# ADR-0002: Run each module as a private Cloudflare Worker behind OS Core

Date: 2026-11-27
Status: Accepted

## Context

OS runs on Cloudflare in each owner's own account, as settled in [ADR-0001](0001-run-on-cloudflare.md). Every capability area, starting with Memory, Secrets, and Google accounts, is a module around a small shared core that owns identity, permissions, the audit log, approvals, and notifications.

Modules have different infrastructure footprints. Memory needs D1, R2, Vectorize, Workers AI, and Cron Triggers, while Google accounts need D1, KV, Cron Triggers, and Google OAuth credentials. An owner who installs only OS Core or a subset of modules should not provision bindings or credentials for modules they did not install.

At the same time, OS must feel like one product and fail closed on every agent action. Every agent request must be authorized against the owner's grant and recorded in the audit log before it touches module state. On mobile, the PWA must show its first screen within 1 s on a 4G network and navigate after intent in under 100 ms.

Modules also have two distinct needs that conflict when collapsed into one mechanism. Some modules require external setup outside OS, such as creating a Google Cloud OAuth project, so installing a module is an infrastructure step. Once a module is installed, the owner needs an immediate switch inside the PWA to cut off agent access without waiting for a deployment or losing access to their stored data.

## Decision

Run OS as one Core Worker, `os-core`, and one private Cloudflare Worker per installed module, such as `os-memory`, `os-secrets`, and `os-google`. Serve all module interfaces from one PWA build, and separate infrastructure installation from runtime toggling.

The owner settled this architecture on 2026-11-27.

### Private Module Workers behind OS Core

- `os-core` connects to each installed Module Worker through Cloudflare Service Bindings using `WorkerEntrypoint` RPC and HTTP forwarding. On Cloudflare, Service Bindings add no extra per-request billing and zero network latency between Workers.
- Module Workers have no public URL or routes and disable `workers.dev`. Every external request enters `os-core` first, including agent MCP requests, PWA API calls, and third-party OAuth callbacks such as `/modules/google/callback`.
- Each Module Worker owns only its own Cloudflare bindings, storage, Cron Triggers, and external credentials. Installing `os-core` provisions only Core resources, and uninstalled modules provision zero bindings in the owner's Cloudflare account.
- Because `os-core` and each Module Worker own separate D1 databases with no cross-D1 SQL transaction, `os-core` is the fail-closed gatekeeper. Before invoking a Module Worker, `os-core` verifies authentication, checks that the module is enabled, checks grants and approvals, and writes an audit entry to Core's D1. After the call returns, `os-core` updates that audit entry with the outcome. If `os-core` cannot read authorization state or write the audit entry, it never calls the Module Worker.
- Module Cron Triggers call `os-core` over a Service Binding RPC to check whether the module is enabled before doing work. If the module is off or `os-core` cannot confirm that it is enabled, the Cron Trigger exits without running module work.

### Single PWA build with lazy-loaded module chunks

- `os-core` serves one PWA build with lazy-loaded chunks per installed module.
- All modules share one `ui-sdk`, one router, and one query cache so the PWA meets the 1 s cold-open and 100 ms navigation targets on mobile.

### Separate installation from runtime toggling

- **Install and uninstall.** Adding or removing a module is an infrastructure operation that deploys or tears down the Module Worker and its Cloudflare bindings and updates `os-core` Service Bindings and the PWA build. The repository ships agent-ready installation instructions and deterministic tooling so the owner's AI agent handles installing OS and adding modules. The agent asks the owner only for what it cannot obtain alone, such as Cloudflare sign-in or external provider setup like a Google Cloud OAuth project.
- **Enable and disable.** Turning an installed module on or off is a runtime toggle in the PWA stored in Core's D1, with no Worker deployment or teardown.
- **Turning a module off.** Disabling a module cuts all agent access immediately. In one atomic transaction in Core's D1, `os-core` marks the module disabled, cancels its pending approvals, and revokes all agent grants scoped to that module. `os-core` removes the module's tools from MCP discovery, rejects direct agent calls to the module and records those denials in the audit log, and tells module Cron Triggers not to run. The Module Worker, its database, its configuration, and its stored data stay intact so the owner can still open the PWA and read their data.
- **Turning a module on.** Re-enabling a module restores agent eligibility with zero agent grants. No agent can use the module until the owner grants access again.

This decision covers module packaging, core-to-module isolation, PWA delivery, and lifecycle boundaries. Owner sign-in, agent authentication, and the grant model belong to issue #4. Module storage schemas, RPC contracts, and Cloudflare plan-tier requirements belong to later specs.

## Consequences

- Each installed module stays isolated in its own Worker and bindings. A bug or secret inside one module cannot read another module's D1 database, KV namespace, R2 bucket, or external credentials directly.
- Owners provision and pay for only the Cloudflare resources required by `os-core` and the modules they install.
- Disabling a module from the PWA stops agent access and module Cron Triggers immediately while preserving the owner's data and read access in the PWA. Re-enabling fails closed because previously revoked grants do not return automatically.
- Because `os-core` and each Module Worker use separate D1 databases, `os-core` cannot wrap an authorization or audit write and a module data write in a single SQL transaction. If a Module Worker fails or times out after partial work, `os-core` records the failed or indeterminate outcome in its audit log without rolling back module storage.
- Installing or uninstalling a module requires redeploying `os-core` to update its Service Bindings and PWA bundle. Runtime enable and disable avoid redeployment, while adding a new module still goes through the agent-guided install flow.
- Every module must expose its backend capabilities through the Service Binding contract and its UI as lazy-loaded chunks in the shared PWA build, rather than running as an independent public web app.
- Whether every installation requires the Cloudflare Workers Paid plan or whether plan requirements depend on installed modules remains open from [ADR-0001](0001-run-on-cloudflare.md). Each module design must state its Cloudflare service and plan requirements.

## Alternatives considered

- **Single monolithic Worker for Core and all modules.** Avoids Service Bindings, multi-Worker deployments, and cross-D1 transaction boundaries, but forces every installation to carry bindings, secrets, and bundle code for modules the owner never installed. That weakens isolation between modules and provisions unused resources in the owner's Cloudflare account.
- **Build-time-only module toggles.** Removes runtime toggle state from Core's D1 and simplifies Cron gating, but cannot stop agent access to a module from the owner's phone without a deployment. Turning a module off by tearing it down would also remove the owner's PWA access to stored data.
- **Micro-frontends served per module.** Decouples module UI deployments from `os-core`, but adds separate frontend runtimes and network overhead, complicates sharing `ui-sdk`, routing, and the query cache, and works against the 1 s cold-open and 100 ms navigation targets on mobile.

## References

- [Issue #3: Decide how modules are built and turned on or off](https://github.com/taecontrol/os/issues/3)
- [ADR-0001: Run OS on Cloudflare](0001-run-on-cloudflare.md)
- [OS agent instructions](../../AGENTS.md)
