import { Clock, Effect, Schema } from "effect";
import { issueBearer } from "./bearer.ts";
import { type Capability, GrantMode } from "./capabilities.ts";
import { decodeStored, query } from "./d1.ts";
import type { Generation } from "./owner.ts";
import { ConnectionNotFound, ConnectionRevoked, Unavailable } from "./refusal.ts";

const StoredConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  expires_at: Schema.Int,
  revoked_at: Schema.NullOr(Schema.Int),
  last_used_at: Schema.NullOr(Schema.Int),
  grants: Schema.fromJsonString(
    Schema.Array(Schema.Struct({ capability: Schema.String, mode: GrantMode })),
  ),
});

const decodeConnection = decodeStored(StoredConnection);
const decodeConnections = decodeStored(Schema.Array(StoredConnection));

export const connectionStatus = (
  connection: { readonly revoked_at: number | null; readonly expires_at: number },
  now: number,
) => {
  if (connection.revoked_at !== null) return "revoked";
  return connection.expires_at <= now ? "expired" : "active";
};

const toConnection = (row: typeof StoredConnection.Type, now: number) => ({
  id: row.id,
  name: row.name,
  status: connectionStatus(row, now),
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
  grants: row.grants,
});

const connectionRows = `
SELECT c.id, c.name, c.expires_at, c.revoked_at,
  (SELECT MAX(a.occurred_at) FROM audit_entries a WHERE a.connection_id = c.id) AS last_used_at,
  (SELECT json_group_array(json_object('capability', g.capability, 'mode', g.mode) ORDER BY g.capability)
    FROM grants g WHERE g.connection_id = c.id) AS grants
FROM connections c`;

const connectionById = (db: D1Database, id: string) =>
  db.prepare(`${connectionRows} WHERE c.id = ?`).bind(id);

const requireConnection = (raw: unknown) =>
  raw == null ? Effect.fail(new ConnectionNotFound()) : decodeConnection(raw);

export const listConnections = (db: D1Database) =>
  Effect.gen(function* () {
    const result = yield* query(() =>
      db.prepare(`${connectionRows} ORDER BY c.created_at DESC, c.rowid DESC`).all(),
    );
    const rows = yield* decodeConnections(result.results);
    const now = yield* Clock.currentTimeMillis;
    return rows.map((row) => toConnection(row, now));
  });

export const getConnection = (db: D1Database, id: string) =>
  Effect.gen(function* () {
    const raw = yield* query(() => connectionById(db, id).first());
    const row = yield* requireConnection(raw);
    const now = yield* Clock.currentTimeMillis;
    return toConnection(row, now);
  });

const changeConnection = (db: D1Database, id: string, change: () => D1PreparedStatement) =>
  Effect.gen(function* () {
    const [, read] = yield* query(() => db.batch([change(), connectionById(db, id)]));
    if (read === undefined) return yield* new Unavailable();
    const row = yield* requireConnection(read.results[0]);
    const now = yield* Clock.currentTimeMillis;
    return toConnection(row, now);
  });

const requireUnrevoked = <A extends { readonly revokedAt: number | null }>(connection: A) =>
  connection.revokedAt === null ? Effect.succeed(connection) : Effect.fail(new ConnectionRevoked());

const expiresAfter = (now: number, days: number) => now + days * 86_400_000;

export const createConnection = (
  db: D1Database,
  generation: Generation,
  name: string,
  days: number,
) =>
  Effect.gen(function* () {
    const { token, hash } = yield* issueBearer;
    const id = crypto.randomUUID();
    const now = yield* Clock.currentTimeMillis;
    const connection = yield* changeConnection(db, id, () =>
      db
        .prepare(`INSERT INTO connections (id, owner_generation, name, token_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, generation, name, hash, now, expiresAfter(now, days)),
    );
    return { connection, token };
  });

export const rotateConnection = (db: D1Database, id: string, days: number) =>
  Effect.gen(function* () {
    const { token, hash } = yield* issueBearer;
    const now = yield* Clock.currentTimeMillis;
    const connection = yield* changeConnection(db, id, () =>
      db
        .prepare(`UPDATE connections SET token_hash = ?, expires_at = ?
          WHERE id = ? AND revoked_at IS NULL RETURNING id`)
        .bind(hash, expiresAfter(now, days), id),
    ).pipe(Effect.flatMap(requireUnrevoked));
    return { connection, token };
  });

export const revokeConnection = (db: D1Database, id: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* changeConnection(db, id, () =>
      db
        .prepare("UPDATE connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, id),
    );
  });

export const changeGrant = (
  db: D1Database,
  id: string,
  capability: Capability,
  mode: GrantMode | null,
) =>
  changeConnection(db, id, () =>
    mode === null
      ? db
          .prepare(`DELETE FROM grants WHERE connection_id = ?1 AND capability = ?2
            AND EXISTS (SELECT 1 FROM connections WHERE id = ?1 AND revoked_at IS NULL)`)
          .bind(id, capability.id)
      : db
          .prepare(`INSERT INTO grants (connection_id, capability, mode)
            SELECT id, ?2, ?3 FROM connections WHERE id = ?1 AND revoked_at IS NULL
            ON CONFLICT (connection_id, capability) DO UPDATE SET mode = excluded.mode
            WHERE grants.mode <> excluded.mode`)
          .bind(id, capability.id, mode),
  ).pipe(Effect.flatMap(requireUnrevoked));
