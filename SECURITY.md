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

- **Single shared-secret auth.** `ATLAS_TOKEN` (`caller:secret` pairs) is the only built-in authentication. It is not per-user, has no scopes, and has no rate limiting or lockout. Treat leaked tokens as a full compromise of that Atlas instance.
- **No built-in TLS.** The server listens over plain HTTP. It must sit behind HTTPS termination (reverse proxy, Cloudflare Tunnel, Tailscale, nginx, etc.). **Never expose the raw port to the internet without TLS in front of it.**
- **Recommended: a dedicated auth gateway.** For real access control (OAuth 2.1/OIDC, per-user identity, IdP-backed login), put [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) or an equivalent gateway in front rather than relying on the shared token alone.
- **`work` / `personal` section isolation is logical, not cryptographic.** Any caller holding a valid token can pass either `section` value — sections are a data-organization boundary, not a security boundary. Don't rely on them to separate trust levels between different users/tokens.
- **SQLite file is the entire data store.** Anyone with filesystem access to the `data/` volume (or a backup/snapshot of it) has full read/write access to all entities, observations, history, and reminders, in both sections. Protect the volume and any backups (e.g. encrypted at rest, restricted file permissions).
- **`.env` holds the token in plaintext.** Keep it out of version control (it's git-ignored by default via `.env.example`) and restrict file permissions on the host.
- **No input sanitization guarantees beyond standard parameterized SQLite queries.** Treat all tool inputs as untrusted if Atlas is ever exposed to more than one trusted caller.
- **No audit log of tool calls by default.** If you need to know who did what and when, add logging at the auth-gateway layer (e.g. mcp-auth-proxy's failed-login logging) rather than assuming Atlas itself records it.

## Best Practices for Deployment

- Run behind a reverse proxy or tunnel with TLS — never bind the port publicly in plaintext.
- Generate the token with the provided crypto snippet (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`) — don't hand-pick a short or guessable secret.
- Rotate `ATLAS_TOKEN` if you suspect exposure (e.g. it was committed, logged, or shared).
- Back up `data/atlas.db` regularly, and encrypt backups if they leave the host.
- Keep Node.js updated (Node 22+ required for built-in `node:sqlite`); apply OS security patches on the host.
- If exposing to multiple users, use mcp-auth-proxy (or similar) rather than sharing one `ATLAS_TOKEN` among them.

## Scope

This policy covers the Atlas-MCP server code in this repository. It does not cover the security of third-party components you choose to run alongside it (reverse proxies, tunnels, auth gateways, host OS) — follow their respective security guidance separately.
