import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { LocalHiveSession, hiveOrigin } from './hive-session.ts';
import { launchMonitor, acceptMonitorStart } from './monitor-startup.ts';
export { hiveOrigin } from './hive-session.ts';
import { assertProject, configureProfile } from './profile.ts';
import { setTimeout as delay } from 'node:timers/promises';
import {
  configSchema,
  definitionId,
  label,
  usageNotice,
  parseSource,
  read,
  inspect,
  type Config,
} from './provider.ts';
import { runCommand, type Runner } from './readers/process.ts';
import { excerpt, variantInventorySchema, type Snapshot } from './readers/config.ts';
import { loadArtifact, bundleArtifacts, partitionArtifacts, privateWrite } from './artifacts.ts';
import { readJsonInput } from './input.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subscription = {
  id: string;
  url: string;
  channel: string;
  bot: string;
  enabled: number;
  initialized: number;
  initial: string;
  next_at: number;
  failures: number;
};
type Bot = { id: string; name: string; token: string };
export function privateJson(file: string, value: unknown) {
  privateWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function init(home: string, input: unknown) {
  const config = configSchema.parse(input);
  config.hiveUrl = hiveOrigin(config.hiveUrl);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = path.join(home, 'config.json');
  let existing: string | undefined;
  try {
    existing = readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== undefined) {
    if (hash(configSchema.parse(JSON.parse(existing))) !== hash(config))
      throw new Error(
        'Profile already configured; choose a new --home for a different configuration',
      );
  } else {
    // Exclusive creation: a concurrent init must not overwrite a different profile.
    try {
      writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      return init(home, input);
    }
  }
  return { configured: true, home, bot: definitionId };
}
function brief(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError')
    return 'Provider response did not match the expected schema';
  return error instanceof Error ? error.message.slice(0, 240) : 'Operation failed';
}
function hasProfileIdentity(file: string) {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get() &&
      db.prepare("SELECT 1 FROM meta WHERE key='identity'").get(),
    );
  } finally {
    db.close();
  }
}
export class CrashlyticsBot {
  readonly config: Config;
  readonly session: LocalHiveSession;
  readonly db: DatabaseSync;
  constructor(
    readonly home: string,
    readonly runner: Runner = runCommand,
  ) {
    const file = path.join(home, 'state.db');
    // Serialize the first config read and retained identity write with configure.
    // An initialized profile has immutable identity: do not take setup here,
    // because a managed-start parent owns it while its child initializes, and
    // status/stop must remain available during that handshake.
    const release = hasProfileIdentity(file) ? undefined : this.lock('setup');
    let opened: DatabaseSync | undefined;
    try {
      this.config = configSchema.parse(
        JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')),
      );
      this.config.hiveUrl = hiveOrigin(this.config.hiveUrl);
      this.session = new LocalHiveSession(this.config.hiveUrl);
      this.db = opened = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bots(project TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL,token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,url TEXT NOT NULL,channel TEXT NOT NULL,bot TEXT NOT NULL,enabled INTEGER NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,initial TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_poll INTEGER,last_queued INTEGER,usage TEXT,warnings TEXT,UNIQUE(url,channel)); CREATE TABLE IF NOT EXISTS items(subscription TEXT NOT NULL,item TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(subscription,item)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,subscription TEXT NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL DEFAULT "pending",attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,messageid TEXT);'.replace(
          '"pending"',
          "'pending'",
        ),
      );
      const identity = hash([
        definitionId,
        this.config.hiveUrl,
        this.config.host,
        this.config.account,
        this.config.versions,
        this.config.minEvents,
        this.config.minUsers,
        this.config.notifyCounts,
      ]);
      const saved = this.db.prepare('SELECT value FROM meta WHERE key=?').get('identity') as any;
      if (saved && saved.value !== identity) {
        throw new Error('Profile belongs to a different Hivemind/provider host; use a new --home');
      }
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('identity', identity);
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS samples_seen(subscription TEXT NOT NULL,item TEXT NOT NULL,variant TEXT NOT NULL,PRIMARY KEY(subscription,item,variant)); CREATE TABLE IF NOT EXISTS event_files(event INTEGER PRIMARY KEY,artifact TEXT NOT NULL,attachment_id TEXT);',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS events_subscription_state ON events(subscription,state,id,next_at)',
      );
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS baseline_pending(subscription TEXT NOT NULL,item TEXT NOT NULL,PRIMARY KEY(subscription,item)); CREATE TABLE IF NOT EXISTS baseline_variants(subscription TEXT NOT NULL,item TEXT NOT NULL,variant TEXT NOT NULL,PRIMARY KEY(subscription,item,variant));',
      );
    } catch (error) {
      opened?.close();
      throw error;
    } finally {
      release?.();
    }
  }
  close() {
    this.db.close();
  }
  // Call only while setup is held (by this command or its managed-start parent).
  // Construction can precede a concurrent configure; never admit stale settings.
  assertCurrentConfig() {
    let current: Config;
    try {
      current = configSchema.parse(
        JSON.parse(readFileSync(path.join(this.home, 'config.json'), 'utf8')),
      );
      current.hiveUrl = hiveOrigin(current.hiveUrl);
    } catch {
      throw new Error(
        'Cannot validate current profile settings; check the profile and run the command again',
      );
    }
    if (hash(current) !== hash(this.config))
      throw new Error('Profile settings changed; run the command again');
  }
  async request(route: string, options: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const response = await this.session.request(route, options, signal);
    if (!response.ok) throw new Error('Hivemind HTTP ' + response.status);
    return response.json();
  }
  async follow(input: string, channelRef: string, initial = 'snapshot') {
    if (!['snapshot', 'baseline'].includes(initial))
      throw new Error('Initial mode must be snapshot or baseline');
    const source = parseSource(input, this.config);
    const snapshot = await this.request('/api/ui/snapshot');
    const channels = snapshot.channels.filter(
      (c: any) => c.id === channelRef || c.name === channelRef,
    );
    if (channels.length !== 1 || !['public', 'private'].includes(channels[0].type))
      throw new Error('Choose one exact public/private channel ID (or a unique name)');
    const channel = channels[0];
    assertProject(this.home, channel.projectId, this.config.hiveUrl);
    let bot = this.db
      .prepare('SELECT id,name,token FROM bots WHERE project=?')
      .get(channel.projectId) as Bot | undefined;
    const post = (body: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (bot) {
      const current = snapshot.agents.find((a: any) => a.id === bot!.id && a.role === 'bot');
      if (!current) throw new Error('Saved bot is unavailable; use a fresh bot profile');
      if (current.name !== bot.name) {
        this.db.prepare('UPDATE bots SET name=? WHERE id=?').run(current.name, bot.id);
        bot.name = current.name;
      }
      if (!channel.memberIds.includes(bot.id))
        await this.request(
          '/api/ui/channels/' + encodeURIComponent(channel.id) + '/invite',
          post({ names: [bot.name] }),
        );
    } else {
      const names = new Set(snapshot.agents.map((a: any) => String(a.name).toLowerCase()));
      let name = label;
      for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = label + '-' + suffix;
      const created = await this.request(
        '/api/ui/projects/' + encodeURIComponent(channel.projectId) + '/bots',
        post({ name }),
      );
      if (created.bot?.role !== 'bot' || typeof created.token !== 'string' || !created.token)
        throw new Error('Invalid bot registration receipt');
      bot = { id: created.bot.id, name: created.bot.name, token: created.token };
      this.db
        .prepare('INSERT INTO bots VALUES (?,?,?,?)')
        .run(channel.projectId, bot.id, bot.name, bot.token);
      // Save the identity before inviting: a failed invitation reuses this bot on retry.
      await this.request(
        '/api/ui/channels/' + encodeURIComponent(channel.id) + '/invite',
        post({ names: [bot.name] }),
      );
    }
    const id = hash([source.url, channel.id]).slice(0, 24);
    this.db
      .prepare(
        'INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES (?,?,?,?,1,?) ON CONFLICT(url,channel) DO UPDATE SET next_at=CASE WHEN subscriptions.enabled=0 THEN 0 ELSE subscriptions.next_at END,enabled=1',
      )
      .run(id, source.url, channel.id, bot.id, initial);
    return { id, source: source.url, channel: channel.id, bot: bot.name, state: 'following' };
  }
  unfollow(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('UPDATE subscriptions SET enabled=0 WHERE id=?').run(id).changes)
        throw new Error('Unknown subscription');
      this.db
        .prepare(
          "UPDATE events SET state='cancelled' WHERE subscription=? AND state IN ('pending','blocked')",
        )
        .run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, state: 'stopped' };
  }
  subscriptions() {
    return this.db
      .prepare('SELECT * FROM subscriptions ORDER BY id')
      .all() as unknown as Subscription[];
  }
  retry(id: string) {
    // Explicit operator recovery only: reconnect/start never retry denied writes.
    const release = this.lock('setup');
    let hold = () => {};
    try {
      this.assertCurrentConfig();
      try {
        hold = this.lock();
      } catch {
        throw new Error('Stop the monitor before retrying blocked deliveries');
      }
      if (!this.db.prepare('SELECT 1 FROM subscriptions WHERE id=? AND enabled=1').get(id))
        throw new Error('Unknown or disabled subscription');
      const result = this.db
        .prepare(
          "UPDATE events SET state='pending',next_at=0,error=NULL WHERE subscription=? AND state='blocked'",
        )
        .run(id);
      return { id, requeued: Number(result.changes), monitorRunning: false };
    } finally {
      hold();
      release();
    }
  }
  status() {
    return {
      bot: definitionId,
      home: this.home,
      monitorRunning: this.isRunning(),
      subscriptions: this.db
        .prepare(
          'SELECT id,url,channel,enabled,last_poll,last_queued,last_error,failures,next_at,usage,warnings FROM subscriptions ORDER BY id',
        )
        .all(),
      events: this.db.prepare('SELECT state,COUNT(*) AS count FROM events GROUP BY state').all(),
      deliveryErrors: this.db
        .prepare(
          'SELECT subscription,state,error,attempts,next_at FROM events WHERE error IS NOT NULL ORDER BY id LIMIT 50',
        )
        .all(),
    };
  }
  apply(sub: Subscription, snapshot: Snapshot) {
    this.db.exec('BEGIN IMMEDIATE');
    let queued = 0;
    try {
      const current = this.db
        .prepare('SELECT * FROM subscriptions WHERE id=?')
        .get(sub.id) as unknown as Subscription;
      if (!current.enabled) {
        this.db.exec('ROLLBACK');
        return 0;
      }
      const keys = new Set<string>();
      for (const observation of snapshot.observations) {
        if (keys.has(observation.key))
          throw new Error('Duplicate observation key in provider snapshot');
        keys.add(observation.key);
        const previous = this.db
          .prepare('SELECT hash,revision FROM items WHERE subscription=? AND item=?')
          .get(sub.id, observation.key) as any;
        const fingerprint = hash(observation.value);
        const inventory =
          observation.variants === undefined
            ? undefined
            : variantInventorySchema.parse(observation.variants);
        if (inventory && observation.samples?.some((sample) => !inventory.includes(sample.variant)))
          throw new Error('Sample outside complete variant inventory');
        if (!current.initialized && current.initial === 'baseline')
          this.db
            .prepare('INSERT OR IGNORE INTO baseline_pending VALUES (?,?)')
            .run(sub.id, observation.key);
        if (
          this.db
            .prepare('SELECT 1 FROM baseline_pending WHERE subscription=? AND item=?')
            .get(sub.id, observation.key)
        ) {
          // A real metadata change ends deferred baseline suppression immediately.
          // Otherwise the first complete inventory is the quiet variant baseline,
          // independently of which samples happen to download in that poll.
          if (previous && previous.hash !== fingerprint)
            this.db
              .prepare('DELETE FROM baseline_pending WHERE subscription=? AND item=?')
              .run(sub.id, observation.key);
          else if (inventory !== undefined) {
            for (const variant of inventory)
              this.db
                .prepare('INSERT OR IGNORE INTO baseline_variants VALUES (?,?,?)')
                .run(sub.id, observation.key, variant);
            this.db
              .prepare('DELETE FROM baseline_pending WHERE subscription=? AND item=?')
              .run(sub.id, observation.key);
          }
        }
        const variants = new Set<string>();
        const unseen = (observation.samples ?? []).filter((sample) => {
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(sample.variant) || variants.has(sample.variant))
            throw new Error('Invalid or duplicate stack variant');
          variants.add(sample.variant);
          return !this.db
            .prepare('SELECT 1 FROM samples_seen WHERE subscription=? AND item=? AND variant=?')
            .get(sub.id, observation.key, sample.variant);
        });
        const fresh = unseen.filter(
          (sample) =>
            !this.db
              .prepare(
                'SELECT 1 FROM baseline_variants WHERE subscription=? AND item=? AND variant=?',
              )
              .get(sub.id, observation.key, sample.variant),
        );
        if (previous?.hash === fingerprint && !unseen.length) continue;
        let revision = previous?.revision ?? 0;
        const origin = new URL(observation.url);
        if (
          origin.protocol !== 'https:' ||
          origin.host !== this.config.host ||
          origin.username ||
          origin.password
        )
          throw new Error('Provider returned an unexpected origin');
        if (
          (current.initialized || current.initial === 'snapshot') &&
          (previous?.hash !== fingerprint || fresh.length)
        ) {
          const batches = fresh.length ? partitionArtifacts(fresh.map((s) => s.artifact)) : [[]];
          for (const [part, batch] of batches.entries()) {
            revision++;
            const suffix = batch.length
              ? `\nAttached: ${batch.length} variant sample(s), one representative per variant. Open the TXT only when needed.` +
                (batches.length > 1 ? `\nStack attachment part ${part + 1}/${batches.length}.` : '')
              : '';
            const event = {
              eventId:
                definitionId +
                ':' +
                sub.id +
                ':' +
                hash(observation.key).slice(0, 24) +
                ':' +
                revision,
              body: excerpt(observation.body, 3600) + suffix,
              origin: {
                label,
                url: observation.url,
                ...(observation.author ? { author: observation.author.slice(0, 200) } : {}),
                ...(observation.occurredAt ? { occurredAt: observation.occurredAt } : {}),
              },
            };
            const inserted = this.db
              .prepare('INSERT INTO events(subscription,event) VALUES (?,?)')
              .run(sub.id, JSON.stringify(event));
            queued++;
            if (batch.length) {
              const artifact = bundleArtifacts(
                this.home,
                'crash-samples-' + hash(observation.key).slice(0, 16) + '.txt',
                batch,
              );
              this.db
                .prepare('INSERT INTO event_files(event,artifact) VALUES (?,?)')
                .run(inserted.lastInsertRowid, JSON.stringify(artifact));
            }
          }
        } else if (!previous) revision++;
        for (const sample of unseen)
          this.db
            .prepare('INSERT INTO samples_seen VALUES (?,?,?)')
            .run(sub.id, observation.key, sample.variant);
        this.db
          .prepare(
            'INSERT INTO items VALUES (?,?,?,?) ON CONFLICT(subscription,item) DO UPDATE SET hash=excluded.hash,revision=excluded.revision',
          )
          .run(sub.id, observation.key, fingerprint, revision);
      }
      this.db
        .prepare(
          'UPDATE subscriptions SET initialized=1,last_poll=?,last_queued=?,next_at=?,failures=0,last_error=NULL,usage=?,warnings=? WHERE id=?',
        )
        .run(
          Date.now(),
          queued,
          Date.now() + this.config.intervalSeconds * 1000,
          JSON.stringify(snapshot.usage ?? null),
          JSON.stringify(snapshot.warnings ?? []),
          sub.id,
        );
      this.db.exec('COMMIT');
      return queued;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async cycle(id?: string, dueOnly = false, signal?: AbortSignal, limit = Infinity) {
    let subs = this.subscriptions().filter((s) => s.enabled && (!id || s.id === id));
    if (id && !subs.length) throw new Error('Unknown or disabled subscription');
    if (dueOnly) subs = subs.filter((s) => s.next_at <= Date.now());
    subs = subs.slice(0, limit);
    const reads = new Map<string, Promise<Snapshot>>();
    const results: any[] = [];
    for (const sub of subs) {
      if (signal?.aborted) break;
      try {
        let promise = reads.get(sub.url);
        if (!promise) {
          promise = read(sub.url, this.config, this.home, this.runner, signal);
          reads.set(sub.url, promise);
        }
        const snapshot = await promise;
        signal?.throwIfAborted();
        results.push({
          id: sub.id,
          observed: snapshot.observations.length,
          queued: this.apply(sub, snapshot),
        });
      } catch (error) {
        if (signal?.aborted) break;
        const message = brief(error);
        const backoff = Math.min(
          86400000,
          this.config.intervalSeconds * 1000 * 2 ** Math.min(sub.failures, 8),
        );
        this.db
          .prepare('UPDATE subscriptions SET failures=failures+1,last_error=?,next_at=? WHERE id=?')
          .run(message, Date.now() + backoff, sub.id);
        results.push({ id: sub.id, error: message });
      }
    }
    await this.deliver(signal);
    return results;
  }
  async deliver(signal?: AbortSignal) {
    const now = Date.now();
    const jobs = this.db
      .prepare(
        `SELECT e.* FROM events e JOIN subscriptions s ON s.id=e.subscription
         WHERE s.enabled=1 AND e.state='pending' AND e.next_at<=?
           AND NOT EXISTS (
             SELECT 1 FROM events earlier
             WHERE earlier.subscription=e.subscription AND earlier.id<e.id
               AND (earlier.state='blocked' OR (earlier.state='pending' AND earlier.next_at>?))
           )
         ORDER BY e.id LIMIT 200`,
      )
      .all(now, now) as any[];
    for (const job of jobs) {
      if (signal?.aborted) break;
      const pending = () =>
        this.db
          .prepare(
            "SELECT 1 FROM events e JOIN subscriptions s ON s.id=e.subscription WHERE e.id=? AND e.state='pending' AND s.enabled=1",
          )
          .get(job.id);
      if (!pending()) continue;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM events WHERE subscription=? AND id<? AND state IN ('pending','blocked') LIMIT 1",
          )
          .get(job.subscription, job.id)
      )
        continue;
      const sub = this.db
        .prepare('SELECT * FROM subscriptions WHERE id=? AND enabled=1')
        .get(job.subscription) as unknown as Subscription | undefined;
      if (!sub) continue;
      const bot = this.db.prepare('SELECT * FROM bots WHERE id=?').get(sub.bot) as Bot;
      try {
        const event = JSON.parse(job.event);
        const file = this.db.prepare('SELECT * FROM event_files WHERE event=?').get(job.id) as any;
        if (file) {
          if (!file.attachment_id) {
            const artifact = JSON.parse(file.artifact),
              bytes = loadArtifact(this.home, artifact);
            const uploaded = await this.request(
              '/api/bot/files',
              {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + bot.token,
                  'Content-Type': 'application/octet-stream',
                  'X-File-Name': artifact.name,
                  'X-File-Mime': 'text/plain',
                },
                body: new Uint8Array(bytes),
              },
              signal,
            );
            if (
              typeof uploaded.file?.id !== 'string' ||
              !uploaded.file.id ||
              uploaded.file.bytes !== bytes.length
            )
              throw new Error('Invalid attachment upload receipt');
            file.attachment_id = uploaded.file.id;
            this.db
              .prepare('UPDATE event_files SET attachment_id=? WHERE event=?')
              .run(file.attachment_id, job.id);
          }
          event.attachmentIds = [file.attachment_id];
        }
        // Unfollow may run in another process while the upload is in flight.
        // Retain its receipt, but never start a new send for a cancelled event.
        if (signal?.aborted) break;
        if (!pending()) continue;
        const receipt = await this.request(
          '/api/bot/channels/' + encodeURIComponent(sub.channel) + '/messages',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bot.token },
            body: JSON.stringify(event),
          },
          signal,
        );
        if (
          typeof receipt.message?.id !== 'string' ||
          !receipt.message.id ||
          receipt.message?.channelId !== sub.channel ||
          receipt.message?.authorId !== bot.id ||
          receipt.message?.authorRole !== 'bot' ||
          receipt.message?.botEvent?.eventId !== event.eventId
        )
          throw new Error('Invalid bot message receipt');
        this.db
          .prepare(
            "UPDATE events SET state='sent',messageid=?,error=NULL WHERE id=? AND state='pending'",
          )
          .run(receipt.message.id, job.id);
      } catch (error) {
        if (signal?.aborted) break;
        const message = brief(error);
        const status = /^Hivemind HTTP ([0-9]{3})$/.exec(message);
        const blocked =
          status &&
          Number(status[1]) >= 400 &&
          Number(status[1]) < 500 &&
          !['408', '429'].includes(status[1]!);
        this.db
          .prepare(
            "UPDATE events SET state=?,attempts=attempts+1,next_at=?,error=? WHERE id=? AND state='pending'",
          )
          .run(
            blocked ? 'blocked' : 'pending',
            Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)),
            message,
            job.id,
          );
      }
    }
  }
  lock(name = 'monitor') {
    const file = path.join(this.home, name + '.lock.db');
    const db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch (error) {
      db.close();
      throw error;
    }
    return () => {
      db.exec('ROLLBACK');
      db.close();
    };
  }
  isRunning() {
    try {
      const unlock = this.lock();
      unlock();
      return false;
    } catch (error: any) {
      if (error.errcode === 5 || String(error.message).includes('database is locked')) return true;
      throw error;
    }
  }
  desired(value?: boolean) {
    if (value !== undefined)
      this.db
        .prepare(
          'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run('desired', value ? '1' : '0');
    return (
      (this.db.prepare('SELECT value FROM meta WHERE key=?').get('desired') as any)?.value === '1'
    );
  }
  async start() {
    // A stopping daemon keeps the lock while reporting its final source state.
    // Its abort signal cannot be undone by setting desired=true again.
    // Serialize startup with other starts and profile/identity changes, including
    // the interval before the child has loaded enough to acquire its monitor lock.
    const release = this.lock('setup');
    try {
      this.assertCurrentConfig();
      if (this.isRunning()) {
        if (!this.desired())
          throw new Error('Monitor is stopping; wait until it is offline before starting');
        return;
      }
      this.desired(true);
      let log: number | undefined;
      try {
        const file = path.join(this.home, 'monitor.log');
        log = openSync(file, 'a', 0o600);
        chmodSync(file, 0o600);
        await launchMonitor(path.join(root, 'bin/hivemind-crashlytics.mjs'), this.home, log, () =>
          this.desired(),
        );
      } catch (error) {
        this.desired(false);
        throw error;
      } finally {
        if (log !== undefined) closeSync(log);
      }
    } finally {
      release();
    }
  }
}

