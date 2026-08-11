# Fideli-Maroc — Backend

## C'est quoi ces fichiers ?
- `server.js` : le programme qui gère les clients et les points de fidélité
- `package.json` : la liste des outils dont le programme a besoin

## Comment le mettre en ligne (étape par étape)

### 1. Mets ces fichiers sur GitHub
1. Va sur https://github.com et connecte-toi (ou crée un compte gratuit)
2. Clique sur le bouton vert **"New"** (nouveau dépôt)
3. Nomme-le `fideli-maroc-backend`, laisse-le en **Public** ou **Private**, clique **"Create repository"**
4. Sur la page suivante, clique **"uploading an existing file"**
5. Glisse-dépose les 3 fichiers (`server.js`, `package.json`, `README.md`)
6. Clique **"Commit changes"**

### 2. Connecte-le à Railway
1. Retourne sur ton projet Railway (celui avec ta base Postgres)
2. Clique **"New"** → **"GitHub Repo"**
3. Autorise Railway à accéder à GitHub si demandé, puis sélectionne `fideli-maroc-backend`
4. Railway va détecter automatiquement que c'est une appli Node.js et va essayer de la démarrer

### 3. Connecte la base de données au backend
1. Clique sur ton nouveau service (le backend) dans Railway
2. Va dans l'onglet **"Variables"**
3. Clique **"New Variable"** → **"Add Reference"**
4. Choisis la variable `DATABASE_URL` qui vient du service **Postgres**
5. Railway va redéployer automatiquement

### 4. Récupère l'adresse de ton backend
1. Toujours dans ton service backend, va dans **"Settings"**
2. Descends jusqu'à **"Networking"**
3. Clique **"Generate Domain"**
4. Tu obtiens une adresse du type `https://fideli-maroc-backend-production.up.railway.app`

### 5. Vérifie que ça marche
Ouvre cette adresse dans ton navigateur en ajoutant `/health` à la fin, par exemple :
`https://fideli-maroc-backend-production.up.railway.app/health`

Tu dois voir : `{"status":"ok","message":"Fideli-Maroc backend en ligne"}`

Si tu vois ça, ton backend est en ligne et prêt à recevoir des vrais clients.
