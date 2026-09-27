import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CrashlyticsBot, init, hiveOrigin, privateJson } from '../src/runtime.ts';
import { definitionId, label } from '../src/provider.ts';
import { saveArtifact, loadArtifact, maxArtifactBytes } from '../src/artifacts.ts';
const url =
  'https://console.firebase.google.com/project/test-app/crashlytics/app/ios:com.example.app/issues';
const other = url.replace('com.example.app', 'com.example.second');
const root = fileURLToPath(new URL('../', import.meta.url));
async function setup(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), definitionId + '-test-'));
  const channels = ['one', 'two'].map((id) => ({
    id,
    name: id,
    type: 'private',
    projectId: 'p',
    memberIds: [] as string[],
  }));
  const agents: any[] = [],
    received: any[] = [],
    uploads: any[] = [],
    events = new Map<string, any>();
  let fail = 0,
    missingAck = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const data of req) raw += data;
    const body = raw && req.url !== '/api/bot/files' ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === '/api/ui/snapshot') {
      send({ channels, agents });
      return;
    }
    if (req.url === '/api/ui/projects/p/bots') {
      const bot = { id: 'b' + agents.length, name: body.name, role: 'bot', projectId: 'p' };
      agents.push(bot);
      send({ bot, token: 'fixture-only-' + bot.id });
      return;
    }
    if (req.url === '/api/bot/files') {
      const file = {
        id: 'file' + uploads.length,
        name: req.headers['x-file-name'],
        mime: req.headers['x-file-mime'],
        bytes: Buffer.byteLength(raw),
        raw,
      };
      uploads.push(file);
      send({ file });
      return;
    }
    const channel = channels.find((c) => req.url?.includes('/channels/' + c.id + '/'));
    if (!channel) {
      res.statusCode = 404;
      send({ error: 'missing' });
      return;
    }
    if (req.url?.endsWith('/bots')) {
      const bot = { id: 'b' + agents.length, name: body.name, role: 'bot' };
      agents.push(bot);
      channel.memberIds.push(bot.id);
      send({ bot, token: 'fixture-only-' + bot.id });
      return;
    }
    if (req.url?.endsWith('/invite')) {
      channel.memberIds.push(agents.find((a) => a.name === body.names[0]).id);
      send({ channel });
      return;
    }
    if (req.url?.startsWith('/api/bot/') && req.url.endsWith('/messages')) {
      if (fail) {
        res.statusCode = fail;
        send({ error: 'fixture' });
        return;
      }
      const bot = agents.find((a) => req.headers.authorization === 'Bearer fixture-only-' + a.id);
      assert.ok(bot && channel.memberIds.includes(bot.id));
      const key = channel.id + ':' + body.eventId;
      let message = events.get(key);
      if (!message) {
        message = {
          id: String(events.size + 1),
          channelId: channel.id,
          authorId: bot.id,
          authorRole: 'bot',
          botEvent: { eventId: body.eventId },
          body: body.body,
          attachmentIds: body.attachmentIds,
        };
        events.set(key, message);
        received.push(message);
      } else
        assert.deepEqual(
          message.attachmentIds,
          body.attachmentIds,
          'retry must reuse attachment IDs',
        );
      if (missingAck) {
        missingAck = false;
        req.socket.destroy();
        return;
      }
      send({ message });
      return;
    }
    res.statusCode = 404;
    send({});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hiveUrl = 'http://127.0.0.1:' + (server.address() as any).port;
  init(home, { hiveUrl, host: new URL(url).host });
  let bot = new CrashlyticsBot(home, async () => {
    throw new Error('NO REAL PROVIDER IN THIS TEST');
  });
  t.after(async () => {
    bot.desired(false);
    for (let i = 0; i < 50 && bot.isRunning(); i++) await delay(100);
    bot.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    hiveUrl,
    channels,
    agents,
    received,
    uploads,
    get bot() {
      return bot;
    },
    reopen() {
      bot.close();
      bot = new CrashlyticsBot(home);
    },
    fail(code: number) {
      fail = code;
    },
    loseAck() {
      missingAck = true;
    },
  };
}
function snapshot(text = 'Invented observation') {
  return { observations: [{ key: 'one', value: text, body: text, url }] };
}
async function cli(home: string, args: string[]) {
  const child = spawn(
    process.execPath,
    [path.join(root, 'bin', definitionId + '.mjs'), '--home', home, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '',
    err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code] = await once(child, 'close');
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}
test('follow reuses one bot across sources/channels; status and restart retain links without reading', async (t) => {
  const f = await setup(t);
  const one = await f.bot.follow(url, 'one');
  await f.bot.follow(other, 'one');
  await f.bot.follow(url, 'two');
  assert.equal((await f.bot.follow(url, 'one')).id, one.id);
  assert.equal(f.agents.length, 1);
  assert.equal(f.bot.subscriptions().length, 3);
  assert.equal(f.agents[0].name, label);
  assert.equal(f.received.length, 0);
  assert.equal(f.bot.status().monitorRunning, false);
  assert.ok(!JSON.stringify(f.bot.status()).includes('fixture-only'));
  assert.equal(statSync(path.join(f.home, 'state.db')).mode & 0o777, 0o600);
  f.reopen();
  assert.equal(f.bot.subscriptions().length, 3);
});
test('new bots use readable numeric names when other identities already own the label', async (t) => {
  const f = await setup(t);
  f.agents.push(
    { id: 'existing-brain', name: label.toLowerCase(), role: 'brain' },
    { id: 'existing-bot', name: label + '-2', role: 'bot' },
  );
  const link = await f.bot.follow(url, 'one');
  assert.equal(link.bot, label + '-3');
  assert.equal(f.agents.length, 3);
  assert.equal(f.received.length, 0);
});
test('any chosen public/private channel can mix apps and other bots; no channel is created', async (t) => {
  const f = await setup(t);
  f.channels[0]!.name = 'reviews-and-crashes';
  f.channels[0]!.type = 'public';
  f.agents.push({ id: 'gitlab-existing', name: 'GitLab', role: 'bot' });
  f.channels[0]!.memberIds.push('gitlab-existing');
  const a = await f.bot.follow(url, 'one'),
    b = await f.bot.follow(other, 'one');
  await f.bot.follow(url, 'two');
  assert.equal(f.channels.length, 2);
  assert.equal(a.channel, 'one');
  assert.equal(b.channel, 'one');
  assert.equal(f.agents.filter((x) => x.name === label).length, 1);
  assert.ok(f.channels[0]!.memberIds.includes('gitlab-existing'));
  assert.equal(f.received.length, 0);
});
test('same app in two arbitrary channels shares one provider read per cycle', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  await f.bot.follow(url, 'two');
  let calls = 0;
  const reader = new CrashlyticsBot(f.home, async () => {
    calls++;
    return { stdout: JSON.stringify(snapshot()) };
  });
  try {
    const results = await reader.cycle();
    assert.equal(calls, 1);
    assert.equal(results.length, 2);
    assert.equal(f.received.length, 2);
    assert.deepEqual(new Set(f.received.map((x) => x.channelId)), new Set(['one', 'two']));
  } finally {
    reader.close();
  }
});
test('a renamed bot keeps its identity and uses its current name for subsequent invitations', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  const botId = f.agents[0].id;
  f.agents[0].name = label + '-Work';
  f.reopen();
  const link = await f.bot.follow(url, 'two');
  assert.equal(link.bot, label + '-Work');
  assert.equal(f.agents.length, 1);
  assert.deepEqual(f.channels[1].memberIds, [botId]);
  assert.equal(
    f.bot.db.prepare('SELECT name FROM bots WHERE id=?').get(botId)!.name,
    label + '-Work',
  );
  assert.equal(f.received.length, 0);
});
test('persistent snapshot dedup, observed edits/reversion and no deletion inference', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  let sub = f.bot.subscriptions()[0]!;
  assert.equal(f.bot.apply(sub, snapshot()), 1);
  await f.bot.deliver();
  assert.equal(f.received.length, 1);
  f.reopen();
  sub = f.bot.subscriptions()[0]!;
  const due = sub.next_at;
  await f.bot.follow(url, 'one');
  assert.equal(f.bot.subscriptions()[0]!.next_at, due);
  assert.equal(f.bot.apply(sub, snapshot()), 0);
  assert.equal(f.bot.apply(sub, snapshot('Edited')), 1);
  await f.bot.deliver();
  assert.equal(f.bot.apply(sub, { observations: [] }), 0);
  assert.equal(f.bot.apply(sub, snapshot()), 1);
  await f.bot.deliver();
  assert.equal(f.received.length, 3);
});
test('baseline is quiet; bad snapshot rolls back all fingerprints and events', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one', 'baseline');
  const sub = f.bot.subscriptions()[0]!;
  assert.equal(f.bot.apply(sub, snapshot()), 0);
  assert.throws(() =>
    f.bot.apply(sub, {
      observations: [
        ...snapshot('new').observations,
        { key: 'bad', value: 1, body: 'bad', url: 'https://wrong.invalid/' },
      ],
    }),
  );
  assert.equal(f.bot.apply(sub, snapshot('new')), 1);
  assert.throws(
    () =>
      f.bot.apply(sub, { observations: [...snapshot().observations, ...snapshot().observations] }),
    /Duplicate/,
  );
});
for (const deferred of [false, true])
  test(`baseline variant inventory survives restarts and only mutes existing variants (deferred=${deferred})`, async (t) => {
    const f = await setup(t);
    await f.bot.follow(url, 'one', 'baseline');
    await f.bot.follow(url, 'two', 'snapshot');
    const artifact = saveArtifact(f.home, 'fixture.txt', 'invented stack');
    const snap = (variants?: string[], samples: string[] = []) => ({
      observations: [
        {
          key: 'issue:a1',
          value: 1,
          body: 'Crash',
          url,
          variants,
          samples: samples.map((variant) => ({ variant, artifact })),
        },
      ],
    });
    for (const sub of f.bot.subscriptions())
      assert.equal(
        f.bot.apply(sub, snap(deferred ? undefined : ['v1', 'v2'])),
        sub.channel === 'one' ? 0 : 1,
      );
    f.reopen();
    for (const sub of f.bot.subscriptions())
      assert.equal(f.bot.apply(sub, snap(['v1', 'v2'], ['v1'])), sub.channel === 'one' ? 0 : 1);
    f.reopen();
    for (const sub of f.bot.subscriptions()) {
      assert.equal(f.bot.apply(sub, snap(['v1', 'v2'], ['v2'])), sub.channel === 'one' ? 0 : 1);
      assert.equal(f.bot.apply(sub, snap(['v1', 'v2', 'v3'], ['v1', 'v2', 'v3'])), 1);
      assert.equal(f.bot.apply(sub, snap(['v1', 'v2', 'v3'], ['v1', 'v2', 'v3'])), 0);
    }
    assert.equal(f.bot.db.prepare('SELECT count(*) n FROM baseline_pending').get()!.n, 0);
    assert.equal(f.bot.db.prepare('SELECT count(*) n FROM samples_seen').get()!.n, 6);
    await f.bot.deliver();
    const quiet = f.received.filter((message) => message.channelId === 'one');
    assert.equal(quiet.length, 1);
    assert.match(quiet[0].body, /Attached: 1 variant/);
  });
