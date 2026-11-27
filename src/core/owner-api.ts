import { Effect, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest } from "effect/http";
import { AuditCursor, getAuditEntry, listAuditEntries } from "./audit.ts";
import { Bindings } from "./bindings.ts";
import { capabilityCatalog, findCapability, GrantMode, grantModes } from "./capabilities.ts";
import { changeGrant, getConnection, listConnections, revokeConnection } from "./connections.ts";
import { CapabilityNotFound, InvalidRequest, respond } from "./refusal.ts";

const AuditQuery = Schema.Struct({
  connection: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(AuditCursor),
  limit: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
});

const invalidRequest = Effect.mapError(() => new InvalidRequest());

const grantMode = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Schema.Struct({ mode: GrantMode }))),
  invalidRequest,
);

const resourceId = HttpRouter.schemaPathParams(Schema.Struct({ id: Schema.String })).pipe(
  Effect.map(({ id }) => id),
  invalidRequest,
);

const grantKey = Effect.gen(function* () {
  const { id, capability } = yield* HttpRouter.schemaPathParams(
    Schema.Struct({ id: Schema.String, capability: Schema.String }),
  ).pipe(invalidRequest);
  const declared = findCapability(capability);
  if (declared === undefined) return yield* new CapabilityNotFound();
  return { id, capability: declared };
});

export const capabilities = Effect.succeed(
  respond(
    200,
    capabilityCatalog.map((capability) => ({ ...capability, modes: grantModes })),
  ),
);

export const connections = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  return respond(200, yield* listConnections(DB));
});

export const connection = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  return respond(200, yield* getConnection(DB, id));
});

export const revoke = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  return respond(200, yield* revokeConnection(DB, id));
});

export const putGrant = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const { id, capability } = yield* grantKey;
  const { mode } = yield* grantMode;
  return respond(200, yield* changeGrant(DB, id, capability, mode));
});

export const deleteGrant = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const { id, capability } = yield* grantKey;
  return respond(200, yield* changeGrant(DB, id, capability, null));
});

export const audit = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const page = yield* HttpServerRequest.schemaSearchParams(AuditQuery).pipe(invalidRequest);
  return respond(
    200,
    yield* listAuditEntries(DB, { ...page, limit: Math.min(page.limit ?? 50, 100) }),
  );
});

export const auditEntry = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  return respond(200, yield* getAuditEntry(DB, id));
});
