/**
 * PULSE — 80Hz sine with Hann-shaped breathing, 1 cycle per second.
 *
 * Each breath is a sin²() swell — the same window that makes the tap
 * feel smooth. The amplitude oscillates between 40% and 100% of 0.05
 * (half the original spec). Quiet enough to forget about, present
 * enough that its absence would be noticed.
 *
 * Uses a looping AudioBuffer rather than a live oscillator + LFO.
 * This avoids the mechanical feel of a periodic LFO — the Hann shape
 * gives each breath a natural rise and fall.
 *
 * Hard-stops on call (no fade). The voice beginning IS the resolution.
 */
export interface PulseHandle {
  stop: () => void;
}

export function playPulse(ctx: AudioContext, destination?: AudioNode): PulseHandle {
  const dest = destination ?? ctx.destination;
  const sampleRate = ctx.sampleRate;
  const amp = 0.05;
  const floor = 0.4;
  const swell = 1 - floor;
  const breathCycle = 1.0; // 1 second per breath

  // Pre-render one full breath cycle
  const cycleSamples = Math.ceil(breathCycle * sampleRate);
  const buffer = ctx.createBuffer(1, cycleSamples, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < cycleSamples; i++) {
    const t = i / sampleRate;
    const frac = (t % breathCycle) / breathCycle;
    const breath = amp * floor + amp * swell * Math.sin(Math.PI * frac) ** 2;
    data[i] = breath * Math.sin(2 * Math.PI * 80 * t);
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(dest);
  src.start(ctx.currentTime);

  return {
    stop() {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    },
  };
}
