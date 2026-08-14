const { z } = require('zod');
const db = require('./db');
const tz = require('./tz');

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
  let line = `server_time: ${tz.format(now)}`;
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
    if (Array.isArray(args.ids)) parts.push(`ids=${args.ids.join(',')}`);
    if (args.reminder_id !== undefined) parts.push(`rem=${args.reminder_id}`);
    if (args.pending_id !== undefined) parts.push(`tray=${args.pending_id}`);
    if (args.research_id !== undefined) parts.push(`shelf=${args.research_id}`);
    if (args.query) parts.push(`q=${args.query}`);
    return parts.join(' ') || null;
  }

  // get_time: unguarded (no section), still audited. Cheap clock check for
  // turns that involve dates/elapsed time without another Atlas touch.
  server.registerTool('get_time', {
    title: 'Get time',
    description:
      `Get the current date and time (${tz.TZ}) plus elapsed time since your last Atlas call. ` +
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
      'any due reminders (trigger_date today or earlier, not yet dismissed), every untriaged tray item, ' +
      'and a count of open shelf ideas. ' +
      'The "shared" section is automatically merged in - entities, reminders and tray items are tagged with their origin section. ' +
      'Call this at the start of a conversation to get oriented on what is going on. ' +
      'If reminders come back non-empty, surface them to the user near the top of your reply - ' +
      'that is the whole point of a reminder. Dismiss one with dismiss_reminder once handled or acknowledged. ' +
      'If the tray is non-empty, mention that items are waiting for triage (briefly - it is not the agenda) ' +
      'and offer to work through them. The shelf count is context only: mention it if it is relevant, ' +
      'but never push the user to act on ideas - the shelf has no deadlines.',
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

  // get_observation is registered directly rather than through guarded(): it
  // takes no section, because scope is resolved from each row's OWN section.
  server.registerTool('get_observation', {
    title: 'Get observation by id',
    description:
      'Fetch 1-20 observations directly by their id. Observation ids are stable and never reused, ' +
      'which makes them the cheapest way to hand specific facts from one conversation to the next: ' +
      'cite the ids in a handoff, then fetch exactly those instead of re-reading a whole entity. ' +
      'Ids you cannot reach - out of scope, deleted, or never issued - come back in "missing", ' +
      'with no way to tell those cases apart.',
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(20).describe('Observation ids to fetch, e.g. [412, 87].'),
    },
  }, async ({ ids }) => {
    const prev = db.lastCallTime(auth.caller);
    db.audit(auth.caller, 'get_observation', null, true, `ids=${ids.join(',')}`);
    return withFooter(json(db.getObservationsByIds(auth.sections, ids)), auth.caller, prev);
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
      'with a known future date it should resurface on. ' +
      'Add trigger_time to make it a TIMED reminder: it becomes due at that clock time and is ' +
      'meant to be delivered once by whatever polls list_due_reminders (a notifier, a cron job, ' +
      'a chat bot). Without trigger_time the reminder is passive - it waits in the landscape ' +
      'until it is dismissed.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('The reminder text, written plainly, e.g. "TLS cert expires September 2026 - action needed."'),
      trigger_date: z.string().describe('Date (YYYY-MM-DD) on or after which this reminder should start appearing in get_landscape.'),
      trigger_time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'trigger_time must be HH:MM (24h)').optional()
        .describe(`Optional HH:MM (24h), read in ${tz.TZ}. Makes this a timed reminder that is delivered once at that moment.`),
      entity: z.string().optional().describe('Optional entity/topic name to link this reminder to.'),
    },
  }, async ({ section, content, trigger_date, trigger_time, entity }) => {
    return json(db.createReminder(section, content, trigger_date, entity, trigger_time));
  });

  guarded('list_due_reminders', {
    title: 'List due reminders',
    description:
      'Everything currently due and not dismissed: passive reminders whose date has arrived ' +
      '(due until dismissed) plus timed reminders whose date and time have arrived and that have ' +
      'not been delivered yet. This is the endpoint an external notifier polls - it should deliver ' +
      'only the rows that carry a trigger_time, then call mark_reminder_fired on each so it lands once.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    return json(db.getDueReminders(section));
  });

  guarded('mark_reminder_fired', {
    title: 'Mark reminder fired',
    description:
      'Stamp a TIMED reminder as delivered so it never fires again. Call this right after actually ' +
      'delivering it. Passive reminders (no trigger_time) have no firing step - they stay due until ' +
      'dismissed, so use dismiss_reminder for those. Returns false if it was already stamped, which ' +
      'makes overlapping pollers safe.',
    inputSchema: {
      section: SECTION,
      reminder_id: z.number().int().describe('The id of the timed reminder that was just delivered.'),
    },
  }, async ({ section, reminder_id }) => {
    const ok = db.markReminderFired(section, reminder_id);
    return text(ok
      ? `Reminder ${reminder_id} stamped as fired.`
      : `Reminder ${reminder_id} was already fired, or does not exist in ${section}.`);
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

  // -------------------------------------------------------------------------
  // THE TRAY - capture now, decide later.
  // -------------------------------------------------------------------------

  guarded('pending_add', {
    title: 'Add to tray',
    description:
      'Drop something into the tray: a message, a request, a half-finished thought, anything that ' +
      'arrived and needs triage but should not interrupt what is happening now. Capturing is cheap ' +
      'and reversible - when in doubt, put it in the tray rather than deciding on the spot.',
    inputSchema: {
      section: SECTION,
      summary: z.string().describe('One line describing what arrived, in plain language.'),
      source: z.string().optional().describe('Where it came from, your own vocabulary, e.g. "email", "meeting", "shower thought" (default "manual").'),
      source_ref: z.string().optional().describe('Optional pointer back to the original: a URL, a message id, a file path.'),
      source_date: z.string().optional().describe('Optional date the item originally arrived (YYYY-MM-DD).'),
    },
  }, async ({ section, summary, source, source_ref, source_date }) => {
    return json(db.addPendingItem(section, summary, { source, source_ref, source_date }));
  });

  guarded('pending_list', {
    title: 'List tray',
    description:
      'List untriaged tray items, oldest first, with a "pos" field - the position is the number to ' +
      'speak in conversation ("tray 3"), so it stays readable as ids grow. Resolved items are hidden; ' +
      'the tray shows only what still needs a decision.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    const items = db.listPending(section).map((item, i) => ({ pos: i + 1, ...item }));
    return json(items);
  });

  guarded('pending_promote', {
    title: 'Promote tray item to memory',
    description:
      'Turn a tray item into a durable observation on an entity - the capture stops being noise and ' +
      'becomes something Claude will read back in future conversations. The tray row records which ' +
      'observation it became.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int().describe('The id of the tray item to promote.'),
      entity: z.string().describe('Entity/topic the resulting observation belongs to (created if new).'),
      content: z.string().optional().describe('Optional rewritten text for the observation. Defaults to the tray item summary - rewrite it if the raw capture would not read well in six months.'),
    },
  }, async ({ section, pending_id, entity, content }) => {
    return json(db.promotePending(section, pending_id, entity, content));
  });

  guarded('pending_merge', {
    title: 'Merge tray item',
    description:
      'Fold a duplicate tray item into the one you are keeping. The merged item stops showing up but ' +
      'is not deleted - it records what it was merged into.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int().describe('The id of the duplicate to fold away.'),
      into_id: z.number().int().describe('The id of the tray item to keep.'),
      note: z.string().optional().describe('Optional note about why these are the same thing.'),
    },
  }, async ({ section, pending_id, into_id, note }) => {
    return json(db.mergePending(section, pending_id, into_id, note));
  });

  guarded('pending_dismiss', {
    title: 'Dismiss tray item',
    description:
      'Decide a tray item needs nothing. It leaves the tray but stays on record with the reason - ' +
      '"we looked and chose not to" is worth keeping.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int().describe('The id of the tray item to dismiss.'),
      note: z.string().optional().describe('Optional reason it needs nothing.'),
    },
  }, async ({ section, pending_id, note }) => {
    return json(db.resolvePending(section, pending_id, 'dismissed', { resolution_note: note }));
  });

  guarded('pending_reopen', {
    title: 'Reopen tray item',
    description: 'Put a resolved tray item back in the tray. Triage mistakes should be cheap to undo.',
    inputSchema: {
      section: SECTION,
      pending_id: z.number().int().describe('The id of the tray item to reopen.'),
    },
  }, async ({ section, pending_id }) => {
    return json(db.reopenPending(section, pending_id));
  });

  // -------------------------------------------------------------------------
  // THE SHELF - ideas with no deadline.
  // -------------------------------------------------------------------------

  guarded('research_add', {
    title: 'Add to shelf',
    description:
      'Park an idea or loose thread on the shelf. This is deliberately NOT work: no date, no ' +
      'pressure, no expectation it ever happens. Use it for "someday", "worth a look", "I wonder ' +
      'if" - the things that get lost because they are not urgent enough to write down anywhere else.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('The idea, in your own words. Rough is fine.'),
    },
  }, async ({ section, content }) => {
    return json(db.addResearchItem(section, content));
  });

  guarded('research_list', {
    title: 'List shelf',
    description:
      'List open shelf items, oldest first, with a "pos" field to speak in conversation ("idea 2"). ' +
      'An item sitting here a long time is not a backlog problem - the shelf has no deadlines. ' +
      'Do not nudge the user about age.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    const items = db.listResearch(section).map((item, i) => ({ pos: i + 1, ...item }));
    return json(items);
  });

  guarded('research_promote', {
    title: 'Promote shelf item',
    description:
      'Graduate an idea from the shelf into the tray: it has stopped being a maybe and now needs ' +
      'triage like anything else that arrived.',
    inputSchema: {
      section: SECTION,
      research_id: z.number().int().describe('The id of the shelf item to graduate.'),
      note: z.string().optional().describe('Optional note about what changed to make this real.'),
    },
  }, async ({ section, research_id, note }) => {
    return json(db.promoteResearch(section, research_id, note));
  });

  guarded('research_kill', {
    title: 'Kill shelf item',
    description:
      'Retire an idea on purpose. Killing is a real outcome, not a failure - record why, so the same ' +
      'idea does not get re-litigated from scratch in six months.',
    inputSchema: {
      section: SECTION,
      research_id: z.number().int().describe('The id of the shelf item to retire.'),
      note: z.string().optional().describe('Why it is dead. Worth writing - this is the part future-you wants.'),
    },
  }, async ({ section, research_id, note }) => {
    return json(db.killResearch(section, research_id, note));
  });

  guarded('research_reopen', {
    title: 'Reopen shelf item',
    description: 'Put a promoted or killed idea back on the shelf.',
    inputSchema: {
      section: SECTION,
      research_id: z.number().int().describe('The id of the shelf item to reopen.'),
    },
  }, async ({ section, research_id }) => {
    return json(db.reopenResearch(section, research_id));
  });
}

module.exports = { registerTools };
