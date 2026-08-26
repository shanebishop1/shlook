ALTER TABLE assets ADD COLUMN secret_hash TEXT
  CHECK (secret_hash IS NULL OR length(secret_hash) = 64);
ALTER TABLE assets ADD COLUMN share_expires_at TEXT;
ALTER TABLE assets ADD COLUMN hard_expires_at TEXT;
ALTER TABLE assets ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_pending IN (0, 1));
ALTER TABLE assets ADD COLUMN cleanup_checked_at TEXT;

UPDATE assets SET cleanup_pending = 1 WHERE state = 'deleted';

CREATE INDEX assets_live_hard_expiry
  ON assets (hard_expires_at)
  WHERE state = 'live' AND hard_expires_at IS NOT NULL;

CREATE INDEX assets_cleanup_queue
  ON assets (cleanup_checked_at)
  WHERE cleanup_pending = 1;
