import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { Runner } from './readers/process.ts';
import { ReaderTimeoutError } from './readers/process.ts';
import {
  metadataCheckpointSchema,
  sampleCheckpointSchema,
  variantCheckpointSchema,
  snapshotSchema,
  type Snapshot,
} from './readers/config.ts';
export const definitionId = 'hivemind-crashlytics';
export const label = 'Crashlytics';
export const usageNotice =
  'Read-only Firebase reports, no model calls. Any chosen Hivemind channel; never creates a channel.';
export const configSchema = z
  .object({
    hiveUrl: z.string().url(),
    host: z.literal('console.firebase.google.com').default('console.firebase.google.com'),
    account: z.string().email().optional(),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    timeoutSeconds: z.number().int().min(5).max(300).default(90),
    maxPages: z.number().int().min(1).max(100).default(20),
    pageSize: z.number().int().min(1).max(100).default(100),
    lookbackDays: z.number().int().min(1).max(89).default(7),
    states: z
      .array(z.enum(['OPEN', 'CLOSED', 'MUTED']))
      .max(3)
      .refine(
        (states) => new Set(states).size !== 2,
        'Choose one state or all states (empty or OPEN, CLOSED, MUTED)',
      )
      .default(['OPEN']),
    errorTypes: z
      .array(z.enum(['FATAL', 'NON_FATAL', 'ANR']))
      .min(1)
      .max(3)
      .default(['FATAL']),
    versions: z.array(z.string().min(1).max(200)).max(50).default([]),
    minEvents: z.number().int().min(1).default(1),
    minUsers: z.number().int().min(0).default(0),
    notifyCounts: z.boolean().default(false),
    autoStacks: z.boolean().default(true),
    maxSamplesPerPoll: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const profileIdentity = (config: Config) => [
  definitionId,
  config.hiveUrl,
  config.host,
  config.account,
  config.versions,
  config.minEvents,
  config.minUsers,
  config.notifyCounts,
];
const typeCodes = { crash: 'FATAL', nonfatal: 'NON_FATAL', anr: 'ANR' } as const;
export function parseSource(input: string, config: Config) {
  const u = new URL(input);
  if (u.protocol !== 'https:' || u.host !== config.host || u.username || u.password || u.hash)
    throw new Error('Use an exact Firebase Crashlytics app overview URL');
  const match =
    /^\/(?:u\/\d+\/)?project\/([a-z0-9][a-z0-9-]*)\/crashlytics\/app\/(ios|android):([^/]+)\/issues\/?$/.exec(
      u.pathname,
    );
  if (!match) throw new Error('Use the Crashlytics app issues overview, not an individual crash');
  const [, project, platform, encodedBundle] = match;
  const bundle = decodeURIComponent(encodedBundle!);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(bundle)) throw new Error('Invalid app bundle/package');
  for (const key of u.searchParams.keys())
    if (
      !['state', 'time', 'types', 'tag', 'sort'].includes(key) ||
      u.searchParams.getAll(key).length !== 1
    )
      throw new Error('Unsupported or repeated Firebase URL filter: ' + key);
  if (u.searchParams.has('tag') && u.searchParams.get('tag') !== 'all')
    throw new Error('Only tag=all is supported; no tag filter will be silently discarded');
  const days = u.searchParams.get('time');
  if (days !== null && !/^[1-9]\d?d$/.test(days))
    throw new Error('Use a relative whole-day window, for example time=7d');
  const state = u.searchParams.get('state');
  if (state !== null && !['open', 'closed', 'muted', 'all'].includes(state))
    throw new Error('Unsupported issue state');
  const types = u.searchParams.get('types')?.split(',');
  if (types?.some((t) => !Object.hasOwn(typeCodes, t))) throw new Error('Unsupported error type');
  const effective = configSchema.parse({
    ...config,
    lookbackDays: days ? Number(days.slice(0, -1)) : config.lookbackDays,
    states: state ? (state === 'all' ? [] : [state.toUpperCase()]) : config.states,
    errorTypes: types
      ? [...new Set(types.map((t) => typeCodes[t as keyof typeof typeCodes]))].sort()
      : [...config.errorTypes].sort(),
  });
  // Remove the browser account index; authentication uses the configured CLI account.
  const base = `https://${config.host}/project/${project}/crashlytics/app/${platform}:${encodeURIComponent(bundle)}`;
  const canonical = new URL(base + '/issues');
  const selectedStates = [...new Set(effective.states)].sort();
  if (selectedStates.length > 1 && selectedStates.length < 3)
    throw new Error('Choose one state or all states');
  canonical.searchParams.set(
    'state',
    selectedStates.length === 1 ? selectedStates[0]!.toLowerCase() : 'all',
  );
  canonical.searchParams.set('time', `${effective.lookbackDays}d`);
  canonical.searchParams.set(
    'types',
    effective.errorTypes
      .map((t) => Object.keys(typeCodes).find((k) => typeCodes[k as keyof typeof typeCodes] === t)!)
      .sort()
      .join(','),
  );
  return {
    project: project!,
    platform: platform as 'ios' | 'android',
    bundle,
    base,
    url: canonical.href,
    config: effective,
  };
}
export type Source = ReturnType<typeof parseSource>;
export async function read(
  input: string,
  config: Config,
  directory: string,
  runner: Runner,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const source = parseSource(input, config);
  const command = {
    executable: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./readers/firebase-entry.ts', import.meta.url)),
    ],
    cwd: directory,
    stdin: JSON.stringify({
      url: source.url,
      config,
      prefetchStacks: config.autoStacks,
      enrichmentDeadline: Date.now() + config.timeoutSeconds * 1000 - 1000,
    }),
    timeoutMs: config.timeoutSeconds * 1000,
    // Metadata, completed sample descriptors and final result share a 32 MiB cap.
    maxOutputBytes: (config.autoStacks ? 32 : 16) * 1024 * 1024,
    signal,
  };
  let stdout: string;
  try {
    stdout = (await runner(command)).stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (config.autoStacks && error instanceof ReaderTimeoutError) {
      // Only an actual owned-child deadline permits this fallback. Cancellation,
      // provider errors, process failure, invalid or partial checkpoints do not.
      if (
        error.stdout.endsWith('\n') &&
        Buffer.byteLength(error.stdout) <= command.maxOutputBytes
      ) {
        try {
          const snapshot = parseCheckpoints(error.stdout.trimEnd().split('\n'));
          return {
            ...snapshot,
            warnings: [
              ...(snapshot.warnings ?? []),
              'Automatic stack enrichment is incomplete: reader deadline reached. Complete issue metadata retained; remaining stacks will be attempted on later polls.',
            ],
          } as Snapshot;
        } catch {
          /* Preserve the original safe deadline error. */
        }
      }
    }
    throw error;
  }
  signal?.throwIfAborted();
  if (Buffer.byteLength(stdout) > command.maxOutputBytes)
    throw new Error('Reader output exceeded its limit; snapshot not applied');
  const records = stdout.trim().split('\n');
  if (records.length > 1 && !config.autoStacks)
    throw new Error('Reader returned unexpected records; snapshot not applied');
  if (records.length > 1) {
    try {
      parseCheckpoints(records.slice(0, -1));
    } catch {
      throw new Error('Reader returned unexpected records; snapshot not applied');
    }
  }
  const response = parseResponse(records.at(-1)!);
  if (response.error) throw new Error(String(response.error).slice(0, 300));
  return snapshotSchema.parse(response) as Snapshot;
}

