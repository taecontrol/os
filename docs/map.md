# Map

Where each area lives and how the areas connect. Decisions are in `docs/adr/`, terms in `docs/glossary.md`.

## Core

The `os-core` Worker: owner sign-in, the owner and machine route groups, and the owner table.

- Requests enter at `src/core/worker.ts`; `src/core/core.ts` routes them and holds both gates, which follow ADR-0003. Refusals and the JSON answers they produce are in `src/core/refusal.ts`.
- Owner identity: the contract in `src/core/identity.ts`; Access verification in `src/core/access.ts`; the local-only synthetic owner in `src/core/synthetic-owner.ts`, which the `SYNTHETIC_OWNER` flag in `vite.config.ts` keeps out of production builds.
- Owner state: `src/core/owner.ts`, `migrations/`, and the `owner:reset` scripts in `package.json`. New owner-bound tables follow ADR-0004.
- Configuration: `wrangler.jsonc` declares the Worker, its D1 binding, and the required secrets; `src/core/config.ts` validates the secrets.
- Tests: `test/core/` runs in workerd; `test/*.test.ts` runs in Node (production build, owner reset, dev server, no-comments rule).

## Tooling

Vite+ in `vite.config.ts`, the no-comments rule in `lint/`, CI in `.github/workflows/ci.yml`.
