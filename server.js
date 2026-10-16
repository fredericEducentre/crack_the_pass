'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('./db');

// ---------------------------------------------------------------- config ---
const PORT = Number(process.env.PORT) || 3000;
// Character sets a secret can be drawn from.
const DIGITS = '0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'; // lowercase + uppercase
// Every printable ASCII character a keyboard can type (letters, digits and symbols,
// from '!' to '~'). Excludes the space (invisible in the UI) and emojis.
const ANY = (() => {
  let s = '';
  for (let code = 0x21; code <= 0x7e; code++) s += String.fromCharCode(code);
  return s;
})();

// Levels come in categories. A category fixes the character set; its levels make the secret
// longer one step at a time. Categories are independent: each one starts unlocked, and a level
// unlocks when the previous level OF THE SAME CATEGORY is cracked.
const CATEGORIES = [
  { id: 'chiffres', charset: DIGITS, lengths: [1, 2, 3, 4] },
  { id: 'lettres', charset: LETTERS, lengths: [1, 2, 3, 4] },
  { id: 'caracteres', charset: ANY, lengths: [1, 2, 3, 4, 8] },
];
// Level ids are numbered 1, 2, 3... across all categories (the API uses these ids).
// `prev` is the level that must be cracked first (null = open from the start).
const LEVEL_DEFS = {};
let nextId = 1;
for (const cat of CATEGORIES) {
  let prev = null;
  for (const length of cat.lengths) {
    LEVEL_DEFS[nextId] = { category: cat.id, length, charset: cat.charset, prev };
    prev = nextId++;
  }
}
const LEVELS = Object.keys(LEVEL_DEFS).map(Number); // [1, 2, ..., 13]
// Safety valve against someone hammering the server (guesses per second, per student).
const GUESS_RATE_PER_SEC = Number(process.env.GUESS_RATE_PER_SEC) || 1000;
const COOKIE_NAME = 'ctp_token';
const COOKIE_MAX_AGE = 7 * 24 * 3600 * 1000;

// Signing key for session cookies: env var, or generated once and kept in data/.
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, 'jwt.secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const JWT_SECRET = loadJwtSecret();

// ------------------------------------------------------------ statements ---
const q = {
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),

  active: db.prepare("SELECT * FROM attempts WHERE user_id = ? AND level = ? AND status = 'active'"),
  activeAll: db.prepare(
    "SELECT level, started_at, guesses FROM attempts WHERE user_id = ? AND status = 'active'"
  ),
  insertAttempt: db.prepare(
    'INSERT INTO attempts (user_id, level, secret, started_at) VALUES (?, ?, ?, ?)'
  ),
  bumpGuess: db.prepare('UPDATE attempts SET guesses = guesses + 1 WHERE id = ?'),
  finish: db.prepare(
    "UPDATE attempts SET status = 'done', finished_at = ?, duration_ms = ? WHERE id = ?"
  ),
  abandon: db.prepare("UPDATE attempts SET status = 'abandoned' WHERE id = ?"),
  hasDone: db.prepare(
    "SELECT 1 FROM attempts WHERE user_id = ? AND level = ? AND status = 'done' LIMIT 1"
  ),
};

// Each student's best run per level: fastest time, earliest finish breaks ties.
const BEST_CTE = `
  WITH best AS (
    SELECT user_id, level, duration_ms, finished_at, guesses,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, level ORDER BY duration_ms ASC, finished_at ASC
           ) AS rn
    FROM attempts
    WHERE status = 'done'
  )`;

const boardStmt = db.prepare(`${BEST_CTE}
  SELECT u.id AS user_id, u.username, b.duration_ms, b.finished_at, b.guesses
  FROM best b JOIN users u ON u.id = b.user_id
  WHERE b.rn = 1 AND b.level = ?
  ORDER BY b.duration_ms ASC, b.finished_at ASC
  LIMIT ?`);

const overallStmt = db.prepare(`${BEST_CTE}
  SELECT u.id AS user_id, u.username,
         COUNT(*)           AS levels_done,
         SUM(b.duration_ms) AS total_ms,
         MAX(b.finished_at) AS last_finished
  FROM best b JOIN users u ON u.id = b.user_id
  WHERE b.rn = 1
  GROUP BY u.id
  ORDER BY levels_done DESC, total_ms ASC, last_finished ASC
  LIMIT ?`);

