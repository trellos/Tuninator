# This demo targets the 0.1 API and no longer compiles

Tuninator 0.2 replaced the pitch detector with a streaming musical event
recognizer. Every symbol this demo touches changed: `createTuninator`, all seven
subscriptions, `setMode`, and every per-field read in `src/ui.ts`.

This directory is a held copy. The demo's real home is the separate repository
`trellos/Tuninator-Example`, so the migration belongs there rather than here —
updating this copy alone would leave the published demo broken while looking
fixed.

The work is fully specified and ready to run:

- `../../docs/MIGRATION.md` — the durable old→new reference.
- `../../docs/example-migration-prompt.md` — a self-contained, paste-ready
  prompt for a session opened against `trellos/Tuninator-Example`, containing
  the new API verbatim, the mapping table, the file-by-file work list, and the
  verification bar.
