import { describe, expect, it } from "vite-plus/test";
import { answer, install, makeKey, signedBy } from "./installation.ts";

const accessKey = await makeKey("access");
const owner = await signedBy(accessKey);

const notFound = { status: 404, body: { error: "not_found" } };
const agentCredential = { status: 400, body: { error: "agent_credential_rejected" } };
const accessAssertion = { status: 400, body: { error: "access_assertion_rejected" } };
const unauthenticated = { status: 401, body: { error: "unauthenticated" } };
const invalidToken = { status: 401, body: { error: "invalid_token" } };
const invalidClient = { status: 401, body: { error: "invalid_client" } };

const machinePaths = [
  ["/mcp", invalidToken],
  ["/mcp/x", invalidToken],
  ["/oauth/token", invalidClient],
  ["/oauth/token/x", notFound],
  ["/.well-known/oauth-protected-resource", notFound],
  ["/agent/x", notFound],
] as const;

interface Row {
  readonly path: string;
  readonly method?: string;
  readonly headers: Record<string, string>;
  readonly expected: object;
  readonly reads?: number;
}

const rows: ReadonlyArray<Row> = [
  {
    path: "/api/owner",
    headers: { ...owner, authorization: "" },
    expected: agentCredential,
    reads: 0,
  },
  {
    path: "/api/owner",
    headers: { ...owner, authorization: "Bearer agent" },
    expected: agentCredential,
    reads: 0,
  },
  {
    path: "/api/owner",
    headers: owner,
    expected: { status: 200, body: { email: "owner@example.com" } },
  },
  ...machinePaths.flatMap(([path, anonymous]): ReadonlyArray<Row> => [
    { path, headers: { "cf-access-jwt-assertion": "" }, expected: accessAssertion, reads: 0 },
    { path, method: "POST", headers: owner, expected: accessAssertion, reads: 0 },
    { path, headers: {}, expected: anonymous, reads: 1 },
  ]),
  { path: "/.well-known", headers: owner, expected: notFound, reads: 0 },
  { path: "/agent", headers: owner, expected: notFound, reads: 0 },
  { path: "/mcpx", headers: owner, expected: notFound, reads: 0 },
  { path: "/api/unknown", headers: {}, expected: unauthenticated, reads: 0 },
  { path: "/api/unknown", method: "POST", headers: {}, expected: unauthenticated, reads: 0 },
  { path: "/api/unknown", method: "POST", headers: owner, expected: notFound },
];

describe("route groups", () => {
  it("refuse the credential the path does not take", async () => {
    const installation = await install([accessKey]);
    for (const { path, method = "GET", headers, expected, reads } of rows) {
      const before = {
        reads: installation.databaseReads(),
        fetches: installation.certificateFetches(),
      };
      const response = await answer(await installation.request(path, { method, headers }));
      expect({ path, method, headers, ...response }).toEqual({
        path,
        method,
        headers,
        ...expected,
      });
      if (reads !== undefined) {
        expect({ path, method, reads: installation.databaseReads() - before.reads }).toEqual({
          path,
          method,
          reads,
        });
      }
      if (reads === 0) expect(installation.certificateFetches()).toBe(before.fetches);
    }
  });
});
