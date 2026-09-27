import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-package-'));
try {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  for (const file of pack.files) {
    assert.match(
      file.path,
      /^(?:LICENSE|NOTICE|bin\/[^/]+\.mjs|src\/.+\.ts|(?:README|BOT-TOOLS|SECURITY|REVIEW|ALERTS)\.md|(?:package|hivemind-bot|settings.schema)\.json)$/,
    );
    assert.ok(!/\.db|\.env|\.log|node_modules|hivemind-project|config\.json/.test(file.path));
  }
  const packagedPaths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'LICENSE',
    'NOTICE',
    'README.md',
    'ALERTS.md',
    'BOT-TOOLS.md',
    'SECURITY.md',
    'REVIEW.md',
  ]) {
    assert.ok(packagedPaths.has(required), `Missing packaged documentation: ${required}`);
  }
  assert.ok(!packagedPaths.has('src/native-alerts.ts'));
  assert.ok(packagedPaths.has('src/top-issues.ts'));
  assert.ok(packagedPaths.has('src/query-errors.ts'));
  assert.ok(packagedPaths.has('src/readers/parent-lifeline.ts'));
  assert.ok(!packagedPaths.has('package-lock.json'));
  const install = path.join(scratch, 'install');
  mkdirSync(install);
  // Test the packed source, not a copy of the checkout or an unlocked consumer
  // install. Registry metadata in npm's cache must not select newer versions.
  execFileSync('tar', [
    '-xzf',
    path.join(scratch, pack.filename),
    '-C',
    install,
    '--strip-components=1',
  ]);
  const lockBytes = readFileSync(path.join(root, 'package-lock.json'));
  copyFileSync(path.join(root, 'package-lock.json'), path.join(install, 'package-lock.json'));
  // Use only the exact tarballs cached by npm ci. No publish, login or provider call.
  execFileSync(
    'npm',
    ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: install, stdio: 'pipe' },
  );
  assert.deepEqual(readFileSync(path.join(install, 'package-lock.json')), lockBytes);
  const locked = JSON.parse(lockBytes).packages;
  const installed = JSON.parse(
    readFileSync(path.join(install, 'node_modules', '.package-lock.json'), 'utf8'),
  ).packages;
  assert.ok(Object.keys(installed).length > 0);
  for (const [location, entry] of Object.entries(installed)) {
    assert.ok(locked[location], `Unexpected dependency: ${location}`);
    assert.notEqual(entry.dev, true, `Development dependency installed: ${location}`);
    for (const key of ['version', 'resolved', 'integrity'])
      assert.equal(entry[key], locked[location][key], `Unlocked ${key}: ${location}`);
  }
  const cli = path.join(install, 'bin', 'hivemind-crashlytics.mjs');
  const profile = path.join(scratch, 'profile');
  const run = (args, input) =>
    execFileSync(process.execPath, [cli, '--home', profile, ...args], {
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
  assert.match(run(['help']), /Crashlytics|crashlytics/);
  assert.doesNotMatch(run(['help']), /import-alert/);
  assert.match(run(['instructions']), /Native Hivemind tools/);
  assert.match(run(['instructions']), /top_issues/);
  const manifest = JSON.parse(readFileSync(path.join(install, 'hivemind-bot.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(path.join(install, 'package.json'), 'utf8'));
  assert.equal(metadata.license, 'Apache-2.0');
  assert.match(
    readFileSync(path.join(install, 'LICENSE'), 'utf8'),
    /Apache License[\s\S]+Version 2\.0/,
  );
  assert.match(readFileSync(path.join(install, 'NOTICE'), 'utf8'), /Copyright 2026 Mario Rossano/);
  assert.equal(manifest.tools.find((tool) => tool.name === 'top_issues').effect, 'read');
  // Exercise the packed configuration validator, without a Firebase read.
  assert.throws(
    () =>
      run(
        ['configure'],
        JSON.stringify({
          config: { hiveUrl: 'http://127.0.0.1:1', states: ['OPEN', 'CLOSED'] },
          projectId: 'fixture',
        }),
      ),
    (error) => error.status === 1 && JSON.parse(error.stdout).configured === false,
  );
  const configured = JSON.parse(
    run(
      ['configure'],
      JSON.stringify({ config: { hiveUrl: 'http://127.0.0.1:1' }, projectId: 'fixture' }),
    ),
  );
  assert.equal(configured.configured, true);
  const context = {
    projectId: 'fixture',
    botId: 'fixture-bot',
    botName: 'Crashlytics',
    arguments: {},
  };
  const connected = JSON.parse(
    run(
      ['invoke'],
      JSON.stringify({ ...context, tool: 'connect', token: 'synthetic-package-token' }),
    ),
  );
  assert.equal(connected.connected, true);
  const status = JSON.parse(run(['invoke'], JSON.stringify({ ...context, tool: 'status' })));
  assert.equal(status.monitorRunning, false);
  assert.equal(status.sections.subscriptions, 0);
  assert.ok(!JSON.stringify(status).includes('synthetic-package-token'));
  assert.deepEqual(JSON.parse(run(['poll'])), []);
  console.log(
    `Package smoke PASS: ${pack.files.length} allowlisted files; tarball source with locked offline production dependencies; CLI, settings, identity, status and empty poll.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
