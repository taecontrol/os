import type { Effect, Result } from "effect";
import type { Headers } from "effect/http";
import type { Config, ConfigKey, OwnerEmail, SetupIncomplete } from "./config.ts";
import type { Unauthenticated, Unavailable } from "./refusal.ts";

export interface OwnerIdentity<K extends ConfigKey> {
  readonly readConfig: (env: object) => Result.Result<Config<K | "OWNER_EMAIL">, SetupIncomplete>;
  readonly authenticate: (
    headers: Headers.Headers,
    config: Config<K | "OWNER_EMAIL">,
  ) => Effect.Effect<OwnerEmail, Unauthenticated | Unavailable>;
}
