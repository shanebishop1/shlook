ALTER TABLE assets ADD COLUMN name TEXT NOT NULL DEFAULT 'Untitled artifact'
  CHECK (length(name) BETWEEN 1 AND 80);
ALTER TABLE assets ADD COLUMN description TEXT
  CHECK (description IS NULL OR length(description) <= 500);

UPDATE assets SET name = substr(id, 1, 8);
