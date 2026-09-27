/** Firebase owns these classifications. Never infer them from local counts or first observation. */
export const nativeSignalClasses = {
  SIGNAL_FRESH: 'new',
  SIGNAL_REPETITIVE: 'repetitive',
  SIGNAL_REGRESSED: 'regressed',
  SIGNAL_EARLY: 'early',
} as const;

export function classifySignals(signals: readonly string[]) {
  const raw = [...new Set(signals)].sort();
  return {
    classifications: raw
      .filter((signal): signal is keyof typeof nativeSignalClasses =>
        Object.hasOwn(nativeSignalClasses, signal),
      )
      .map((signal) => nativeSignalClasses[signal])
      .sort(),
    unknownSignals: raw.filter(
      (signal) => signal !== 'SIGNAL_UNSPECIFIED' && !Object.hasOwn(nativeSignalClasses, signal),
    ),
  };
}

/** A fixed header precedes provider-controlled titles/text; these are observations, not instructions. */
export function classificationLine(classes: readonly string[], source: 'issue-signals') {
  return `Native classifications: ${classes.length ? classes.join(', ') : 'none reported'} · source: ${source}`;
}
