# ADR-0004: Tie owner-bound data to the owner generation with a cascading foreign key

Date: 2026-11-27
Status: Accepted

## Context

Under ADR-0003, Core D1 pins one owner email and a monotonic owner generation. An explicit owner reset increments the generation and must invalidate everything the previous owner left behind: agent connections, grants, approvals, and every later table that belongs to the owner. Core D1 will gain many such tables as later work adds connections, push devices, and module state.

The invalidation has to stay correct while requests run during the reset. A request may read the old generation, then try to write after the reset has committed. It also has to hold for tables that do not exist yet, which contributors will add without reading the reset code.

google-accounts-mcp solved the same problem by deleting a list of tables. Those deletes did not run as one atomic step, so its reset needed a staged state machine (its ADR-0016).

## Decision

Every owner-bound root table in Core D1 carries `owner_generation INTEGER NOT NULL REFERENCES owner (generation) ON DELETE CASCADE`. A table that belongs to such a root references its parent row and cascades from it; it does not carry its own generation.

The reset replaces the singleton `owner` row with the next generation in one statement. Replacing the row deletes the old generation, so SQLite's foreign keys delete every root row of that generation and, through them, every descendant, in the same statement. A write that arrives late with the old generation fails, because its parent generation no longer exists. A plain update of the generation fails while dependent rows exist, so the reset is the only way to move to the next generation.

SQLite enforces the rule on every write, so it covers future tables and every code path, and no caller has to apply it.

Core D1 also follows these storage conventions, so that every table fits this rule and reads the same way:

- The binding is `DB`, and migrations live in `migrations/NNNN_snake_name.sql`.
- Tables are `STRICT` and snake_case, with plural names except the singleton `owner`.
- Timestamps are `*_at INTEGER` columns holding Unix milliseconds.
- Every installation-specific value is a Worker secret named in `secrets.required`. Committed configuration holds only values that are the same in every installation.

## Consequences

- A reset is atomic and covers tables added later without changing the reset.
- A migration must never drop or rebuild the `owner` table. Dropping the parent cascades across all owner-bound data, even when foreign key checks are deferred. Change `owner` in place with `ALTER TABLE`.
- Each new owner-bound root table must declare the foreign key. A root table without it survives the reset, and no runtime check notices.
- The reset is not conditioned on the generation it expects. Repeating it after the new owner has signed in unpins that owner and deletes their rows; they sign in again.

## Alternatives considered

- **A deletion trigger per table.** It runs when the generation changes, but a write authorized before the reset can still land after it with the old generation.
- **Filtering every read by generation.** Old rows stay in the database, and every query that forgets the filter revives them.
- **A reset that deletes a list of tables.** It ties the reset to a list every new table must join. In google-accounts-mcp the deletes were not atomic, and the reset needed a staged state machine.
- **A generation column on every descendant table.** It repeats ownership the parent reference already gives, and adds a consistency rule between the two.
