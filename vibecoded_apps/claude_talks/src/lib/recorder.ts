/**
 * Black-box utterance recorder.
 * Taps getUserMedia to record mic audio without modifying production pipelines.
 * Auto-saves to IndexedDB on 'utterance-committed' CustomEvents.
 *
 * Setup (before clicking Start):
 *   import { setup } from '$lib/recorder';
 *   setup();
 *
 * Console access:
 *   window.__recorder.recordings
 *   window.__recorder.segment('manual label')
 *   window.__recorder.download(0)
 */

import { chunksToWav } from './stt';
import { saveRecording } from './recording-db';

interface Chunk {
  ts: number;
  data: string;
}

export interface Recording {
  transcript: string;
  chunks: Chunk[];
}

export interface RecorderHandle {
  readonly recordings: readonly Recording[];
  segment(transcript?: string): void;
  download(index: number, filename?: string): void;
  clear(): void;
}

const WORKLET = `
class R extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, ch[i] * 32767));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('recorder-proc', R);
`;

const WIN = window as unknown as Record<string, unknown>;

export function setup(): RecorderHandle {
  if (WIN.__recorder) return WIN.__recorder as RecorderHandle;

  let buffer: Chunk[] = [];
  const recordings: Recording[] = [];
  let t0 = Date.now();

  // --- Layer 1: tap getUserMedia ---
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await real(constraints);
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const blob = new Blob([WORKLET], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'recorder-proc');
    src.connect(node);
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(e.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      buffer.push({ ts: Date.now() - t0, data: btoa(bin) });
    };
    t0 = Date.now();
    console.log('[recorder] tapped mic stream');
    return stream;
  };

  // --- Layer 2: auto-segment on production events ---
  window.addEventListener('utterance-committed', ((e: CustomEvent<{ transcript: string }>) => {
    doSegment(e.detail.transcript);
    console.log(`[recorder] saved (${recordings.length} total)`);
  }) as EventListener);

  function doSegment(transcript = '') {
    if (buffer.length === 0) return;
    const chunks = buffer;
    buffer = [];
    recordings.push({ transcript, chunks });
    saveRecording(transcript, chunks);
  }

  const handle: RecorderHandle = {
    get recordings() { return recordings; },
    segment: doSegment,
    download(index: number, filename?: string) {
      const rec = recordings[index];
      if (!rec) throw new Error(`No recording at index ${index}`);
      const wavB64 = chunksToWav(rec.chunks, 16000);
      const bin = atob(wavB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      a.download = filename ?? `utterance-${index}.wav`;
      a.click();
    },
    clear() {
      recordings.length = 0;
      buffer = [];
    },
  };

  WIN.__recorder = handle;
  console.log('[recorder] ready');
  return handle;
}
