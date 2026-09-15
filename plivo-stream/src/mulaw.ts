/**
 * G.711 mu-law <-> linear PCM16.
 *
 * Port of the Sun Microsystems reference `g711.c`. The encode/decode pair is
 * complementary for 255 of the 256 codes: decoding a code and re-encoding the
 * result returns the original. The exception is 0x7F ("negative zero"), which
 * shares a linear value of 0 with 0xFF and re-encodes to 0xFF. Note also that
 * mu-law stores codes complemented, so 0x00 is the *most negative* sample and
 * 0xFF/0x7F are silence. `mulaw.test.ts` pins both behaviours.
 *
 * Plivo streams `audio/x-mulaw;rate=8000`; LiveKit wants Int16 PCM. This module
 * is the only place that knows about either representation.
 */

const BIAS = 0x84; // 132, the mu-law offset
const CLIP = 8159; // max magnitude in the 14-bit domain the codec works in

/** Upper bound of each mu-law segment, in the 14-bit domain. */
const SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segmentFor(value: number): number {
  for (let i = 0; i < SEG_END.length; i++) {
    if (value <= SEG_END[i]!) return i;
  }
  return SEG_END.length;
}

/** Encode one 16-bit signed sample to a mu-law byte. */
export function encodeSample(pcm: number): number {
  // The codec is defined on 14 bits, so drop the two low bits first.
  let value = pcm >> 2;
  let mask: number;

  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }

  if (value > CLIP) value = CLIP;
  value += BIAS >> 2;

  const segment = segmentFor(value);
  if (segment >= 8) return 0x7f ^ mask;

  return ((segment << 4) | ((value >> (segment + 1)) & 0x0f)) ^ mask;
}

/** Decode one mu-law byte to a 16-bit signed sample. */
export function decodeSample(muLaw: number): number {
  const u = ~muLaw & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) !== 0 ? BIAS - t : t - BIAS;
}

/** Decode a mu-law buffer into PCM16 samples. */
export function decodeBuffer(muLaw: Uint8Array): Int16Array {
  const out = new Int16Array(muLaw.length);
  for (let i = 0; i < muLaw.length; i++) out[i] = decodeSample(muLaw[i]!);
  return out;
}

/** Encode PCM16 samples into a mu-law buffer. */
export function encodeBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]!);
  return out;
}

/**
 * Decode 16-bit little-endian PCM from a Buffer.
 *
 * Used for the `audio/x-l16` content type, and for any caller that has raw
 * bytes rather than an Int16Array. Reads explicitly rather than aliasing the
 * Buffer's memory, because a Buffer from the network is rarely 2-byte aligned
 * and `new Int16Array(buf.buffer, ...)` throws on an odd byteOffset.
 */
export function pcm16FromBuffer(buf: Buffer): Int16Array {
  const samples = buf.length >> 1;
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Encode PCM16 samples to a 16-bit little-endian Buffer. */
export function pcm16ToBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i]!, i * 2);
  return out;
}
