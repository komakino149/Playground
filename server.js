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
const TZ = 'America/New_York';

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
    poll_date TEXT NOT NULL UNIQUE,
    yes_votes INTEGER DEFAULT 0,
    no_votes INTEGER DEFAULT 0,
    outcome TEXT DEFAULT NULL,
    archived INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS vote_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_date TEXT NOT NULL,
    ip TEXT NOT NULL,
    choice TEXT NOT NULL,
    voted_at TEXT NOT NULL
  )`);

  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getPollInfo() {
  const now = new Date();
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  const etHour = etDate.getHours();
  const etMinute = etDate.getMinutes();
  const etTotalMinutes = etHour * 60 + etMinute;

  const year = etDate.getFullYear();
  const month = String(etDate.getMonth() + 1).padStart(2, '0');
  const day = String(etDate.getDate()).padStart(2, '0');
  const todayET = `${year}-${month}-${day}`;

  const tomorrowDate = new Date(etDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowET = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth()+1).padStart(2,'0')}-${String(tomorrowDate.getDate()).padStart(2,'0')}`;

  const yesterdayDate = new Date(etDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayET = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth()+1).padStart(2,'0')}-${String(yesterdayDate.getDate()).padStart(2,'0')}`;

  let votingOpen = false;
  let pollDate = null;
  let deadWindow = false;

  if (etTotalMinutes >= 720) {
    // 12pm to midnight: voting open, predicting tomorrow
    votingOpen = true;
    pollDate = tomorrowET;
  } else if (etTotalMinutes < 180) {
    // midnight to 3am: voting open, predicting today
    votingOpen = true;
    pollDate = todayET;
  } else {
    // 3am to noon: dead window
    votingOpen = false;
    deadWindow = true;
    pollDate = null;
  }

// Next noon ET — construct the target time string and let Date parse it as ET
  let nextNoonDate = new Date(etDate);
  if (etTotalMinutes >= 720) {
    nextNoonDate.setDate(nextNoonDate.getDate() + 1);
  }
  const ny = nextNoonDate.getFullYear();
  const nm = String(nextNoonDate.getMonth() + 1).padStart(2, '0');
  const nd = String(nextNoonDate.getDate()).padStart(2, '0');
  // Build an ET noon string and convert to UTC via Intl
  const noonETStr = `${ny}-${nm}-${nd}T12:00:00`;
  const noonUTCMs = new Date(new Date(noonETStr).toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
    + (new Date(noonETStr + ' ET').getTimezoneOffset ? 0 : 0);
  // Reliable method: use a fixed offset aware approach
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });
  const nowUTC = now.getTime();
  const etOffsetMs = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() - new Date(now.toLocaleString('en-US', { timeZone: TZ })).getTime();
  const nextNoonUTC = new Date(`${ny}-${nm}-${nd}T12:00:00`).getTime() + etOffsetMs;
  const nextNoonUTCStr = new Date(nextNoonUTC).toISOString();

function ensurePoll(pollDate) {
  if (!pollDate) return;
  db.run(`INSERT OR IGNORE INTO polls (poll_date) VALUES (?)`, [pollDate]);
  saveDb();
}

function getPoll(pollDate) {
  if (!pollDate) return null;
  const stmt = db.prepare(`SELECT * FROM polls WHERE poll_date = ?`);
  stmt.bind([pollDate]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function getLastArchivedPoll() {
  const stmt = db.prepare(`SELECT * FROM polls WHERE archived = 1 ORDER BY poll_date DESC LIMIT 1`);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function getHistory() {
  const stmt = db.prepare(`SELECT * FROM polls ORDER BY poll_date DESC LIMIT 60`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

app.get('/api/poll', (req, res) => {
  const info = getPollInfo();
  if (info.votingOpen) ensurePoll(info.pollDate);
  // During dead window, fetch today's poll to show closing results
  const fetchDate = info.pollDate || info.todayET;
  const current = getPoll(fetchDate);
  const lastArchived = getLastArchivedPoll();
  res.json({
    votingOpen: info.votingOpen,
    deadWindow: info.deadWindow,
    pollDate: info.pollDate,
    todayET: info.todayET,
    nextNoonUTC: info.nextNoonUTC,
    current,
    lastArchived
  });
});

app.post('/api/vote', (req, res) => {
  const info = getPollInfo();
  if (!info.votingOpen) return res.status(403).json({ error: 'Voting is closed' });
  const { choice } = req.body;
  if (choice !== 'yes' && choice !== 'no') return res.status(400).json({ error: 'Invalid choice' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const pollDate = info.pollDate;
  ensurePoll(pollDate);
  const checkStmt = db.prepare(`SELECT id FROM vote_log WHERE poll_date = ? AND ip = ?`);
  checkStmt.bind([pollDate, ip]);
  const alreadyVoted = checkStmt.step();
  checkStmt.free();
  if (alreadyVoted) return res.status(409).json({ error: 'Already voted', alreadyVoted: true });
  const col = choice === 'yes' ? 'yes_votes' : 'no_votes';
  db.run(`UPDATE polls SET ${col} = ${col} + 1 WHERE poll_date = ?`, [pollDate]);
  db.run(`INSERT INTO vote_log (poll_date, ip, choice, voted_at) VALUES (?, ?, ?, ?)`, [pollDate, ip, choice, new Date().toISOString()]);
  saveDb();
  res.json({ success: true, current: getPoll(pollDate) });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ error: 'Wrong password' });
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/data', requireAdmin, (req, res) => {
  const info = getPollInfo();
  const history = getHistory();
  const fetchDate = info.pollDate || info.todayET;
  const current = getPoll(fetchDate);
  res.json({ current, history, pollInfo: info });
});

app.get('/api/admin/votes/:pollDate', requireAdmin, (req, res) => {
  const stmt = db.prepare(`SELECT * FROM vote_log WHERE poll_date = ? ORDER BY voted_at ASC`);
  stmt.bind([req.params.pollDate]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ votes: rows });
});

app.post('/api/admin/archive', requireAdmin, (req, res) => {
  const { outcome, pollDate } = req.body;
  if (outcome !== 'yes' && outcome !== 'no') return res.status(400).json({ error: 'Invalid outcome' });
  const info = getPollInfo();
  const date = pollDate || info.pollDate || info.todayET;
  if (!date) return res.status(400).json({ error: 'No active poll' });
  ensurePoll(date);
  db.run(`UPDATE polls SET outcome = ?, archived = 1 WHERE poll_date = ?`, [outcome, date]);
  saveDb();
  res.json({ success: true });
});

app.put('/api/admin/history/:pollDate', requireAdmin, (req, res) => {
  const { pollDate } = req.params;
  const { yes_votes, no_votes, outcome, archived } = req.body;
  ensurePoll(pollDate);
  db.run(`UPDATE polls SET yes_votes = ?, no_votes = ?, outcome = ?, archived = ? WHERE poll_date = ?`,
    [yes_votes ?? 0, no_votes ?? 0, outcome || null, archived ?? 1, pollDate]);
  saveDb();
  res.json({ success: true });
});

app.delete('/api/admin/history/:pollDate', requireAdmin, (req, res) => {
  db.run(`DELETE FROM polls WHERE poll_date = ?`, [req.params.pollDate]);
  db.run(`DELETE FROM vote_log WHERE poll_date = ?`, [req.params.pollDate]);
  saveDb();
  res.json({ success: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const info = getPollInfo();
  const date = info.pollDate || info.todayET;
  if (!date) return res.status(400).json({ error: 'No active poll' });
  db.run(`UPDATE polls SET yes_votes = 0, no_votes = 0 WHERE poll_date = ?`, [date]);
  db.run(`DELETE FROM vote_log WHERE poll_date = ?`, [date]);
  saveDb();
  res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initDb().then(() => app.listen(PORT, () => console.log(`MitchWatch running on port ${PORT}`)));
