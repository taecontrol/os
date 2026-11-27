import { Brand, Cause, Clock, Context, Data, Effect, Exit, Option, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { hashBearer, readBearer } from "./bearer.ts";
import { capabilityCatalog, type Capability } from "./capabilities.ts";
import { connectionStatus } from "./connections.ts";
import { decodeStored, query } from "./d1.ts";
import { Generation } from "./owner.ts";
import { InvalidToken } from "./refusal.ts";
import { truncateCharacters } from "./text.ts";

export type AuthenticatedConnection = {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: number;
} & Brand.Brand<"AuthenticatedConnection">;

const authenticated = Brand.nominal<AuthenticatedConnection>();

export class Connection extends Context.Service<Connection, AuthenticatedConnection>()(
  "os/core/Connection",
) {}

const decodeCredential = decodeStored(
  Schema.Struct({
    id: Schema.String,
    owner_generation: Generation,
    name: Schema.String,
    expires_at: Schema.Int,
    revoked_at: Schema.NullOr(Schema.Int),
  }),
);

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

export const makeGate = (db: D1Database) => ({
  authenticate: (request: Request | HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const header =
        request instanceof Request
          ? request.headers.get("authorization")
          : request.headers.authorization;
      const token = readBearer(header);
      if (token === undefined) return yield* new InvalidToken();
      const hash = yield* hashBearer(token);
      const raw = yield* query(() =>
        db
          .prepare(
            "SELECT id, owner_generation, name, expires_at, revoked_at FROM connections WHERE token_hash = ?",
          )
          .bind(hash)
          .first(),
      );
      if (raw === null) return yield* new InvalidToken();
      const row = yield* decodeCredential(raw);
      const now = yield* Clock.currentTimeMillis;
      const status = connectionStatus(row, now);
      if (status !== "active") {
        yield* query(() =>
          db
            .prepare(`INSERT INTO audit_entries (id, owner_generation, connection_id, outcome, reason, occurred_at, finished_at)
              VALUES (?1, ?2, ?3, 'denied', ?4, ?5, ?5)`)
            .bind(crypto.randomUUID(), row.owner_generation, row.id, `connection_${status}`, now)
            .run(),
        ).pipe(Effect.ignore);
        return yield* new InvalidToken();
      }
      return authenticated({ id: row.id, name: row.name, expiresAt: row.expires_at });
    }),

  visibleCapabilities: (connection: AuthenticatedConnection) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const visible = yield* query(() =>
        db
          .prepare(`SELECT g.capability FROM grants g JOIN connections c ON c.id = g.connection_id
            WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND g.mode IN ('allow', 'ask')`)
          .bind(connection.id, now)
          .all(),
      );
      const rows = yield* decodeVisible(visible.results);
      const ids = new Set(rows.map((row) => row.capability));
      return capabilityCatalog.filter((capability) => ids.has(capability.id));
    }),

  run: <A, E, R>(
    connection: AuthenticatedConnection,
    capability: Capability,
    annotation: Annotation,
    effect: (context: { readonly auditEntryId: string }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const raw = yield* query(() =>
        db
          .prepare(`WITH decision AS (
            SELECT c.owner_generation, c.id AS connection_id,
              CASE
                WHEN c.revoked_at IS NOT NULL THEN 'connection_revoked'
                WHEN c.expires_at <= ?3 THEN 'connection_expired'
                WHEN g.mode = 'allow' THEN NULL
                WHEN g.mode = 'deny' THEN 'denied_by_grant'
                WHEN g.mode = 'ask' THEN 'approval_unavailable'
                ELSE 'not_granted'
              END AS reason
            FROM connections c LEFT JOIN grants g ON g.connection_id = c.id AND g.capability = ?2
            WHERE c.id = ?1
          )
          INSERT INTO audit_entries (id, owner_generation, connection_id, capability, outcome, reason,
            session, purpose, occurred_at, finished_at)
          SELECT ?4, owner_generation, connection_id, ?2,
            CASE WHEN reason IS NOT NULL THEN 'denied' END, reason, ?5, ?6, ?3,
            CASE WHEN reason IS NOT NULL THEN ?3 END
          FROM decision
          RETURNING id, outcome, reason`)
          .bind(
            connection.id,
            capability.id,
            now,
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
            const finishedAt = yield* Clock.currentTimeMillis;
            const reason = Exit.isFailure(exit) ? failureReason(exit.cause) : null;
            const outcome = Exit.isSuccess(exit) ? "succeeded" : "failed";
            yield* query(() =>
              db
                .prepare(
                  "UPDATE audit_entries SET outcome = ?, reason = ?, finished_at = ? WHERE id = ?",
                )
                .bind(outcome, reason, finishedAt, decision.id)
                .run(),
            ).pipe(Effect.ignore);
          }),
        ),
      );
    }),
});
