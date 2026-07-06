const { z } = require('zod');
const db = require('./db');

const SECTION = z.enum(['work', 'personal']).describe(
  'Which section of Atlas to operate on. Use your own default section unless the user has explicitly told you to read or write the other one.'
);

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function registerTools(server) {
  server.registerTool('get_landscape', {
    title: 'Get landscape',
    description:
      'Get the current state of a section: every known entity (topic/project) and its observations (facts), ' +
      'plus any due reminders (trigger_date today or earlier, not yet dismissed). ' +
      'Call this at the start of a conversation to get oriented on what is going on. ' +
      'If reminders come back non-empty, surface them to the user near the top of your reply - ' +
      'that is the whole point of a reminder. Dismiss one with dismiss_reminder once handled or acknowledged.',
    inputSchema: { section: SECTION },
  }, async ({ section }) => {
    return json(db.getLandscape(section));
  });

  server.registerTool('get_entity', {
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

  server.registerTool('upsert_entity', {
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

  server.registerTool('remove_entity', {
    title: 'Remove entity',
    description:
      'Delete a topic/project entirely, including all of its observations. Use when something is fully done and no longer relevant.',
    inputSchema: {
      section: SECTION,
      name: z.string().describe('Entity name to delete.'),
    },
  }, async ({ section, name }) => {
    const ok = db.removeEntity(section, name);
    return text(ok ? `Removed "${name}" from ${section}.` : `No entity named "${name}" in ${section}.`);
  });

  server.registerTool('add_observation', {
    title: 'Add observation',
    description:
      'Add a fact to a topic/project. Creates the entity if it does not exist yet. ' +
      'Use this to record current state, e.g. "deployed on port 8080" or "waiting on vendor callback".',
    inputSchema: {
      section: SECTION,
      entity: z.string().describe('Entity name this observation belongs to.'),
      content: z.string().describe('The fact itself, written plainly.'),
    },
  }, async ({ section, entity, content }) => {
    return json(db.addObservation(section, entity, content));
  });

  server.registerTool('remove_observation', {
    title: 'Remove observation',
    description:
      'Delete a single observation by id (get the id from get_landscape or get_entity first). ' +
      'Use this to clean up facts that are now stale or wrong.',
    inputSchema: {
      section: SECTION,
      observation_id: z.number().int().describe('The id of the observation to remove.'),
    },
  }, async ({ section, observation_id }) => {
    const ok = db.removeObservation(section, observation_id);
    return text(ok ? `Removed observation ${observation_id}.` : `No observation ${observation_id} found in ${section}.`);
  });

  server.registerTool('log_event', {
    title: 'Log event',
    description:
      'Append a one-line entry to the history log. Use for things that happened ' +
      '("shipped v2.0", "migrated the database to Postgres"). ' +
      'Optionally link it to an entity/topic.',
    inputSchema: {
      section: SECTION,
      content: z.string().describe('What happened, written plainly.'),
      entity: z.string().optional().describe('Optional entity/topic name to link this event to.'),
    },
  }, async ({ section, content, entity }) => {
    return json(db.logEvent(section, content, entity));
  });

  server.registerTool('get_history', {
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

  server.registerTool('search', {
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

  server.registerTool('create_reminder', {
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

  server.registerTool('list_reminders', {
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

  server.registerTool('dismiss_reminder', {
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

  server.registerTool('remove_reminder', {
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
