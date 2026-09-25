-- My Stash — D1 schema (plan §4)
-- Apply with: npx wrangler d1 execute my-stash-cards --remote --file=./schema.sql
-- (add --local instead of --remote when developing against the local simulator)

CREATE TABLE IF NOT EXISTS generated_cards (
  id            TEXT    PRIMARY KEY,          -- uuid v4
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,             -- markdown-lite
  source        TEXT    NOT NULL DEFAULT '',
  tags          TEXT    NOT NULL DEFAULT '[]',-- JSON string array
  category      TEXT    NOT NULL,             -- top-level category
  subcategory   TEXT    NOT NULL DEFAULT '',
  topic_slug    TEXT    NOT NULL,             -- kebab-case normalized topic id
  title_hash    TEXT    NOT NULL,             -- sha256 prefix for dedup
  batch_date    TEXT    NOT NULL,             -- YYYY-MM-DD
  created_at    TEXT    NOT NULL,             -- ISO datetime
  word_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (title_hash)
);

CREATE INDEX IF NOT EXISTS idx_batch_date  ON generated_cards(batch_date);
CREATE INDEX IF NOT EXISTS idx_category    ON generated_cards(category);
CREATE INDEX IF NOT EXISTS idx_created_at  ON generated_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title_hash  ON generated_cards(title_hash);

CREATE TABLE IF NOT EXISTS generation_log (
  id              TEXT    PRIMARY KEY,        -- uuid v4
  batch_date      TEXT    NOT NULL,           -- YYYY-MM-DD
  requested       INTEGER NOT NULL,
  generated       INTEGER NOT NULL,
  duplicates_skip INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  model           TEXT    NOT NULL,
  status          TEXT    NOT NULL,           -- 'success' | 'partial' | 'failed'
  error           TEXT,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_date ON generation_log(batch_date);

-- Concurrent-run lock: at most one in-flight ('running') row per batch date.
-- The pipeline inserts this row with INSERT OR IGNORE at start and UPDATES it
-- to the final status at completion; changes = 0 means another run holds the
-- lock (D1 is strongly consistent — KV is not).
CREATE UNIQUE INDEX IF NOT EXISTS idx_log_running_per_day
  ON generation_log(batch_date) WHERE status = 'running';
