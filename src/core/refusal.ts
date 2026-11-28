import { Data, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiSchema } from "effect/http-api";
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
export class InvalidClient extends Data.TaggedError("InvalidClient") {}
export class ConsentNotFound extends Data.TaggedError("ConsentNotFound") {}
export class BearerChallenge extends Data.TaggedError("BearerChallenge")<{
  readonly header: string;
}> {}

export type Refusal =
  | SetupIncomplete
  | AgentCredentialRejected
  | AccessAssertionRejected
  | Unauthenticated
  | NotOwner
  | OwnerLocked
  | Unavailable
  | InvalidRequest
  | ConnectionNotFound
  | CapabilityNotFound
  | ConnectionRevoked
  | AuditEntryNotFound
  | InvalidClient
  | ConsentNotFound
  | BearerChallenge;

const refusals = {
  SetupIncomplete: [503, "setup_incomplete"],
  AgentCredentialRejected: [400, "agent_credential_rejected"],
  AccessAssertionRejected: [400, "access_assertion_rejected"],
  Unauthenticated: [401, "unauthenticated"],
  NotOwner: [403, "not_owner"],
  OwnerLocked: [503, "owner_locked"],
  Unavailable: [503, "unavailable"],
  InvalidRequest: [400, "invalid_request"],
  ConnectionNotFound: [404, "connection_not_found"],
  CapabilityNotFound: [404, "capability_not_found"],
  ConnectionRevoked: [409, "connection_revoked"],
  AuditEntryNotFound: [404, "audit_entry_not_found"],
  InvalidClient: [401, "invalid_client"],
  ConsentNotFound: [404, "consent_not_found"],
  BearerChallenge: [401, "invalid_token"],
} as const satisfies Record<Refusal["_tag"], readonly [number, string]>;

export const refusalSchema = <Tag extends Exclude<Refusal["_tag"], "SetupIncomplete">>(
  tag: Tag,
) => {
  const [status, error] = refusals[tag];
  return Schema.Struct({ error: Schema.Literal<(typeof refusals)[Tag][1]>(error) }).pipe(
    HttpApiSchema.status(status),
  );
};

export const SetupIncompleteResponse = Schema.Struct({
  error: Schema.Literal(refusals.SetupIncomplete[1]),
  missing: Schema.Array(Schema.String),
}).pipe(HttpApiSchema.status(refusals.SetupIncomplete[0]));

export const noStore = HttpServerResponse.setHeader("cache-control", "no-store");

export const respond = (status: number, body: object): HttpServerResponse.HttpServerResponse =>
  noStore(HttpServerResponse.jsonUnsafe(body, { status }));

export const notFound = respond(404, { error: "not_found" });

export const refuse = (refusal: Refusal): HttpServerResponse.HttpServerResponse => {
  const [status, error] = refusals[refusal._tag];
  const response = respond(
    status,
    refusal._tag === "SetupIncomplete" ? { error, missing: refusal.missing } : { error },
  );
  return refusal._tag === "BearerChallenge"
    ? HttpServerResponse.setHeader(response, "www-authenticate", refusal.header)
    : response;
};
