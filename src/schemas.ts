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
});
export type ArchiveSettings = z.infer<typeof archiveSettingsSchema>;
export const defaultSettings: ArchiveSettings = {
  integrations: defaultIntegrations,
  retentionDays: null,
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
}
