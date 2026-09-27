import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect as inspectValue } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { configSchema, parseSource, read } from '../src/provider.ts';
import { enrichStacks } from '../src/readers/stacks.ts';
import { runCommand, ReaderTimeoutError } from '../src/readers/process.ts';
import { readMonitor } from '../src/readers/monitor.ts';
import { configureProfile } from '../src/profile.ts';
import { CrashlyticsBot } from '../src/runtime.ts';
const url =
  'https://console.firebase.google.com/project/fixture/crashlytics/app/ios:com.example.app/issues';
const config = configSchema.parse({ hiveUrl: 'http://127.0.0.1:1', maxSamplesPerPoll: 1 });
const source = parseSource(url, config),
  app = '1:123456:ios:abcdef';
const now = Date.now();
const snapshot = () => ({
  observations: ['first', 'second', 'third'].map((issue) => ({
    key: 'issue:' + issue,
    value: { state: 'OPEN' },
    body: 'Synthetic crash',
    url: source.base + '/issues/' + issue,
  })),
});

test('reader deadline retains a complete metadata checkpoint, with an incomplete-stack warning', async () => {
  const metadata = snapshot();
  const result = await read(url, config, os.tmpdir(), (command) =>
    runCommand({
      ...command,
      timeoutMs: 500,
      args: [
        '-e',
        `console.log(${JSON.stringify(JSON.stringify({ type: 'metadata', snapshot: metadata }))});setInterval(()=>{},1000)`,
      ],
    }),
  );
  assert.deepEqual(result.observations, metadata.observations);
  assert.match(result.warnings!.join(), /stack.*incomplete/i);
});

test('output overflow during timeout shutdown cannot recover an apparently complete checkpoint', async () => {
  const checkpoint = JSON.stringify({ type: 'metadata', snapshot: snapshot() });
  await assert.rejects(
    read(url, config, os.tmpdir(), (command) =>
      runCommand({
        ...command,
        timeoutMs: 500,
        maxOutputBytes: Buffer.byteLength(checkpoint) + 16,
        args: [
          '-e',
          `process.on('SIGTERM',()=>process.stdout.write('x'.repeat(4096),()=>process.exit(0)));console.log(${JSON.stringify(checkpoint)});setInterval(()=>{},1000)`,
        ],
      }),
    ),
    /output exceeded/,
  );
});

test('enrichment stops discovery at the sample budget and rotates to later issues next poll', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crash-budget-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const discoveries: string[] = [];
  const get = async (u: URL) => {
    const issue = u.searchParams.get('filter.issue.id')!;
    if (u.pathname.endsWith('topVariants')) {
      discoveries.push(issue);
      return {
        name: `projects/123456/apps/${app}/reports/topVariants`,
        totalSize: 1,
        groups: [
          {
            issue: { id: issue },
            variant: { id: 'v1' },
            metrics: [
              {
                startTime: u.searchParams.get('filter.interval.startTime'),
                endTime: u.searchParams.get('filter.interval.endTime'),
              },
            ],
          },
        ],
      };
    }
    return {
      events: [
        {
          name: `projects/123456/apps/${app}/events/${issue}`,
          eventTime: new Date(now - 1000).toISOString(),
          issue: { id: issue },
          issueVariant: { id: 'v1' },
          threads: [{ frames: [{ symbol: 'synthetic' }] }],
        },
      ],
    };
  };
  for (let poll = 0; poll < 3; poll++) {
    const result = await enrichStacks(snapshot(), source, app, get, home, now);
    assert.equal(result.observations.length, 3);
    assert.equal(discoveries.length, poll + 1);
    assert.equal(result.observations[poll]!.samples!.length, 1);
  }
  assert.deepEqual(discoveries, ['first', 'second', 'third']);
});

test('an exhausted enrichment deadline makes no request and keeps every issue', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crash-deadline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const result = await enrichStacks(
    snapshot(),
    source,
    app,
    async () => {
      calls++;
      throw Error('No request allowed');
    },
    home,
    now,
    Date.now() - 1,
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.observations, snapshot().observations);
  assert.match(result.warnings!.join(), /deadline/i);
});

