# Map

Where each area lives and how the areas connect. Decisions are in `docs/adr/`, terms in `docs/glossary.md`.

## Core

The `os-core` Worker owns owner sign-in, agent connections, capability grants, and the audit log.

- Requests enter at `src/core/worker.ts`. `src/core/core.ts` groups owner and machine routes and applies the identity checks in ADR-0003. `src/core/refusal.ts` maps errors to JSON responses.
- Owner identity: the contract in `src/core/identity.ts`; Access verification in `src/core/access.ts`; the local-only synthetic owner in `src/core/synthetic-owner.ts`, which the `SYNTHETIC_OWNER` flag in `vite.config.ts` keeps out of production builds.
- Owner state: `src/core/owner.ts`, `migrations/`, and the `owner:reset` scripts in `package.json`. New owner-bound tables follow ADR-0004.
- Connections and grants: `src/core/connections.ts` accepts a consent request, creates the connection at redemption, and checks whether a connection is live. `src/core/owner-api.ts` serves the owner HTTP API. `src/core/capabilities.ts` declares what agents can be granted.
- Agent calls and audit: `src/core/gate.ts` records the grant decision before running an action. `src/core/audit.ts` reads the audit log for the owner.
- Configuration: `wrangler.jsonc` declares the Worker, its D1 binding, and the required secrets; `src/core/config.ts` validates the secrets.
- Tests: `test/core/` runs in workerd; `test/*.test.ts` runs in Node (production build, owner reset, dev server, no-comments rule).

## Tooling

Vite+ in `vite.config.ts`, the no-comments rule in `lint/`, CI in `.github/workflows/ci.yml`.