test('metadata changes end a pending baseline; new issues and an empty inventory never mute new samples', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one', 'baseline');
  const sub = f.bot.subscriptions()[0]!;
  const artifact = saveArtifact(f.home, 'fixture.txt', 'invented stack');
  const observation = { key: 'issue:a1', value: 1, body: 'Crash', url };
  assert.equal(f.bot.apply(sub, { observations: [observation] }), 0);
  f.reopen();
  assert.equal(f.bot.apply(sub, { observations: [{ ...observation, value: 2 }] }), 1);
  assert.equal(f.bot.db.prepare('SELECT count(*) n FROM baseline_pending').get()!.n, 0);
  assert.equal(
    f.bot.apply(sub, {
      observations: [
        { ...observation, value: 2, variants: ['v1'], samples: [{ variant: 'v1', artifact }] },
      ],
    }),
    1,
  );
  assert.equal(
    f.bot.apply(sub, {
      observations: [
        {
          ...observation,
          key: 'issue:new',
          variants: ['v1'],
          samples: [{ variant: 'v1', artifact }],
        },
      ],
    }),
    1,
  );
  await f.bot.follow(url, 'two', 'baseline');
  const empty = f.bot.subscriptions().find((s) => s.channel === 'two')!;
  assert.equal(f.bot.apply(empty, { observations: [{ ...observation, variants: [] }] }), 0);
  assert.equal(
    f.bot.apply(empty, {
      observations: [{ ...observation, variants: ['v1'], samples: [{ variant: 'v1', artifact }] }],
    }),
    1,
  );
});
test('invalid baseline inventories roll back pending state, known variants and events together', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one', 'baseline');
  const sub = f.bot.subscriptions()[0]!;
  const artifact = saveArtifact(f.home, 'fixture.txt', 'invented stack');
  const observation = { key: 'issue:a1', value: 1, body: 'Crash', url };
  assert.equal(f.bot.apply(sub, { observations: [observation] }), 0);
  for (const invalid of [
    { ...observation, key: 'issue:bad', variants: ['v1', 'v1'] },
    { ...observation, key: 'issue:bad', variants: ['v1'], samples: [{ variant: 'v2', artifact }] },
  ]) {
    assert.throws(() =>
      f.bot.apply(sub, { observations: [{ ...observation, variants: ['v1'] }, invalid] }),
    );
    assert.equal(f.bot.db.prepare('SELECT count(*) n FROM baseline_pending').get()!.n, 1);
    assert.equal(f.bot.db.prepare('SELECT count(*) n FROM baseline_variants').get()!.n, 0);
    assert.equal(f.bot.db.prepare('SELECT count(*) n FROM events').get()!.n, 0);
  }
});
test('lost acknowledgement retries same event; transient and terminal errors stay visible', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  const sub = f.bot.subscriptions()[0]!;
  f.bot.apply(sub, snapshot());
  f.loseAck();
  await f.bot.deliver();
  assert.equal(f.received.length, 1);
  f.bot.db.exec('UPDATE events SET next_at=0');
  await f.bot.deliver();
  assert.equal(f.received.length, 1);
  f.bot.apply(sub, snapshot('second'));
  f.fail(403);
  await f.bot.deliver();
  assert.equal(f.bot.db.prepare("SELECT COUNT(*) n FROM events WHERE state='blocked'").get()!.n, 1);
});
test('stack attachments bundle variants once, reuse upload receipts after restart/lost ACK, and attach only new variants', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  let sub = f.bot.subscriptions()[0]!;
  const snap = (ids: string[]) => ({
    observations: [
      {
        key: 'issue:a1',
        value: { state: 'OPEN' },
        body: 'Short crash',
        url,
        samples: ids.map((variant) => ({
          variant,
          artifact: saveArtifact(f.home, variant + '.txt', 'Invented full stack ' + variant),
        })),
      },
    ],
  });
  f.bot.apply(sub, snap(['v1', 'v2', 'v3', 'v4', 'v5']));
  f.loseAck();
  await f.bot.deliver();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].attachmentIds.length, 1);
  assert.match(f.uploads[0].raw, /v5/);
  assert.ok(!f.received[0].body.includes('Invented full stack'));
  f.reopen();
  sub = f.bot.subscriptions()[0]!;
  f.bot.db.exec('UPDATE events SET next_at=0');
  await f.bot.deliver();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.received.length, 1);
  assert.equal(f.bot.apply(sub, snap(['v1', 'v2', 'v3', 'v4', 'v5'])), 0);
  assert.equal(f.bot.apply(sub, snap(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'])), 1);
  await f.bot.deliver();
  assert.equal(f.uploads.length, 2);
  assert.match(f.uploads[1].raw, /v6/);
  assert.ok(!f.uploads[1].raw.includes('stack v1'));
});
test('same artifact for different channels receives separate upload IDs; quiet baseline and bad artifacts stay safe', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  await f.bot.follow(url, 'two', 'baseline');
  const artifact = saveArtifact(f.home, 'fixture.txt', 'invented stack');
  const snap = {
    observations: [
      { key: 'issue:a1', value: 1, body: 'Crash', url, samples: [{ variant: 'v1', artifact }] },
    ],
  };
  for (const sub of f.bot.subscriptions()) f.bot.apply(sub, snap);
  await f.bot.deliver();
  assert.equal(f.received.length, 1);
  const changed = {
    observations: [{ ...snap.observations[0]!, samples: [{ variant: 'v2', artifact }] }],
  };
  for (const sub of f.bot.subscriptions()) f.bot.apply(sub, changed);
  await f.bot.deliver();
  assert.equal(f.received.length, 3);
  assert.notEqual(f.received[1].attachmentIds[0], f.received[2].attachmentIds[0]);
  assert.throws(() =>
    f.bot.apply(f.bot.subscriptions()[0]!, {
      observations: [
        {
          ...snap.observations[0]!,
          samples: [{ variant: 'v3', artifact: { ...artifact, sha256: '../secret' } }],
        },
      ],
    }),
  );
});

