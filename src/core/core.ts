import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { Bindings } from "./bindings.ts";
import type { ConfigKey } from "./config.ts";
import type { OwnerIdentity } from "./identity.ts";
import * as ownerApi from "./owner-api.ts";
import { Owner, OwnerGeneration, pinOwner, readOwner, requireUnlocked } from "./owner.ts";
import {
  AccessAssertionRejected,
  AgentCredentialRejected,
  notFound,
  NotOwner,
  refuse,
  respond,
  type Refusal,
} from "./refusal.ts";

const machinePaths = [
  "/mcp",
  "/mcp/*",
  "/oauth/token",
  "/oauth/token/*",
  "/.well-known/*",
  "/agent/*",
] as const;

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

export const asMachine = <K extends ConfigKey>(identity: OwnerIdentity<K>) => {
  const machineGate = Effect.gen(function* () {
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

  return <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Refusal, R>) =>
    guarded(machineGate)(OwnerGeneration, handler);
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
    HttpRouter.route("GET", "/api/capabilities", asOwner(ownerApi.capabilities)),
    HttpRouter.route("GET", "/api/connections", asOwner(ownerApi.connections)),
    HttpRouter.route("GET", "/api/connections/:id", asOwner(ownerApi.connection)),
    HttpRouter.route("POST", "/api/connections/:id/revoke", asOwner(ownerApi.revoke)),
    HttpRouter.route("PUT", "/api/connections/:id/grants/:capability", asOwner(ownerApi.putGrant)),
    HttpRouter.route(
      "DELETE",
      "/api/connections/:id/grants/:capability",
      asOwner(ownerApi.deleteGrant),
    ),
    HttpRouter.route("GET", "/api/audit", asOwner(ownerApi.audit)),
    HttpRouter.route("GET", "/api/audit/:id", asOwner(ownerApi.auditEntry)),
    HttpRouter.route("*", "/api/*", asOwner(Effect.succeed(notFound))),
    ...machinePaths.map((path) => HttpRouter.route("*", path, asAgent(Effect.succeed(notFound)))),
    ...bareWildcardBases.map((path) => HttpRouter.route("*", path, notFound)),
    HttpRouter.route("*", "/*", notFound),
  ]);

  const { handler } = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpRouter.layer)), {
    disableLogger: true,
    routerConfig: {
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      caseSensitive: true,
    },
  });

  return (request: Request, env: Env): Promise<Response> =>
    handler(request, Context.make(Bindings, env));
};
