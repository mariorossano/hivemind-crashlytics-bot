import { z } from 'zod/v3';
import { fileURLToPath } from 'node:url';
import { configSchema, parseSource, type Config, type Source } from './provider.ts';
import { readCrashlytics, type Get } from './readers/crashlytics.ts';
import type { Runner } from './readers/process.ts';
import { QueryError, queryErrorFromReceipt } from './query-errors.ts';

const argumentsSchema = z
  .object({
    url: z.string().url().max(2048),
    lookbackDays: z.number().int().min(1).max(89).optional(),
    limit: z.number().int().min(1).max(10).default(1),
  })
  .strict();
const count = z.number().int().nonnegative().safe();
const issueValue = z.object({
  title: z.string(),
  subtitle: z.string(),
  errorType: z.enum(['FATAL', 'NON_FATAL', 'ANR']),
  state: z.enum(['OPEN', 'CLOSED', 'MUTED', 'STATE_UNSPECIFIED']).nullable(),
  events: count,
  users: count.nullable(),
});
const resultSchema = z
  .object({
    source: z.literal('Firebase Crashlytics topIssues report'),
    url: z.string().url(),
    interval: z.object({ start: z.string().datetime(), end: z.string().datetime() }).strict(),
    fetchedAt: z.string().datetime(),
    filters: z
      .object({
        lookbackDays: z.number().int().min(1).max(89),
        states: configSchema.shape.states,
        errorTypes: configSchema.shape.errorTypes,
        versions: configSchema.shape.versions,
        minEvents: configSchema.shape.minEvents,
        minUsers: configSchema.shape.minUsers,
      })
      .strict(),
    totalMatchingIssues: count,
    limited: z.boolean(),
    moreWithSameCount: count,
    issues: z
      .array(
        issueValue
          .extend({
            id: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .max(494),
            url: z.string().url().max(4096),
            textTruncated: z.boolean(),
          })
          .strict(),
      )
      .max(10),
    warnings: z.array(z.string().max(1000)).max(10),
  })
  .strict();

/** Metadata only: no enrichment, cache writes, outbox application or channel operations. */
export async function readTopIssues(
  source: Source,
  appId: string,
  get: Get,
  limit: number,
  now = Date.now(),
) {
  z.number().int().min(1).max(10).parse(limit);
  const snapshot = await readCrashlytics(
    { ...source, config: { ...source.config, notifyCounts: true, autoStacks: false } },
    appId,
    get,
    now,
  );
  const sorted = snapshot.observations
    .map((observation) => {
      const value = issueValue.parse(observation.value);
      return {
        ...value,
        id: observation.key.slice('issue:'.length),
        url: observation.url,
        title: value.title.slice(0, 160),
        subtitle: value.subtitle.slice(0, 160),
        textTruncated: value.title.length > 160 || value.subtitle.length > 160,
      };
    })
    .sort((a, b) => b.events - a.events || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const issues = sorted.slice(0, limit);
  const result = resultSchema.parse({
    source: 'Firebase Crashlytics topIssues report',
    url: source.url,
    interval: {
      start: new Date(now - source.config.lookbackDays * 86400000).toISOString(),
      end: new Date(now).toISOString(),
    },
    fetchedAt: new Date().toISOString(),
    filters: {
      lookbackDays: source.config.lookbackDays,
      states: source.config.states,
      errorTypes: source.config.errorTypes,
      versions: source.config.versions,
      minEvents: source.config.minEvents,
      minUsers: source.config.minUsers,
    },
    totalMatchingIssues: sorted.length,
    limited: sorted.length > issues.length,
    moreWithSameCount: issues.length
      ? sorted.slice(limit).filter((issue) => issue.events === issues.at(-1)!.events).length
      : 0,
    issues,
    warnings: snapshot.warnings ?? [],
  });
  // Leave space for the core's response envelope. Never silently shorten a ranking.
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024)
    throw new QueryError('RESULT_TOO_LARGE');
  return result;
}

export async function topIssues(config: Config, home: string, runner: Runner, raw: unknown) {
  const parsed = argumentsSchema.safeParse(raw);
  if (!parsed.success) throw new QueryError('INVALID_ARGUMENTS');
  const args = parsed.data;
  // Validate all supplied filters before applying the explicit time override.
  let source: Source;
  try {
    const original = parseSource(args.url, config);
    const url = new URL(original.url);
    if (args.lookbackDays !== undefined) url.searchParams.set('time', `${args.lookbackDays}d`);
    source = parseSource(url.href, config);
  } catch {
    throw new QueryError('INVALID_SOURCE');
  }
  const queryConfig = {
    ...source.config,
    autoStacks: false,
    notifyCounts: true,
    // The core may end a queued call sooner; IPC also terminates the reader if
    // its caller dies before this local deadline can run.
    timeoutSeconds: Math.min(config.timeoutSeconds, 20),
  };
  const result = await runner({
    executable: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./readers/firebase-entry.ts', import.meta.url)),
    ],
    cwd: home,
    stdin: JSON.stringify({
      action: 'top_issues',
      url: source.url,
      config: queryConfig,
      limit: args.limit,
    }),
    timeoutMs: queryConfig.timeoutSeconds * 1000,
    maxOutputBytes: 64 * 1024,
    parentLifeline: true,
  });
  const response = JSON.parse(result.stdout.trim());
  if (response?.ok === false) throw queryErrorFromReceipt(response);
  return resultSchema.parse(response);
}
