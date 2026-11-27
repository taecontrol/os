import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { makeAccessIdentity } from "../../src/core/access.ts";
import { makeCore } from "../../src/core/core.ts";

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey & { readonly kid: string };
}

const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export const makeKey = async (
  kid: string,
  algorithm: "RSASSA-PKCS1-v1_5" | "RSA-PSS" = "RSASSA-PKCS1-v1_5",
): Promise<SigningKey> => {
  const pair = (await crypto.subtle.generateKey({ name: algorithm, ...rsa }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const { n, e } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const alg = algorithm === "RSA-PSS" ? {} : { alg: "RS256" };
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n, e, kid, use: "sig", ...alg } };
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encodeJson = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export const claims = (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: env.ACCESS_ISSUER,
    aud: [env.ACCESS_AUDIENCE],
    exp: now + 600,
    nbf: now - 10,
    iat: now,
    email: env.OWNER_EMAIL,
    ...overrides,
  };
};

export const signedBy = async (
  key: SigningKey,
  overrides: Record<string, unknown> = {},
  alg: "RS256" | "PS256" = "RS256",
) => {
  const input = `${encodeJson({ alg, kid: key.kid, typ: "JWT" })}.${encodeJson(claims(overrides))}`;
  const algorithm = alg === "PS256" ? { name: "RSA-PSS", saltLength: 32 } : "RSASSA-PKCS1-v1_5";
  const signature = await crypto.subtle.sign(
    algorithm,
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return { "cf-access-jwt-assertion": `${input}.${base64url(new Uint8Array(signature))}` };
};

export const keySet = (keys: ReadonlyArray<SigningKey>) =>
  Response.json({ keys: keys.map((key) => key.jwk) });

export const failedKeySet = () => new Response("unavailable", { status: 500 });

const certificatesUrl = `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`;

export interface RequestOptions {
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly env?: Partial<Record<keyof Env, unknown>>;
}

export const ownerRow = () =>
  env.DB.prepare("SELECT generation, email FROM owner WHERE id = 1").first();

export const install = async (keys: ReadonlyArray<SigningKey>) => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  let respond = async () => keySet(keys);
  let certificateFetches = 0;
  let databaseReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const { url } = new Request(input);
    if (url !== certificatesUrl) throw new Error(`unexpected fetch of ${url}`);
    certificateFetches += 1;
    return respond();
  });
  const countingDb = new Proxy(env.DB, {
    get: (db, property) =>
      property === "prepare"
        ? (statement: string) => {
            databaseReads += 1;
            return db.prepare(statement);
          }
        : Reflect.get(db, property),
  });
  const core = makeCore(makeAccessIdentity());
  return {
    request: (path: string, options: RequestOptions = {}) =>
      core(
        new Request(`https://os.example.com${path}`, {
          method: options.method ?? "GET",
          headers: options.headers ?? {},
        }),
        { ...env, DB: countingDb, ...options.env } as Env,
      ),
    serveKeySet: (next: () => Promise<Response>) => {
      respond = next;
    },
    certificateFetches: () => certificateFetches,
    databaseReads: () => databaseReads,
  };
};

export const answer = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as unknown,
});
