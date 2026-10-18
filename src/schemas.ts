import { z } from 'zod';
import type { ArchiveSnapshot } from './index';
import { archiveIntegrationSchema, defaultIntegrations } from './tags';

export const archiveSettingsSchema = z.strictObject({
  /** Integrations sessions can reference; Kingdom and Foundry display these, Archive owns them. */
  integrations: z
    .array(archiveIntegrationSchema)
    .max(50)
    .refine(
      (list) => new Set(list.map((i) => i.key)).size === list.length,
      'Duplicate integration keys',
    ),
  /** Archives whose latest capture is older than this are deleted here. Deletions never sync. */
  retentionDays: z.number().int().positive().max(36_500).nullable(),
  /**
   * Whether this Archive keeps tool calls and tool results. Off: ingest drops them from every
   * snapshot, whoever writes it (collectors, Foundry, a syncing Archive), and maintenance removes
   * those already held.
   */
  captureToolCallsAndResults: z.boolean(),
});
export type ArchiveSettings = z.infer<typeof archiveSettingsSchema>;
export const defaultSettings: ArchiveSettings = {
  integrations: defaultIntegrations,
  retentionDays: null,
  captureToolCallsAndResults: true,
};

export const tagSchema = z.string().min(1).max(120);
/** A conceptual tag this archive offers: archive-wide (no actor) or for one actor. */
export const tagDefinitionSchema = z.strictObject({
  tag: tagSchema,
  actorId: z.string().min(1).max(256).optional(),
  description: z.string().max(500).optional(),
});
export type TagDefinition = z.infer<typeof tagDefinitionSchema>;

export interface ArchiveFilter {
  projectId?: string;
  source?: ArchiveSnapshot['source'];
  tag?: string;
  actorId?: string;
  reference?: { integration: string; ref: string };
  model?: string;
  effort?: string;
  provider?: string;
  accessPath?: 'subscription' | 'api' | 'unknown';
  /**
   * Test and evaluation runs (`run:test`, `run:oracle`): left out unless asked for. `include` lists
   * them with the rest, `only` lists only them.
   */
  exempt?: 'exclude' | 'include' | 'only';
  /** Archives with this tag among their suggestions. */
  suggestedTag?: string;
}

/** Native sources a writer can claim: sessions it drives and records itself (Foundry). */
export const CLAIM_SOURCES = ['claude-code', 'codex'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];
/** `live` and `fulfilled` leave a session to its claimant; `lapsed` and `none` are captured. */
export type ClaimState = 'none' | 'live' | 'fulfilled' | 'lapsed';
