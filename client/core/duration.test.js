import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endTime, formatDuration, parseDuration } from './duration.js';
import { parseQuickAdd } from './quickadd.js';
import { setLanguage } from './i18n.js';

test('parseDuration leest minuten en uren in het Nederlands en Engels', () => {
  for (const [text, minutes] of [
    ['45', 45], ['45m', 45], ['45 min', 45], ['45 minuten', 45], ['1u', 60], ['1 uur', 60], ['2 uur', 120], ['1,5u', 90], ['1.5 h', 90],
    ['1u30', 90], ['1u 30 min', 90], ['1h30m', 90], ['1 hour 5 minutes', 65], ['0,25u', 15], ['3u', 180], ['168u', 10080], ['10080', 10080],
  ]) assert.equal(parseDuration(text), minutes, text);
});

test('parseDuration weigt onzin, nul en te grote waarden af', () => {
  for (const bad of ['', ' ', 'abc', '0', '0m', '0u', '-5', '1u60', '1u99m', '1,5u30', '169u', '10081', '100000', '1 dag', '45 sec', '1u30x', null, undefined, '4 5']) {
    assert.equal(parseDuration(bad), null, String(bad));
  }
});

test('formatDuration in beide talen', () => {
  setLanguage('nl');
  assert.deepEqual([15, 45, 60, 90, 120, 1440, 2880, 1500].map(formatDuration), ['15 min', '45 min', '1 u', '1 u 30 min', '2 u', '1 d', '2 d', '25 u']);
  setLanguage('en');
  assert.deepEqual([45, 60, 90, 1440].map(formatDuration), ['45 min', '1 h', '1 h 30 min', '1 d']);
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(null), '');
  setLanguage('nl');
});

test('endTime telt bij de begintijd op en geeft niets over middernacht', () => {
  assert.equal(endTime('09:00', 30), '09:30');
  assert.equal(endTime('09:45', 30), '10:15');
  assert.equal(endTime('23:00', 60), null);
  assert.equal(endTime('23:00', 59), '23:59');
  assert.equal(endTime(null, 30), null);
  assert.equal(endTime('9:00', 30), null);
  assert.equal(endTime('09:00', 0), null);
});

const NOW = new Date(2026, 10, 14, 10, 0);
const view = { projects: new Map(), sections: new Map(), labels: new Map() };
const parse = (text) => parseQuickAdd(text, { view, now: NOW, defaultProjectId: 'inbox-project' });

test('snel toevoegen: =45m, =1u30 en =1,5u zetten de duur', () => {
  for (const [text, minutes] of [['Tandarts bellen =45m', 45], ['Tandarts bellen =1u30', 90], ['Tandarts bellen =1,5u', 90], ['=30 Tandarts bellen', 30], ['Tandarts =2uur bellen', 120]]) {
    const p = parse(text);
    assert.equal(p.duration, minutes, text);
    assert.equal(p.content, text.startsWith('Tandarts =2uur') ? 'Tandarts bellen' : 'Tandarts bellen', text);
  }
});

test('snel toevoegen: geen duur als het geen duur is; het veld ontbreekt dan helemaal', () => {
  for (const text of ['Tandarts bellen', 'Sommen 2=2', 'Gelijk =abc', 'Vergelijk a=45m', 'Nul =0m', 'Te lang =999999u']) {
    const p = parse(text);
    assert.equal(Object.hasOwn(p, 'duration'), false, text);
  }
  assert.equal(parse('Sommen 2=2').content, 'Sommen 2=2');
  assert.equal(parse('Gelijk =abc').content, 'Gelijk =abc');
});

test('snel toevoegen: samen met datum, prioriteit en tijd', () => {
  const p = parse('Vergadering morgen 14:00 =1u p2');
  assert.equal(p.duration, 60);
  assert.equal(p.priority, 2);
  assert.equal(p.due.date, '2026-11-15T14:00');
  assert.equal(p.content, 'Vergadering');
});
