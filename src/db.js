const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('coordinador', 'entrenador')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS competitions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL CHECK (source IN ('fecapa', 'rfep', 'manual')),
  source_id    TEXT NOT NULL,          -- id del grup a sidgad (content_fase_X)
  master_id    TEXT,                   -- competició mestra que el conté
  name         TEXT NOT NULL,
  season       TEXT,
  follow       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  source_id      TEXT,                 -- id d'equip a sidgad (team_X)
  name           TEXT NOT NULL,
  short_name     TEXT,
  own            INTEGER NOT NULL DEFAULT 0,
  rotation       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (competition_id, source_id)
);

CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  family     TEXT,
  porter     INTEGER NOT NULL DEFAULT 0,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  player_id  TEXT UNIQUE,              -- id_player de sidgad / jok.cat
  auto       INTEGER NOT NULL DEFAULT 0, -- creada a partir de les actes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS person_teams (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('juga', 'entrena', 'ajuda', 'cap')),
  PRIMARY KEY (person_id, team_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  source_key     TEXT UNIQUE,          -- fecapa:154502 · rfep:31483 · null si és manual
  jornada        INTEGER,
  home_team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  away_team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  home_name      TEXT NOT NULL,
  away_name      TEXT NOT NULL,
  date           TEXT,                 -- YYYY-MM-DD
  time           TEXT,                 -- HH:MM
  played         INTEGER NOT NULL DEFAULT 0,
  score          TEXT,
  origin         TEXT NOT NULL DEFAULT 'font' CHECK (origin IN ('font', 'manual')),
  status         TEXT NOT NULL DEFAULT 'actiu' CHECK (status IN ('actiu', 'eliminat')),
  acta_loaded    INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches (date);
CREATE INDEX IF NOT EXISTS idx_matches_home ON matches (home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away ON matches (away_team_id);

CREATE TABLE IF NOT EXISTS appearances (
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('juga', 'entrena', 'ajuda')),
  PRIMARY KEY (match_id, person_id)
);

CREATE TABLE IF NOT EXISTS match_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('canvi', 'nou', 'eliminat')),
  before      TEXT,
  after       TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN ('porter', 'reforç')),
  UNIQUE (match_id, person_id, type)
);

CREATE TABLE IF NOT EXISTS pista_blocks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,
  time_from TEXT NOT NULL,
  time_to   TEXT NOT NULL,
  reason    TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  new_date    TEXT NOT NULL,
  new_time    TEXT NOT NULL,
  origin      TEXT,
  contact     TEXT,
  status      TEXT NOT NULL DEFAULT 'pendent' CHECK (status IN ('pendent', 'acceptada', 'rebutjada', 'oficial')),
  impact      TEXT,                    -- JSON: { blocks, warns, conflicts: [...] }
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('match', 'person', 'team', 'proposal')),
  entity_id   INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok          INTEGER,
  matches     INTEGER DEFAULT 0,
  changes     INTEGER DEFAULT 0,
  new_blocks  INTEGER DEFAULT 0,
  errors      TEXT
);

CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file) {
  const target = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'calendar.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Paràmetres de configuració (JSON per clau) amb valors per defecte. */
function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setSetting(db, key, value) {
  if (value === undefined || value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

module.exports = { openDb, getSetting, setSetting };
