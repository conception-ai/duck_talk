/**
 * TAP — Hann-windowed sine at ~690Hz, 3ms signal in 80ms frame.
 *
 * The entire sound is ~1.5 cycles of a sine wave shaped by sin²(πt/dur).
 * The Hann window has zero derivative at both endpoints — the sound
 * appears and dissolves with no perceptible attack or release.
 *
 * Reverse-engineered from the original tap.wav: the spec said 700→400Hz
 * over 80ms, but the actual recording is a gentle 710→670Hz sweep
 * compressed into 3ms. The sweep is barely perceptible — the ear hears
 * a single soft pulse at ~690Hz, not a descending tone.
 */
export function playTap(ctx: AudioContext, destination?: AudioNode): void {
  const dest = destination ?? ctx.destination;
  const sampleRate = ctx.sampleRate;
  const signalDur = 0.003; // 3ms of actual signal
  const frameDur = 0.08; // 80ms total (77ms silence padding)
  const totalSamples = Math.ceil(frameDur * sampleRate);
  const signalSamples = Math.ceil(signalDur * sampleRate);

  const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
  const data = buffer.getChannelData(0);

  let phase = 0;
  for (let i = 0; i < signalSamples; i++) {
    const t = i / sampleRate;
    const frac = t / signalDur;
    const freq = 710 + (670 - 710) * frac;
    const env = 0.22 * Math.sin(Math.PI * frac) ** 2;
    data[i] = env * Math.sin(2 * Math.PI * phase);
    phase += freq / sampleRate;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start(ctx.currentTime);
}