// Number of attempts (runs) ever started on each level, by every student. One row of `attempts`
// = one attempt, whether it is still running, abandoned or cracked. (Not the number of guesses.)
const attemptCountStmt = db.prepare('SELECT level, COUNT(*) AS total FROM attempts GROUP BY level');

const myBestStmt = db.prepare(`${BEST_CTE}
  SELECT level, duration_ms, finished_at, guesses
  FROM best WHERE user_id = ? AND rn = 1`);

// --------------------------------------------------------------- helpers ---
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
// Hash compared against when the username is unknown, so timing doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function randomSecret(level) {
  const { length, charset } = LEVEL_DEFS[level];
  let s = '';
  for (let i = 0; i < length; i++) s += charset[crypto.randomInt(charset.length)];
  return s;
}

// Returns the level number (0 is valid!) or null. Always compare the result with `=== null`.
function parseLevel(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return LEVELS.includes(n) ? n : null;
}

function setSession(res, userId) {
  const token = jwt.sign({}, JWT_SECRET, {
    subject: String(userId),
    expiresIn: '7d',
    algorithm: 'HS256',
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: COOKIE_MAX_AGE,
  });
}

// The signed-in student for this request, or null.
function userFromRequest(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return q.userById.get(Number(payload.sub)) || null;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) {
    if (req.cookies[COOKIE_NAME]) res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Veuillez vous connecter.' });
  }
  req.user = user;
  next();
}

function rankOf(rows, userId) {
  const i = rows.findIndex((r) => r.user_id === userId);
  return i === -1 ? null : i + 1;
}

// ------------------------------------------------------------------- app ---
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.disable('x-powered-by');
// Classroom setups often serve plain http on a LAN, so don't force https upgrades.
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } },
  })
);
app.use(express.json({ limit: '2kb' }));
app.use(cookieParser());

// State-changing API calls must be JSON: a cross-site <form> can't send that.
app.use('/api', (req, res, next) => {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (req.method !== 'GET' && !type.startsWith('application/json')) {
    return res.status(415).json({ error: 'Le Content-Type doit être application/json.' });
  }
  next();
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTER_RATE_MAX) || 300, // a whole class may share one IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop d\'inscriptions depuis ce réseau. Réessayez plus tard.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10, // failed attempts per username
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'login:' + String(req.body?.username || '').toLowerCase().slice(0, 40),
  message: { error: 'Trop de connexions échouées pour ce compte. Réessayez dans 15 minutes.' },
});
const guessLimiter = rateLimit({
  windowMs: 1000,
  limit: GUESS_RATE_PER_SEC,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => 'guess:' + req.user.id,
  message: { error: 'Ralentissez : trop d\'essais par seconde.' },
});

