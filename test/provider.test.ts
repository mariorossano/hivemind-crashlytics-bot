import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, parseSource, read } from '../src/provider.ts';
import { readCrashlytics, resolveApp } from '../src/readers/crashlytics.ts';
const config = configSchema.parse({ hiveUrl: 'http://127.0.0.1:7777' });
const url =
  'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues';
const source = parseSource(url, config),
  appId = '1:123456:ios:abcdef';
const name = `projects/123456/apps/${appId}/reports/topIssues`;
const now = Date.parse('2026-09-14T12:00:00Z');
function group(id = 'a1', events: unknown = '10', users: unknown = '3') {
  return {
    issue: {
      id,
      title: 'InventedCrash.swift',
      subtitle: 'Invented failure',
      state: 'OPEN',
      errorType: 'FATAL',
      uri: source.base + '/issues/' + id,
      firstSeenVersion: '1.0',
      lastSeenVersion: '1.1',
      signals: [],
    },
    metrics: [
      {
        startTime: new Date(now - 7 * 86400000).toISOString(),
        endTime: new Date(now).toISOString(),
        eventsCount: events,
        impactedUsersCount: users,
      },
    ],
  };
}
function report(groups: any[] = [group()], extra: any = {}) {
  return { name, groups, totalSize: groups.length, ...extra };
}
test('console account index and sorting do not bind a channel/account; filters persist canonically', () => {
  const a = parseSource(
    url.replace('/project', '/u/0/project') +
      '?state=open&time=7d&types=crash&tag=all&sort=eventCount',
    config,
  );
  assert.equal(a.url, source.url);
  assert.equal(a.config.lookbackDays, 7);
  assert.equal(a.config.account, undefined);
  const custom = parseSource(url + '?state=all&time=14d&types=anr,crash', config);
  assert.deepEqual(custom.config.states, []);
  assert.deepEqual(custom.config.errorTypes, ['ANR', 'FATAL']);
  assert.equal(custom.config.lookbackDays, 14);
  for (const bad of [
    url.replace('console.firebase.google.com', 'wrong.invalid'),
    url + '/a1',
    url + '?tag=regressed',
    url + '?versions=1.2',
    url + '?time=90d',
    url + '?types=unknown',
    url + '?state=open&state=closed',
    url.replace('com.example.app', '%2Fetc'),
  ])
    assert.throws(() => parseSource(bad, config));
});
test('every accepted state selection has a canonical source URL; pairs fail at configuration', () => {
  const states = ['OPEN', 'CLOSED', 'MUTED'];
  for (let mask = 0; mask < 8; mask++) {
    const selected = states.filter((_, index) => mask & (1 << index));
    if (selected.length === 2) {
      assert.throws(() => configSchema.parse({ ...config, states: selected }), /one state/);
      continue;
    }
    const custom = configSchema.parse({ ...config, states: selected });
    const parsed = parseSource(url, custom);
    assert.equal(
      new URL(parsed.url).searchParams.get('state'),
      selected.length === 1 ? selected[0]!.toLowerCase() : 'all',
    );
    assert.equal(parseSource(parsed.url, custom).url, parsed.url);
    assert.deepEqual(parseSource(url + '?state=muted', custom).config.states, ['MUTED']);
  }
  assert.throws(
    () => configSchema.parse({ ...config, states: ['OPEN', 'OPEN', 'CLOSED'] }),
    /one state/,
  );
  const repeated = configSchema.parse({ ...config, states: ['OPEN', 'OPEN'] });
  assert.equal(parseSource(url, repeated).url, source.url);
});

