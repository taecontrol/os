import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import type { Bindings } from "./bindings.ts";
import { GrantMode, Grants } from "./capabilities.ts";
import type { Owner } from "./owner.ts";
import { refusalSchema, SetupIncompleteResponse } from "./refusal.ts";

const ById = Schema.Struct({ id: Schema.String });
const ByGrant = Schema.Struct({ id: Schema.String, capability: Schema.String });
export const GrantPayload = Schema.Struct({ mode: GrantMode });

const Capability = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  scope: Schema.Literal("installation"),
  modes: Schema.Array(GrantMode),
});

const Connection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "expired", "revoked"]),
  expiresAt: Schema.Int,
  revokedAt: Schema.NullOr(Schema.Int),
  lastUsedAt: Schema.NullOr(Schema.Int),
  grants: Grants,
});

const AuditEntry = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.Int,
  finishedAt: Schema.NullOr(Schema.Int),
  connection: Schema.Struct({ id: Schema.String, name: Schema.String }),
  capability: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["denied", "succeeded", "failed", "unfinished"]),
  reason: Schema.NullOr(Schema.String),
  annotation: Schema.Struct({
    session: Schema.NullOr(Schema.String),
    purpose: Schema.NullOr(Schema.String),
  }),
});

const AuditQuery = Schema.Struct({
  connection: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
});

const connectionError = refusalSchema("ConnectionNotFound");
const invalidRequest = refusalSchema("InvalidRequest");
const grantErrors = [
  connectionError,
  refusalSchema("CapabilityNotFound"),
  refusalSchema("ConnectionRevoked"),
];

export class OwnerApiAccess extends HttpApiMiddleware.Service<
  OwnerApiAccess,
  { requires: Bindings; provides: Owner }
>()("os/core/OwnerApiAccess", {
  error: [
    SetupIncompleteResponse,
    refusalSchema("AgentCredentialRejected"),
    refusalSchema("Unauthenticated"),
    refusalSchema("NotOwner"),
    refusalSchema("OwnerLocked"),
    refusalSchema("Unavailable"),
  ],
}) {}

export const OwnerApiGroup = HttpApiGroup.make("owner")
  .add(
    HttpApiEndpoint.get("capabilities", "/api/capabilities", { success: Schema.Array(Capability) }),
    HttpApiEndpoint.get("connections", "/api/connections", { success: Schema.Array(Connection) }),
    HttpApiEndpoint.get("connection", "/api/connections/:id", {
      params: ById,
      success: Connection,
      error: connectionError,
    }),
    HttpApiEndpoint.post("revoke", "/api/connections/:id/revoke", {
      params: ById,
      success: Connection,
      error: connectionError,
    }),
    HttpApiEndpoint.put("putGrant", "/api/connections/:id/grants/:capability", {
      params: ByGrant,
      payload: GrantPayload,
      success: Connection,
      error: [...grantErrors, invalidRequest],
    }),
    HttpApiEndpoint.delete("deleteGrant", "/api/connections/:id/grants/:capability", {
      params: ByGrant,
      success: Connection,
      error: grantErrors,
    }),
    HttpApiEndpoint.get("audit", "/api/audit", {
      query: AuditQuery,
      success: Schema.Struct({
        entries: Schema.Array(AuditEntry),
        nextCursor: Schema.NullOr(Schema.String),
      }),
      error: invalidRequest,
    }),
    HttpApiEndpoint.get("auditEntry", "/api/audit/:id", {
      params: ById,
      success: AuditEntry,
      error: refusalSchema("AuditEntryNotFound"),
    }),
  )
  .middleware(OwnerApiAccess);

export const OwnerApi = HttpApi.make("os").add(OwnerApiGroup);
