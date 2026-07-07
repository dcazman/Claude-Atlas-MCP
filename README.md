# Claude-Atlas-MCP

Self-hosted MCP server that gives Claude persistent memory across conversations — **entities**, **observations**, **history**, and time-based **reminders**, in a lightweight Node/SQLite backend you run yourself.

Point Claude at it as an MCP connector and it can remember what you're working on from one conversation to the next: ongoing projects, decisions and their rationale, facts about you and your setup, and things to resurface on a future date.

## Why

Claude forgets everything when a conversation ends. Atlas is a small, boring, durable memory layer you own end to end — no third-party service, no vendor lock-in. It's a single Node process backed by one SQLite file. Run it on a home server, a VPS, or your laptop.

## Data model

| Concept | What it is |
|---------|-----------|
| **Entity** | A topic or project you want Claude to track (e.g. "Home Network", "Q3 Planning"). Has a name and a one-line summary. |
| **Observation** | A single fact attached to an entity ("switched the router to the 6E band on 2026-06-01"). The atomic unit of memory. |
| **History event** | A notable thing that happened, logged to the timeline for later recall. |
| **Reminder** | A note with a `trigger_date`. Once the date arrives it auto-surfaces at the start of a conversation and stays until dismissed. |
| **Section** | A top-level namespace — one of two fixed values, `work` and `personal`. Every tool call takes a `section` argument, so the two contexts never bleed into each other. |

## Tools

The server exposes 13 MCP tools:

**Reading**
- `get_landscape` — everything in a section: all entities with their observations, plus any due reminders. Call at the start of a conversation to get oriented.
- `search` — keyword search across entities, observations, and history.
- `get_entity` — one entity and its observations by name.
- `get_history` — the timeline of logged events.

**Writing**
- `upsert_entity` — create or update an entity's name/summary.
- `add_observation` — attach a fact to an entity.
- `remove_observation` — drop a fact that's stale or done.
- `remove_entity` — delete an entity and its observations.
- `log_event` — record a notable event to history.

**Reminders**
- `create_reminder` — a note with a `trigger_date` (and optional entity link).
- `list_reminders` — all reminders, or just those currently due.
- `dismiss_reminder` — mark a reminder handled (it stops surfacing).
- `remove_reminder` — delete a reminder outright.

## Requirements

- Node.js with built-in SQLite support (`node:sqlite`) — Node 22+.
- Docker (optional, recommended for deployment).

There are **no native dependencies** — storage is the built-in `node:sqlite` module, so there's nothing to compile.

## Quick start (Docker)

```bash
git clone https://github.com/dcazman/Claude-Atlas-MCP.git
cd Claude-Atlas-MCP
cp .env.example .env      # set a token
docker compose up -d --build
```

The server listens on port **7784**. Data persists to `./data` (a single SQLite file) via the mounted volume.

## Quick start (bare Node)

Requires Node 22+ (for built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # set a token
npm start                 # or: node src/server.js
```

## Connecting Claude

Atlas speaks MCP over streamable HTTP at `POST /atlas-mcp`. Add it as a connector using the server's URL with your token:

```
https://<your-host>/atlas-mcp?token=<your-secret>
```

The token is the **secret** half of an `ATLAS_TOKEN` `caller:secret` pair (see below). You can also pass it as an `X-Atlas-Token` header or a `Bearer` token instead of the query string.

There's no `section` in the URL — every tool takes a `section` argument (`work` or `personal`), and which one a given conversation should default to is best set in your Claude project's custom instructions (e.g. *"Your Atlas section is personal"*). A `GET /health` endpoint is available for liveness checks.

For real use you'll want it behind HTTPS — a reverse proxy or a tunnel (Cloudflare Tunnel, Tailscale, nginx, etc.) in front of the container. The token is the only auth, so **do not expose the port publicly without TLS.**

Once connected, a good habit is to have Claude call `get_landscape` at the start of each conversation and keep entries updated (`upsert_entity` / `add_observation` / `log_event` / `remove_observation`) as things change — you can encode that in the connector's instructions field or your project's custom instructions.

## Securing it

Atlas's built-in auth is a single shared token — fine behind a private network or tunnel, but thin if you're exposing it to the internet. For real access control, put a dedicated auth gateway in front rather than hardening this server yourself.

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

Set via `.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `ATLAS_TOKEN` | **Required.** One or more `caller:secret` pairs, comma-separated (e.g. `claude:changeme`). A request is authorized if its token matches any secret. Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. |
| `PORT` | Listen port (defaults to `7784`). |
| `ATLAS_DB_PATH` | Path to the SQLite file (defaults to `../data/atlas.db` relative to `src/`; the Docker image uses `/app/data/atlas.db`). |

## Security

See [SECURITY.md](SECURITY.md) for the threat model, deployment hardening notes, and how to report a vulnerability.

## License

MIT — see [LICENSE](LICENSE).
