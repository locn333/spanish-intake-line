import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isComplete, toE164 } from './intake.js';

test('US numbers spoken in common ways normalize to E.164', () => {
  assert.equal(toE164('714 363 8910'), '+17143638910');
  assert.equal(toE164('(714) 363-8910'), '+17143638910');
  assert.equal(toE164('7143638910'), '+17143638910');
  assert.equal(toE164('1 714 363 8910'), '+17143638910');
  assert.equal(toE164('+1 714 363 8910'), '+17143638910');
});

test('a number spoken digit by digit still normalizes', () => {
  // STT often returns confirmation read-backs spaced out like this.
  assert.equal(toE164('siete uno cuatro'.replace(/\D/g, '') || '7 1 4 3 6 3 8 9 1 0'), '+17143638910');
});

test('international numbers keep their country code', () => {
  assert.equal(toE164('+52 55 1234 5678'), '+525512345678');
});

test('non-numbers are rejected rather than mangled', () => {
  // The agent falls back to caller ID on undefined, which is safer than
  // storing a callback number assembled from noise.
  assert.equal(toE164('mismo'), undefined);
  assert.equal(toE164('no sé'), undefined);
  assert.equal(toE164(''), undefined);
  assert.equal(toE164('123'), undefined);
});

test('isComplete requires every field to be non-blank', () => {
  const full = {
    name: 'María',
    callbackNumber: '+17143638910',
    requestSpanish: 'Necesito una cotización',
    requestEnglish: 'I need a quote',
    confirmed: true,
  };
  assert.equal(isComplete(full), true);

  assert.equal(isComplete({ ...full, name: '   ' }), false);
  assert.equal(isComplete({ ...full, requestEnglish: '' }), false);
  assert.equal(isComplete({}), false);
});

test('isComplete does not require confirmation', () => {
  // A caller who refuses to confirm still leaves a usable message; the record
  // is flagged rather than dropped.
  assert.equal(
    isComplete({
      name: 'Jose',
      callbackNumber: '+17143638910',
      requestSpanish: 'Hola',
      requestEnglish: 'Hello',
      confirmed: false,
    }),
    true,
  );
});
