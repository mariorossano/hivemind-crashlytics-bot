import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configSchema, parseSource } from '../src/provider.ts';
import { readTopIssues, topIssues } from '../src/top-issues.ts';
import { ReaderTimeoutError, type Runner } from '../src/readers/process.ts';
import { configureProfile } from '../src/profile.ts';
import { CrashlyticsBot } from '../src/runtime.ts';
import { invoke } from '../src/bot-interface.ts';

const url =
  'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues';
const config = configSchema.parse({ hiveUrl: 'http://127.0.0.1:1' });
const source = parseSource(url, config);
const appId = '1:123456:ios:abcdef';
const now = Date.parse('2026-09-20T12:00:00Z');
const name = `projects/123456/apps/${appId}/reports/topIssues`;
function group(id: string, events: number, users: number | undefined = 2) {
  return {
    issue: {
      id,
      title: 'Synthetic crash',
      subtitle: 'Synthetic frame',
      errorType: 'FATAL',
      state: 'OPEN',
    },
    metrics: [
      {
        startTime: new Date(now - 7 * 86400000).toISOString(),
        endTime: new Date(now).toISOString(),
        eventsCount: String(events),
        ...(users === undefined ? {} : { impactedUsersCount: String(users) }),
      },
    ],
  };
}
const report = (groups: ReturnType<typeof group>[], extra = {}) => ({
  name,
  groups,
  totalSize: groups.length,
  ...extra,
});

test('ranking fully paginates before selecting the winner, preserves scope and exposes ties', async () => {
  let calls = 0;
  const ranked = await readTopIssues(
    source,
    appId,
    async (request) => {
      assert.match(request.pathname, /reports\/topIssues$/);
      assert.equal(
        request.searchParams.get('filter.interval.endTime'),
        new Date(now).toISOString(),
      );
      return ++calls === 1
        ? report([group('low', 4), group('z-tie', 100)], { totalSize: 3, nextPageToken: 'next' })
        : report([group('a-winner', 100)], { totalSize: 3 });
    },
    1,
    now,
  );
  assert.equal(calls, 2);
  assert.equal(ranked.totalMatchingIssues, 3);
  assert.equal(ranked.issues[0]!.id, 'a-winner');
  assert.equal(ranked.issues[0]!.events, 100);
  assert.equal(ranked.issues[0]!.users, 2);
  assert.match(ranked.issues[0]!.url, /\/issues\/a-winner\?time=7d$/);
  assert.equal(ranked.limited, true);
  assert.equal(ranked.moreWithSameCount, 1);
  assert.deepEqual(ranked.filters, {
    lookbackDays: 7,
    states: ['OPEN'],
    errorTypes: ['FATAL'],
    versions: [],
    minEvents: 1,
    minUsers: 0,
  });
  assert.deepEqual(ranked.interval, {
    start: '2026-09-13T12:00:00.000Z',
    end: '2026-09-20T12:00:00.000Z',
  });
  assert.equal(source.config.notifyCounts, false);
  const all = await readTopIssues(
    source,
    appId,
    async () => report([group('low', 1), group('b', 2), group('a', 2)]),
    10,
    now,
  );
  assert.deepEqual(
    all.issues.map((i) => i.id),
    ['a', 'b', 'low'],
  );
  assert.equal(all.limited, false);
  assert.equal(all.moreWithSameCount, 0);
});

test('empty, unknown-user and filtered rankings never imply zero users or an unfiltered global winner', async () => {
  const empty = await readTopIssues(source, appId, async () => report([]), 1, now);
  assert.deepEqual(empty.issues, []);
  assert.equal(empty.totalMatchingIssues, 0);
  assert.equal(empty.moreWithSameCount, 0);
  const unknown = group('unknown', 999);
  delete unknown.metrics[0]!.impactedUsersCount;
  const ranked = await readTopIssues(source, appId, async () => report([unknown]), 1, now);
  assert.equal(ranked.issues[0]!.users, null);
  assert.ok(ranked.warnings.some((w) => /unavailable/.test(w)));
  const filtered = parseSource(
    url,
    configSchema.parse({ ...config, minUsers: 3, minEvents: 5, versions: ['1.2.3'] }),
  );
  const result = await readTopIssues(
    filtered,
    appId,
    async (request) => {
      assert.equal(request.searchParams.get('filter.version.displayNames'), '1.2.3');
      return report([
        unknown,
        group('few-users', 100, 2),
        group('few-events', 2, 5),
        group('match', 10, 5),
      ]);
    },
    10,
    now,
  );
  assert.deepEqual(
    result.issues.map((i) => i.id),
    ['match'],
  );
  assert.equal(result.filters.minUsers, 3);
  assert.deepEqual(result.filters.versions, ['1.2.3']);
});

