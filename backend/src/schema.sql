-- Applied on every open (see db.ts). Everything is CREATE ... IF NOT EXISTS, so opening an
-- existing database is a no-op. Bumping SCHEMA_VERSION and adding an ALTER block below is the
-- whole migration story.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id               TEXT PRIMARY KEY,            -- 'anon:' + 22-char base64url random, or 'google:' + sub
  nickname         TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('anonymous','google')),
  created_at       TEXT NOT NULL,               -- ISO-8601 UTC
  last_seen_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT PRIMARY KEY,            -- sha256(token); the raw token is never stored
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS plays (
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  date             TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  puzzle_number    INTEGER NOT NULL,            -- #N at the time of play; never recomputed
  answer_json      TEXT NOT NULL,               -- CompanyLite of the answer, snapshot at start (served only once solved)
  started_at       TEXT NOT NULL,
  solved_at        TEXT,                        -- NULL while playing
  guess_count      INTEGER NOT NULL DEFAULT 0,
  elapsed_ms       INTEGER,                     -- solved_at - started_at, denormalised for leaderboards
  PRIMARY KEY (player_id, date)
);
CREATE INDEX IF NOT EXISTS plays_date_solved ON plays(date, solved_at);

CREATE TABLE IF NOT EXISTS guesses (
  player_id        TEXT NOT NULL,
  date             TEXT NOT NULL,
  seq              INTEGER NOT NULL,            -- 1-based, per play
  company_id       TEXT NOT NULL,               -- guessed company id
  guess_json       TEXT NOT NULL,               -- CompanyLite of the guess, snapshot at guess time
  correct          INTEGER NOT NULL,            -- 0/1
  cells_json       TEXT NOT NULL,               -- CellFeedback[] as computed at the time
  created_at       TEXT NOT NULL,
  PRIMARY KEY (player_id, date, seq),
  UNIQUE (player_id, date, company_id),         -- enforces "one guess per company per play"
  FOREIGN KEY (player_id, date) REFERENCES plays(player_id, date) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
