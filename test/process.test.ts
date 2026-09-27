import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderTimeoutError, runCommand } from '../src/readers/process.ts';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { configSchema, read } from '../src/provider.ts';

const command = (script: string) => ({
  executable: process.execPath,
  args: ['-e', script],
  cwd: os.tmpdir(),
  timeoutMs: 3000,
});

test('reader preserves stdin/stdout bytes without shell interpretation', async () => {
  const text = 'diagnostic: é 😀 $(not-a-command)';
  const result = await runCommand({
    ...command('process.stdin.pipe(process.stdout)'),
    stdin: text,
  });
  assert.equal(result.stdout, text);
});

test('reader spawn and exit errors never echo private stderr', async () => {
  await assert.rejects(
    runCommand({ ...command(''), executable: '/nonexistent-crashlytics-reader' }),
    /Cannot start/,
  );
  await assert.rejects(
    runCommand(command('process.stderr.write("PRIVATE-STDERR");process.exit(7)')),
    /^Error: Reader command exited 7; check provider login\/configuration$/,
  );
});

for (const mode of ['exit-error', 'exit-signal', 'exit-success', 'deadline', 'cancel'])
  test(
    `open descendant pipes preserve the reader outcome after ${mode}`,
    { skip: process.platform === 'win32', timeout: 10000 },
    async (t) => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-reader-exit-'));
      const readerFile = path.join(home, 'reader.pid'),
        helperFile = path.join(home, 'helper.json');
      const url =
        'https://console.firebase.google.com/project/fixture/crashlytics/app/ios:com.example.app/issues';
      const metadata = {
        observations: [
          {
            key: 'issue:first',
            value: { state: 'OPEN' },
            body: 'Synthetic crash',
            url: url + '/first',
          },
        ],
      };
      const checkpoint = JSON.stringify({ type: 'metadata', snapshot: metadata }) + '\n';
      const helperCode = `
        process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, parent: process.ppid }));
        process.send('ready');
        setInterval(() => {}, 1000);
      `;
      const readerCode = `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(readerFile)}, String(process.pid));
        ${mode === 'deadline' ? "process.on('SIGTERM', () => process.exit(7));" : ''}
        const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}, ${JSON.stringify(helperFile)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        helper.once('message', () => {
          process.stdout.write(${JSON.stringify(checkpoint)}, () => {
            ${mode === 'exit-error' ? 'process.exit(7);' : ''}
            ${mode === 'exit-signal' ? "process.kill(process.pid, 'SIGKILL');" : ''}
            ${mode === 'exit-success' ? 'process.exit(0);' : ''}
          });
        });
        setInterval(() => {}, 1000);
      `;
      const canary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      const canaryExit = once(canary, 'exit');
      const controller = new AbortController();
      let readerError: unknown;
      const result = read(
        url,
        configSchema.parse({ hiveUrl: 'http://127.0.0.1:1' }),
        home,
        async (request) => {
          try {
            return await runCommand({
              ...request,
              ...command(readerCode),
              cwd: home,
              timeoutMs: 1500,
            });
          } catch (error) {
            readerError = error;
            throw error;
          }
        },
        controller.signal,
      ).then(
        (snapshot) => ({ snapshot, error: undefined }),
        (error: unknown) => ({ snapshot: undefined, error }),
      );
      let helper: { pid: number; parent: number } | undefined;
      t.after(async () => {
        controller.abort();
        await result;
        try {
          if (!helper && existsSync(helperFile) && existsSync(readerFile)) {
            const late = JSON.parse(readFileSync(helperFile, 'utf8'));
            if (late.parent === Number(readFileSync(readerFile, 'utf8'))) helper = late;
          }
          if (helper && alive(helper.pid)) process.kill(helper.pid, 'SIGKILL');
          if (helper) {
            for (let i = 0; i < 100 && alive(helper.pid); i++) await delay(10);
            assert.equal(alive(helper.pid), false, 'Owned test helper must be reaped');
          }
        } finally {
          canary.kill('SIGKILL');
          await canaryExit;
          rmSync(home, { recursive: true, force: true });
        }
      });
      for (let i = 0; i < 100 && !existsSync(helperFile); i++) await delay(10);
      assert.ok(existsSync(helperFile), 'Synthetic helper must start before the deadline');
      helper = JSON.parse(readFileSync(helperFile, 'utf8'));
      assert.equal(helper!.parent, Number(readFileSync(readerFile, 'utf8')));
      if (mode === 'cancel') controller.abort();
      const outcome = await result;
      if (mode === 'deadline') {
        // A nonzero exit caused by our timeout must not replace that timeout.
        assert.ok(readerError instanceof ReaderTimeoutError);
        assert.deepEqual(outcome.snapshot?.observations, metadata.observations);
        assert.match(outcome.snapshot!.warnings!.join(), /stack.*incomplete/i);
      } else {
        assert.ok(readerError instanceof Error);
        assert.equal(readerError instanceof ReaderTimeoutError, false);
        assert.match(
          readerError.message,
          mode === 'exit-error'
            ? /exited 7/
            : mode === 'exit-signal'
              ? /exited null/
              : mode === 'exit-success'
                ? /output did not close after exit/
                : /cancelled/,
        );
        assert.ok(outcome.error instanceof Error);
        assert.equal(outcome.snapshot, undefined, 'Never recover a failed or completed reader');
      }
      assert.equal(alive(helper!.parent), false);
      for (let i = 0; i < 50 && alive(helper!.pid); i++) await delay(10);
      assert.equal(alive(helper!.pid), false, 'The inherited-pipe helper must be terminated');
      assert.ok(canary.pid && alive(canary.pid), 'Never signal an unrelated process group');
    },
  );

