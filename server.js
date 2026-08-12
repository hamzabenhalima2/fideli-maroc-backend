// Fideli-Maroc — Backend API
// Gère les commerces, les clients, et les points de fidélité.

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const GOAL = 5; // nombre de points pour débloquer une récompense

// ---- Configuration Google Wallet ----
const WALLET_ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID; // ex: 3388000000023187431
const WALLET_CLASS_SUFFIX = process.env.GOOGLE_WALLET_CLASS_ID || 'fideli_maroc_v1';
let serviceAccount = null;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
} catch (e) {
  console.error('Impossible de lire GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
}

function sanitizeForId(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function generateShopCode() {
  return crypto.randomBytes(4).toString('hex'); // ex: "a1b2c3d4"
}

// Transforme "Pâtisserie Palais de Gâteaux" -> "patisserie-palais-de-gateaux"
function slugify(str) {
  return String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// Génère un slug unique pour un commerce (ajoute -2, -3... si déjà pris)
async function generateUniqueSlug(name) {
  const base = slugify(name) || 'commerce';
  let slug = base;
  let i = 2;
  while (true) {
    const { rows } = await pool.query('SELECT id FROM shops WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${i}`;
    i++;
  }
}

function buildWalletSaveUrl(client) {
  if (!serviceAccount || !WALLET_ISSUER_ID) {
    throw new Error('Google Wallet non configuré sur le serveur');
  }
  const classId = `${WALLET_ISSUER_ID}.${WALLET_CLASS_SUFFIX}`;
  const objectId = `${WALLET_ISSUER_ID}.${sanitizeForId(client.phone)}`;

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountName: client.name,
    accountId: client.phone,
    loyaltyPoints: {
      label: 'Points',
      balance: { string: String(client.stamps) },
    },
  };

  const claims = {
    iss: serviceAccount.client_email,
    aud: 'google',
    typ: 'savetowallet',
    origins: [],
    payload: {
      loyaltyObjects: [loyaltyObject],
    },
  };

  const token = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// Récupère un jeton d'accès Google (OAuth2) pour appeler l'API Wallet
async function getGoogleAccessToken() {
  if (!serviceAccount) throw new Error('Google Wallet non configuré');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const assertion = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Impossible d\'obtenir le jeton Google');
  return data.access_token;
}

// Pousse le nouveau solde de points vers la carte déjà installée du client
async function pushWalletUpdate(client) {
  if (!serviceAccount || !WALLET_ISSUER_ID) return; // Google Wallet non configuré, on ignore silencieusement
  const objectId = `${WALLET_ISSUER_ID}.${sanitizeForId(client.phone)}`;
  try {
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(
      `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          loyaltyPoints: {
            label: 'Points',
            balance: { string: String(client.stamps) },
          },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      // Le client n'a peut-être pas encore installé sa carte -> normal, on ignore
      console.log('Mise à jour Wallet ignorée (carte pas encore installée ?):', errText);
    }
  } catch (e) {
    console.error('Erreur mise à jour Google Wallet:', e.message);
  }
}

// ---- Création automatique des tables au démarrage ----
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points_goal INTEGER NOT NULL DEFAULT 5,
      access_code TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Ajoute les colonnes si elles n'existaient pas encore sur une base déjà en place
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS access_code TEXT;`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS slug TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS shops_slug_idx ON shops(slug);`);

  // Génère un slug pour les commerces qui n'en ont pas encore (anciennes données)
  const shopsWithoutSlug = await pool.query('SELECT id, name FROM shops WHERE slug IS NULL');
  for (const shop of shopsWithoutSlug.rows) {
    const slug = await generateUniqueSlug(shop.name);
    await pool.query('UPDATE shops SET slug = $1 WHERE id = $2', [slug, shop.id]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      shop_id INTEGER REFERENCES shops(id),
      stamps INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(phone, shop_id)
    );
  `);

  // Génère un code d'accès pour les commerces qui n'en ont pas encore (anciennes données)
  const shopsWithoutCode = await pool.query('SELECT id FROM shops WHERE access_code IS NULL');
  for (const shop of shopsWithoutCode.rows) {
    await pool.query('UPDATE shops SET access_code = $1 WHERE id = $2', [generateShopCode(), shop.id]);
  }

}

// ---- Routes ----

// Vérifie que le serveur est en vie
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Fideli-Maroc backend en ligne' });
});

// Liste des commerces (le code d'accès n'est jamais renvoyé ici)
app.get('/shops', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, slug, points_goal, created_at FROM shops ORDER BY id');
  res.json(rows);
});

// Récupère un commerce par son "slug" (utilisé par la page client publique, ex: ?shop=patisserie-palais)
app.get('/shops/by-slug/:slug', async (req, res) => {
  const { slug } = req.params;
  const { rows } = await pool.query(
    'SELECT id, name, slug, points_goal FROM shops WHERE slug = $1',
    [slug]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Commerce introuvable' });
  res.json(rows[0]);
});

// Créer un nouveau commerce (protégé par mot de passe admin)
// Le code d'accès généré n'est renvoyé qu'une seule fois, à la création.
app.post('/shops', async (req, res) => {
  const adminKey = (req.headers['x-admin-key'] || '').trim();
  const expected = (process.env.ADMIN_SECRET || '').trim();
  if (!expected || adminKey !== expected) {
    return res.status(403).json({ error: 'Accès refusé : mot de passe administrateur incorrect' });
  }
  const { name, pointsGoal } = req.body;
  if (!name) return res.status(400).json({ error: 'Le nom du commerce est requis' });
  const accessCode = generateShopCode();
  const slug = await generateUniqueSlug(name);
  const { rows } = await pool.query(
    'INSERT INTO shops (name, points_goal, access_code, slug) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, pointsGoal || GOAL, accessCode, slug]
  );
  res.json(rows[0]); // inclut access_code et slug, à transmettre au commerçant concerné
});

// Vérifie le code d'accès d'un commerce (utilisé par le dashboard commerçant pour se déverrouiller)
app.post('/shops/:shopId/verify-code', async (req, res) => {
  const { shopId } = req.params;
  const { code } = req.body;
  const { rows } = await pool.query('SELECT access_code FROM shops WHERE id = $1', [shopId]);
  if (rows.length === 0) return res.status(404).json({ valid: false });
  const valid = rows[0].access_code === (code || '').trim();
  res.json({ valid });
});

// Un client scanne le QR code -> crée ou récupère sa carte
app.post('/clients', async (req, res) => {
  const { phone, shopId } = req.body;
  if (!phone || !shopId) return res.status(400).json({ error: 'phone et shopId requis' });

  const existing = await pool.query(
    'SELECT * FROM clients WHERE phone = $1 AND shop_id = $2',
    [phone, shopId]
  );
  if (existing.rows.length > 0) return res.json(existing.rows[0]);

  const { rows } = await pool.query(
    'INSERT INTO clients (phone, shop_id, name) VALUES ($1, $2, $3) RETURNING *',
    [phone, shopId, 'Client ' + phone.slice(-2)]
  );
  res.json(rows[0]);
});

// Vérifie le code d'accès d'un commerce dans l'en-tête de la requête
async function requireShopCode(req, res, shopId) {
  const code = (req.headers['x-shop-code'] || '').trim();
  const { rows } = await pool.query('SELECT access_code FROM shops WHERE id = $1', [shopId]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Commerce introuvable' });
    return false;
  }
  if (!code || rows[0].access_code !== code) {
    res.status(403).json({ error: 'Code d\'accès commerçant incorrect' });
    return false;
  }
  return true;
}

// Le commerçant crédite un point à un client (scan au comptoir)
app.post('/clients/:phone/stamp', async (req, res) => {
  const { phone } = req.params;
  const { shopId } = req.body;
  if (!shopId) return res.status(400).json({ error: 'shopId requis' });
  if (!(await requireShopCode(req, res, shopId))) return;

  const existing = await pool.query(
    'SELECT * FROM clients WHERE phone = $1 AND shop_id = $2',
    [phone, shopId]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Client introuvable. Il doit d\'abord scanner le QR code.' });
  }

  const { rows } = await pool.query(
    'UPDATE clients SET stamps = stamps + 1 WHERE phone = $1 AND shop_id = $2 RETURNING *',
    [phone, shopId]
  );
  pushWalletUpdate(rows[0]); // met à jour la carte Google Wallet en arrière-plan
  res.json(rows[0]);
});

// Liste des clients d'un commerce (pour le dashboard commerçant) — protégé par le code du commerce
app.get('/shops/:shopId/clients', async (req, res) => {
  const { shopId } = req.params;
  if (!(await requireShopCode(req, res, shopId))) return;
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE shop_id = $1 ORDER BY stamps DESC',
    [shopId]
  );
  res.json(rows);
});

// Génère le vrai lien "Ajouter à Google Wallet" pour un client
app.get('/clients/:phone/wallet-link', async (req, res) => {
  const { phone } = req.params;
  const { shopId } = req.query;
  if (!shopId) return res.status(400).json({ error: 'shopId requis' });

  const existing = await pool.query(
    'SELECT * FROM clients WHERE phone = $1 AND shop_id = $2',
    [phone, shopId]
  );
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: 'Client introuvable' });
  }

  try {
    const url = buildWalletSaveUrl(existing.rows[0]);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Serveur Fideli-Maroc lancé sur le port ${PORT}`));
  })
  .catch((err) => {
    console.error('Erreur d\'initialisation de la base de données:', err);
    process.exit(1);
  });
