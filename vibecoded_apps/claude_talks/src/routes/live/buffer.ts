/**
 * Rolling-window text buffer.
 * Accumulates text chunks and flushes at regular intervals.
 * Produces smooth, regular text blocks for TTS consumers.
 */
export interface ChunkBuffer {
  push(text: string): void;
  flush(): void;
  clear(): void;
}

export function createChunkBuffer(
  onFlush: (text: string) => void,
  intervalMs: number = 1000,
): ChunkBuffer {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (buf) { onFlush(buf); buf = ''; }
  }

  function push(text: string) {
    buf += text;
    if (!timer) {
      timer = setTimeout(flush, intervalMs);
    }
  }

  function clear() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    buf = '';
  }

  return { push, flush, clear };
}
