// De veegacties (core/swipe.js): de drempel en de richting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swipeAction, swipeThreshold } from './swipe.js';

test('de drempel: een derde van de breedte, hooguit 120 pixels', () => {
  assert.equal(swipeThreshold(300), 100);
  assert.equal(swipeThreshold(390), 120);
  assert.equal(swipeThreshold(1200), 120);
});

test('naar rechts afvinken, naar links een datum; te kort doet niets', () => {
  assert.equal(swipeAction(130, 390), 'complete');
  assert.equal(swipeAction(-130, 390), 'schedule');
  assert.equal(swipeAction(119, 390), null);
  assert.equal(swipeAction(-40, 390), null);
  assert.equal(swipeAction(200, 0), null, 'geen breedte: niets');
});
