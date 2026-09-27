import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueryError, queryFailure, queryErrorFromReceipt } from '../src/query-errors.ts';
import { ReaderTimeoutError } from '../src/readers/process.ts';
import { configSchema } from '../src/provider.ts';
import { topIssues } from '../src/top-issues.ts';
import { invoke } from '../src/bot-interface.ts';
import { configureProfile } from '../src/profile.ts';
import { CrashlyticsBot } from '../src/runtime.ts';

test('query failures carry actionable allowlisted codes, never raw errors or timeout output', () => {
  const cases: Array<[unknown, string]> = [
    [new QueryError('INVALID_SOURCE'), 'INVALID_SOURCE'],
    [new ReaderTimeoutError('private-timeout-buffer'), 'TIMEOUT'],
    [
      new Error(
        'Firebase authentication unavailable. Use the bundled Firebase CLI login, or configure an existing account/ADC.',
      ),
      'AUTH_REQUIRED',
    ],
    [new Error('Firebase login expired or missing; authenticate again.'), 'AUTH_REQUIRED'],
    [
      new Error('Firebase GET HTTP 401; check account/project permissions and API availability.'),
      'AUTH_REQUIRED',
    ],
    [
      new Error('Firebase GET HTTP 403; check account/project permissions and API availability.'),
      'PERMISSION_DENIED',
    ],
    [
      new Error('Firebase GET HTTP 429; check account/project permissions and API availability.'),
      'RATE_LIMITED',
    ],
    [
      new Error('Firebase GET HTTP 503; check account/project permissions and API availability.'),
      'PROVIDER_UNAVAILABLE',
    ],
    [new Error('Firebase GET failed or timed out; snapshot not applied.'), 'PROVIDER_UNAVAILABLE'],
    [
      new Error('Expected exactly one Firebase app for the configured project and bundle/package'),
      'APP_NOT_FOUND',
    ],
    [new Error('Report page limit reached; no baseline or events advanced'), 'INCOMPLETE_REPORT'],
    [new Error('Incomplete report; no baseline or events advanced'), 'INCOMPLETE_REPORT'],
    [new Error('Report changed during pagination; retry a complete snapshot'), 'INCOMPLETE_REPORT'],
    [new SyntaxError('private-provider-json'), 'INVALID_RESPONSE'],
    [new Error('Firebase returned an unexpected issue link'), 'INVALID_RESPONSE'],
    [new Error('Reader output exceeded 0.0625 MB'), 'RESULT_TOO_LARGE'],
    [Object.assign(new Error('private-db-path'), { errcode: 5 }), 'PROFILE_BUSY'],
    [new Error('Profile settings changed; run the command again'), 'CONFIG_CHANGED'],
    [new Error('private-secret-token'), 'QUERY_FAILED'],
    [{ error: 'private-object' }, 'QUERY_FAILED'],
  ];
  for (const [error, code] of cases) {
    const result = queryFailure(error);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    assert.equal(Object.hasOwn(result, 'issues'), false);
  }
});

test('query rejects malformed error receipts and reconstructs messages instead of reflecting them', async () => {
  const args = {
    url: 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues',
  };
  const config = configSchema.parse({ hiveUrl: 'http://127.0.0.1:1' });
  const receipt = {
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'private-provider-secret' },
  };
  await assert.rejects(
    topIssues(config, '/synthetic', async () => ({ stdout: JSON.stringify(receipt) }), args),
    (e: QueryError) => {
      assert.equal(e.code, 'AUTH_REQUIRED');
      assert.doesNotMatch(e.message, /private-/);
      return true;
    },
  );
  for (const bad of [
    null,
    { ...receipt, secret: 'private-data' },
    { ok: false, error: { code: 'private-unknown', message: 'private-text' } },
  ]) {
    const result = queryFailure(queryErrorFromReceipt(bad));
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('native query failures are structured receipts, preserve monitor status and do not bypass identity checks', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-query-errors-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  configureProfile(home, { config: { hiveUrl: 'http://127.0.0.1:1' }, projectId: 'fixture' });
  const context = { projectId: 'fixture', botId: 'bot', botName: 'Crashlytics', arguments: {} };
  await invoke(home, { ...context, tool: 'connect', token: 'synthetic-token' });
  const before = await invoke(home, { ...context, tool: 'status' });
  const invalid = (await invoke(home, {
    ...context,
    tool: 'top_issues',
    arguments: { url: 'https://example.invalid' },
  })) as any;
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_SOURCE');
  for (const error of [
    new ReaderTimeoutError('private-output'),
    new QueryError('AUTH_REQUIRED'),
    new Error('private-unknown'),
  ]) {
    const query = t.mock.method(CrashlyticsBot.prototype, 'topIssues', async () => {
      throw error;
    });
    const result = await invoke(home, { ...context, tool: 'top_issues' });
    assert.deepEqual(result, queryFailure(error));
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    await assert.rejects(invoke(home, { ...context, botId: 'wrong', tool: 'top_issues' }));
    query.mock.restore();
  }
  assert.deepEqual(await invoke(home, { ...context, tool: 'status' }), before);
});