test('oversized combined stacks split into bounded durable events without losing other issues', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  let sub = f.bot.subscriptions()[0]!;
  const snap = {
    observations: [
      { key: 'issue:healthy', value: 1, body: 'Synthetic normal crash', url },
      {
        key: 'issue:large',
        value: 1,
        body: 'Synthetic large crash',
        url,
        samples: ['v1', 'v2'].map((variant) => ({
          variant,
          artifact: saveArtifact(f.home, variant + '.txt', variant[1]!.repeat(17 * 1024 * 1024)),
        })),
      },
    ],
  };
  assert.equal(f.bot.apply(sub, snap), 3);
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM items').get()!.n, 2);
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM samples_seen').get()!.n, 2);
  const rows = f.bot.db.prepare('SELECT artifact FROM event_files').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const artifact = JSON.parse(String(row.artifact));
    assert.ok(artifact.bytes <= maxArtifactBytes);
    assert.equal(loadArtifact(f.home, artifact).length, 17 * 1024 * 1024);
  }
  const events = f.bot.db
    .prepare('SELECT event FROM events ORDER BY id')
    .all()
    .map((row) => JSON.parse(String(row.event)));
  assert.equal(new Set(events.map((e) => e.eventId)).size, 3);
  assert.match(events[1].body, /part 1\/2/);
  assert.match(events[2].body, /part 2\/2/);
  f.reopen();
  sub = f.bot.subscriptions()[0]!;
  assert.equal(f.bot.apply(sub, snap), 0);
  f.loseAck();
  await f.bot.deliver();
  f.bot.db.exec('UPDATE events SET next_at=0');
  await f.bot.deliver();
  assert.equal(f.received.length, 3);
  assert.equal(f.uploads.length, 2);
  assert.equal(f.bot.db.prepare("SELECT count(*) AS n FROM events WHERE state='sent'").get()!.n, 3);
});

