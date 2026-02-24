/**
 * Voice-based approval using the browser's native SpeechRecognition API.
 * Activated during BLOCKING approval holds when Gemini is frozen.
 * Listens for accept/reject keywords, triggers callbacks, then stops.
 */

const ACCEPT_WORDS = new Set(['accept', 'yes']);
const REJECT_WORDS = new Set(['reject', 'no']);

// Chrome exposes this under a vendor prefix
const SpeechRecognition =
  (globalThis as Record<string, unknown>).webkitSpeechRecognition as
    typeof globalThis.SpeechRecognition | undefined;

export function startVoiceApproval(
  onAccept: () => void,
  onReject: () => void,
): (() => void) | null {
  if (!SpeechRecognition) {
    console.warn('[voice-approval] SpeechRecognition not available');
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  let stopped = false;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    // Check only the latest result
    const result = event.results[event.results.length - 1];
    if (!result?.isFinal) return;

    const transcript = result[0].transcript.trim().toLowerCase();
    console.log(`[voice-approval] heard: "${transcript}"`);

    const words = transcript.split(/\s+/);
    if (words.some((w) => ACCEPT_WORDS.has(w))) {
      stop();
      onAccept();
    } else if (words.some((w) => REJECT_WORDS.has(w))) {
      stop();
      onReject();
    }
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    if (event.error === 'not-allowed') {
      console.warn('[voice-approval] mic permission denied — stopping');
      stop();
      return;
    }
    // 'no-speech' and 'aborted' are expected during normal operation
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn(`[voice-approval] error: ${event.error}`);
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
    console.log('[voice-approval] listening');
  } catch {
    console.warn('[voice-approval] failed to start');
    return null;
  }

  return stop;
}