test('timeout output stays private; partial/invalid checkpoints and other failures never become successful reads', async () => {
  const metadata = snapshot();
  const checkpoint = JSON.stringify({ type: 'metadata', snapshot: metadata }) + '\n';
  const error = new ReaderTimeoutError('PRIVATE-DIAGNOSTIC');
  assert.doesNotMatch(
    String(error) + JSON.stringify(error) + inspectValue(error),
    /PRIVATE-DIAGNOSTIC/,
  );
  for (const output of [
    '',
    checkpoint.trim(),
    '{partial\n',
    JSON.stringify({ type: 'other', snapshot: metadata }) + '\n',
    JSON.stringify({
      type: 'metadata',
      snapshot: { observations: [{ ...metadata.observations[0], samples: [] }] },
    }) + '\n',
  ])
    await assert.rejects(
      read(url, config, os.tmpdir(), async () => {
        throw new ReaderTimeoutError(output);
      }),
      /timed out/,
    );
  await assert.rejects(
    read(url, config, os.tmpdir(), async () => {
      throw new Error('Reader command exited 7');
    }),
    /exited 7/,
  );
  await assert.rejects(
    read(url, { ...config, autoStacks: false }, os.tmpdir(), async () => {
      throw new ReaderTimeoutError(checkpoint);
    }),
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort(new Error('operator cancellation'));
  await assert.rejects(
    read(
      url,
      config,
      os.tmpdir(),
      async () => {
        throw new ReaderTimeoutError(checkpoint);
      },
      controller.signal,
    ),
    /operator cancellation/,
  );
  const result = await read(url, config, os.tmpdir(), async () => ({
    stdout: checkpoint + JSON.stringify(metadata) + '\n',
  }));
  assert.deepEqual(result.observations, metadata.observations);
  await assert.rejects(
    read(url, config, os.tmpdir(), async () => ({
      stdout: checkpoint + JSON.stringify({ error: 'Firebase GET HTTP 403' }),
    })),
    /403/,
  );
  await assert.rejects(
    read(url, config, os.tmpdir(), async () => ({
      stdout: checkpoint + checkpoint + JSON.stringify(metadata),
    })),
    /unexpected records/,
  );
});

test('a failed or incomplete metadata report never emits a checkpoint', async () => {
  let checkpoints = 0;
  const options = {
    prefetchStacks: true,
    deadline: Date.now() + 1000,
    checkpoint: () => {
      checkpoints++;
    },
  };
  await assert.rejects(
    readMonitor(
      source,
      app,
      async () => {
        throw new Error('provider unavailable');
      },
      os.tmpdir(),
      options,
    ),
    /provider unavailable/,
  );
  await assert.rejects(
    readMonitor(
      source,
      app,
      async () => ({
        name: `projects/123456/apps/${app}/reports/topIssues`,
        groups: [],
        totalSize: 2,
      }),
      os.tmpdir(),
      options,
    ),
    /Incomplete report/,
  );
  assert.equal(checkpoints, 0);
});

test('a deadline after an additional error or partial result cannot mask that ambiguous outcome', async () => {
  const checkpoint = JSON.stringify({ type: 'metadata', snapshot: snapshot() }) + '\n';
  for (const tail of [
    JSON.stringify({ error: 'Firebase GET HTTP 403' }) + '\n',
    '{"error":',
    '{"observations":',
  ])
    await assert.rejects(
      read(url, config, os.tmpdir(), async () => {
        throw new ReaderTimeoutError(checkpoint + tail);
      }),
      /timed out/,
    );
});

test('persistent timeouts retain healthy stacks exactly once across restarts', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crash-persistent-timeout-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, {
    projectId: 'fixture',
    config: { ...config, maxSamplesPerPoll: 20, timeoutSeconds: 5 },
  });
  const makeBot = () => {
    const bot = new CrashlyticsBot(home, (command) =>
      runCommand({
        ...command,
        timeoutMs: 1000,
        args: [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('./fixtures/enrichment-reader.ts', import.meta.url)),
          'persistent-stall',
        ],
      }),
    );
    bot.deliver = async () => {};
    return bot;
  };
  let bot = makeBot();
  bot.db
    .prepare(
      "INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES(?,?,?,?,1,'snapshot')",
    )
    .run('sub', url, 'fixture-channel', 'fixture-bot');
  try {
    for (let poll = 0; poll < 3; poll++) {
      const result = await bot.cycle();
      assert.equal(result[0].observed, 2);
      assert.equal(result[0].queued, poll === 0 ? 2 : 0);
      assert.equal(bot.db.prepare('SELECT count(*) AS n FROM event_files').get()!.n, 1);
      assert.equal(bot.db.prepare('SELECT item FROM samples_seen').get()!.item, 'issue:issue0');
      assert.match(
        String(bot.db.prepare('SELECT warnings FROM subscriptions').get()!.warnings),
        /incomplete/,
      );
      bot.close();
      bot = makeBot();
    }
  } finally {
    bot.close();
  }
});

