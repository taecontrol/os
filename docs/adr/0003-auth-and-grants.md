# ADR-0003: Cloudflare Access for the owner, scoped agent connections, and unified deny-by-default grants

Date: 2026-11-27
Status: Accepted

## Context

OS serves a single owner from their own Cloudflare account (issue #2). A small shared core holds identity, permissions, the audit log, approvals, and notifications, while optional modules such as Memory, Secrets, and Google accounts can be turned on or off without setup outside OS (issue #3).

The owner uses OS through a mobile-first PWA on their phone to review agent activity, approve waiting actions, and receive push notifications, with a cold-open budget under 1 second on a 4G network. Agents connect from different kinds of clients: hosted MCP clients (such as Claude and ChatGPT), local MCP clients (such as Claude Code and Codex), headless scripts, and future local runners for Secrets, where secret values must never enter a model's context.

OS replaces two earlier single-owner Cloudflare systems, and both exposed real limits:

- **Nook** protected the owner with Cloudflare Access and enabled Managed OAuth so owner MCP clients could sign in without Nook running an OAuth server. That gave those MCP clients the owner's own Access identity, which meant an agent able to read its client's stored token could approve its own requests or reveal secrets. Nook also made hierarchical buckets the platform-wide authorization unit, which does not fit non-hierarchical resources such as connected Google accounts or installation-wide actions such as sending a notification.
- **google-accounts-mcp** turned Managed OAuth off and gave every agent an explicit, deny-by-default connection with per-tool settings of not allowed, ask first, and allowed. That closed the privilege-escalation gap, but accepting only OAuth 2.1 from a fixed allowlist of three clients excluded local CLIs, headless scripts, and unlisted MCP clients. Its permissions were also bound directly to Google accounts.

OS needs one authentication and permission design across core and every module. The first end-to-end flow requires a grant that lets an agent send the owner a phone notification (issue #6), and the same model must cover Memory (issue #7), Secrets, Google accounts, and later modules. When two designs are both valid, OS chooses the one that grants less by default and fails closed.

## Decision

### Owner sign-in

The owner signs in to the OS PWA through a Cloudflare Access self-hosted application that protects the OS hostname and allows only the owner's configured email. Managed OAuth stays off so no agent ever holds an owner Access identity.

A second Access Bypass application exposes only OS's fixed non-browser agent routes (MCP, OAuth discovery and token exchange, and direct agent API routes). Because these routes belong to the shared core, turning a module on or off never requires changing Access configuration.

The Worker enforces defense in depth on every request:

- Every owner route cryptographically verifies the forwarded Access JWT against the configured issuer, audience, signing keys, time window, and owner email.
- Owner routes never accept agent credentials, and agent routes never accept Access assertions.
- On the first verified owner request, OS pins the single owner email and a monotonic owner generation in server state. Every owner action, connection, grant, and approval binds to that pinned owner and generation. If the configured owner email stops matching the pinned owner, the entire installation fails closed until an explicit owner reset increments the generation and invalidates prior connections, grants, and approvals.
- A synthetic local owner may exist only in explicit local development or test mode and never in production.

### Agent connections

Every agent authenticates as an owner-approved **connection**, never as the owner. Each connection has an owner-chosen name, a server-enforced expiration (bounded by default, absolute or idle), live revocation state, and last-used tracking. Every new connection starts with no grants unless the owner explicitly selects grants during creation or consent, with nothing preselected.

Two credential flows issue credentials for the same connection:

- **OS-issued bearer tokens** cover local MCP clients, headless agents, custom tools, and future local runners such as a Secrets CLI. OS issues a token only after the owner approves the connection in the PWA (either directly in the PWA or through a browser-approved device flow), shows the raw token once, and stores only its cryptographic hash. The owner can rotate or revoke a token immediately.
- **MCP OAuth 2.1** (Authorization Code with PKCE, Protected Resource Metadata, and Resource Indicators) covers interactive and hosted MCP clients. The consent page sits behind Cloudflare Access so only the owner can approve a connection. Access tokens are short-lived and refresh tokens rotate. Before fetching any external client metadata document on unauthenticated OAuth endpoints, OS screens the client identifier against an explicit allowlist so unauthenticated requests cannot trigger outbound fetches to arbitrary hosts.

Both flows resolve to the same connection record, and OS checks that record's live state in server storage on every request. Revocation and expiration take effect on the next call, even before an access token's short lifetime ends.

### Unified grants, approvals, and audit

One grant model covers core and every module. Each grant binds a connection, a namespaced capability (such as sending a notification, reading memories, using a secret, or sending email), a scope, and a mode (`allow`, `ask`, or `deny`).

Each capability declares the scope shape it accepts: installation-wide (such as sending the owner a notification in issue #6), an exact resource identifier (such as a connected Google account or a single secret), or a hierarchical prefix (such as a bucket subtree or an explicit wildcard over a module's resources). Core matches grants strictly against the requested target and never widens a grant implicitly to ancestor or sibling resources.

Grant evaluation fails closed and picks the strictest matching rule:

- If no grant matches a required capability and target, or if the capability's module is turned off, the result is `deny`. Newly added capabilities and newly enabled modules stay denied for every existing connection until the owner grants them.
- If an action touches several capabilities or resources, every required check must pass.
- When multiple grants match the same target (for example, `allow` on a subtree and `ask` or `deny` on a narrower path inside it), the strictest mode wins (`deny` beats `ask`, and `ask` beats `allow`). Adding a restrictive rule always tightens access.

Tool discovery follows least disclosure. A connection sees only tools for enabled capabilities where it holds at least one `allow` or `ask` grant. Direct calls to unadvertised tools still pass through the authorization gate and fail closed.

Every agent call passes through one core authorization and audit gate before any module handler runs. The gate authenticates the live connection, evaluates all required grants, and writes an audit entry for every attempt (allowed, pending approval, denied, or failed). If OS cannot read authorization state or write the audit entry, the gate refuses execution. Audit entries store only server-verified connection identity, capability, target identifiers, timestamps, and outcomes, never secret values. Client-supplied metadata such as agent session IDs or stated purposes may be stored only as unverified audit annotations and never affect authorization or approval scope.

When a call resolves to `ask`, the core gate does not run the action and does not hold the HTTP request open. It freezes the validated request as a time-limited pending approval in the shared inbox, notifies the owner, and immediately returns a pending response with the approval reference. Each approval is single-use and bound to that exact request. When the owner approves it in the PWA, OS verifies again that the connection, module, and grant still permit the action before executing. Revoking the connection, turning off the module, removing the target resource, or changing the grant to `deny` invalidates waiting approvals immediately.

## Consequences

### Benefits

- OS keeps login, MFA, identity-provider integration, brute-force protection, and account recovery out of its small shared core, while enforcing two independent fail-closed checks (Cloudflare Access at the edge and cryptographic verification plus owner pinning in the Worker).
- No agent credential can impersonate the owner, change grants, or approve its own waiting requests.
- One connection model, one grant evaluator, one approval inbox, and one audit log cover core notifications (issue #6), Memory (issue #7), Secrets, Google accounts, and future modules. Turning a module on or off needs no Access changes.
- Supporting both OS-issued bearer tokens and MCP OAuth 2.1 behind one connection principal lets issue #6 work immediately with any local or custom agent while remaining compatible with hosted MCP clients that require OAuth 2.1.
- Strictest-wins evaluation makes narrowing rules safe: adding an `ask` or `deny` rule on a sensitive resource cannot be bypassed by a broader `allow`.

### Costs and responsibilities

- Each self-hosted installation must enable Cloudflare Zero Trust (which requires a payment method on file even on its Free plan), configure an identity provider, maintain two Access applications (whole-hostname Allow and agent-route Bypass), and set Access secrets on the Worker. A misconfigured Bypass still fails closed at the Worker for owner APIs, but would expose static PWA assets and needs deployment checks to catch.
- Running a mobile-first PWA behind Cloudflare Access imposes client constraints that issue #6 must verify on real iOS and Android devices. The web manifest must send credentials (`crossorigin="use-credentials"`), the service worker must not mask Access login redirects as offline cache hits, and the Access session policy should avoid IP binding so switching between Wi-Fi and cellular does not break the session. Because iOS standalone PWAs isolate cookies from Safari, the first sign-in inside the installed app and any re-authentication after session expiry cross origin to the Access login domain.
- Core owns bearer-token storage and rotation alongside an OAuth 2.1 server with a screened client allowlist. Both paths resolve to the same connection lookup before authorization runs.
- Checking live connection state, grants, and audit writes on every agent call adds database reads and writes per request in exchange for immediate revocation and guaranteed auditing.
- Omitting implicit ancestor reads on hierarchical scopes means an owner who wants a project agent to read shared context (such as a shared `me` bucket) must grant that scope explicitly.
- An agent that controls a browser where the owner is signed in can still act with the owner's session; Cloudflare Access cannot distinguish automated browser clicks from the owner.

### Open uncertainty

Real-device iOS and Android standalone PWA behavior behind Cloudflare Access (cold open, session expiry, and opening push notifications) has not been tested on OS yet and must be proven in issue #6. If Access proves too disruptive for installed mobile PWAs, owner sign-in can move to OS-native passkeys in a superseding ADR without changing the agent connection, grant, approval, or audit model.

## Alternatives considered

- **OS-native passkeys (WebAuthn) and OS-managed sessions for the owner.** Removes Cloudflare Zero Trust setup and the two Access applications, and allows native biometric sign-in inside an installed mobile PWA without cross-origin redirects. Rejected for now because it puts passkey verification, challenge storage, session rotation and revocation, login rate limiting, first-install bootstrapping, and lost-device account recovery into OS's small shared core, and exposes the PWA shell and login endpoints directly to the public internet. Remains the main fallback if real-device testing in issue #6 shows Access friction is too high.
- **Cloudflare Access Managed OAuth for owner MCP clients (Nook's pattern).** Avoids running an OAuth server in OS, but issues agents the owner's own Access identity. Rejected because an agent that reads its client's token can approve its own requests, edit grants, or reveal secrets.
- **MCP OAuth 2.1 only for agents (google-accounts-mcp's pattern).** Keeps a single agent credential flow, but excludes local CLIs needed to keep secret values out of model context, headless scripts, and MCP clients outside the metadata allowlist.
- **OS-issued bearer tokens only for agents.** Simplest server code with no OAuth endpoints, but incompatible with hosted MCP clients such as Claude and ChatGPT that require standard MCP OAuth 2.1 discovery and authorization flows.
- **Cloudflare Access service tokens per agent.** Delegates agent credentials to Access, but requires manual creation and revocation outside OS, breaking OS's single-product control model.
- **Module-owned permission tables or platform-wide buckets.** Module-specific permission tables fragment the permission model and risk inconsistent fail-closed or audit enforcement. Forcing hierarchical buckets onto every module does not fit installation-wide capabilities like notifications or account-scoped modules like Google accounts.
- **Most-specific-scope-wins precedence or implicit ancestor reads.** Letting a narrower `allow` override a broader `ask` or `deny` makes locking down a connection error-prone, and implicit ancestor reads expose data the owner did not select. Strictest-wins evaluation with explicit grants gives agents less access by default.

## References

- [AGENTS.md](../../AGENTS.md)
- [Issue #4: Decide how the owner signs in, agents connect, and grants work](https://github.com/taecontrol/os/issues/4)
- [Issue #6: An agent can send the owner a notification on their phone](https://github.com/taecontrol/os/issues/6)
- [Nook ADR-0002: Hierarchical buckets as the authorization boundary for every tool](https://github.com/taecontrol/nook/blob/main/docs/adrs/0002-buckets-as-the-authorization-boundary.md)
- [Nook ADR-0003: Cloudflare Access for the owner and Nook-issued tokens for machines](https://github.com/taecontrol/nook/blob/main/docs/adrs/0003-cloudflare-access-for-the-owner-and-nook-tokens-for-machines.md)
- [Nook ADR-0010: Accept Nook tokens only under `/api/machine/*`](https://github.com/taecontrol/nook/blob/main/docs/adrs/0010-machine-tokens-only-under-the-machine-api-prefix.md)
- [Nook ADR-0019: Agent session claims are unverified audit annotations](https://github.com/taecontrol/nook/blob/main/docs/adrs/0019-agent-session-claims-are-unverified-audit-annotations.md)
- [Nook ADR-0020: Machine access can expire at an owner-chosen date, enforced in D1](https://github.com/taecontrol/nook/blob/main/docs/adrs/0020-machine-access-expires-at-an-owner-chosen-date-enforced-in-d1.md)
- [Nook ADR-0021: Owner approval is decided by the values call and remembered per machine](https://github.com/taecontrol/nook/blob/main/docs/adrs/0021-owner-approval-is-decided-by-the-values-call-and-remembered-per-machine.md)
- [Nook ADR-0022: `nook run` returns the approval link at once and waits only when resumed](https://github.com/taecontrol/nook/blob/main/docs/adrs/0022-nook-run-returns-the-approval-link-at-once-and-waits-only-when-resumed.md)
- [google-accounts-mcp README](https://github.com/taecontrol/google-accounts-mcp/blob/main/README.md)
- [google-accounts-mcp ADR-0002: Screen token clients before provider fetches](https://github.com/taecontrol/google-accounts-mcp/blob/main/docs/adr/0002-screen-token-clients-before-provider-fetches.md)
