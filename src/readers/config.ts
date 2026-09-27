import { z } from 'zod';
import { artifactSchema } from '../artifacts.ts';

export type Artifact = { sha256: string; name: string; bytes: number };
export type Sample = { variant: string; artifact: Artifact };
export type Observation = {
  key: string;
  value: unknown;
  body: string;
  author?: string;
  url: string;
  occurredAt?: number;
  samples?: Sample[];
  variants?: string[];
};
export type Snapshot = { observations: Observation[]; usage?: unknown; warnings?: string[] };
export const sampleSchema = z
  .object({
    variant: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    artifact: artifactSchema,
  })
  .strict();
export const variantInventorySchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
  .max(10000)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate variant inventory');
export const variantCheckpointSchema = z
  .object({
    type: z.literal('variants'),
    key: z.string().min(1).max(500),
    variants: variantInventorySchema,
  })
  .strict();
export const sampleCheckpointSchema = z
  .object({
    type: z.literal('sample'),
    key: z.string().min(1).max(500),
    sample: sampleSchema,
  })
  .strict();
export const snapshotSchema = z
  .object({
    observations: z
      .array(
        z
          .object({
            key: z.string().min(1).max(500),
            value: z.unknown().refine((value) => value !== undefined, 'Missing fingerprint value'),
            body: z.string().max(100000),
            url: z.string().url().max(4096),
            author: z.string().max(1000).optional(),
            occurredAt: z.number().int().nonnegative().safe().optional(),
            samples: z.array(sampleSchema).max(10000).optional(),
            variants: variantInventorySchema.optional(),
          })
          .strict(),
      )
      .max(10000),
    usage: z.unknown().optional(),
    warnings: z.array(z.string().max(10000)).max(10000).optional(),
  })
  .strict();
export const metadataCheckpointSchema = z
  .object({
    type: z.literal('metadata'),
    snapshot: snapshotSchema.refine(
      (s) => s.observations.every((o) => o.samples === undefined && o.variants === undefined),
      'Metadata checkpoint cannot contain stacks or variant inventories',
    ),
  })
  .strict();
export function excerpt(text: string, limit = 3300) {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Excerpt truncated; open the original for the full text.]`;
}
