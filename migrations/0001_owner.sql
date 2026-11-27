CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1),
  email TEXT CHECK (email IS NULL OR email = lower(trim(email)))
) STRICT;

INSERT INTO owner (id, generation, email) VALUES (1, 1, NULL);
