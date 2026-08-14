require('dotenv').config({ quiet: true });

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./tools');

const PORT = process.env.PORT || 7784;

// ---------------------------------------------------------------------------
// First run: with no ATLAS_TOKEN set, generate one token per scope, save them
// beside the database, and print them. Atlas is usable from `docker run` with
// no configuration at all, and the tokens survive restarts because they live
// in the data volume - not regenerated every boot, which would silently break
// every client that had already connected.
//
// Set ATLAS_TOKEN in the environment and this path is never taken.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const fsBoot = require('node:fs');
const pathBoot = require('node:path');

const DB_PATH = process.env.ATLAS_DB_PATH || pathBoot.join(__dirname, '..', 'data', 'atlas.db');
const TOKEN_FILE = pathBoot.join(pathBoot.dirname(DB_PATH), 'first-run-tokens.txt');

function bootstrapTokens() {
  if (fsBoot.existsSync(TOKEN_FILE)) {
    const saved = fsBoot.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) {
      console.log(`atlas: using generated tokens from ${TOKEN_FILE} (set ATLAS_TOKEN to take over)`);
      return saved;
    }
  }
  const secret = () => crypto.randomBytes(24).toString('hex');
  const generated = ['work', 'personal', 'shared'].map((scope) => `${scope}-client:${secret()}:${scope}`).join(',');
  fsBoot.mkdirSync(pathBoot.dirname(TOKEN_FILE), { recursive: true });
  fsBoot.writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 });

  console.log('');
  console.log('  No ATLAS_TOKEN was set, so Atlas generated one token per scope.');
  console.log(`  Saved to ${TOKEN_FILE} - they will be reused on the next start.`);
  console.log('');
  for (const entry of generated.split(',')) {
    const [caller, tokenSecret, scope] = entry.split(':');
    console.log(`    ${scope.padEnd(8)} ${tokenSecret}   (caller "${caller}")`);
  }
  console.log('');
  console.log(`  Connect a client to:  http://localhost:${PORT}/atlas-mcp?token=<one of the above>`);
  console.log('  A "work" token reaches the work and shared sections, and so on.');
  console.log('');
  return generated;
}

const ATLAS_TOKEN = process.env.ATLAS_TOKEN || bootstrapTokens();

// v2 token format: "caller:secret:scope" pairs, comma-separated.
// scope is one of: work | personal | shared
//   work     -> may access sections: work, shared
//   personal -> may access sections: personal, shared
//   shared   -> may access sections: shared only
// Enforcement is SERVER-SIDE on every tool call - a token can never reach a
// section outside its scope, regardless of what the client asks for.
// (v1 format "caller:secret" is rejected at startup - scope is mandatory in v2.)
const SCOPE_SECTIONS = {
  work: ['work', 'shared'],
  personal: ['personal', 'shared'],
  shared: ['shared'],
};

const TOKENS = {};
let tokenParseError = false;
ATLAS_TOKEN.split(',').forEach((entry) => {
  const parts = entry.trim().split(':');
  if (parts.length !== 3) {
    console.error(`FATAL: token entry "${parts[0] || entry}" is not in caller:secret:scope format`);
    tokenParseError = true;
    return;
  }
  const [caller, secret, scope] = parts;
  if (!SCOPE_SECTIONS[scope]) {
    console.error(`FATAL: token entry "${caller}" has unknown scope "${scope}"`);
    tokenParseError = true;
    return;
  }
  TOKENS[secret] = { caller, scope, sections: SCOPE_SECTIONS[scope] };
});
if (tokenParseError || Object.keys(TOKENS).length === 0) process.exit(1);

function identifyCaller(token) {
  return TOKENS[token] || null;
}

function authCheck(req, res, next) {
  const token = req.headers['x-atlas-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  const auth = identifyCaller(token);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = auth;
  next();
}

const app = express();
app.use(express.json());

const ATLAS_INSTRUCTIONS = `Atlas is shared memory for Claude across conversations, split into "work",
"personal", and "shared" sections. Your token is scoped: it can reach its own
section plus "shared", and the server refuses (403) anything else - so use the
section your project instructions name, plus "shared" for cross-context material
like skill files.

At the start of every conversation, call get_landscape with your section to see
the current state - don't ask the user to repeat context that's already there.

As things change during the conversation, proactively (without being asked):
- upsert_entity / add_observation to record or update current state
- update_observation to revise a fact in place (ID stays stable)
- remove_observation / remove_entity to clear out stuff that's stale or done
- log_event for notable things that happened

Observations marked protected cannot be deleted, only updated. Protect facts
whose loss would be costly and hard to notice: skill files, standing rules,
permanent URLs, incident lessons.

Two staging areas feed that memory, and neither is a to-do list:
- the TRAY (pending_*) holds things that arrived and still need triage. When
  something comes up mid-conversation that should not derail it, capture it
  there instead of deciding on the spot, then promote it into an observation
  once it is worth keeping. Untriaged items come back in get_landscape, so say
  when something is waiting - briefly, and never as the agenda.
- the SHELF (research_*) holds the user's own ideas. No dates, no nudging, no
  aging - an idea sitting there for a year is fine. get_landscape reports only
  how many are open; use research_list when the user asks. It leaves by
  graduating to the tray or by being killed on purpose, with the reason
  recorded.`;

app.post('/atlas-mcp', authCheck, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: 'atlas', version: '2.0.0' }, { instructions: ATLAS_INSTRUCTIONS });
  registerTools(server, req.auth);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-mcp', version: 2, port: PORT }));

// ---------------------------------------------------------------------------
// Groom scheduler: in-image, no host cron dependency. Every 5 minutes, if the
// local hour (ATLAS_TZ) has reached ATLAS_GROOM_HOUR and the groom has not yet
// run today (groom_meta), spawn src/groom.js as a child process. Self-healing:
// a missed window (container down, host reboot) runs at the first check after
// it comes back.
// ---------------------------------------------------------------------------
const { spawn } = require('node:child_process');
const dbMod = require('./db');
const tz = require('./tz');
let groomRunning = false;

// Hour of the local day (ATLAS_TZ) the nightly groom is allowed to start.
const GROOM_HOUR = Math.min(23, Math.max(0, parseInt(process.env.ATLAS_GROOM_HOUR || '4', 10) || 0));

setInterval(() => {
  try {
    const date = tz.today();
    const hour = tz.hour();
    if (hour < GROOM_HOUR || groomRunning) return;
    if (dbMod.getGroomMeta('last_groom_date') === date) return;
    groomRunning = true;
    dbMod.setGroomMeta('last_groom_date', date);
    console.log(`groom scheduler: starting nightly groom for ${date}`);
    const child = spawn(process.execPath, [require('node:path').join(__dirname, 'groom.js')], { stdio: 'inherit' });
    child.on('exit', (code) => {
      groomRunning = false;
      console.log(`groom scheduler: groom exited with code ${code}`);
    });
  } catch (e) {
    groomRunning = false;
    console.error('groom scheduler error:', e.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`atlas-mcp running on port ${PORT} (timezone ${tz.TZ})`));
