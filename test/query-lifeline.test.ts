import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/readers/process.ts';

const loader = import.meta.resolve('tsx');
const root = fileURLToPath(new URL('../', import.meta.url));
const lifeline = new URL('../src/readers/parent-lifeline.ts', import.meta.url).href;
const processes = new URL('../src/readers/process.ts', import.meta.url).href;
const query = new URL('../src/top-issues.ts', import.meta.url).href;
const provider = new URL('../src/provider.ts', import.meta.url).href;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), message);
}

for (const mode of ['active', 'loading']) {
  test(
    `query reader and its helper stop on caller death (${mode}), before the local read timeout`,
    { skip: process.platform === 'win32', timeout: 15000 },
    async (t) => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-query-lifeline-'));
      const marker = path.join(home, 'ready.json');
      const work = path.join(home, 'work-started');
      let reader: { pid: number; helper?: number } | undefined;
      const readerCode = `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      import { setTimeout as delay } from 'node:timers/promises';
      import { installParentLifeline } from ${JSON.stringify(lifeline)};
      if (${JSON.stringify(mode)} === 'loading') {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));
        await delay(800);
      }
      installParentLifeline();
      fs.writeFileSync(${JSON.stringify(work)}, 'started');
      const helper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},12000)'], { stdio: 'ignore' });
      if (${JSON.stringify(mode)} === 'active')
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, helper:helper.pid}));
      setTimeout(()=>{},12000);
    `;
      const parentCode = `
      import { topIssues } from ${JSON.stringify(query)};
      import { configSchema } from ${JSON.stringify(provider)};
      import { runCommand } from ${JSON.stringify(processes)};
      const config = configSchema.parse({hiveUrl:'http://127.0.0.1:1'});
      await topIssues(config, ${JSON.stringify(home)}, (command) => runCommand({
        ...command, args:['--import',${JSON.stringify(loader)},'--input-type=module','-e',${JSON.stringify(readerCode)}],
      }), {url:'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues'});
    `;
      const parent = spawn(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', parentCode],
        { cwd: root, detached: true, stdio: 'ignore' },
      );
      const parentExit = once(parent, 'exit');
      t.after(async () => {
        try {
          process.kill(-parent.pid!, 'SIGKILL');
        } catch {
          /* owned fixture already gone */
        }
        if (!reader && existsSync(marker)) {
          try {
            reader = JSON.parse(readFileSync(marker, 'utf8'));
          } catch {}
        }
        if (reader) {
          try {
            process.kill(-reader.pid, 'SIGKILL');
          } catch {}
        }
        await parentExit;
        rmSync(home, { recursive: true, force: true });
      });
      await until(() => {
        try {
          reader = JSON.parse(readFileSync(marker, 'utf8'));
          return Number.isSafeInteger(reader?.pid);
        } catch {
          return false;
        }
      }, 'reader must be ready before simulating an exhausted core deadline');
      const started = Date.now();
      process.kill(-parent.pid!, 'SIGKILL');
      await parentExit;
      await until(
        () => !alive(reader!.pid) && (!reader!.helper || !alive(reader!.helper)),
        'reader group must not survive its caller',
      );
      assert.ok(Date.now() - started < 5000, 'must not wait for the 20-second reader timer');
      if (mode === 'loading')
        assert.equal(
          existsSync(work),
          false,
          'a late-loading reader must not start provider work after parent death',
        );
    },
  );
}

test('real Firebase entry releases its lifeline after a completed request without contacting a provider', async () => {
  const result = await runCommand({
    executable: process.execPath,
    args: [
      '--import',
      loader,
      fileURLToPath(new URL('../src/readers/firebase-entry.ts', import.meta.url)),
    ],
    cwd: root,
    stdin: '{}', // rejected by the entry schema before authentication or GET
    timeoutMs: 5000,
    parentLifeline: true,
  });
  assert.match(JSON.parse(result.stdout).error, /expected schema/);
});
