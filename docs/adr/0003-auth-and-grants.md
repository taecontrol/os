# ADR-0003: Authenticate the owner with Cloudflare Access and authorize agents through one core gate

Date: 2026-11-27
Status: Accepted

## Context

OS serves one owner and lets that owner's AI agents act across core capabilities and optional modules, starting with sending phone notifications in issue #6 and later replacing Nook and google-accounts-mcp. OS must authorize every agent action against the owner's grant, fail closed outside that grant, and record every attempt in one audit log. Secret values must never enter a model's context or any audit record.

Earlier work in Nook and google-accounts-mcp exposed four constraints that OS must resolve together:

- **Owner and agent identities must stay separate.** Nook enabled Cloudflare Access Managed OAuth so MCP clients could connect without an OAuth server in the Worker. Because Managed OAuth gives those clients the owner's Access identity, an agent that reads its client's stored token can approve its own requests or change owner settings.
- **Agents connect in two different ways.** Hosted and interactive MCP clients such as Claude, Claude Code, and ChatGPT expect OAuth 2.1, while local MCP clients, headless scripts, custom agents, and a future local CLI need direct bearer credentials.
- **Unauthenticated OAuth token endpoints create a server-side request forgery risk.** An OAuth provider that fetches Client ID Metadata Documents and signing keys from URLs supplied in unauthenticated `/oauth/token` requests lets callers trigger requests to arbitrary hosts.
- **Approvals cannot block Cloudflare Workers and cannot treat every action the same.** Holding requests open for human approval collides with worker and client timeouts, and repeatable secret uses need different approval lifetimes from irreversible actions such as sending email or permanent deletion.

OS needs one owner sign-in model, one agent connection model, and one grant, approval, and audit gate in Core before building modules or the first notification flow.

## Decision

The owner settled this architecture on 2026-11-27 across three parts: owner sign-in, agent connections, and a unified core grant, approval, and audit gate.

### Owner sign-in

Protect the OS hostname with a Cloudflare Access self-hosted application whose Allow policy permits only the owner's email address, with Managed OAuth turned off. Turning Managed OAuth off ensures no agent ever holds the owner's Access identity. Owners can configure Cloudflare Access native passkeys using WebAuthn, such as 1Password, Face ID, Touch ID, or hardware security keys, and independent MFA with hardware security keys directly in Zero Trust. That gives phishing-resistant sign-in and edge defense in depth without maintaining WebAuthn, session management, or account recovery code in OS Core.

Expose only Core's non-browser machine routes through one fixed Cloudflare Access Bypass application: `/mcp`, `/oauth/token`, `/.well-known/*`, and direct agent and CLI API routes. Because every bypassed route belongs to Core, installing, enabling, or disabling modules never requires changing Access rules.

Enforce defense in depth inside the Worker:

- Cryptographically verify `Cf-Access-Jwt-Assertion` on every owner route, checking the issuer, audience, JSON Web Key Set, time window, and normalized `OWNER_EMAIL`.
- Reject agent credentials on owner routes, and reject Access assertions on agent routes.
- Pin the single owner email and a monotonic owner generation in Core D1 on the first verified sign-in. Fail the installation closed on any mismatch until an explicit owner reset increments the generation and invalidates all prior connections, grants, and approvals.
- Allow a synthetic local owner only in explicit local development and test mode, never in production.

### Agent connections

Every agent authenticates as an owner-approved `Connection` record in Core D1. Each connection carries an owner-chosen name, a bounded expiration by default, live revocation state, and last-used tracking. A new connection starts with no grants unless the owner explicitly selects grants during creation or consent, with nothing preselected.

Core supports two credential flows that both resolve to the same `Connection` record in Core D1:

- **OS-issued bearer tokens.** This flow covers local MCP clients, headless scripts, custom agents, and the future local CLI, including secrets injection outside model context. The CLI binary name remains undecided. Core issues a bearer token only after the owner approves it in the PWA, either by direct creation or through a browser-approved device flow. Core shows the token once, stores only a cryptographic hash, and lets the owner rotate or revoke it immediately.
- **MCP OAuth 2.1 via `@cloudflare/workers-oauth-provider`.** This flow covers hosted and interactive MCP clients such as Claude, Claude Code, and ChatGPT. The `/authorize` consent screen sits behind Cloudflare Access so only the owner can approve a connection. The flow uses Authorization Code with PKCE, Protected Resource Metadata per RFC 9728, short-lived access tokens, and rotating refresh tokens. Before the provider fetches any external metadata or signing keys on `/oauth/token`, Core screens the client identifier against an explicit allowlist of known Client ID Metadata Document clients. Screening blocks unauthenticated server-side request forgery and open Dynamic Client Registration. Unlisted clients connect with OS-issued bearer tokens instead.

Core verifies the resolved `Connection` record live in Core D1 on every request, so revocation and expiration apply immediately on the next call.

### Unified grants, approvals, and audit

Core enforces one grant model across Core and every module, defined by connection, capability, scope, and mode, where mode is `allow`, `ask`, or `deny`.

