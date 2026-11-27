import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkoutCopy, withoutVitest } from "./checkout-copy.ts";

const seed = [
  "UPDATE owner SET email = 'owner@example.com' WHERE id = 1",
  "CREATE TABLE test_root (id INTEGER PRIMARY KEY, owner_generation INTEGER NOT NULL REFERENCES owner (generation) ON DELETE CASCADE) STRICT",
  "CREATE TABLE test_child (id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES test_root (id) ON DELETE CASCADE) STRICT",
  "INSERT INTO test_root (id, owner_generation) VALUES (1, 1)",
  "INSERT INTO test_child (root_id) VALUES (1)",
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
        "SELECT generation, email, (SELECT count(*) FROM test_root) AS roots, (SELECT count(*) FROM test_child) AS children FROM owner",
      );
      succeeded(state);
      expect((JSON.parse(state.stdout) as Array<{ results: unknown }>)[0]?.results).toEqual([
        { generation: 2, email: null, roots: 0, children: 0 },
      ]);
      violatesForeignKey(execute("INSERT INTO test_root (owner_generation) VALUES (1)"));
      succeeded(execute("INSERT INTO test_root (owner_generation) VALUES (2)"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
