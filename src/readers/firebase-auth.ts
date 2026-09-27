import { createRequire } from 'node:module';
import type { Get } from './crashlytics.ts';
const require = createRequire(import.meta.url);
/** Firebase's pinned CLI owns credentials/refresh; never copy tokens into our profile or events. */
export async function authenticatedGet(account?: string): Promise<Get> {
  const { logger } = require('firebase-tools/lib/logger.js');
  logger.silent = true;
  const auth = require('firebase-tools/lib/auth.js');
  const { requireAuth } = require('firebase-tools/lib/requireAuth.js');
  const api = require('firebase-tools/lib/apiv2.js');
  const options: any = { nonInteractive: true };
  try {
    // The CLI gives FIREBASE_TOKEN precedence over a selected login. An
    // explicit account must never silently run as another identity or ADC.
    if (account && process.env.FIREBASE_TOKEN) throw new Error('Conflicting credentials');
    const selected = auth.selectAccount(account);
    if (selected) auth.setActiveAccount(options, selected);
    const authenticated = await requireAuth(options, Boolean(account));
    if (account && authenticated !== account) throw new Error('Selected account unavailable');
  } catch {
    throw new Error(
      'Firebase authentication unavailable. Use the bundled Firebase CLI login, or configure an existing account/ADC.',
    );
  }
  return async (url) => {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !['firebase.googleapis.com', 'firebasecrashlytics.googleapis.com'].includes(url.host)
    )
      throw new Error('Unexpected Firebase endpoint');
    let token: string;
    try {
      token = await api.getAccessToken();
    } catch {
      throw new Error('Firebase login expired or missing; authenticate again.');
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('Firebase GET failed or timed out; snapshot not applied.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Firebase GET HTTP ${response.status}; check account/project permissions and API availability.`,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Firebase response exceeded 8 MB');
        chunks.push(chunk);
      }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Firebase returned invalid JSON');
    }
  };
}
