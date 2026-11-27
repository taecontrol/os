# ADR-0001: Run OS on Cloudflare

Date: 2026-11-27
Status: Accepted

## Context

OS is a public, single-owner product that replaces Nook and google-accounts-mcp. Anyone must be able to install OS in their own account, without multi-tenancy and without installation-specific values in code. OS also serves a mobile-first web app whose cold open must show its first screen within 1 s on a 4G phone network.

Later designs for modules, authentication, storage, and deployment depend on the hosting platform. That choice sets the server runtime, the managed services available to OS, the installation steps for new owners, and the operating cost.

Nook and google-accounts-mcp already run on Cloudflare in the owner's own account. google-accounts-mcp runs as a Cloudflare Worker with D1, KV, and Cron Triggers, requires the Workers Paid plan, and sizes its limits to that plan. Nook runs as a Cloudflare Worker with static single-page app assets, D1, R2, Vectorize, Workers AI, and Cron Triggers.

## Decision

Run OS on Cloudflare.

The owner settled this choice on 2026-11-27 for three reasons. Anyone can install OS in their own Cloudflare account. Operating cost stays low for a single-owner installation. Nook and google-accounts-mcp already run on Cloudflare, so OS uses the same Cloudflare account and hosting platform while those systems stay in production and OS replaces them one module at a time.

This decision covers the hosting platform only. How OS packages and toggles modules, how the owner and agents authenticate, which Cloudflare services OS adopts, and how deployments run belong to separate decisions.

## Consequences

- Each installation runs in its owner's Cloudflare account. Account IDs, hostnames, and provisioned resource IDs stay in configuration, never in code.
- Server code runs on the Cloudflare Workers runtime rather than a long-lived Node.js process. Code and dependencies must fit Workers CPU, memory, and request limits, use Web standard APIs or Workers Node.js compatibility APIs, and store persistent state outside worker memory.
- Core and modules can build directly on Cloudflare's managed services, such as Workers static assets, D1, KV, R2, Vectorize, Workers AI, and Cron Triggers, as later designs select them, without provisioning a second cloud provider.
- Moving OS off Cloudflare later will require replacing Workers runtime assumptions and any Cloudflare-specific services that core or modules adopt.
- The owner has not yet decided whether OS requires the Workers Paid plan for every installation, as google-accounts-mcp does, or whether plan requirements depend on enabled modules. Later designs must state their Cloudflare plan and limit assumptions explicitly.

## Alternatives considered

The owner did not benchmark other hosts because Nook and google-accounts-mcp already run on Cloudflare. Two broader alternatives remain the ones a future contributor is most likely to revisit.

- **Self-hosted Node.js server or container.** Avoids Workers runtime limits and provider lock-in, but requires each owner to provision and maintain a server, manage TLS, updates, and backups, and handle low-latency delivery for the mobile web app. It also raises operating cost and adds a second hosting model alongside Nook and google-accounts-mcp.
- **Provider-neutral hosting layer.** Keeps hosting portable across clouds, but adds abstraction cost for a single-owner product with no second target and gives up direct use of Cloudflare's managed services.

## References

- [Issue #2: Record that OS runs on Cloudflare](https://github.com/taecontrol/os/issues/2)
- [OS agent instructions](../../AGENTS.md)
- [google-accounts-mcp AGENTS.md](https://github.com/taecontrol/google-accounts-mcp/blob/main/AGENTS.md) and [wrangler.jsonc](https://github.com/taecontrol/google-accounts-mcp/blob/main/wrangler.jsonc)
- [Nook AGENTS.md](https://github.com/taecontrol/nook/blob/main/AGENTS.md) and [wrangler.jsonc](https://github.com/taecontrol/nook/blob/main/wrangler.jsonc)
