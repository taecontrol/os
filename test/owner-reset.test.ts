import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkoutCopy, withoutVitest } from "./checkout-copy.ts";

const connectionId = "00000000-0000-4000-8000-000000000001";
const insertConnection = (generation: number) =>
  `INSERT INTO connections (id, owner_generation, name, created_at, expires_at)
    VALUES ('${connectionId}', ${generation}, 'Laptop', 1800000000000, 1800604800000)`;

const seed = [
  "UPDATE owner SET email = 'owner@example.com' WHERE id = 1",
  insertConnection(1),
  `INSERT INTO grants (connection_id, capability, mode) VALUES ('${connectionId}', 'notifications.send', 'allow')`,
  `INSERT INTO audit_entries (id, owner_generation, connection_id, capability, outcome, occurred_at, finished_at)
    VALUES ('00000000-0000-4000-8000-000000000002', 1, '${connectionId}', 'notifications.send', 'succeeded', 1800000000001, 1800000000002)`,
].join("; ");

describe("vp run owner:reset:local", () => {
  it("removes owner-bound data and rejects the old generation", { timeout: 120_000 }, () => {
    const root = checkoutCopy("os-owner-reset-");
    const run = (command: string, ...args: Array<string>) =>
      spawnSync(command, args, { cwd: root, env: withoutVitest(), encoding: "utf8" });
    const wrangler = (...args: Array<string>) =>
      run(join(root, "node_modules", ".bin", "wrangler"), ...args);
    const execute = (statement: string) =>
      wrangler("d1", "execute", "DB", "--local", "--json", "--command", statement);
    const succeeded = (result: ReturnType<typeof run>) =>
      expect(result.status, result.stdout + result.stderr).toBe(0);
    const violatesForeignKey = (result: ReturnType<typeof run>) => {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("FOREIGN KEY constraint failed");
    };
    try {
      succeeded(wrangler("d1", "migrations", "apply", "DB", "--local"));
      succeeded(execute(seed));
      violatesForeignKey(execute("UPDATE owner SET generation = 2 WHERE id = 1"));

      succeeded(run("vp", "run", "owner:reset:local"));

      const state = execute(
        `SELECT generation, email,
          (SELECT count(*) FROM connections) AS connections,
          (SELECT count(*) FROM grants) AS grants,
          (SELECT count(*) FROM audit_entries) AS audit_entries FROM owner`,
      );
      succeeded(state);
      expect((JSON.parse(state.stdout) as Array<{ results: unknown }>)[0]?.results).toEqual([
        { generation: 2, email: null, connections: 0, grants: 0, audit_entries: 0 },
      ]);
      violatesForeignKey(execute(insertConnection(1)));
      succeeded(execute(insertConnection(2)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
