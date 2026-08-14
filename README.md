# Claude-Atlas-MCP

Self-hosted MCP server that gives Claude persistent memory across conversations — **entities**, **observations**, **history**, **timed reminders**, plus a **tray** for things that arrive and a **shelf** for ideas — in a lightweight Node/SQLite backend you run yourself.

Point Claude at it as an MCP connector and it can remember what you're working on from one conversation to the next: ongoing projects, decisions and their rationale, facts about you and your setup, and things to resurface on a future date.

## Why

Claude forgets everything when a conversation ends. Atlas is a small, boring, durable memory layer you own end to end — no third-party service, no vendor lock-in. It's a single Node process backed by one SQLite file. Run it on a home server, a VPS, or your laptop.

It starts blank on purpose. There is no schema of *your* life baked in, no assumed job, no required issue tracker — just a shape that fills in as you use it.

## Quick start

```bash
git clone https://github.com/dcazman/Claude-Atlas-MCP.git
cd Claude-Atlas-MCP
docker compose up -d --build
docker compose logs atlas-mcp
```

No `.env`, no token, no config. On first start Atlas creates the database, generates one token per scope, and prints them:

```
    work     3f2a…   (caller "work-client")
    personal 9c41…   (caller "personal-client")
    shared   b7e0…   (caller "shared-client")

  Connect a client to:  http://localhost:7784/atlas-mcp?token=<one of the above>
```

The tokens are saved next to the database and reused on every restart. Data lives in `./data`, a single SQLite file. That's the whole setup — everything below is optional.

<details>
<summary>Prebuilt image, bare Node, or your own tokens</summary>

CI publishes an image on every push to `main`:

```bash
docker run -d --name atlas -p 7784:7784 -v "$PWD/atlas-data:/app/data" \
  ghcr.io/dcazman/claude-atlas-mcp:latest
```

Bare Node (22+, for built-in `node:sqlite` — no native dependencies, nothing to compile):

```bash
npm install
npm start
```

To choose your own tokens or timezone instead of the generated ones,
`cp .env.example .env` before starting and edit it.
</details>

## Data model

| Concept | What it is |
|---------|-----------|
| **Entity** | A topic or project you want Claude to track (e.g. "Home Network", "Q3 Planning"). Has a name and a one-line summary. |
| **Observation** | A single fact attached to an entity ("switched the router to the 6E band on 2026-06-01"). The atomic unit of memory. Editable in place, and markable **protected** so it can be corrected but never deleted. |
| **History event** | A notable thing that happened, logged to the timeline for later recall. |
| **Reminder** | A note with a `trigger_date`. Once the date arrives it auto-surfaces at the start of a conversation and stays until dismissed. Add a `trigger_time` and it becomes a **timed** reminder meant to be delivered once, by something that polls for it. |
| **Tray item** | Something that arrived and needs triage but shouldn't derail what you're doing. Capture now, decide later. |
| **Shelf item** | One of your own ideas. No date, no pressure, no aging. |
| **Section** | A top-level namespace — `work`, `personal`, or `shared`. Every tool call takes a `section`. `shared` is a handoff channel both `work`- and `personal`-scoped tokens can reach; `get_landscape` merges it into whichever section you pull. |

### The funnel

Three surfaces, in increasing order of commitment:

```
  shelf  ──graduate──▶  tray  ──promote──▶  memory
 (ideas)              (triage)          (observations)
```

- **The shelf** holds things you thought of. An idea sitting there for a year isn't a backlog failure — it's the shelf working. Ideas leave by graduating to the tray or by being killed on purpose, with the reason kept.
- **The tray** holds things that arrived. It's a queue, not a pile: capture, then promote, merge, or dismiss.
- **Memory** is the part Claude reads back at the start of a conversation.

Nothing is destroyed on the way through. Resolved items stop showing up but keep their history, including what they turned into.

## Tools

31 MCP tools.

