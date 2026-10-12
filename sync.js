/* Mon Journal — synchronisation chiffrée de bout en bout via Google Drive (dossier caché de l'application) */
'use strict';
window.Sync = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  const META_NAME = 'journal-meta.json', DATA_NAME = 'journal-data.bin';
  const J = () => window.Journal;
  let cfg = { clientId: '', enabled: false, consented: false, lastSync: 0 };
  let key = null, token = null, tokenExp = 0, gisPromise = null;
  let busy = false, again = false, timer = null, pendingRender = false, state = 'off', lastErr = '';
  const remote = new Map(); // nom -> id Drive
  const $ = s => document.querySelector(s);
  const clientId = () => (window.JOURNAL_CONFIG && JOURNAL_CONFIG.googleClientId) || cfg.clientId || '';
  const ready = () => !!(cfg.enabled && key && clientId());
  const tokenOk = () => token && Date.now() < tokenExp - 60000;
  class NeedAuth extends Error { constructor() { super('auth'); this.needAuth = true; } }

  /* ---------- Chiffrement (AES-GCM 256, clé dérivée du mot de passe par PBKDF2) ---------- */
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function enc(k, buf) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf);
    const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12); return out;
  }
  async function dec(k, buf) { const u = new Uint8Array(buf); return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, k, u.slice(12)); }

  /* ---------- Connexion Google ---------- */
  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!gisPromise) gisPromise = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = res; s.onerror = () => { gisPromise = null; rej(new Error('Impossible de joindre Google (hors ligne ?)')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  function saveToken() { try { localStorage.setItem('journal.tok', JSON.stringify({ t: token, e: tokenExp })); } catch (e) {} }
  function loadToken() { try { const x = JSON.parse(localStorage.getItem('journal.tok') || 'null'); if (x) { token = x.t; tokenExp = x.e; } } catch (e) {} }
  async function getToken(interactive) {
    if (tokenOk()) return token;
    if (!interactive) throw new NeedAuth();
    if (!window.google?.accounts?.oauth2) await loadGis();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: SCOPE, prompt: cfg.consented ? '' : 'consent',
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          token = r.access_token; tokenExp = Date.now() + (+r.expires_in || 3600) * 1000; saveToken();
          if (!cfg.consented) { cfg.consented = true; saveCfg(); }
          res(token);
        },
        error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'Fenêtre Google fermée' : e.type === 'popup_failed_to_open' ? 'Fenêtre Google bloquée par le navigateur' : (e.message || e.type)))
      });
      tc.requestAccessToken();
    });
  }

  /* ---------- Google Drive (dossier appDataFolder, invisible dans votre Drive) ---------- */
  async function gfetch(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + token } });
    if (r.status === 401) { token = null; saveToken(); throw new NeedAuth(); }
    if (!r.ok) throw new Error(`Google Drive ${r.status} : ${(await r.text()).slice(0, 200)}`);
    return r;
  }
  async function listRemote() {
    remote.clear(); let pageToken = '';
    do {
      const u = `${API}/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name)${pageToken ? '&pageToken=' + pageToken : ''}`;
      const j = await (await gfetch(u)).json();
      for (const f of j.files || []) remote.set(f.name, f.id);
      pageToken = j.nextPageToken || '';
    } while (pageToken);
  }
  const download = async id => (await gfetch(`${API}/files/${id}?alt=media`)).arrayBuffer();
  async function create(name, blob) {
    const meta = { name, parents: ['appDataFolder'] };
    if (blob.size > 4 * 1024 * 1024) {
      const r = await gfetch(`${UP}/files?uploadType=resumable&fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream' }, body: JSON.stringify(meta) });
      const loc = r.headers.get('Location');
      const r2 = await gfetch(loc, { method: 'PUT', body: blob });
      return (await r2.json()).id;
    }
    const bnd = 'jrnl' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bnd}\r\nContent-Type: application/octet-stream\r\n\r\n`, blob, `\r\n--${bnd}--`]);
    const r = await gfetch(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${bnd}` }, body });
    return (await r.json()).id;
  }
  const update = (id, blob) => gfetch(`${UP}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const gdel = id => gfetch(`${API}/files/${id}`, { method: 'DELETE' }).catch(e => { if (!/404/.test(e.message)) throw e; });

  /* ---------- Fusion : la version la plus récente de chaque entrée gagne ---------- */
  function merge(a, b) {
    const m = new Map(); for (const x of a || []) m.set(x.id, x);
    for (const y of b || []) { const x = m.get(y.id); if (!x || (y.updated || 0) > (x.updated || 0)) m.set(y.id, y); }
    return [...m.values()];
  }
  const sig = list => new Map((list || []).map(x => [x.id, x.updated || 0]));
  const differs = (merged, other) => { const s = sig(other); return merged.length !== s.size || merged.some(x => s.get(x.id) !== (x.updated || 0)); };

  async function applyLocal(storeName, merged) {
    let changed = false;
    for (const x of merged) {
      const cur = await J().dbGet(storeName, x.id);
      if (!cur || (x.updated || 0) > (cur.updated || 0)) { await J().dbPut(storeName, x); changed = true; }
    }
    return changed;
  }

  async function run(interactive) {
    if (!ready()) return;
    if (busy) { again = true; return; }
    if (!navigator.onLine) { setState('offline'); return; }
    busy = true; setState('syncing');
    try {
      await getToken(interactive);
      await listRemote();
      let rem = { events: [], cats: [], settings: null, deadFiles: [] };
      const dataId = remote.get(DATA_NAME);
      if (dataId) rem = JSON.parse(td.decode(await dec(key, await download(dataId))));
      const lEvents = await J().dbAll('events'), lCats = await J().dbAll('cats');
      const lSet = J().settings, lDead = (await J().metaGet('deadFiles')) || [];
      const mE = merge(lEvents, rem.events), mC = merge(lCats, rem.cats);
      const mS = rem.settings && (rem.settings.updated || 0) > (lSet.updated || 0) ? rem.settings : lSet;
      const mD = [...new Set([...lDead, ...(rem.deadFiles || [])])];
      let localChanged = await applyLocal('events', mE);
      localChanged = (await applyLocal('cats', mC)) || localChanged;
      if (mS !== lSet) { await J().metaSet('settings', mS); localChanged = true; }
      await J().metaSet('deadFiles', mD);
      const remStale = !dataId || differs(mE, rem.events) || differs(mC, rem.cats) || (mS.updated || 0) !== (rem.settings?.updated || 0) || mD.length !== (rem.deadFiles || []).length;
      if (remStale) {
        const payload = te.encode(JSON.stringify({ v: 1, events: mE, cats: mC, settings: mS, deadFiles: mD, saved: Date.now() }));
        const blob = new Blob([await enc(key, payload)]);
        if (dataId) await update(dataId, blob); else remote.set(DATA_NAME, await create(DATA_NAME, blob));
      }
      // Pièces jointes : envoi de celles qui ne sont pas encore en ligne
      const used = new Set(mE.filter(e => !e.deleted).flatMap(e => (e.attachments || []).map(a => a.id)));
      for (const f of await J().dbAll('files')) {
        if (f.synced || !used.has(f.id)) continue;
        const name = `f_${f.id}.bin`;
        if (!remote.has(name)) remote.set(name, await create(name, new Blob([await enc(key, await f.blob.arrayBuffer())])));
        f.synced = true; await J().dbPut('files', f);
      }
      // Pièces jointes supprimées
      for (const id of mD) {
        const n = `f_${id}.bin`;
        if (remote.has(n)) { await gdel(remote.get(n)); remote.delete(n); }
        await J().dbDel('files', id);
      }
      if (localChanged) { await J().loadAll(); if (J().isEditing()) pendingRender = true; else J().render(); }
      cfg.lastSync = Date.now(); saveCfg(); lastErr = '';
      setState('ok');
    } catch (e) {
      console.warn('Synchro :', e);
      if (e.needAuth) setState('auth');
      else if (e.name === 'OperationError') { lastErr = 'Les données en ligne ne correspondent pas à votre mot de passe.'; setState('error'); }
      else { lastErr = e.message; setState(navigator.onLine ? 'error' : 'offline'); }
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(() => run(false), 800); }
    }
  }
  function schedule() {
    if (!ready()) return;
    if (!tokenOk()) { setState('auth'); return; }
    clearTimeout(timer); timer = setTimeout(() => run(false), 2500);
  }
  async function fetchFile(id) {
    if (!ready() || !navigator.onLine || !tokenOk()) return null;
    if (!remote.has(`f_${id}.bin`)) await listRemote();
    const rid = remote.get(`f_${id}.bin`); if (!rid) return null;
    const att = J().events.flatMap(e => e.attachments || []).find(a => a.id === id);
    return new Blob([await dec(key, await download(rid))], { type: att?.type || 'application/octet-stream' });
  }

  /* ---------- État affiché ---------- */
  function setState(s) {
    state = s;
    const b = $('#syncBtn'), bar = $('#syncBar');
    const t = cfg.lastSync ? new Date(cfg.lastSync).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    const map = {
      off: ['☁ Synchro', '', 'Activer la synchronisation entre vos appareils'],
      ok: ['☁ ✓', 'ok', `Synchronisé à ${t}`],
      syncing: ['☁ …', '', 'Synchronisation en cours'],
      auth: ['☁ Reconnecter', 'warn', 'Reconnexion à Google nécessaire'],
      offline: ['☁ Hors ligne', '', 'Hors ligne : vos modifications seront envoyées au retour du réseau'],
      error: ['☁ ⚠', 'warn', 'Erreur de synchronisation : ' + lastErr]
    }[s];
    b.textContent = map[0]; b.className = 'btn ' + map[1]; b.title = map[2];
    const showBar = s === 'auth' || s === 'error';
    bar.classList.toggle('on', showBar);
    $('#syncBarText').textContent = s === 'auth' ? 'Synchronisation en pause : touchez « Reconnecter » pour récupérer et envoyer vos dernières modifications.' : 'Synchronisation impossible : ' + lastErr;
    $('#syncBarBtn').textContent = s === 'auth' ? 'Reconnecter' : 'Réessayer';
    if ($('#dlgSync').open) renderDialog();
  }

  /* ---------- Fenêtre de configuration ---------- */
  let step = '';
  function renderDialog(msg = '') {
    const el = $('#syncInner');
    const head = `<div class="dlg-h"><h2 style="flex:1">Synchronisation</h2><button type="button" class="icon-btn" data-x>✕</button></div>`;
    const err = msg ? `<div class="warnbox">${msg}</div>` : '';
    let h = '';
    if (!clientId()) {
      h = `<p>La synchronisation passe par <b>votre</b> Google Drive. Il faut d'abord renseigner l'identifiant (Client ID) créé lors de la mise en place (voir le guide).</p>
        <label class="f">Client ID Google<input id="sCid" placeholder="xxxxxxxx.apps.googleusercontent.com"></label>
        <div class="dlg-f"><span class="sp"></span><button class="btn primary" id="sCidOk">Enregistrer</button></div>`;
    } else if (ready()) {
      const t = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'jamais';
      h = `<p>✅ Synchronisation active. Vos entrées sont chiffrées avec votre mot de passe avant d'être envoyées dans un dossier caché de votre Google Drive.</p>
        <p class="hint">Dernière synchronisation : ${t}${state === 'error' ? '<br>⚠ ' + lastErr : ''}</p>
        <div class="dlg-f"><button class="btn danger" id="sOff">Déconnecter cet appareil</button><span class="sp"></span><button class="btn primary" id="sNow">Synchroniser maintenant</button></div>`;
    } else if (step === 'create') {
      h = `<p>Première connexion : choisissez un <b>mot de passe de chiffrement</b>. Il vous sera demandé une seule fois sur chacun de vos appareils.</p>
        <div class="warnbox">⚠ Notez-le en lieu sûr. Sans lui, personne (ni vous, ni Google, ni moi) ne pourra relire les données en ligne. Vos données restent néanmoins sur cet appareil.</div>
        <label class="f">Mot de passe (8 caractères minimum)<input type="password" id="sP1" autocomplete="new-password"></label>
        <label class="f">Confirmation<input type="password" id="sP2" autocomplete="new-password"></label>
        <div class="dlg-f"><span class="sp"></span><button class="btn primary" id="sCreate">Activer la synchronisation</button></div>`;
    } else if (step === 'unlock') {
      h = `<p>Un journal existe déjà sur votre Google Drive. Saisissez votre <b>mot de passe de chiffrement</b> pour le relier à cet appareil.</p>
        <label class="f">Mot de passe<input type="password" id="sP" autocomplete="current-password"></label>
        <p class="hint">Les entrées déjà présentes sur cet appareil seront fusionnées avec celles en ligne.</p>
        <div class="dlg-f"><span class="sp"></span><button class="btn primary" id="sUnlock">Déverrouiller</button></div>`;
    } else {
      h = `<p>Retrouvez votre journal sur votre téléphone, votre tablette et votre ordinateur.</p>
        <ul class="hint" style="padding-left:18px;margin:0"><li>Stockage dans un dossier caché de votre Google Drive, réservé à cette app.</li><li>Tout est chiffré sur l'appareil avant l'envoi : Google ne voit qu'un bloc illisible.</li><li>L'app continue de fonctionner hors connexion.</li></ul>
        <div class="dlg-f"><span class="sp"></span><button class="btn primary" id="sConnect">Se connecter à Google Drive</button></div>`;
    }
    el.innerHTML = head + err + h;
    el.querySelector('[data-x]').onclick = () => $('#dlgSync').close();
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { renderDialog(e.needAuth ? 'Connexion Google requise.' : esc2(e.message)); } finally { b.disabled = false; } }; };
    on('#sCidOk', async () => { const v = $('#sCid').value.trim(); if (!/apps\.googleusercontent\.com$/.test(v)) throw new Error('Cet identifiant ne ressemble pas à un Client ID Google.'); cfg.clientId = v; await saveCfg(); loadGis().catch(() => {}); renderDialog(); });
    on('#sConnect', async () => {
      await getToken(true); await listRemote();
      step = remote.has(META_NAME) ? 'unlock' : 'create'; renderDialog();
    });
    on('#sCreate', async () => {
      const p1 = $('#sP1').value, p2 = $('#sP2').value;
      if (p1.length < 8) throw new Error('Le mot de passe doit faire au moins 8 caractères.');
      if (p1 !== p2) throw new Error('Les deux mots de passe ne correspondent pas.');
      await getToken(true); await listRemote();
      if (remote.has(META_NAME)) { step = 'unlock'; renderDialog('Un journal existe déjà en ligne : saisissez son mot de passe.'); return; }
      const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 310000;
      const k = await deriveKey(p1, salt, iter);
      const check = await enc(k, te.encode('journal-ok'));
      remote.set(META_NAME, await create(META_NAME, new Blob([JSON.stringify({ v: 1, salt: b64(salt), iter, check: b64(check) })], { type: 'application/json' })));
      await activate(k);
    });
    on('#sUnlock', async () => {
      await getToken(true); await listRemote();
      const meta = JSON.parse(td.decode(await download(remote.get(META_NAME))));
      const k = await deriveKey($('#sP').value, unb64(meta.salt), meta.iter);
      try { await dec(k, unb64(meta.check)); } catch (e) { throw new Error('Mot de passe incorrect.'); }
      await activate(k);
    });
    on('#sNow', () => run(true));
    on('#sOff', async () => {
      if (!confirm('Déconnecter cet appareil ? Vos entrées restent sur cet appareil et sur Google Drive, mais ne seront plus synchronisées ici.')) return;
      cfg.enabled = false; key = null; await J().dbDel('meta', 'syncKey'); await saveCfg();
      try { if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {}); } catch (e) {}
      token = null; saveToken(); step = ''; setState('off'); renderDialog();
    });
    const first = el.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
  }
  const esc2 = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  async function activate(k) {
    key = k; cfg.enabled = true;
    await J().metaSet('syncKey', k); await saveCfg();
    J().toast('Synchronisation activée ✓');
    await run(true); renderDialog();
  }
  const saveCfg = () => J().metaSet('syncCfg', cfg);
  function openDialog() { step = ''; renderDialog(); $('#dlgSync').showModal(); if (clientId()) loadGis().catch(() => {}); }

  async function init() {
    cfg = Object.assign(cfg, (await J().metaGet('syncCfg')) || {});
    key = (await J().metaGet('syncKey')) || null;
    $('#syncBtn').onclick = () => { if (!ready()) openDialog(); else run(true); };
    $('#btnSyncDlg').onclick = openDialog;
    $('#syncBarBtn').onclick = () => run(true);
    $('#dlgSync').addEventListener('close', () => { if (!ready()) setState('off'); });
    addEventListener('online', () => { if (ready()) tokenOk() ? run(false) : setState('auth'); });
    addEventListener('offline', () => { if (ready()) setState('offline'); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ready()) { if (tokenOk()) run(false); else setState('auth'); } });
    setInterval(() => { if (ready() && tokenOk()) run(false); }, 5 * 60 * 1000);
    if (!ready()) { setState('off'); return; }
    loadToken(); loadGis().catch(() => {});
    if (tokenOk()) run(false); else setState('auth');
  }
  function afterDialog() { if (pendingRender) { pendingRender = false; J().render(); } }
  return { init, schedule, run, fetchFile, openDialog, afterDialog, get state() { return state; } };
})();
