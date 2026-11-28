import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import {
  answer,
  base64url,
  claudeCode,
  type Installation,
  install,
  installationOrigin,
  makeKey,
  signedBy,
} from "./installation.ts";

const accessKey = await makeKey("access");
const owner = await signedBy(accessKey);

const minute = 60_000;
const day = 86_400_000;
const callback = "http://localhost:51234/callback";
const state = "client-state";
const formEncoded = { "content-type": "application/x-www-form-urlencoded" };
const approval = {
  decision: "allow",
  name: "Claude Code on laptop",
  grants: [{ capability: "notifications.send", mode: "allow" }],
} as const;

const form = (fields: Record<string, string>, clientIds: ReadonlyArray<string> = [claudeCode]) => {
  const params = new URLSearchParams(fields);
  for (const clientId of clientIds) params.append("client_id", clientId);
  return params.toString();
};

const pkce = async () => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
};

const authorizePath = (challenge: string, clientIds: ReadonlyArray<string>, origin: string) =>
  `/authorize?${form(
    {
      response_type: "code",
      redirect_uri: callback,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: `${origin}/mcp`,
    },
    clientIds,
  )}`;

const startSignIn = async (installation: Installation, origin = installationOrigin) => {
  const { verifier, challenge } = await pkce();
  const response = await installation.request(authorizePath(challenge, [claudeCode], origin), {
    headers: owner,
    origin,
  });
  const location = response.headers.get("location") ?? "";
  const id = /^\/consent\/([0-9a-f]+)$/u.exec(location)?.[1];
  if (id === undefined) throw new Error(`authorize answered ${response.status} ${location}`);
  return { id, verifier, origin };
};

type Consent = Awaited<ReturnType<typeof startSignIn>>;

const approve = async (installation: Installation, consent: Consent, origin = consent.origin) => {
  const response = await installation.request(`/api/consent/${consent.id}`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify(approval),
    origin,
  });
  expect(response.status).toBe(200);
  return new URL(((await response.json()) as { redirectUrl: string }).redirectUrl).searchParams;
};

const tokenRequest = (
  installation: Installation,
  fields: Record<string, string>,
  origin = installationOrigin,
) =>
  installation.request("/oauth/token", {
    method: "POST",
    headers: formEncoded,
    body: form({ ...fields, resource: `${origin}/mcp` }),
    origin,
  });

const redeem = (installation: Installation, consent: Consent, code: string | null) =>
  tokenRequest(
    installation,
    {
      grant_type: "authorization_code",
      code: code ?? "",
      code_verifier: consent.verifier,
      redirect_uri: callback,
    },
    consent.origin,
  );

const refresh = (installation: Installation, refreshToken: string) =>
  tokenRequest(installation, { grant_type: "refresh_token", refresh_token: refreshToken });

const issuedTokens = async (response: Response) => {
  expect(response.status).toBe(200);
  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
};

const tokenOutcome = async (response: Response) => ({
  status: response.status,
  error: ((await response.json()) as { error?: string }).error,
});

const callMcp = (installation: Installation, accessToken: string) =>
  installation.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });

const connections = async (installation: Installation, headers = owner) =>
  (await (await installation.request("/api/connections", { headers })).json()) as ReadonlyArray<{
    readonly id: string;
    readonly expiresAt: number;
  }>;

it("completes an approval sent through another address with the issuer where sign-in began", async () => {
  const installation = await install([accessKey]);
  const started = "http://127.0.0.1:9417";
  const consent = await startSignIn(installation, started);

  const redirect = await approve(installation, consent, "http://127.0.0.2:9417");
  expect({
    state: redirect.get("state"),
    issuer: redirect.get("iss"),
    hasCode: redirect.has("code"),
  }).toEqual({ state, issuer: started, hasCode: true });

  expect(await connections(installation)).toEqual([]);
  await issuedTokens(await redeem(installation, consent, redirect.get("code")));
  expect(await connections(installation)).toEqual([
    expect.objectContaining({ name: approval.name, status: "active", grants: approval.grants }),
  ]);
});

it("tells a client that follows discovery from /mcp to authenticate as a public client", async () => {
  const installation = await install([accessKey]);
  const read = async (url: URL) =>
    (await (await installation.request(url.pathname, { origin: url.origin })).json()) as Record<
      string,
      unknown
    >;
  const challenge = (await installation.request("/mcp")).headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/u.exec(challenge)?.[1] ?? "";
  const [issuer] = (await read(new URL(metadataUrl))).authorization_servers as Array<string>;

  const discovery = await read(new URL("/.well-known/oauth-authorization-server", issuer));
  expect({
    authentication: discovery.token_endpoint_auth_methods_supported,
    signing: discovery.token_endpoint_auth_signing_alg_values_supported,
    registration: discovery.registration_endpoint,
  }).toEqual({ authentication: ["none"], signing: undefined, registration: undefined });
});

