/**
 * SSE stream consumer for the Claude Code /api/converse endpoint.
 * Pure async I/O — no reactive state, no Gemini dependency.
 */

import type { ConverseApi } from './types';

export function createConverseApi(endpoint = '/api/converse'): ConverseApi {
  let sessionId: string | null = null;
  let controller: AbortController | null = null;

  return {
    get sessionId() { return sessionId; },
    set sessionId(id: string | null) { sessionId = id; },

    abort() { controller?.abort(); controller = null; },

    async stream(instruction, { onChunk, onDone, onError }) {
      console.log('[converse] starting:', instruction.slice(0, 120), 'session:', sessionId);
      controller = new AbortController();
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction, session_id: sessionId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          console.error('[converse] fetch failed:', res.status);
          onError(`Claude Code request failed (${res.status}).`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let nChunks = 0;
        let fullText = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const parts = buf.split('\n\n');
          buf = parts.pop()!;

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6));
            if (data.text) {
              nChunks++;
              fullText += data.text;
              onChunk(data.text);
            }
            if (data.done) {
              if (data.session_id) sessionId = data.session_id;
              console.log(
                `[converse] done: ${nChunks} chunks, cost=$${data.cost_usd}, ${data.duration_ms}ms, session=${sessionId}\n[claude] ${fullText}`,
              );
              onDone?.(data.cost_usd, data.duration_ms);
            }
          }
        }
      } catch (e) {
        console.error('[converse] SSE error:', e);
        onError('Claude Code request failed.');
      } finally {
        controller = null;
      }
    },
  };
}