test('sample checkpoints are bound to the report and cannot mask errors, cancellation or partial output', async () => {
  const metadata = snapshot();
  const checkpoint = JSON.stringify({ type: 'metadata', snapshot: metadata }) + '\n';
  const sample = {
    variant: 'v1',
    artifact: { sha256: 'a'.repeat(64), name: 'fixture.txt', bytes: 12 },
  };
  const frame = JSON.stringify({ type: 'sample', key: 'issue:first', sample }) + '\n';
  const recover = (stdout: string, signal?: AbortSignal) =>
    read(
      url,
      config,
      os.tmpdir(),
      async () => {
        throw new ReaderTimeoutError(stdout);
      },
      signal,
    );
  const result = await recover(checkpoint + frame);
  assert.deepEqual(result.observations[0]!.samples, [sample]);
  assert.equal(result.observations[1]!.samples, undefined);
  for (const invalid of [
    checkpoint + frame.trim(), // complete JSON without the completed-frame delimiter
    checkpoint + frame + '{"type":',
    checkpoint + frame + JSON.stringify({ error: 'provider failed' }) + '\n',
    checkpoint + frame + JSON.stringify(metadata) + '\n', // final output during shutdown is ambiguous
    checkpoint + frame + frame,
    checkpoint + JSON.stringify({ type: 'sample', key: 'unknown', sample }) + '\n',
    checkpoint +
      JSON.stringify({
        type: 'sample',
        key: 'issue:first',
        sample: { ...sample, artifact: { ...sample.artifact, sha256: '../private' } },
      }) +
      '\n',
    frame,
  ])
    await assert.rejects(recover(invalid), /timed out/);
  const controller = new AbortController();
  controller.abort(new Error('operator cancellation'));
  await assert.rejects(recover(checkpoint + frame, controller.signal), /operator cancellation/);
  await assert.rejects(
    read(url, config, os.tmpdir(), async () => ({
      stdout: checkpoint + frame + '{"error":"provider failed"}\n',
    })),
    /provider failed/,
  );
  await assert.rejects(
    read(url, config, os.tmpdir(), async () => ({ stdout: checkpoint + frame })),
    /./,
  );
  const final = {
    ...metadata,
    observations: metadata.observations.map((observation, i) =>
      i ? observation : { ...observation, samples: [sample] },
    ),
  };
  assert.deepEqual(
    await read(url, config, os.tmpdir(), async () => ({
      stdout: checkpoint + frame + JSON.stringify(final) + '\n',
    })),
    final,
  );
});

test('complete variant inventories survive deadlines; invalid, reordered or partial inventory frames fail closed', async () => {
  const checkpoint = JSON.stringify({ type: 'metadata', snapshot: snapshot() }) + '\n';
  const inventory = (key: string, variants: string[]) =>
    JSON.stringify({ type: 'variants', key, variants }) + '\n';
  const frame = inventory('issue:first', ['v1', 'v2']);
  const sample = {
    variant: 'v1',
    artifact: { sha256: 'a'.repeat(64), name: 'fixture.txt', bytes: 12 },
  };
  const completed = JSON.stringify({ type: 'sample', key: 'issue:first', sample }) + '\n';
  const recover = (stdout: string, signal?: AbortSignal) =>
    read(
      url,
      config,
      os.tmpdir(),
      async () => {
        throw new ReaderTimeoutError(stdout);
      },
      signal,
    );
  assert.deepEqual((await recover(checkpoint + frame)).observations[0]!.variants, ['v1', 'v2']);
  assert.deepEqual((await recover(checkpoint + frame + completed)).observations[0]!.samples, [
    sample,
  ]);
  for (const tail of [
    frame.trim(),
    frame + '{"type":',
    frame + frame,
    inventory('missing', ['v1']),
    inventory('issue:first', ['v1', 'v1']),
    inventory('issue:first', ['v2']) + completed,
    completed + frame,
    frame + '{"error":"failed"}\n',
    frame + JSON.stringify(snapshot()) + '\n',
  ])
    await assert.rejects(recover(checkpoint + tail), /timed out/);
  const controller = new AbortController();
  controller.abort(new Error('operator cancellation'));
  await assert.rejects(recover(checkpoint + frame, controller.signal), /operator cancellation/);
});

