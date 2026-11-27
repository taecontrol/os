import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { AuditCursor, getAuditEntry, listAuditEntries } from "./audit.ts";
import { Bindings } from "./bindings.ts";
import { capabilityCatalog, findCapability, GrantMode, grantModes } from "./capabilities.ts";
import {
  changeGrant,
  createConnection,
  getConnection,
  listConnections,
  revokeConnection,
  rotateConnection,
} from "./connections.ts";
import { Owner } from "./owner.ts";
import { CapabilityNotFound, InvalidRequest, respond } from "./refusal.ts";
import { truncateCharacters } from "./text.ts";

const ExpiryOptions = { expiresInDays: Schema.optionalKey(Schema.Literals([7, 30, 90, 365])) };
const defaultExpiryDays = 90;

const ConnectionName = Schema.Trim.check(
  Schema.makeFilter((name) => name.length > 0 && truncateCharacters(name, 64) === name),
);

const CreateConnection = Schema.Struct({ name: ConnectionName, ...ExpiryOptions });
const RotateConnection = Schema.Struct(ExpiryOptions);
const GrantChange = Schema.Struct({ mode: GrantMode });

const AuditQuery = Schema.Struct({
  connection: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(AuditCursor),
  limit: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
});

const invalidRequest = Effect.mapError(() => new InvalidRequest());

const readJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, allowEmpty = false) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text;
    return yield* decode(allowEmpty && body === "" ? "{}" : body);
  }).pipe(invalidRequest);
};

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

export const create = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const { generation } = yield* Owner;
  const { name, expiresInDays = defaultExpiryDays } = yield* readJson(CreateConnection);
  return respond(201, yield* createConnection(DB, generation, name, expiresInDays));
});

export const connection = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  return respond(200, yield* getConnection(DB, id));
});

export const rotate = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  const { expiresInDays = defaultExpiryDays } = yield* readJson(RotateConnection, true);
  return respond(200, yield* rotateConnection(DB, id, expiresInDays));
});

export const revoke = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const id = yield* resourceId;
  return respond(200, yield* revokeConnection(DB, id));
});

export const putGrant = Effect.gen(function* () {
  const { DB } = yield* Bindings;
  const { id, capability } = yield* grantKey;
  const { mode } = yield* readJson(GrantChange);
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