/** Only completed samples from this exact metadata report can survive a timeout.
 * Errors, extra finals, duplicate/unknown identities and partial frames fail closed. */
function parseCheckpoints(records: string[]): Snapshot {
  const snapshot: Snapshot = metadataCheckpointSchema.parse(parseResponse(records[0]!)).snapshot;
  const observations = new Map(
    snapshot.observations.map((observation) => [observation.key, observation]),
  );
  if (observations.size !== snapshot.observations.length)
    throw new Error('Reader returned duplicate checkpoint identities');
  const seen = new Map<string, Set<string>>();
  for (const record of records.slice(1)) {
    const raw = parseResponse(record);
    if (raw.type === 'variants') {
      const update = variantCheckpointSchema.parse(raw);
      const observation = observations.get(update.key);
      if (!observation || observation.variants !== undefined || observation.samples !== undefined)
        throw new Error('Reader returned an unexpected variant inventory');
      observation.variants = update.variants;
      continue;
    }
    const update = sampleCheckpointSchema.parse(raw);
    const observation = observations.get(update.key);
    if (!observation) throw new Error('Reader returned an unknown checkpoint identity');
    if (observation.variants && !observation.variants.includes(update.sample.variant))
      throw new Error('Reader returned a sample outside its variant inventory');
    const variants = seen.get(update.key) ?? new Set<string>();
    if (variants.has(update.sample.variant) || variants.size >= 10000)
      throw new Error('Reader returned duplicate or excessive checkpoint samples');
    variants.add(update.sample.variant);
    seen.set(update.key, variants);
    (observation.samples ??= []).push(update.sample);
  }
  return snapshot;
}
export async function inspect(
  input: string,
  config: Config,
  directory: string,
  runner: Runner,
  options: { variant?: string; samples?: number; refresh?: boolean; days?: number },
) {
  const { parseIssue } = await import('./readers/stacks.ts');
  const parsed = parseIssue(input, config);
  const selected =
    options.days === undefined
      ? parsed.source.config
      : configSchema.parse({ ...parsed.source.config, lookbackDays: options.days });
  const u = new URL(parsed.source.base + '/issues/' + parsed.issue);
  u.searchParams.set('time', selected.lookbackDays + 'd');
  const result = await runner({
    executable: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./readers/firebase-entry.ts', import.meta.url)),
    ],
    cwd: directory,
    stdin: JSON.stringify({ url: u.href, config: selected, action: 'inspect', options }),
    timeoutMs: config.timeoutSeconds * 1000,
  });
  const response = parseResponse(result.stdout);
  if (response.error) throw new Error(String(response.error).slice(0, 300));
  return response;
}

function parseResponse(text: string) {
  try {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Reader returned invalid JSON; snapshot not applied');
  }
}
