const { z } = require('zod');
const db = require('./db');

const SECTION = z.enum(['work', 'personal', 'shared']).describe(
  'Which section of Atlas to operate on. Your token reaches its own section plus "shared"; anything else is refused server-side (403).'
);

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function denied(auth, section) {
  return {
    isError: true,
    content: [{ type: 'text', text: `403: token "${auth.caller}" (scope: ${auth.scope}) cannot access section "${section}". Allowed sections: ${auth.sections.join(', ')}.` }],
  };
}

// ---------------------------------------------------------------------------
// Time footer: every tool response carries fresh server time + elapsed time
// since the token's last call. Push-based clock — the client model never has
// to remember to ask what time it is.
// ---------------------------------------------------------------------------
function fmtEastern(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}

function timeLine(caller, prevTs) {
  const now = new Date();
  let line = `server_time: ${fmtEastern(now)}`;
  if (prevTs) {
    const prev = new Date(prevTs.replace(' ', 'T') + 'Z');
    line += ` | since your last Atlas call: ${fmtElapsed(now - prev)}`;
  } else {
    line += ` | first Atlas call from this token`;
  }
  return line;
}

function withFooter(result, caller, prevTs) {
  try {
    if (result && Array.isArray(result.content)) {
      result.content.push({ type: 'text', text: `[${timeLine(caller, prevTs)}]` });
    }
  } catch (e) { /* footer must never break a response */ }
  return result;
}

