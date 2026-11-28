import { Brand, Clock, Effect, Result, Schema } from "effect";
import { Bindings } from "./bindings.ts";
import { type Capability, findCapability, type GrantMode, Grants } from "./capabilities.ts";
import { decodeStored, query } from "./d1.ts";
import { Generation } from "./owner.ts";
import {
  CapabilityNotFound,
  ConnectionNotFound,
  ConnectionRevoked,
  InvalidRequest,
  InvalidToken,
  Unavailable,
} from "./refusal.ts";
import { truncateCharacters } from "./text.ts";

const ExpiryDays = Schema.Literals([7, 30, 90]);

const decodeRequest = Schema.decodeUnknownResult(
  Schema.Struct({
    name: Schema.Trim.check(
      Schema.makeFilter((name) => name.length > 0 && truncateCharacters(name, 64) === name),
    ),
    expiresInDays: Schema.optionalKey(ExpiryDays),
    grants: Schema.optionalKey(Grants),
  }),
);

export interface ConnectionRequest {
  readonly id: string;
  readonly name: string;
  readonly expiresInDays: typeof ExpiryDays.Type;
  readonly grants: typeof Grants.Type;
}

export const parseConnectionRequest = (
  input: unknown,
): Result.Result<ConnectionRequest, InvalidRequest | CapabilityNotFound> => {
  const parsed = decodeRequest(input);
  if (Result.isFailure(parsed)) return Result.fail(new InvalidRequest());
  const { name, expiresInDays = 90, grants = [] } = parsed.success;
  const ids = new Set(grants.map((grant) => grant.capability));
  if (ids.size !== grants.length) return Result.fail(new InvalidRequest());
  if (grants.some((grant) => findCapability(grant.capability) === undefined)) {
    return Result.fail(new CapabilityNotFound());
  }
  return Result.succeed({ id: crypto.randomUUID(), name, expiresInDays, grants });
};

export type Connection = {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: number;
} & Brand.Brand<"Connection">;

const connection = Brand.nominal<Connection>();

const connectionFields = {
  id: Schema.String,
  name: Schema.String,
  expires_at: Schema.Int,
  revoked_at: Schema.NullOr(Schema.Int),
};

const decodeIdentity = decodeStored(
  Schema.Struct({ ...connectionFields, owner_generation: Generation }),
);

const StoredConnection = Schema.Struct({
  ...connectionFields,
  last_used_at: Schema.NullOr(Schema.Int),
  grants: Schema.fromJsonString(Grants),
});

const decodeConnection = decodeStored(StoredConnection);
const decodeConnections = decodeStored(Schema.Array(StoredConnection));

const connectionStatus = (
  connection: { readonly revoked_at: number | null; readonly expires_at: number },
  now: number,
): "revoked" | "expired" | "active" => {
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

const identityColumns = "id, name, owner_generation, expires_at, revoked_at";

export const createConnection = (generation: Generation, request: ConnectionRequest) =>
  Effect.gen(function* () {
    const { id, name, expiresInDays, grants } = request;
    if (grants.some((grant) => findCapability(grant.capability) === undefined)) {
      return yield* new CapabilityNotFound();
    }
    const { DB } = yield* Bindings;
    const createdAt = yield* Clock.currentTimeMillis;
    const [, , read] = yield* query(() =>
      DB.batch([
        DB.prepare(`INSERT INTO connections (id, owner_generation, name, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).bind(
          id,
          generation,
          name,
          createdAt,
          createdAt + expiresInDays * 86_400_000,
        ),
        DB.prepare(`INSERT INTO grants (connection_id, capability, mode)
          SELECT ?1, json_extract(value, '$.capability'), json_extract(value, '$.mode')
          FROM json_each(?2) WHERE changes() = 1`).bind(id, JSON.stringify(grants)),
        DB.prepare(
          `SELECT ${identityColumns} FROM connections WHERE id = ? AND owner_generation = ?`,
        ).bind(id, generation),
      ]),
    );
    const row = yield* decodeIdentity(read?.results[0]);
    const now = yield* Clock.currentTimeMillis;
    if (connectionStatus(row, now) !== "active") return yield* new InvalidToken();
    return connection({ id: row.id, name: row.name, expiresAt: row.expires_at });
  });

export const authenticateConnection = (id: string) =>
  Effect.gen(function* () {
    const { DB } = yield* Bindings;
    const raw = yield* query(() =>
      DB.prepare(`SELECT ${identityColumns} FROM connections WHERE id = ?`).bind(id).first(),
    );
    if (raw === null) return yield* new InvalidToken();
    const row = yield* decodeIdentity(raw);
    const now = yield* Clock.currentTimeMillis;
    const status = connectionStatus(row, now);
    if (status === "active") {
      return connection({ id: row.id, name: row.name, expiresAt: row.expires_at });
    }
    yield* query(() =>
      DB.prepare(`INSERT INTO audit_entries (id, owner_generation, connection_id, outcome, reason, occurred_at, finished_at)
        VALUES (?1, ?2, ?3, 'denied', ?4, ?5, ?5)`)
        .bind(crypto.randomUUID(), row.owner_generation, row.id, `connection_${status}`, now)
        .run(),
    ).pipe(Effect.ignore);
    return yield* new InvalidToken();
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