test('incomplete, duplicate, wrong-scope and failed later pages cannot return a partial ranking', async () => {
  for (const bad of [
    report([group('a', 10)], { totalSize: 2 }),
    report([group('a', 10), group('a', 10)]),
    report([group('a', 10)], { name: 'wrong' }),
  ])
    await assert.rejects(readTopIssues(source, appId, async () => bad, 1, now));
  let calls = 0;
  await assert.rejects(
    readTopIssues(
      source,
      appId,
      async () => {
        if (++calls === 1) return report([group('a', 10)], { totalSize: 2, nextPageToken: 'next' });
        throw new Error('Synthetic provider failure');
      },
      1,
      now,
    ),
    /Synthetic provider failure/,
  );
  await assert.rejects(
    readTopIssues(
      { ...source, config: { ...config, maxPages: 1 } },
      appId,
      async () => report([group('a', 10)], { totalSize: 2, nextPageToken: 'next' }),
      1,
      now,
    ),
    /page limit/,
  );
});

test('ranking bounds text and serialized output without exposing provider-only fields', async () => {
  const groups = Array.from({ length: 10 }, (_, i) => {
    const g = group(`issue${i}`, 100 - i);
    g.issue.title = '\u0000'.repeat(5000);
    g.issue.subtitle = '🔥'.repeat(5000);
    Object.assign(g.issue, {
      token: 'synthetic-private-token',
      customKeys: 'synthetic-private-data',
    });
    return g;
  });
  const ranked = await readTopIssues(source, appId, async () => report(groups), 10, now);
  assert.ok(ranked.issues.every((i) => i.textTruncated && i.title.length === 160));
  const serialized = JSON.stringify(ranked);
  assert.ok(Buffer.byteLength(serialized) < 48 * 1024);
  assert.doesNotMatch(serialized, /synthetic-private/);
});

test('query uses a bounded fixed metadata reader, validates arguments and keeps profile settings unchanged', async () => {
  const before = JSON.stringify(config);
  let calls = 0;
  const runner: Runner = async (command) => {
    calls++;
    assert.equal(command.executable, process.execPath);
    assert.match(command.args.at(-1)!, /firebase-entry\.ts$/);
    assert.equal(command.timeoutMs, 20000);
    assert.equal(command.maxOutputBytes, 64 * 1024);
    assert.equal(command.parentLifeline, true);
    const input = JSON.parse(command.stdin!);
    assert.equal(input.action, 'top_issues');
    assert.equal(input.limit, 1);
    assert.equal(input.config.autoStacks, false);
    assert.equal(input.config.notifyCounts, true);
    assert.equal(input.config.lookbackDays, 14);
    assert.equal(new URL(input.url).searchParams.get('time'), '14d');
    const querySource = parseSource(input.url, configSchema.parse(input.config));
    return {
      stdout: JSON.stringify(
        await readTopIssues(querySource, appId, async () => report([]), input.limit, now),
      ),
    };
  };
  const result = await topIssues(config, '/synthetic-profile', runner, {
    url: url + '?time=7d',
    lookbackDays: 14,
  });
  assert.equal(result.filters.lookbackDays, 14);
  assert.equal(JSON.stringify(config), before);
  for (const args of [
    {},
    { url, limit: 0 },
    { url, limit: 11 },
    { url, limit: 1.5 },
    { url, lookbackDays: 90 },
    { url, command: 'ignored' },
    { url: url + '?tag=regressed' },
    { url: url + '?time=bad', lookbackDays: 7 },
    { url: 'https://example.invalid/issues' },
    { url: url + '?time=7d&time=14d' },
  ])
    await assert.rejects(topIssues(config, '/synthetic-profile', runner, args));
  assert.equal(calls, 1);
  await topIssues(
    { ...config, timeoutSeconds: 5 },
    '/synthetic-profile',
    async (command) => {
      assert.equal(command.timeoutMs, 5000);
      return { stdout: JSON.stringify(result) };
    },
    { url },
  );
});

