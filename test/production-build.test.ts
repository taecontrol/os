import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import { describe, expect, it } from "vite-plus/test";

const syntheticOwnerModule = "src/core/synthetic-owner.ts";

const ownerEmail = { OWNER_EMAIL: "owner@example.com" };
const completeConfig = {
  ...ownerEmail,
  ACCESS_ISSUER: "https://example-team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "a".repeat(64),
};

function buildEnvironment(nodeEnv: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  if (nodeEnv === undefined) delete environment.NODE_ENV;
  return environment;
}

function modulesInWorker(workerDir: string): ReadonlyArray<string> {
  expect(readdirSync(workerDir)).toEqual(expect.arrayContaining(["index.js", "index.js.map"]));
  const sourceMap = JSON.parse(readFileSync(join(workerDir, "index.js.map"), "utf8")) as {
    readonly sources: ReadonlyArray<string>;
  };
  return sourceMap.sources;
}

async function ownerResponse(workerDir: string, devVars: Record<string, string>) {
  writeFileSync(
    join(workerDir, ".dev.vars"),
    Object.entries(devVars)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  const worker = await unstable_startWorker({
    config: join(workerDir, "wrangler.json"),
    dev: { server: { port: 0 }, inspector: false, persist: false, logLevel: "none" },
  });
  try {
    const response = await worker.fetch("http://localhost/api/owner");
    return { status: response.status, body: await response.json() };
  } finally {
    await worker.dispose();
  }
}

describe.each([
  { label: "unset", nodeEnv: undefined },
  { label: "development", nodeEnv: "development" },
  { label: "test", nodeEnv: "test" },
])("vp build with NODE_ENV $label", ({ nodeEnv }) => {
  it("ships a Worker without the synthetic owner", { timeout: 120_000 }, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "os-production-build-"));
    try {
      const build = spawnSync("vp", ["build", "--outDir", outDir], {
        cwd: process.cwd(),
        env: buildEnvironment(nodeEnv),
        encoding: "utf8",
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);

      const workerDir = join(outDir, "os_core");
      expect(
        modulesInWorker(workerDir).filter((module) => module.endsWith(syntheticOwnerModule)),
      ).toEqual([]);

      expect(await ownerResponse(workerDir, completeConfig)).toEqual({
        status: 401,
        body: { error: "unauthenticated" },
      });
      expect(await ownerResponse(workerDir, ownerEmail)).toEqual({
        status: 503,
        body: { error: "setup_incomplete", missing: ["ACCESS_ISSUER", "ACCESS_AUDIENCE"] },
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
