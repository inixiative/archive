import { type ArchiveEntry, type ArchiveSnapshot, archiveSnapshotSchema } from './index';

export interface ImportOptions {
  source: 'codex' | 'claude-code';
  sourceId: string;
  sessionId?: string;
  title?: string;
  projectId?: string;
}
/** Content the harness wraps in or adds to a user message; the person never typed it. */
const injectedTags = [
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'task-notification',
  'user-prompt-submit-hook',
  'fork-boilerplate',
  'recommended_plugins',
  'environment_context',
  'user_instructions',
  'permissions',
  'INSTRUCTIONS',
  'codex_internal_context',
  'heartbeat',
  'in-app-browser-context',
  'external_codex_apps_open_page',
  'send_user_message_question_reply',
  'turn_aborted',
].join('|');
/** Prompts Codex writes in the user's role. */
const injectedPreamble = /^(?:# In app browser:|The following is the Codex agent history)/;
/**
 * Nothing but blocks of harness-style tags such as `<codex_internal_context>`: `snake_case` or
 * `kebab-case` names, unlike markup a person pastes. A linear scan, since a backtracking pattern is
 * exponential on many sibling blocks.
 */
function onlyTagBlocks(text: string) {
  const open = /\s*<([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)(?:\s[^>]*)?>/y;
  let at = 0;
  let blocks = 0;
  while (at < text.length) {
    open.lastIndex = at;
    const match = open.exec(text);
    if (!match) return blocks > 0 && !text.slice(at).trim();
    const close = text.indexOf(`</${match[1]}>`, open.lastIndex);
    if (close < 0) return false;
    at = close + match[1]!.length + 3;
    blocks++;
  }
  return blocks > 0;
}
const injectedBlock = new RegExp(`<(${injectedTags})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g');
const injectedOpening = new RegExp(`^<(?:${injectedTags})(?:>|\\s)`);
/** Foundry's native-session envelope; the person's text is the first User Message section. */
const foundryUserMessage =
  /^# User Message[ \t]*\n([\s\S]*?)(?=\n# (?:User Message|Assistant Message|Foundry Injection)[ \t]*\n|(?![\s\S]))/m;

/** What the person typed in a user message, without injected content; undefined when nothing is left. */
export function typedPrompt(text: string) {
  let prompt = text
    .replace(injectedBlock, '')
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/g, '')
    .replace(/^\s*# AGENTS\.md instructions for [^\n]*/, '')
    .trim();
  if (/^# (?:System Context|User Message)[ \t]*\n/.test(prompt))
    prompt = prompt.match(foundryUserMessage)?.[1].trim() ?? '';
  if (
    !prompt ||
    injectedOpening.test(prompt) ||
    injectedPreamble.test(prompt) ||
    onlyTagBlocks(prompt) ||
    /^\[Request interrupted by user/.test(prompt)
  )
    return undefined;
  return prompt;
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
  let prompt: string | undefined;
  let metaPrompt: string | undefined;
  let index = -1;
  let contentBytes = 0;
  // Codex states the model per turn; Claude Code per assistant record.
  let turn: { model?: string; effort?: string } = {};
  // A Codex session started by a script (codex exec, a custom originator) has no typed prompts.
  let scripted = false;
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
      const originator = row.payload?.originator;
      if (typeof originator === 'string')
        scripted = !/^codex/i.test(originator) || /^codex_(?:exec|sdk|mcp)/.test(originator);
    }
    if (options.source === 'claude-code' && row.sessionId) {
      // Subagent transcripts reuse their parent's sessionId; each is its own archive.
      const id =
        row.isSidechain && typeof row.agentId === 'string'
          ? `${row.sessionId}/agent-${row.agentId}`
          : row.sessionId;
      if (sessionId && sessionId !== id) throw new Error('Mixed transcript sessions');
      sessionId = id;
    }
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    if (options.source === 'codex' && row.type === 'turn_context')
      turn = { model: text(row.payload?.model), effort: text(row.payload?.effort) };
    const producer =
      options.source === 'codex'
        ? turn
        : row.type === 'assistant'
          ? { model: text(row.message?.model), effort: text(row.effort) }
          : {};
    // A user record the person did not type: an expansion, a compaction summary, a subagent's prompt,
    // a message from the harness, another agent or an SDK caller, or a scripted Codex session's prompt.
    // It is kept as an event, not a user turn.
    const written =
      options.source === 'claude-code'
        ? row.type === 'user' &&
          Boolean(
            row.isMeta ||
              row.isCompactSummary ||
              row.isSidechain ||
              (row.origin && typeof row.origin === 'object'
                ? row.origin.kind !== 'human'
                : typeof row.entrypoint === 'string' && row.entrypoint.startsWith('sdk')),
          )
        : scripted && row.type === 'response_item' && row.payload?.role === 'user';
    // User text is a user entry only when the person typed it; markers and injected blocks are events.
    const textKind = (role: 'user' | 'assistant', content: unknown) =>
      role === 'user' && (written || typeof content !== 'string' || !typedPrompt(content))
        ? 'event'
        : role;
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
      // A prompt someone else wrote (an expansion, a subagent's task) titles the session only when nothing was typed.
      if (!prompt && !row.isCompactSummary) {
        if (kind === 'user') prompt = typedPrompt(content);
        else if (kind === 'event' && written) metaPrompt ??= typedPrompt(content);
      }
      entries.push({
        id,
        kind,
        text: content,
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        sourceRef: `line:${index + 1}`,
        ...(callId ? { callId } : {}),
        ...(['assistant', 'tool-call', 'reasoning-summary'].includes(kind)
          ? {
              ...(producer.model ? { model: producer.model } : {}),
              ...(producer.effort ? { effort: producer.effort } : {}),
            }
          : {}),
      });
    };
    if (options.source === 'codex') {
      // Codex records the person stopping a turn as its own event; Claude Code writes this marker.
      if (row.type === 'event_msg' && row.payload?.type === 'turn_aborted') {
        if (row.payload.reason === 'interrupted')
          add('event', '[Request interrupted by user]', 'aborted');
      } else if (row.type === 'response_item') {
        const p = row.payload ?? {};
        if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
          for (const [i, block] of (p.content ?? []).entries()) {
            if (['input_text', 'output_text', 'text'].includes(block.type))
              add(textKind(p.role, block.text), block.text, `text-${i}`);
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
      if (typeof blocks === 'string') add(textKind(row.type, blocks), blocks, 'text');
      else if (Array.isArray(blocks))
        for (const [i, block] of blocks.entries()) {
          if (block.type === 'text') add(textKind(row.type, block.text), block.text, `text-${i}`);
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
  const title = options.title ?? (prompt ?? metaPrompt)?.slice(0, 160) ?? sessionId;
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
