import { Context, Effect, Option, Schema } from "effect";
import { normalizeEmail, type OwnerEmail } from "./config.ts";
import { OwnerLocked, Unavailable } from "./refusal.ts";

const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("OwnerGeneration"),
);
export type Generation = typeof Generation.Type;

export class Owner extends Context.Service<
  Owner,
  { readonly email: OwnerEmail; readonly generation: Generation }
>()("os/core/Owner") {}

export class OwnerGeneration extends Context.Service<OwnerGeneration, Generation>()(
  "os/core/OwnerGeneration",
) {}

const StoredOwner = Schema.Struct({
  generation: Generation,
  email: Schema.NullOr(Schema.String),
});

interface OwnerRow {
  readonly generation: Generation;
  readonly pinned: Option.Option<OwnerEmail>;
}

const query = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new Unavailable() });

const decodeStoredOwner = Schema.decodeUnknownEffect(StoredOwner);

export const readOwner = (db: D1Database) =>
  Effect.gen(function* () {
    const raw = yield* query(() =>
      db.prepare("SELECT generation, email FROM owner WHERE id = 1").first(),
    );
    const row = yield* decodeStoredOwner(raw).pipe(Effect.mapError(() => new Unavailable()));
    if (row.email === null) return { generation: row.generation, pinned: Option.none() };
    const pinned = normalizeEmail(row.email);
    if (Option.isNone(pinned) || pinned.value !== row.email) return yield* new Unavailable();
    return { generation: row.generation, pinned } satisfies OwnerRow;
  });

export const requireUnlocked = (row: OwnerRow, configured: OwnerEmail) =>
  Option.isSome(row.pinned) && row.pinned.value !== configured
    ? Effect.fail(new OwnerLocked())
    : Effect.void;

export const pinOwner = (db: D1Database, row: OwnerRow, email: OwnerEmail) =>
  Effect.gen(function* () {
    if (Option.isSome(row.pinned)) return { email, generation: row.generation };
    const pinned = yield* query(() =>
      db
        .prepare(
          "UPDATE owner SET email = ?1 WHERE id = 1 AND generation = ?2 AND (email IS NULL OR email = ?1) RETURNING generation",
        )
        .bind(email, row.generation)
        .first(),
    );
    if (pinned === null) return yield* new Unavailable();
    return { email, generation: row.generation };
  });