// ------------------------------------------------------------------ auth ---
app.post('/api/register', registerLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Le nom d\'utilisateur doit faire 3 à 20 caractères : lettres, chiffres, point, tiret ou tiret bas.',
    });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Votre mot de passe doit faire au moins 8 caractères.' });
  }
  if (Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Votre mot de passe est trop long (72 octets max).' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = q.insertUser.run(username, hash, Date.now());
    setSession(res, lastInsertRowid);
    res.status(201).json({ user: { id: Number(lastInsertRowid), username } });
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err.message))) {
      return res.status(409).json({ error: 'Ce nom d\'utilisateur est déjà pris.' });
    }
    throw err;
  }
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const row = typeof username === 'string' ? q.userByName.get(username) : undefined;
  const ok = bcrypt.compareSync(typeof password === 'string' ? password : '', row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe invalide.' });
  setSession(res, row.id);
  res.json({ user: { id: row.id, username: row.username } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// -------------------------------------------------------------- progress ---
// Public on purpose: the page asks "am I signed in?" when it loads.
app.get('/api/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ user: null });

  const best = new Map(myBestStmt.all(user.id).map((r) => [r.level, r]));
  const active = new Map(q.activeAll.all(user.id).map((r) => [r.level, r]));
  const attemptTotals = new Map(attemptCountStmt.all().map((r) => [r.level, Number(r.total)]));

  const progress = LEVELS.map((level) => {
    const b = best.get(level);
    const a = active.get(level);
    const { category, length, charset, prev } = LEVEL_DEFS[level];
    return {
      level,
      category,
      prev,
      length,
      charset,
      possibilities: charset.length ** length,
      totalAttempts: attemptTotals.get(level) || 0,
      unlocked: prev === null || best.has(prev),
      best: b ? { durationMs: b.duration_ms, finishedAt: b.finished_at, guesses: b.guesses } : null,
      active: a ? { startedAt: a.started_at, guesses: a.guesses } : null,
    };
  });

  res.json({
    user,
    config: { levels: LEVELS },
    progress,
    serverNow: Date.now(),
  });
});

// ----------------------------------------------------------------- game ----
app.post('/api/levels/:level/start', auth, (req, res) => {
  const level = parseLevel(req.params.level);
  if (level === null) return res.status(404).json({ error: 'Niveau inconnu.' });
  const { prev } = LEVEL_DEFS[level];
  if (prev !== null && !q.hasDone.get(req.user.id, prev)) {
    return res.status(403).json({ error: `Cassez d'abord le niveau ${prev}.` });
  }

  let attempt = q.active.get(req.user.id, level);
  if (!attempt) {
    const startedAt = Date.now();
    q.insertAttempt.run(req.user.id, level, randomSecret(level), startedAt);
    attempt = { level, started_at: startedAt, guesses: 0 };
  }
  res.json({
    level,
    length: LEVEL_DEFS[level].length,
    startedAt: attempt.started_at,
    guesses: attempt.guesses,
    serverNow: Date.now(),
  });
});

app.post('/api/levels/:level/guess', auth, guessLimiter, (req, res) => {
  const level = parseLevel(req.params.level);
  if (level === null) return res.status(404).json({ error: 'Niveau inconnu.' });
  const { length, charset } = LEVEL_DEFS[level];

  const guess = req.body?.guess;
  if (typeof guess !== 'string' || [...guess].length !== length || [...guess].some((c) => !charset.includes(c))) {
    return res
      .status(400)
      .json({ error: `Un essai fait exactement ${length} caractère${length > 1 ? 's' : ''} parmi : ${charset}` });
  }

  const attempt = q.active.get(req.user.id, level);
  if (!attempt) return res.status(409).json({ error: 'Démarrez d\'abord le niveau.' });

  q.bumpGuess.run(attempt.id);
  const guesses = attempt.guesses + 1;

  if (guess !== attempt.secret) return res.json({ correct: false, guesses });

  const finishedAt = Date.now();
  const durationMs = finishedAt - attempt.started_at;
  q.finish.run(finishedAt, durationMs, attempt.id);

  const board = boardStmt.all(level, 1000);
  res.json({
    correct: true,
    secret: attempt.secret,
    guesses,
    durationMs,
    finishedAt,
    rank: rankOf(board, req.user.id),
    players: board.length,
    possibilities: charset.length ** length,
    nextLevelUnlocked: LEVELS.some((l) => LEVEL_DEFS[l].prev === level),
  });
});

app.post('/api/levels/:level/giveup', auth, (req, res) => {
  const level = parseLevel(req.params.level);
  if (level === null) return res.status(404).json({ error: 'Niveau inconnu.' });
  const attempt = q.active.get(req.user.id, level);
  if (!attempt) return res.status(409).json({ error: 'Aucun niveau en cours.' });
  q.abandon.run(attempt.id);
  res.json({ secret: attempt.secret, guesses: attempt.guesses });
});

// ----------------------------------------------------------- leaderboard ---
app.get('/api/leaderboard/:which', auth, (req, res) => {
  const { which } = req.params;
  const me = req.user.id;

  if (which === 'overall') {
    const rows = overallStmt.all(100).map((r, i) => ({
      rank: i + 1,
      username: r.username,
      levelsDone: r.levels_done,
      totalMs: r.total_ms,
      lastFinished: r.last_finished,
      isMe: r.user_id === me,
    }));
    return res.json({ which, totalLevels: LEVELS.length, rows });
  }

  const level = parseLevel(which);
  if (level === null) return res.status(404).json({ error: 'Classement inconnu.' });
  const rows = boardStmt.all(level, 100).map((r, i) => ({
    rank: i + 1,
    username: r.username,
    durationMs: r.duration_ms,
    finishedAt: r.finished_at,
    guesses: r.guesses,
    isMe: r.user_id === me,
  }));
  res.json({ which, level, rows });
});

// ------------------------------------------------------------- static/err --
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  console.error(err);
  res.status(500).json({ error: 'Une erreur est survenue sur le serveur.' });
});

app.listen(PORT, () => {
  console.log(`Crack the Pass is running on http://localhost:${PORT}`);
});
