import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUuid } from './random.js';

test('randomUuid: een uuid versie 4, elke keer een ander, ook zonder crypto.randomUUID (http op een ander adres dan localhost)', () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const a = randomUuid();
  assert.match(a, re);
  assert.notEqual(a, randomUuid());
  assert.equal(randomUuid(() => new Uint8Array(16).fill(0xff)), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(randomUuid(() => new Uint8Array(16)), '00000000-0000-4000-8000-000000000000');

  // zoals in een onveilige context: randomUUID ontbreekt, getRandomValues niet
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), 'randomUUID');
  const proto = Object.getOwnPropertyDescriptor(crypto, 'randomUUID') ? crypto : Object.getPrototypeOf(crypto);
  Object.defineProperty(proto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(typeof crypto.randomUUID, 'undefined');
    assert.match(randomUuid(), re);
  } finally {
    Object.defineProperty(proto, 'randomUUID', original);
  }
});
