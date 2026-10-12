/* Mon Journal — cœur de l'application (stockage local, vues, éditeur, impression) */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const pad = n => String(n).padStart(2, '0');
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ---------------- IndexedDB ---------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('journal-perso', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('events', { keyPath: 'id' });
      d.createObjectStore('cats', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbAll = s => req(store(s).getAll());
const dbGet = (s, k) => req(store(s).get(k));
const dbPut = (s, v) => req(store(s, 'readwrite').put(v));
const dbDel = (s, k) => req(store(s, 'readwrite').delete(k));
const metaGet = async k => (await dbGet('meta', k))?.v;
const metaSet = (k, v) => dbPut('meta', { k, v });

/* ---------------- État ---------------- */
let events = [];          // inclut les entrées supprimées (deleted:true) pour la synchro
let cats = [];
let settings = { dayStart: 7, dayEnd: 22, weekStart: 1, updated: 0 };
let view = 'week', cursor = startOfDay(new Date()), hidden = new Set(), query = '';
let lastCat = '';
const HOUR = 48;
const urlCache = new Map();
const live = () => events.filter(e => !e.deleted);
const liveCats = () => cats.filter(c => !c.deleted);

/* ---------------- Dates ---------------- */
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = d => addDays(startOfDay(d), -((d.getDay() - settings.weekStart + 7) % 7));
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const fWd = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });
const fDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' });
const fLong = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const fDM = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fDMY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const WD1 = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
function enumDays(from, to) { const out = []; for (let d = parse(from), i = 0; ymd(d) <= to && i < 2000; d = addDays(d, 1), i++) out.push(ymd(d)); return out; }

/* ---------------- Catégories & entrées ---------------- */
const NOCAT = { id: '', name: 'Sans catégorie', color: '#9a9187' };
const catOf = id => cats.find(c => c.id === id && !c.deleted) || NOCAT;
const isTimed = ev => !ev.allDay && !!ev.start;
const dTitle = ev => ev.title || (ev.notes || '').split('\n')[0].slice(0, 70) || '(sans titre)';
const hasRec = ev => ev.rec && ev.rec.freq && ev.rec.freq !== 'none';
function matches(ev, q) {
  const hay = norm([ev.title, ev.notes, ...(ev.attachments || []).map(a => a.name), catOf(ev.catId).name].join(' '));
  return norm(q).split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

/* Récurrence : dates d'occurrence entre from et to (chaînes AAAA-MM-JJ incluses) */
function occDates(ev, from, to) {
  const r = ev.rec || { freq: 'none' };
  const ex = new Set(ev.exceptions || []);
  const out = [];
  const push = s => { if (s >= from && s <= to && !ex.has(s)) out.push(s); };
  if (!hasRec(ev)) { push(ev.date); return out; }
  const start = parse(ev.date), iv = Math.max(1, +r.interval || 1);
  const until = r.until || '9999-12-31', max = r.count || Infinity;
  const lim = to < until ? to : until;
  let n = 0, guard = 0;
  if (r.freq === 'daily') {
    for (let d = start; ; d = addDays(d, iv)) { const s = ymd(d); if (s > lim || n >= max || ++guard > 40000) break; n++; push(s); }
  } else if (r.freq === 'weekly') {
    const days = (r.days && r.days.length) ? r.days : [start.getDay()];
    let w = addDays(start, -start.getDay());
    outer: for (; ; w = addDays(w, 7 * iv)) {
      if (++guard > 8000) break;
      for (let i = 0; i < 7; i++) {
        const d = addDays(w, i); if (!days.includes(d.getDay())) continue;
        const s = ymd(d); if (s < ev.date) continue;
        if (s > lim || n >= max) break outer; n++; push(s);
      }
    }
  } else if (r.freq === 'monthly' || r.freq === 'yearly') {
    const step = r.freq === 'monthly' ? iv : 12 * iv, dd = start.getDate();
    for (let k = 0; ; k += step) {
      if (++guard > 5000) break;
      const m0 = new Date(start.getFullYear(), start.getMonth() + k, 1);
      if (ymd(m0) > lim) break;
      const d = new Date(start.getFullYear(), start.getMonth() + k, dd);
      if (d.getDate() !== dd) continue; // ex. 31 dans un mois de 30 jours
      const s = ymd(d); if (s > lim || n >= max) break; n++; push(s);
    }
  }
  return out;
}
function occurrences(from, to, opt = {}) {
  const out = [];
  for (const ev of events) {
    if (ev.deleted) continue;
    if (opt.cats) { if (!opt.cats.has(ev.catId || '')) continue; }
    else { if (hidden.has(ev.catId || '')) continue; if (query && !matches(ev, query)) continue; }
    for (const d of occDates(ev, from, to)) out.push({ ev, date: d });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (isTimed(a.ev) - isTimed(b.ev)) || (a.ev.start || '').localeCompare(b.ev.start || '') || (a.ev.created || 0) - (b.ev.created || 0));
}
function recText(r) {
  if (!r || r.freq === 'none') return '';
  const iv = +r.interval || 1;
  const u = { daily: ['jour', 'jours'], weekly: ['semaine', 'semaines'], monthly: ['mois', 'mois'], yearly: ['an', 'ans'] }[r.freq];
  let s = iv === 1 ? { daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois', yearly: 'Chaque année' }[r.freq] : `Tous les ${iv} ${u[1]}`;
  if (r.freq === 'weekly' && r.days?.length) {
    const names = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
    const order = [...r.days].sort((a, b) => ((a - settings.weekStart + 7) % 7) - ((b - settings.weekStart + 7) % 7));
    s += ' (' + order.map(d => names[d]).join(', ') + ')';
  }
  if (r.until) s += ` jusqu'au ${fDMY.format(parse(r.until))}`;
  else if (r.count) s += `, ${r.count} fois`;
  return s;
}
/* Disposition des entrées qui se chevauchent */
function layout(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], colsEnd = [], clusterEnd = -1;
  const flush = () => { const n = colsEnd.length; cluster.forEach(it => it.n = n); cluster = []; colsEnd = []; clusterEnd = -1; };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    let c = colsEnd.findIndex(e => e <= it.s);
    if (c < 0) { c = colsEnd.length; colsEnd.push(it.e); } else colsEnd[c] = it.e;
    it.col = c; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush(); return items;
}
const span = ev => { const a = toMin(ev.start); let b = ev.end ? toMin(ev.end) : a + 60; if (b <= a) b = a + 30; return [a, b]; };

/* ---------------- Fichiers ---------------- */
const viewable = t => /^(image|audio|video|text)\//.test(t || '') || t === 'application/pdf';
const fileIcon = (t, n) => /^image\//.test(t) ? '🖼' : /^audio\//.test(t) ? '🎙' : /^video\//.test(t) ? '🎞' : /pdf/.test(t) ? '📄' : /sheet|excel|csv|ods/.test(t + n) ? '📊' : /word|document|odt|rtf/.test(t + n) ? '📝' : /^text\//.test(t) ? '📃' : '📎';
const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1e3)) + ' ko';
async function fileUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  let r = await dbGet('files', id);
  if (!r && window.Sync) { try { const blob = await Sync.fetchFile(id); if (blob) { r = { id, blob, synced: true }; await dbPut('files', r); } } catch (e) { console.warn(e); } }
  if (!r) return null;
  const u = URL.createObjectURL(r.blob); urlCache.set(id, u); return u;
}
async function hydrate(root) {
  for (const el of root.querySelectorAll('[data-file]')) {
    const u = await fileUrl(el.dataset.file);
    if (!u) { if (el.tagName === 'A') { el.textContent = '☁ ' + el.textContent + ' (pas encore sur cet appareil)'; el.removeAttribute('href'); } else el.replaceWith(Object.assign(document.createElement('span'), { className: 'hint', textContent: '☁ fichier non disponible (synchronisez)' })); continue; }
    if (el.tagName === 'A') el.href = u; else el.src = u;
  }
}
async function gcFiles(ids) {
  const used = new Set(live().flatMap(e => (e.attachments || []).map(a => a.id)));
  const dead = (await metaGet('deadFiles')) || [];
  let changed = false;
  for (const id of ids) {
    if (used.has(id)) continue;
    await dbDel('files', id); if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
    if (!dead.includes(id)) { dead.push(id); changed = true; }
  }
  if (changed) await metaSet('deadFiles', dead);
}

