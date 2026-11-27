import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { readRuntimeIdentity, runtimeIdentity } from "../src/index.ts";

describe("runtime identity", () => {
  it("resolves through the Effect runtime", () => {
    expect(readRuntimeIdentity()).toEqual({ name: "os" });
    expect(Effect.runSync(runtimeIdentity)).toEqual({ name: "os" });
  });
});