**Reading**
- `get_landscape` — everything in a section (with `shared` merged in): all entities with their observations, plus any due reminders. Call at the start of a conversation to get oriented.
- `search` — keyword search across entities, observations, and history.
- `get_entity` — one entity and its observations by name.
- `get_observation` — fetch up to 20 observations directly by id. Ids are stable and never reused, which makes them a cheap way to hand specific facts from one conversation to the next.
- `get_history` — the timeline of logged events.
- `get_time` — current time plus how long since this token's last call.

**Writing**
- `upsert_entity` — create or update an entity's name/summary.
- `add_observation` — attach a fact to an entity.
- `update_observation` — edit a fact in place; the id stays stable. Works on protected rows.
- `remove_observation` — drop a fact that's stale or done (refuses if protected).
- `protect_observation` / `unprotect_observation` — mark a fact undeletable, or lift that.
- `remove_entity` — delete an entity and its observations (refuses if any is protected).
- `log_event` — record a notable event to history.

**Reminders**
- `create_reminder` — a note with a `trigger_date`, an optional `trigger_time`, and an optional entity link.
- `list_reminders` — everything scheduled, due or not.
- `list_due_reminders` — everything due right now. This is what a notifier polls.
- `mark_reminder_fired` — stamp a timed reminder as delivered so it never fires twice.
- `dismiss_reminder` — mark a reminder handled (it stops surfacing).
- `remove_reminder` — delete a reminder outright.

**Tray**
- `pending_add` — capture something that arrived.
- `pending_list` — what still needs triage, oldest first.
- `pending_promote` — turn a capture into an observation on an entity.
- `pending_merge` — fold a duplicate into the one you're keeping.
- `pending_dismiss` — decide it needs nothing, with the reason kept.
- `pending_reopen` — undo any of the above.

**Shelf**
- `research_add` — park an idea.
- `research_list` — open ideas, oldest first.
- `research_promote` — graduate an idea into the tray.
- `research_kill` — retire an idea on purpose, with the reason.
- `research_reopen` — put it back.

Every tool response carries a small time footer — current server time in your
configured timezone, plus elapsed time since that token's last call — so the
model never has to guess or do date math from a stale mental clock.

## Getting notified

Atlas never pushes anything on its own — it has no idea where you'd want to be
reached. Instead, `list_due_reminders` is the contract for anything that does:

1. Poll `list_due_reminders` on whatever interval suits you.
2. Deliver the rows that carry a `trigger_time` (the passive ones are just waiting to be seen in the landscape).
3. Call `mark_reminder_fired` on each one you delivered.

Step 3 is what makes delivery exactly-once: the stamp is guarded in SQL, so
two overlapping pollers can't double-send. A dozen lines of cron-driven script
is enough to wire this to email, a chat webhook, or a phone notification.

## Groom worker

`src/groom.js` runs nightly inside the server process (no host cron needed), or
on demand with `npm run groom`. It's intentionally report-only and mechanical —
no LLM calls, no deletion of your data:

- flags likely near-duplicate observations within an entity
- flags dormant entities (60+ days untouched) as archive/compress candidates
- flags long-dismissed reminders (90+ days) as removal candidates
- rotates its own `audit_log` (90+ days) — the only thing it actually deletes
- skips entities untouched since the last run, so repeat runs are cheap

Findings land in a per-section "Groom Report" entity for you (or Claude) to act on.
It runs at `ATLAS_GROOM_HOUR` (default 4am) in your timezone, and self-heals: a
window missed because the container was down runs at the next check.

## Connecting Claude

Atlas speaks MCP over streamable HTTP at `POST /atlas-mcp`. Add it as a connector using the server's URL with your token:

```
https://<your-host>/atlas-mcp?token=<your-secret>
```

The token is the **secret** half of an `ATLAS_TOKEN` triple (see Configuration). You can also pass it as an `X-Atlas-Token` header or a `Bearer` token instead of the query string.

There's no `section` in the URL — every tool takes a `section` argument, and which one a given conversation should default to is best set in your Claude project's custom instructions (e.g. *"Your Atlas section is personal"*). A `GET /health` endpoint is available for liveness checks.

