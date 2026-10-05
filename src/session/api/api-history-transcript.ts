import type { ChatMessage } from './api-agent-loop.js';

const MAX_TOOL_ARGUMENT_PREVIEW = 400;

function content(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content.trim() : '';
}

/** Keep prompts and replies, record tool calls, and omit successful tool output. */
export function formatApiHistoryTranscript(history: readonly ChatMessage[], archiveFile: string): string {
  const sections = [`# API session transcript\n\nFull message archive, including tool output: ${archiveFile}`];

  for (const message of history) {
    if (message.role === 'user' || message.role === 'assistant') {
      const text = content(message);
      if (text) sections.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${text}`);
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const calls = message.tool_calls.map((call) => {
          const args = call.function.arguments || '{}';
          const preview = args.length > MAX_TOOL_ARGUMENT_PREVIEW
            ? `${args.slice(0, MAX_TOOL_ARGUMENT_PREVIEW)}…`
            : args;
          return '- `' + call.id + '` ' + call.function.name + `(${preview})`;
        });
        sections.push(`### Tool calls\n\n${calls.join('\n')}`);
      }
    } else if (message.role === 'tool' && content(message).startsWith('Error:')) {
      sections.push(`### Tool error (${message.tool_call_id ?? 'unknown call'})\n\n${content(message)}`);
    }
  }

  return `${sections.join('\n\n')}\n`;
}
