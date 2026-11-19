// De veegacties (core/swipe.js): de drempel en de richting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_DEFAULTS, swipeAction, swipeActionFor, swipeThreshold } from './swipe.js';

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

test('de instelling kiest wat een veeg doet, of niets', () => {
  const prefs = { right: 'delete', left: 'none' };
  assert.equal(swipeAction(130, 390, prefs), 'delete');
  assert.equal(swipeAction(-130, 390, prefs), null, 'naar links doet niets');
  for (const a of ['select', 'reminders', 'complete', 'schedule']) assert.equal(swipeAction(-130, 390, { right: 'none', left: a }), a);
  assert.equal(swipeAction(130, 390, { right: 'onzin', left: 'none' }), null, 'iets onbekends doet niets');
  assert.equal(swipeActionFor(5, { right: 'select', left: 'none' }), 'select');
  assert.equal(swipeActionFor(-5, SWIPE_DEFAULTS), 'schedule');
});
