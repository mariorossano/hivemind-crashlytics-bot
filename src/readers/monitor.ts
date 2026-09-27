import type { Source } from '../provider.ts';
import { readCrashlytics, type Get } from './crashlytics.ts';
import { enrichStacks } from './stacks.ts';
import type { Snapshot, Sample } from './config.ts';

/** Only a complete validated metadata report may be emitted before enrichment.
 * Partial pagination, wrong identities or provider failures produce no checkpoint. */
export async function readMonitor(
  source: Source,
  appId: string,
  get: Get,
  home: string,
  options: {
    prefetchStacks: boolean;
    deadline: number;
    checkpoint: (snapshot: Snapshot) => void;
    sample?: (key: string, sample: Sample) => void;
    variants?: (key: string, variants: string[]) => void;
    now?: number;
  },
) {
  const now = options.now ?? Date.now();
  const snapshot = await readCrashlytics(source, appId, get, now);
  if (!options.prefetchStacks) return snapshot;
  options.checkpoint(snapshot);
  return enrichStacks(
    snapshot,
    source,
    appId,
    get,
    home,
    now,
    options.deadline,
    options.sample,
    options.variants,
  );
}
