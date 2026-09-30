/**
 * Minimal MPEG audio frame walker used to compute the exact duration of an
 * MP3 buffer. Exact durations matter: each chunk's start offset on the global
 * timeline is the sum of the previous chunks' durations, so captions for the
 * 500th chunk stay in sync with what the browser actually plays.
 */

// Bitrates in kbps, indexed by [versionGroup][layer][bitrateIndex].
// versionGroup: 0 = MPEG-1, 1 = MPEG-2/2.5. layer: 1..3.
const BITRATES: Record<0 | 1, Record<1 | 2 | 3, number[]>> = {
  0: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  1: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};

// Sample rates indexed by version bits (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1).
const SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

interface FrameInfo {
  length: number;
  samples: number;
  sampleRate: number;
}

function parseFrameHeader(data: Uint8Array, i: number): FrameInfo | null {
  const b1 = data[i + 1]!;
  const b2 = data[i + 2]!;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (versionBits === 1 || layerBits === 0) return null; // reserved values
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const isV1 = versionBits === 3;
  const bitrateIndex = b2 >> 4;
  const srIndex = (b2 >> 2) & 0b11;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null;

  const bitrate = BITRATES[isV1 ? 0 : 1][layer][bitrateIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[versionBits]![srIndex]!;
  const padding = (b2 >> 1) & 1;

  let samples: number;
  let length: number;
  if (layer === 1) {
    samples = 384;
    length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  } else {
    samples = layer === 3 && !isV1 ? 576 : 1152;
    length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  }
  return length > 4 ? { length, samples, sampleRate } : null;
}

/** Returns the duration in seconds, or 0 if no MPEG frame was found. */
export function mp3Duration(data: Uint8Array): number {
  let i = 0;
  // Skip an ID3v2 tag if present (size is a 28-bit "syncsafe" integer).
  if (data.length > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const size = ((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) | ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f);
    i = 10 + size;
  }

  let seconds = 0;
  while (i + 4 <= data.length) {
    if (data[i] === 0xff && (data[i + 1]! & 0xe0) === 0xe0) {
      const frame = parseFrameHeader(data, i);
      if (frame) {
        seconds += frame.samples / frame.sampleRate;
        i += frame.length;
        continue;
      }
    }
    i += 1; // resync
  }
  return seconds;
}
