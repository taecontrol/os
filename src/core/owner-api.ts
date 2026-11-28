import { Effect, Layer } from "effect";
import { HttpIncomingMessage, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { getAuditEntry, listAuditEntries } from "./audit.ts";
import { Bindings } from "./bindings.ts";
import { capabilityCatalog, findCapability, type GrantMode, grantModes } from "./capabilities.ts";
import { changeGrant, getConnection, listConnections, revokeConnection } from "./connections.ts";
import { GrantPayload, OwnerApi, OwnerApiGroup } from "./owner-contract.ts";
import { CapabilityNotFound, InvalidRequest, refuse, type Refusal } from "./refusal.ts";

const withDatabase = <A>(operation: (db: D1Database) => Effect.Effect<A, Refusal>) =>
  Bindings.pipe(
    Effect.flatMap(({ DB }) => operation(DB)),
    Effect.catch((error) => Effect.succeed(refuse(error))),
  );

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
    .handle("auditEntry", ({ params }) => withDatabase((db) => getAuditEntry(db, params.id))),
);

export const ownerApiRoutes = HttpApiBuilder.layer(OwnerApi).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
);
