import { describe, expect, it, vi } from "vite-plus/test";
import {
  answer,
  failedKeySet,
  install,
  keySet,
  makeKey,
  signedBy,
  type SigningKey,
} from "./installation.ts";

const accessKey = await makeKey("access");
const rotatedKey = await makeKey("rotated");
const firstOnlyKey = await makeKey("first-only");
const lastOnlyKey = await makeKey("last-only");

const status = async (installation: Awaited<ReturnType<typeof install>>, key: SigningKey) =>
  (await installation.request("/api/owner", { headers: await signedBy(key) })).status;

const heldKeySets = (installation: Awaited<ReturnType<typeof install>>) => {
  const pending: Array<(response: Response) => void> = [];
  installation.serveKeySet(() => new Promise((resolve) => pending.push(resolve)));
  const started = async (count: number) => {
    while (pending.length < count) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  return { pending, started };
};

describe("the Access key set", () => {
  it("measures rotation, expiry, and retry from when each fetch finishes", async () => {
    const installation = await install([accessKey]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (time: number) => vi.setSystemTime(time);
    const finishingAt = (time: number, response: () => Response) => async () => {
      at(time);
      return response();
    };
    const start = Date.now();
    const fetched = start + 4_000;
    installation.serveKeySet(finishingAt(fetched, () => keySet([accessKey])));
    expect(await status(installation, accessKey)).toBe(200);
    expect(await status(installation, accessKey)).toBe(200);
    expect(installation.certificateFetches()).toBe(1);

    installation.serveKeySet(async () => keySet([accessKey, rotatedKey]));
    at(fetched + 29_999);
    expect(await status(installation, rotatedKey)).toBe(401);
    expect(installation.certificateFetches()).toBe(1);
    const refreshed = fetched + 30_000;
    at(refreshed);
    expect(await status(installation, rotatedKey)).toBe(200);
    expect(installation.certificateFetches()).toBe(2);

    at(refreshed + 599_999);
    expect(await status(installation, accessKey)).toBe(200);
    expect(installation.certificateFetches()).toBe(2);

    const failed = refreshed + 604_000;
    installation.serveKeySet(finishingAt(failed, failedKeySet));
    at(refreshed + 600_000);
    expect(
      await answer(
        await installation.request("/api/owner", { headers: await signedBy(accessKey) }),
      ),
    ).toEqual({
      status: 503,
      body: { error: "unavailable" },
    });
    expect(installation.certificateFetches()).toBe(3);

    installation.serveKeySet(async () => keySet([accessKey]));
    at(failed + 29_999);
    expect(await status(installation, accessKey)).toBe(503);
    expect(installation.certificateFetches()).toBe(3);
    at(failed + 30_000);
    expect(await status(installation, accessKey)).toBe(200);
    expect(installation.certificateFetches()).toBe(4);
  });

  it.each([
    {
      order: "a success then a failure",
      first: () => keySet([accessKey]),
      last: failedKeySet,
      results: [200, 503],
    },
    {
      order: "a failure then a success",
      first: failedKeySet,
      last: () => keySet([accessKey]),
      results: [503, 200],
    },
  ])(
    "lets the last of two overlapping fetches decide after $order",
    async ({ first, last, results }) => {
      const installation = await install([accessKey]);
      const { pending, started } = heldKeySets(installation);
      const firstRead = status(installation, accessKey);
      await started(1);
      const lastRead = status(installation, accessKey);
      await started(2);

      pending[0]?.(first());
      expect(await firstRead).toBe(results[0]);
      pending[1]?.(last());
      expect(await lastRead).toBe(results[1]);

      expect(await status(installation, accessKey)).toBe(results[1]);
      expect(installation.certificateFetches()).toBe(2);
    },
  );

  it.each([
    { finishingFirst: 0, label: "the earlier request's fetch" },
    { finishingFirst: 1, label: "the later request's fetch" },
  ])(
    "keeps the key set that finishes last when $label finishes first",
    async ({ finishingFirst }) => {
      const installation = await install([accessKey]);
      vi.useFakeTimers({ toFake: ["Date"] });
      const { pending, started } = heldKeySets(installation);
      const reads = [status(installation, accessKey)];
      await started(1);
      reads.push(status(installation, accessKey));
      await started(2);

      pending[finishingFirst]?.(keySet([accessKey, firstOnlyKey]));
      expect(await reads[finishingFirst]).toBe(200);
      pending[1 - finishingFirst]?.(keySet([accessKey, lastOnlyKey]));
      expect(await reads[1 - finishingFirst]).toBe(200);

      const finished = Date.now();
      installation.serveKeySet(async () => keySet([accessKey, firstOnlyKey, lastOnlyKey]));
      expect(await status(installation, lastOnlyKey)).toBe(200);
      vi.setSystemTime(finished + 29_999);
      expect(await status(installation, firstOnlyKey)).toBe(401);
      expect(installation.certificateFetches()).toBe(2);
      vi.setSystemTime(finished + 30_000);
      expect(await status(installation, firstOnlyKey)).toBe(200);
      expect(installation.certificateFetches()).toBe(3);
    },
  );
});
