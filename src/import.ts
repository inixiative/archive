import { type ArchiveEntry, type ArchiveSnapshot, archiveSnapshotSchema } from './index';

export interface ImportOptions {
  source: 'codex' | 'claude-code';
  sourceId: string;
  sessionId?: string;
  title?: string;
  projectId?: string;
}
export function importTranscript(text: string, options: ImportOptions): ArchiveSnapshot {
  return importTranscriptLines(text.split('\n'), options);
}
export function importTranscriptLines(
  lines: Iterable<string>,
  options: ImportOptions,
): ArchiveSnapshot {
  const entries: ArchiveEntry[] = [];
  const omissions = new Set<string>();
  let sessionId = options.sessionId;
  let reasoning = false;
  const seen = new Map<string, string>();
  let index = -1;
  let contentBytes = 0;
  for (const rawLine of lines) {
    index++;
    const line = rawLine.trim();
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid transcript JSON at line ${index + 1}; no archive imported`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error(`Invalid transcript record at line ${index + 1}`);
    if (options.source === 'codex' && row.type === 'session_meta') {
      const id = row.payload?.id;
      if (sessionId && id && id !== sessionId)
        throw new Error('Transcript session identity mismatch');
      sessionId ??= id;
    }
    if (options.source === 'claude-code' && row.sessionId) {
      if (sessionId && sessionId !== row.sessionId) throw new Error('Mixed transcript sessions');
      sessionId = row.sessionId;
    }
    const timestamp = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
    const add = (kind: ArchiveEntry['kind'], content: unknown, suffix: string, callId?: string) => {
      if (typeof content !== 'string' || !content.length) return;
      const id = `${row.uuid ?? row.payload?.id ?? `line-${index + 1}`}:${suffix}`;
      const identity = JSON.stringify([kind, content, callId]);
      if (seen.has(id)) {
        if (seen.get(id) !== identity)
          throw new Error(`Conflicting transcript record at line ${index + 1}`);
        return;
      }
      contentBytes += Buffer.byteLength(content);
      if (contentBytes > 64_000_000 || entries.length >= 50_000 || content.length > 2_000_000)
        throw new Error(
          'Supported transcript content exceeds the archive size limit; no archive imported',
        );
      seen.set(id, identity);
      entries.push({
        id,
        kind,
        text: content,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        sourceRef: `line:${index + 1}`,
        ...(callId ? { callId } : {}),
      });
    };
    if (options.source === 'codex') {
      if (row.type === 'response_item') {
        const p = row.payload ?? {};
        if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
          for (const [i, block] of (p.content ?? []).entries()) {
            if (['input_text', 'output_text', 'text'].includes(block.type))
              add(p.role, block.text, `text-${i}`);
            else omissions.add('Non-text message content is not included');
          }
        } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
          add(
            'tool-call',
            JSON.stringify({ name: p.name, arguments: p.arguments ?? p.input }),
            'call',
            p.call_id,
          );
        } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
          const output =
            typeof p.output === 'string'
              ? p.output
              : Array.isArray(p.output)
                ? p.output
                    .filter((block: any) =>
                      ['text', 'input_text', 'output_text'].includes(block.type),
                    )
                    .map((block: any) => block.text)
                    .join('\n')
                : '';
          if (typeof p.output !== 'string')
            omissions.add('Only text tool output blocks are included');
          add('tool-result', output, 'result', p.call_id);
        } else if (p.type === 'reasoning') {
          for (const [i, block] of (p.summary ?? []).entries()) {
            if (typeof block.text === 'string') {
              add('reasoning-summary', block.text, `summary-${i}`);
              reasoning = true;
            }
          }
          omissions.add('Private reasoning and encrypted payloads are not included');
        }
      }
    } else if (['user', 'assistant'].includes(row.type) && row.message) {
      const blocks = row.message.content;
      if (typeof blocks === 'string') add(row.type, blocks, 'text');
      else if (Array.isArray(blocks))
        for (const [i, block] of blocks.entries()) {
          if (block.type === 'text') add(row.type, block.text, `text-${i}`);
          else if (block.type === 'tool_use')
            add(
              'tool-call',
              JSON.stringify({ name: block.name, input: block.input }),
              `call-${i}`,
              block.id,
            );
          else if (block.type === 'tool_result') {
            const output =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((b: any) => b.type === 'text')
                      .map((b: any) => b.text)
                      .join('\n')
                  : '';
            add('tool-result', output, `result-${i}`, block.tool_use_id);
            if (Array.isArray(block.content) && block.content.some((b: any) => b.type !== 'text'))
              omissions.add('Non-text tool content is not included');
          } else if (['thinking', 'redacted_thinking'].includes(block.type))
            omissions.add('Private reasoning is not included');
          else omissions.add('Non-text message content is not included');
        }
    }
  }
  if (!sessionId || !entries.length)
    throw new Error('Transcript must identify a session and contain supported records');
  const firstPrompt = entries.find(
    (entry) =>
      entry.kind === 'user' &&
      !/^<(?:recommended_plugins|environment_context|user_instructions|permissions)(?:>|\s)/.test(
        entry.text.trimStart(),
      ),
  );
  const title = options.title ?? firstPrompt?.text.slice(0, 160) ?? sessionId;
  return archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: options.sourceId,
    source: options.source,
    sessionId,
    title,
    projectId: options.projectId,
    tags: [],
    capturedAt: Date.now(),
    coverage: {
      reasoning: reasoning ? 'summaries-only' : 'unavailable',
      completeness: 'partial',
      omissions: [
        'Import contains public transcript records only; source history may be incomplete',
        ...omissions,
      ],
    },
    entries,
  });
}