it("refuses an unapproved client on both OAuth routes before looking up a client document", async () => {
  const installation = await install([accessKey]);
  const { challenge } = await pkce();
  const exchange = {
    grant_type: "authorization_code",
    code: "unissued",
    code_verifier: "v".repeat(43),
    redirect_uri: callback,
  };
  const authorize = async (clientIds: ReadonlyArray<string>) => {
    const path = authorizePath(challenge, clientIds, installationOrigin);
    const response = await installation.request(path, { headers: owner });
    return { status: response.status, location: response.headers.get("location") };
  };
  const token = async (body: string, headers: Record<string, string> = formEncoded) =>
    tokenOutcome(await installation.request("/oauth/token", { method: "POST", headers, body }));
  const unapproved = [
    ["an unlisted document on an approved host", ["https://chatgpt.com/oauth/client.json"]],
    ["no client", []],
    ["the approved client twice", [claudeCode, claudeCode]],
  ] as const;
  const tokenRefusals: ReadonlyArray<readonly [string, string, Record<string, string>?]> = [
    ...unapproved.map(([label, clientIds]) => [label, form(exchange, clientIds)] as const),
    ["an Authorization header", form(exchange), { ...formEncoded, authorization: "Basic eDp5" }],
    [
      "a client assertion",
      form({
        ...exchange,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: "header.payload.signature",
      }),
    ],
    [
      "a JSON body",
      JSON.stringify({ ...exchange, client_id: claudeCode }),
      { "content-type": "application/json" },
    ],
  ];

  for (const [label, clientIds] of unapproved) {
    expect({ label, ...(await authorize(clientIds)) }).toEqual({
      label,
      status: 302,
      location: "/consent/refused?reason=client_not_allowed",
    });
  }
  for (const [label, body, headers] of tokenRefusals) {
    expect({ label, ...(await token(body, headers)) }).toEqual({
      label,
      status: 401,
      error: "invalid_client",
    });
  }
  expect([installation.metadataFetches(), installation.keyValueReads()]).toEqual([0, 0]);

  expect((await authorize([claudeCode])).location).toMatch(/^\/consent\/[0-9a-f]+$/u);
  expect(await token(form(exchange))).toEqual({ status: 400, error: "invalid_grant" });
  expect(installation.metadataFetches()).toBe(2);
  expect(installation.keyValueReads()).toBeGreaterThan(0);
});

it("keeps the connection's deadline on a late refresh and refuses its tokens once the owner revokes it", async ({
  onTestFinished,
}) => {
  const installation = await install([accessKey]);
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const deadline = Date.now() + 90 * day;
  const consent = await startSignIn(installation);
  const code = (await approve(installation, consent)).get("code");
  const { refresh_token } = await issuedTokens(await redeem(installation, consent, code));
  const [connection] = await connections(installation);
  expect(connection?.expiresAt).toBe(deadline);

  vi.setSystemTime(deadline - 30 * minute);
  const lateOwner = await signedBy(accessKey);
  const late = await issuedTokens(await refresh(installation, refresh_token));
  expect(late.expires_in).toBe(1800);
  expect(await connections(installation, lateOwner)).toEqual([
    expect.objectContaining({ id: connection?.id, expiresAt: deadline }),
  ]);
  expect(await answer(await callMcp(installation, late.access_token))).toEqual({
    status: 404,
    body: { error: "not_found" },
  });

  const revocation = `/api/connections/${connection?.id}/revoke`;
  const revoked = await installation.request(revocation, { method: "POST", headers: lateOwner });
  expect(revoked.status).toBe(200);
  const refused = await callMcp(installation, late.access_token);
  expect({ status: refused.status, challenge: refused.headers.get("www-authenticate") }).toEqual({
    status: 401,
    challenge: expect.stringContaining('error="invalid_token"'),
  });
  const audit = `/api/audit?connection=${connection?.id}`;
  expect(await (await installation.request(audit, { headers: lateOwner })).json()).toMatchObject({
    entries: [
      { connection: { id: connection?.id }, outcome: "denied", reason: "connection_revoked" },
    ],
  });
  expect(await tokenOutcome(await refresh(installation, late.refresh_token))).toEqual({
    status: 400,
    error: "invalid_grant",
  });
});

it("keeps the authorization code usable after a temporary failure to write the connection", async () => {
  const installation = await install([accessKey]);
  const consent = await startSignIn(installation);
  const code = (await approve(installation, consent)).get("code");
  await env.DB.prepare(`CREATE TRIGGER reject_connection_insert BEFORE INSERT ON connections
    BEGIN SELECT RAISE(ABORT, 'connection insert blocked by test'); END`).run();

  expect(await tokenOutcome(await redeem(installation, consent, code))).toEqual({
    status: 503,
    error: "temporarily_unavailable",
  });
  expect(await connections(installation)).toEqual([]);

  await env.DB.prepare("DROP TRIGGER reject_connection_insert").run();
  await issuedTokens(await redeem(installation, consent, code));
  expect(await connections(installation)).toEqual([
    expect.objectContaining({ name: approval.name, status: "active" }),
  ]);
});
