/**
 * Pure functions for extracting data from Message content blocks.
 * No framework dependency — works in any route.
 */

import type { ContentBlock, Message } from './chat-types';

export function messageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function messageToolUses(msg: Message): Extract<ContentBlock, { type: 'tool_use' }>[] {
  if (typeof msg.content === 'string') return [];
  return msg.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

export function messageToolResults(msg: Message): Extract<ContentBlock, { type: 'tool_result' }>[] {
  if (typeof msg.content === 'string') return [];
  return msg.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );
}

export function messageThinking(msg: Message): string[] {
  if (typeof msg.content === 'string') return [];
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking);
}

export function buildToolResultMap(msgs: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of msgs) {
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result') map.set(b.tool_use_id, b.content);
    }
  }
  return map;
}

export function isToolResultOnly(msg: Message): boolean {
  if (msg.role !== 'user' || typeof msg.content === 'string') return false;
  return msg.content.every((b) => b.type === 'tool_result');
}
