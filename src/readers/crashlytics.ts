import { z } from 'zod';
import type { Source } from '../provider.ts';
import { excerpt, type Snapshot } from './config.ts';
import { classifySignals, classificationLine } from '../classifications.ts';
export type Get = (url: URL) => Promise<unknown>;
const count = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());
const timestamp = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'Invalid timestamp');
const issueSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().optional(),
  title: z.string().default('Untitled issue'),
  subtitle: z.string().default(''),
  uri: z.string().url().optional(),
  errorType: z.enum(['FATAL', 'NON_FATAL', 'ANR']),
  state: z.enum(['OPEN', 'CLOSED', 'MUTED', 'STATE_UNSPECIFIED']).optional(),
  firstSeenVersion: z.string().optional(),
  lastSeenVersion: z.string().optional(),
  firstSeenTime: timestamp.optional(),
  lastSeenTime: timestamp.optional(),
  signals: z
    .array(
      z.object({
        signal: z
          .string()
          .max(100)
          .regex(/^SIGNAL_[A-Z0-9_]+$/),
        description: z.string().optional(),
      }),
    )
    .default([]),
});
const reportSchema = z.object({
  name: z.string(),
  groups: z
    .array(
      z.object({
        issue: issueSchema,
        metrics: z
          .array(
            z.object({
              startTime: timestamp,
              endTime: timestamp,
              eventsCount: count,
              impactedUsersCount: count.optional(),
            }),
          )
          .length(1),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
  totalSize: count.optional(),
});
export async function resolveApp(source: Source, get: Get): Promise<string> {
  const seen = new Set<string>();
  const matches = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < source.config.maxPages; page++) {
    const url = new URL(
      `https://firebase.googleapis.com/v1beta1/projects/${source.project}/${source.platform === 'ios' ? 'iosApps' : 'androidApps'}`,
    );
    url.searchParams.set('pageSize', '100');
    if (token) url.searchParams.set('pageToken', token);
    const result = z
      .object({
        apps: z
          .array(
            z.object({
              appId: z.string(),
              bundleId: z.string().optional(),
              packageName: z.string().optional(),
            }),
          )
          .default([]),
        nextPageToken: z.string().optional(),
      })
      .parse(await get(url));
    for (const app of result.apps)
      if ((source.platform === 'ios' ? app.bundleId : app.packageName) === source.bundle)
        matches.add(app.appId);
    token = result.nextPageToken;
    if (!token) {
      if (matches.size !== 1)
        throw new Error(
          'Expected exactly one Firebase app for the configured project and bundle/package',
        );
      const id = [...matches][0]!;
      if (!new RegExp(`^1:[0-9]+:${source.platform}:[a-zA-Z0-9]+$`).test(id))
        throw new Error('Firebase returned an invalid app ID');
      return id;
    }
    if (seen.has(token)) throw new Error('Repeated app page token');
    seen.add(token);
  }
  throw new Error('App page limit reached; no snapshot applied');
}
export async function readCrashlytics(
  source: Source,
  appId: string,
  get: Get,
  now = Date.now(),
): Promise<Snapshot> {
  const projectNumber = /^1:([0-9]+):(ios|android):[a-zA-Z0-9]+$/.exec(appId);
  if (!projectNumber || projectNumber[2] !== source.platform)
    throw new Error('Invalid Firebase app ID/platform');
  const reportName = `projects/${projectNumber[1]}/apps/${appId}/reports/topIssues`;
  const start = new Date(now - source.config.lookbackDays * 86400000).toISOString(),
    end = new Date(now).toISOString();
  const base = new URL(`https://firebasecrashlytics.googleapis.com/v1alpha/${reportName}`);
  base.searchParams.set('filter.interval.startTime', start);
  base.searchParams.set('filter.interval.endTime', end);
  base.searchParams.set('pageSize', String(source.config.pageSize));
  for (const t of source.config.errorTypes) base.searchParams.append('filter.issue.errorTypes', t);
  for (const s of source.config.states) base.searchParams.append('filter.issue.states', s);
  for (const v of [...new Set(source.config.versions)].sort())
    base.searchParams.append('filter.version.displayNames', v);
  const observations: Snapshot['observations'] = [],
    seenTokens = new Set<string>(),
    seenIssues = new Set<string>();
  const warnings = new Set<string>();
  let token: string | undefined, total: number | undefined;
  for (let page = 0; page < source.config.maxPages; page++) {
    const url = new URL(base);
    if (token) url.searchParams.set('pageToken', token);
    const report = reportSchema.parse(await get(url));
    if (report.name !== reportName) throw new Error('Firebase returned a different report/app');
    if (total !== undefined && report.totalSize !== undefined && total !== report.totalSize)
      throw new Error('Report changed during pagination; retry a complete snapshot');
    total = report.totalSize ?? total;
    for (const group of report.groups) {
      const issue = group.issue,
        metric = group.metrics[0]!;
      if (seenIssues.has(issue.id))
        throw new Error('Repeated issue during pagination; snapshot not applied');
      seenIssues.add(issue.id);
      if (
        Date.parse(metric.startTime) !== Date.parse(start) ||
        Date.parse(metric.endTime) !== Date.parse(end)
      )
        throw new Error('Firebase returned a different report interval');
      if (!source.config.errorTypes.includes(issue.errorType))
        throw new Error('Firebase returned a different error type');
      if (
        source.config.states.length &&
        (!issue.state || !source.config.states.includes(issue.state as 'OPEN' | 'CLOSED' | 'MUTED'))
      )
        throw new Error('Firebase returned an unexpected issue state');
      if (
        issue.name &&
        issue.name !== `projects/${projectNumber[1]}/apps/${appId}/issues/${issue.id}`
      )
        throw new Error('Firebase returned a different issue resource');
      if (metric.eventsCount < source.config.minEvents) continue;
      if (metric.impactedUsersCount === undefined)
        warnings.add('Some user counts are unavailable. Unknown counts are never treated as zero.');
      if (
        source.config.minUsers > 0 &&
        (metric.impactedUsersCount === undefined ||
          metric.impactedUsersCount < source.config.minUsers)
      )
        continue;
      const origin = new URL(source.base + '/issues/' + issue.id);
      if (issue.uri) {
        const reported = new URL(issue.uri);
        const path = reported.pathname.replace(/^\/u\/\d+\//, '/');
        const appIdPath = `/v1/appid/project/${source.project}/crashlytics/app/${appId}/issues/${issue.id}`;
        if (
          reported.protocol !== 'https:' ||
          reported.host !== source.config.host ||
          reported.username ||
          reported.password ||
          ![origin.pathname, appIdPath].includes(path)
        )
          throw new Error('Firebase returned an unexpected issue link');
      }
      origin.searchParams.set('time', source.config.lookbackDays + 'd');
      const signals = [...new Set(issue.signals.map((s) => s.signal))].sort();
      const { classifications, unknownSignals } = classifySignals(signals);
      if (unknownSignals.length)
        warnings.add(
          'Firebase returned unrecognized issue signals; retained as raw signals, not classified.',
        );
      // Time-window movement and per-occurrence timestamps never create notifications.
      const value = {
        title: issue.title,
        subtitle: issue.subtitle,
        state: issue.state ?? null,
        errorType: issue.errorType,
        firstSeenVersion: issue.firstSeenVersion ?? null,
        lastSeenVersion: issue.lastSeenVersion ?? null,
        signals,
        ...(source.config.notifyCounts
          ? { events: metric.eventsCount, users: metric.impactedUsersCount ?? null }
          : {}),
      };
      observations.push({
        key: 'issue:' + issue.id,
        value,
        url: origin.href,
        occurredAt: now,
        body: excerpt(
          [
            classificationLine(classifications, 'issue-signals'),
            `${source.bundle} · ${issue.errorType} · ${issue.title.slice(0, 200)}`,
            issue.subtitle.slice(0, 240),
            `Issue: ${issue.id} · State: ${issue.state ?? 'unknown'}`,
            `Last ${source.config.lookbackDays} days: ${metric.eventsCount} events · ${metric.impactedUsersCount ?? 'unknown'} impacted users`,
            `First / latest seen version: ${issue.firstSeenVersion ?? 'unknown'} / ${issue.lastSeenVersion ?? 'unknown'}`,
            ...(source.config.versions.length
              ? [`Version filter: ${source.config.versions.join(', ')}`]
              : []),
            ...(signals.length ? [`Signals: ${signals.join(', ')}`] : []),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      });
    }
    token = report.nextPageToken;
    if (!token) {
      if (total !== undefined && total !== seenIssues.size)
        throw new Error('Incomplete report; no baseline or events advanced');
      return { observations, warnings: [...warnings] };
    }
    if (seenTokens.has(token)) throw new Error('Repeated report page token');
    seenTokens.add(token);
  }
  throw new Error('Report page limit reached; no baseline or events advanced');
}
