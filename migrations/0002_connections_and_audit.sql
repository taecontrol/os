CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  owner_generation INTEGER NOT NULL REFERENCES owner (generation) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE grants (
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'ask', 'deny')),
  PRIMARY KEY (connection_id, capability)
) STRICT;

CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  owner_generation INTEGER NOT NULL REFERENCES owner (generation) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  capability TEXT,
  outcome TEXT CHECK (outcome IN ('denied', 'succeeded', 'failed')),
  reason TEXT,
  session TEXT,
  purpose TEXT,
  occurred_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE INDEX audit_by_time ON audit_entries (occurred_at DESC, id DESC);
CREATE INDEX audit_by_connection ON audit_entries (connection_id, occurred_at DESC);
