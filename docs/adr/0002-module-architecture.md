# ADR-0002: Compile modules into one Worker and PWA with runtime toggles

Date: 2026-11-27
Status: Accepted

## Context

OS gives one owner's AI agents tools across separate life areas such as Memory, Secrets, and Google accounts. Each area is a module the owner can turn on or off around a small shared core: identity, permissions, the audit log, approvals, and notifications.

OS runs on Cloudflare in the owner's own account on one stack: TypeScript, Effect, Vite+, and ui-sdk. Four constraints shape how modules must work:

- Turning a module on must require no setup outside OS: no extra Cloudflare Workers, no new bindings or Wrangler secrets, no Cloudflare Access rule edits, and no redeploy.
- One permission model must span every module, and one inbox must hold agent activity and pending approvals.
- The mobile-first PWA must show its first screen within 1 s on a 4G network and navigate after intent in under 100 ms, even as OS adds more modules.
- Core must authorize every agent action against the owner's grant, fail closed outside it, record it in the audit log, and never expose secret values to a model's context.

Cloudflare Workers bind storage, AI, and Cron triggers statically at deploy time, and Cloudflare D1 supports atomic batches only within one database. In OS's predecessors, Nook compiled Memory and Vault directly into one Worker with no module boundary or toggle, while google-accounts-mcp required Google OAuth credentials as Wrangler Worker secrets at deploy time. OS needs a module boundary that isolates modules in code and runtime control without turning module setup into an infrastructure task.

## Decision

Package each module as an isolated workspace package compiled into OS's single Cloudflare Worker and single PWA build, and control whether each module is on or off through runtime state stored by core in D1.

### Packaging and Cloudflare resources

OS deploys as one Cloudflare Worker, one static-asset PWA bundle, one shared D1 database, and one Cron trigger. All built-in modules ship inside that deployment.

- **Static registration and one-way dependencies.** Core defines one module contract and holds a static registry of built-in modules. Modules depend only on core contracts and services. Modules never import each other, call each other, or query each other's tables, so turning any module on or off cannot break another.
- **Install-time bindings and unified migrations.** OS provisions the shared Cloudflare bindings that built-in modules require (such as D1, R2, Workers AI, or Vectorize) once during deployment, and applies all core and module D1 migrations in one ordered sequence. Each module owns only its own prefixed tables in D1 and never reads or writes core tables directly.
- **In-app storage for external credentials.** If a module integrates with an external provider that requires owner-supplied credentials (such as a Google OAuth client), the owner enters them in the OS PWA and OS stores them encrypted in D1 under core's encryption key rather than as Wrangler Worker secrets. Connecting a third-party account still requires authorizing that external provider inside the module's setup flow, with no Cloudflare configuration or redeploy.
- **Lazy-loaded PWA bundles.** The PWA splits each module's UI into lazy chunks loaded on navigation intent. The initial shell loads only core, so modules that are off download zero browser code and modules that are on do not slow cold open.

### Core and module boundary

Every agent request, module HTTP route, and scheduled run enters through core first. A module cannot bypass authentication, on/off checks, authorization, approvals, or auditing.

- **Agent tools and HTTP routes.** Each module registers its agent tools under a namespace derived from its module ID to prevent name collisions. Core owns the single MCP endpoint and mounts module HTTP routes (for PWA endpoints, OAuth callbacks, or non-model machine flows such as secret injection) under core's fixed route prefixes so Cloudflare Access rules never change when OS adds a module or when the owner turns one on or off.
- **Permissions and grants.** Core owns the single permission model and grant storage. Each module declares its actions and any module-owned resource scopes to core so the owner manages all grants in one place. When authorization depends on a module-owned resource, core resolves that resource's scope through a narrow module hook before running any side effect, and core makes the final allow, ask, or deny decision.
- **Audit log and secret isolation.** Core owns the append-only audit log and records every agent tool call, including denied, pending, and failed attempts. Modules provide safe summary metadata for audit entries and may record sensitive owner actions through core's audit service. Core sanitizes tool responses, errors, logs, and audit entries so secret values never reach a model's context or the audit log.
- **Approvals and notifications.** Core owns pending approvals, the unified inbox, and phone push notifications. Modules supply a human-readable summary of the action awaiting approval (without secret values) and the handler core invokes after approval. Core sends push notifications and re-checks both that the module is on and that the caller's grant still allows the action before running it.
- **PWA shell.** Core owns sign-in, navigation, the unified inbox, connections and grants, notifications, and the Modules screen. Each module contributes lazy-loaded navigation entries, routes, in-app configuration views, and optional inbox detail renderers.
- **Scheduled maintenance.** Core dispatches each module's optional Cron hook only while that module is on, with per-module error isolation and bounded work so one failing hook cannot block core cleanup or other modules.

