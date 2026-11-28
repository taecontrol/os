# ADR-0005: Build the PWA with React, ui-sdk, TanStack Router, and TanStack Query

Date: 2026-11-27
Status: Accepted

## Context

ADR-0002 settles that `os-core` serves one PWA build, shared by Core and every module, with one `ui-sdk`, one router, and one query cache. `AGENTS.md` requires building interfaces from ui-sdk components and recording any new framework or UI library in an ADR. The PWA must show its first screen within 1 s on a 4G phone network and navigate after intent in under 100 ms. It must preload routes and data on intent, cache queries, and apply predictable writes optimistically.

ui-sdk (`@ui-sdk/*`) provides unstyled behavior components, not a full application stack. It ships bindings for React, Vue, Svelte, Solid, and Web Components, so using it means choosing a framework or going without one. It is a beta (0.1.0) at the time of this decision.

The router and the query cache have to work with the chosen binding. Building them inside OS would make OS own navigation, preloading, cancellation, staleness, and pagination for every module.

## Decision

Build the PWA with React 19, `@ui-sdk/react` and `@ui-sdk/core`, TanStack Router as the one router, and TanStack Query as the one client-side data cache. The cache lives in memory only.

The owner chose this stack on 2026-11-27, after comparing the options with a second opinion, for three reasons:

- **The pieces work together today.** React is the binding where ui-sdk, a router with preloading on intent, and a mature query cache all fit. The obvious lighter choice, Solid, does not: `@ui-sdk/solid` requires solid-js 2, while TanStack's Solid adapters require solid-js 1.
- **The weight fits the budget.** A throwaway production build with React, React DOM, TanStack Router and Query, and the ui-sdk components the screens need (buttons, switch, dialogs, drawer, form fields, segmented control, toast) weighed about 174 KB gzip. On an emulated 4G profile (9 Mbps down, 85 ms latency, cold cache) it showed its first data in 569 to 585 ms over 10 runs in Chromium against a local server. Real phones, TLS, and Core add time this did not measure.
- **It is proven in the owner's own products.** Nook runs React with TanStack Router and Query behind Cloudflare Access, and its load-time test checks the same 1 s and 100 ms budgets.

## Consequences

- React is the UI framework for Core screens and every module's lazy-loaded chunk. Module UIs share its router, query cache, and ui-sdk version.
- React, the router, and the cache cost about 100 KB gzip before any screen. Screens must fit in the remaining budget, so later work has to watch the size of the first load.
- ui-sdk is pre-1.0. OS pins exact versions and absorbs breaking changes on upgrade. Young releases can collide with the repository's package release-age policy, and loosening that policy needs the owner's approval.
- The client cache is never persisted, so the PWA is online-only.
- Moving off React later means rewriting every screen and module UI, and choosing new bindings for ui-sdk, the router, and the cache.

## Alternatives considered

- **ui-sdk Web Components with no framework.** Needs no framework decision, but OS would build and maintain its own router and query cache, the two shared mechanisms ADR-0002 requires.
- **Solid.** Smaller runtime, but its ui-sdk binding and TanStack's Solid adapters need incompatible major versions of solid-js.
- **Vue with Vue Router and TanStack Vue Query.** Compatible on paper, but unmeasured against the budgets.
- **Server-rendered HTML from the Worker.** The smallest first load, but no client router or query cache, which ADR-0002 requires for preloading and instant navigation.

## References

- [ADR-0002: Run each module as a private Cloudflare Worker behind OS Core](0002-module-architecture.md)
- [OS agent instructions](../../AGENTS.md)
- [ui-sdk](https://ui-sdk.dev)