test('reader deadlines and cancellation terminate owned children', async () => {
  await assert.rejects(
    runCommand({ ...command('setInterval(()=>{},1000)'), timeoutMs: 50 }),
    /timed out/,
  );
  const controller = new AbortController();
  const running = runCommand({ ...command('setInterval(()=>{},1000)'), signal: controller.signal });
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assert.rejects(
    runCommand({ ...command('process.exit(8)'), signal: controller.signal }),
    /cancelled/,
  );
});

test('reader stdout and stderr share an enforced output budget', async () => {
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(
      runCommand(
        command(`process.${stream}.write(Buffer.alloc(17*1024*1024));setInterval(()=>{},1000)`),
      ),
      /exceeded 16 MB/,
    );
  }
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

for (const mode of [
  'timeout',
  'cancel',
  'stdout-overflow',
  'stderr-overflow',
  'stubborn-leader',
  'failed-leader',
])
  test(
    `reader group cleanup reaps a stubborn descendant after ${mode}`,
    { skip: process.platform === 'win32', timeout: 10000 },
    async (t) => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-reader-group-'));
      const readerFile = path.join(home, 'reader.pid'),
        helperFile = path.join(home, 'helper.json');
      const helperCode = `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, parent: process.ppid }));
      setInterval(() => {}, 1000);
    `;
      const readerCode = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(readerFile)}, String(process.pid));
      ${mode === 'stubborn-leader' ? "process.on('SIGTERM', () => {});" : ''}
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}, ${JSON.stringify(helperFile)}], { stdio: 'ignore' });
      process.stdout.write('synthetic-checkpoint\\n');
      setInterval(() => {
        ${mode.endsWith('overflow') ? `if (fs.existsSync(${JSON.stringify(helperFile)})) process.${mode.startsWith('stdout') ? 'stdout' : 'stderr'}.write(Buffer.alloc(4096));` : ''}
        ${mode === 'failed-leader' ? `if (fs.existsSync(${JSON.stringify(helperFile)})) process.exit(7);` : ''}
      }, 10);
    `;
      // An unrelated process is deliberately in another group and must survive.
      const canary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      const canaryExit = once(canary, 'exit');
      const controller = new AbortController();
      const result = runCommand({
        ...command(readerCode),
        cwd: home,
        timeoutMs: 1500,
        maxOutputBytes: 128,
        signal: controller.signal,
      }).then(
        () => undefined,
        (error) => error,
      );
      let helper: { pid: number; parent: number } | undefined;
      t.after(async () => {
        controller.abort();
        await result;
        try {
          if (!helper && existsSync(helperFile) && existsSync(readerFile)) {
            const late = JSON.parse(readFileSync(helperFile, 'utf8'));
            if (late.parent === Number(readFileSync(readerFile, 'utf8'))) helper = late;
          }
          if (helper && alive(helper.pid)) process.kill(helper.pid, 'SIGKILL');
          if (helper) {
            for (let i = 0; i < 100 && alive(helper.pid); i++) await delay(10);
            assert.equal(
              alive(helper.pid),
              false,
              'Owned test helper must be reaped before removing its profile',
            );
          }
        } finally {
          canary.kill('SIGKILL');
          await canaryExit;
          rmSync(home, { recursive: true, force: true });
        }
      });
      for (let i = 0; i < 100 && !existsSync(helperFile); i++) await delay(10);
      assert.ok(existsSync(helperFile), 'Synthetic helper must start before the deadline');
      helper = JSON.parse(readFileSync(helperFile, 'utf8'));
      assert.equal(helper!.parent, Number(readFileSync(readerFile, 'utf8')));
      if (mode === 'cancel') controller.abort();
      const error = await result;
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        mode === 'cancel'
          ? /cancelled/
          : mode.endsWith('overflow')
            ? /exceeded/
            : mode === 'failed-leader'
              ? /exited 7/
              : /timed out/,
      );
      if (mode === 'timeout' || mode === 'stubborn-leader') {
        assert.ok(error instanceof ReaderTimeoutError);
        assert.equal(error.stdout, 'synthetic-checkpoint\n');
      }
      assert.equal(alive(helper!.parent), false);
      // Allow the OS to reap the killed orphan, not another whole grace period.
      for (let i = 0; i < 50 && alive(helper!.pid); i++) await delay(10);
      assert.equal(alive(helper!.pid), false, 'A closed reader must not leave its helper running');
      assert.ok(canary.pid && alive(canary.pid), 'Never signal an unrelated process group');
    },
  );
