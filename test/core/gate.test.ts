import { format } from "node:util";
import { env } from "cloudflare:workers";
import { Data, Effect } from "effect";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { notificationsSend } from "../../src/core/capabilities.ts";
import {
  authenticateConnection,
  changeGrant,
  revokeConnection,
} from "../../src/core/connections.ts";
import { makeGate } from "../../src/core/gate.ts";
import {
  auditRows,
  expireConnection,
  rejectAuditInserts,
  runCore,
  seedConnection,
} from "./connection-fixture.ts";
import { install } from "./installation.ts";

const { run } = makeGate(env.DB);

const authenticateLaptop = async () => {
  const { id } = await seedConnection("Laptop");
  return runCore(authenticateConnection(id));
};

beforeEach(async () => {
  await install([]);
});

it.each([
  ["not_granted", (id: string) => runCore(changeGrant(env.DB, id, notificationsSend, null))],
  ["denied_by_grant", (id: string) => runCore(changeGrant(env.DB, id, notificationsSend, "deny"))],
  [
    "approval_unavailable",
    (id: string) => runCore(changeGrant(env.DB, id, notificationsSend, "ask")),
  ],
  ["connection_revoked", (id: string) => runCore(revokeConnection(env.DB, id))],
  ["connection_expired", expireConnection],
] as const)("denies and audits %s at action time", async (reason, changeState) => {
  const connection = await authenticateLaptop();
  await changeState(connection.id);
  const send = vi.fn(() => Effect.void);

  await expect(runCore(run(connection, notificationsSend, {}, send))).rejects.toMatchObject({
    _tag: "Denied",
    reason,
  });
  expect(send).not.toHaveBeenCalled();
  expect(await auditRows()).toMatchObject([
    { connection_id: connection.id, capability: notificationsSend.id, outcome: "denied", reason },
  ]);
});

it("commits the audit entry before acting and finishes the same entry", async () => {
  const connection = await authenticateLaptop();
  const send = vi.fn(() => "queued");
  const result = await runCore(
    run(connection, notificationsSend, {}, ({ auditEntryId }) =>
      Effect.promise(async () => {
        const row = await env.DB.prepare("SELECT * FROM audit_entries WHERE id = ?")
          .bind(auditEntryId)
          .first();
        expect(row).toMatchObject({
          connection_id: connection.id,
          capability: notificationsSend.id,
          outcome: null,
          finished_at: null,
        });
        return { auditEntryId, delivery: send() };
      }),
    ),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.delivery).toBe("queued");
  expect(await auditRows()).toMatchObject([
    { id: result.auditEntryId, outcome: "succeeded", finished_at: expect.any(Number) },
  ]);
});

it("refuses to act when the audit insert fails", async () => {
  const connection = await authenticateLaptop();
  await rejectAuditInserts();
  const send = vi.fn(() => Effect.void);

  await expect(runCore(run(connection, notificationsSend, {}, send))).rejects.toMatchObject({
    _tag: "Unavailable",
  });
  expect(send).not.toHaveBeenCalled();
  expect(await auditRows()).toEqual([]);
});

it("keeps the action result when finishing the audit entry fails", async () => {
  const connection = await authenticateLaptop();
  await env.DB.prepare(`CREATE TRIGGER reject_audit_finish BEFORE UPDATE ON audit_entries
    BEGIN SELECT RAISE(ABORT, 'audit update blocked by test'); END`).run();

  await expect(
    runCore(run(connection, notificationsSend, {}, () => Effect.succeed("queued"))),
  ).resolves.toBe("queued");
  expect(await auditRows()).toMatchObject([{ outcome: null, finished_at: null }]);
});

class DeliveryFailed extends Data.TaggedError("DeliveryFailed")<{ readonly message: string }> {}

it("keeps the failure message out of audit rows and Worker logs", async ({ onTestFinished }) => {
  const connection = await authenticateLaptop();
  const privateValue = "synthetic private notification body";
  const failure = new DeliveryFailed({ message: privateValue });
  const logs: Array<string> = [];
  for (const level of ["debug", "error", "info", "log", "warn"] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args) => {
      logs.push(format(...args));
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
  }

  await expect(
    runCore(run(connection, notificationsSend, {}, () => Effect.fail(failure))),
  ).rejects.toBe(failure);
  const entries = await auditRows();
  expect(JSON.stringify(entries)).not.toContain(privateValue);
  expect(logs.join("\n")).not.toContain(privateValue);
  expect(entries).toMatchObject([{ outcome: "failed", reason: "DeliveryFailed" }]);
});
