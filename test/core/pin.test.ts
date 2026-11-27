import { env } from "cloudflare:workers";
import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { normalizeEmail } from "../../src/core/config.ts";
import { pinOwner, readOwner } from "../../src/core/owner.ts";
import { Unavailable } from "../../src/core/refusal.ts";
import { install, ownerRow } from "./installation.ts";

const owner = Option.getOrThrow(normalizeEmail("owner@example.com"));

describe("pinning the owner", () => {
  it("cannot land on the generation that replaced the one it read", async () => {
    await install([]);
    const stale = await Effect.runPromise(readOwner(env.DB));
    await env.DB.prepare("UPDATE owner SET generation = generation + 1 WHERE id = 1").run();

    expect(await Effect.runPromise(Effect.result(pinOwner(env.DB, stale, owner)))).toEqual(
      Result.fail(new Unavailable()),
    );
    expect(await ownerRow()).toEqual({ generation: 2, email: null });

    const fresh = await Effect.runPromise(readOwner(env.DB));
    await Effect.runPromise(pinOwner(env.DB, fresh, owner));
    expect(await ownerRow()).toEqual({ generation: 2, email: "owner@example.com" });
  });
});
