CREATE TABLE assets_next (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'finalizing', 'live', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'secret_link', 'public')),
  upload_count INTEGER NOT NULL DEFAULT 0
    CHECK (upload_count BETWEEN 0 AND 500),
  finalize_token TEXT,
  finalize_started_at TEXT,
  manifest_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO assets_next (id, state, visibility, created_at, updated_at)
  SELECT id, state, visibility, created_at, updated_at FROM assets;
DROP INDEX assets_live_created_at;
DROP TABLE assets;
ALTER TABLE assets_next RENAME TO assets;

CREATE INDEX assets_live_created_at
  ON assets (created_at DESC)
  WHERE state = 'live';
