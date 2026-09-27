import { configSchema, parseSource } from '../provider.ts';
import { authenticatedGet } from './firebase-auth.ts';
import { resolveApp } from './crashlytics.ts';
import { inspectIssue, parseIssue } from './stacks.ts';
import { readMonitor } from './monitor.ts';
import { readJsonInput } from '../input.ts';
import { z } from 'zod';
process.umask(0o077);
try {
  const request = z
    .object({
      url: z.string().url(),
      config: configSchema,
      action: z.literal('inspect').optional(),
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
  const message =
    error instanceof Error && error.name !== 'ZodError'
      ? error.message
      : 'Firebase response/configuration did not match the expected schema';
  console.log(JSON.stringify({ error: message.slice(0, 300) }));
}
