import { Effect } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { Unavailable } from "./refusal.ts";

export const readBearer = (authorization: string | null | undefined) => {
  const parts = authorization?.match(/^([A-Za-z]+) +(os_[A-Za-z0-9_-]{43})$/u);
  return parts?.[1]?.toLowerCase() === "bearer" ? parts[2] : undefined;
};

export const hashBearer = (token: string) =>
  Effect.tryPromise({
    try: async () =>
      Hex.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
      ),
    catch: () => new Unavailable(),
  });

export const issueBearer = Effect.gen(function* () {
  const token = `os_${Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
  const hash = yield* hashBearer(token);
  return { token, hash };
});
