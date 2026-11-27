import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const notCopied = new Set([".git", ".work", ".wrangler", ".dev.vars", "dist", "node_modules"]);

export function checkoutCopy(prefix: string): string {
  const checkout = process.cwd();
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(checkout, root, {
    recursive: true,
    filter: (source) => !notCopied.has(relative(checkout, source).split("/")[0] ?? ""),
  });
  symlinkSync(join(checkout, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

export function withoutVitest(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  return environment;
}
