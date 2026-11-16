// De testgevallen van de Android-app voor de filtertaal (android/app/src/test/resources/filter-vectors.json) horen bij de
// huidige filtertaal van de web-app. Verandert filter.js, dan verandert het bestand: maak het opnieuw met
//   node scripts/filter-vectors.ts
// en laat de Android-tests (FilterLangVectorsTest) zien of FilterLang.kt nog hetzelfde doet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildVectors, VECTORS_PATH } from '../../scripts/filter-vectors.ts';

test('de testgevallen voor de filtertaal op Android zijn bij', () => {
  const saved = readFileSync(VECTORS_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(saved === buildVectors(), 'filter-vectors.json is verouderd: draai node scripts/filter-vectors.ts');
});

test('de testgevallen dekken de belangrijke uitkomsten: taken, lege lijsten, meer lijsten en fouten', () => {
  const data = JSON.parse(buildVectors());
  const results = data.cases.flatMap((c) => c.results);
  assert.ok(data.cases.length > 250);
  assert.ok(results.some((r) => r.ok && r.tasks.length > 3));
  assert.ok(results.some((r) => r.ok && r.tasks.length === 0));
  assert.ok(results.some((r) => r.ok && r.groups.length > 2));
  const codes = new Set(results.filter((r) => !r.ok).map((r) => r.code));
  for (const code of ['empty_query', 'empty_term', 'empty_name', 'unknown_term', 'unclosed_paren', 'unexpected_paren', 'unclosed_quote',
    'expected_operator', 'comma_in_parens', 'unknown_project', 'unknown_section', 'unknown_label', 'unknown_user', 'invalid_date',
    'bad_number', 'too_deep', 'too_long']) {
    assert.ok(codes.has(code), code);
  }
  // een datum in gewone taal is een fout zonder `naturalDates`, en in de web-app gewoon een datum
  const donderdag = data.cases.find((c) => c.query === 'donderdag');
  assert.equal(donderdag.results[0].code, 'unknown_term');
});
