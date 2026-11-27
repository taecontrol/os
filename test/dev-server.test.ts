import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import { checkoutCopy, withoutVitest } from "./checkout-copy.ts";

describe("vp dev", () => {
  it("listens only on loopback unless given a host", { timeout: 60_000 }, async () => {
    const root = checkoutCopy("os-dev-server-");
    const environment = process.env;
    process.env = withoutVitest();
    try {
      const server = await createServer({
        root,
        configFile: join(root, "vite.config.ts"),
        server: { port: 0 },
        logLevel: "silent",
      });
      try {
        await server.listen();
        expect(server.httpServer?.address()).toEqual(
          expect.objectContaining({ address: expect.stringMatching(/^(?:127\.0\.0\.1|::1)$/u) }),
        );
      } finally {
        await server.close();
      }
    } finally {
      process.env = environment;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
