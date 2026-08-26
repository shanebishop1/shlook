CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'live', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'secret_link', 'public')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX assets_live_created_at
  ON assets (created_at DESC)
  WHERE state = 'live';