test('query propagates timeouts and rejects metadata checkpoints, malformed results or provider errors', async () => {
  await assert.rejects(
    topIssues(
      config,
      '/synthetic-profile',
      async () => {
        throw new ReaderTimeoutError('synthetic-private-checkpoint');
      },
      { url },
    ),
    (error: Error) => /timed out/.test(error.message) && !error.message.includes('checkpoint'),
  );
  for (const stdout of [
    '{}',
    'not-json',
    '{"type":"metadata","snapshot":{"observations":[]}}',
    '{"error":"Firebase unavailable"}',
  ])
    await assert.rejects(
      topIssues(config, '/synthetic-profile', async () => ({ stdout }), { url }),
    );
});

test('runtime ranking leaves monitor, subscriptions, baseline, outbox, cache and configuration intact', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-query-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: config.hiveUrl }, projectId: 'fixture' });
  const response = await readTopIssues(source, appId, async () => report([group('a', 10)]), 1, now);
  const bot = new CrashlyticsBot(home, async () => ({ stdout: JSON.stringify(response) }));
  const release = bot.lock();
  try {
    bot.desired(true);
    bot.db
      .prepare('INSERT INTO bots VALUES (?,?,?,?)')
      .run('fixture', 'bot', 'Crashlytics', 'synthetic-token');
    bot.db
      .prepare(
        "INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES (?,?,?,?,1,'snapshot')",
      )
      .run('subscription', url, 'channel', 'bot');
    const state = () =>
      [
        'meta',
        'bots',
        'subscriptions',
        'items',
        'events',
        'samples_seen',
        'event_files',
        'baseline_pending',
        'baseline_variants',
      ].map((table) => bot.db.prepare(`SELECT * FROM ${table}`).all());
    const before = state();
    const files = readdirSync(home).sort();
    const configBefore = readFileSync(path.join(home, 'config.json'));
    assert.equal((await bot.topIssues({ url })).issues[0]!.events, 10);
    assert.deepEqual(state(), before);
    assert.deepEqual(readdirSync(home).sort(), files);
    assert.deepEqual(readFileSync(path.join(home, 'config.json')), configBefore);
    assert.equal(bot.isRunning(), true);
    assert.equal(bot.desired(), true);
    await assert.rejects(bot.topIssues({ url: 'bad' }));
    const setup = bot.lock('setup');
    setup();
  } finally {
    release();
    bot.close();
  }
});

test('native ranking enforces project/identity/token boundaries before querying', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-query-invoke-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: config.hiveUrl }, projectId: 'fixture' });
  const context = { projectId: 'fixture', botId: 'bot', botName: 'Crashlytics', arguments: {} };
  await invoke(home, { ...context, tool: 'connect', token: 'synthetic-token' });
  const response = await readTopIssues(source, appId, async () => report([]), 1, now);
  const query = t.mock.method(CrashlyticsBot.prototype, 'topIssues', async (args: unknown) => {
    assert.deepEqual(args, { url });
    return response;
  });
  const request = { ...context, tool: 'top_issues', arguments: { url } };
  await assert.rejects(invoke(home, { ...request, projectId: 'other' }));
  await assert.rejects(invoke(home, { ...request, botId: 'other' }));
  await assert.rejects(invoke(home, { ...request, token: 'unexpected' }));
  assert.equal(query.mock.callCount(), 0);
  assert.deepEqual(await invoke(home, request), { ok: true, ...response });
  assert.equal(query.mock.callCount(), 1);
});
