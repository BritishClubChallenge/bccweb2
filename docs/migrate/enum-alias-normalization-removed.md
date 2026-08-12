# Enum alias normalization removed — migration required before prod

**Status:** action required (future migration script)
**Introduced by:** PR #109 (`fix/brief-followup`), schema refactor commits
`refactor(types,schemas): share coach/rating/wing enums …`,
`refactor(schemas): drop rating/wing enum aliases across all schemas`,
`refactor(types,schemas): share round status/slot/scoring enums …`.

## What changed

The blob schemas in [`packages/schemas`](../../packages/schemas) used to **heal
legacy alias values on read** via `z.preprocess(normalizeEnum(values, aliases), …)`.
Every one of those alias tables has been removed. The enums are now plain
`z.enum(...)` sourced from the shared consts in
[`@bccweb/types`](../../packages/types/src/index.ts)
(`COACH_TYPES`, `PILOT_RATINGS`, `WING_CLASSES`, `ROUND_STATUSES`,
`PILOT_SLOT_STATUSES`, `SCORING_TYPES`).

**Consequence:** a stored blob that still holds an *alias-form* value is no longer
normalized to its canonical value. Instead it heals to the field **default** (or,
for `config.wingFactors`, is **rejected** by the strict object). This is a silent
data-quality regression for any migrated blob that still carries a legacy value.

`normalizeStatus()` in [`packages/types/src/status.ts`](../../packages/types/src/status.ts)
was **not** removed and still maps a *different* legacy set
(`submitted→Proposed`, `verified→Confirmed`, `brief complete/briefcomplete→BriefComplete`,
`deleted→Cancelled`). Reuse or extend it in the migration.

## Required migration

Before this ships to prod, a one-time migration (see [`scripts/migrate`](../../scripts/migrate))
must **scan every affected blob and rewrite any alias-form value to its canonical
value** using the tables below. Run it against a snapshot first
(`scripts/migrate/dry-run-against-prod.sh`) and report counts of rewrites per field.
Set `STAGING_BLOB_CONN` for connection-string targets or `STAGING_BLOB_ACCOUNT` for
operator/OIDC identity authentication; the connection string takes precedence if both
are set.

If prod data is already fully canonical (likely, post initial migration), the
migration is a no-op verification — but that must be **confirmed with a scan**, not
assumed, because the new healing is lossy.

### Affected blobs → fields

| Blob | Field(s) |
| ---- | -------- |
| `pilots/{uuid}.json` | `coachType`, `pilotRating`, `wingClass` |
| `pilots.json` (public index) | `rating` |
| `rounds/{uuid}.json` | `status`; `teams[].pilots[].status`; `teams[].pilots[].flight.scoringType`; `teams[].pilots[].snapshot.wingClass`; `teams[].pilots[].snapshot.pilotRating` |
| `rounds.json` (public index) | `status` |
| `round-briefs/{uuid}.json` | `teams[].pilots[].snapshot.wingClass`; `…snapshot.pilotRating`; `briefer.bhpaCoachLevel` |
| `config.json` | `wingFactors` object **keys** |

### Alias → canonical maps to apply

**Coach type** (`coachType`, `briefer.bhpaCoachLevel`)

```
none → None
clubCoach, club_coach → ClubCoach
seniorCoach, senior_coach → SeniorCoach
instructor → Instructor
seniorInstructor, senior_instructor → SeniorInstructor
```

**Pilot rating** (`pilotRating`, index `rating`)

```
clubPilot, club_pilot, ClubPilot → Club Pilot
pilot → Pilot
advancedPilot, advanced_pilot, AdvancedPilot → Advanced Pilot
```

**Wing class** (`wingClass`, and `config.wingFactors` keys)

```
EN_A → EN A
EN_B → EN B
EN_C → EN C
EN_D → EN D
EN_C_2_LINER, ENC2Liner, EN_C_2_LINER_LOWER → EN C 2-liner
EN_D_2_LINER, END2Liner, EN_D_2_LINER_LOWER → EN D 2-liner
```

**Round status** (`status`)

```
Draft, draft, proposed → Proposed
Active, active, confirmed → Confirmed
BriefingComplete, briefingComplete, briefing_complete, brief_complete → BriefComplete
locked → Locked
completed, complete → Complete
cancelled, canceled → Cancelled
```

**Pilot slot status** (`teams[].pilots[].status`)

```
empty, vacant → Empty
filled, assigned → Filled
```

**Scoring type** (`flight.scoringType`)

```
xc, Xc, puretrack, PureTrack → XC
manual → Manual
```

### New default-healing behaviour (what an un-migrated alias becomes now)

| Field | Unknown/alias value now heals to |
| ----- | -------------------------------- |
| `pilot.coachType` | `None` |
| `pilot.pilotRating` | `Club Pilot` |
| `pilot.wingClass` | absent (`lenientOptional`, pilot record only) |
| snapshot `wingClass` (round + brief) | `EN A` |
| snapshot `pilotRating` (round + brief) | `Pilot` |
| `round.status` | `Proposed` |
| slot `status` | `Empty` |
| `flight.scoringType` | `XC` |
| `config.wingFactors` key | **rejected** — strict object → `DATA_SHAPE_INVALID` on read |

Note the mismatched defaults are the danger: e.g. a legacy `status: "deleted"` would
heal to `Proposed` (not `Cancelled`), and a legacy `pilotRating: "advanced_pilot"`
would heal to `Club Pilot` (not `Advanced Pilot`).
