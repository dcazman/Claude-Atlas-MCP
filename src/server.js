require('dotenv').config({ quiet: true });

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./tools');

const PORT = process.env.PORT || 7784;
const ATLAS_TOKEN = process.env.ATLAS_TOKEN;

if (!ATLAS_TOKEN) {
  console.error('FATAL: ATLAS_TOKEN not set');
  process.exit(1);
}

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
permanent URLs, incident lessons.`;

app.post('/atlas-mcp', authCheck, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: 'atlas', version: '2.0.0' }, { instructions: ATLAS_INSTRUCTIONS });
  registerTools(server, req.auth);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-mcp', version: 2, port: PORT }));

// ---------------------------------------------------------------------------
// Groom scheduler: in-image, no host cron dependency. Every 5 minutes, if it
// is past 4am ET and the groom has not yet run today (groom_meta), spawn
// src/groom.js as a child process. Self-healing: a missed 4am window (container
// down, host reboot) runs at the first check after it comes back.
// ---------------------------------------------------------------------------
const { spawn } = require('node:child_process');
const dbMod = require('./db');
let groomRunning = false;

function easternNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24 };
}

setInterval(() => {
  try {
    const { date, hour } = easternNow();
    if (hour < 4 || groomRunning) return;
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

app.listen(PORT, () => console.log('atlas-mcp v2 running on port ' + PORT));