For real use you'll want it behind HTTPS — a reverse proxy or a tunnel (Cloudflare Tunnel, Tailscale, nginx, etc.) in front of the container. The token is the only auth, so **do not expose the port publicly without TLS.**

Once connected, a good habit is to have Claude call `get_landscape` at the start of each conversation and keep entries updated as things change. The server ships instructions saying exactly that, so most clients pick it up without you writing anything.

## Securing it

Atlas's built-in auth is a shared token — fine behind a private network or tunnel, but thin if you're exposing it to the internet. For real access control, put a dedicated auth gateway in front rather than hardening this server yourself.

[**mcp-auth-proxy**](https://github.com/sigbit/mcp-auth-proxy) is a drop-in OAuth 2.1 / OIDC gateway for MCP servers — no code changes to Atlas:

- Authenticate against your own IdP (Google, GitHub, Okta, Auth0, Azure AD, Keycloak, any OIDC provider), with an optional password.
- Authorize users by exact match or glob (e.g. `*@yourcompany.com`).
- Terminates TLS and proxies HTTP transports through as-is, verified across Claude, Claude Code, ChatGPT, Copilot, and Cursor.

Roughly, you'd point it at Atlas's HTTP endpoint:

```bash
./mcp-auth-proxy \
  --external-url https://<your-domain> \
  --tls-accept-tos \
  -- http://localhost:7784/atlas-mcp
```

See its [documentation](https://github.com/sigbit/mcp-auth-proxy) for IdP setup and configuration. (Not affiliated — just a clean fit for self-hosted MCP servers like this one.)

## Configuration

All optional. Set via `.env` (see `.env.example`) or the environment:

| Variable | Purpose |
|----------|---------|
| `ATLAS_TOKEN` | One or more `caller:secret:scope` triples, comma-separated. Scope is mandatory — `work` (reaches `work`+`shared`), `personal` (reaches `personal`+`shared`), or `shared` (reaches `shared` only). Enforced server-side on every call; out-of-scope requests get a 403 and are logged. **If unset, Atlas generates a token per scope on first start and saves them to `first-run-tokens.txt` in the data directory.** |
| `ATLAS_TZ` | IANA timezone for reminders, the time footer, and the groom window (e.g. `America/Chicago`, `Europe/Berlin`). Defaults to the host TZ, then UTC. |
| `ATLAS_GROOM_HOUR` | Hour of the local day the nightly groom may start (0–23, default 4). |
| `PORT` | Listen port (default 7784). |
| `ATLAS_DB_PATH` | Path to the SQLite file (default `../data/atlas.db` relative to `src/`; the Docker image uses `/app/data/atlas.db`). |

## Making it yours

The design is deliberately small so you can extend it without fighting it.

- **Add a tool.** Everything lives in `src/tools.js`, registered through one `guarded()` wrapper that does the scope check and the audit write. A new tool is a `guarded(name, {description, inputSchema}, handler)` block plus a function in `src/db.js`. The description matters more than the code — it's what Claude reads to decide when to reach for it.
- **Add a table.** Migrations are a `PRAGMA user_version` ladder in `src/db.js`: bump the number, write additive SQL guarded by it, done. Every migration is idempotent and runs at boot, so upgrading is just restarting.
- **Push rules into the database.** The house style here is that a rule you have to remember is a rule that gets broken — so `resolved_at` is stamped by a trigger, scope is enforced server-side, and protected rows are protected in SQL. Follow the pattern and your additions inherit it.
- **Change the sections.** `work`/`personal`/`shared` are fixed in the schema's CHECK constraints and the scope map in `src/server.js`. Renaming them is a migration plus a two-line map edit — worth doing if the vocabulary doesn't fit your life.

## Tests

```bash
npm test
```

Every run starts from an empty database, so the suite doubles as the blank-slate
check: schema builds from nothing, the token scope matrix holds (including that
out-of-scope ids are indistinguishable from nonexistent ones), timed reminders
fire exactly once, and the funnel moves items the way it claims to.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, deployment hardening notes, and how to report a vulnerability.

## License

MIT — see [LICENSE](LICENSE).
