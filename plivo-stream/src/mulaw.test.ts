import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeBuffer,
  decodeSample,
  encodeBuffer,
  encodeSample,
  pcm16FromBuffer,
  pcm16ToBuffer,
} from './mulaw.js';

/**
 * G.711 mu-law has two codes for zero: 0xFF (+0) and 0x7F (-0). Both decode to
 * linear 0, and linear 0 encodes back to 0xFF, so 0x7F is the one code that
 * cannot survive a round trip. Every other code must.
 */
const NEGATIVE_ZERO = 0x7f;

test('mu-law codes survive a decode/encode round trip', () => {
  for (let code = 0; code < 256; code++) {
    if (code === NEGATIVE_ZERO) continue;
    const linear = decodeSample(code);
    assert.equal(
      encodeSample(linear),
      code,
      `code ${code} decoded to ${linear} and re-encoded to ${encodeSample(linear)}`,
    );
  }
});

test('negative zero is the only code that collapses, and it collapses to +0', () => {
  assert.equal(decodeSample(NEGATIVE_ZERO), 0);
  assert.equal(decodeSample(0xff), 0);
  assert.equal(encodeSample(0), 0xff);
});

test('decoded samples stay inside the int16 range', () => {
  for (let code = 0; code < 256; code++) {
    const linear = decodeSample(code);
    assert.ok(linear >= -32768 && linear <= 32767, `code ${code} decoded to ${linear}`);
  }
});

test('the sign bit is inverted, as G.711 specifies', () => {
  // mu-law stores codes complemented, so the extremes are the opposite of what
  // a naive reading suggests: 0x00 is the most negative sample, not the most
  // positive, and 0xFF/0x7F are digital silence.
  assert.ok(decodeSample(0x00) < -32000, 'code 0x00 should be the most negative sample');
  assert.ok(decodeSample(0x80) > 32000, 'code 0x80 should be the most positive sample');
  assert.equal(decodeSample(0xff), 0);
  assert.equal(decodeSample(0x7f), 0);
});

test('encoding a PCM sweep stays within mu-law quantization error', () => {
  // mu-law is logarithmic: error grows with amplitude, so compare relatively
  // once past the near-silence floor.
  for (let pcm = -32000; pcm <= 32000; pcm += 137) {
    const round = decodeSample(encodeSample(pcm));
    const error = Math.abs(round - pcm);
    const tolerance = Math.max(64, Math.abs(pcm) * 0.09);
    assert.ok(error <= tolerance, `pcm ${pcm} round-tripped to ${round} (error ${error})`);
  }
});

test('buffer helpers round-trip through mu-law', () => {
  const original = new Int16Array([0, 1000, -1000, 20000, -20000, 32767, -32768]);
  const encoded = encodeBuffer(original);
  assert.equal(encoded.length, original.length, 'one mu-law byte per sample');

  const decoded = decodeBuffer(encoded);
  assert.equal(decoded.length, original.length);
  // Re-encoding the decoded signal must be stable (idempotent after one pass).
  assert.deepEqual(Array.from(encodeBuffer(decoded)), Array.from(encoded));
});

test('pcm16 buffer helpers round-trip, including at an odd byte offset', () => {
  const samples = new Int16Array([0, -1, 1, 12345, -12345, 32767, -32768]);
  const buf = pcm16ToBuffer(samples);
  assert.deepEqual(Array.from(pcm16FromBuffer(buf)), Array.from(samples));

  // A Buffer sliced out of a larger network buffer is often misaligned; the
  // helper must read it byte-wise rather than aliasing the ArrayBuffer.
  const padded = Buffer.concat([Buffer.from([0xaa]), buf]);
  const misaligned = padded.subarray(1);
  assert.equal(misaligned.byteOffset % 2, 1, 'test needs an odd byteOffset to be meaningful');
  assert.deepEqual(Array.from(pcm16FromBuffer(misaligned)), Array.from(samples));
});

test('odd-length pcm buffers drop the trailing half sample instead of throwing', () => {
  const buf = Buffer.from([0x01, 0x02, 0x03]);
  assert.equal(pcm16FromBuffer(buf).length, 1);
});
