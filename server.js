// Fideli-Maroc — Backend API
// Gère les commerces, les clients, et les points de fidélité.

const express = require('express');
const cors = require('cors');
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

// ---- Création automatique des tables au démarrage ----
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points_goal INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
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

  // Crée un commerce de démo si aucun n'existe encore
  const { rows } = await pool.query('SELECT id FROM shops LIMIT 1');
  if (rows.length === 0) {
    await pool.query(
      'INSERT INTO shops (name, points_goal) VALUES ($1, $2)',
      ["Animalerie L'empreinte", GOAL]
    );
    console.log('Commerce de démo "Animalerie L\'empreinte" créé.');
  }
}

// ---- Routes ----

// Vérifie que le serveur est en vie
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Fideli-Maroc backend en ligne' });
});

// Liste des commerces
app.get('/shops', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shops ORDER BY id');
  res.json(rows);
});

// Créer un nouveau commerce
app.post('/shops', async (req, res) => {
  const { name, pointsGoal } = req.body;
  if (!name) return res.status(400).json({ error: 'Le nom du commerce est requis' });
  const { rows } = await pool.query(
    'INSERT INTO shops (name, points_goal) VALUES ($1, $2) RETURNING *',
    [name, pointsGoal || GOAL]
  );
  res.json(rows[0]);
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

// Le commerçant crédite un point à un client (scan au comptoir)
app.post('/clients/:phone/stamp', async (req, res) => {
  const { phone } = req.params;
  const { shopId } = req.body;
  if (!shopId) return res.status(400).json({ error: 'shopId requis' });

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
  res.json(rows[0]);
});

// Liste des clients d'un commerce (pour le dashboard commerçant)
app.get('/shops/:shopId/clients', async (req, res) => {
  const { shopId } = req.params;
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE shop_id = $1 ORDER BY stamps DESC',
    [shopId]
  );
  res.json(rows);
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
