import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizePhone, rememberCaller, takeCaller } from './call-registry.js';

test('form-encoded plus signs are restored', () => {
  // This is what actually arrives: Plivo sends "+17143638910" and the urlencoded
  // body parser correctly turns the "+" into a space.
  assert.equal(normalizePhone(' 17143638910'), '+17143638910');
  assert.equal(normalizePhone('+17143638910'), '+17143638910');
  assert.equal(normalizePhone('17143638910'), '+17143638910');
});

test('non-numeric senders pass through untouched', () => {
  assert.equal(normalizePhone('sip:alice@example.com'), 'sip:alice@example.com');
  assert.equal(normalizePhone('ACME'), 'ACME');
});

test('blank and missing values collapse to empty string', () => {
  assert.equal(normalizePhone(undefined), '');
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('   '), '');
});

test('a remembered caller is returned once and then gone', () => {
  rememberCaller('call-a', { from: ' 17143638910', to: ' 13307489336' });

  const first = takeCaller('call-a');
  assert.equal(first?.from, '+17143638910');
  assert.equal(first?.to, '+13307489336');

  // Taking it twice would mean two bridges believed they owned the same call.
  assert.equal(takeCaller('call-a'), undefined);
});

test('an unknown call id yields undefined rather than throwing', () => {
  // Outbound calls open a stream with no preceding answer webhook.
  assert.equal(takeCaller('never-seen'), undefined);
});
