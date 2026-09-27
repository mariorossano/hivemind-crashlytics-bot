import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrashlyticsBot, main } from '../src/runtime.ts';
import { configureProfile } from '../src/profile.ts';
import { invoke } from '../src/bot-interface.ts';
import type { Command } from '../src/readers/process.ts';
import { DatabaseSync } from 'node:sqlite';

const config = { hiveUrl: 'http://127.0.0.1:1', autoStacks: true };
const source =
  'https://console.firebase.google.com/project/fixture/crashlytics/app/ios:com.example.app/issues';
const context = { projectId: 'fixture', botId: 'bot', botName: 'Crashlytics', arguments: {} };
const cases: Array<{ name: string; run: (home: string) => Promise<unknown> }> = [
  { name: 'CLI poll', run: (home) => main(['poll', '--home', home, '--id', 'sub']) },
  { name: 'CLI run', run: (home) => main(['run', '--home', home, '--max-polls', '1']) },
  {
    name: 'CLI follow',
    run: (home) => main(['follow', source, '--home', home, '--channel', 'channel']),
  },
  {
    name: 'CLI follow --no-start',
    run: (home) => main(['follow', source, '--home', home, '--channel', 'channel', '--no-start']),
  },
  { name: 'CLI start', run: (home) => main(['start', '--home', home]) },
  { name: 'CLI retry', run: (home) => main(['retry', '--home', home, '--id', 'sub']) },
  { name: 'native start', run: (home) => invoke(home, { ...context, tool: 'start' }) },
  {
    name: 'native follow',
    run: (home) =>
      invoke(home, { ...context, tool: 'follow', arguments: { url: source, channel: 'channel' } }),
  },
  {
    name: 'native retry',
    run: (home) => invoke(home, { ...context, tool: 'retry', arguments: { id: 'sub' } }),
  },
  {
    name: 'native connect',
    run: (home) =>
      invoke(home, { ...context, tool: 'connect', token: 'replacement-fixture-token' }),
  },
];

for (const item of cases) {
  test(`${item.name} rejects settings changed before admission, without side effects or leaked locks`, async (t) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-race-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    configureProfile(home, { config, projectId: context.projectId });
    await invoke(home, { ...context, tool: 'connect', token: 'original-fixture-token' });
    const saved = new CrashlyticsBot(home);
    t.after(() => saved.close());
    saved.db
      .prepare(
        "INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES(?,?,?,?,1,'snapshot')",
      )
      .run('sub', source, 'channel', 'bot');
    if (item.name.includes('retry'))
      saved.db
        .prepare("INSERT INTO events(subscription,event,state) VALUES(?,?,'blocked')")
        .run('sub', '{}');
    const desired = !item.name.includes('run');
    saved.desired(desired);
    const before = {
      subscriptions: saved.subscriptions(),
      events: saved.db.prepare('SELECT * FROM events').all(),
    };
    t.mock.method(console, 'log', () => {});
    let follows = 0;
    const follow = t.mock.method(CrashlyticsBot.prototype, 'follow', async () => {
      follows++;
      throw new Error('Unexpected follow with stale settings');
    });
    // Never spawn a real daemon even when exercising the unfixed start path.
    const running = t.mock.method(CrashlyticsBot.prototype, 'isRunning', () => true);
    const lock = CrashlyticsBot.prototype.lock;
    let raced = false;
    const reads: Array<{ config: { autoStacks: boolean }; prefetchStacks: boolean }> = [];
    t.mock.method(
      CrashlyticsBot.prototype,
      'lock',
      function (this: CrashlyticsBot, name = 'monitor') {
        if (name === 'setup' && !raced) {
          raced = true;
          configureProfile(home, {
            config: { ...config, autoStacks: false },
            projectId: context.projectId,
          });
        }
        if (name === 'setup')
          t.mock.method(this, 'runner', async (command: Command) => {
            reads.push(JSON.parse(command.stdin!));
            return { stdout: JSON.stringify({ observations: [] }) };
          });
        return lock.call(this, name);
      },
    );

    await assert.rejects(item.run(home), /Profile settings changed; run the command again/);
    assert.equal(raced, true);
    assert.equal(
      JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')).autoStacks,
      false,
    );
    assert.equal(saved.desired(), desired, 'rejected admission must preserve existing intent');
    assert.deepEqual(saved.subscriptions(), before.subscriptions);
    assert.deepEqual(saved.db.prepare('SELECT * FROM events').all(), before.events);
    assert.equal(saved.db.prepare('SELECT token FROM bots').get()?.token, 'original-fixture-token');
    assert.equal(follows, 0);
    assert.equal(reads.length, 0);
    // Both locks must have been released, even when validation rejected the command.
    lock.call(saved, 'setup')();
    lock.call(saved)();
    running.mock.restore();
    follow.mock.restore();
    if (item.name === 'CLI poll' || item.name === 'CLI run') {
      await item.run(home);
      assert.equal(reads.length, 1);
      assert.equal(reads[0]!.config.autoStacks, false);
      assert.equal(reads[0]!.prefetchStacks, false);
    }
  });
}

