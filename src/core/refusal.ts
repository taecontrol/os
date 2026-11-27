import { Data } from "effect";
import { HttpServerResponse } from "effect/http";
import type { SetupIncomplete } from "./config.ts";

export class AgentCredentialRejected extends Data.TaggedError("AgentCredentialRejected") {}
export class AccessAssertionRejected extends Data.TaggedError("AccessAssertionRejected") {}
export class Unauthenticated extends Data.TaggedError("Unauthenticated") {}
export class NotOwner extends Data.TaggedError("NotOwner") {}
export class OwnerLocked extends Data.TaggedError("OwnerLocked") {}
export class Unavailable extends Data.TaggedError("Unavailable") {}

export type Refusal =
  | SetupIncomplete
  | AgentCredentialRejected
  | AccessAssertionRejected
  | Unauthenticated
  | NotOwner
  | OwnerLocked
  | Unavailable;

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
  }
};
