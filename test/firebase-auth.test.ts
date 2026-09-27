import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { authenticatedGet } from '../src/readers/firebase-auth.ts';

const require = createRequire(import.meta.url);
const auth = require('firebase-tools/lib/auth.js');
const authentication = require('firebase-tools/lib/requireAuth.js');
const api = require('firebase-tools/lib/apiv2.js');

function fixture(t: TestContext) {
  const originalToken = process.env.FIREBASE_TOKEN;
  delete process.env.FIREBASE_TOKEN;
  t.after(() => {
    if (originalToken === undefined) delete process.env.FIREBASE_TOKEN;
    else process.env.FIREBASE_TOKEN = originalToken;
  });
  const calls: unknown[][] = [];
  t.mock.method(auth, 'selectAccount', (account?: string) => ({
    user: { email: account ?? 'fixture@example.com' },
    tokens: {},
  }));
  t.mock.method(auth, 'setActiveAccount', (options: any, account: any) =>
    Object.assign(options, account),
  );
  t.mock.method(authentication, 'requireAuth', async (options: any, skipAutoAuth: boolean) => {
    calls.push([options, skipAutoAuth]);
    return options.user.email;
  });
  const token = t.mock.method(api, 'getAccessToken', async () => 'synthetic-provider-token');
  // Never allow this suite to fall through to real Firebase/Google networking.
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ groups: [] }));
  return { calls, token, fetchMock };
}

test('pinned CLI auth contract is present and explicit accounts cannot fall back to ADC', async (t) => {
  const f = fixture(t);
  const get = await authenticatedGet('fixture@example.com');
  assert.equal(f.calls[0]![1], true);
  const result = await get(
    new URL(
      'https://firebasecrashlytics.googleapis.com/v1alpha/projects/demo/apps/app/reports/topIssues',
    ),
  );
  assert.deepEqual(result, { groups: [] });
  assert.equal(f.token.mock.callCount(), 1);
  const [, options] = f.fetchMock.mock.calls[0]!.arguments as unknown as [URL, RequestInit];
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(
    new Headers(options.headers).get('authorization'),
    'Bearer synthetic-provider-token',
  );
  t.mock.method(authentication, 'requireAuth', async () => null);
  await assert.rejects(authenticatedGet('fixture@example.com'), /authentication unavailable/);
});

test('conflicting environment credentials and missing selected accounts fail before any GET', async (t) => {
  const f = fixture(t);
  process.env.FIREBASE_TOKEN = 'synthetic-conflicting-token';
  await assert.rejects(authenticatedGet('fixture@example.com'), /authentication unavailable/);
  assert.equal(f.calls.length, 0);
  delete process.env.FIREBASE_TOKEN;
  t.mock.method(auth, 'selectAccount', () => {
    throw new Error('SECRET-ACCOUNT');
  });
  await assert.rejects(
    authenticatedGet('missing@example.com'),
    /^Error: Firebase authentication unavailable/,
  );
  assert.equal(f.token.mock.callCount(), 0);
  assert.equal(f.fetchMock.mock.callCount(), 0);
});

test('provider endpoint allowlist is checked before asking for a token', async (t) => {
  const f = fixture(t);
  const get = await authenticatedGet();
  assert.equal(
    f.calls[0]![1],
    false,
    'default credentials are supported only without an explicit account',
  );
  for (const url of [
    'http://firebase.googleapis.com/',
    'https://evil.invalid/',
    'https://firebase.googleapis.com.evil.invalid/',
    'https://user:secret@firebase.googleapis.com/',
    'https://firebase.googleapis.com:123/',
    'https://firebase.googleapis.com/#x',
  ]) {
    await assert.rejects(get(new URL(url)), /Unexpected Firebase endpoint/);
  }
  assert.equal(f.token.mock.callCount(), 0);
  assert.equal(f.fetchMock.mock.callCount(), 0);
});

test('provider HTTP, token, network and JSON errors do not expose response bodies or credentials', async (t) => {
  const f = fixture(t);
  const get = await authenticatedGet();
  const url = new URL('https://firebase.googleapis.com/v1beta1/projects/demo/iosApps');
  for (const response of [
    new Response('SECRET-RESPONSE', { status: 403 }),
    new Response('SECRET-RESPONSE'),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(get(url), (error) => !String(error).includes('SECRET'));
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('SECRET-NETWORK');
  });
  await assert.rejects(get(url), /^Error: Firebase GET failed or timed out/);
  t.mock.method(api, 'getAccessToken', async () => {
    throw new Error('SECRET-TOKEN');
  });
  await assert.rejects(get(url), /^Error: Firebase login expired or missing/);
  assert.ok(f.calls.length);
});

test('oversized Firebase bodies are rejected, not parsed or cached', async (t) => {
  fixture(t);
  const get = await authenticatedGet();
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)));
  await assert.rejects(get(new URL('https://firebase.googleapis.com/')), /exceeded 8 MB/);
});
