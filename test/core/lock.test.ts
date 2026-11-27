import { describe, expect, it } from "vite-plus/test";
import { answer, install, makeKey, ownerRow, signedBy } from "./installation.ts";

const accessKey = await makeKey("access");
const configuredA = { env: { OWNER_EMAIL: "a@example.com" } };
const configuredB = { env: { OWNER_EMAIL: "b@example.com" } };
const ownerLocked = { status: 503, body: { error: "owner_locked" } };

describe("a configuration change", () => {
  it("cannot transfer ownership", async () => {
    const installation = await install([accessKey]);
    const a = await signedBy(accessKey, { email: "a@example.com" });
    const b = await signedBy(accessKey, { email: "b@example.com" });
    const asA = await answer(
      await installation.request("/api/owner", { headers: a, ...configuredA }),
    );
    expect(asA).toEqual({ status: 200, body: { email: "a@example.com" } });

    expect(
      await answer(await installation.request("/api/owner", { headers: b, ...configuredB })),
    ).toEqual(ownerLocked);
    expect(await answer(await installation.request("/mcp", configuredB))).toEqual(ownerLocked);
    expect(
      await answer(await installation.request("/api/owner", { headers: a, ...configuredB })),
    ).toEqual({
      status: 403,
      body: { error: "not_owner" },
    });
    expect(await ownerRow()).toEqual({ generation: 1, email: "a@example.com" });

    expect(
      await answer(await installation.request("/api/owner", { headers: a, ...configuredA })),
    ).toEqual(asA);
  });
});
