import { Effect, Layer } from "effect";
import { HttpIncomingMessage, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { getAuditEntry, listAuditEntries } from "./audit.ts";
import { Bindings } from "./bindings.ts";
import { capabilityCatalog, findCapability, type GrantMode, grantModes } from "./capabilities.ts";
import { changeGrant, getConnection, listConnections, revokeConnection } from "./connections.ts";
import { decideConsent, describeConsent } from "./consent.ts";
import { ConsentDecision, GrantPayload, OwnerApi, OwnerApiGroup } from "./owner-contract.ts";
import { CapabilityNotFound, InvalidRequest, refuse, type Refusal } from "./refusal.ts";

const refusing = <A, R>(effect: Effect.Effect<A, Refusal, R>) =>
  effect.pipe(Effect.catch((error) => Effect.succeed(refuse(error))));

const withDatabase = <A>(operation: (db: D1Database) => Effect.Effect<A, Refusal>) =>
  refusing(Bindings.pipe(Effect.flatMap(({ DB }) => operation(DB))));

const updateGrant = (
  id: string,
  capability: string,
  mode: Effect.Effect<GrantMode | null, InvalidRequest>,
) =>
  withDatabase((db) =>
    Effect.gen(function* () {
      const declared = findCapability(capability);
      if (declared === undefined) return yield* new CapabilityNotFound();
      return yield* changeGrant(db, id, declared, yield* mode);
    }),
  );

const decodeGrant = HttpIncomingMessage.schemaBodyJson(GrantPayload);
const decodeDecision = HttpIncomingMessage.schemaBodyJson(ConsentDecision);

const handlers = HttpApiBuilder.group(OwnerApi, OwnerApiGroup.identifier, (group) =>
  group
    .handle("capabilities", () =>
      Effect.succeed(capabilityCatalog.map((capability) => ({ ...capability, modes: grantModes }))),
    )
    .handle("connections", () => withDatabase(listConnections))
    .handle("connection", ({ params }) => withDatabase((db) => getConnection(db, params.id)))
    .handle("revoke", ({ params }) => withDatabase((db) => revokeConnection(db, params.id)))
    .handleRaw("putGrant", ({ params, request }) =>
      updateGrant(
        params.id,
        params.capability,
        decodeGrant(request).pipe(
          Effect.map(({ mode }) => mode),
          Effect.mapError(() => new InvalidRequest()),
        ),
      ),
    )
    .handle("deleteGrant", ({ params }) =>
      updateGrant(params.id, params.capability, Effect.succeed(null)),
    )
    .handle("audit", ({ query }) =>
      withDatabase((db) =>
        listAuditEntries(db, { ...query, limit: Math.min(query.limit ?? 50, 100) }),
      ),
    )
    .handle("auditEntry", ({ params }) => withDatabase((db) => getAuditEntry(db, params.id)))
    .handle("consent", ({ params }) => refusing(describeConsent(params.id)))
    .handleRaw("decideConsent", ({ params, request }) =>
      refusing(
        decideConsent(
          params.id,
          decodeDecision(request).pipe(Effect.mapError(() => new InvalidRequest())),
        ),
      ),
    ),
);

export const ownerApiRoutes = HttpApiBuilder.layer(OwnerApi).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
);