/* ---------------- Enregistrement ---------------- */
function changed() { if (window.Sync) Sync.schedule(); }
async function saveEvent(ev) {
  ev.updated = Date.now(); if (!ev.created) ev.created = ev.updated;
  await dbPut('events', ev);
  const i = events.findIndex(e => e.id === ev.id); if (i >= 0) events[i] = ev; else events.push(ev);
  changed();
}
async function deleteEvent(id) {
  const ev = events.find(e => e.id === id); if (!ev) return;
  const ids = (ev.attachments || []).map(a => a.id);
  const tomb = { id, deleted: true, updated: Date.now() };
  await dbPut('events', tomb);
  events[events.indexOf(ev)] = tomb;
  await gcFiles(ids); changed();
}
async function saveCat(c) { c.updated = Date.now(); await dbPut('cats', c); const i = cats.findIndex(x => x.id === c.id); if (i >= 0) cats[i] = c; else cats.push(c); changed(); }
async function saveSettings() { settings.updated = Date.now(); await metaSet('settings', settings); changed(); }

/* ---------------- Rendu ---------------- */
function rangeOfView() {
  if (view === 'day') return [ymd(cursor), ymd(cursor)];
  if (view === 'week') { const s = startOfWeek(cursor); return [ymd(s), ymd(addDays(s, 6))]; }
  const s = new Date(cursor.getFullYear(), cursor.getMonth(), 1); return [ymd(s), ymd(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0))];
}
function render() {
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  const [a, b] = rangeOfView();
  $('#rangeLabel').textContent = view === 'day' ? cap(fLong.format(cursor)) : view === 'month' ? cap(fMonth.format(cursor))
    : (parse(a).getMonth() === parse(b).getMonth() ? `${parse(a).getDate()} – ${fDMY.format(parse(b))}` : `${fDM.format(parse(a))} – ${fDMY.format(parse(b))}`);
  renderMini(); renderCatList();
  if (view === 'month') renderMonth(); else renderTimeGrid();
}
function renderMini() {
  const m = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const s = startOfWeek(m), t = ymd(new Date()), sel = ymd(cursor);
  const occ = new Set(occurrences(ymd(s), ymd(addDays(s, 41))).map(o => o.date));
  let h = `<div class="mini-h"><button class="icon-btn" data-mini="-1">‹</button><span>${cap(fMonth.format(m))}</span><button class="icon-btn" data-mini="1">›</button></div><div class="mini-g">`;
  for (let i = 0; i < 7; i++) h += `<span class="wd">${WD1[(settings.weekStart + i) % 7]}</span>`;
  for (let i = 0; i < 42; i++) {
    const d = addDays(s, i), k = ymd(d);
    h += `<button data-go="${k}" class="${d.getMonth() !== m.getMonth() ? 'out ' : ''}${k === t ? 'today ' : ''}${k === sel ? 'sel ' : ''}${occ.has(k) ? 'has' : ''}">${d.getDate()}</button>`;
  }
  $('#mini').innerHTML = h + '</div>';
}
function renderCatList() {
  const used = live().some(e => !e.catId);
  const list = [...liveCats(), ...(used ? [NOCAT] : [])];
  $('#catList').innerHTML = list.map(c => `<label class="cat-row" style="--c:${c.color}"><input type="checkbox" data-cat="${c.id}" ${hidden.has(c.id) ? '' : 'checked'}><span class="dot"></span>${esc(c.name)}</label>`).join('') || '<p class="hint">Aucune catégorie.</p>';
}
function evBlock(o, top, hgt, it, showNotes) {
  const ev = o.ev, c = catOf(ev.catId);
  const icons = (hasRec(ev) ? ' ↻' : '') + ((ev.attachments || []).length ? ' 📎' : '');
  return `<div class="ev" data-id="${ev.id}" data-date="${o.date}" style="top:${top}px;height:${hgt}px;left:calc(${it.col / it.n * 100}% + 2px);width:calc(${100 / it.n}% - 4px);--c:${c.color}" title="${esc(dTitle(ev))}">
    ${hgt < 34 ? `<div class="ev-ti" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span class="ev-t">${esc(ev.start)}</span> ${esc(dTitle(ev))}${icons}</div>` : `<div class="ev-t">${esc(ev.start)}${ev.end ? '–' + esc(ev.end) : ''}${icons}</div><div class="ev-ti">${esc(dTitle(ev))}</div>${showNotes && ev.notes && ev.title ? `<div class="ev-n">${esc(ev.notes)}</div>` : ''}`}</div>`;
}
function renderTimeGrid() {
  const isDay = view === 'day';
  const days = isDay ? [cursor] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));
  const from = ymd(days[0]), to = ymd(days[days.length - 1]);
  const occ = occurrences(from, to);
  const h1 = settings.dayStart, h2 = settings.dayEnd, H = (h2 - h1) * HOUR;
  const tstr = ymd(new Date());
  let g = `<div class="tg ${isDay ? 'day' : ''}" style="--n:${days.length}"><div class="tg-head"><div></div>`;
  for (const d of days) { const s = ymd(d); g += `<div class="tg-dh ${s === tstr ? 'is-today' : ''}" data-day="${s}"><span class="dn">${cap(fWd.format(d))}</span><span class="dd">${d.getDate()}</span></div>`; }
  g += `</div><div class="tg-allday"><div class="lbl">journée</div>`;
  for (const d of days) { const s = ymd(d); g += `<div class="tg-ad" data-new="${s}">` + occ.filter(o => o.date === s && !isTimed(o.ev)).map(chip).join('') + `</div>`; }
  g += `</div><div class="tg-body"><div class="tg-gut">`;
  for (let h = h1; h < h2; h++) g += `<div class="tg-hl" style="height:${HOUR}px"><span${h === h1 ? ' style="top:2px"' : ''}>${pad(h)}:00</span></div>`;
  g += `</div>`;
  for (const d of days) {
    const s = ymd(d);
    const items = layout(occ.filter(o => o.date === s && isTimed(o.ev)).map(o => { const [a, b] = span(o.ev); return { o, s: a, e: b }; }));
    g += `<div class="tg-col ${s === tstr ? 'is-today' : ''}" style="height:${H}px">`;
    for (let h = h1; h < h2; h++) g += `<div class="tg-slot" data-new="${s}" data-h="${h}" style="height:${HOUR}px"></div>`;
    for (const it of items) {
      let top = (it.s - h1 * 60) / 60 * HOUR, bot = (it.e - h1 * 60) / 60 * HOUR;
      top = Math.min(Math.max(0, top), H - 20); bot = Math.min(Math.max(bot, top + 20), H);
      g += evBlock(it.o, top, Math.max(18, bot - top - 1), it, isDay);
    }
    if (s === tstr) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= h1 * 60 && m <= h2 * 60) g += `<div class="now" style="top:${(m - h1 * 60) / 60 * HOUR}px"></div>`; }
    g += `</div>`;
  }
  g += `</div></div>`;
  const main = $('#main');
  if (isDay) {
    main.innerHTML = `<div class="dayview"><div class="gridside">${g}</div><div class="journal" id="journal"></div></div>`;
    renderJournal(occ.filter(o => o.date === ymd(cursor)));
  } else main.innerHTML = g;
}
const chip = o => `<button class="chip" data-id="${o.ev.id}" data-date="${o.date}" style="--c:${catOf(o.ev.catId).color}" title="${esc(dTitle(o.ev))}">${isTimed(o.ev) ? esc(o.ev.start) + ' ' : ''}${esc(dTitle(o.ev))}${hasRec(o.ev) ? ' ↻' : ''}</button>`;
function renderJournal(list) {
  const el = $('#journal');
  let h = `<h2>${cap(fLong.format(cursor))}</h2><div class="sub">${list.length ? list.length + ' entrée' + (list.length > 1 ? 's' : '') : ''}</div>`;
  if (!list.length) h += `<p class="empty">Rien pour ce jour. Cliquez dans la grille ou sur « + Entrée » pour écrire.</p>`;
  for (const o of list) {
    const ev = o.ev, c = catOf(ev.catId);
    const files = (ev.attachments || []).map(a => /^image\//.test(a.type) ? `<img data-file="${a.id}" alt="${esc(a.name)}">`
      : /^audio\//.test(a.type) ? `<audio controls preload="none" data-file="${a.id}"></audio>`
      : `<a data-file="${a.id}" target="_blank" ${viewable(a.type) ? '' : `download="${esc(a.name)}"`} onclick="event.stopPropagation()">${fileIcon(a.type, a.name)} ${esc(a.name)}</a>`).join('');
    h += `<div class="card" data-id="${ev.id}" data-date="${o.date}" style="--c:${c.color}">
      <div class="meta"><span class="dot"></span>${esc(c.name)}<span>·</span>${isTimed(ev) ? esc(ev.start) + (ev.end ? ' – ' + esc(ev.end) : '') : 'journée'}${hasRec(ev) ? `<span>· ↻ ${esc(recText(ev.rec))}</span>` : ''}</div>
      <div class="ti">${esc(ev.title || '')}</div>${ev.notes ? `<div class="nt">${esc(ev.notes)}</div>` : ''}
      ${files ? `<div class="files" onclick="if(event.target.tagName!=='IMG')event.stopPropagation()">${files}</div>` : ''}</div>`;
  }
  el.innerHTML = h; hydrate(el);
}
function renderMonth() {
  const m0 = new Date(cursor.getFullYear(), cursor.getMonth(), 1), s = startOfWeek(m0);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const weeks = Math.ceil((((m0.getDay() - settings.weekStart + 7) % 7) + last.getDate()) / 7);
  const occ = occurrences(ymd(s), ymd(addDays(s, weeks * 7 - 1)));
  const t = ymd(new Date());
  let h = `<div class="month">`;
  for (let i = 0; i < 7; i++) h += `<div class="mh">${cap(fWd.format(addDays(s, i)))}</div>`;
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(s, i), k = ymd(d), list = occ.filter(o => o.date === k);
    h += `<div class="mc ${d.getMonth() !== m0.getMonth() ? 'out' : ''} ${k === t ? 'today' : ''}" data-new="${k}"><button class="num" data-day="${k}">${d.getDate()}</button>${list.slice(0, 4).map(chip).join('')}${list.length > 4 ? `<button class="more" data-day="${k}">+ ${list.length - 4} autre(s)</button>` : ''}</div>`;
  }
  $('#main').innerHTML = h + '</div>';
}

