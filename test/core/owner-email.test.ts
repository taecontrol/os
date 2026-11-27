import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { answer, install, makeKey, ownerRow, signedBy } from "./installation.ts";

const accessKey = await makeKey("access");

const malformed = [
  "owner.example.com",
  "owner@sub@example.com",
  "@example.com",
  "owner@",
  "own er@example.com",
];

describe("owner email", () => {
  it.each([
    {
      configured: "owner@mañana.example",
      signed: "  Owner@MAÑANA.Example ",
      pinned: "owner@mañana.example",
    },
    {
      configured: "First..Last@Example.com,",
      signed: "first..last@example.com,",
      pinned: "first..last@example.com,",
    },
  ])(
    "pins $signed as $pinned and signs in again from the pin",
    async ({ configured, signed, pinned }) => {
      const installation = await install([accessKey]);
      const options = {
        headers: await signedBy(accessKey, { email: signed }),
        env: { OWNER_EMAIL: configured },
      };
      const expected = { status: 200, body: { email: pinned } };
      expect(await answer(await installation.request("/api/owner", options))).toEqual(expected);
      expect(await ownerRow()).toEqual({ generation: 1, email: pinned });
      expect(await answer(await installation.request("/api/owner", options))).toEqual(expected);
    },
  );

  it("refuses a malformed setting, signed claim, or stored pin and keeps the pin", async () => {
    const installation = await install([accessKey]);
    const owner = await signedBy(accessKey);
    const pinned = { generation: 1, email: "owner@example.com" };
    expect((await installation.request("/api/owner", { headers: owner })).status).toBe(200);

    const setupIncomplete = {
      status: 503,
      body: { error: "setup_incomplete", missing: ["OWNER_EMAIL"] },
    };
    for (const [path, headers] of [
      ["/api/owner", {}],
      ["/mcp", owner],
    ] as const) {
      const response = await answer(
        await installation.request(path, { headers, env: { OWNER_EMAIL: malformed[0] } }),
      );
      expect({ path, ...response }).toEqual({ path, ...setupIncomplete });
    }

    for (const email of malformed) {
      const setting = await installation.request("/api/owner", {
        headers: owner,
        env: { OWNER_EMAIL: email },
      });
      const text = await setting.text();
      expect({ email, status: setting.status, body: JSON.parse(text) as unknown }).toEqual({
        email,
        ...setupIncomplete,
      });
      expect(text).not.toContain(email);

      const claim = await installation.request("/api/owner", {
        headers: await signedBy(accessKey, { email }),
      });
      expect({ email, ...(await answer(claim)) }).toEqual({
        email,
        status: 401,
        body: { error: "unauthenticated" },
      });
      expect(await ownerRow()).toEqual(pinned);

      await env.DB.prepare("UPDATE owner SET email = ?1 WHERE id = 1").bind(email).run();
      const stored = await installation.request("/api/owner", { headers: owner });
      expect({ email, ...(await answer(stored)) }).toEqual({
        email,
        status: 503,
        body: { error: "unavailable" },
      });
      expect(await ownerRow()).toEqual({ generation: 1, email });
      await env.DB.prepare("UPDATE owner SET email = ?1 WHERE id = 1").bind(pinned.email).run();
    }
  });
});