// registerTools is called per-request with the authenticated token's identity.
// Every tool that takes a section is scope-checked here, server-side, and the
// call (allowed or denied) is written to audit_log.
function registerTools(server, auth) {
  function guarded(name, config, handler) {
    server.registerTool(name, config, async (args) => {
      const section = args.section;
      const allowed = auth.sections.includes(section);
      const prev = db.lastCallTime(auth.caller);
      db.audit(auth.caller, name, section, allowed, allowed ? summarize(args) : 'DENIED out-of-scope');
      if (!allowed) return denied(auth, section);
      const result = await handler(args);
      return withFooter(result, auth.caller, prev);
    });
  }

  function summarize(args) {
    const parts = [];
    if (args.entity) parts.push(`entity=${args.entity}`);
    if (args.name) parts.push(`name=${args.name}`);
    if (args.observation_id !== undefined) parts.push(`obs=${args.observation_id}`);
    if (args.reminder_id !== undefined) parts.push(`rem=${args.reminder_id}`);
    if (args.query) parts.push(`q=${args.query}`);
    return parts.join(' ') || null;
  }

  // get_time: unguarded (no section), still audited. Cheap clock check for
  // turns that involve dates/elapsed time without another Atlas touch.
  server.registerTool('get_time', {
    title: 'Get time',
    description:
      'Get the current date and time (America/New_York) plus elapsed time since your last Atlas call. ' +
      'Very cheap. Call this on any turn involving dates, scheduling, or elapsed time when you have not ' +
      'already touched Atlas this turn — never do date math from memory.',
    inputSchema: {},
  }, async () => {
    const prev = db.lastCallTime(auth.caller);
    db.audit(auth.caller, 'get_time', null, true, null);
    return text(timeLine(auth.caller, prev));
  });

  guarded('get_landscape', {
    title: 'Get landscape',
    description:
      'Get the current state of a section: every known entity (topic/project) and its observations (facts), ' +
      'plus any due reminders (trigger_date today or earlier, not yet dismissed). ' +
      'The "shared" section is automatically merged in - entities and reminders are tagged with their origin section. ' +
      'Call this at the start of a conversation to get oriented on what is going on. ' +
      'If reminders come back non-empty, surface them to the user near the top of your reply - ' +
      'that is the whole point of a reminder. Dismiss one with dismiss_reminder once handled or acknowledged.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    return json(db.getLandscape(section));
  });

  guarded('get_entity', {
    title: 'Get entity',
    description:
      'Get full detail on one topic/project: its summary, all observations, and recent events. ' +
      'Use this when asked to "look at X".',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name, e.g. "Home Network" or "Q3 Planning".'),
    },
  }, async ({ section, name }) => {
    const entity = db.getEntity(section, name);
    if (!entity) return text(`No entity named "${name}" in ${section}.`);
    return json(entity);
  });

  guarded('upsert_entity', {
    title: 'Create or update entity',
    description:
      'Create a new topic/project, or update its one-line summary. Does not touch its observations.',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name.'),
      summary: z.string().optional().describe('Short one-line summary of what this entity is / current status.'),
    },
  }, async ({ section, name, summary }) => {
    return json(db.upsertEntity(section, name, summary));
  });

  guarded('remove_entity', {
    title: 'Remove entity',
    description:
      'Delete a topic/project entirely, including all of its observations. Refuses if the entity ' +
      'contains any protected observations - unprotect them first if the deletion is really intended.',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name to delete.'),
    },
  }, async ({ section, name }) => {
    const r = db.removeEntity(section, name);
    if (r.ok) return text(`Removed "${name}" from ${section}.`);
    if (r.reason === 'protected') return text(`Refused: "${name}" contains ${r.count} protected observation(s). Unprotect them first if you really mean to delete this entity.`);
    return text(`No entity named "${name}" in ${section}.`);
  });

  guarded('add_observation', {
    title: 'Add observation',
    description:
      'Add a fact to a topic/project. Creates the entity if it does not exist yet. ' +
      'Use this to record current state, e.g. "deployed on port 7782" or "waiting on vendor callback".',
    inputSchema: {
      section: SECTION,
      entity: z.string().describe('Entity name this observation belongs to.'),
      content: z.string().describe('The fact itself, written plainly.'),
    },
  }, async ({ section, entity, content }) => {
    return json(db.addObservation(section, entity, content));
  });

  guarded('update_observation', {
    title: 'Update observation',
    description:
      'Edit an observation in place: content changes, the ID stays stable for life, timestamp refreshes. ' +
      'Use this instead of delete-and-recreate when a fact evolves - it keeps observation IDs usable as ' +
      'permanent addresses (e.g. for skill files and standing rules). Allowed on protected observations.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to update.'),
      content: z.string().describe('The new full content (replaces the old content entirely).'),
    },
  }, async ({ section, observation_id, content }) => {
    const r = db.updateObservation(section, observation_id, content);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return json(r);
  });

  guarded('protect_observation', {
    title: 'Protect observation',
    description:
      'Mark an observation as protected: it can no longer be deleted (remove_observation refuses), only ' +
      'updated in place. Use for skill files, standing rules, permanent URLs, and incident lessons - ' +
      'anything where the cost of forgetting is high and the trigger to re-learn may never come.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to protect.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.setObservationProtected(section, observation_id, true);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return text(`Observation ${observation_id} (${r.entity}) is now protected.`);
  });

  guarded('unprotect_observation', {
    title: 'Unprotect observation',
    description:
      'Remove the protected flag from an observation so it can be deleted again. ' +
      'Only do this deliberately - protection exists so groom passes cannot silently destroy load-bearing facts.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to unprotect.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.setObservationProtected(section, observation_id, false);
    if (!r.ok) return text(`No observation ${observation_id} found in ${section}.`);
    return text(`Observation ${observation_id} (${r.entity}) is no longer protected.`);
  });

  guarded('remove_observation', {
    title: 'Remove observation',
    description:
      'Delete a single observation by id (get the id from get_landscape or get_entity first). ' +
      'Use this to clean up facts that are now stale or wrong. Refuses on protected observations - ' +
      'update them instead, or unprotect first if deletion is truly intended.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to remove.'),
    },
  }, async ({ section, observation_id }) => {
    const r = db.removeObservation(section, observation_id);
    if (r.ok) return text(`Removed observation ${observation_id}.`);
    if (r.reason === 'protected') return text(`Refused: observation ${observation_id} is protected. Use update_observation to change it, or unprotect_observation first if you really mean to delete it.`);
    return text(`No observation ${observation_id} found in ${section}.`);
  });

  guarded('log_event', {
    title: 'Log event',
    description:
      'Append a one-line entry to the history log. Use for things that happened ' +
      '("shipped v2.0", "migrated DB to Postgres"). ' +
      'Optionally link it to an entity/topic.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('What happened, written plainly.'),
      entity: z.string().optional().describe('Optional entity/topic name to link this event to.'),
    },
  }, async ({ section, content, entity }) => {
    return json(db.logEvent(section, content, entity));
  });

  guarded('get_history', {
    title: 'Get history',
    description:
      'Get recent history log entries for a section, optionally filtered to one entity/topic.',
    inputSchema: {
      section: SECTION,
      limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 20).'),
      entity: z.string().optional().describe('Optional entity/topic name to filter to.'),
    },
  }, async ({ section, limit, entity }) => {
    return json(db.getHistory(section, limit, entity));
  });

  guarded('search', {
    title: 'Search',
    description:
      'Search entities, observations, and history events for a keyword. Use when you need ' +
      'to find something but do not know the exact entity name.',
    inputSchema: {
      section: SECTION,
      query: z.string().describe('Keyword or phrase to search for.'),
    },
  }, async ({ section, query }) => {
    return json(db.search(section, query));
  });

  guarded('create_reminder', {
    title: 'Create reminder',
    description:
      'Create a time-based reminder that will automatically appear in get_landscape output ' +
      'on or after its trigger date - no need for the user to bring it up again. ' +
      'Use for things like cert/license expirations, "start flagging X on date Y", or anything ' +
      'with a known future date it should resurface on.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('The reminder text, written plainly, e.g. "TLS cert expires September 2026 - action needed."'),
      trigger_date: z.string().describe('Date (YYYY-MM-DD) on or after which this reminder should start appearing in get_landscape.'),
      entity: z.string().optional().describe('Optional entity/topic name to link this reminder to.'),
    },
  }, async ({ section, content, trigger_date, entity }) => {
    return json(db.createReminder(section, content, trigger_date, entity));
  });

  guarded('list_reminders', {
    title: 'List reminders',
    description:
      'List reminders for a section, including ones not yet due. Use this to check what is ' +
      'scheduled, or pass include_dismissed to see resolved ones too. get_landscape only shows ' +
      'reminders that are already due - use this tool for the full picture.',
    inputSchema: {
      section: SECTION,
      include_dismissed: z.boolean().optional().describe('Include dismissed reminders too (default false).'),
    },
  }, async ({ section, include_dismissed }) => {
    return json(db.listReminders(section, include_dismissed));
  });

  guarded('dismiss_reminder', {
    title: 'Dismiss reminder',
    description:
      'Mark a reminder as handled/acknowledged so it stops appearing in get_landscape. ' +
      'Get the id from get_landscape (for due ones) or list_reminders (for any). ' +
      'This keeps the reminder around (dismissed) rather than deleting it - use remove_reminder ' +
      'if it should be gone entirely.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the reminder to dismiss.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.dismissReminder(section, reminder_id);
    return text(ok ? `Dismissed reminder ${reminder_id}.` : `No active reminder ${reminder_id} found in ${section}.`);
  });

  guarded('remove_reminder', {
    title: 'Remove reminder',
    description: 'Permanently delete a reminder (dismissed or not). Use dismiss_reminder instead if you just want it to stop showing up but keep a record.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the reminder to delete.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.removeReminder(section, reminder_id);
    return text(ok ? `Removed reminder ${reminder_id}.` : `No reminder ${reminder_id} found in ${section}.`);
  });
}

module.exports = { registerTools };
