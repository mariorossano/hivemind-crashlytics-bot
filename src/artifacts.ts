import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  realpathSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Artifact } from './readers/config.ts';

export const digest = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
export const maxArtifactBytes = 32 * 1024 * 1024;
export const artifactSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  name: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\.txt$/)
    .max(160),
  bytes: z.number().int().positive().max(maxArtifactBytes),
});
export function privateWrite(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.next';
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
export function saveArtifact(home: string, name: string, text: string): Artifact {
  const artifact = artifactSchema.parse({
    sha256: digest(text),
    name,
    bytes: Buffer.byteLength(text),
  });
  privateWrite(path.join(home, 'artifacts', artifact.sha256 + '.txt'), text);
  return artifact;
}
export function artifactPath(home: string, artifact: Artifact) {
  return path.join(home, 'artifacts', artifactSchema.parse(artifact).sha256 + '.txt');
}
export function loadArtifact(home: string, input: Artifact): Buffer {
  const artifact = artifactSchema.parse(input),
    file = artifactPath(home, artifact);
  const base = realpathSync(home) + path.sep;
  const info = lstatSync(file);
  if (!realpathSync(file).startsWith(base) || !info.isFile())
    throw new Error('Invalid artifact location');
  if (info.size !== artifact.bytes) throw new Error('Cached artifact missing or changed');
  const bytes = readFileSync(file);
  if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256)
    throw new Error('Cached artifact missing or changed');
  return bytes;
}

const separator = '\n\n' + '='.repeat(72) + '\n\n';
const separatorBytes = Buffer.byteLength(separator);

/** Preserve input order and validate each descriptor before loading any files.
 * Each batch can become one bounded attachment; no sample is dropped/truncated. */
export function partitionArtifacts(inputs: Artifact[]): Artifact[][] {
  const batches: Artifact[][] = [];
  let batch: Artifact[] = [],
    bytes = 0;
  for (const input of inputs) {
    const artifact = artifactSchema.parse(input);
    if (batch.length && bytes + separatorBytes + artifact.bytes > maxArtifactBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    bytes += (batch.length ? separatorBytes : 0) + artifact.bytes;
    batch.push(artifact);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function bundleArtifacts(home: string, name: string, inputs: Artifact[]) {
  const artifacts = inputs.map((input) => artifactSchema.parse(input));
  const bytes =
    artifacts.reduce((total, artifact) => total + artifact.bytes, 0) +
    Math.max(0, artifacts.length - 1) * separatorBytes;
  if (bytes > maxArtifactBytes)
    throw new Error('Combined stack attachment exceeds 32 MiB; no observation was queued');
  return saveArtifact(
    home,
    name,
    artifacts.map((artifact) => loadArtifact(home, artifact).toString('utf8')).join(separator),
  );
}
