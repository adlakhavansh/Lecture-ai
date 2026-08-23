/** Pure helpers for voice-activity detection. Extracted so the CPU-sensitive
 *  math is unit-testable without a Web Audio context. */

/** Computes the root-mean-square (loudness) of a byte time-domain waveform,
 *  where 128 is silence. Returns 0 for an empty buffer. */
export function computeRms(buffer: Uint8Array): number {
  if (buffer.length === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const normalized = (buffer[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / buffer.length);
}

/** Decides whether a VAD tick should run the analyser read + RMS pass.
 *  While speech is sustained we skip every other tick to cut CPU. */
export function shouldRunVadAnalysis(speechActive: boolean, tickCounter: number): boolean {
  if (!speechActive) return true;
  return tickCounter % 2 !== 0;
}
