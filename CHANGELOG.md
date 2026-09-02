# Changelog

## Unreleased — 2026-09-02

**Security**
- `npm audit fix` for transitive `fast-uri` (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc,
  GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — host confusion / SSRF via IDN and IPv6
  normalization) and `qs` (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g — array-limit bypass /
  DoS). `npm audit` now reports 0 vulnerabilities. No source changes; all 30 tests still pass
  (verified on Node 22; this host's Node 20 can't run the suite at all - node:sqlite needs 22.5+).

## v4 — 2026-08-21

`get_landscape` stopped dumping every entity in a section, and got a bounded
default in its place.

**Added**
- **Core memory tier** (`entities.core`) — `get_landscape` now defaults to only
  the entities currently marked "core" (the working-memory tier) plus due
  reminders, the tray, and the shelf count. Pass `all: true` for the old
  full-dump behavior when a scoped `search`/`get_entity` genuinely will not do.
  Nothing auto-promotes or auto-evicts - a brand-new entity starts out of core
  like every other one, and eviction never deletes anything.
- **`promote_entity`** / **`evict_entity`** — move an entity into or out of the
  core view, explicitly. Evicted entities stay fully intact and reachable via
  `search` or `get_entity` by name.
- **`list_entities`** — enumerate every entity in a section (own + shared),
  core or not, with just name/summary/core flag/observation_count - never
  observation bodies. The lightweight full-coverage tool for a browse/audit
  pass, distinct from the bounded `get_landscape` and the one-topic
  `get_entity`.
- **`merge_entity`** — fold a duplicate entity into the one you are keeping.
  Every observation moves or copies over (protected ones move as-is, keeping
  their id and protection; unprotected ones copy in with a "MERGED IN from X"
  prefix), the duplicate name becomes a permanent alias of the survivor, and
  the now-empty duplicate is deleted.
- **Search-gated entity creation** — `upsert_entity` and `add_observation` now
  check a brand-new name against `entity_aliases` first: a name that was
  already merged away redirects silently to the survivor (`redirected` in the
  result). If it is not a known alias but is merely similar to an existing
  same-section name, creation still succeeds - it is never blocked - but the
  result carries `similar_entities` so the caller can check before assuming
  this is really new.
- 7 new tests covering the core tier, promote/evict, list_entities, merge,
  aliasing, and the similarity warning - 30 total, still every run from an
  empty database.

**Schema**
- `PRAGMA user_version` 5. Two additive migrations: v4 adds `entities.core`
  (`ALTER TABLE`, defaults existing rows to 0); v5 adds the `entity_aliases`
  table. Either upgrades an existing database in place on the next start.

## v3 — 2026-08-14

Memory got two staging areas in front of it, reminders learned to be delivered,
and the whole thing now runs with no configuration at all.

**Added**
- **`get_observation`** — fetch up to 20 observations by id. Ids are stable and
  never reused, so a handoff can cite them and the next conversation fetches
  exactly those. Scope resolves from each row's own section, and an unreachable
  id reads exactly like one that never existed.
- **Timed reminders** — `trigger_time` makes a reminder due at a clock time.
  `list_due_reminders` is the polling contract for an external notifier;
  `mark_reminder_fired` stamps delivery through a guarded UPDATE, so two
  pollers can't double-send.
- **The tray** (`pending_*`) — capture what arrives without derailing what
  you're doing, then promote it into an observation, merge it, or dismiss it.
  Untriaged items come back in `get_landscape`.
- **The shelf** (`research_*`) — your own ideas, undated and unpressured. They
  leave by graduating to the tray or being killed on purpose, with the reason
  kept. `get_landscape` reports only how many are open, never the list.
- **Zero-config start** — with no `ATLAS_TOKEN`, the server generates one token
  per scope on first run, prints them, and saves them beside the database.
- **`ATLAS_TZ`** — reminders, the time footer, and the groom window all read one
  configurable timezone instead of a hardcoded one. `ATLAS_GROOM_HOUR` moves the
  nightly run.
- **Tests** (`npm test`) — 21 of them, every run from an empty database, so they
  double as the blank-slate check. CI runs them on every push; a second workflow
  publishes the container image.
- `HEALTHCHECK` in the image; `docker compose up` needs no `.env`.

**Changed**
- `get_landscape` now returns `tray` and `shelf` alongside `entities` and
  `reminders`.
- The groom worker stamps its reports in your timezone, and the server schedules
  it internally — no host cron.

**Schema**
- `PRAGMA user_version` 3. Additive only: an existing v2 database upgrades in
  place on the next start, no migration step to run.

## v2 — 2026-07-12

- `shared` section, auto-merged into every landscape pull.
- Scoped tokens (`caller:secret:scope`), enforced server-side on every call.
- `protect_observation` / `unprotect_observation`, `update_observation`.
- Full `audit_log` of allowed and denied calls.
- Time footer on every response; mechanical groom worker.

## v1

- Entities, observations, history events, date-based reminders, keyword search.
