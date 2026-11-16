// De versiegeschiedenis zonder scherm: per dag groeperen en regel voor regel vergelijken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DIFF_LINES, groupRevisionsByDay, historyDayLabel, lineDiff, revisionCauseLabel } from './noteHistory.js';
import { setLanguage } from './i18n.js';

test('per dag: Vandaag, Gisteren, en daarna de datum voluit', () => {
  setLanguage('nl');
  const now = new Date(2026, 10, 16, 15, 0);
  const at = (d, h) => new Date(2026, 10, d, h, 5).toISOString();
  const days = groupRevisionsByDay([{ id: 'a', saved_at: at(16, 14) }, { id: 'b', saved_at: at(16, 9) }, { id: 'c', saved_at: at(15, 20) }, { id: 'd', created_at: at(3, 8) }], now);
  assert.deepEqual(days.map((d) => [d.label, d.entries.map((e) => e.id).join('')]), [['Vandaag', 'ab'], ['Gisteren', 'c'], ['3 november 2026', 'd']]);
  assert.equal(historyDayLabel(new Date(2025, 0, 2), now), '2 januari 2025');
  setLanguage('en');
  assert.equal(historyDayLabel(new Date(2026, 10, 16, 1), now), 'Today');
  setLanguage('nl');
  assert.equal(revisionCauseLabel('restore'), 'Vóór terugzetten');
  assert.equal(revisionCauseLabel('edit'), 'Eerdere versie');
});

test('regel voor regel: toegevoegd, verwijderd en gewijzigd (een vervangen regel)', () => {
  const d = lineDiff('melk\nbrood\nkaas\neieren', 'melk\nvolkoren brood\nkaas\nappels\neieren\nkoffie');
  assert.deepEqual(d.lines.map((l) => `${{ same: ' ', add: '+', del: '-' }[l.kind]}${l.text}`), [' melk', '-brood', '+volkoren brood', ' kaas', '+appels', ' eieren', '+koffie']);
  assert.deepEqual([d.added, d.removed, d.changed], [2, 0, 1]);
  const gone = lineDiff('a\nb\nc', 'a');
  assert.deepEqual([gone.added, gone.removed, gone.changed], [0, 2, 0]);
  const same = lineDiff('x\ny', 'x\ny');
  assert.deepEqual([same.added, same.removed, same.changed, same.lines.length], [0, 0, 0, 2]);
  assert.deepEqual(lineDiff('', 'nieuw').lines.map((l) => l.kind), ['del', 'add'], 'een lege tekst is één lege regel');
  assert.equal(lineDiff('', 'nieuw').changed, 1);
});

test('heel lange teksten vergelijken we niet (te duur); gewone lengte gaat snel', () => {
  const big = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `regel ${i}`).join('\n');
  assert.equal(lineDiff(big, `${big}\nnog een`).tooLarge, true);
  const mid = Array.from({ length: 1500 }, (_, i) => `regel ${i}`);
  const changed = mid.map((l, i) => (i % 7 === 0 ? `${l} (aangepast)` : l));
  const t0 = performance.now();
  const d = lineDiff(mid.join('\n'), changed.join('\n'));
  assert.ok(performance.now() - t0 < 1500, 'binnen anderhalve seconde');
  assert.equal(d.changed, Math.ceil(1500 / 7));
});