/* ---------------- Navigation ---------------- */
function go(n) {
  if (view === 'day') cursor = addDays(cursor, n);
  else if (view === 'week') cursor = addDays(cursor, 7 * n);
  else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
  render();
}
function setView(v) { view = v; try { localStorage.setItem('journal.view', v); } catch (e) {} render(); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }

/* ---------------- Éditeur ---------------- */
let draft = null;
const dlgEvent = $('#dlgEvent');
function openEditor(id, occDate, preset = {}) {
  const isNew = !id;
  const base = isNew ? null : events.find(e => e.id === id);
  if (!isNew && !base) return;
  const ev = isNew ? {
    id: uid(), title: '', date: preset.date || ymd(cursor), start: preset.start || '', end: preset.end || '', allDay: !preset.start,
    catId: (lastCat && catOf(lastCat).id) ? lastCat : (liveCats()[0]?.id || ''), notes: '',
    rec: { freq: 'none', interval: 1, days: [], until: '', count: null }, exceptions: [], attachments: []
  } : structuredClone(base);
  ev.rec = Object.assign({ freq: 'none', interval: 1, days: [], until: '', count: null }, ev.rec || {});
  ev.attachments = ev.attachments || [];
  draft = { ev, isNew, occDate: occDate || ev.date, newFiles: new Set(), removed: [], saved: false };
  $('#evTitle').value = ev.title || '';
  $('#evDate').value = ev.date;
  $('#evCat').innerHTML = liveCats().map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + `<option value="">Sans catégorie</option>`;
  $('#evCat').value = ev.catId || '';
  $('#evAllDay').checked = !isTimed(ev);
  $('#evStart').value = ev.start || '09:00'; $('#evEnd').value = ev.end || '';
  $('#evNotes').value = ev.notes || '';
  const r = ev.rec;
  $('#recFreq').value = r.freq; $('#recIv').value = r.interval || 1;
  $('#recEnd').value = r.until ? 'until' : r.count ? 'count' : 'never';
  $('#recUntil').value = r.until || ''; $('#recCount').value = r.count || 10;
  buildDays(r.days || []);
  const recurring = !isNew && hasRec(base);
  $('#occBanner').hidden = !recurring;
  $('#evOnlyThis').checked = false;
  if (recurring) $('#occText').textContent = `↻ ${recText(base.rec)}. Vous modifiez la série entière (occurrence du ${fDMY.format(parse(draft.occDate))}).`;
  $('#delZone').hidden = isNew; $('#delChoice').hidden = true;
  updateTimeUI(); updateRecUI(); renderAtt();
  dlgEvent.showModal();
  if (isNew) setTimeout(() => $('#evTitle').focus(), 50);
}
function buildDays(sel) {
  let h = '';
  for (let i = 0; i < 7; i++) { const d = (settings.weekStart + i) % 7; h += `<button type="button" data-d="${d}" class="${sel.includes(d) ? 'on' : ''}">${WD1[d]}</button>`; }
  $('#recDays').innerHTML = h;
}
function updateTimeUI() { const all = $('#evAllDay').checked; $$('#timeFields input').forEach(i => i.disabled = all); $('#timeFields').style.opacity = all ? .4 : 1; }
function updateRecUI() {
  const f = $('#recFreq').value, none = f === 'none', only = $('#evOnlyThis').checked;
  $('#recBox').disabled = only;
  $('#recBox').style.opacity = only ? .45 : 1;
  $('#recIvWrap').hidden = none; $('#recEndRow').hidden = none; $('#recDays').hidden = f !== 'weekly';
  const iv = +$('#recIv').value || 1;
  $('#recUnit').textContent = { daily: iv > 1 ? 'jours' : 'jour', weekly: iv > 1 ? 'semaines' : 'semaine', monthly: 'mois', yearly: iv > 1 ? 'ans' : 'an' }[f] || '';
  if (f === 'weekly' && !$$('#recDays .on').length) { const d = parse($('#evDate').value || ymd(cursor)).getDay(); $(`#recDays [data-d="${d}"]`)?.classList.add('on'); }
  const e = $('#recEnd').value; $('#recUntil').hidden = e !== 'until'; $('#recCountWrap').hidden = e !== 'count';
}
async function renderAtt() {
  const list = draft.ev.attachments;
  const items = await Promise.all(list.map(async a => ({ a, u: await fileUrl(a.id) })));
  $('#attList').innerHTML = items.map(({ a, u }) => `<div class="att-item">
      ${/^image\//.test(a.type) && u ? `<a href="${u}" target="_blank"><img src="${u}" alt=""></a>` : `<span style="font-size:20px">${fileIcon(a.type, a.name)}</span>`}
      <span class="nm" title="${esc(a.name)}">${esc(a.name)} <span class="hint">${a.size ? fmtSize(a.size) : ''}</span></span>
      ${/^audio\//.test(a.type) && u ? `<audio controls src="${u}"></audio>` : ''}
      ${u ? `<a href="${u}" target="_blank" ${viewable(a.type) ? '' : `download="${esc(a.name)}"`}>ouvrir</a>` : '<span class="hint">☁ non téléchargé</span>'}
      <button type="button" class="icon-btn" data-rm="${a.id}" title="Retirer">✕</button></div>`).join('');
}
async function addFiles(files) {
  for (const f of files) {
    const id = uid();
    await dbPut('files', { id, blob: f, synced: false });
    draft.ev.attachments.push({ id, name: f.name || 'fichier', type: f.type || 'application/octet-stream', size: f.size });
    draft.newFiles.add(id);
  }
  renderAtt();
}
$('#evForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (mediaRec) { toast('Arrêtez d\'abord le mémo vocal.'); return; }
  stopVoice();
  const ev = draft.ev;
  ev.title = $('#evTitle').value.trim();
  ev.date = $('#evDate').value || ymd(cursor);
  ev.catId = $('#evCat').value;
  ev.allDay = $('#evAllDay').checked || !$('#evStart').value;
  ev.start = ev.allDay ? '' : $('#evStart').value;
  ev.end = ev.allDay ? '' : $('#evEnd').value;
  if (ev.end && ev.start && ev.end <= ev.start) ev.end = '';
  ev.notes = $('#evNotes').value;
  if (!ev.title && !ev.notes.trim() && !ev.attachments.length) { toast('Entrée vide : écrivez un titre ou une note.'); return; }
  const f = $('#recFreq').value, endMode = $('#recEnd').value;
  ev.rec = { freq: f, interval: Math.max(1, +$('#recIv').value || 1), days: f === 'weekly' ? $$('#recDays .on').map(b => +b.dataset.d) : [], until: endMode === 'until' ? $('#recUntil').value : '', count: endMode === 'count' ? Math.max(1, +$('#recCount').value || 1) : null };
  if (!draft.isNew && $('#evOnlyThis').checked) {
    const orig = events.find(x => x.id === ev.id);
    orig.exceptions = [...new Set([...(orig.exceptions || []), draft.occDate])];
    await saveEvent(orig);
    ev.id = uid(); ev.created = 0; ev.rec = { freq: 'none', interval: 1, days: [], until: '', count: null }; ev.exceptions = [];
  }
  await saveEvent(ev);
  lastCat = ev.catId;
  draft.saved = true;
  await gcFiles(draft.removed);
  dlgEvent.close();
  render();
});
dlgEvent.addEventListener('close', async () => {
  stopVoice(true);
  if (draft && !draft.saved) { for (const id of draft.newFiles) { await dbDel('files', id); urlCache.delete(id); } }
  draft = null;
  if (window.Sync) Sync.afterDialog();
});
$('#evAllDay').onchange = updateTimeUI;
$('#evStart').onchange = () => { const s = $('#evStart').value, e = $('#evEnd').value; if (s && (!e || e <= s)) { const m = Math.min(toMin(s) + 60, 23 * 60 + 59); $('#evEnd').value = pad(Math.floor(m / 60)) + ':' + pad(m % 60); } };
$('#recFreq').onchange = updateRecUI; $('#recIv').oninput = updateRecUI; $('#recEnd').onchange = updateRecUI;
$('#evOnlyThis').onchange = () => { $('#evDate').value = $('#evOnlyThis').checked ? draft.occDate : draft.ev.date; updateRecUI(); };
$('#recDays').onclick = e => { const b = e.target.closest('button'); if (b) b.classList.toggle('on'); };
$('#evFiles').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#evPhoto').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#attList').onclick = e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  const id = b.dataset.rm; draft.ev.attachments = draft.ev.attachments.filter(a => a.id !== id);
  if (draft.newFiles.has(id)) { dbDel('files', id); draft.newFiles.delete(id); } else draft.removed.push(id);
  renderAtt();
};
const zone = $('#attZone');
dlgEvent.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
dlgEvent.addEventListener('dragleave', e => { if (e.target === dlgEvent) zone.classList.remove('drag'); });
dlgEvent.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
$('#evNotes').addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
$$('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
$('#btnDel').onclick = async () => {
  const base = events.find(e => e.id === draft.ev.id);
  if (hasRec(base)) { $('#delZone').hidden = true; $('#delChoice').hidden = false; return; }
  if (!confirm('Supprimer cette entrée et ses pièces jointes ?')) return;
  draft.saved = true; await deleteEvent(base.id); dlgEvent.close(); render();
};
$('#delOcc').onclick = async () => { const base = events.find(e => e.id === draft.ev.id); base.exceptions = [...new Set([...(base.exceptions || []), draft.occDate])]; draft.saved = true; await saveEvent(base); dlgEvent.close(); render(); };
$('#delSeries').onclick = async () => { if (!confirm('Supprimer toute la série ?')) return; draft.saved = true; await deleteEvent(draft.ev.id); dlgEvent.close(); render(); };

/* Voix : dictée (reconnaissance du navigateur) et mémo vocal (100 % local) */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, mediaRec = null, memoStream = null, memoCancel = false;
if (!SR) $('#btnDictate').hidden = true;
$('#btnDictate').onclick = () => {
  if (recog) { recog.stop(); return; }
  recog = new SR(); recog.lang = 'fr-FR'; recog.continuous = true; recog.interimResults = false;
  recog.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) {
      const ta = $('#evNotes'), t = e.results[i][0].transcript.trim();
      ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + t;
    }
  };
  recog.onend = () => { recog = null; $('#btnDictate').textContent = '🎤 Dicter'; $('#btnDictate').classList.remove('rec'); };
  recog.onerror = e => { if (e.error === 'not-allowed') toast('Micro refusé : autorisez-le dans le navigateur.'); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Dictée indisponible (' + e.error + ')'); };
  try { recog.start(); $('#btnDictate').textContent = '⏹ Arrêter'; $('#btnDictate').classList.add('rec'); } catch (err) { recog = null; }
};
function pickAudioType() {
  if (!window.MediaRecorder) return '';
  return ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}
