import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifySignals } from '../src/classifications.ts';
import { main } from '../src/runtime.ts';

test('classifications are combinable native labels; unknown and unspecified do not imply urgency', () => {
  assert.deepEqual(
    classifySignals([
      'SIGNAL_REPETITIVE',
      'SIGNAL_FRESH',
      'SIGNAL_EARLY',
      'SIGNAL_REGRESSED',
      'SIGNAL_REPETITIVE',
      'SIGNAL_FUTURE',
      'SIGNAL_UNSPECIFIED',
    ]),
    {
      classifications: ['early', 'new', 'regressed', 'repetitive'],
      unknownSignals: ['SIGNAL_FUTURE'],
    },
  );
  assert.deepEqual(classifySignals([]), { classifications: [], unknownSignals: [] });
});

test('deferred official-alert import is rejected before profile or provider access', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'crashlytics-no-alert-import-'));
  try {
    await assert.rejects(
      main(['import-alert', '--id', 'fixture', '--home', path.join(scratch, 'missing-profile')]),
      /^Error: Unknown bot command$/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