test('split stacks preserve a quiet baseline and roll back all parts if a later artifact is corrupt', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one', 'baseline');
  const sub = f.bot.subscriptions()[0]!;
  const samples = ['v1', 'v2'].map((variant) => ({
    variant,
    artifact: saveArtifact(f.home, variant + '.txt', variant[1]!.repeat(17 * 1024 * 1024)),
  }));
  const observation = { key: 'issue:large', value: 1, body: 'Synthetic crash', url, samples };
  assert.equal(f.bot.apply(sub, { observations: [observation] }), 0);
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM samples_seen').get()!.n, 2);
  assert.equal(f.bot.apply(sub, { observations: [observation] }), 0);
  assert.throws(
    () =>
      f.bot.apply(sub, {
        observations: [
          {
            ...observation,
            value: 2,
            samples: [
              { ...samples[0]!, variant: 'v3' },
              {
                variant: 'v4',
                artifact: { sha256: 'a'.repeat(64), name: 'missing.txt', bytes: 17 * 1024 * 1024 },
              },
            ],
          },
        ],
      }),
    /ENOENT/,
  );
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM events').get()!.n, 0);
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM event_files').get()!.n, 0);
  assert.equal(f.bot.db.prepare('SELECT count(*) AS n FROM samples_seen').get()!.n, 2);
  assert.equal(f.bot.db.prepare('SELECT revision FROM items').get()!.revision, 1);
  // A valid later retry receives fresh IDs and queues every part, not just the last one.
  assert.equal(
    f.bot.apply(sub, {
      observations: [
        {
          ...observation,
          value: 2,
          samples: samples.map((sample, i) => ({ ...sample, variant: 'v' + (i + 3) })),
        },
      ],
    }),
    2,
  );
  const revisions = f.bot.db
    .prepare('SELECT event FROM events ORDER BY id')
    .all()
    .map((row) => JSON.parse(String(row.event)).eventId.split(':').at(-1));
  assert.deepEqual(revisions, ['2', '3']);
});
test('unfollow cancels queued events and ignores a late read result', async (t) => {
  const f = await setup(t);
  const link = await f.bot.follow(url, 'one');
  const sub = f.bot.subscriptions()[0]!;
  f.bot.apply(sub, snapshot());
  f.bot.unfollow(link.id);
  assert.equal(f.bot.apply(sub, snapshot('late')), 0);
  await f.bot.deliver();
  assert.equal(f.received.length, 0);
  assert.equal(f.bot.subscriptions()[0]!.enabled, 0);
});

