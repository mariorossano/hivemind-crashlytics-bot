import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configSchema, parseSource, inspect } from '../src/provider.ts';
import {
  listVariants,
  fetchSamples,
  readMask,
  StackCache,
  obtainSamples,
  enrichStacks,
  inspectIssue,
  parseIssue,
} from '../src/readers/stacks.ts';
import {
  loadArtifact,
  saveArtifact,
  privateWrite,
  bundleArtifacts,
  partitionArtifacts,
  maxArtifactBytes,
} from '../src/artifacts.ts';
const cfg = configSchema.parse({ hiveUrl: 'http://127.0.0.1:7777' });
const url =
  'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues';
const source = parseSource(url, cfg),
  app = '1:123456:ios:abcdef',
  parent = `projects/123456/apps/${app}`;
const now = Date.parse('2026-09-15T01:00:00Z'),
  start = new Date(now - 7 * 86400000).toISOString(),
  end = new Date(now).toISOString();
const report = (ids: string[], extra: any = {}) => ({
  name: parent + '/reports/topVariants',
  groups: ids.map((id) => ({
    variant: { id },
    issue: { id: 'a1' },
    metrics: [{ startTime: start, endTime: end }],
  })),
  totalSize: ids.length,
  ...extra,
});
const event = (variant = 'v1', name = 'evt1') => ({
  name: parent + '/events/' + name,
  eventTime: new Date(now - 10000).toISOString(),
  issue: { id: 'a1' },
  issueVariant: { id: variant },
  platform: 'IOS',
  bundleOrPackage: source.bundle,
  version: { displayName: '1.2 (42)' },
  threads: [
    {
      crashed: true,
      name: 'main',
      frames: Array.from({ length: 80 }, (_, i) => ({
        file: 'Invented.swift',
        symbol: 'invented' + i,
        line: i,
        library: 'Example',
        blamed: i === 0,
      })),
    },
  ],
  logs: [{ message: 'SECRET_LOG' }],
  user: { id: 'SECRET_USER' },
  customKeys: { sensitive: 'SECRET_KEY' },
  breadcrumbs: [{ title: 'SECRET_BREADCRUMB' }],
  sessionId: 'SECRET_SESSION',
});
function home(t: any) {
  const h = mkdtempSync(path.join(os.tmpdir(), 'crash-stacks-test-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}
test('corrupt cache metadata cannot claim samples or leave a variant in permanent backoff', (t) => {
  const h = home(t),
    cache = new StackCache(h),
    key = cache.key(source, app, 'a1', 'v1', 1, true);
  const artifact = saveArtifact(h, 'fixture.txt', 'Synthetic stack');
  cache.put(key, { artifact, samples: 1, eventTimes: [], fetchedAt: now });
  assert.equal(cache.get(key), undefined);
  privateWrite(
    path.join(h, 'stack-cache', key + '.retry.json'),
    JSON.stringify({ attempts: 'bad', after: 'not-a-time' }),
  );
  assert.equal(cache.retryReady(key, now), true);
  cache.failed(key, now, 60);
  assert.equal(cache.retryReady(key, now), false);
  assert.equal(cache.retryReady(key, now + 60000), true);
});
test('combined attachment size is bounded before loading cached files', (t) => {
  const h = home(t);
  const missing = { sha256: 'a'.repeat(64), name: 'large.txt', bytes: maxArtifactBytes };
  assert.throws(
    () => bundleArtifacts(h, 'combined.txt', [missing, missing]),
    /Combined stack attachment exceeds 32 MiB/,
  );
  const first = saveArtifact(h, 'first.txt', 'First'),
    second = saveArtifact(h, 'second.txt', 'Second');
  assert.match(
    loadArtifact(h, bundleArtifacts(h, 'combined.txt', [first, second])).toString(),
    /First\n\n=+\n\nSecond/,
  );
});

test('attachment partitioning respects separator bytes and rejects invalid descriptors', () => {
  const make = (bytes: number) => ({ sha256: 'a'.repeat(64), name: 'fixture.txt', bytes });
  const first = make(maxArtifactBytes - 77),
    second = make(1);
  assert.deepEqual(partitionArtifacts([first, second]), [[first, second]]);
  const larger = make(2);
  assert.deepEqual(partitionArtifacts([first, larger]), [[first], [larger]]);
  assert.deepEqual(partitionArtifacts([make(maxArtifactBytes), second]), [
    [make(maxArtifactBytes)],
    [second],
  ]);
  assert.deepEqual(partitionArtifacts([]), []);
  assert.throws(() => partitionArtifacts([first, make(maxArtifactBytes + 1)]));
  assert.throws(() => partitionArtifacts([{ ...first, sha256: '../private' }]));
});
test('variant discovery reads ALL pages (not the issue top 12) with fixed issue/interval/version scope', async () => {
  const calls: URL[] = [];
  const ids = Array.from({ length: 15 }, (_, i) => 'v' + i);
  const variants = await listVariants(
    source,
    app,
    'a1',
    async (u) => {
      calls.push(u);
      return calls.length === 1
        ? report(ids.slice(0, 12), { nextPageToken: 'next', totalSize: 15 })
        : report(ids.slice(12), { totalSize: 15 });
    },
    now,
  );
  assert.equal(variants.length, 15);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.searchParams.get('filter.issue.id'), 'a1');
  const second = new URL(calls[1]!);
  second.searchParams.delete('pageToken');
  assert.equal(second.href, calls[0]!.href);
  for (const bad of [
    report(['v1', 'v1']),
    report(['v1'], { totalSize: 2 }),
    report(['v1'], { name: 'projects/wrong/reports/topVariants' }),
  ])
    await assert.rejects(listVariants(source, app, 'a1', async () => bad, now));
  let n = 0;
  await assert.rejects(
    listVariants(
      source,
      app,
      'a1',
      async () => report(['v' + ++n], { totalSize: 50, nextPageToken: 'same' }),
      now,
    ),
    /Repeated/,
  );
});
test('sample retrieval requests only stack fields, retains all frames, strips unexpected sensitive fields', async (t) => {
  const h = home(t);
  let calls = 0;
  const result = await obtainSamples(
    source,
    app,
    'a1',
    'v1',
    async (u) => {
      calls++;
      assert.equal(u.searchParams.get('readMask'), readMask);
      assert.equal(u.searchParams.get('pageSize'), '1');
      assert.equal(u.searchParams.get('filter.issue.variantId'), 'v1');
      return { events: [event()] };
    },
    new StackCache(h),
    { automatic: true, now },
  );
  const text = loadArtifact(h, result.artifact).toString();
  assert.match(text, /invented79/);
  assert.match(text, /Variant: v1/);
  assert.match(text, /1.2 \(42\)/);
  assert.ok(!text.includes('SECRET_'));
  assert.equal(calls, 1);
});
test('wrong app/variant/issue/time/version and frameless events never get cached', async () => {
  const otherSource = parseSource(url, configSchema.parse({ ...cfg, versions: ['2.0 (99)'] }));
  for (const e of [
    { ...event(), name: 'projects/999/apps/other/events/e' },
    { ...event(), issueVariant: { id: 'v2' } },
    { ...event(), issue: { id: 'wrong' } },
    { ...event(), eventTime: new Date(now + 1).toISOString() },
    { ...event(), bundleOrPackage: 'other' },
    { ...event(), threads: [] },
  ])
    await assert.rejects(
      fetchSamples(source, app, 'a1', 'v1', 1, async () => ({ events: [e] }), now),
    );
  await assert.rejects(
    fetchSamples(otherSource, app, 'a1', 'v1', 1, async () => ({ events: [event()] }), now),
    /version/,
  );
});
test('representatives survive restarts and moving windows; same on-demand sample reuses cache; refresh and extra samples are explicit', async (t) => {
  const h = home(t);
  let reads = 0;
  const get = async (u: URL) => {
    reads++;
    const n = Number(u.searchParams.get('pageSize'));
    return { events: Array.from({ length: n }, (_, i) => event('v1', 'e' + i)) };
  };
  await obtainSamples(source, app, 'a1', 'v1', get, new StackCache(h), { automatic: true, now });
  assert.equal(
    (
      await obtainSamples(source, app, 'a1', 'v1', get, new StackCache(h), {
        automatic: true,
        now: now + 30 * 86400000,
      })
    ).cached,
    true,
  );
  assert.equal(reads, 1);
  assert.equal(
    (await obtainSamples(source, app, 'a1', 'v1', get, new StackCache(h), { now })).cached,
    true,
  );
  assert.equal(reads, 1);
  await obtainSamples(source, app, 'a1', 'v1', get, new StackCache(h), { samples: 3, now });
  assert.equal(reads, 2);
  await obtainSamples(source, app, 'a1', 'v1', get, new StackCache(h), {
    samples: 3,
    refresh: true,
    now,
  });
  assert.equal(reads, 3);
});
test('on-demand multiple samples paginate, report fewer available, reject duplicates and page-limit truncation', async () => {
  let calls = 0;
  const events = await fetchSamples(
    source,
    app,
    'a1',
    'v1',
    3,
    async () =>
      ++calls === 1
        ? { events: [event()], nextPageToken: 'next' }
        : { events: [event('v1', 'evt2')] },
    now,
  );
  assert.equal(events.length, 2);
  await assert.rejects(
    fetchSamples(
      source,
      app,
      'a1',
      'v1',
      3,
      async () => ({ events: [event()], nextPageToken: 'again' }),
      now,
    ),
    /Repeated sample/,
  );
  await assert.rejects(
    fetchSamples(
      parseSource(url, configSchema.parse({ ...cfg, maxPages: 1 })),
      app,
      'a1',
      'v1',
      3,
      async () => ({ events: [event()], nextPageToken: 'next' }),
      now,
    ),
    /page limit/,
  );
});
test('automatic enrichment keeps issue fingerprints, downloads only missing variants, and retries failures visibly', async (t) => {
  const h = home(t);
  let eventReads = 0,
    fail = true,
    variants = ['v1', 'v2'];
  const get = async (u: URL) => {
    if (u.pathname.endsWith('topVariants')) {
      const r = report(variants);
      for (const g of r.groups) {
        g.metrics[0]!.startTime = u.searchParams.get('filter.interval.startTime')!;
        g.metrics[0]!.endTime = u.searchParams.get('filter.interval.endTime')!;
      }
      return r;
    }
    eventReads++;
    const v = u.searchParams.get('filter.issue.variantId')!;
    if (v === 'v2' && fail) throw new Error('403 private provider details');
    return { events: [event(v)] };
  };
  const snapshot = () => ({
    observations: [
      {
        key: 'issue:a1',
        value: { state: 'OPEN' },
        url: source.base + '/issues/a1',
        body: 'Short issue',
      },
    ],
  });
  const first = await enrichStacks(snapshot(), source, app, get, h, now);
  assert.equal(first.observations[0]!.samples!.length, 1);
  assert.equal(first.warnings!.length, 1);
  assert.deepEqual(first.observations[0]!.value, { state: 'OPEN' });
  const second = await enrichStacks(snapshot(), source, app, get, h, now);
  assert.equal(second.observations[0]!.samples!.length, 1);
  assert.equal(eventReads, 2); // failure backoff
  fail = false;
  await enrichStacks(snapshot(), source, app, get, h, now + 301000);
  assert.equal(eventReads, 3);
  variants.push('v3');
  await enrichStacks(snapshot(), source, app, get, h, now + 302000);
  assert.equal(eventReads, 4);
  const bad = await enrichStacks(
    snapshot(),
    source,
    app,
    async () => {
      throw new Error('PRIVATE');
    },
    h,
    now,
  );
  assert.equal(bad.observations.length, 1);
  assert.match(bad.warnings![0]!, /coverage unknown/);
  assert.ok(!JSON.stringify(bad).includes('PRIVATE'));
});
test('bounded automatic downloads continue remaining variants on next poll', async (t) => {
  const h = home(t),
    s = parseSource(url, configSchema.parse({ ...cfg, maxSamplesPerPoll: 1 }));
  let reads = 0;
  const get = async (u: URL) =>
    u.pathname.endsWith('topVariants')
      ? report(['v1', 'v2'])
      : (++reads, { events: [event(u.searchParams.get('filter.issue.variantId')!)] });
  const snap = () => ({
    observations: [{ key: 'issue:a1', value: 1, body: 'A', url: source.base + '/issues/a1' }],
  });
  const first = await enrichStacks(snap(), s, app, get, h, now);
  assert.equal(reads, 1);
  assert.match(first.warnings!.join(), /budget/);
  const second = await enrichStacks(snap(), s, app, get, h, now);
  assert.equal(reads, 2);
  assert.equal(second.observations[0]!.samples!.length, 2);
});
test('variant discovery checkpoints require complete pagination, independent of downloaded samples', async (t) => {
  const h = home(t),
    inventories: string[][] = [];
  const snap = () => ({ observations: [{ key: 'issue:a1', value: 1, body: 'A', url }] });
  const partial = await enrichStacks(
    snap(),
    source,
    app,
    async (u) => {
      if (u.searchParams.has('pageToken')) throw new Error('page unavailable');
      return report(['v1'], { totalSize: 2, nextPageToken: 'next' });
    },
    h,
    now,
    Date.now() + 10000,
    undefined,
    (_key, variants) => inventories.push(variants),
  );
  assert.equal(inventories.length, 0);
  assert.equal(partial.observations[0]!.variants, undefined);
  const result = await enrichStacks(
    snap(),
    source,
    app,
    async (u) => {
      if (u.pathname.endsWith('topVariants')) return report(['v1', 'v2']);
      throw new Error('sample unavailable');
    },
    h,
    now,
    Date.now() + 10000,
    undefined,
    (_key, variants) => inventories.push(variants),
  );
  assert.deepEqual(inventories, [['v1', 'v2']]);
  assert.deepEqual(result.observations[0]!.variants, ['v1', 'v2']);
  assert.deepEqual(result.observations[0]!.samples, []);
});
test('corrupt or obsolete variant cursors recover; version-scoped scheduling remains independent', async (t) => {
  const h = home(t),
    reads: string[] = [];
  const s = parseSource(url, configSchema.parse({ ...cfg, maxSamplesPerPoll: 1 }));
  const snap = () => ({ observations: [{ key: 'issue:a1', value: 1, body: 'A', url }] });
  const get = async (u: URL) => {
    if (u.pathname.endsWith('topVariants')) return report(['v1', 'v2']);
    reads.push(u.searchParams.get('filter.issue.variantId')!);
    throw new Error('unavailable');
  };
  await enrichStacks(snap(), s, app, get, h, now);
  const cursor = path.join(
    h,
    'stack-cache',
    readdirSync(path.join(h, 'stack-cache')).find((f) => f.endsWith('.variants-progress.json'))!,
  );
  for (const [index, content] of ['invalid json', JSON.stringify({ next: 'obsolete' })].entries()) {
    privateWrite(cursor, content);
    await enrichStacks(snap(), s, app, get, h, now + (index + 1) * 86400000);
    assert.equal(reads.at(-1), 'v1');
  }
  const scoped = { ...s, config: { ...s.config, versions: ['different'] } };
  await enrichStacks(snap(), scoped, app, get, h, now);
  assert.equal(reads.at(-1), 'v1');
  assert.equal(
    readdirSync(path.join(h, 'stack-cache')).filter((f) => f.endsWith('.variants-progress.json'))
      .length,
    2,
  );
});
test('inspect selects other windows/variants, returns paths not stack content and never needs Hivemind', async (t) => {
  const h = home(t);
  const result = await inspectIssue(source, app, 'a1', async () => ({ events: [event('v9')] }), h, {
    variant: 'v9',
    now,
  });
  assert.equal(result.localOnly, true);
  assert.equal(result.files[0]!.variant, 'v9');
  assert.match(readFileSync(result.files[0]!.path, 'utf8'), /invented79/);
  assert.ok(!JSON.stringify(result).includes('invented79'));
  let input: any;
  await inspect(
    source.base + '/issues/a1?time=7d',
    cfg,
    h,
    async (c) => {
      input = JSON.parse(c.stdin!);
      return { stdout: JSON.stringify({ files: [] }) };
    },
    { variant: 'v9', days: 30, samples: 2 },
  );
  assert.equal(input.action, 'inspect');
  assert.equal(new URL(input.url).searchParams.get('time'), '30d');
  assert.equal(input.options.samples, 2);
  for (const bad of [
    url,
    url + '/../a1',
    url + '/a1?time=90d',
    url.replace('console.firebase.google.com', 'evil.invalid') + '/a1',
  ])
    assert.throws(() => parseIssue(bad, cfg));
});
