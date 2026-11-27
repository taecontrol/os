import { Clock, Data, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { SecureRandom, Signature } from "effect/crypto";
import { Jwk, Jwks, Jwt } from "effect/jose";
import {
  normalizeEmail,
  readConfig,
  type AccessIssuer,
  type Config,
  type OwnerEmail,
} from "./config.ts";
import { Unauthenticated, Unavailable } from "./refusal.ts";
import type { OwnerIdentity } from "./identity.ts";

const keySetTimeToLive = Duration.toMillis(Duration.minutes(10));
const refetchCooldown = Duration.toMillis(Duration.seconds(30));
const fetchTimeout = Duration.seconds(5);

interface CachedKeySet {
  readonly issuer: AccessIssuer;
  readonly keySet: Jwks.KeySet;
  readonly fetchedAt: number;
}

type AccessConfig = Config<"ACCESS_ISSUER" | "ACCESS_AUDIENCE">;

interface FetchAttempt {
  readonly at: number;
  readonly failed: boolean;
}

const AccessClaims = Schema.Struct({ email: Schema.String });

const decodeKeySet = Schema.decodeUnknownEffect(Jwks.KeySet);

const signatureCrypto = Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

type RsaJwk = Extract<Jwk.PublicJwk, { readonly kty: "RSA" }>;

const isPublicJwk = Schema.is(Jwk.PublicJwk);

const usableForRs256 = (key: Jwks.KeySet["keys"][number]): key is RsaJwk =>
  isPublicJwk(key) &&
  key.kty === "RSA" &&
  (key.alg === undefined || key.alg === "RS256") &&
  (key.use === undefined || key.use === "sig");

const downloadKeySet = (issuer: AccessIssuer) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
          redirect: "manual",
          signal,
          headers: { accept: "application/json" },
        });
        if (response.status !== 200) throw new Unavailable();
        return (await response.json()) as unknown;
      },
      catch: () => new Unavailable(),
    }).pipe(
      Effect.timeoutOrElse({
        duration: fetchTimeout,
        orElse: () => Effect.fail(new Unavailable()),
      }),
    );
    const decoded = yield* decodeKeySet(body).pipe(Effect.mapError(() => new Unavailable()));
    const keys = decoded.keys.filter(usableForRs256);
    if (keys.length === 0) return yield* new Unavailable();
    yield* Effect.forEach(keys, (key) => Jwk.importPublic(key, "RS256")).pipe(
      Effect.mapError(() => new Unavailable()),
    );
    return { keys } satisfies Jwks.KeySet;
  });

class UnknownKey extends Data.TaggedError("UnknownKey") {}

const verifyWith = (keySet: Jwks.KeySet, assertion: string, config: AccessConfig) =>
  Jwt.verifyWithKeySet(AccessClaims, assertion, {
    algorithms: ["RS256"],
    issuer: config.ACCESS_ISSUER,
    audience: config.ACCESS_AUDIENCE,
    requiredClaims: ["exp", "nbf"],
  }).pipe(
    Effect.provide(Jwks.layerLocal(keySet)),
    Effect.provide(signatureCrypto),
    Effect.mapError((error) =>
      error._tag === "JoseError" && error.reason._tag === "KeyNotFound"
        ? new UnknownKey()
        : new Unauthenticated(),
    ),
  );

export const makeAccessIdentity = (): OwnerIdentity<
  "OWNER_EMAIL" | "ACCESS_ISSUER" | "ACCESS_AUDIENCE"
> => {
  let cached: CachedKeySet | undefined;
  let lastAttempt: FetchAttempt | undefined;

  const successLandedSince = (previous: FetchAttempt | undefined) =>
    lastAttempt !== previous && lastAttempt?.failed === false;

  const refetch = (issuer: AccessIssuer) =>
    Effect.gen(function* () {
      const previous = lastAttempt;
      const at = yield* Clock.currentTimeMillis;
      const outcome = yield* Effect.exit(downloadKeySet(issuer));
      if (Exit.isSuccess(outcome)) {
        lastAttempt = { at, failed: false };
        cached = { issuer, keySet: outcome.value, fetchedAt: at };
      } else if (!successLandedSince(previous)) {
        lastAttempt = { at, failed: true };
      }
      return yield* outcome;
    });

  const verify = (assertion: string, config: AccessConfig) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (lastAttempt?.failed && now - lastAttempt.at < refetchCooldown) {
        return yield* new Unavailable();
      }
      const keySet =
        cached !== undefined &&
        cached.issuer === config.ACCESS_ISSUER &&
        now - cached.fetchedAt < keySetTimeToLive
          ? cached.keySet
          : yield* refetch(config.ACCESS_ISSUER);
      return yield* verifyWith(keySet, assertion, config).pipe(
        Effect.catchTag("UnknownKey", () =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            if (lastAttempt !== undefined && at - lastAttempt.at < refetchCooldown) {
              return yield* new Unauthenticated();
            }
            const rotated = yield* refetch(config.ACCESS_ISSUER);
            return yield* verifyWith(rotated, assertion, config).pipe(
              Effect.catchTag("UnknownKey", () => Effect.fail(new Unauthenticated())),
            );
          }),
        ),
      );
    });

  return {
    readConfig: (env) => readConfig(env, ["OWNER_EMAIL", "ACCESS_ISSUER", "ACCESS_AUDIENCE"]),
    authenticate: (headers, config) =>
      Effect.gen(function* () {
        const assertion = headers["cf-access-jwt-assertion"];
        if (assertion === undefined || assertion === "") return yield* new Unauthenticated();
        const verified = yield* verify(assertion, config);
        const email: Option.Option<OwnerEmail> = normalizeEmail(verified.claims.email);
        if (Option.isNone(email)) return yield* new Unauthenticated();
        return email.value;
      }),
  };
};
