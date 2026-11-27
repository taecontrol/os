import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testing = process.env.VITEST !== undefined;

const testBindings = {
  OWNER_EMAIL: "owner@example.com",
  ACCESS_ISSUER: "https://example-team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "a".repeat(64),
};

export default defineConfig(async ({ command }) => ({
  define: {
    SYNTHETIC_OWNER: JSON.stringify(command === "serve"),
  },
  server: { strictPort: true },
  plugins: testing ? [] : [cloudflare()],
  test: {
    projects: testing
      ? [
          {
            define: { SYNTHETIC_OWNER: "true" },
            plugins: [
              cloudflareTest({
                wrangler: { configPath: "./wrangler.jsonc" },
                miniflare: {
                  bindings: {
                    ...testBindings,
                    TEST_MIGRATIONS: await readD1Migrations("migrations"),
                  },
                },
              }),
            ],
            test: { name: "worker", include: ["test/core/**/*.test.ts"] },
          },
          {
            test: {
              name: "repo",
              environment: "node",
              include: ["test/*.test.ts"],
              testTimeout: 60_000,
            },
          },
        ]
      : undefined,
  },
  lint: {
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["dist/**", "worker-configuration.d.ts"],
    jsPlugins: ["./lint/no-comments.ts"],
    rules: {
      "os/no-comments": "error",
    },
  },
  fmt: {
    ignorePatterns: ["dist/**", "worker-configuration.d.ts"],
  },
}));
