import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

function lintSnippet(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "os-no-comments-"));
  const file = join(dir, "fixture.ts");
  try {
    writeFileSync(file, source, "utf8");
    return spawnSync("vp", ["lint", "--format=default", file], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("os/no-comments lint rule", () => {
  it("accepts clean code including strings that look like comments", () => {
    const result = lintSnippet(
      [
        'export const url = "https://example.com/a//b";',
        'export const pattern = "/* not a comment */";',
        "",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
  });

  it("rejects line comments", () => {
    const result = lintSnippet(["/" + "/ explanation", "export const value = 1;", ""].join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("os(no-comments)");
  });

  it("rejects block comments", () => {
    const result = lintSnippet(["/" + "* block *" + "/", "export const value = 1;", ""].join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("os(no-comments)");
  });

  it("rejects JSDoc comments", () => {
    const result = lintSnippet(["/" + "** doc *" + "/", "export const value = 1;", ""].join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("os(no-comments)");
  });

  it("rejects lint-disable comments that attempt to bypass the rule", () => {
    const lineDisable = lintSnippet(
      ["export const value = 1; " + "/" + "/ oxlint-disable-line os/no-comments", ""].join("\n"),
    );
    const nextLineDisable = lintSnippet(
      ["/" + "/ oxlint-disable-next-line os/no-comments", "export const value = 1;", ""].join("\n"),
    );
    const blockDisable = lintSnippet(
      ["/" + "* oxlint-disable *" + "/", "export const value = 1;", ""].join("\n"),
    );

    expect(lineDisable.status).not.toBe(0);
    expect(lineDisable.stdout + lineDisable.stderr).toContain(
      "Lint disable comments are not allowed.",
    );
    expect(nextLineDisable.status).not.toBe(0);
    expect(nextLineDisable.stdout + nextLineDisable.stderr).toContain(
      "Lint disable comments are not allowed.",
    );
    expect(blockDisable.status).not.toBe(0);
    expect(blockDisable.stdout + blockDisable.stderr).toContain(
      "Lint disable comments are not allowed.",
    );
  });
});
