# Mon Journal : guide de mise en place (environ 30 min, une seule fois)

Vous allez faire trois choses :

1. **Héberger l'app** gratuitement sur GitHub Pages, pour qu'elle ait une adresse web accessible depuis tous vos appareils.
2. **Créer un identifiant Google** qui autorise l'app à utiliser un dossier caché de votre Google Drive.
3. **Installer l'app** sur le PC, le téléphone et la tablette.

> 🔒 **À propos de la confidentialité.** Le *code* de l'app sera public sur GitHub, comme une recette de cuisine. Vos *données*, elles, n'y sont jamais. Elles restent sur vos appareils et, chiffrées, dans votre Google Drive.

---

## Étape 1 : Héberger l'app sur GitHub (10 min)

1. Allez sur **github.com** et créez un compte gratuit (« Sign up »). Choisissez bien votre **nom d'utilisateur** : il fera partie de l'adresse de l'app, par exemple `robin-g`.
2. Une fois connecté, cliquez sur **+** en haut à droite, puis **New repository**.
   - *Repository name* : `journal`
   - Cochez **Public** (obligatoire pour l'hébergement gratuit).
   - Cliquez sur **Create repository**.
3. Sur la page qui s'affiche, cliquez sur le lien **uploading an existing file**.
4. Décompressez le fichier `mon-journal.zip` sur votre PC. Glissez **tous les fichiers qu'il contient** (pas le dossier lui-même) dans la page GitHub, puis cliquez sur **Commit changes**.
5. Allez dans **Settings** (onglet en haut), puis **Pages** (menu de gauche).
   - *Source* : **Deploy from a branch**
   - *Branch* : **main** et **/ (root)**, puis **Save**.
6. Patientez 1 à 2 minutes et rechargez la page. L'adresse de votre app s'affiche :
   **`https://VOTRE-NOM.github.io/journal/`**

Ouvrez-la : l'app fonctionne déjà, en mode local sur cet appareil. Notez cette adresse.

---

## Étape 2 : Créer l'identifiant Google (15 min)

Google affiche ces écrans en français ou en anglais selon votre compte. Les termes anglais sont indiqués entre parenthèses.

1. Allez sur **console.cloud.google.com**, avec le compte Google dont vous voulez utiliser le Drive.
2. En haut, cliquez sur le sélecteur de projet, puis **Nouveau projet** (*New project*). Nommez-le `Mon Journal`, puis **Créer**. Vérifiez qu'il est bien sélectionné en haut de la page.
3. **Activer l'API Drive.** Dans la barre de recherche du haut, tapez `Google Drive API`, ouvrez-la, puis cliquez sur **Activer** (*Enable*).
4. **Écran de consentement.** Dans le menu ☰, allez dans **API et services**, puis **Écran de consentement OAuth**. Google l'appelle parfois *Google Auth Platform*. Cliquez sur **Commencer** (*Get started*).
   - Nom de l'application : `Mon Journal`. E-mail d'assistance : le vôtre.
   - Audience : **Externe** (*External*).
   - Coordonnées : votre e-mail. Acceptez les conditions, puis **Créer**.
5. **Vous ajouter comme testeur.** Dans le menu de gauche **Audience**, section *Utilisateurs test* (*Test users*), cliquez sur **Add users**, saisissez **votre adresse Gmail**, puis **Enregistrer**.
   *(L'app reste en mode « test », réservée à vous seul. C'est parfait pour un usage personnel.)*
6. **Créer l'identifiant.** Menu de gauche **Clients** (ou *Identifiants*), puis **Créer un client** (*Create client*).
   - Type d'application : **Application Web** (*Web application*).
   - Nom : `Journal`.
   - **Origines JavaScript autorisées** (*Authorized JavaScript origins*), cliquez sur **Ajouter un URI** et saisissez :
     `https://VOTRE-NOM.github.io`
     ⚠ Sans `/journal` et sans `/` final.
   - Laissez les « URI de redirection » vides, puis **Créer**.
7. Copiez l'**ID client** affiché. Il se termine par `.apps.googleusercontent.com`.

**Mettre l'identifiant dans l'app :**

8. Retournez sur votre dépôt GitHub `journal` et cliquez sur le fichier **config.js**, puis sur le crayon ✏️ (*Edit*).
9. Collez l'ID entre les guillemets :
   ```js
   googleClientId: '123456-abcdef.apps.googleusercontent.com'
   ```
10. Cliquez sur **Commit changes** (deux fois). Attendez une minute que le site se mette à jour.

---

## Étape 3 : Activer la synchro et installer l'app (5 min)

**Sur le PC (Chrome ou Edge) :**

1. Ouvrez `https://VOTRE-NOM.github.io/journal/`.
2. Cliquez sur **☁ Synchro**, puis **Se connecter à Google Drive**.
3. Google affiche « *Google n'a pas validé cette application* ». C'est normal, puisque c'est votre propre app. Cliquez sur **Continuer**, puis autorisez l'accès.
4. Choisissez votre **mot de passe de chiffrement**.
   ⚠ **Notez-le en lieu sûr.** Il n'existe aucun moyen de le récupérer.
5. Pour installer l'app : cliquez sur l'icône d'installation à droite de la barre d'adresse (un écran avec une flèche), ou passez par le menu ⋮, puis **Installer Mon Journal**.

**Sur le téléphone et la tablette Android (Chrome) :**

1. Ouvrez la même adresse.
2. Menu ⋮, puis **Ajouter à l'écran d'accueil** (ou **Installer l'application**).
3. Ouvrez l'app depuis son icône, touchez **☁ Synchro**, puis **Se connecter à Google Drive**, et saisissez **le même mot de passe**.

**Plus tard, sur un iPhone, un iPad ou un Mac :** même adresse, mais avec Safari. Sur iPhone et iPad, passez par Partager, puis **Sur l'écran d'accueil**. Ensuite, connexion Google et même mot de passe.

---

## Au quotidien

- **La synchro est automatique** : à l'ouverture, après chaque modification et toutes les 5 minutes.
- **Après une heure d'inactivité**, Google demande de confirmer la connexion. Un bandeau orange apparaît alors : touchez **Reconnecter**, c'est l'affaire d'une seconde. Pendant ce temps, vous pouvez continuer à écrire : rien n'est perdu.
- **Hors connexion**, tout fonctionne. Les modifications partent au retour du réseau.
- **Pièces jointes** : elles sont envoyées chiffrées. Sur un autre appareil, elles sont téléchargées au moment où vous les ouvrez.
- **Mémo vocal** (🔴) : c'est un enregistrement audio joint à l'entrée, 100 % privé.
  **Dictée** (🎤) : elle transforme votre voix en texte dans les notes. Attention, la reconnaissance est faite par Google ou Apple.
- **Sauvegarde** : de temps en temps, faites **⬇ Sauvegarde (export)** depuis le PC. Le fichier obtenu n'est **pas chiffré** : rangez-le en lieu sûr.
- **Raccourcis clavier sur PC** : ← → pour naviguer, `n` pour une nouvelle entrée, `t` pour aujourd'hui, `j`/`s`/`m` pour les vues jour, semaine et mois, `p` pour imprimer.

## Imprimer

Bouton **🖨 Imprimer**. Choisissez :

- **la mise en page** : journal détaillé, jour (grille et notes), semaine (grille horaire) ou mois (calendrier) ;
- **la période** et **les catégories** ;
- **le contenu** : notes, images et leur taille, pièces jointes, jours vides, une page par jour, lignes vierges pour écrire à la main ;
- **la page** : A4, A5 ou Letter, portrait ou paysage, marges, taille et style du texte, couleurs ou noir et blanc, titre.

L'aperçu se met à jour en direct. Dans la fenêtre d'impression, vous pouvez aussi choisir **Enregistrer au format PDF**.

## En cas de souci

| Problème | Solution |
|---|---|
| « Fenêtre Google bloquée » | Autorisez les pop-ups pour votre adresse `github.io`. |
| Erreur `origin_mismatch` ou `redirect_uri_mismatch` | Vérifiez l'origine à l'étape 2.6 : exactement `https://VOTRE-NOM.github.io`. |
| Erreur `access_denied` | Votre adresse Gmail n'est pas dans les « Utilisateurs test » (étape 2.5). |
| L'app ne reflète pas une modification de `config.js` | Attendez 2 minutes, puis fermez et rouvrez l'app. |
