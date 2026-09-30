import 'server-only';
import { Mp3Encoder } from '@breezystack/lamejs';

/**
 * Incremental PCM (s16le mono) → MP3 encoder.
 *
 * Engines that only output raw PCM (VieNeu-TTS) are re-encoded to the format
 * family Edge produces – 24 kHz mono MPEG-2 Layer III – so the rest of the
 * stack (MSE player, mp3Duration timeline, cache, MP3 download) is shared.
 *
 * Bitrate is 96 kbps, not Edge's 48: lamejs at 48 kbps punches spectral holes
 * into breathy / cloned voices (audible as "watery" noise; 19.6 dB SNR vs the
 * PCM), 96 kbps is transparent for speech (25.8 dB, same as 128 kbps).
 */
export const PCM_SAMPLE_RATE = 24_000;
export const MP3_KBPS = 96;

export class PcmToMp3Stream {
  private readonly encoder = new Mp3Encoder(1, PCM_SAMPLE_RATE, MP3_KBPS);
  /** Odd trailing byte of the previous network chunk (a sample split in two). */
  private carry: number | null = null;

  /** @param gain linear volume multiplier applied to every sample (1 = unchanged). */
  constructor(private readonly gain = 1) {}

  /** Feeds raw s16le bytes; returns whatever MP3 frames are complete (may be empty). */
  push(bytes: Uint8Array): Buffer {
    let offset = 0;
    const total = bytes.length + (this.carry === null ? 0 : 1);
    const samples = new Int16Array(total >> 1);
    let i = 0;
    if (this.carry !== null && bytes.length > 0) {
      samples[i++] = this.scale((bytes[0]! << 8) | this.carry);
      offset = 1;
      this.carry = null;
    }
    for (; offset + 1 < bytes.length; offset += 2) {
      samples[i++] = this.scale((bytes[offset + 1]! << 8) | bytes[offset]!);
    }
    if (offset < bytes.length) this.carry = bytes[offset]!;
    return i > 0 ? Buffer.from(this.encoder.encodeBuffer(samples.subarray(0, i))) : Buffer.alloc(0);
  }

  /** Flushes the encoder's internal buffer (last partial frame). */
  end(): Buffer {
    return Buffer.from(this.encoder.flush());
  }

  /** Unsigned 16-bit word → signed sample with gain, clipped to int16. */
  private scale(word: number): number {
    const sample = word >= 0x8000 ? word - 0x10000 : word;
    if (this.gain === 1) return sample;
    return Math.max(-32768, Math.min(32767, Math.round(sample * this.gain)));
  }
}
