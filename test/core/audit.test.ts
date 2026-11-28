import { env, exports as worker } from "cloudflare:workers";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { assert, expect, it } from "vite-plus/test";
import { notificationsSend } from "../../src/core/capabilities.ts";
import { OwnerApi } from "../../src/core/owner-contract.ts";
import { seedConnection } from "./connection-fixture.ts";
import { install } from "./installation.ts";

it("pages through audit entries with tied timestamps via the owner client", async () => {
  await install([]);
  const { id } = await seedConnection("Laptop");
  const timestamp = Date.now();
  const insert = env.DB.prepare(`INSERT INTO audit_entries
    (id, owner_generation, connection_id, capability, outcome, occurred_at, finished_at)
    SELECT ?1, owner_generation, id, ?2, 'succeeded', ?3, ?3 FROM connections WHERE id = ?4`);
  await env.DB.batch(
    ["audit-b", "audit-a", "audit-c"].map((entry) =>
      insert.bind(entry, notificationsSend.id, timestamp, id),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const { owner } = yield* HttpApiClient.make(OwnerApi, { baseUrl: "https://os.example.com" });
      const first = yield* owner.audit({ query: { limit: 2 } });
      expect(first.entries).toHaveLength(2);
      assert.isNotNull(first.nextCursor);
      const second = yield* owner.audit({ query: { limit: 2, cursor: first.nextCursor } });
      expect([...first.entries, ...second.entries].map(({ id }) => id)).toEqual([
        "audit-c",
        "audit-b",
        "audit-a",
      ]);
      expect(second.nextCursor).toBeNull();
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (url, init) => worker.default.fetch(url, init)),
    ),
  );
});