for (const outcome of ['uploaded', 'failed'] as const) {
  test(`unfollow during attachment upload stays cancelled (${outcome})`, async (t) => {
    const f = await setup(t);
    await f.bot.follow(url, 'one');
    const sub = f.bot.subscriptions()[0]!;
    const artifact = saveArtifact(f.home, 'stack.txt', 'Synthetic diagnostic');
    f.bot.apply(sub, {
      observations: [{ ...snapshot().observations[0]!, samples: [{ variant: 'v1', artifact }] }],
    });
    const request = f.bot.request.bind(f.bot);
    t.mock.method(
      f.bot,
      'request',
      async (route: string, options: RequestInit, signal?: AbortSignal) => {
        if (route !== '/api/bot/files') return request(route, options, signal);
        const uploaded = await request(route, options, signal);
        const operator = new CrashlyticsBot(f.home);
        try {
          operator.unfollow(sub.id);
        } finally {
          operator.close();
        }
        if (outcome === 'failed') throw new Error('Hivemind HTTP 503');
        return uploaded;
      },
    );
    await f.bot.deliver();
    assert.equal(f.received.length, 0, 'must not start a message request after unfollow');
    assert.equal(f.bot.db.prepare('SELECT state FROM events').get()!.state, 'cancelled');
    await f.bot.follow(url, 'one');
    f.bot.db.exec('UPDATE events SET next_at=0');
    await f.bot.deliver();
    assert.equal(f.received.length, 0, 'following again must not resurrect cancelled events');
  });
}

