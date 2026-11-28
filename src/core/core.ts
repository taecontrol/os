import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import { Bindings, Execution } from "./bindings.ts";
import type { ConfigKey } from "./config.ts";
import { AuthenticatedConnection } from "./connections.ts";
import { authorize } from "./consent.ts";
import type { OwnerIdentity } from "./identity.ts";
import {
  authenticateBearer,
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  tokenEndpoint,
} from "./oauth.ts";
import { ownerApiRoutes } from "./owner-api.ts";
import { OwnerApiAccess } from "./owner-contract.ts";
import { Owner, OwnerGeneration, pinOwner, readOwner, requireUnlocked } from "./owner.ts";
import {
  AccessAssertionRejected,
  AgentCredentialRejected,
  InvalidRequest,
  noStore,
  notFound,
  NotOwner,
  refuse,
  respond,
  type Refusal,
} from "./refusal.ts";

const unservedMachinePaths = ["/oauth/token/*", "/.well-known/*", "/agent/*"] as const;

const bareWildcardBases = ["/api", "/.well-known", "/agent"] as const;

const guarded =
  <A>(gate: Effect.Effect<A, Refusal, Bindings | HttpServerRequest.HttpServerRequest>) =>
  <S, R>(
    service: Context.Key<S, A>,
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Refusal, R>,
  ) =>
    gate.pipe(
      Effect.flatMap((value) => Effect.provideService(handler, service, value)),
      Effect.catch((refusal) => Effect.succeed(refuse(refusal))),
    );

const machineGate = <K extends ConfigKey>(identity: OwnerIdentity<K>) =>
  Effect.gen(function* () {
    const env = yield* Bindings;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* Effect.fromResult(identity.readConfig(env));
    if (request.headers["cf-access-jwt-assertion"] !== undefined) {
      return yield* new AccessAssertionRejected();
    }
    const row = yield* readOwner(env.DB);
    yield* requireUnlocked(row, config.OWNER_EMAIL);
    return row.generation;
  });

export const asMachine = <K extends ConfigKey>(identity: OwnerIdentity<K>) => {
  const gate = machineGate(identity);
  return <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Refusal, R>) =>
    guarded(gate)(OwnerGeneration, handler);
};

export const asConnection = <K extends ConfigKey>(identity: OwnerIdentity<K>) => {
  const gate = machineGate(identity).pipe(Effect.andThen(authenticateBearer));
  return <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Refusal, R>) =>
    guarded(gate)(AuthenticatedConnection, handler);
};

export const makeCore = <K extends ConfigKey>(identity: OwnerIdentity<K>) => {
  const ownerGate = Effect.gen(function* () {
    const env = yield* Bindings;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* Effect.fromResult(identity.readConfig(env));
    if (request.headers.authorization !== undefined) return yield* new AgentCredentialRejected();
    const email = yield* identity.authenticate(request.headers, config);
    if (email !== config.OWNER_EMAIL) return yield* new NotOwner();
    const row = yield* readOwner(env.DB);
    yield* requireUnlocked(row, config.OWNER_EMAIL);
    return yield* pinOwner(env.DB, row, email);
  });

  const asOwner = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Refusal, R>) =>
    guarded(ownerGate)(Owner, handler);
  const asAgent = asMachine(identity);
  const asAgentConnection = asConnection(identity);
  const ownerAccess = Layer.succeed(OwnerApiAccess)((httpEffect) =>
    asOwner(
      httpEffect.pipe(
        Effect.catch((error) =>
          HttpApiError.HttpApiSchemaError.is(error) &&
          error.kind !== "Body" &&
          error.kind !== "ResponseHeaders"
            ? Effect.fail(new InvalidRequest())
            : Effect.die(error),
        ),
        Effect.map(noStore),
      ),
    ),
  );
  const apiRoutes = ownerApiRoutes.pipe(Layer.provide(ownerAccess)) as Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Bindings>
  >;

  const routes = HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/api/owner",
      asOwner(
        Effect.gen(function* () {
          const owner = yield* Owner;
          return respond(200, { email: owner.email });
        }),
      ),
    ),
    HttpRouter.route("GET", "/authorize", asOwner(authorize)),
    HttpRouter.route("*", "/api/*", asOwner(Effect.succeed(notFound))),
    HttpRouter.route("*", "/mcp", asAgentConnection(Effect.succeed(notFound))),
    HttpRouter.route("*", "/mcp/*", asAgentConnection(Effect.succeed(notFound))),
    HttpRouter.route("*", "/oauth/token", asAgent(tokenEndpoint)),
    HttpRouter.route(
      "*",
      "/.well-known/oauth-authorization-server",
      asAgent(authorizationServerMetadata),
    ),
    HttpRouter.route("GET", protectedResourceMetadataPath, asAgent(protectedResourceMetadata)),
    ...unservedMachinePaths.map((path) =>
      HttpRouter.route("*", path, asAgent(Effect.succeed(notFound))),
    ),
    ...bareWildcardBases.map((path) => HttpRouter.route("*", path, notFound)),
    HttpRouter.route("*", "/*", notFound),
  ]);

  const { handler } = HttpRouter.toWebHandler(Layer.merge(routes, apiRoutes), {
    disableLogger: true,
    routerConfig: {
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      caseSensitive: true,
    },
  });

  return (request: Request, env: Env, execution: ExecutionContext): Promise<Response> =>
    handler(request, Context.make(Bindings, env).pipe(Context.add(Execution, execution)));
};
