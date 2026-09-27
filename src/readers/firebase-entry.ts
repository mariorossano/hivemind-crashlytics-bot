import { configSchema, parseSource } from '../provider.ts';
import { authenticatedGet } from './firebase-auth.ts';
import { resolveApp } from './crashlytics.ts';
import { inspectIssue, parseIssue } from './stacks.ts';
import { readMonitor } from './monitor.ts';
import { readTopIssues } from '../top-issues.ts';
import { queryFailure } from '../query-errors.ts';
import { installParentLifeline } from './parent-lifeline.ts';
import { readJsonInput } from '../input.ts';
import { z } from 'zod';
process.umask(0o077);
const releaseLifeline = installParentLifeline();
let ranking = false;
try {
  const request = z
    .object({
      url: z.string().url(),
      config: configSchema,
      action: z.enum(['inspect', 'top_issues']).optional(),
      limit: z.number().int().min(1).max(10).optional(),
      prefetchStacks: z.boolean().optional(),
      enrichmentDeadline: z.number().int().nonnegative().safe().optional(),
      options: z
        .object({
          variant: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,200}$/)
            .optional(),
          samples: z.number().int().min(1).max(10).optional(),
          refresh: z.boolean().optional(),
          days: z.number().int().min(1).max(89).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(await readJsonInput(process.stdin));
  ranking = request.action === 'top_issues';
  const config = request.config;
  const target = request.action === 'inspect' ? parseIssue(request.url, config) : undefined;
  const source = target?.source ?? parseSource(request.url, config);
  const get = await authenticatedGet(config.account);
  const appId = await resolveApp(source, get);
  if (target)
    console.log(
      JSON.stringify(
        await inspectIssue(source, appId, target.issue, get, process.cwd(), request.options),
      ),
    );
  else if (request.action === 'top_issues')
    console.log(JSON.stringify(await readTopIssues(source, appId, get, request.limit ?? 1)));
  else {
    const snapshot = await readMonitor(source, appId, get, process.cwd(), {
      prefetchStacks: request.prefetchStacks === true,
      deadline: request.enrichmentDeadline ?? Date.now() + config.timeoutSeconds * 1000 - 1000,
      checkpoint: (snapshot) => console.log(JSON.stringify({ type: 'metadata', snapshot })),
      sample: (key, sample) => console.log(JSON.stringify({ type: 'sample', key, sample })),
      variants: (key, variants) => console.log(JSON.stringify({ type: 'variants', key, variants })),
    });
    console.log(JSON.stringify(snapshot));
  }
} catch (error) {
  if (ranking) console.log(JSON.stringify(queryFailure(error)));
  else {
    const message =
      error instanceof Error && error.name !== 'ZodError'
        ? error.message
        : 'Firebase response/configuration did not match the expected schema';
    console.log(JSON.stringify({ error: message.slice(0, 300) }));
  }
} finally {
  releaseLifeline();
}
