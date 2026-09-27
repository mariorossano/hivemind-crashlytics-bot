import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureProfile, assertProject, projectBinding } from '../src/profile.ts';
import { CrashlyticsBot, init } from '../src/runtime.ts';
import { definitionId, configSchema } from '../src/provider.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), definitionId + '-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = configSchema.parse({
    hiveUrl: 'http://127.0.0.1:23456',
    host: 'console.firebase.google.com',
  });
  return { home, config, request: { config, projectId: 'project-a' } };
}
test('configure only saves a private local profile; repeated saves retain it and never start work', (t) => {
  const f = setup(t);
  assert.equal(configureProfile(f.home, f.request).configured, true);
  assert.equal(existsSync(path.join(f.home, 'state.db')), false);
  assert.equal(statSync(path.join(f.home, 'config.json')).mode & 0o777, 0o600);
  assert.deepEqual(configureProfile(f.home, f.request), {
    configured: true,
    projectId: 'project-a',
    monitorRunning: false,
  });
  assert.equal(projectBinding(f.home)!.projectId, 'project-a');
  assert.doesNotThrow(() => assertProject(f.home, 'project-a', f.config.hiveUrl));
  assert.throws(() => assertProject(f.home, 'project-b', f.config.hiveUrl), /another/);
  assert.throws(
    () => configureProfile(f.home, { ...f.request, projectId: 'project-b' }),
    /another/,
  );
});
test('unsupported state pairs cannot create or overwrite a profile', (t) => {
  const f = setup(t);
  const invalid = { ...f.config, states: ['OPEN', 'CLOSED'] };
  assert.throws(() => configureProfile(f.home, { ...f.request, config: invalid }), /one state/);
  assert.equal(existsSync(path.join(f.home, 'config.json')), false);
  assert.equal(existsSync(path.join(f.home, 'hivemind-project.json')), false);
  assert.throws(() => init(f.home, invalid), /one state/);
  assert.equal(existsSync(path.join(f.home, 'config.json')), false);

  configureProfile(f.home, f.request);
  const before = readFileSync(path.join(f.home, 'config.json'), 'utf8');
  assert.throws(() => configureProfile(f.home, { ...f.request, config: invalid }), /one state/);
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), before);
  assert.equal(existsSync(path.join(f.home, 'state.db')), false);
});

test('configure CLI rejects unsupported states with a failed receipt before saving', (t) => {
  const f = setup(t);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/hivemind-crashlytics.mjs', import.meta.url)),
      'configure',
      '--home',
      f.home,
    ],
    {
      input: JSON.stringify({ ...f.request, config: { ...f.config, states: ['OPEN', 'CLOSED'] } }),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).configured, false);
  assert.match(JSON.parse(result.stdout).error, /Invalid bot settings/);
  assert.equal(existsSync(path.join(f.home, 'config.json')), false);
});

test('unchanged running profiles can be adopted; changed settings need a stopped monitor', (t) => {
  const f = setup(t);
  configureProfile(f.home, f.request);
  const bot = new CrashlyticsBot(f.home, async () => {
    throw new Error('NO REAL PROVIDER');
  });
  try {
    const release = bot.lock();
    try {
      assert.equal(configureProfile(f.home, f.request).monitorRunning, true);
      assert.throws(
        () =>
          configureProfile(f.home, {
            ...f.request,
            config: { ...f.config, intervalSeconds: 1200 },
          }),
        /Stop this profile monitor/,
      );
    } finally {
      release();
    }
    configureProfile(f.home, { ...f.request, config: { ...f.config, intervalSeconds: 1200 } });
    assert.equal(
      JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8')).intervalSeconds,
      1200,
    );
    assert.equal(bot.subscriptions().length, 0);
  } finally {
    bot.close();
  }
});
test('wrong project destination is rejected before bot creation or a source read', async (t) => {
  const f = setup(t);
  configureProfile(f.home, f.request);
  const bot = new CrashlyticsBot(f.home, async () => {
      throw new Error('NO REAL PROVIDER');
    }),
    calls: string[] = [];
  bot.request = async (route: string) => {
    calls.push(route);
    if (route !== '/api/ui/snapshot') throw new Error('Unexpected write');
    return {
      agents: [],
      channels: [
        { id: 'room', name: 'Room', type: 'private', projectId: 'project-b', memberIds: [] },
      ],
    };
  };
  const source =
    'https://console.firebase.google.com/project/demo-app/crashlytics/app/ios:com.example.app/issues';
  try {
    await assert.rejects(bot.follow(source, 'room'), /another/);
    assert.deepEqual(calls, ['/api/ui/snapshot']);
    assert.equal(bot.subscriptions().length, 0);
  } finally {
    bot.close();
  }
});
test('a retained profile from another project cannot be adopted or overwritten', (t) => {
  const f = setup(t);
  configureProfile(f.home, f.request);
  const bot = new CrashlyticsBot(f.home);
  try {
    bot.db
      .prepare('INSERT INTO bots VALUES (?,?,?,?)')
      .run('other', 'fixture-id', 'Fixture', 'invented-not-a-token');
  } finally {
    bot.close();
  }
  const before = readFileSync(path.join(f.home, 'config.json'), 'utf8');
  assert.throws(() => configureProfile(f.home, f.request), /different project/);
  assert.throws(() =>
    configureProfile(f.home, { ...f.request, config: { ...f.config, intervalSeconds: 1 } }),
  );
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), before);
});
test('real configure CLI accepts stdin and returns a receipt, without creating a bot or monitor', (t) => {
  const f = setup(t),
    root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'bin', definitionId + '.mjs'), 'configure', '--home', f.home],
    { input: JSON.stringify(f.request), encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configured, true);
  const invalid = spawnSync(
    process.execPath,
    [path.join(root, 'bin', definitionId + '.mjs'), 'configure', '--home', f.home],
    {
      input: JSON.stringify({ ...f.request, config: { ...f.config, intervalSeconds: 1 } }),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).configured, false);
  assert.match(JSON.parse(invalid.stdout).error, /Invalid bot settings/);
  assert.equal(existsSync(path.join(f.home, 'state.db')), false);
  const schema = JSON.parse(readFileSync(path.join(root, 'settings.schema.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'hivemind-bot.json'), 'utf8'));
  assert.equal(manifest.settings, 'settings.schema.json');
  assert.deepEqual(
    schema.fields.map((f: any) => f.key).sort(),
    Object.keys(configSchema.shape)
      .filter((k) => k !== 'hiveUrl')
      .sort(),
  );
});
