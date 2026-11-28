import { env } from "cloudflare:workers";
import { Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { notificationsSend } from "../../src/core/capabilities.ts";
import {
  authenticateConnection,
  changeGrant,
  createConnection,
  getConnection,
  listConnections,
  parseConnectionRequest,
  revokeConnection,
} from "../../src/core/connections.ts";
import { readOwner } from "../../src/core/owner.ts";
import {
  auditRows,
  expireConnection,
  notificationConsent,
  notificationGrant,
  rejectAuditInserts,
  runCore,
  seedConnection,
} from "./connection-fixture.ts";
import { install } from "./installation.ts";

it.each([
  [undefined, 90],
  [7, 7],
  [30, 30],
  [90, 90],
  [365, "InvalidRequest"],
])("resolves a consent expiry of %s to %s", (days, expected) => {
  const input = days === undefined ? { name: "Laptop" } : { name: "Laptop", expiresInDays: days };
  const result = parseConnectionRequest(input);
  expect(Result.isSuccess(result) ? result.success.expiresInDays : result.failure._tag).toBe(
    expected,
  );
});

it("redeems the same consent without restoring grants, extending expiry, or undoing revocation", async ({
  onTestFinished,
}) => {
  await install([]);
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const startedAt = Date.now();
  const day = 86_400_000;
  const { generation } = await runCore(readOwner(env.DB));
  const consent = notificationConsent("Laptop");
  const { id } = consent;
  const redeem = () => runCore(createConnection(generation, consent));
  const original = { id, name: "Laptop", expiresAt: startedAt + 90 * day };

  expect(await Promise.all([redeem(), redeem()])).toEqual([original, original]);
  expect(await runCore(listConnections(env.DB))).toEqual([
    expect.objectContaining({ ...original, grants: [notificationGrant] }),
  ]);

  await runCore(changeGrant(env.DB, id, notificationsSend, null));
  vi.setSystemTime(startedAt + day);
  expect(await redeem()).toEqual(original);
  expect((await runCore(getConnection(env.DB, id))).grants).toEqual([]);

  const revoked = await runCore(revokeConnection(env.DB, id));
  expect(revoked.status).toBe("revoked");
  await expect(redeem()).rejects.toMatchObject({ _tag: "InvalidToken" });
  expect(await runCore(getConnection(env.DB, id))).toEqual(revoked);
});

it("audits known dead connections without recording unknown IDs or losing the refusal on write failure", async () => {
  await install([]);
  const { id: revoked } = await seedConnection("Old laptop");
  const { id: expired } = await seedConnection("Expired laptop");
  await runCore(revokeConnection(env.DB, revoked));
  await expireConnection(expired);

  const invalid = (id: string) =>
    expect(runCore(authenticateConnection(id))).rejects.toMatchObject({ _tag: "InvalidToken" });
  await invalid("00000000-0000-4000-8000-000000000000");
  await invalid(revoked);
  await invalid(expired);

  const { results } = await env.DB.prepare(
    "SELECT connection_id, capability, outcome, reason FROM audit_entries ORDER BY reason",
  ).all();
  expect(results).toEqual([
    { connection_id: expired, capability: null, outcome: "denied", reason: "connection_expired" },
    { connection_id: revoked, capability: null, outcome: "denied", reason: "connection_revoked" },
  ]);

  await rejectAuditInserts();
  await invalid(revoked);
  expect(await auditRows()).toHaveLength(2);
});