- **Capability-declared scope shapes.** Each capability declares whether its scope is installation-wide, such as sending a phone notification for issue #6; an exact resource identifier, such as a connected Google account or a single secret; or a hierarchical prefix, such as a bucket subtree.
- **Explicit scopes only.** Hierarchical grants never imply ancestor reads. Granting `work/acme` never allows reading `work` or `me`. The owner must grant every readable or writable scope explicitly.
- **Fail-closed, strictest-wins evaluation.** Missing grants, newly added capabilities, and disabled modules resolve to `deny`. Multi-target actions require every check to pass. When overlapping grants match one request, `deny` overrides `ask`, and `ask` overrides `allow`. Least-disclosure MCP tool discovery advertises only tools for enabled modules with at least one `allow` or `ask` grant, and direct calls to unadvertised tools still fail closed.
- **One core authorization and audit gate.** Every agent call passes through Core before any module worker runs. Core writes an audit entry for every attempt, whether allowed, pending, denied, or failed. Each entry records the server-verified connection identity, capability, target IDs, timestamps, and outcome, and never records secret values. Core stores client-supplied session and purpose metadata only as an unverified audit annotation and never uses it to authorize requests or scope approvals. If Core cannot read authorization state or write the audit entry, Core refuses execution.
- **Non-blocking `ask` approvals with capability-declared timed approvals.** When an action resolves to `ask`, Core freezes the validated request as a time-limited pending approval in the shared inbox, notifies the owner on their phone, and returns the pending reference immediately without holding the Worker open. Each capability declares whether it allows timed, remembered approvals, such as once, 1 hour, or 12 hours for repeatable uses like secrets, while irreversible actions such as sending email or permanent deletion allow once only. Timed approvals apply strictly to the exact connection, capability, and exact scope or targets, and never widen the connection's grant. Core invalidates active timed approvals and waiting approvals immediately if the owner revokes the connection, turns off the module, removes the target resource, or changes the grant to `deny`.

## Consequences

- One identity boundary, one grant model, one approval inbox, and one audit gate cover Core and every module. Issue #6 uses this path directly without per-module auth code.
- Adding, enabling, or disabling modules requires no Cloudflare Access changes because all machine traffic enters through Core's fixed Bypass routes.
- Revoking a connection, turning off a module, removing a target resource, or changing a grant to `deny` takes effect on the next request and invalidates waiting and timed approvals immediately.
- Every installation requires configuring two Cloudflare Access self-hosted applications in the owner's Zero Trust organization, one protecting the hostname with Managed OAuth off and one Bypass application for Core's machine routes. A misconfigured Bypass rule weakens edge blocking, so JWT verification in the Worker and strict separation between owner and agent routes remain mandatory.
- Core owns bearer token issuance, hashing, rotation, and revocation, `@cloudflare/workers-oauth-provider` integration, and the Client ID Metadata Document allowlist. Supporting a new hosted OAuth client requires adding its identifier to the allowlist; unlisted clients must use OS-issued bearer tokens.
- Every agent request performs a live Core D1 read for connection and grant state and a Core D1 write for audit before any module worker runs. If Core cannot read or write Core D1, agent execution fails closed.
- Timed approvals apply to the connection, capability, and exact scope or targets rather than client-claimed session identifiers, so another agent using the same connection can reuse an active timed approval until it expires or is invalidated.
- An agent that controls a browser where the owner is signed in to Cloudflare Access can approve its own requests or edit grants, because OS cannot distinguish automated browser actions from the owner.
- Moving off Cloudflare Access or `@cloudflare/workers-oauth-provider` later will require replacing the owner assertion check and OAuth authorization server in Core.
- This decision requires a Cloudflare Zero Trust organization for Access, and does not by itself settle the Workers plan tier noted as open in ADR-0001. Exact D1 schemas, default expiration and approval timeouts, initial allowlist entries, and the local CLI binary name remain open for implementation designs.

## Alternatives considered

- **Cloudflare Access Managed OAuth for MCP clients.** Nook used Managed OAuth so MCP clients could authenticate without running an OAuth server in the Worker. OS rejects it because Managed OAuth hands the agent the owner's Access identity. That removes the boundary between owner approvals and agent credentials and prevents per-connection grants.
- **Self-hosted WebAuthn and session authentication in Core.** Removes the Zero Trust setup step for new installations, but moves passkey registration, session cookies, account recovery, and edge brute-force defense into Core.
- **Open Dynamic Client Registration or unscreened Client ID Metadata Document fetches.** Lets any hosted MCP client connect without maintaining an allowlist, but lets unauthenticated callers on `/oauth/token` trigger server-side requests to arbitrary hosts or register arbitrary clients. Unlisted clients remain supported through OS-issued bearer tokens.
- **Implicit ancestor reads on hierarchical scopes.** Nook allowed a grant on `work/acme` to read `work` and `me`. OS rejects implicit ancestor reads so granting a narrow subtree never exposes parent data without an explicit grant.
- **Blocking requests until the owner approves, or uniform timed approvals across all capabilities.** Holding a Worker or client command open for human approval hits runtime and tool timeouts, and allowing timed approvals on every capability would let one approval repeat irreversible actions such as sending email or permanent deletion.
- **Per-module authentication, grants, or Cloudflare Access rules.** Letting modules manage their own credentials or Access bypass paths would fragment permissions, break the shared inbox, and require Zero Trust edits whenever the owner toggles a module.

## References

- [Issue #4: Decide how the owner signs in, agents connect, and grants work](https://github.com/taecontrol/os/issues/4)
- [Issue #6: An agent can send the owner a notification on their phone](https://github.com/taecontrol/os/issues/6)
- [ADR-0001: Run OS on Cloudflare](0001-run-on-cloudflare.md)
- [OS agent instructions](../../AGENTS.md)
