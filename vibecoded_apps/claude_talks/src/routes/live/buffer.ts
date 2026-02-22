/**
 * Sentence-boundary text buffer.
 * Accumulates streaming text chunks and flushes at sentence boundaries
 * (`. ` / `! ` / `? `) once enough text has accumulated (minChars).
 * Falls back to a timer if no boundary is found within maxWaitMs.
 */
export interface SentenceBuffer {
  push(text: string): void;
  flush(): void;
  clear(): void;
}

/** Minimum characters before flushing at a sentence boundary */
const MIN_CHARS = 40;
/** Fallback flush timeout (ms) when no sentence boundary is found */
const MAX_WAIT_MS = 1500;

export function createSentenceBuffer(
  onFlush: (text: string) => void,
  { minChars = MIN_CHARS, maxWaitMs = MAX_WAIT_MS } = {},
): SentenceBuffer {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  function resetTimer() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (buf) {
      timer = setTimeout(() => {
        timer = undefined;
        if (buf) { onFlush(buf.trim()); buf = ''; }
      }, maxWaitMs);
    }
  }

  function push(text: string) {
    buf += text;
    // Find last sentence boundary after minChars
    let lastBoundary = -1;
    for (let i = 0; i < buf.length; i++) {
      if ('.!?'.includes(buf[i]) && (i === buf.length - 1 || buf[i + 1] === ' ' || buf[i + 1] === '\n')) {
        lastBoundary = i;
      }
    }
    if (lastBoundary >= 0 && lastBoundary + 1 >= minChars) {
      const chunk = buf.slice(0, lastBoundary + 1).trim();
      buf = buf.slice(lastBoundary + 1).trimStart();
      if (timer) { clearTimeout(timer); timer = undefined; }
      onFlush(chunk);
    }
    resetTimer();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (buf.trim()) { onFlush(buf.trim()); buf = ''; }
  }

  function clear() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    buf = '';
  }

  return { push, flush, clear };
}
