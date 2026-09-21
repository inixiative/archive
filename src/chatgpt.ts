import { z } from 'zod';
import { type ArchiveEntry, archiveSnapshotSchema } from './index';

const exportSchema = z.object({
  thread: z.object({ id: z.string(), kind: z.literal('chatgpt'), title: z.string() }),
  page: z.object({ order: z.literal('newest_first'), hasMore: z.boolean() }),
  turns: z.array(
    z.object({
      id: z.string(),
      startedAt: z.number().nullable(),
      completedAt: z.number().nullable(),
      items: z.array(
        z.object({
          type: z.string(),
          id: z.string(),
          text: z.string().optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        }),
      ),
    }),
  ),
});

/** Import the text returned by the desktop ChatGPT conversation reader, not a native JSONL log. */
export function importChatGPTThread(
  input: unknown,
  options: { sourceId: string; projectId?: string; title?: string },
) {
  const data = exportSchema.parse(input);
  const entries: ArchiveEntry[] = [];
  for (const turn of [...data.turns].reverse()) {
    for (const item of turn.items) {
      if (!['userMessage', 'agentMessage'].includes(item.type)) continue;
      const text =
        item.text ??
        item.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n');
      if (!text) continue;
      entries.push({
        id: item.id,
        turnId: turn.id,
        kind: item.type === 'userMessage' ? 'user' : 'assistant',
        text,
        timestamp:
          (item.type === 'userMessage' ? turn.startedAt : turn.completedAt) === null
            ? null
            : (item.type === 'userMessage' ? turn.startedAt! : turn.completedAt!) * 1000,
        sourceRef: `chatgpt:${data.thread.id}:${item.id}`,
      });
    }
  }
  if (!entries.length) throw new Error('ChatGPT export contains no readable messages');
  return archiveSnapshotSchema.parse({
    schemaVersion: 1,
    source: 'chatgpt',
    sourceId: options.sourceId,
    sessionId: data.thread.id,
    title: options.title ?? data.thread.title,
    projectId: options.projectId,
    tags: [],
    capturedAt: Date.now(),
    entries,
    coverage: {
      reasoning: 'unavailable',
      completeness: 'partial',
      omissions: [
        'Desktop conversation text only; tool activity, attachments, alternate branches and citation targets are not exported. Reader text may be truncated.',
        ...(data.page.hasMore ? ['Older conversation turns are not included in this page.'] : []),
      ],
    },
  });
}