test('failed in-flight message cannot resurrect an event cancelled by unfollow', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  const sub = f.bot.subscriptions()[0]!;
  f.bot.apply(sub, snapshot());
  t.mock.method(f.bot, 'request', async () => {
    f.bot.unfollow(sub.id);
    throw new Error('Hivemind HTTP 403');
  });
  await f.bot.deliver();
  assert.equal(f.bot.db.prepare('SELECT state FROM events').get()!.state, 'cancelled');
});

test('private JSON writes do not follow a predictable temporary symlink; init rejects empty existing profiles', async (t) => {
  const f = await setup(t);
  const victim = path.join(f.home, 'unrelated.txt');
  const target = path.join(f.home, 'saved.json');
  writeFileSync(victim, 'untouched');
  symlinkSync(victim, target + '.next');
  privateJson(target, { value: 1 });
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  writeFileSync(path.join(f.home, 'config.json'), '');
  assert.throws(() => init(f.home, { hiveUrl: f.hiveUrl }));
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), '');
});

test('blocked deliveries require explicit stopped-profile retry, keeping order and attachment receipts', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  const sub = f.bot.subscriptions()[0]!;
  const artifact = saveArtifact(f.home, 'stack.txt', 'Invented stack');
  f.bot.apply(sub, {
    observations: [{ ...snapshot().observations[0]!, samples: [{ variant: 'v1', artifact }] }],
  });
  f.fail(403);
  await f.bot.deliver();
  f.bot.apply(sub, snapshot('second'));
  f.fail(0);
  f.bot.db.exec('UPDATE events SET next_at=0');
  await f.bot.deliver();
  assert.equal(f.received.length, 0, 'no automatic retry of a denial');
  const before = f.bot.db.prepare('SELECT event FROM events ORDER BY id').all();
  const unlock = f.bot.lock();
  try {
    assert.throws(() => f.bot.retry(sub.id), /Stop the monitor/);
  } finally {
    unlock();
  }
  assert.throws(() => f.bot.retry('missing'), /Unknown/);
  assert.deepEqual(f.bot.retry(sub.id), { id: sub.id, requeued: 1, monitorRunning: false });
  assert.equal(f.received.length, 0, 'retry configures only');
  assert.deepEqual(f.bot.db.prepare('SELECT event FROM events ORDER BY id').all(), before);
  await f.bot.deliver();
  assert.deepEqual(
    f.received.map((m) => m.body),
    [
      'Invented observation\nAttached: 1 variant sample(s), one representative per variant. Open the TXT only when needed.',
      'second',
    ],
  );
  assert.equal(f.uploads.length, 1);
  assert.equal(f.bot.retry(sub.id).requeued, 0);
  f.bot.unfollow(sub.id);
  assert.throws(() => f.bot.retry(sub.id), /disabled/);
});

