/**
 * Browser audio I/O for Gemini Live API.
 * Mic: 16-bit PCM, 16kHz, mono → base64 chunks.
 * Player: base64 PCM chunks at 24kHz → speakers (gapless scheduling).
 */

// --- Mic Capture ---

const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, ch[i] * 32767));
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

export interface MicHandle {
  stop: () => void;
}

export async function startMic(onChunk: (base64: string) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
  source.connect(worklet);

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    onChunk(uint8ToBase64(new Uint8Array(e.data)));
  };

  return {
    stop() {
      worklet.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

// --- PCM Playback ---

export interface PlayerHandle {
  play: (base64: string) => void;
  flush: () => void;
  stop: () => void;
}

export function createPlayer(): PlayerHandle {
  const ctx = new AudioContext({ sampleRate: 24000 });
  let nextTime = 0;
  let sources: AudioBufferSourceNode[] = [];

  return {
    play(base64: string) {
      const bytes = base64ToUint8(base64);
      const int16 = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2,
      );
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const buffer = ctx.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const start = Math.max(ctx.currentTime + 0.01, nextTime);
      src.start(start);
      nextTime = start + buffer.duration;

      sources.push(src);
      src.onended = () => {
        sources = sources.filter((s) => s !== src);
      };
    },

    flush() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      sources = [];
      nextTime = 0;
    },

    stop() {
      this.flush();
      void ctx.close();
    },
  };
}

// --- One-shot PCM playback (for recorded clips) ---

export function playPcmChunks(
  chunks: string[],
  sampleRate: number,
  onEnded?: () => void,
): { stop: () => void } {
  const allBytes = chunks.map(base64ToUint8);
  const totalLength = allBytes.reduce((sum, b) => sum + b.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of allBytes) {
    combined.set(b, offset);
    offset += b.length;
  }

  const int16 = new Int16Array(combined.buffer, combined.byteOffset, combined.byteLength / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const ctx = new AudioContext({ sampleRate });
  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.getChannelData(0).set(float32);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  let closed = false;
  src.onended = () => {
    if (!closed) { closed = true; void ctx.close(); }
    onEnded?.();
  };

  return {
    stop() {
      try { src.stop(); } catch { /* already stopped */ }
      if (!closed) { closed = true; void ctx.close(); }
    },
  };
}

// --- Base64 helpers ---

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
