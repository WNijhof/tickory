// De tijdnotatie (Instellingen › Algemeen): 24 of 12 uur, overal waar de app een tijd toont (core/format.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockText, formatDue, setClockFormat, timeFormatOptions } from './format.js';

test('24 uur is de standaard; 12 uur geeft de tijd met a.m./p.m. in de taal van de app', () => {
  try {
    assert.equal(clockText('14:05'), '14:05');
    assert.equal(formatDue({ date: '2026-11-17T09:30' }, '2026-11-16'), 'morgen 09:30');
    setClockFormat('12h');
    assert.match(clockText('14:05'), /^2:05\s?p\.?\s?m\.?$/i);
    assert.match(clockText('00:15'), /^12:15\s?a\.?\s?m\.?$/i);
    assert.match(formatDue({ date: '2026-11-17T09:30' }, '2026-11-16'), /^morgen 9:30\s?a\.?\s?m\.?$/i);
    assert.equal(timeFormatOptions().hour12, true);
    assert.equal(clockText('geen tijd'), 'geen tijd');
  } finally {
    setClockFormat('24h');
  }
  assert.equal(clockText('14:05'), '14:05');
  assert.equal(timeFormatOptions().hour12, false);
});
