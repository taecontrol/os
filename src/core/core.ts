import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import { Bindings } from "./bindings.ts";
import type { ConfigKey } from "./config.ts";
import type { OwnerIdentity } from "./identity.ts";
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
    HttpRouter.route("*", "/api/*", asOwner(Effect.succeed(notFound))),
    ...machinePaths.map((path) => HttpRouter.route("*", path, asAgent(Effect.succeed(notFound)))),
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

  return (request: Request, env: Env): Promise<Response> =>
    handler(request, Context.make(Bindings, env));
};
