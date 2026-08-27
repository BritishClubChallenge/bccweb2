# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `CONTEXT.md` glossary at the repo root, one `docs/adr/`
directory for decisions. The npm-workspaces layout (`apps/*`, `packages/*`) is a build-graph
split, not a domain split: `apps/api` and `apps/web` are two ends of the same round lifecycle,
and `packages/{types,schemas,scoring}` exist to be shared between them. One glossary covers all
of them.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in

If these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get
resolved. Neither exists yet in this repo.

Until `CONTEXT.md` exists, the working domain vocabulary lives in the `AGENTS.md` files —
[root](../../AGENTS.md), [apps/api](../../apps/api/AGENTS.md),
[apps/api/src/lib](../../apps/api/src/lib/AGENTS.md),
[apps/api/src/functions](../../apps/api/src/functions/AGENTS.md),
[apps/web/src](../../apps/web/src/AGENTS.md), [packages/schemas](../../packages/schemas/AGENTS.md),
[scripts](../../scripts/AGENTS.md) — plus the human-facing docs in
[docs/architecture/](../architecture/) and [docs/runbooks/](../runbooks/). Those describe
mechanics; `CONTEXT.md` is for the domain terms themselves (round, brief, slot, signature
ledger, sign-to-fly, blob family).

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── apps/{api,web}/
└── packages/{types,schemas,scoring}/
```

If the domain ever genuinely splits — the most plausible seam is the application
(`apps/`, `packages/`) versus the Azure topology (`iac/`), which use different vocabularies —
switch to multi-context: a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context, with
context-scoped `docs/adr/` directories alongside each.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
