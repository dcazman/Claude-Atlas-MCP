# Changelog

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
