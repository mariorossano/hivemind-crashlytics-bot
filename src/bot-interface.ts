import { z } from 'zod/v3';
import { CrashlyticsBot } from './runtime.ts';
import { assertProject, projectBinding } from './profile.ts';
import { botStatus } from './bot-status.ts';

const inputSchema = z
  .object({
    tool: z.enum(['connect', 'status', 'start', 'stop', 'follow', 'unfollow', 'retry']),
    projectId: z.string().min(1),
    botId: z.string().min(1),
    botName: z.string().min(1),
    arguments: z.record(z.unknown()),
    token: z.string().min(1).optional(),
  })
  .strict();

/** Canonical Hivemind bot entry point: fixed project/identity, no arbitrary commands, provider writes or chat intake. */
export async function invoke(home: string, raw: unknown) {
  const input = inputSchema.parse(raw);
  const bot = new CrashlyticsBot(home);
  try {
    if (!projectBinding(home)) throw new Error('Configure the project binding first');
    assertProject(home, input.projectId, bot.config.hiveUrl);
    if (input.tool === 'connect') {
      z.object({}).strict().parse(input.arguments);
      if (!input.token) throw new Error('A bot token is required');
      const release = bot.lock('setup');
      let hold = () => {};
      try {
        hold = bot.lock();
        bot.assertCurrentConfig();
        const current = bot.db.prepare('SELECT id FROM bots WHERE project=?').get(input.projectId);
        if (current && current.id !== input.botId)
          throw new Error('Profile already belongs to another bot');
        if (bot.db.prepare('SELECT 1 FROM bots WHERE project<>?').get(input.projectId))
          throw new Error('Profile belongs to another project');
        bot.db
          .prepare(
            'INSERT INTO bots(project,id,name,token) VALUES(?,?,?,?) ON CONFLICT(project) DO UPDATE SET name=excluded.name,token=excluded.token',
          )
          .run(input.projectId, input.botId, input.botName, input.token);
        return { connected: true };
      } finally {
        hold();
        release();
      }
    }
    if (input.token !== undefined) throw new Error('Credentials are only accepted by connect');
    const current = bot.db.prepare('SELECT id FROM bots WHERE project=?').get(input.projectId);
    if (!current || current.id !== input.botId) throw new Error('Connect this bot identity first');
    if (input.tool === 'status') return botStatus(bot, input.arguments);
    if (['start', 'stop'].includes(input.tool)) z.object({}).strict().parse(input.arguments);
    if (input.tool === 'start') {
      await bot.start();
      return { monitorRunning: true };
    }
    if (input.tool === 'stop') {
      bot.desired(false);
      return { stopRequested: true, monitorRunning: bot.isRunning() };
    }
    if (input.tool === 'follow') {
      const args = z
        .object({
          url: z.string().url(),
          channel: z.string().min(1),
          initial: z.enum(['snapshot', 'baseline']).default('snapshot'),
        })
        .strict()
        .parse(input.arguments);
      // Configure only. Starting/polling is an explicit separate action.
      const release = bot.lock('setup');
      let hold = () => {};
      try {
        hold = bot.lock();
        bot.assertCurrentConfig();
        return await bot.follow(args.url, args.channel, args.initial);
      } finally {
        hold();
        release();
      }
    }
    const args = z
      .object({ id: z.string().min(1) })
      .strict()
      .parse(input.arguments);
    const result = input.tool === 'retry' ? bot.retry(args.id) : bot.unfollow(args.id);
    return result;
  } finally {
    bot.close();
  }
}
