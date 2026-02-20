/**
 * Audio injection for E2E testing (Chrome MCP).
 * Overrides getUserMedia with a fake stream, then injects TTS audio into it.
 *
 * Not imported by production code. Dynamically imported via:
 *   const { setup, inject } = await import('/src/lib/test-inject.ts');
 *
 * Usage from evaluate_script:
 *   Step 1 (before clicking Start):
 *     const { setup } = await import('/src/lib/test-inject.ts');
 *     setup();
 *
 *   Step 2 (after connection):
 *     const { inject } = await import('/src/lib/test-inject.ts');
 *     const { speak } = await import('/src/lib/tts.ts');
 *     const key = JSON.parse(localStorage.getItem('claude-talks:ui') || '{}').apiKey;
 *     const { data, sampleRate } = await speak(key, 'Say naturally: <prompt> OVER');
 *     inject(data, sampleRate);
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
  console.log('[test] audio injection ready');
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