test('app discovery is exact and fully paginated, not guessed from a bundle or project name', async () => {
  const requests: URL[] = [];
  const id = await resolveApp(source, async (u) => {
    requests.push(u);
    return requests.length === 1
      ? { apps: [{ appId: '1:123456:ios:111', bundleId: 'other.app' }], nextPageToken: 'next' }
      : { apps: [{ appId, bundleId: source.bundle }] };
  });
  assert.equal(id, appId);
  assert.equal(requests[1]!.searchParams.get('pageToken'), 'next');
  assert.equal(requests[0]!.pathname, '/v1beta1/projects/example-prod/iosApps');
  await assert.rejects(
    resolveApp(source, async () => ({ apps: [] })),
    /exactly one/,
  );
  await assert.rejects(
    resolveApp(source, async () => ({
      apps: [
        { appId, bundleId: source.bundle },
        { appId: '1:123456:ios:123', bundleId: source.bundle },
      ],
    })),
    /exactly one/,
  );
  await assert.rejects(
    resolveApp(source, async () => ({ nextPageToken: 'again' })),
    /Repeated/,
  );
});
test('full report pagination uses identical interval/filters and preserves counts, links, versions', async () => {
  const calls: URL[] = [];
  const result = await readCrashlytics(
    source,
    appId,
    async (u) => {
      calls.push(u);
      return calls.length === 1
        ? report([group()], { totalSize: 2, nextPageToken: 'second' })
        : report([group('b2')], { totalSize: 2 });
    },
    now,
  );
  assert.equal(result.observations.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.origin, 'https://firebasecrashlytics.googleapis.com');
  const next = new URL(calls[1]!);
  next.searchParams.delete('pageToken');
  assert.equal(next.href, calls[0]!.href);
  assert.equal(calls[0]!.searchParams.get('filter.issue.errorTypes'), 'FATAL');
  assert.equal(calls[0]!.searchParams.get('filter.issue.states'), 'OPEN');
  assert.match(result.observations[0]!.body, /10 events · 3 impacted users/);
  assert.equal(
    new URL(result.observations[0]!.url).pathname,
    new URL(source.base).pathname + '/issues/a1',
  );
});
test('no count/timestamp noise by default; count notifications are explicit configuration', async () => {
  const first = (await readCrashlytics(source, appId, async () => report(), now)).observations[0]!;
  const changed = group('a1', '15', '6');
  (changed.issue as any).lastSeenTime = new Date(now + 1000).toISOString();
  const second = (await readCrashlytics(source, appId, async () => report([changed]), now))
    .observations[0]!;
  assert.deepEqual(first.value, second.value);
  assert.match(first.body, /^Native classifications: none reported · source: issue-signals/);
  assert.match(second.body, /^Native classifications: none reported · source: issue-signals/);
  assert.notEqual(first.body, second.body);
  const countSource = parseSource(url, configSchema.parse({ ...config, notifyCounts: true }));
  const a = (await readCrashlytics(countSource, appId, async () => report(), now)).observations[0]!;
  const b = (await readCrashlytics(countSource, appId, async () => report([changed]), now))
    .observations[0]!;
  assert.notDeepEqual(a.value, b.value);
});
test('issue signal mapping is explicit, stable and never creates trending/velocity from counts', async () => {
  const g = group('a1', '99999', '9999');
  Object.assign(g.issue, {
    signals: [
      { signal: 'SIGNAL_REPETITIVE' },
      { signal: 'SIGNAL_EARLY' },
      { signal: 'SIGNAL_FRESH' },
      { signal: 'SIGNAL_REGRESSED' },
      { signal: 'SIGNAL_FUTURE' },
      { signal: 'SIGNAL_FRESH' },
    ],
  });
  const result = await readCrashlytics(source, appId, async () => report([g]), now);
  const first = result.observations[0]!;
  assert.match(
    first.body,
    /^Native classifications: early, new, regressed, repetitive · source: issue-signals/,
  );
  assert.doesNotMatch(first.body, /trending|velocity/);
  assert.match(first.body, /Signals: .*SIGNAL_FUTURE/);
  assert.ok(result.warnings!.some((w) => w.includes('unrecognized')));
  g.issue.signals.reverse();
  const reordered = await readCrashlytics(source, appId, async () => report([g]), now);
  assert.deepEqual(reordered, result);
  // Only native raw signals enter the existing fingerprint: no mass replay on upgrade.
  assert.ok(!Object.hasOwn(first.value as object, 'classifications'));
});
test('Firebase app-ID deep links validate the exact project, app and issue', async () => {
  const g = group();
  g.issue.uri = `https://console.firebase.google.com/v1/appid/project/${source.project}/crashlytics/app/${appId}/issues/a1?time=1:2`;
  const result = await readCrashlytics(source, appId, async () => report([g]), now);
  assert.equal(result.observations.length, 1);
  g.issue.uri = g.issue.uri.replace(appId, '1:999:ios:other');
  await assert.rejects(
    readCrashlytics(source, appId, async () => report([g]), now),
    /unexpected issue link/,
  );
});
test('regression signals, state and version changes remain meaningful changes', async () => {
  const original = (await readCrashlytics(source, appId, async () => report(), now))
    .observations[0]!;
  for (const patch of [
    { signals: [{ signal: 'SIGNAL_REGRESSED' }] },
    { lastSeenVersion: '2.0' },
    { title: 'DifferentCrash' },
  ]) {
    const g = group();
    Object.assign(g.issue, patch);
    const result = (await readCrashlytics(source, appId, async () => report([g]), now))
      .observations[0]!;
    assert.notDeepEqual(result.value, original.value);
  }
});
test('incomplete, duplicate, wrong-scope and malformed reports never become a successful snapshot', async () => {
  const malformed = [
    report([], { name: name.replace('123456', '999') }),
    report([group()], { totalSize: 2 }),
    report([group(), group()]),
    report([group('a1', 'oops')]),
    report([group('a1', '9007199254740992')]),
  ];
  for (const r of malformed)
    await assert.rejects(readCrashlytics(source, appId, async () => r, now));
  for (const patch of [
    { uri: 'https://wrong.invalid/crash' },
    { uri: source.base.replace('com.example.app', 'com.other') + '/issues/a1' },
    { errorType: 'NON_FATAL' },
    { state: 'CLOSED' },
    { name: 'projects/999/apps/wrong/issues/a1' },
  ]) {
    const g = group();
    Object.assign(g.issue, patch);
    await assert.rejects(readCrashlytics(source, appId, async () => report([g]), now));
  }
  const limit = parseSource(url, configSchema.parse({ ...config, maxPages: 1 }));
  await assert.rejects(
    readCrashlytics(limit, appId, async () => report([group()], { nextPageToken: 'more' }), now),
    /page limit/,
  );
  let n = 0;
  await assert.rejects(
    readCrashlytics(
      source,
      appId,
      async () => report([group('id' + ++n)], { nextPageToken: 'again', totalSize: 10 }),
      now,
    ),
    /Repeated report page/,
  );
  await assert.rejects(
    readCrashlytics(
      source,
      appId,
      async () => {
        throw new Error('HTTP 403');
      },
      now,
    ),
    /403/,
  );
});
test('empty complete reports are valid; unknown users do not become zero; thresholds and versions are configurable', async () => {
  assert.equal(
    (await readCrashlytics(source, appId, async () => report([]), now)).observations.length,
    0,
  );
  const missing = group();
  delete (missing.metrics[0] as any).impactedUsersCount;
  const result = await readCrashlytics(source, appId, async () => report([missing]), now);
  assert.match(result.observations[0]!.body, /unknown impacted users/);
  assert.equal(result.warnings!.length, 1);
  const filtered = parseSource(
    url,
    configSchema.parse({ ...config, minUsers: 5, minEvents: 10, versions: ['1.2 (42)'] }),
  );
  const r = await readCrashlytics(
    filtered,
    appId,
    async (u) => {
      assert.deepEqual(u.searchParams.getAll('filter.version.displayNames'), ['1.2 (42)']);
      return report([missing, group('b2', '9', '8'), group('c3', '10', '6')]);
    },
    now,
  );
  assert.deepEqual(
    r.observations.map((x) => x.key),
    ['issue:c3'],
  );
});
test('reader runs the bundled read-only helper without Claude or shell and retains cancellation', async () => {
  let cmd: any;
  const controller = new AbortController();
  const result = await read(
    url,
    config,
    '/tmp',
    async (c) => {
      cmd = c;
      return { stdout: JSON.stringify({ observations: [] }) };
    },
    controller.signal,
  );
  assert.deepEqual(result.observations, []);
  assert.equal(cmd.executable, process.execPath);
  assert.ok(cmd.args.at(-1).endsWith('/firebase-entry.ts'));
  assert.equal(cmd.signal, controller.signal);
  assert.equal(JSON.parse(cmd.stdin).url, source.url);
  assert.ok(!JSON.stringify(cmd).includes('claude'));
  await assert.rejects(
    read(url, config, '/tmp', async () => ({
      stdout: JSON.stringify({ error: 'Firebase GET HTTP 403' }),
    })),
    /403/,
  );
});

test('empty URL filters and inherited object keys are not silently accepted', () => {
  for (const query of ['state=', 'time=', 'types=toString', 'types=constructor'])
    assert.throws(() => parseSource(url + '?' + query, config));
});

test('reader output validation rejects malformed JSON without echoing provider content', async () => {
  for (const stdout of ['SECRET-OUTPUT', '{"observations": SECRET-OUTPUT}', 'null', '[]']) {
    await assert.rejects(
      read(url, config, '/tmp', async () => ({ stdout })),
      (error) => {
        assert.match(String(error), /invalid JSON/);
        assert.ok(!String(error).includes('SECRET-OUTPUT'));
        return true;
      },
    );
  }
});
