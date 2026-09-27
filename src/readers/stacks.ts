import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Source, Config } from '../provider.ts';
import { parseSource } from '../provider.ts';
import {
  artifactSchema,
  digest,
  loadArtifact,
  privateWrite,
  saveArtifact,
  artifactPath,
} from '../artifacts.ts';
import type { Artifact, Snapshot, Sample } from './config.ts';
import type { Get } from './crashlytics.ts';

const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(200);
const timestamp = z.string().refine((v) => Number.isFinite(Date.parse(v)));
const count = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().safe().nonnegative());
const scalar = z.union([z.string(), z.number()]);
const frame = z.object({
  line: scalar.optional(),
  file: z.string().optional(),
  symbol: z.string().optional(),
  offset: scalar.optional(),
  address: scalar.optional(),
  library: z.string().optional(),
  owner: z.string().optional(),
  blamed: z.boolean().optional(),
});
const stack = z.object({
  type: z.string().optional(),
  exceptionMessage: z.string().optional(),
  nested: z.boolean().optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  blamed: z.boolean().optional(),
  frames: z.array(frame).default([]),
  crashed: z.boolean().optional(),
  name: z.string().optional(),
  queue: z.string().optional(),
  signal: z.string().optional(),
  signalCode: z.string().optional(),
  crashAddress: scalar.optional(),
  code: scalar.optional(),
  threadId: scalar.optional(),
  sysThreadId: scalar.optional(),
  threadState: z.string().optional(),
});
// Explicit allowlist, also applied locally if the server returns extra fields.
export const readMask =
  'name,eventId,eventTime,platform,bundleOrPackage,issue.id,issueVariant.id,version,blameFrame,exceptions,errors,threads';