if (!window.MediaRecorder || !navigator.mediaDevices) $('#btnMemo').hidden = true;
$('#btnMemo').onclick = async () => {
  if (mediaRec) { mediaRec.stop(); return; }
  try {
    memoStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [], type = pickAudioType();
    mediaRec = type ? new MediaRecorder(memoStream, { mimeType: type }) : new MediaRecorder(memoStream);
    memoCancel = false;
    mediaRec.ondataavailable = e => e.data.size && chunks.push(e.data);
    mediaRec.onstop = async () => {
      memoStream.getTracks().forEach(t => t.stop());
      const t = (mediaRec.mimeType || 'audio/webm').split(';')[0];
      mediaRec = null; $('#btnMemo').textContent = '🔴 Mémo vocal'; $('#btnMemo').classList.remove('rec');
      if (memoCancel || !draft) return;
      const ext = t.includes('mp4') ? 'm4a' : t.includes('ogg') ? 'ogg' : 'webm';
      const now = new Date();
      await addFiles([new File(chunks, `Mémo vocal ${pad(now.getHours())}h${pad(now.getMinutes())}.${ext}`, { type: t })]);
    };
    mediaRec.start(); $('#btnMemo').textContent = '⏹ Arrêter le mémo'; $('#btnMemo').classList.add('rec');
  } catch (err) { toast('Micro indisponible : ' + err.message); }
};
function stopVoice(cancelMemo) { if (recog) recog.stop(); if (mediaRec && cancelMemo) { memoCancel = true; mediaRec.stop(); } }

