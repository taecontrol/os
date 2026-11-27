import { Data, Option, Result, Schema } from "effect";

export const OwnerEmail = Schema.String.check(
  Schema.isPattern(
    /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u,
  ),
).pipe(Schema.brand("OwnerEmail"));
export type OwnerEmail = typeof OwnerEmail.Type;

const decodeOwnerEmail = Schema.decodeUnknownOption(OwnerEmail);

export const normalizeEmail = (raw: unknown): Option.Option<OwnerEmail> =>
  typeof raw === "string" ? decodeOwnerEmail(raw.trim().toLowerCase()) : Option.none();

export const AccessIssuer = Schema.String.check(
  Schema.isPattern(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u),
).pipe(Schema.brand("AccessIssuer"));
export type AccessIssuer = typeof AccessIssuer.Type;

export const AccessAudience = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/iu)).pipe(
  Schema.brand("AccessAudience"),
);
export type AccessAudience = typeof AccessAudience.Type;

const parsers = {
  OWNER_EMAIL: normalizeEmail,
  ACCESS_ISSUER: Schema.decodeUnknownOption(AccessIssuer),
  ACCESS_AUDIENCE: Schema.decodeUnknownOption(AccessAudience),
};

export type ConfigKey = keyof typeof parsers;

export type Config<K extends ConfigKey> = {
  readonly [P in K]: Option.Option.Value<ReturnType<(typeof parsers)[P]>>;
};

export class SetupIncomplete extends Data.TaggedError("SetupIncomplete")<{
  readonly missing: ReadonlyArray<ConfigKey>;
}> {}

export const readConfig = <K extends ConfigKey>(
  env: object,
  keys: ReadonlyArray<K>,
): Result.Result<Config<K>, SetupIncomplete> => {
  const raw: Partial<Record<string, unknown>> = env;
  const config: Partial<Record<ConfigKey, unknown>> = {};
  const missing: Array<ConfigKey> = [];
  for (const key of keys) {
    const parsed: Option.Option<unknown> = parsers[key](raw[key]);
    if (Option.isSome(parsed)) config[key] = parsed.value;
    else missing.push(key);
  }
  return missing.length > 0
    ? Result.fail(new SetupIncomplete({ missing }))
    : Result.succeed(config as Config<K>);
};
