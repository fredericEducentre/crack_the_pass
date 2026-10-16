'use strict';

const fs = require('fs');
const path = require('path');
// Built into Node 22.13+: no native module to compile, nothing extra to install.
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'crackthepass.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

-- One row per try at a level. The secret lives only on the server.
CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL,
  secret      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  guesses     INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'done', 'abandoned')),
  finished_at INTEGER,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_attempts_user_level ON attempts (user_id, level, status);
CREATE INDEX IF NOT EXISTS idx_attempts_board      ON attempts (level, status, duration_ms, finished_at);
-- A student can only have one running attempt per level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active
  ON attempts (user_id, level) WHERE status = 'active';
`);

module.exports = { db, DATA_DIR };