for (const scenario of ['baseline', 'variant-stall'] as const)
  test(`${scenario}: deferred enrichment makes progress without replaying a quiet baseline`, async (t) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'crash-' + scenario + '-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    configureProfile(home, {
      projectId: 'fixture',
      config: { ...config, timeoutSeconds: 5, maxSamplesPerPoll: scenario === 'baseline' ? 1 : 20 },
    });
    const makeBot = () => {
      const bot = new CrashlyticsBot(home, (command) =>
        runCommand({
          ...command,
          timeoutMs: scenario === 'variant-stall' ? 1200 : command.timeoutMs,
          args: [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL('./fixtures/enrichment-reader.ts', import.meta.url)),
            scenario,
          ],
        }),
      );
      bot.deliver = async () => {};
      return bot;
    };
    let bot = makeBot();
    bot.db
      .prepare('INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES(?,?,?,?,1,?)')
      .run(
        'sub',
        url,
        'fixture-channel',
        'fixture-bot',
        scenario === 'baseline' ? 'baseline' : 'snapshot',
      );
    try {
      for (let poll = 0; poll < 3; poll++) {
        const result = await bot.cycle();
        assert.equal(result[0].observed, scenario === 'baseline' ? 2 : 1);
        assert.equal(result[0].queued, scenario === 'baseline' ? 0 : poll < 2 ? 1 : 0);
        const attachments = bot.db.prepare('SELECT count(*) AS n FROM event_files').get()!.n;
        assert.equal(attachments, scenario === 'baseline' || poll === 0 ? 0 : 1);
        if (scenario === 'variant-stall' && poll > 0)
          assert.equal(bot.db.prepare('SELECT variant FROM samples_seen').get()!.variant, 'v2');
        bot.close();
        bot = makeBot();
      }
    } finally {
      bot.close();
    }
  });

test(
  'hard reader deadlines queue all 36 issues, preserve dedup and advance to later stacks on restart',
  { timeout: 15000 },
  async (t) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'crash-enrichment-e2e-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    configureProfile(home, { config: { ...config, timeoutSeconds: 5 }, projectId: 'fixture' });
    let mode = 'stall';
    const makeBot = () => {
      const bot = new CrashlyticsBot(home, (command) =>
        runCommand({
          ...command,
          timeoutMs: mode === 'stall' ? 1000 : command.timeoutMs,
          args: [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL('./fixtures/enrichment-reader.ts', import.meta.url)),
            mode,
          ],
        }),
      );
      bot.deliver = async () => {}; // Only local queue assertions; no real channel/provider.
      return bot;
    };
    let bot = makeBot();
    bot.db
      .prepare(
        "INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES(?,?,?,?,1,'snapshot')",
      )
      .run('sub', url, 'fixture-channel', 'fixture-bot');
    try {
      for (let poll = 0; poll < 2; poll++) {
        const result = await bot.cycle();
        assert.equal(result[0].observed, 36);
        assert.equal(result[0].queued, poll === 0 ? 36 : 0);
        assert.equal(bot.db.prepare('SELECT count(*) AS n FROM events').get()!.n, 36);
        assert.match(
          String(bot.db.prepare('SELECT warnings FROM subscriptions').get()!.warnings),
          /incomplete/,
        );
        // Simulate a daemon restart: progress must survive, without live configuration edits.
        bot.close();
        bot = makeBot();
      }
      mode = 'normal';
      const result = await bot.cycle();
      assert.equal(result[0].observed, 36);
      assert.equal(result[0].queued, 1);
      assert.equal(bot.db.prepare('SELECT item FROM samples_seen').get()!.item, 'issue:issue2');
      assert.equal(bot.db.prepare('SELECT count(*) AS n FROM events').get()!.n, 37);
    } finally {
      bot.close();
    }
  },
);

test('a deadline inside paginated discovery makes no further request and rotates past the deferred issue', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crash-pagination-deadline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const wallNow = Date.now;
  let wall = wallNow(),
    calls = 0;
  t.mock.method(Date, 'now', () => wall);
  const result = await enrichStacks(
    snapshot(),
    source,
    app,
    async (u) => {
      calls++;
      wall += 1000;
      return {
        name: `projects/123456/apps/${app}/reports/topVariants`,
        groups: [],
        nextPageToken: 'second-page',
      };
    },
    home,
    now,
    wall + 500,
  );
  assert.equal(calls, 1);
  assert.equal(result.observations.length, 3);
  assert.match(result.warnings!.join(), /deadline/);
  const file = readdirSync(path.join(home, 'stack-cache')).find((f) =>
    f.endsWith('.progress.json'),
  )!;
  assert.equal(
    JSON.parse(readFileSync(path.join(home, 'stack-cache', file), 'utf8')).next,
    'issue:second',
  );
  writeFileSync(path.join(home, 'stack-cache', file), '{invalid');
  let first: string | undefined;
  await enrichStacks(
    snapshot(),
    source,
    app,
    async (u) => {
      first ??= u.searchParams.get('filter.issue.id')!;
      wall += 1000;
      throw new Error('synthetic timeout');
    },
    home,
    now,
    wall + 500,
  );
  assert.equal(first, 'first', 'corrupt scheduling state must remain recoverable');
});
