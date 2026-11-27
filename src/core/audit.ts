import { Effect, Schema } from "effect";
import { decodeStored, query } from "./d1.ts";
import { AuditEntryNotFound } from "./refusal.ts";

export const AuditCursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Tuple([Schema.Int, Schema.String]))),
);
const encodeCursor = Schema.encodeSync(AuditCursor);

interface AuditPage {
  readonly connection?: string;
  readonly cursor?: typeof AuditCursor.Type;
  readonly limit: number;
}

const StoredEntry = Schema.Struct({
  id: Schema.String,
  occurred_at: Schema.Int,
  finished_at: Schema.NullOr(Schema.Int),
  connection_id: Schema.String,
  connection_name: Schema.String,
  capability: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["denied", "succeeded", "failed"])),
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
});

const decodeEntry = decodeStored(StoredEntry);
const decodeEntries = decodeStored(Schema.Array(StoredEntry));

const toEntry = (row: typeof StoredEntry.Type) => ({
  id: row.id,
  occurredAt: row.occurred_at,
  finishedAt: row.finished_at,
  connection: { id: row.connection_id, name: row.connection_name },
  capability: row.capability,
  outcome: row.outcome ?? "unfinished",
  reason: row.reason,
  annotation: { session: row.session, purpose: row.purpose },
});

const auditRows = `
SELECT a.id, a.occurred_at, a.finished_at, a.connection_id, c.name AS connection_name,
  a.capability, a.outcome, a.reason, a.session, a.purpose
FROM audit_entries a JOIN connections c ON c.id = a.connection_id`;

export const getAuditEntry = (db: D1Database, id: string) =>
  Effect.gen(function* () {
    const raw = yield* query(() => db.prepare(`${auditRows} WHERE a.id = ?`).bind(id).first());
    if (raw === null) return yield* new AuditEntryNotFound();
    return toEntry(yield* decodeEntry(raw));
  });

export const listAuditEntries = (db: D1Database, page: AuditPage) =>
  Effect.gen(function* () {
    const conditions: Array<string> = [];
    const parameters: Array<string | number> = [];
    if (page.connection !== undefined) {
      conditions.push("a.connection_id = ?");
      parameters.push(page.connection);
    }
    if (page.cursor !== undefined) {
      conditions.push("(a.occurred_at, a.id) < (?, ?)");
      parameters.push(...page.cursor);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = yield* query(() =>
      db
        .prepare(`${auditRows}${where} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`)
        .bind(...parameters, page.limit + 1)
        .all(),
    );
    const rows = yield* decodeEntries(result.results);
    const entries = rows.slice(0, page.limit).map(toEntry);
    const last = entries.at(-1);
    const nextCursor =
      last && rows.length > page.limit ? encodeCursor([last.occurredAt, last.id]) : null;
    return { entries, nextCursor };
  });