export async function main(args: string[]) {
  process.umask(0o077);
  const options = Object.fromEntries(
    [
      'home',
      'hive-url',
      'account',
      'interval',
      'max-pages',
      'page-size',
      'lookback-days',
      'min-events',
      'min-users',
      'states',
      'types',
      'versions',
      'timeout',
      'channel',
      'initial',
      'id',
      'max-polls',
      'variant',
      'samples',
      'max-samples-per-poll',
    ].map((k) => [k, { type: 'string' as const }]),
  );
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      ...options,
      help: { type: 'boolean' },
      'managed-start': { type: 'boolean' },
      'no-start': { type: 'boolean' },
      'notify-counts': { type: 'boolean' },
      'no-auto-stacks': { type: 'boolean' },
      refresh: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  const managedStart = values['managed-start'] === true;
  if (managedStart && (command !== 'run' || !process.send || !process.connected))
    throw new Error('Managed startup requires its parent IPC connection');
  const value = (key: string) => (values as Record<string, unknown>)[key] as string | undefined;
  const home = path.resolve(
    value('home') ??
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), definitionId),
  );
  if (!command || command === 'help' || values.help) {
    console.log(
      'Stack options: init [--no-auto-stacks] [--max-samples-per-poll 20]\n  inspect FIREBASE_ISSUE_URL [--variant ID] [--samples 1..10] [--lookback-days 1..89] [--refresh]\nInspect saves local TXT files and prints paths/metadata only; it does not publish or start monitoring.',
    );
    console.log(
      definitionId +
        "\n  init --hive-url http://127.0.0.1:PORT [--account EMAIL] [--interval 300]\n    [--lookback-days 7] [--types FATAL] [--states OPEN] [--versions '1.2 (42),1.3 (43)']\n    [--min-events 1] [--min-users 0] [--notify-counts] [--page-size 100] [--max-pages 20] [--timeout 90]\n  follow FIREBASE_APP_URL --channel ANY_CHANNEL_ID [--initial snapshot|baseline] [--no-start]\n  list | status | unfollow --id ID | retry --id ID\n  start | stop | run [--max-polls N] | poll [--id ID]\n  instructions\nEvery command accepts --home /absolute/profile. Follow starts polling unless --no-start. Retry requires a stopped monitor and does not send or start it. " +
        usageNotice,
    );
    return;
  }
  const commandOptions: Record<string, string[]> = {
    init: [
      'hive-url',
      'account',
      'interval',
      'max-pages',
      'page-size',
      'lookback-days',
      'min-events',
      'min-users',
      'states',
      'types',
      'versions',
      'timeout',
      'notify-counts',
      'no-auto-stacks',
      'max-samples-per-poll',
    ],
    follow: ['channel', 'initial', 'no-start'],
    inspect: ['variant', 'samples', 'lookback-days', 'refresh'],
    poll: ['id'],
    run: ['max-polls', 'managed-start'],
    unfollow: ['id'],
    retry: ['id'],
    list: [],
    status: [],
    start: [],
    stop: [],
    instructions: [],
    configure: [],
    invoke: [],
  };
  const allowed = commandOptions[command];
  if (!allowed) throw new Error('Unknown bot command');
  for (const key of Object.keys(values)) {
    if (!['home', 'help', ...allowed].includes(key))
      throw new Error(`--${key} is not supported by ${command}`);
  }
  if (['init', 'instructions'].includes(command) && positionals.length !== 1)
    throw new Error('Unexpected positional arguments');
  if (command === 'instructions') {
    console.log(readFileSync(path.join(root, 'BOT-TOOLS.md'), 'utf8'));
    return;
  }
  if (command === 'invoke') {
    if (positionals.length !== 1) throw new Error('invoke accepts a JSON request on stdin only');
    const raw = await readJsonInput(process.stdin);
    const { invoke } = await import('./bot-interface.ts');
    console.log(JSON.stringify(await invoke(home, raw)));
    return;
  }
  if (command === 'configure') {
    if (positionals.length !== 1) throw new Error('configure accepts settings on stdin only');
    try {
      console.log(JSON.stringify(configureProfile(home, await readJsonInput(process.stdin))));
    } catch (error) {
      console.log(
        JSON.stringify({
          configured: false,
          error:
            error instanceof Error && error.name !== 'ZodError'
              ? error.message.slice(0, 300)
              : 'Invalid bot settings; check the declared fields and values',
        }),
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'init') {
    const config: Record<string, unknown> = {};
    for (const [flag, key] of Object.entries({ 'hive-url': 'hiveUrl', account: 'account' }))
      if (value(flag)) config[key] = value(flag);
    for (const [flag, key] of Object.entries({
      interval: 'intervalSeconds',
      'max-pages': 'maxPages',
      timeout: 'timeoutSeconds',
      'page-size': 'pageSize',
      'lookback-days': 'lookbackDays',
      'min-events': 'minEvents',
      'min-users': 'minUsers',
    }))
      if (value(flag)) config[key] = Number(value(flag));
    for (const [flag, key] of Object.entries({
      states: 'states',
      types: 'errorTypes',
      versions: 'versions',
    }))
      if (value(flag) !== undefined)
        config[key] =
          value(flag) === ''
            ? []
            : value(flag)!
                .split(',')
                .map((v) => v.trim());
    if (values['notify-counts']) config.notifyCounts = true;
    if (values['no-auto-stacks']) config.autoStacks = false;
    if (value('max-samples-per-poll'))
      config.maxSamplesPerPoll = Number(value('max-samples-per-poll'));
    console.log(JSON.stringify(init(home, config)));
    return;
  }
  if (command === 'inspect') {
    if (positionals.length !== 2 || value('channel'))
      throw new Error('inspect requires one issue URL and never posts to a channel');
    const samples = Number(value('samples') ?? 1);
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10)
      throw new Error('--samples must be 1..10 per variant');
    if (value('variant') && !/^[A-Za-z0-9_-]{1,200}$/.test(value('variant')!))
      throw new Error('Invalid variant ID');
    const config = configSchema.parse(
      JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')),
    );
    console.log(
      JSON.stringify(
        await inspect(positionals[1]!, config, home, runCommand, {
          variant: value('variant'),
          samples,
          days: value('lookback-days') ? Number(value('lookback-days')) : undefined,
          refresh: !!values.refresh,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (
    !['follow', 'list', 'status', 'unfollow', 'retry', 'start', 'stop', 'poll', 'run'].includes(
      command,
    )
  )
    throw new Error('Unknown bot command');
  if (positionals.length !== (command === 'follow' ? 2 : 1))
    throw new Error('Unexpected or missing positional arguments');
  const bot = new CrashlyticsBot(home);
  try {
    if (command === 'status' || command === 'list') {
      console.log(JSON.stringify(bot.status(), null, 2));
      return;
    }
    if (command === 'follow') {
      if (!value('channel')) throw new Error('Supply --channel ID');
      let result;
      let hold = () => {};
      const release = bot.lock('setup');
      try {
        bot.assertCurrentConfig();
        if (values['no-start']) {
          try {
            hold = bot.lock();
          } catch {
            throw new Error(
              'Stop the monitor before follow --no-start; otherwise it could read the new source immediately',
            );
          }
        }
        result = await bot.follow(positionals[1]!, value('channel')!, value('initial'));
      } finally {
        hold();
        release();
      }
      if (!values['no-start']) await bot.start();
      console.log(JSON.stringify({ ...result, monitorRunning: bot.isRunning() }));
      return;
    }
    if (command === 'unfollow') {
      if (!value('id')) throw new Error('Supply --id ID');
      console.log(JSON.stringify(bot.unfollow(value('id')!)));
      return;
    }
    if (command === 'retry') {
      if (!value('id')) throw new Error('Supply --id ID');
      console.log(JSON.stringify(bot.retry(value('id')!)));
      return;
    }
    if (command === 'start') {
      await bot.start();
      console.log(JSON.stringify({ monitorRunning: true }));
      return;
    }
    if (command === 'stop') {
      bot.desired(false);
      for (let i = 0; i < 40 && bot.isRunning(); i++) await delay(100);
      console.log(JSON.stringify({ stopRequested: true, monitorRunning: bot.isRunning() }));
      return;
    }
    const max = value('max-polls') ? Number(value('max-polls')) : Infinity;
    if (value('max-polls') && (!Number.isSafeInteger(max) || max < 1))
      throw new Error('--max-polls must be a positive integer');
    // Direct run/poll must not overtake a managed child still bootstrapping.
    // That child's parent already owns setup; it alone may acquire monitor now.
    const releaseSetup = managedStart ? undefined : bot.lock('setup');
    let release = () => {};
    try {
      release = bot.lock();
      bot.assertCurrentConfig();
      if (command === 'run' && !managedStart) bot.desired(true);
      // A one-shot poll is not a daemon, even when stale intent survived a
      // previous crash. A concurrent Start must wait for it to release monitor.
      if (command === 'poll') bot.desired(false);
    } catch (error) {
      release();
      throw error;
    } finally {
      releaseSetup?.();
    }
    const controller = new AbortController();
    const stop = () => {
      bot.desired(false);
      controller.abort();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const timer = setInterval(() => {
      if (command === 'run' && !bot.desired()) controller.abort();
    }, 250);
    try {
      if (managedStart) {
        await acceptMonitorStart(() => bot.desired() && !controller.signal.aborted);
        if (!bot.desired()) controller.abort();
      }
      if (command === 'poll') {
        const results = await bot.cycle(value('id'), false, controller.signal);
        console.log(JSON.stringify(results));
        if (
          results.some((r) => r.error) ||
          bot.db.prepare("SELECT 1 FROM events WHERE state IN ('pending','blocked') LIMIT 1").get()
        )
          process.exitCode = 2;
        return;
      }
      let polls = 0;
      while (!controller.signal.aborted && polls < max) {
        if (Number.isFinite(max) && !bot.subscriptions().some((sub) => sub.enabled)) break;
        const results = await bot.cycle(undefined, true, controller.signal, max - polls);
        polls += results.length;
        if (results.length) console.log(JSON.stringify(results));
        if (polls < max)
          await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    } finally {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      bot.desired(false);
      release();
    }
  } finally {
    bot.close();
  }
}