/* ---------------- Catégories ---------------- */
function renderCatEdit() {
  const counts = {}; live().forEach(e => counts[e.catId || ''] = (counts[e.catId || ''] || 0) + 1);
  $('#catEditList').innerHTML = liveCats().map(c => `<div class="cat-edit" data-id="${c.id}"><input type="color" value="${c.color}"><input type="text" value="${esc(c.name)}"><span class="hint">${counts[c.id] || 0}</span><button class="icon-btn" data-del title="Supprimer">🗑</button></div>`).join('');
}
$('#btnCats').onclick = () => { renderCatEdit(); $('#dlgCats').showModal(); };
$('#catEditList').addEventListener('change', async e => {
  const row = e.target.closest('.cat-edit'); if (!row) return;
  const c = cats.find(x => x.id === row.dataset.id);
  c.color = row.querySelector('[type=color]').value; c.name = row.querySelector('[type=text]').value.trim() || 'Sans nom';
  await saveCat(c); render();
});
$('#catEditList').addEventListener('click', async e => {
  if (!e.target.closest('[data-del]')) return;
  const id = e.target.closest('.cat-edit').dataset.id, c = cats.find(x => x.id === id);
  const n = live().filter(ev => ev.catId === id).length;
  if (!confirm(`Supprimer « ${c.name} » ?` + (n ? `\n${n} entrée(s) passeront en « Sans catégorie ».` : ''))) return;
  for (const ev of live().filter(ev => ev.catId === id)) { ev.catId = ''; await saveEvent(ev); }
  Object.assign(c, { deleted: true }); await saveCat(c); renderCatEdit(); render();
});
$('#catAdd').onclick = async () => {
  const palette = ['#b5562f', '#2f7bb5', '#3d8a4a', '#8a4fb5', '#c99a1c', '#c2416b', '#2a9a8f', '#6b6b6b'];
  await saveCat({ id: uid(), name: 'Nouvelle catégorie', color: palette[liveCats().length % palette.length] });
  renderCatEdit(); render();
  const inputs = $$('#catEditList [type=text]'); inputs[inputs.length - 1]?.select();
};
$('#catList').onchange = e => { const id = e.target.dataset.cat; if (id === undefined) return; e.target.checked ? hidden.delete(id) : hidden.add(id); render(); };

/* ---------------- Réglages ---------------- */
$('#btnSettings').onclick = () => {
  $('#setStart').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${pad(h)}:00</option>`).join('');
  $('#setEnd').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h + 1}">${pad(h + 1)}:00</option>`).join('');
  $('#setStart').value = settings.dayStart; $('#setEnd').value = settings.dayEnd; $('#setWeek').value = settings.weekStart;
  $('#dlgSettings').showModal();
};
$('#setSave').onclick = async () => {
  const a = +$('#setStart').value, b = +$('#setEnd').value;
  if (b <= a) { toast('La fin doit être après le début.'); return; }
  settings.dayStart = a; settings.dayEnd = b; settings.weekStart = +$('#setWeek').value;
  await saveSettings(); $('#dlgSettings').close(); render();
};

