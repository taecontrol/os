import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { Clock, Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpServerResponse } from "effect/http";
import { Bindings } from "./bindings.ts";
import { defaultExpiryDays, parseConnectionRequest } from "./connections.ts";
import { decodeStored, query } from "./d1.ts";
import { allowedClient, oauthHelpers, pendingGrant, webRequest } from "./oauth.ts";
import type { ConsentDecision } from "./owner-contract.ts";
import { Owner } from "./owner.ts";
import { ConsentNotFound, type InvalidRequest, noStore, Unavailable } from "./refusal.ts";

const consentSeconds = 600;

const StoredConsent = Schema.Struct({
  authRequest: Schema.Struct({
    responseType: Schema.String,
    clientId: Schema.String,
    redirectUri: Schema.String,
    scope: Schema.mutable(Schema.Array(Schema.String)),
    state: Schema.String,
    codeChallenge: Schema.optionalKey(Schema.String),
    codeChallengeMethod: Schema.optionalKey(Schema.String),
    resource: Schema.optionalKey(Schema.String),
    issuer: Schema.optionalKey(Schema.String),
  }),
  expiresAt: Schema.Int,
});

const decodeConsent = decodeStored(StoredConsent);

const consentKey = (id: string) => `consent:${id}`;

const kv = <A>(run: (store: KVNamespace) => Promise<A>) =>
  Bindings.pipe(Effect.flatMap(({ OAUTH_KV }) => query(() => run(OAUTH_KV))));

type RefusalReason = "client_not_allowed" | "invalid_request" | "unavailable";

const redirect = (location: string) =>
  noStore(HttpServerResponse.redirect(location, { status: 302 }));

export const authorize = Effect.gen(function* () {
  const request = yield* webRequest;
  const { origin, searchParams } = new URL(request.url);
  if (allowedClient(searchParams.getAll("client_id")) === undefined) {
    return yield* Effect.fail<RefusalReason>("client_not_allowed");
  }
  const env = yield* Bindings;
  const authRequest = yield* Effect.tryPromise({
    try: () => oauthHelpers(origin, env).parseAuthRequest(request),
    catch: (error): RefusalReason =>
      error instanceof AuthorizationError ? "invalid_request" : "unavailable",
  });
  const id = Hex.encode(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = (yield* Clock.currentTimeMillis) + consentSeconds * 1000;
  yield* kv((store) =>
    store.put(consentKey(id), JSON.stringify({ authRequest, expiresAt }), {
      expirationTtl: consentSeconds,
    }),
  ).pipe(Effect.mapError((): RefusalReason => "unavailable"));
  return redirect(`/consent/${id}`);
}).pipe(Effect.catch((reason) => Effect.succeed(redirect(`/consent/refused?reason=${reason}`))));

const readConsent = (id: string) =>
  Effect.gen(function* () {
    const raw = yield* kv((store) => store.get(consentKey(id), "json"));
    if (raw === null) return yield* new ConsentNotFound();
    const consent = yield* decodeConsent(raw);
    const client = allowedClient([consent.authRequest.clientId]);
    const now = yield* Clock.currentTimeMillis;
    if (client === undefined || consent.expiresAt <= now) return yield* new ConsentNotFound();
    return { ...consent, client };
  });

const isLoopback = (host: string) =>
  host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);

export const describeConsent = (id: string) =>
  readConsent(id).pipe(
    Effect.map(({ authRequest, expiresAt, client }) => {
      const { hostname } = new URL(authRequest.redirectUri);
      return {
        client,
        redirect: { host: hostname, loopback: isLoopback(hostname) },
        expiresInDays: defaultExpiryDays,
        expiresAt,
      };
    }),
  );

export const decideConsent = (
  id: string,
  body: Effect.Effect<typeof ConsentDecision.Type, InvalidRequest>,
) =>
  Effect.gen(function* () {
    const { authRequest } = yield* readConsent(id);
    const decision = yield* body;
    if (decision.decision === "deny") {
      yield* kv((store) => store.delete(consentKey(id)));
      return { redirectUrl: authorizationErrorRedirect(authRequest, "access_denied") };
    }
    const request = yield* Effect.fromResult(
      parseConnectionRequest({ name: decision.name, grants: decision.grants ?? [] }),
    );
    const { generation } = yield* Owner;
    yield* kv((store) => store.delete(consentKey(id)));
    const { origin } = new URL((yield* webRequest).url);
    const env = yield* Bindings;
    const { redirectTo } = yield* Effect.tryPromise({
      try: () =>
        oauthHelpers(origin, env).completeAuthorization({
          request: authRequest,
          userId: request.id,
          scope: authRequest.scope,
          metadata: {},
          props: pendingGrant(request, generation),
        }),
      catch: () => new Unavailable(),
    });
    return { redirectUrl: redirectTo };
  });
