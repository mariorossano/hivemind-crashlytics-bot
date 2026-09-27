import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonInput } from '../src/input.ts';
async function* stream(chunks: Uint8Array[]) {
  yield* chunks;
}
test('protocol JSON preserves multibyte characters split at every byte boundary', async () => {
  const value = { text: 'é € 😀' };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(
    await readJsonInput(stream([...bytes].map((byte) => Buffer.from([byte])))),
    value,
  );
});
test('protocol limits count bytes and invalid input never echoes credentials', async () => {
  await assert.rejects(readJsonInput(stream([Buffer.from('"ééé"')]), 6), /byte limit/);
  for (const bytes of [
    Buffer.from('SECRET-CONNECTION-TOKEN'),
    Buffer.from([34, 0xff, 34]),
    Buffer.alloc(0),
  ]) {
    await assert.rejects(readJsonInput(stream([bytes])), /^Error: Invalid JSON input$/);
  }
});
