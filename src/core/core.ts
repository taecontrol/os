import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import type { ConfigKey } from "./config.ts";
import type { OwnerIdentity } from "./identity.ts";
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

export class Bindings extends Context.Service<Bindings, Env>()("os/core/Bindings") {}

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
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
  ) =>
    Effect.matchEffect(gate, {
      onFailure: (refusal) => Effect.succeed(refuse(refusal)),
      onSuccess: (value) => Effect.provideService(handler, service, value),
    });

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

  const asOwner = guarded(ownerGate);
  const asMachine = guarded(machineGate);

  const routes = HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/api/owner",
      asOwner(
        Owner,
        Effect.gen(function* () {
          const owner = yield* Owner;
          return respond(200, { email: owner.email });
        }),
      ),
    ),
    HttpRouter.route("*", "/api/*", asOwner(Owner, Effect.succeed(notFound))),
    ...machinePaths.map((path) =>
      HttpRouter.route("*", path, asMachine(OwnerGeneration, Effect.succeed(notFound))),
    ),
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