test('admission compares normalized settings, not JSON formatting or omitted defaults', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-normalized-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config, projectId: context.projectId });
  const bot = new CrashlyticsBot(home);
  t.after(() => bot.close());
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hiveUrl: config.hiveUrl + '/' }));
  const release = bot.lock('setup');
  try {
    assert.doesNotThrow(() => bot.assertCurrentConfig());
  } finally {
    release();
  }
});

for (const invalid of ['malformed', 'missing']) {
  test(`admission rejects ${invalid} settings without echoing contents or retaining locks`, async (t) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-invalid-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    configureProfile(home, { config, projectId: context.projectId });
    const saved = new CrashlyticsBot(home);
    t.after(() => saved.close());
    saved.desired(true);
    const lock = CrashlyticsBot.prototype.lock;
    t.mock.method(
      CrashlyticsBot.prototype,
      'lock',
      function (this: CrashlyticsBot, name = 'monitor') {
        if (name === 'setup') {
          const file = path.join(home, 'config.json');
          if (invalid === 'missing') rmSync(file);
          else writeFileSync(file, '{"fixture-private-content":');
        }
        return lock.call(this, name);
      },
    );
    await assert.rejects(main(['poll', '--home', home]), {
      message:
        'Cannot validate current profile settings; check the profile and run the command again',
    });
    assert.equal(saved.desired(), true);
    lock.call(saved, 'setup')();
    lock.call(saved)();
  });
}

test('stale instances can still request stop, report status and unfollow', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config, projectId: context.projectId });
  const bot = new CrashlyticsBot(home);
  t.after(() => bot.close());
  bot.db
    .prepare(
      "INSERT INTO subscriptions(id,url,channel,bot,enabled,initial) VALUES(?,?,?,?,1,'snapshot')",
    )
    .run('sub', source, 'channel', 'bot');
  bot.desired(true);
  configureProfile(home, {
    config: { ...config, autoStacks: false },
    projectId: context.projectId,
  });
  bot.desired(false);
  assert.equal(bot.desired(), false);
  assert.equal(bot.status().monitorRunning, false);
  assert.deepEqual(bot.unfollow('sub'), { id: 'sub', state: 'stopped' });
  assert.equal(bot.subscriptions()[0]!.enabled, 0);
});

test('first initialization owns setup before creating the retained profile identity', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-first-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { ...config, minUsers: 0 }, projectId: context.projectId });
  const exec = DatabaseSync.prototype.exec;
  let interleaved = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (!interleaved && sql.includes('CREATE TABLE IF NOT EXISTS meta')) {
      interleaved = true;
      assert.throws(
        () =>
          configureProfile(home, {
            config: { ...config, minUsers: 1 },
            projectId: context.projectId,
          }),
        /database is locked/,
      );
    }
    return result;
  });
  const first = new CrashlyticsBot(home);
  first.close();
  assert.equal(interleaved, true);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')).minUsers, 0);
  const next = new CrashlyticsBot(home);
  const release = next.lock('setup');
  try {
    assert.equal(next.config.minUsers, 0);
    next.assertCurrentConfig();
  } finally {
    release();
    next.close();
  }
});

test('a configure that wins first admission is loaded before recording any profile identity', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-first-save-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config, projectId: context.projectId });
  const lock = CrashlyticsBot.prototype.lock;
  let saved = false;
  t.mock.method(
    CrashlyticsBot.prototype,
    'lock',
    function (this: CrashlyticsBot, name = 'monitor') {
      if (name === 'setup' && !saved) {
        saved = true;
        configureProfile(home, {
          config: { ...config, minUsers: 1 },
          projectId: context.projectId,
        });
      }
      return lock.call(this, name);
    },
  );
  const first = new CrashlyticsBot(home);
  try {
    assert.equal(saved, true);
    assert.equal(first.config.minUsers, 1);
  } finally {
    first.close();
  }
  const next = new CrashlyticsBot(home);
  try {
    assert.equal(next.config.minUsers, 1);
  } finally {
    next.close();
  }
});

test('first initialization releases setup after invalid configuration or failed schema creation', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-first-failure-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config, projectId: context.projectId });
  const file = path.join(home, 'config.json');
  const saved = readFileSync(file);
  writeFileSync(file, '{}');
  assert.throws(() => new CrashlyticsBot(home));
  writeFileSync(file, saved);
  const exec = DatabaseSync.prototype.exec;
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS meta'))
        throw new Error('fixture schema failure');
      return exec.call(this, sql);
    },
  );
  assert.throws(() => new CrashlyticsBot(home), /fixture schema failure/);
  failure.mock.restore();
  // The empty state file left by an interrupted first initialization is recoverable.
  const bot = new CrashlyticsBot(home);
  try {
    const release = bot.lock('setup');
    try {
      bot.assertCurrentConfig();
    } finally {
      release();
    }
  } finally {
    bot.close();
  }
});

test('initialized profile construction does not acquire setup owned by a managed-start parent', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-config-parent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config, projectId: context.projectId });
  const parent = new CrashlyticsBot(home);
  const release = parent.lock('setup');
  try {
    const child = new CrashlyticsBot(home);
    try {
      assert.equal(child.status().monitorRunning, false);
      child.desired(false);
    } finally {
      child.close();
    }
  } finally {
    release();
    parent.close();
  }
});
