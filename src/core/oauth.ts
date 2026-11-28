import {
  GrantType,
  OAuthAuthorizationServer,
  OAuthError,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { Clock, Effect, Result, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Bindings, Execution } from "./bindings.ts";
import {
  authenticateConnection,
  type Connection,
  ConnectionRequest,
  createConnection,
} from "./connections.ts";
import { Generation } from "./owner.ts";
import { BearerChallenge, InvalidClient, InvalidToken, respond, Unavailable } from "./refusal.ts";

interface AllowedClient {
  readonly name: string;
  readonly domain: string;
}

const allowlist = new Map<string, AllowedClient>([
  [
    "https://claude.ai/oauth/claude-code-client-metadata",
    { name: "Claude Code", domain: "claude.ai" },
  ],
  ["https://chatgpt.com/oauth/codex/client.json", { name: "Codex", domain: "chatgpt.com" }],
  ["https://claude.ai/oauth/mcp-oauth-client-metadata", { name: "Claude", domain: "claude.ai" }],
]);

export const allowedClient = (clientIds: ReadonlyArray<string>) => {
  const [clientId, ...others] = clientIds;
  return clientId === undefined || others.length > 0 ? undefined : allowlist.get(clientId);
};

export const protectedResourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";

const accessTokenSeconds = 3600;

const resourceOf = (origin: string) => `${origin}/mcp`;

const PendingGrant = Schema.Struct({ request: ConnectionRequest, generation: Generation });
const LiveGrant = Schema.Struct({ connectionId: Schema.String });
const decodePendingGrant = Schema.decodeUnknownEffect(PendingGrant);
const decodeLiveGrant = Schema.decodeUnknownEffect(LiveGrant);

export const pendingGrant = (
  request: ConnectionRequest,
  generation: Generation,
): typeof PendingGrant.Type => ({ request, generation });

const exchange = ({ grantType, props }: TokenExchangeCallbackOptions<Env>) =>
  Effect.gen(function* () {
    if (grantType === GrantType.AUTHORIZATION_CODE) {
      const { request, generation } = yield* decodePendingGrant(props).pipe(
        Effect.mapError(() => new InvalidToken()),
      );
      const connection = yield* createConnection(generation, request);
      const now = yield* Clock.currentTimeMillis;
      return {
        newProps: { connectionId: connection.id } satisfies typeof LiveGrant.Type,
        refreshTokenTTL: Math.floor((connection.expiresAt - now) / 1000),
      };
    }
    if (grantType === GrantType.REFRESH_TOKEN) {
      const { connectionId } = yield* decodeLiveGrant(props).pipe(
        Effect.mapError(() => new InvalidToken()),
      );
      yield* authenticateConnection(connectionId);
      return {};
    }
    return yield* new InvalidToken();
  });

const tokenExchangeCallback = async (options: TokenExchangeCallbackOptions<Env>) => {
  const outcome = await Effect.runPromise(
    Effect.result(exchange(options).pipe(Effect.provideService(Bindings, options.env))),
  );
  if (Result.isSuccess(outcome)) return outcome.success;
  throw outcome.failure._tag === "Unavailable"
    ? new OAuthError("temporarily_unavailable", {
        description: "OS could not check the connection. Try again.",
        statusCode: 503,
      })
    : new OAuthError("invalid_grant", {
        description: "This connection is no longer active. Authorize again.",
      });
};

const authorizationServer = (origin: string) =>
  new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resourceOf(origin)],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: accessTokenSeconds,
    tokenExchangeCallback,
  });

export const oauthHelpers = (origin: string, env: Env) =>
  authorizationServer(origin).getOAuthApi(env);

export const webRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => HttpServerRequest.toWeb(request)),
  Effect.orDie,
);

const serve = (request: Request) =>
  Effect.gen(function* () {
    const env = yield* Bindings;
    const execution = yield* Execution;
    const response = yield* Effect.tryPromise({
      try: () => authorizationServer(new URL(request.url).origin).fetch(request, env, execution),
      catch: () => new Unavailable(),
    });
    return HttpServerResponse.fromWeb(response);
  });

const screenTokenRequest = (request: Request) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (
      request.headers.has("authorization") ||
      contentType !== "application/x-www-form-urlencoded"
    ) {
      return yield* new InvalidClient();
    }
    const body = yield* Effect.tryPromise({
      try: () => request.clone().text(),
      catch: () => new InvalidClient(),
    });
    const form = new URLSearchParams(body);
    if (form.has("client_assertion") || allowedClient(form.getAll("client_id")) === undefined) {
      return yield* new InvalidClient();
    }
  });

export const tokenEndpoint = Effect.gen(function* () {
  const request = yield* webRequest;
  yield* screenTokenRequest(request);
  return yield* serve(request);
});

export const authorizationServerMetadata = webRequest.pipe(Effect.flatMap(serve));

export const protectedResourceMetadata = webRequest.pipe(
  Effect.map((request) => {
    const { origin } = new URL(request.url);
    return respond(200, {
      resource: resourceOf(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    });
  }),
);

const challenge = (origin: string, rejected: boolean) =>
  new BearerChallenge({
    header: [
      'Bearer realm="OAuth"',
      `resource_metadata="${origin}${protectedResourceMetadataPath}"`,
      ...(rejected ? ['error="invalid_token"'] : []),
    ].join(", "),
  });

export const authenticateBearer: Effect.Effect<
  Connection,
  BearerChallenge | Unavailable,
  Bindings | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* webRequest;
  const { origin } = new URL(request.url);
  const authorization = request.headers.get("authorization");
  if (authorization === null) return yield* challenge(origin, false);
  const rejected = challenge(origin, true);
  const token = /^Bearer +(\S+)$/iu.exec(authorization)?.[1];
  if (token === undefined) return yield* rejected;
  const env = yield* Bindings;
  const validated = yield* Effect.tryPromise({
    try: () => authorizationServer(origin).validateToken(resourceOf(origin), token, env),
    catch: () => new Unavailable(),
  });
  if (validated === null) return yield* rejected;
  const { connectionId } = yield* decodeLiveGrant(validated.props).pipe(
    Effect.mapError(() => rejected),
  );
  return yield* authenticateConnection(connectionId).pipe(
    Effect.catchTag("InvalidToken", () => Effect.fail(rejected)),
  );
});
