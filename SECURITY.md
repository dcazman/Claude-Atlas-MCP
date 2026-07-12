# Security Policy

## Supported Versions

Atlas-MCP is a single self-hosted service tracked on the `main` branch. There is no versioned release channel — only the latest commit on `main` is supported. Deployments should stay current by pulling `main` and rebuilding.

| Version | Supported |
|---------|-----------|
| `main` (latest commit) | ✅ |
| Older/pinned commits | ❌ |

## Reporting a Vulnerability

This is a personal, self-hosted project. If you find a security issue:

1. **Do not open a public GitHub issue.**
2. Report it privately via GitHub's [private vulnerability reporting](https://github.com/dcazman/Claude-Atlas-MCP/security/advisories/new) on this repo, or contact the maintainer directly.
3. Include: affected file/endpoint, reproduction steps, and potential impact.
4. Expect an initial response within a few days. This is a hobby project maintained in spare time, not a commercially supported product with an SLA.

## Threat Model & Known Considerations

Atlas-MCP is designed to be run **behind a private network, tunnel, or auth gateway** — not exposed directly to the public internet. Keep the following in mind:

- **Single shared-secret auth, but scoped as of v2.** `ATLAS_TOKEN` (`caller:secret:scope` triples) is the only built-in authentication. There is no per-user identity and no rate limiting or lockout — treat a leaked token as a compromise of everything that token's scope can reach. Scope is enforced server-side on every tool call.
- **No built-in TLS.** The server listens over plain HTTP. It must sit behind HTTPS termination (reverse proxy, Cloudflare Tunnel, Tailscale, nginx, etc.). **Never expose the raw port to the internet without TLS in front of it.**
- **Recommended: a dedicated auth gateway.** For real access control (OAuth 2.1/OIDC, per-user identity, IdP-backed login), put [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) or an equivalent gateway in front rather than relying on the shared token alone.
- **`work` / `personal` / `shared` section isolation is enforced server-side, not just a data-organization convention.** Each token's scope (`work`, `personal`, or `shared`) is checked on every tool call; a token can only ever reach the sections its scope permits, and out-of-scope attempts are rejected with a 403 and recorded — they don't fail silently. That said, this is still a single shared-secret model with no per-user identity behind each scope, so anyone holding a given token has full read/write to everything that scope covers.
- **SQLite file is the entire data store.** Anyone with filesystem access to the `data/` volume (or a backup/snapshot of it) has full read/write access to all entities, observations, history, and reminders, across all sections. Protect the volume and any backups (e.g. encrypted at rest, restricted file permissions).
- **`.env` holds the token in plaintext.** Keep it out of version control (it's git-ignored by default via `.env.example`) and restrict file permissions on the host.
- **No input sanitization guarantees beyond standard parameterized SQLite queries.** Treat all tool inputs as untrusted if a single token's scope is ever shared across more than one trusted caller.
- **Every tool call is written to an `audit_log` table** (caller, tool, section, allowed/denied, a short detail summary, timestamp) — both allowed and denied calls, not just failures. There's no built-in log viewer or alerting; query the SQLite table directly, or layer alerting at the auth-gateway level (e.g. mcp-auth-proxy's failed-login logging) if you want notifications rather than just a record.

## Best Practices for Deployment

- Run behind a reverse proxy or tunnel with TLS — never bind the port publicly in plaintext.
- Generate the token with the provided crypto snippet (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`) — don't hand-pick a short or guessable secret.
- Rotate `ATLAS_TOKEN` if you suspect exposure (e.g. it was committed, logged, or shared). Since v2, scope a rotated token narrowly (`work`, `personal`, or `shared`) rather than reissuing a token with broader reach than the caller needs.
- Back up `data/atlas.db` regularly, and encrypt backups if they leave the host.
- Keep Node.js updated (Node 22+ required for built-in `node:sqlite`); apply OS security patches on the host.
- If exposing to multiple users, use mcp-auth-proxy (or similar) rather than sharing one `ATLAS_TOKEN` among them.

## Scope

This policy covers the Atlas-MCP server code in this repository. It does not cover the security of third-party components you choose to run alongside it (reverse proxies, tunnels, auth gateways, host OS) — follow their respective security guidance separately.