### Turning modules on and off

Core stores whether each module is on or off in D1. Every module starts off on a new installation, and missing or unreadable state fails closed as off. Only the owner can toggle a module, the toggle is idempotent, and core records every state change in the audit log.

- **Turning a module on** shows its navigation entries in the PWA, allows its HTTP routes and scheduled hooks to run, and makes its tools eligible for MCP discovery. Turning a module on grants no agent access automatically; existing connections see no tools from that module until the owner grants them.
- **Turning a module off** stops the module from acting immediately:
  - Core removes the module's tools from MCP tool discovery, rejects any direct tool call or module HTTP request, and records rejected agent attempts in the audit log.
  - In the same atomic D1 batch that turns the module off, core cancels all pending approvals for that module and revokes all existing agent grants scoped to that module, so turning the module back on later never reactivates stale agent access.
  - Core pauses the module's scheduled hooks, hides the module from PWA navigation, and returns an off-module state on direct module routes.
  - Core preserves the module's stored data, configuration, and historical audit entries. Past activity remains readable in the unified inbox from core's stored summaries while the module is off. Permanent data erasure is a separate destructive action, never a side effect of turning a module off.

## Consequences

The owner turns any built-in module on or off inside the OS PWA in one request, with no Cloudflare setup or redeploy. Atomic D1 batches keep module writes, audit entries, approval cancellations, and grant revocations consistent without distributed transactions. Every module shares one local development loop and one deployment.

This choice carries four material costs:

- **No runtime third-party plugins.** Adding a new module requires adding a workspace package to the repository and deploying OS.
- **Shared Worker and D1 limits.** All modules share one Worker's 64 MiB uncompressed script limit, 128 MB isolate memory, per-request CPU limit, and one D1 database's 10 GB storage limit. Core must wrap module calls and Cron hooks in isolated failure boundaries so a defect in one module cannot break core or other modules.
- **Pre-provisioned idle bindings.** OS's deploy script provisions Cloudflare bindings required by built-in modules even when the owner leaves those modules off. Idle D1 tables, empty R2 buckets, and empty Vectorize indexes add no direct usage cost within Workers Paid allowances, but they appear in the owner's Cloudflare account.
- **Re-granting after turning off.** Because turning a module off revokes its agent grants to keep turning it back on least-privilege, temporarily turning a module off and back on requires the owner to grant agent access again.

## Alternatives considered

- **Separate Cloudflare Worker per module wired through Service Bindings.** Isolating each module in its own Worker separates memory, bindings, and script size. Deploying module Workers on demand violates zero setup outside OS, while pre-deploying every module Worker forces lockstep multi-Worker deployments, complicates unified PWA routing, and prevents atomic D1 batches between core and module state.
- **Dynamic external plugins through Workers for Platforms or remote webhook modules.** Runtime plugins would allow third-party modules without redeploying OS. Cloudflare Workers disallow arbitrary dynamic code evaluation, Workers for Platforms adds multi-tenant infrastructure and cost that conflicts with single-owner self-hosting, and remote modules require external hosting outside OS with weaker security boundaries for secrets and personal accounts.
- **Build-time module selection in configuration files.** Compiling only chosen modules into each deploy keeps the Worker bundle smaller. Turning a module on or off would then require editing configuration and redeploying outside OS, and per-installation build combinations would complicate upgrades and verification.