/* ---------------- Recherche ---------------- */
$('#search').addEventListener('input', () => {
  query = $('#search').value.trim(); render();
  const box = $('#results');
  if (!query) { box.hidden = true; return; }
  const res = live().filter(e => matches(e, query)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  box.innerHTML = res.length ? res.map(e => `<button data-go="${e.date}" data-open="${e.id}"><b>${esc(dTitle(e))}</b><small>${fDMY.format(parse(e.date))}${hasRec(e) ? ' · ↻' : ''} · ${esc(catOf(e.catId).name)}</small></button>`).join('') : '<p class="hint" style="padding:8px">Aucun résultat.</p>';
  box.hidden = false;
});
$('#search').addEventListener('blur', () => setTimeout(() => $('#results').hidden = true, 200));
$('#search').addEventListener('focus', () => { if (query) $('#results').hidden = false; });
$('#results').onclick = e => { const b = e.target.closest('[data-go]'); if (!b) return; cursor = parse(b.dataset.go); view = 'day'; $('#results').hidden = true; render(); };

/* ---------------- Export / import ---------------- */
const blobToB64 = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(b); });
function b64ToBlob(d, type) { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
$('#btnExport').onclick = async () => {
  toast('Préparation de la sauvegarde…');
  const needed = new Set(live().flatMap(e => (e.attachments || []).map(a => a.id)));
  const files = [], missing = [];
  for (const id of needed) {
    let r = await dbGet('files', id);
    if (!r && window.Sync) { try { const b = await Sync.fetchFile(id); if (b) r = { id, blob: b }; } catch (e) {} }
    if (r) files.push({ id, type: r.blob.type, data: await blobToB64(r.blob) }); else missing.push(id);
  }
  const data = { app: 'journal-perso', version: 1, exported: new Date().toISOString(), settings, cats: liveCats(), events: live(), files };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `journal-sauvegarde-${ymd(new Date())}.json`);
  toast(missing.length ? `Sauvegarde créée (${missing.length} fichier(s) non disponibles hors ligne).` : 'Sauvegarde créée. Attention : ce fichier n\'est pas chiffré.');
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'journal-perso') throw new Error('fichier non reconnu');
    if (!confirm(`Restaurer ${data.events.length} entrée(s) ? Elles seront fusionnées avec les entrées actuelles (les versions identiques sont remplacées).`)) return;
    for (const x of data.files || []) await dbPut('files', { id: x.id, blob: b64ToBlob(x.data, x.type), synced: false });
    for (const c of data.cats || []) { c.updated = Date.now(); await dbPut('cats', c); }
    for (const ev of data.events || []) { ev.updated = Date.now(); await dbPut('events', ev); }
    await loadAll(); changed(); render(); toast('Sauvegarde restaurée.');
  } catch (err) { alert('Import impossible : ' + err.message); }
};