const eventSchema = z.object({
  name: z.string(),
  eventId: z.string().optional(),
  eventTime: timestamp,
  platform: z.string().optional(),
  bundleOrPackage: z.string().optional(),
  issue: z.object({ id }),
  issueVariant: z.object({ id }),
  version: z
    .object({
      displayName: z.string().optional(),
      displayVersion: z.string().optional(),
      buildVersion: z.string().optional(),
    })
    .optional(),
  blameFrame: frame.optional(),
  exceptions: z.array(stack).default([]),
  errors: z.array(stack).default([]),
  threads: z.array(stack).default([]),
});
type Event = z.infer<typeof eventSchema>;
export function parseIssue(input: string, config: Config) {
  const u = new URL(input),
    match = /^(.*\/issues)\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
  if (!match) throw new Error('Use the exact Firebase console issue URL');
  const issue = id.parse(match[2]);
  u.pathname = match[1]!;
  // This CLI accepts the canonical bundle/package links emitted by this bot.
  const source = parseSource(u.href, config);
  return { source, issue };
}
function parent(source: Source, appId: string) {
  const m = /^1:([0-9]+):(ios|android):[A-Za-z0-9]+$/.exec(appId);
  if (!m || m[2] !== source.platform) throw new Error('Invalid Firebase app ID/platform');
  return `projects/${m[1]}/apps/${appId}`;
}
function filtered(source: Source, appId: string, issue: string, endpoint: string, now: number) {
  id.parse(issue);
  const u = new URL(
    `https://firebasecrashlytics.googleapis.com/v1alpha/${parent(source, appId)}/${endpoint}`,
  );
  u.searchParams.set('filter.issue.id', issue);
  u.searchParams.set(
    'filter.interval.startTime',
    new Date(now - source.config.lookbackDays * 86400000).toISOString(),
  );
  u.searchParams.set('filter.interval.endTime', new Date(now).toISOString());
  for (const v of [...new Set(source.config.versions)].sort())
    u.searchParams.append('filter.version.displayNames', v);
  // An exact issue is already selected; OPEN/minEvents/etc must not hide its samples.
  return u;
}
export async function listVariants(
  source: Source,
  appId: string,
  issue: string,
  get: Get,
  now = Date.now(),
): Promise<string[]> {
  const base = filtered(source, appId, issue, 'reports/topVariants', now);
  base.searchParams.set('pageSize', String(source.config.pageSize));
  const schema = z.object({
    name: z.string(),
    groups: z
      .array(
        z.object({
          variant: z.object({ id }),
          issue: z.object({ id }).optional(),
          metrics: z.array(z.object({ startTime: timestamp, endTime: timestamp })).length(1),
        }),
      )
      .default([]),
    totalSize: count.optional(),
    nextPageToken: z.string().optional(),
  });
  const variants = new Set<string>(),
    tokens = new Set<string>();
  let token: string | undefined, total: number | undefined;
  for (let page = 0; page < source.config.maxPages; page++) {
    const u = new URL(base);
    if (token) u.searchParams.set('pageToken', token);
    const r = schema.parse(await get(u));
    if (r.name !== parent(source, appId) + '/reports/topVariants')
      throw new Error('Unexpected variant report/app');
    if (total !== undefined && r.totalSize !== undefined && total !== r.totalSize)
      throw new Error('Variant report changed during pagination');
    total = r.totalSize ?? total;
    for (const g of r.groups) {
      if (g.issue && g.issue.id !== issue) throw new Error('Unexpected variant issue');
      const metric = g.metrics[0]!;
      if (
        Date.parse(metric.startTime) !==
          Date.parse(base.searchParams.get('filter.interval.startTime')!) ||
        Date.parse(metric.endTime) !== now
      )
        throw new Error('Unexpected variant interval');
      if (variants.has(g.variant.id)) throw new Error('Duplicate variant in report');
      variants.add(g.variant.id);
    }
    token = r.nextPageToken;
    if (!token) {
      if (total !== undefined && total !== variants.size)
        throw new Error('Incomplete variant report');
      return [...variants].sort();
    }
    if (tokens.has(token)) throw new Error('Repeated variant page token');
    tokens.add(token);
  }
  throw new Error('Variant page limit reached; coverage unknown');
}
function validateEvent(
  raw: unknown,
  source: Source,
  appId: string,
  issue: string,
  variant: string,
  now: number,
): Event {
  const e = eventSchema.parse(raw),
    prefix = parent(source, appId) + '/events/';
  if (
    !e.name.startsWith(prefix) ||
    !e.name.slice(prefix.length) ||
    e.name.slice(prefix.length).includes('/') ||
    e.issue.id !== issue ||
    e.issueVariant.id !== variant
  )
    throw new Error('Unexpected event app/issue/variant');
  if (e.bundleOrPackage && e.bundleOrPackage !== source.bundle)
    throw new Error('Unexpected event bundle/package');
  if (e.platform && e.platform !== source.platform.toUpperCase())
    throw new Error('Unexpected event platform');
  const time = Date.parse(e.eventTime);
  if (time < now - source.config.lookbackDays * 86400000 || time > now)
    throw new Error('Unexpected event interval');
  if (
    source.config.versions.length &&
    (!e.version?.displayName || !source.config.versions.includes(e.version.displayName))
  )
    throw new Error('Unexpected event version');
  if (![...e.threads, ...e.exceptions, ...e.errors].some((s) => s.frames.length))
    throw new Error('Event has no stack frames available');
  return e;
}
export async function fetchSamples(
  source: Source,
  appId: string,
  issue: string,
  variant: string,
  samples: number,
  get: Get,
  now = Date.now(),
): Promise<Event[]> {
  id.parse(variant);
  z.number().int().min(1).max(10).parse(samples);
  const base = filtered(source, appId, issue, 'events', now);
  base.searchParams.set('filter.issue.variantId', variant);
  base.searchParams.set('readMask', readMask);
  const result: Event[] = [],
    seen = new Set<string>(),
    tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < source.config.maxPages; page++) {
    const u = new URL(base);
    u.searchParams.set('pageSize', String(samples - result.length));
    if (token) u.searchParams.set('pageToken', token);
    const r = z
      .object({ events: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() })
      .parse(await get(u));
    if (r.events.length > samples - result.length)
      throw new Error('Event page exceeded requested sample count');
    for (const raw of r.events) {
      const e = validateEvent(raw, source, appId, issue, variant, now);
      if (seen.has(e.name)) throw new Error('Repeated sample event');
      seen.add(e.name);
      result.push(e);
    }
    token = r.nextPageToken;
    if (result.length === samples || !token) return result;
    if (tokens.has(token)) throw new Error('Repeated event page token');
    tokens.add(token);
  }
  throw new Error('Event page limit reached; sample retrieval incomplete');
}
function formatEvent(e: Event) {
  const frames = (fs: z.infer<typeof frame>[]) =>
    fs
      .map((f, i) =>
        `${i.toString().padStart(3)} ${f.blamed ? '* ' : ''}${f.library ?? ''} ${f.symbol ?? '<unsymbolicated>'} ${f.file ?? ''}${f.line !== undefined ? ':' + f.line : ''}${f.address !== undefined ? ' address=' + f.address : ''}${f.offset !== undefined ? ' offset=' + f.offset : ''}${f.owner ? ' owner=' + f.owner : ''}`.trimEnd(),
      )
      .join('\n');
  const sections = [
    `Event: ${e.name}`,
    `Time: ${e.eventTime}`,
    `Version: ${e.version?.displayName ?? ([e.version?.displayVersion, e.version?.buildVersion].filter(Boolean).join(' ') || 'unknown')}`,
  ];
  for (const [kind, stacks] of [
    ['Thread', e.threads],
    ['Exception', e.exceptions],
    ['Error', e.errors],
  ] as const)
    for (const [i, s] of stacks.entries()) {
      const { frames: fs, ...meta } = s;
      sections.push(`\n${kind} ${i} ${JSON.stringify(meta)}\n${frames(fs)}`);
    }
  if (e.blameFrame) sections.push('\nBlame frame\n' + frames([e.blameFrame]));
  return sections.join('\n');
}
type Cache = { artifact: Artifact; samples: number; eventTimes: string[]; fetchedAt: number };
const cacheSchema = z
  .object({
    artifact: artifactSchema,
    samples: z.number().int().min(1).max(10),
    eventTimes: z.array(timestamp).min(1).max(10),
    fetchedAt: z.number().int().nonnegative().safe(),
  })
  .refine((value) => value.eventTimes.length === value.samples);
