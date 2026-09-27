import { setTimeout as delay } from 'node:timers/promises';
import { configSchema, parseSource } from '../../src/provider.ts';
import { readMonitor } from '../../src/readers/monitor.ts';
import { readJsonInput } from '../../src/input.ts';
const request = (await readJsonInput(process.stdin)) as any;
const source = parseSource(request.url, configSchema.parse(request.config));
const app = '1:123456:ios:abcdef',
  parent = `projects/123456/apps/${app}`;
const now = Date.now();
const persistent = process.argv[2] === 'persistent-stall';
const baseline = process.argv[2] === 'baseline';
const variantStall = process.argv[2] === 'variant-stall';
const issueCount = variantStall ? 1 : persistent || baseline ? 2 : 36;
const get = async (u: URL) => {
  const startTime = u.searchParams.get('filter.interval.startTime'),
    endTime = u.searchParams.get('filter.interval.endTime');
  if (u.pathname.endsWith('/reports/topIssues'))
    return {
      name: parent + '/reports/topIssues',
      totalSize: issueCount,
      groups: Array.from({ length: issueCount }, (_, i) => ({
        issue: { id: 'issue' + i, title: 'Synthetic crash', errorType: 'FATAL', state: 'OPEN' },
        metrics: [{ startTime, endTime, eventsCount: 10, impactedUsersCount: 3 }],
      })),
    };
  const issue = u.searchParams.get('filter.issue.id')!;
  if (u.pathname.endsWith('/reports/topVariants')) {
    await delay(process.argv[2] === 'stall' || (persistent && issue === 'issue1') ? 10000 : 200);
    return {
      name: parent + '/reports/topVariants',
      totalSize: variantStall ? 2 : 1,
      groups: (variantStall ? ['v1', 'v2'] : ['v1']).map((id) => ({
        issue: { id: issue },
        variant: { id },
        metrics: [{ startTime, endTime }],
      })),
    };
  }
  if (u.pathname.endsWith('/events')) {
    const variant = u.searchParams.get('filter.issue.variantId')!;
    if (variantStall && variant === 'v1') await delay(10000);
    return {
      events: [
        {
          name: parent + '/events/evt' + issue,
          eventTime: new Date(now - 1000).toISOString(),
          issue: { id: issue },
          issueVariant: { id: variant },
          threads: [{ frames: [{ symbol: 'synthetic', file: 'Fixture.swift', line: 1 }] }],
        },
      ],
    };
  }
  throw new Error('Unexpected synthetic endpoint');
};
console.log(
  JSON.stringify(
    await readMonitor(source, app, get, process.cwd(), {
      prefetchStacks: request.prefetchStacks === true,
      deadline: request.enrichmentDeadline,
      checkpoint: (snapshot) => console.log(JSON.stringify({ type: 'metadata', snapshot })),
      sample: (key, sample) => console.log(JSON.stringify({ type: 'sample', key, sample })),
      variants: (key, variants) => console.log(JSON.stringify({ type: 'variants', key, variants })),
      now,
    }),
  ),
);
