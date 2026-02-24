/**
 * Browser-native keyword listener using SpeechRecognition.
 * Matches individual words in speech against a keyword→callback map.
 * Fires the first matching callback, then auto-stops.
 *
 * Used for:
 * - Approval holds: accept/reject keywords while Gemini is frozen
 * - Stop detection: stop/cancel keywords while Claude is streaming
 */

// ── Keyword sets ──

export const ACCEPT_WORDS = ['accept', 'yes'] as const;
export const REJECT_WORDS = ['reject', 'no'] as const;
export const STOP_WORDS = ['stop', 'cancel'] as const;

// ── Listener ──

interface KeywordListenerOptions {
  tag?: string;
  lang?: string;
}

/**
 * Start listening for keywords via webkitSpeechRecognition.
 * Returns a stop() handle, or null if SpeechRecognition is unavailable.
 */
export function startKeywordListener(
  keywords: Record<string, () => void>,
  { tag = 'keyword', lang = 'en-US' }: KeywordListenerOptions = {},
): (() => void) | null {
  if (!webkitSpeechRecognition) {
    console.warn(`[${tag}] SpeechRecognition not available`);
    return null;
  }

  const map = new Map(Object.entries(keywords));
  const recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = lang;

  let stopped = false;

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (!result?.isFinal) return;

    const transcript = result[0].transcript.trim().toLowerCase();
    console.log(`[${tag}] heard: "${transcript}"`);

    for (const w of transcript.split(/\s+/)) {
      const handler = map.get(w);
      if (handler) {
        stop();
        handler();
        return;
      }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      console.warn(`[${tag}] mic permission denied — stopping`);
      stop();
      return;
    }
    // 'no-speech' and 'aborted' are expected during normal operation
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn(`[${tag}] error: ${event.error}`);
    }
  };

  recognition.onend = () => {
    // Restart if we haven't been explicitly stopped
    if (!stopped) {
      try { recognition.start(); } catch { /* already started */ }
    }
  };

  function stop() {
    stopped = true;
    try { recognition.stop(); } catch { /* already stopped */ }
  }

  try {
    recognition.start();
    console.log(`[${tag}] listening`);
  } catch {
    console.warn(`[${tag}] failed to start`);
    return null;
  }

  return stop;
}

/**
 * Voice-based approval — listens for accept/reject keywords.
 * Thin wrapper over startKeywordListener.
 */
export function startVoiceApproval(
  onAccept: () => void,
  onReject: () => void,
  lang?: string,
): (() => void) | null {
  const keywords: Record<string, () => void> = {};
  for (const w of ACCEPT_WORDS) keywords[w] = onAccept;
  for (const w of REJECT_WORDS) keywords[w] = onReject;
  return startKeywordListener(keywords, { tag: 'voice-approval', lang });
}
