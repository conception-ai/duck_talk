/**
 * Audio injection for E2E testing (Chrome MCP).
 * Overrides getUserMedia with a fake stream, then injects audio into it.
 *
 * Not imported by production code. Dynamically imported via:
 *   const { setup, inject, listReplays, injectFromDB } = await import('/src/lib/test-inject.ts');
 *
 * Usage:
 *   Step 1 (before clicking Start):
 *     setup();
 *
 *   Step 2 (after connection) — replay from IndexedDB:
 *     const replays = await listReplays();  // see available recordings
 *     await injectFromDB(0);                // inject first recording
 *
 *   Step 2 (after connection) — TTS alternative:
 *     const { speak } = await import('/src/lib/tts.ts');
 *     const key = JSON.parse(localStorage.getItem('claude-talks:ui') || '{}').apiKey;
 *     inject((await speak(key, 'Say naturally: <prompt> OVER')).data, 24000);
 */

const WIN = window as unknown as Record<string, unknown>;
const CTX_KEY = '__testAudioCtx';
const DEST_KEY = '__testAudioDest';

/** Override getUserMedia with a fake silent stream. Idempotent. */
export function setup(): void {
  if (WIN[CTX_KEY]) {
    console.log('[test] already set up');
    return;
  }
  const ctx = new AudioContext({ sampleRate: 24000 });
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 0;
  osc.connect(dest);
  osc.start();

  WIN[CTX_KEY] = ctx;
  WIN[DEST_KEY] = dest;

  navigator.mediaDevices.getUserMedia = async () => {
    console.log('[test] getUserMedia intercepted');
    await ctx.resume();
    return dest.stream;
  };
  console.warn(
    '%c[test] getUserMedia OVERRIDDEN — real mic is disabled. Refresh page to restore.',
    'background:red;color:white;font-weight:bold;padding:2px 8px;border-radius:3px;font-size:14px',
  );
}

/** Push base64 PCM audio into the fake mic stream. */
export function inject(base64pcm: string, sampleRate: number): void {
  const ctx = WIN[CTX_KEY] as AudioContext | undefined;
  const dest = WIN[DEST_KEY] as MediaStreamAudioDestinationNode | undefined;
  if (!ctx || !dest) throw new Error('call setup() first');

  const binary = atob(base64pcm);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.getChannelData(0).set(float32);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(dest);
  source.start();
  console.log(`[test] injected ${float32.length} samples at ${sampleRate}Hz (${(float32.length / sampleRate).toFixed(1)}s)`);
}

/** List available recordings from IndexedDB. */
export async function listReplays(): Promise<{ index: number; transcript: string; chunks: number }[]> {
  const { getAllRecordings } = await import('./recording-db');
  const recordings = await getAllRecordings();
  return recordings.map((r, i) => ({ index: i, transcript: r.transcript, chunks: r.chunks.length }));
}

/** Inject a recorded utterance from IndexedDB into the fake mic stream. */
export async function injectFromDB(index = 0): Promise<string> {
  const { getAllRecordings } = await import('./recording-db');
  const { combineChunks } = await import('./stt');
  const recordings = await getAllRecordings();
  const rec = recordings[index];
  if (!rec) throw new Error(`No recording at index ${index}`);
  inject(combineChunks(rec.chunks), 16000);
  return rec.transcript;
}
