CREATE TABLE IF NOT EXISTS listings (
  id            TEXT PRIMARY KEY,           -- upstream UUID (Simplify) or content hash (sndsh404)
  source        TEXT NOT NULL,              -- 'simplify-newgrad' | 'simplify-summer2026' | 'sndsh-summer2027'
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  locations     TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  terms         TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  sponsorship   TEXT,
  category      TEXT,
  date_posted   INTEGER NOT NULL DEFAULT 0, -- unix seconds
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'candidate', 'dismissed', 'queued', 'applied')),
  first_seen_at INTEGER NOT NULL,           -- unix seconds, when scan first inserted it
  last_seen_at  INTEGER NOT NULL            -- unix seconds, when scan last saw it upstream
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_source ON listings (source);
