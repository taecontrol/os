import { Cause, Data, Effect, Exit, Option, Schema } from "effect";
import { capabilityCatalog, type Capability } from "./capabilities.ts";
import type { Connection } from "./connections.ts";
import { decodeStored, query } from "./d1.ts";
import { truncateCharacters } from "./text.ts";

const DenialReason = Schema.Literals([
  "connection_revoked",
  "connection_expired",
  "not_granted",
  "denied_by_grant",
  "approval_unavailable",
]);

export class Denied extends Data.TaggedError("Denied")<{
  readonly reason: typeof DenialReason.Type;
}> {}

const decodeDecision = decodeStored(
  Schema.Union([
    Schema.Struct({ id: Schema.String, outcome: Schema.Null, reason: Schema.Null }),
    Schema.Struct({ id: Schema.String, outcome: Schema.Literal("denied"), reason: DenialReason }),
  ]),
);

const decodeVisible = decodeStored(Schema.Array(Schema.Struct({ capability: Schema.String })));

interface Annotation {
  readonly session?: string | null;
  readonly purpose?: string | null;
}

const normalizeAnnotation = (text: string | null | undefined) =>
  truncateCharacters((text ?? "").replace(/\p{Cc}/gu, "").trim(), 200) || null;

const failureReason = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasDies(cause)) return "defect";
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) return "defect";
  const error = failure.value;
  if (typeof error !== "object" || error === null || !("_tag" in error)) return "defect";
  const tag = error._tag;
  return typeof tag === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(tag) ? tag : "defect";
};

const databaseTime = "CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)";

export const makeGate = (db: D1Database) => ({
  visibleCapabilities: (connection: Connection) =>
    Effect.gen(function* () {
      const visible = yield* query(() =>
        db
          .prepare(`SELECT g.capability FROM grants g JOIN connections c ON c.id = g.connection_id
            WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ${databaseTime}
              AND g.mode IN ('allow', 'ask')`)
          .bind(connection.id)
          .all(),
      );
      const rows = yield* decodeVisible(visible.results);
      const ids = new Set(rows.map((row) => row.capability));
      return capabilityCatalog.filter((capability) => ids.has(capability.id));
    }),

  run: <A, E, R>(
    connection: Connection,
    capability: Capability,
    annotation: Annotation,
    effect: (context: { readonly auditEntryId: string }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const raw = yield* query(() =>
        db
          .prepare(`WITH attempt AS (SELECT ${databaseTime} AS occurred_at), decision AS (
            SELECT c.owner_generation, c.id AS connection_id, attempt.occurred_at,
              CASE
                WHEN c.revoked_at IS NOT NULL THEN 'connection_revoked'
                WHEN c.expires_at <= attempt.occurred_at THEN 'connection_expired'
                WHEN g.mode = 'allow' THEN NULL
                WHEN g.mode = 'deny' THEN 'denied_by_grant'
                WHEN g.mode = 'ask' THEN 'approval_unavailable'
                ELSE 'not_granted'
              END AS reason
            FROM connections c CROSS JOIN attempt
            LEFT JOIN grants g ON g.connection_id = c.id AND g.capability = ?2
            WHERE c.id = ?1
          )
          INSERT INTO audit_entries (id, owner_generation, connection_id, capability, outcome, reason,
            session, purpose, occurred_at, finished_at)
          SELECT ?3, owner_generation, connection_id, ?2,
            CASE WHEN reason IS NOT NULL THEN 'denied' END, reason, ?4, ?5, occurred_at,
            CASE WHEN reason IS NOT NULL THEN occurred_at END
          FROM decision
          RETURNING id, outcome, reason`)
          .bind(
            connection.id,
            capability.id,
            crypto.randomUUID(),
            normalizeAnnotation(annotation.session),
            normalizeAnnotation(annotation.purpose),
          )
          .first(),
      );
      const decision = yield* decodeDecision(raw);
      if (decision.outcome === "denied") return yield* new Denied({ reason: decision.reason });

      return yield* Effect.suspend(() => effect({ auditEntryId: decision.id })).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            const reason = Exit.isFailure(exit) ? failureReason(exit.cause) : null;
            const outcome = Exit.isSuccess(exit) ? "succeeded" : "failed";
            yield* query(() =>
              db
                .prepare(
                  `UPDATE audit_entries SET outcome = ?, reason = ?, finished_at = ${databaseTime} WHERE id = ?`,
                )
                .bind(outcome, reason, decision.id)
                .run(),
            ).pipe(Effect.ignore);
          }),
        ),
      );
    }),
});