test('malformed reader snapshots fail without committing a partial observation', async (t) => {
  const f = await setup(t);
  await f.bot.follow(url, 'one');
  for (const malformed of [
    { observations: [{ key: 'oops', body: 'bad', url }] },
    { observations: [{ key: 'oops', value: 1, body: 42, url }] },
  ]) {
    const reader = new CrashlyticsBot(f.home, async () => ({ stdout: JSON.stringify(malformed) }));
    try {
      const results = await reader.cycle();
      assert.match(results[0].error, /expected schema/);
      assert.equal(reader.db.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 0);
      assert.equal(reader.subscriptions()[0]!.initialized, 0);
    } finally {
      reader.close();
    }
  }
  assert.equal(f.received.length, 0);
});

test('CLI rejects misplaced flags, extra init arguments and bounded runs finish without sources', async (t) => {
  const f = await setup(t);
  for (const args of [
    ['follow', url, '--channel', 'one', '--no-auto-stacks'],
    ['status', '--account', 'fixture@example.com'],
    ['init', 'unexpected'],
  ]) {
    const result = await cli(f.home, args);
    assert.equal(result.code, 1, result.err);
  }
  const result = await cli(f.home, ['run', '--max-polls', '1']);
  assert.equal(result.code, 0, result.err);
  assert.equal(f.bot.isRunning(), false);
  assert.equal(f.bot.desired(), false);
  assert.equal(f.agents.length, 0);
});
test('a large blocked or backed-off subscription cannot starve other destinations', async (t) => {
  const f = await setup(t);
  const first = await f.bot.follow(url, 'one');
  const second = await f.bot.follow(url, 'two');
  const blocked = f.bot.subscriptions().find((sub) => sub.id === first.id)!;
  const healthy = f.bot.subscriptions().find((sub) => sub.id === second.id)!;
  for (let i = 0; i < 202; i++) f.bot.apply(blocked, snapshot('blocked-' + i));
  f.bot.apply(healthy, snapshot('healthy'));
  f.bot.db.exec("UPDATE events SET state='blocked',error='Hivemind HTTP 403' WHERE id=1");
  await f.bot.deliver();
  assert.deepEqual(
    f.received.map((message) => message.body),
    ['healthy'],
  );
  f.bot.db
    .prepare("UPDATE events SET state='pending',next_at=? WHERE id=1")
    .run(Date.now() + 60000);
  f.bot.apply(healthy, snapshot('healthy again'));
  await f.bot.deliver();
  assert.deepEqual(
    f.received.map((message) => message.body),
    ['healthy', 'healthy again'],
  );
});

test('bad targets never create bots and local identity cannot silently retarget', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.bot.follow('https://wrong.invalid/x', 'one'));
  await assert.rejects(f.bot.follow(url, 'unknown'));
  assert.equal(f.agents.length, 0);
  assert.throws(() => init(f.home, { hiveUrl: f.hiveUrl, host: 'other.invalid' }));
  assert.throws(() => hiveOrigin('http://example.com'));
  assert.throws(() => hiveOrigin('http://127.0.0.1/other'));
});
test('real CLI follow --no-start, status and unfollow make no provider calls', async (t) => {
  const f = await setup(t);
  const followed = await cli(f.home, ['follow', url, '--channel', 'one', '--no-start']);
  assert.equal(followed.code, 0, followed.err);
  const link = JSON.parse(followed.out);
  assert.equal(link.monitorRunning, false);
  assert.equal((await cli(f.home, ['status'])).code, 0);
  assert.equal((await cli(f.home, ['unfollow', '--id', link.id])).code, 0);
  assert.equal(f.received.length, 0);
});
test(
  'one owned daemon per profile, normal stop releases lock without touching other processes',
  { timeout: 15000 },
  async (t) => {
    const f = await setup(t);
    await f.bot.start();
    assert.equal(f.bot.isRunning(), true);
    await f.bot.start();
    assert.throws(() => f.bot.lock());
    const blocked = await cli(f.home, ['follow', url, '--channel', 'one', '--no-start']);
    assert.notEqual(blocked.code, 0);
    assert.equal(f.bot.subscriptions().length, 0);
    const stopped = await cli(f.home, ['stop']);
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(f.bot.isRunning(), false);
  },
);
