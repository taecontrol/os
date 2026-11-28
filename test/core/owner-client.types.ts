import type { Effect } from "effect";
import type { HttpApiClient } from "effect/http-api";
import { expectTypeOf } from "vite-plus/test";
import type { OwnerApi } from "../../src/core/owner-contract.ts";

type OwnerClient = HttpApiClient.ForApi<typeof OwnerApi>["owner"];

type OwnerRefusal =
  | "setup_incomplete"
  | "agent_credential_rejected"
  | "unauthenticated"
  | "not_owner"
  | "owner_locked"
  | "unavailable";
type ConnectionRefusal = OwnerRefusal | "connection_not_found";
type GrantRefusal = ConnectionRefusal | "capability_not_found" | "connection_revoked";

type ExpectedRefusals = {
  capabilities: OwnerRefusal;
  connections: OwnerRefusal;
  connection: ConnectionRefusal;
  revoke: ConnectionRefusal;
  putGrant: GrantRefusal | "invalid_request";
  deleteGrant: GrantRefusal;
  audit: OwnerRefusal | "invalid_request";
  auditEntry: OwnerRefusal | "audit_entry_not_found";
};

type ClientRefusals = {
  [Method in keyof ExpectedRefusals]: Extract<
    Effect.Error<ReturnType<OwnerClient[Method]>>,
    { readonly error: string }
  >["error"];
};

expectTypeOf<ClientRefusals>().toEqualTypeOf<ExpectedRefusals>();
