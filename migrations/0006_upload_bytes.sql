ALTER TABLE assets ADD COLUMN upload_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (upload_bytes >= 0);