/* ---------------- Impression ---------------- */
const PAPER = { A4: [210, 297], A5: [148, 210], letter: [216, 279] };
let printPrefs = {};
function pageDims(o) { let [w, h] = PAPER[o.paper] || PAPER.A4; if (o.orient === 'landscape') [w, h] = [h, w]; return { w: w - 2 * o.margin, h: h - 2 * o.margin - 4 }; }
function readPrintOpts() {
  let from = $('#pFrom').value || ymd(cursor), to = $('#pTo').value || from;
  if (to < from) [from, to] = [to, from];
  let h1 = Math.min(23, Math.max(0, +$('#pH1').value || 0)), h2 = Math.min(24, Math.max(1, +$('#pH2').value || 24)); if (h2 <= h1) h2 = Math.min(24, h1 + 1);
  return {
    format: $('#pFormat').value, from, to,
    cats: $$('#pCats input:checked').map(i => i.value),
    notes: $('#pNotes').checked, images: $('#pImages').checked, imgSize: +$('#pImgSize').value, attach: $('#pAttach').checked,
    empty: $('#pEmpty').checked, pagePerDay: $('#pPageDay').checked, lines: Math.min(40, Math.max(0, +$('#pLines').value || 0)),
    h1, h2, paper: $('#pPaper').value, orient: $('#pOrient').value, margin: Math.min(40, Math.max(3, +$('#pMargin').value || 12)),
    font: Math.min(18, Math.max(6, +$('#pFont').value || 10)), fam: $('#pFam').value, color: $('#pColor').checked, title: $('#pTitle').value.trim()
  };
}
function setQuick(q) {
  const v0 = view; view = q; const [a, b] = rangeOfView(); view = v0;
  $('#pFrom').value = a; $('#pTo').value = b;
}
function openPrint() {
  const p = printPrefs;
  $('#pFormat').value = p.format || ({ day: 'day', week: 'week', month: 'month' })[view];
  const allCats = [...liveCats(), NOCAT];
  $('#pCats').innerHTML = allCats.map(c => `<label class="chk"><input type="checkbox" value="${c.id}" ${hidden.has(c.id) ? '' : 'checked'}><span class="dot" style="--c:${c.color}"></span>${esc(c.name)}</label>`).join('');
  const set = (id, k, def) => { const el = $(id); const v = p[k] ?? def; if (el.type === 'checkbox') el.checked = v; else el.value = v; };
  set('#pNotes', 'notes', true); set('#pImages', 'images', true); set('#pImgSize', 'imgSize', 50); set('#pAttach', 'attach', true);
  set('#pEmpty', 'empty', false); set('#pPageDay', 'pagePerDay', false); set('#pLines', 'lines', 0);
  set('#pH1', 'h1', settings.dayStart); set('#pH2', 'h2', settings.dayEnd);
  set('#pPaper', 'paper', 'A4'); set('#pOrient', 'orient', 'portrait'); set('#pMargin', 'margin', 12); set('#pFont', 'font', 10);
  set('#pFam', 'fam', 'serif'); set('#pColor', 'color', true); set('#pTitle', 'title', '');
  setQuick(view);
  $('#dlgPrint').showModal(); updatePreview();
}
function headerHtml(o, sub) { return `<header class="p-head">${o.title ? `<div class="p-ttl">${esc(o.title)}</div>` : ''}<div class="p-sub">${esc(sub)}</div></header>`; }
const headH = o => (o.title ? 12 : 7) * (o.font / 10) + 4;
function pColor(o, c) { return o.color ? c.color : '#777'; }
function entriesHtml(list, o) {
  return list.map(x => {
    const ev = x.ev, c = catOf(ev.catId);
    const imgs = o.images ? (ev.attachments || []).filter(a => /^image\//.test(a.type) && urlCache.get(a.id)) : [];
    const others = o.attach ? (ev.attachments || []).filter(a => !(o.images && /^image\//.test(a.type) && urlCache.get(a.id))) : [];
    const title = o.notes ? ev.title : dTitle(ev);
    return `<article class="p-entry" style="--c:${pColor(o, c)}"><div class="p-time">${isTimed(ev) ? esc(ev.start) + (ev.end ? '<br>' + esc(ev.end) : '') : ''}</div><div class="p-body">
      <div class="p-title"><span class="p-cat">${esc(c.name)}</span>${esc(title || '')}</div>
      ${o.notes && ev.notes ? `<div class="p-notes">${esc(ev.notes)}</div>` : ''}
      ${imgs.length ? `<div class="p-imgs">${imgs.map(a => `<img src="${urlCache.get(a.id)}" style="max-height:${o.imgSize}mm">`).join('')}</div>` : ''}
      ${others.length ? `<div class="p-att">📎 ${others.map(a => esc(a.name)).join(' · ')}</div>` : ''}</div></article>`;
  }).join('');
}
const linesHtml = o => o.lines ? `<div class="p-lines">${'<div></div>'.repeat(o.lines)}</div>` : '';
function gridHtml(days, occ, o, gridH, adH, withNotes) {
  const hh = gridH / (o.h2 - o.h1);
  let s = `<div class="pg" style="grid-template-columns:10mm repeat(${days.length},minmax(0,1fr))"><div></div>`;
  days.forEach(d => s += `<div class="pg-dh">${days.length > 1 ? cap(fDay.format(parse(d))) : ''}</div>`);
  if (adH) {
    s += `<div class="pg-gl">jour</div>`;
    days.forEach(d => s += `<div class="pg-ad" style="height:${adH}mm">${occ.filter(x => x.date === d && !isTimed(x.ev)).map(x => `<div class="pg-chip" style="--c:${pColor(o, catOf(x.ev.catId))}">${esc(dTitle(x.ev))}</div>`).join('')}</div>`);
  }
  s += `<div class="pg-gut" style="height:${gridH}mm">`;
  for (let h = o.h1; h < o.h2; h++) s += `<div style="position:absolute;top:${(h - o.h1) * hh}mm;right:0">${pad(h)}h</div>`;
  s += `</div>`;
  for (const d of days) {
    const items = layout(occ.filter(x => x.date === d && isTimed(x.ev)).map(x => { const [a, b] = span(x.ev); return { x, s: a, e: b }; }));
    s += `<div class="pg-col" style="height:${gridH}mm">`;
    for (let h = o.h1; h < o.h2; h++) s += `<div class="pg-hr" style="top:${(h - o.h1) * hh}mm"></div>`;
    for (const it of items) {
      let top = (it.s - o.h1 * 60) / 60 * hh, bot = (it.e - o.h1 * 60) / 60 * hh;
      top = Math.min(Math.max(0, top), gridH - 4); bot = Math.min(Math.max(bot, top + 4), gridH);
      const ev = it.x.ev;
      s += `<div class="pg-ev" style="top:${top}mm;height:${bot - top}mm;left:${it.col / it.n * 100}%;width:${100 / it.n}%;--c:${pColor(o, catOf(ev.catId))}"><b>${esc(ev.start)}</b> ${esc(dTitle(ev))}${withNotes && ev.notes && ev.title ? `<div class="pg-n">${esc(ev.notes)}</div>` : ''}</div>`;
    }
    s += `</div>`;
  }
  return s + `</div>`;
}
async function buildPrint(o) {
  const dims = pageDims(o);
  const occ = occurrences(o.from, o.to, { cats: new Set(o.cats) });
  if (o.images) for (const x of occ) for (const a of x.ev.attachments || []) if (/^image\//.test(a.type)) await fileUrl(a.id);
  const pages = [];
  const page = (inner, fixed) => `<section class="p-page ${fixed ? 'p-fixed' : ''}">${inner}</section>`;
  const days = enumDays(o.from, o.to);
  const rangeTxt = o.from === o.to ? cap(fLong.format(parse(o.from))) : `Du ${fDMY.format(parse(o.from))} au ${fDMY.format(parse(o.to))}`;
  if (o.format === 'list') {
    let acc = '';
    for (const d of days) {
      const list = occ.filter(x => x.date === d);
      if (!list.length && !o.empty && !o.lines) continue;
      const block = `<div class="p-day"><h2>${cap(fLong.format(parse(d)))}</h2>${list.length ? entriesHtml(list, o) : (o.lines ? '' : '<p class="p-empty">—</p>')}${linesHtml(o)}</div>`;
      if (o.pagePerDay) pages.push(page(headerHtml(o, cap(fLong.format(parse(d)))).replace(/<div class="p-sub">.*?<\/div>/, o.title ? '' : '<div class="p-sub"></div>') + block));
      else acc += block;
    }
    if (!o.pagePerDay || !pages.length) pages.push(page(headerHtml(o, rangeTxt) + (acc || '<p class="p-empty">Aucune entrée sur cette période.</p>')));
  } else if (o.format === 'week') {
    let ws = startOfWeek(parse(o.from));
    for (let i = 0; ymd(ws) <= o.to && i < 60; i++, ws = addDays(ws, 7)) {
      const wd = Array.from({ length: 7 }, (_, k) => ymd(addDays(ws, k)));
      const wocc = occurrences(wd[0], wd[6], { cats: new Set(o.cats) });
      const adMax = Math.max(0, ...wd.map(d => wocc.filter(x => x.date === d && !isTimed(x.ev)).length));
      const adH = adMax ? Math.min(32, 3 + adMax * 4.2 * o.font / 10) : 0;
      const gridH = dims.h - headH(o) - 7 - adH - 2;
      const sub = `Semaine du ${fDM.format(parse(wd[0]))} au ${fDMY.format(parse(wd[6]))}`;
      pages.push(page(headerHtml(o, sub) + gridHtml(wd, wocc, o, gridH, adH, o.notes), true));
    }
  } else if (o.format === 'day') {
    for (const d of days) {
      const list = occ.filter(x => x.date === d);
      if (!list.length && !o.empty) continue;
      const gridH = dims.h - headH(o) - 7 - 2;
      pages.push(page(headerHtml(o, cap(fLong.format(parse(d)))) + `<div class="pday"><div>${gridHtml([d], list, o, gridH, 0, false)}</div><div>${list.length ? entriesHtml(list, o) : '<p class="p-empty">Aucune entrée.</p>'}${linesHtml(o)}</div></div>`));
    }
    if (!pages.length) pages.push(page(headerHtml(o, rangeTxt) + '<p class="p-empty">Aucune entrée sur cette période.</p>'));
  } else {
    let m = new Date(parse(o.from).getFullYear(), parse(o.from).getMonth(), 1);
    for (let i = 0; ymd(m) <= o.to && i < 36; i++, m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const last = new Date(m.getFullYear(), m.getMonth() + 1, 0), s0 = startOfWeek(m);
      const weeks = Math.ceil((((m.getDay() - settings.weekStart + 7) % 7) + last.getDate()) / 7);
      const mocc = occurrences(ymd(s0), ymd(addDays(s0, weeks * 7 - 1)), { cats: new Set(o.cats) });
      const rowH = (dims.h - headH(o) - 8) / weeks;
      let t = `<table class="pm"><thead><tr>${Array.from({ length: 7 }, (_, k) => `<th>${cap(fWd.format(addDays(s0, k)))}</th>`).join('')}</tr></thead><tbody>`;
      for (let w = 0; w < weeks; w++) {
        t += '<tr>';
        for (let k = 0; k < 7; k++) {
          const d = addDays(s0, w * 7 + k), key = ymd(d);
          const list = mocc.filter(x => x.date === key);
          t += `<td class="${d.getMonth() !== m.getMonth() ? 'out' : ''}" style="height:${rowH}mm"><div style="height:${rowH - 1.6}mm"><span class="n">${d.getDate()}</span>${list.map(x => `<div class="pm-e ${o.notes ? 'wrap' : ''}" style="--c:${pColor(o, catOf(x.ev.catId))}">${isTimed(x.ev) ? esc(x.ev.start) + ' ' : ''}${esc(dTitle(x.ev))}</div>`).join('')}</div></td>`;
        }
        t += '</tr>';
      }
      pages.push(page(headerHtml(o, cap(fMonth.format(m))) + t + '</tbody></table>', true));
    }
  }
  return `<div class="p-root ${o.fam === 'sans' ? 'sans' : ''}" style="font-size:${o.font}pt;--pw:${dims.w}mm;--ph:${dims.h}mm;--pm:${o.margin}mm">${pages.join('')}</div>`;
}
let prevTimer;
function updatePreview() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(async () => {
    const o = readPrintOpts();
    $('#pPreview').innerHTML = await buildPrint(o);
    const [w] = (() => { let [a, b] = PAPER[o.paper]; return o.orient === 'landscape' ? [b, a] : [a, b]; })();
    const box = $('#dlgPrint .print-preview');
    $('#pPreview').style.zoom = Math.min(1, (box.clientWidth - 40) / (w * 3.78));
  }, 150);
}
$('#dlgPrint .print-opts').addEventListener('input', updatePreview);
$('#dlgPrint .print-opts').addEventListener('change', updatePreview);
$$('#dlgPrint [data-q]').forEach(b => b.onclick = () => { setQuick(b.dataset.q); updatePreview(); });
$('#pAllCats').onclick = () => { $$('#pCats input').forEach(i => i.checked = true); updatePreview(); };
$('#pNoCats').onclick = () => { $$('#pCats input').forEach(i => i.checked = false); updatePreview(); };
$('#btnPrint').onclick = openPrint;
let pageStyle = document.createElement('style'); document.head.appendChild(pageStyle);
$('#pGo').onclick = async () => {
  const o = readPrintOpts();
  printPrefs = { ...o }; delete printPrefs.from; delete printPrefs.to; delete printPrefs.cats;
  metaSet('printPrefs', printPrefs);
  const area = $('#print-area');
  area.innerHTML = await buildPrint(o);
  pageStyle.textContent = `@page{size:${o.paper} ${o.orient};margin:${o.margin}mm}`;
  await Promise.all([...area.querySelectorAll('img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
  $('#dlgPrint').close();
  setTimeout(() => window.print(), 50);
};
window.addEventListener('afterprint', () => { $('#print-area').innerHTML = ''; });

/* ---------------- Interactions ---------------- */
$('#main').addEventListener('click', e => {
  const t = e.target;
  const evEl = t.closest('[data-id]');
  if (evEl) { openEditor(evEl.dataset.id, evEl.dataset.date); return; }
  const day = t.closest('[data-day]');
  if (day) { cursor = parse(day.dataset.day); setView('day'); return; }
  const nw = t.closest('[data-new]');
  if (nw) {
    const h = nw.dataset.h;
    openEditor(null, null, h !== undefined ? { date: nw.dataset.new, start: pad(+h) + ':00', end: +h + 1 >= 24 ? '23:59' : pad(+h + 1) + ':00' } : { date: nw.dataset.new });
  }
});
$('#mini').addEventListener('click', e => {
  const m = e.target.closest('[data-mini]'); if (m) { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + +m.dataset.mini, 1); render(); return; }
  const g = e.target.closest('[data-go]'); if (g) { cursor = parse(g.dataset.go); render(); document.body.classList.remove('side-open'); }
});
$('#prev').onclick = () => go(-1); $('#next').onclick = () => go(1);
$('#today').onclick = () => { cursor = startOfDay(new Date()); render(); };
$('#viewSeg').onclick = e => { const b = e.target.closest('[data-v]'); if (b) setView(b.dataset.v); };
$('#btnNew').onclick = () => {
  const [a, b] = rangeOfView(), t = ymd(new Date());
  openEditor(null, null, { date: view === 'day' ? ymd(cursor) : (t >= a && t <= b ? t : a) });
};
$('#btnSide').onclick = () => document.body.classList.toggle('side-open');
document.body.addEventListener('click', e => { if (document.body.classList.contains('side-open') && !e.target.closest('aside') && !e.target.closest('#btnSide')) document.body.classList.remove('side-open'); });
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select') || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowLeft') go(-1); else if (k === 'ArrowRight') go(1);
  else if (k === 't') $('#today').click(); else if (k === 'n') $('#btnNew').click();
  else if (k === 'j') setView('day'); else if (k === 's') setView('week'); else if (k === 'm') setView('month');
  else if (k === 'p') openPrint(); else return;
  e.preventDefault();
});
/* Balayage gauche/droite sur mobile */
let tx0 = null, ty0 = 0;
$('#main').addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; ty0 = e.touches[0].clientY; }, { passive: true });
$('#main').addEventListener('touchend', e => {
  if (tx0 === null) return; const dx = e.changedTouches[0].clientX - tx0, dy = e.changedTouches[0].clientY - ty0; tx0 = null;
  if (Math.abs(dx) > 80 && Math.abs(dy) < 50 && view !== 'week') go(dx < 0 ? 1 : -1);
}, { passive: true });
setInterval(() => { if (!document.querySelector('dialog[open]')) render(); }, 5 * 60 * 1000);

