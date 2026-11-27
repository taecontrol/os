import { describe, expect, it } from "vite-plus/test";
import { answer, install, makeKey, ownerRow, signedBy } from "./installation.ts";

const accessKey = await makeKey("access");
const impostorKey = await makeKey("access");
const pssKey = await makeKey("pss", "RSA-PSS");
const now = () => Math.floor(Date.now() / 1000);

describe("owner identity from an Access assertion", () => {
  it("comes only from an assertion valid for this installation", async () => {
    const installation = await install([accessKey, pssKey]);
    const refused = {
      "signed by another key with the same key ID": await signedBy(impostorKey),
      "for another audience": await signedBy(accessKey, { aud: ["b".repeat(64)] }),
      "from another issuer": await signedBy(accessKey, {
        iss: "https://other-team.cloudflareaccess.com",
      }),
      expired: await signedBy(accessKey, { exp: now() - 1 }),
      "not yet valid": await signedBy(accessKey, { nbf: now() + 600 }),
      "without an expiry": await signedBy(accessKey, { exp: undefined }),
      "without a not-before time": await signedBy(accessKey, { nbf: undefined }),
      "signed with PS256": await signedBy(pssKey, {}, "PS256"),
    };
    for (const [name, headers] of Object.entries(refused)) {
      expect({
        name,
        ...(await answer(await installation.request("/api/owner", { headers }))),
      }).toEqual({
        name,
        status: 401,
        body: { error: "unauthenticated" },
      });
    }
    expect(await ownerRow()).toEqual({ generation: 1, email: null });

    const otherIdentity = await signedBy(accessKey, { email: "someone@example.com" });
    expect(
      await answer(await installation.request("/api/owner", { headers: otherIdentity })),
    ).toEqual({
      status: 403,
      body: { error: "not_owner" },
    });
    expect(await ownerRow()).toEqual({ generation: 1, email: null });

    const owner = await signedBy(accessKey);
    expect(await answer(await installation.request("/api/owner", { headers: owner }))).toEqual({
      status: 200,
      body: { email: "owner@example.com" },
    });
  });
});
