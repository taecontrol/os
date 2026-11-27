# Glossary

**Core**: the `os-core` Worker. It owns identity, permissions, the audit log, approvals, and notifications, and every external request enters OS through it.

**Module**: one capability area, such as Memory, Secrets, or Google accounts. Each runs as its own private Worker behind Core, and the owner can turn an installed module on or off.

**Owner**: the one person an installation serves. They sign in through Cloudflare Access with the email in `OWNER_EMAIL`.

**Owner generation**: a number in Core D1 that starts at 1 and goes up by one on every owner reset. Rows that belong to the owner carry the generation they were written under.

**Pinned owner**: the owner email recorded in Core D1 by the first verified sign-in. Only an owner reset clears it.

**Locked installation**: an installation whose pinned owner differs from `OWNER_EMAIL`. Owner and machine routes refuse every request until `OWNER_EMAIL` is restored or the owner is reset.

**Owner reset**: the operator command that clears the pinned owner, moves to the next owner generation, and in the same statement deletes every owner-bound row of the old generation.

**Owner route**: a route under `/api/`. It acts only for the pinned owner, verified from the Cloudflare Access assertion, and refuses any agent credential.

**Machine route**: a route that Cloudflare Access bypasses, under `/mcp`, `/oauth/token`, `/.well-known/`, or `/agent/`. Agents call it with their own credentials, and it refuses any Access assertion.

**Synthetic owner**: the identity Core uses under `vp dev` and Vitest in place of Cloudflare Access. It signs in as `OWNER_EMAIL` and goes through the same pinning and lock checks. Production builds do not contain it.

**Owner-bound row**: a row that belongs to one owner generation through a foreign key to the owner's generation, directly or through a parent row. An owner reset deletes it.