/* ---------------- Démarrage ---------------- */
async function loadAll() {
  events = await dbAll('events'); cats = await dbAll('cats');
  settings = Object.assign({ dayStart: 7, dayEnd: 22, weekStart: 1, updated: 0 }, (await metaGet('settings')) || {});
}
async function init() {
  try { db = await openDB(); }
  catch (e) { $('#main').innerHTML = `<p style="padding:30px">Impossible d'ouvrir le stockage local (${esc(e.message)}). Vérifiez que le navigateur n'est pas en navigation privée.</p>`; return; }
  await loadAll();
  if (!cats.length && !(await metaGet('initDone'))) {
    const defs = [['Personnel', '#b5562f'], ['Travail', '#2f7bb5'], ['Santé', '#3d8a4a'], ['Famille', '#8a4fb5'], ['Idées', '#c99a1c']];
    for (const [name, color] of defs) await saveCat({ id: uid(), name, color, updated: 1 });
    await metaSet('initDone', true);
  }
  printPrefs = (await metaGet('printPrefs')) || {};
  let v = null; try { v = localStorage.getItem('journal.view'); } catch (e) {}
  view = v || (innerWidth < 820 ? 'day' : 'week');
  navigator.storage?.persist?.();
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (window.Sync) Sync.init();
}
/* API utilisée par sync.js */
window.Journal = {
  get db() { return db; }, dbAll, dbGet, dbPut, dbDel, metaGet, metaSet, loadAll, render, toast,
  get events() { return events; }, get cats() { return cats; }, get settings() { return settings; },
  set settings(v) { settings = v; }, isEditing: () => !!document.querySelector('dialog[open]'), fileUrl
};
document.addEventListener('DOMContentLoaded', init);