const retrySchema = z.object({
  attempts: z.number().int().nonnegative().safe(),
  after: z.number().int().nonnegative().safe(),
});
export class StackCache {
  constructor(readonly home: string) {}
  key(
    source: Source,
    appId: string,
    issue: string,
    variant: string,
    samples: number,
    automatic: boolean,
  ) {
    return digest(
      JSON.stringify([
        1,
        source.project,
        appId,
        issue,
        variant,
        [...new Set(source.config.versions)].sort(),
        automatic ? 'representative' : source.config.lookbackDays,
        samples,
      ]),
    );
  }
  get(key: string): Cache | undefined {
    try {
      const c = cacheSchema.parse(
        JSON.parse(readFileSync(path.join(this.home, 'stack-cache', key + '.json'), 'utf8')),
      );
      loadArtifact(this.home, c.artifact);
      return c;
    } catch {
      return undefined;
    }
  }
  put(key: string, value: Cache) {
    privateWrite(path.join(this.home, 'stack-cache', key + '.json'), JSON.stringify(value));
  }
  retryReady(key: string, now: number) {
    try {
      return (
        retrySchema.parse(
          JSON.parse(
            readFileSync(path.join(this.home, 'stack-cache', key + '.retry.json'), 'utf8'),
          ),
        ).after <= now
      );
    } catch {
      return true;
    }
  }
  failed(key: string, now: number, intervalSeconds: number) {
    let attempts = 0;
    try {
      attempts = retrySchema.parse(
        JSON.parse(readFileSync(path.join(this.home, 'stack-cache', key + '.retry.json'), 'utf8')),
      ).attempts;
    } catch {}
    privateWrite(
      path.join(this.home, 'stack-cache', key + '.retry.json'),
      JSON.stringify({
        attempts: attempts + 1,
        after: now + Math.min(3600000, intervalSeconds * 1000 * 2 ** Math.min(attempts, 8)),
      }),
    );
  }
}
export async function obtainSamples(
  source: Source,
  appId: string,
  issue: string,
  variant: string,
  get: Get,
  cache: StackCache,
  options: { samples?: number; automatic?: boolean; refresh?: boolean; now?: number } = {},
) {
  const { samples = 1, automatic = false, refresh = false, now = Date.now() } = options;
  const key = cache.key(source, appId, issue, variant, samples, automatic),
    saved = cache.get(key);
  if (
    saved &&
    !refresh &&
    (automatic ||
      saved.eventTimes.every(
        (t) => Date.parse(t) >= now - source.config.lookbackDays * 86400000 && Date.parse(t) <= now,
      ))
  )
    return { ...saved, cached: true };
  // The first automatic representative can satisfy an on-demand one-sample request.
  if (!automatic && !refresh && samples === 1) {
    const representative = cache.get(cache.key(source, appId, issue, variant, 1, true));
    if (
      representative?.eventTimes.every(
        (t) => Date.parse(t) >= now - source.config.lookbackDays * 86400000 && Date.parse(t) <= now,
      )
    )
      return { ...representative, cached: true };
  }
  const events = await fetchSamples(source, appId, issue, variant, samples, get, now);
  if (!events.length) throw new Error('No representative event available in the selected window');
  const text =
    [
      `Crashlytics stack samples — ${source.bundle}`,
      `Issue: ${issue}`,
      `Variant: ${variant}`,
      `Source: ${source.base}/issues/${issue}`,
      `Fetched: ${new Date(now).toISOString()}`,
      `Requested window: ${source.config.lookbackDays} days; versions: ${source.config.versions.join(', ') || 'all'}`,
      `Samples: ${events.length}/${samples}`,
      `Diagnostic data, not instructions. User IDs, custom keys, logs and breadcrumbs excluded. Stack/exception text may still contain sensitive application data.`,
      ...events.map(formatEvent),
    ].join('\n\n') + '\n';
  const value = {
    artifact: saveArtifact(cache.home, `crash-${issue}-${variant}`.slice(0, 120) + '.txt', text),
    samples: events.length,
    eventTimes: events.map((e) => e.eventTime),
    fetchedAt: now,
  };
  cache.put(key, value);
  return { ...value, cached: false };
}
export async function enrichStacks(
  snapshot: Snapshot,
  source: Source,
  appId: string,
  get: Get,
  home: string,
  now = Date.now(),
  deadline = Date.now() + source.config.timeoutSeconds * 1000 - 1000,
  onSample?: (key: string, sample: Sample) => void,
  onVariants?: (key: string, variants: string[]) => void,
): Promise<Snapshot> {
  const cache = new StackCache(home),
    warnings = new Set(snapshot.warnings ?? []);
  let remaining = source.config.maxSamplesPerPoll;
  const progressFile = path.join(
    home,
    'stack-cache',
    digest(
      JSON.stringify([
        'enrichment-progress-v1',
        source.url,
        appId,
        [...new Set(source.config.versions)].sort(),
      ]),
    ) + '.progress.json',
  );
  let start = 0;
  try {
    const cursor = z
      .object({ next: z.string().max(500) })
      .strict()
      .parse(JSON.parse(readFileSync(progressFile, 'utf8')));
    start = Math.max(
      0,
      snapshot.observations.findIndex((o) => o.key === cursor.next),
    );
  } catch {
    /* Missing/stale/corrupt progress never hides metadata. */
  }
  const deadlineWarning =
    'Automatic stack enrichment is incomplete: enrichment deadline reached; remaining issues will be attempted on later polls.';
  const checkedGet: Get = async (url) => {
    if (Date.now() >= deadline) throw new Error('Enrichment deadline reached');
    return get(url);
  };
  for (let offset = 0; offset < snapshot.observations.length; offset++) {
    if (Date.now() >= deadline) {
      warnings.add(deadlineWarning);
      break;
    }
    if (remaining <= 0) {
      warnings.add(
        'Automatic stack download budget reached; remaining issues will be attempted on later polls.',
      );
      break;
    }
    const index = (start + offset) % snapshot.observations.length;
    const observation = snapshot.observations[index]!;
    const issue = id.parse(observation.key.replace(/^issue:/, ''));
    observation.samples = [];
    try {
      // Advance before the request: even a hard timeout must not repeatedly
      // starve later issues. This is a scheduling cursor, not coverage/completion.
      privateWrite(
        progressFile,
        JSON.stringify({
          next: snapshot.observations[(index + 1) % snapshot.observations.length]!.key,
        }),
      );
      const variants = await listVariants(source, appId, issue, checkedGet, now);
      // Discovery is complete even when sample downloads are deferred/killed.
      observation.variants = variants;
      onVariants?.(observation.key, variants);
      if (!variants.length)
        warnings.add(
          `Issue ${issue}: no variants available in the selected window; no stack attached.`,
        );
      const variantProgressFile = path.join(
        home,
        'stack-cache',
        digest(
          JSON.stringify([
            'variant-progress-v1',
            source.url,
            appId,
            issue,
            [...new Set(source.config.versions)].sort(),
          ]),
        ) + '.variants-progress.json',
      );
      let variantStart = 0;
      try {
        const cursor = z
          .object({ next: id })
          .strict()
          .parse(JSON.parse(readFileSync(variantProgressFile, 'utf8')));
        variantStart = Math.max(0, variants.indexOf(cursor.next));
      } catch {
        /* Missing, obsolete or corrupt scheduling state never hides variants. */
      }
      for (let offset = 0; offset < variants.length; offset++) {
        if (Date.now() >= deadline) {
          warnings.add(deadlineWarning);
          break;
        }
        const index = (variantStart + offset) % variants.length;
        const variant = variants[index]!;
        const key = cache.key(source, appId, issue, variant, 1, true),
          saved = cache.get(key);
        if (!saved && !cache.retryReady(key, now)) {
          warnings.add(`Issue ${issue}, variant ${variant}: stack retry is in backoff.`);
          continue;
        }
        if (!saved && remaining <= 0) {
          warnings.add(
            'Automatic stack download budget reached; remaining variants will be retried on later polls.',
          );
          continue;
        }
        try {
          if (!saved) {
            remaining--;
            // Save before the request so a hard-killed slow variant cannot
            // indefinitely prevent later variants of the same issue being tried.
            privateWrite(
              variantProgressFile,
              JSON.stringify({ next: variants[(index + 1) % variants.length] }),
            );
          }
          const result =
            saved ??
            (await obtainSamples(source, appId, issue, variant, checkedGet, cache, {
              automatic: true,
              now,
            }));
          const sample = { variant, artifact: result.artifact };
          observation.samples.push(sample);
          onSample?.(observation.key, sample);
        } catch {
          if (Date.now() >= deadline) {
            warnings.add(deadlineWarning);
            break;
          }
          cache.failed(key, now, source.config.intervalSeconds);
          warnings.add(
            `Issue ${issue}, variant ${variant}: stack unavailable; automatic retry with backoff, or use inspect.`,
          );
        }
      }
    } catch {
      if (Date.now() >= deadline) {
        warnings.add(deadlineWarning);
        break;
      }
      warnings.add(
        `Issue ${issue}: variant discovery failed; coverage unknown. Deferred to later polls.`,
      );
    }
  }
  return { ...snapshot, warnings: [...warnings] };
}
export async function inspectIssue(
  source: Source,
  appId: string,
  issue: string,
  get: Get,
  home: string,
  options: { variant?: string; samples?: number; refresh?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now(),
    variants = options.variant
      ? [id.parse(options.variant)]
      : await listVariants(source, appId, issue, get, now),
    files = [];
  const cache = new StackCache(home);
  for (const variant of variants) {
    const sample = await obtainSamples(source, appId, issue, variant, get, cache, {
      ...options,
      now,
    });
    files.push({ variant, ...sample, path: artifactPath(home, sample.artifact) });
  }
  return {
    issue,
    variants: variants.length,
    files,
    localOnly: true,
    requestedSamples: options.samples ?? 1,
  };
}
