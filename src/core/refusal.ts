import { Data } from "effect";
import { HttpServerResponse } from "effect/http";
import type { SetupIncomplete } from "./config.ts";

export class AgentCredentialRejected extends Data.TaggedError("AgentCredentialRejected") {}
export class AccessAssertionRejected extends Data.TaggedError("AccessAssertionRejected") {}
export class Unauthenticated extends Data.TaggedError("Unauthenticated") {}
export class NotOwner extends Data.TaggedError("NotOwner") {}
export class OwnerLocked extends Data.TaggedError("OwnerLocked") {}
export class Unavailable extends Data.TaggedError("Unavailable") {}
export class InvalidToken extends Data.TaggedError("InvalidToken") {}
export class InvalidRequest extends Data.TaggedError("InvalidRequest") {}
export class ConnectionNotFound extends Data.TaggedError("ConnectionNotFound") {}
export class CapabilityNotFound extends Data.TaggedError("CapabilityNotFound") {}
export class ConnectionRevoked extends Data.TaggedError("ConnectionRevoked") {}
export class AuditEntryNotFound extends Data.TaggedError("AuditEntryNotFound") {}

export type Refusal =
  | SetupIncomplete
  | AgentCredentialRejected
  | AccessAssertionRejected
  | Unauthenticated
  | NotOwner
  | OwnerLocked
  | Unavailable
  | InvalidToken
  | InvalidRequest
  | ConnectionNotFound
  | CapabilityNotFound
  | ConnectionRevoked
  | AuditEntryNotFound;

export const respond = (status: number, body: object): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

export const notFound = respond(404, { error: "not_found" });

export const refuse = (refusal: Refusal): HttpServerResponse.HttpServerResponse => {
  switch (refusal._tag) {
    case "SetupIncomplete":
      return respond(503, { error: "setup_incomplete", missing: refusal.missing });
    case "AgentCredentialRejected":
      return respond(400, { error: "agent_credential_rejected" });
    case "AccessAssertionRejected":
      return respond(400, { error: "access_assertion_rejected" });
    case "Unauthenticated":
      return respond(401, { error: "unauthenticated" });
    case "NotOwner":
      return respond(403, { error: "not_owner" });
    case "OwnerLocked":
      return respond(503, { error: "owner_locked" });
    case "Unavailable":
      return respond(503, { error: "unavailable" });
    case "InvalidToken":
      return HttpServerResponse.setHeader(
        respond(401, { error: "invalid_token" }),
        "www-authenticate",
        'Bearer error="invalid_token"',
      );
    case "InvalidRequest":
      return respond(400, { error: "invalid_request" });
    case "ConnectionNotFound":
      return respond(404, { error: "connection_not_found" });
    case "CapabilityNotFound":
      return respond(404, { error: "capability_not_found" });
    case "ConnectionRevoked":
      return respond(409, { error: "connection_revoked" });
    case "AuditEntryNotFound":
      return respond(404, { error: "audit_entry_not_found" });
  }
};
