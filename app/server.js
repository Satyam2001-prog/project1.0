const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Simple bootstrap — fine for a learning project, not how you'd do it in prod
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      item TEXT NOT NULL,
      qty INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Liveness: "is the process alive at all" — no DB check here on purpose
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Readiness: "can this pod actually serve traffic right now"
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ service: 'orders-api', pod: process.env.HOSTNAME });
});

app.get('/orders', async (req, res) => {
  const result = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 50');
  res.json(result.rows);
});

app.post('/orders', async (req, res) => {
  const { item, qty } = req.body;
  if (!item || !qty) return res.status(400).json({ error: 'item and qty required' });
  const result = await pool.query(
    'INSERT INTO orders (item, qty) VALUES ($1, $2) RETURNING *',
    [item, qty]
  );
  res.status(201).json(result.rows[0]);
});

// Deliberately CPU-hungry endpoint so we have something to load test
// and watch the HPA react to. n controls how much work it does.
app.get('/stress', (req, res) => {
  const iterations = Number(req.query.n) || 5_000_000;
  let x = 0;
  for (let i = 0; i < iterations; i++) {
    x += Math.sqrt(i);
  }
  res.json({ result: x, pod: process.env.HOSTNAME });
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(port, () => console.log(`orders-api listening on ${port}`)))
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });
