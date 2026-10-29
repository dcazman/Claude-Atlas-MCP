# The board (not in this tree, on purpose)

This folder is a placeholder. Public Atlas ships the general memory core: entities, observations, history, timed reminders, the tray and the research shelf. It starts blank and assumes nothing about the work you do with it.

Some deployments layer a work board on top of that core: sprint-based tracking of tickets with ordering, hold and close rules, and records of spawned worker sessions tied to each piece of work. That layer is built around one particular way of working (sprints, ticket keys, a fixed notion of "in progress" versus "done"), so it is not part of the general-purpose tree.

## If you want something like it

Build it as an additive migration on this tree's `PRAGMA user_version` ladder (see the v4 and v5 migrations for the pattern):

- Give work items their own table. Never hard-delete a row; retire it instead so history stays.
- Require a ledger entry before an item can be marked done, and enforce that in the database rather than in tool code.
- Register each tool through `guarded(...)` in `src/tools.js` so scope checks and the audit log apply.
- Write tool descriptions fresh and generic, and start every test from an empty database as the existing suite does.
- Run `npm test` before pushing.

Describe whatever you add in `README.md` and `CHANGELOG.md`.
