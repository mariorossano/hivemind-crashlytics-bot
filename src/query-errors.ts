import { z } from 'zod/v3';
import { ReaderTimeoutError } from './readers/process.ts';

// Only these authored messages may cross the native bot boundary. Never return
// provider bodies, stderr, paths, credentials or arbitrary exception messages.
const messages = {
  INVALID_ARGUMENTS:
    'Provide an app overview URL, a limit from 1 to 10 and, optionally, lookbackDays from 1 to 89.',
  INVALID_SOURCE:
    'Use a Firebase Crashlytics app issues overview URL. Supported filters: time=1d..89d, state=open/closed/muted/all, types=crash/nonfatal/anr, tag=all and sort. No repeated or additional filters.',
  AUTH_REQUIRED:
    'Firebase authentication is unavailable or expired. Authenticate with the bundled Firebase CLI using the configured account.',
  PERMISSION_DENIED:
    'Firebase denied this read. Check the configured account permissions for the requested project and app.',
  RATE_LIMITED: 'Firebase rate-limited this read. No ranking is available; try again later.',
  PROVIDER_UNAVAILABLE:
    'Firebase could not complete this read. Check connectivity and API availability; no ranking is available.',
  APP_NOT_FOUND:
    'Could not resolve exactly one Firebase app for this project and bundle/package. Check the overview URL and account access.',
  INCOMPLETE_REPORT:
    'Firebase did not return a complete, consistent report within the configured page limit. No partial ranking is available.',
  INVALID_RESPONSE: 'Firebase or the reader returned an invalid response. No ranking is available.',
  RESULT_TOO_LARGE:
    'The ranking exceeds the response limit. Request fewer results or narrower filters.',
  TIMEOUT:
    'The Firebase query exceeded its read deadline. No partial or cached ranking is available.',
  PROFILE_BUSY:
    'Another operation is updating this bot profile. Wait for it to finish, then query again; do not stop the monitor.',
  CONFIG_CHANGED:
    'The bot settings changed before the query started. Query again to use the current settings.',
  QUERY_FAILED:
    'The Firebase query could not complete. Check the bot configuration and local diagnostics; no ranking is available.',
} as const;
export type QueryErrorCode = keyof typeof messages;
export class QueryError extends Error {
  constructor(readonly code: QueryErrorCode) {
    super(messages[code]);
  }
}

function codeFor(error: unknown): QueryErrorCode {
  if (error instanceof QueryError) return error.code;
  if (error instanceof ReaderTimeoutError) return 'TIMEOUT';
  if (!(error instanceof Error)) return 'QUERY_FAILED';
  if (error.name === 'ZodError' || error instanceof SyntaxError) return 'INVALID_RESPONSE';
  if ('errcode' in error && error.errcode === 5) return 'PROFILE_BUSY';
  const message = error.message;
  if (message === 'Profile settings changed; run the command again') return 'CONFIG_CHANGED';
  if (
    message ===
      'Firebase authentication unavailable. Use the bundled Firebase CLI login, or configure an existing account/ADC.' ||
    message === 'Firebase login expired or missing; authenticate again.'
  )
    return 'AUTH_REQUIRED';
  const http =
    /^Firebase GET HTTP (\d{3}); check account\/project permissions and API availability\.$/.exec(
      message,
    );
  if (http)
    return http[1] === '401'
      ? 'AUTH_REQUIRED'
      : http[1] === '403'
        ? 'PERMISSION_DENIED'
        : http[1] === '429'
          ? 'RATE_LIMITED'
          : 'PROVIDER_UNAVAILABLE';
  if (message === 'Firebase GET failed or timed out; snapshot not applied.')
    return 'PROVIDER_UNAVAILABLE';
  if (message === 'Expected exactly one Firebase app for the configured project and bundle/package')
    return 'APP_NOT_FOUND';
  if (
    [
      'App page limit reached; no snapshot applied',
      'Report page limit reached; no baseline or events advanced',
      'Incomplete report; no baseline or events advanced',
      'Report changed during pagination; retry a complete snapshot',
      'Repeated issue during pagination; snapshot not applied',
      'Repeated report page token',
      'Repeated app page token',
    ].includes(message)
  )
    return 'INCOMPLETE_REPORT';
  if (message === 'Reader output exceeded 0.0625 MB') return 'RESULT_TOO_LARGE';
  if (
    [
      'Firebase returned invalid JSON',
      'Firebase response exceeded 8 MB',
      'Firebase returned a different report/app',
      'Firebase returned a different report interval',
      'Firebase returned a different error type',
      'Firebase returned an unexpected issue state',
      'Firebase returned a different issue resource',
      'Firebase returned an unexpected issue link',
      'Firebase returned an invalid app ID',
      'Invalid Firebase app ID/platform',
    ].includes(message)
  )
    return 'INVALID_RESPONSE';
  return 'QUERY_FAILED';
}

export function queryFailure(error: unknown) {
  const code = codeFor(error);
  return { ok: false as const, error: { code, message: messages[code] } };
}

const failureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(Object.keys(messages) as [QueryErrorCode, ...QueryErrorCode[]]),
        message: z.string().max(1000),
      })
      .strict(),
  })
  .strict();

/** Reconstruct locally authored text rather than reflecting a child receipt. */
export function queryErrorFromReceipt(raw: unknown) {
  const receipt = failureSchema.safeParse(raw);
  return new QueryError(receipt.success ? receipt.data.error.code : 'INVALID_RESPONSE');
}
