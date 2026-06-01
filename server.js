const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'db');
const DB_PATH = path.join(DATA_DIR, 'mitch.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mitch123';

let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    yes_votes INTEGER DEFAULT 0,
    no_votes INTEGER DEFAULT 0,
    outcome TEXT DEFAULT NULL,
    archived INTEGER DEFAULT 0
  )`);

  saveDb();
  ensureTodayPoll();
}

function saveDb() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function ensureTodayPoll() {
  const today = todayDate();
  db.run(`INSERT OR IGNORE INTO polls (date) VALUES (?)`, [today]);
  saveDb();
}

function getTodayPoll() {
  ensureTodayPoll();
  const stmt = db.prepare(`SELECT * FROM polls WHERE date = ?`);
  stmt.bind([todayDate()]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getLastArchivedPoll() {
  const stmt = db.prepare(`SELECT * FROM polls WHERE archived = 1 ORDER BY date DESC LIMIT 1`);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function getHistory() {
  const stmt = db.prepare(`SELECT * FROM polls WHERE archived = 1 ORDER BY date DESC LIMIT 30`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// GET /api/poll — today's vote counts + yesterday's result
app.get('/api/poll', (req, res) => {
  const today = getTodayPoll();
  const yesterday = getLastArchivedPoll();
  res.json({ today, yesterday });
});

// POST /api/vote
app.post('/api/vote', (req, res) => {
  const { choice } = req.body;
  if (choice !== 'yes' && choice !== 'no') return res.status(400).json({ error: 'Invalid choice' });
  const today = todayDate();
  const col = choice === 'yes' ? 'yes_votes' : 'no_votes';
  db.run(`UPDATE polls SET ${col} = ${col} + 1 WHERE date = ?`, [today]);
  saveDb();
  const poll = getTodayPoll();
  res.json({ success: true, today: poll });
});

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ error: 'Wrong password' });
});

// GET /api/admin/data (password in header)
app.get('/api/admin/data', requireAdmin, (req, res) => {
  const today = getTodayPoll();
  const history = getHistory();
  res.json({ today, history });
});

// POST /api/admin/archive — record outcome and archive today
app.post('/api/admin/archive', requireAdmin, (req, res) => {
  const { outcome } = req.body;
  if (outcome !== 'yes' && outcome !== 'no') return res.status(400).json({ error: 'Invalid outcome' });
  const today = todayDate();
  db.run(`UPDATE polls SET outcome = ?, archived = 1 WHERE date = ?`, [outcome, today]);
  saveDb();
  ensureTodayPoll();
  res.json({ success: true });
});

// POST /api/admin/reset — wipe today's votes
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const today = todayDate();
  db.run(`UPDATE polls SET yes_votes = 0, no_votes = 0 WHERE date = ?`, [today]);
  saveDb();
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Catch-all: serve index.html
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`MitchWatch running on port ${PORT}`));
});
