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

// ATLAS_TOKEN is one or more "caller:secret" pairs, comma-separated. A request is
// authorized if its token matches any secret; the matched caller name is attached to
// the request. A single caller is fine (the section param on every tool already
// separates the "work" and "personal" tables), but the format supports more.
const TOKENS = {};
ATLAS_TOKEN.split(',').forEach((entry) => {
  const [caller, secret] = entry.trim().split(':');
  if (caller && secret) TOKENS[secret] = caller;
});

function identifyCaller(token) {
  return TOKENS[token] || null;
}

function authCheck(req, res, next) {
  const token = req.headers['x-atlas-token'] || req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  const caller = identifyCaller(token);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });
  req.caller = caller;
  next();
}

const app = express();
app.use(express.json());

const ATLAS_INSTRUCTIONS = `Atlas is shared memory for Claude across conversations, split into "work" and
"personal" sections (work and personal Claude projects each have their own data, but use
this same connector/token - the project's custom instructions say which section is yours,
e.g. "Your Atlas section is personal").

At the start of every conversation, call get_landscape with your section to see the
current state - don't ask the user to repeat context that's already there.

As things change during the conversation, proactively (without being asked):
- upsert_entity / add_observation to record or update current state
- remove_observation / remove_entity to clear out stuff that's stale or done
- log_event for notable things that happened

Only read or write the other section if the user explicitly says so (e.g. "go look at
work for X" or "write that for work too").`;

app.post('/atlas-mcp', authCheck, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: 'atlas', version: '1.0.0' }, { instructions: ATLAS_INSTRUCTIONS });
  registerTools(server);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'atlas-mcp', port: PORT }));

app.listen(PORT, () => console.log('atlas-mcp running on port ' + PORT));
