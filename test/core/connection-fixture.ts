import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { Bindings } from "../../src/core/bindings.ts";
import { notificationsSend } from "../../src/core/capabilities.ts";
import { createConnection, parseConnectionRequest } from "../../src/core/connections.ts";
import { readOwner } from "../../src/core/owner.ts";

export const runCore = <A, E>(effect: Effect.Effect<A, E, Bindings>) =>
  Effect.runPromise(Effect.provideService(effect, Bindings, env));

export const notificationGrant = { capability: notificationsSend.id, mode: "allow" } as const;

export const notificationConsent = (name: string) =>
  Result.getOrThrow(parseConnectionRequest({ name, grants: [notificationGrant] }));

export const seedConnection = async (name: string) => {
  const { generation } = await runCore(readOwner(env.DB));
  return runCore(createConnection(generation, notificationConsent(name)));
};

export const expireConnection = (id: string) =>
  env.DB.prepare("UPDATE connections SET expires_at = 0 WHERE id = ?").bind(id).run();

export const auditRows = async () =>
  (await env.DB.prepare("SELECT * FROM audit_entries").all()).results;

export const rejectAuditInserts = () =>
  env.DB.prepare(`CREATE TRIGGER reject_audit_insert BEFORE INSERT ON audit_entries
    BEGIN SELECT RAISE(ABORT, 'audit insert blocked by test'); END`).run();
