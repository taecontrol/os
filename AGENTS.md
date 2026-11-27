# OS

OS gives one owner's AI agents the tools to act on the things the owner cares about: memory, secrets, Google accounts, and more areas to come. It replaces Nook and google-accounts-mcp. Redesign each area for OS rather than porting it; their code and decisions are input, not a template.

Each area is a module the owner can turn on or off. Keep the shared core small: identity, permissions, the audit log, approvals, and notifications. How modules are packaged and enabled is an architecture decision that belongs in an ADR.

OS is public, and anyone should be able to install it. Each installation serves one owner. Do not build multi-tenancy. Keep installation-specific values in configuration, never in code.

## How to decide

- Agents do the work; the owner keeps control. Every capability starts as an agent tool. The PWA is where the owner sees what agents did, approves what waits on them, and gets notified on their phone.
- OS feels like one product. One permission concept spans every module, one inbox holds agent activity and pending approvals, and turning a module on needs no setup outside OS.
- Design mobile first. The web app feels instant: preload routes and data on intent, cache queries, and apply predictable writes optimistically. A cold open shows its first screen within 1 s on a 4G phone network, and navigation after intent takes under 100 ms.
- When two designs are both valid, choose the one that grants less by default and fails closed.
- Use one stack: TypeScript and Effect, with Vite+ as the toolchain. Build interfaces from ui-sdk components rather than custom controls. Introduce another language, framework, or UI library only for a concrete reason, recorded in an ADR.

## Obligations on every change

- Secret values never enter a model's context. No agent tool, error, log line, or audit entry returns or records a value.
- Every agent action is authorized against the owner's grant, fails closed outside it, and lands in the audit log.
- Code carries no comments; lint enforces it. Put a decision in an ADR and every other why in a name, a type, or a test.
- The only documentation is ADRs in `docs/adr/`, the glossary in `docs/glossary.md`, the map in `docs/map.md`, and a short README that says what OS is and how to install it. Update the map when you add, move, or remove an area, and the glossary when you name a domain concept. Leave everything the code already says to the code.

## Development phase

OS has no users besides the owner. Write no backward compatibility, rollback paths, or migrations that preserve old data. Nook and google-accounts-mcp stay in production until the OS module that replaces each is ready; then a one-time script imports the owner's real data.

Work in small pull requests that merge fast. Issues live in this repository's GitHub tracker.

## Proof

Unit tests are not proof. For every change the owner can see, use the product as a real user: run every case you defined as a complete flow, on a local installation seeded with realistic synthetic data, and put a video or screenshots of each case in the pull request description.

Read the owner's real accounts only with their permission for that case, and only to read. Every write, such as sending mail or changing a calendar, goes against test accounts or test events.

## Merging

The most sensitive thing a pull request touches sets its tier. When in doubt, take the higher tier.

1. Merge yourself once checks are green: tests, fixtures, and synthetic data; the glossary, map, and README; UI that does not change which data is read or written; refactors with no behavior change; tooling and CI that add or tighten checks; minor and patch dependency updates.
2. Merge after the owner approves the proof: new or changed behavior in a module, such as flows, screens, agent tools, or CLI commands; schema and data model changes; new dependencies and major updates.
3. Wait for the owner to approve the change itself: authentication, tokens, permissions, and agent grants; secret handling, encryption, and the audit log; writes to real external accounts; importing, migrating, or deleting the owner's real data; deployment configuration and deploys; loosening, skipping, or removing a check; new or changed ADRs.

## Language

Write everything in this repository in English: code, docs, UI text, issues, and pull requests. Talk to the owner in Spanish.
