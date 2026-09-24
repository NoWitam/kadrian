/**
 * The audio asset: 10 s of a 480 Hz triangle tone, 48 kHz, mono, signed 16-bit
 * PCM in a WAV container. One period is exactly 100 samples, so every sample is
 * an integer computed without floating point.
 */
import { ByteWriter } from './bytes.js';

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_SECONDS = 10;
const PERIOD = 100;
const AMPLITUDE = 8_000;

function sample(index: number): number {
  const phase = index % PERIOD;
  const step = (4 * AMPLITUDE) / PERIOD; // 320 per sample, an integer
  return phase < PERIOD / 2 ? -AMPLITUDE + step * phase : AMPLITUDE - step * (phase - PERIOD / 2);
}

export function generateAudio(): Uint8Array {
  const samples = AUDIO_SAMPLE_RATE * AUDIO_SECONDS;
  const dataBytes = samples * 2;
  const out = new ByteWriter()
    .ascii('RIFF')
    .u32le(36 + dataBytes)
    .ascii('WAVE')
    .ascii('fmt ')
    .u32le(16)
    .u16le(1) // PCM
    .u16le(1) // mono
    .u32le(AUDIO_SAMPLE_RATE)
    .u32le(AUDIO_SAMPLE_RATE * 2) // byte rate
    .u16le(2) // block align
    .u16le(16) // bits per sample
    .ascii('data')
    .u32le(dataBytes);
  for (let index = 0; index < samples; index += 1) out.u16le(sample(index) & 0xffff);
  return out.toBytes();
}
