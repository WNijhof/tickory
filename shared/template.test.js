// De controle op de inhoud van een sjabloon (shared/template.js): precies op de grenzen, en wat er wordt geteld.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE_LIMITS, checkTemplateContent, labelNameProblem, templateStats, walkTemplate } from './template.js';

const one = (task) => ({ v: 1, tasks: [task], sections: [] });
const valid = (content) => assert.equal(checkTemplateContent(content), null);
const invalid = (content, pattern) => {
  const problem = checkTemplateContent(content);
  assert.ok(problem, `verwacht een fout voor ${JSON.stringify(content).slice(0, 80)}`);
  if (pattern) assert.match(problem, pattern);
};

test('lengtes: precies op de grens mag, een teken erover niet', () => {
  valid(one({ content: 'a'.repeat(TEMPLATE_LIMITS.title) }));
  invalid(one({ content: 'a'.repeat(TEMPLATE_LIMITS.title + 1) }), /maximaal 4000/);
  valid(one({ content: 'x', description: 'a'.repeat(TEMPLATE_LIMITS.description) }));
  invalid(one({ content: 'x', description: 'a'.repeat(TEMPLATE_LIMITS.description + 1) }), /description/);
  valid({ v: 1, tasks: [{ content: 'x' }], sections: [{ name: 'n'.repeat(TEMPLATE_LIMITS.sectionName), tasks: [] }] });
  invalid({ v: 1, tasks: [{ content: 'x' }], sections: [{ name: 'n'.repeat(TEMPLATE_LIMITS.sectionName + 1), tasks: [] }] });
  valid(one({ content: 'x', labels: ['l'.repeat(TEMPLATE_LIMITS.labelName)] }));
  invalid(one({ content: 'x', labels: ['l'.repeat(TEMPLATE_LIMITS.labelName + 1)] }));
  valid(one({ content: 'x', day: 0, recurrence: { freq: 'daily' }, repeat_text: 'r'.repeat(TEMPLATE_LIMITS.repeatText) }));
  invalid(one({ content: 'x', day: 0, recurrence: { freq: 'daily' }, repeat_text: 'r'.repeat(TEMPLATE_LIMITS.repeatText + 1) }));
});

test('getallen: dag, duur, prioriteit en tijd op hun grenzen', () => {
  for (const day of [TEMPLATE_LIMITS.dayMin, 0, TEMPLATE_LIMITS.dayMax]) valid(one({ content: 'x', day }));
  for (const day of [TEMPLATE_LIMITS.dayMin - 1, TEMPLATE_LIMITS.dayMax + 1, 1.5, '1', null, NaN]) invalid(one({ content: 'x', day }));
  valid(one({ content: 'x', duration: 1 }));
  valid(one({ content: 'x', duration: TEMPLATE_LIMITS.durationMax }));
  for (const duration of [0, -5, TEMPLATE_LIMITS.durationMax + 1, 1.5, '30']) invalid(one({ content: 'x', duration }));
  for (const priority of [1, 2, 3, 4]) valid(one({ content: 'x', priority }));
  for (const priority of [0, 5, 2.5, '2', null]) invalid(one({ content: 'x', priority }));
  for (const time of ['00:00', '09:05', '23:59']) valid(one({ content: 'x', day: 0, time }));
  for (const time of ['24:00', '9:05', '09:60', '09:5', '0905', '', 905]) invalid(one({ content: 'x', day: 0, time }));
});

test('diepte: vier niveaus mag, vijf niet; subtaken tellen mee in de aantallen', () => {
  const chain = (levels) => { let node = { content: `niveau ${levels}` }; for (let i = levels - 1; i >= 1; i--) node = { content: `niveau ${i}`, subtasks: [node] }; return node; };
  valid(one(chain(TEMPLATE_LIMITS.depth)));
  invalid(one(chain(TEMPLATE_LIMITS.depth + 1)), /niveaus diep/);
  const stats = templateStats(one(chain(4)));
  assert.deepEqual([stats.tasks, stats.subtasks, stats.sections], [4, 3, 0]);
});

test('secties: hooguit 100, elke naam één keer (hoofdletterongevoelig, ook met een ontleedde é)', () => {
  const sections = (n) => Array.from({ length: n }, (_, i) => ({ name: `sectie ${i}`, tasks: [{ content: 'x' }] }));
  valid({ v: 1, tasks: [], sections: sections(TEMPLATE_LIMITS.sections) });
  invalid({ v: 1, tasks: [], sections: sections(TEMPLATE_LIMITS.sections + 1) });
  invalid({ v: 1, tasks: [], sections: [{ name: 'Café', tasks: [{ content: 'x' }] }, { name: 'CAFE\u0301', tasks: [{ content: 'y' }] }] }, /al voorkomt/);
});

test('grootte: precies 256 KiB aan JSON mag, één byte meer niet', () => {
  const sizeOf = (c) => new TextEncoder().encode(JSON.stringify(c)).length;
  // 65 taken van 4000 tekens, en een laatste die zo lang is dat de inhoud precies op de grens uitkomt
  const build = (lastLength) => ({ v: 1, tasks: [...Array.from({ length: 65 }, () => ({ content: 'a'.repeat(4000) })), { content: 'a'.repeat(lastLength) }], sections: [] });
  const need = TEMPLATE_LIMITS.bytes - sizeOf(build(0));
  assert.ok(need > 0 && need <= 4000, `de test rekent op ${need} tekens in de laatste taak`);
  assert.equal(sizeOf(build(need)), TEMPLATE_LIMITS.bytes);
  valid(build(need));
  valid(build(need - 1));
  invalid(build(need + 1), /te groot/);
});

test('grootte: tekens van meerdere bytes tellen als bytes', () => {
  // 40 taken van 4000 keer 'é' zijn maar 160.000 tekens, maar 320 KB
  const wide = { v: 1, tasks: Array.from({ length: 40 }, () => ({ content: 'é'.repeat(4000) })), sections: [] };
  assert.ok(wide.tasks.length * 4000 < TEMPLATE_LIMITS.bytes);
  invalid(wide, /te groot/);
  valid({ v: 1, tasks: Array.from({ length: 30 }, () => ({ content: 'é'.repeat(4000) })), sections: [] });
});

test('labelnamen: dezelfde regels als voor een label op de server', () => {
  assert.equal(labelNameProblem('inpakken'), null);
  assert.equal(labelNameProblem('Café met melk'), null);
  for (const bad of ['', ' ', 'a,b', ' a', 'a ', 'a\tb\n', 'a\u0000', 5, null]) assert.ok(labelNameProblem(bad), JSON.stringify(bad));
});

test('tekens: stuurtekens en losse halve tekens worden geweigerd, regeleinden in de beschrijving niet', () => {
  invalid(one({ content: 'a\u0000b' }));
  invalid(one({ content: 'a\nb' }));
  invalid(one({ content: 'a\u007fb' }));
  invalid(one({ content: 'half\ud83d' }));
  valid(one({ content: 'x', description: 'regel 1\nregel 2\r\n\tingesprongen' }));
  invalid(one({ content: 'x', description: 'a\u0000' }));
  valid(one({ content: 'emoji \u{1F600} en é en 日本語' }));
});

test('verkeerde vormen: een taak of sectie die geen object is, geeft een fout en geen uitzondering', () => {
  for (const bad of [null, 'x', 5, [], true]) {
    invalid({ v: 1, tasks: [bad], sections: [] }, /moet een object zijn/);
    invalid({ v: 1, tasks: [{ content: 'x' }], sections: [bad] }, /moet een object zijn/);
    invalid({ v: 1, tasks: [{ content: 'x', subtasks: [bad] }], sections: [] }, /moet een object zijn/);
  }
  for (const bad of [null, 'x', 5, [], true]) invalid(bad, /moet een object zijn/);
});

test('prototype-vervuiling: __proto__ en constructor als sleutel zijn onbekende velden', () => {
  invalid(JSON.parse('{"v":1,"tasks":[{"content":"x","__proto__":{"a":1}}],"sections":[]}'));
  invalid(JSON.parse('{"v":1,"tasks":[{"content":"x"}],"sections":[],"constructor":{}}'));
  invalid(JSON.parse('{"v":1,"tasks":[{"content":"x","constructor":"y"}],"sections":[]}'));
});

test('templateStats en walkTemplate: tellen, volgorde (eerst zonder sectie, dan per sectie) en bereik van de dagen', () => {
  const content = {
    v: 1,
    tasks: [{ content: 'a', day: 2 }],
    sections: [
      { name: 's1', tasks: [{ content: 'b', day: -3, time: '09:00', labels: ['x', 'y'], subtasks: [{ content: 'c', recurrence: undefined }] }, { content: 'd', day: 0, recurrence: { freq: 'daily' } }] },
      { name: 's2', tasks: [{ content: 'e', labels: ['Y', 'z'] }] },
    ],
  };
  delete content.sections[0].tasks[0].subtasks[0].recurrence;
  valid(content);
  assert.deepEqual([...walkTemplate(content)].map((x) => `${x.section?.name ?? '-'}:${x.depth}:${x.task.content}`), ['-:1:a', 's1:1:b', 's1:2:c', 's1:1:d', 's2:1:e']);
  assert.deepEqual(templateStats(content), { tasks: 5, sections: 2, subtasks: 1, dated: 3, recurring: 1, timed: 1, labels: ['x', 'y', 'z'], minDay: -3, maxDay: 2 });
  assert.deepEqual(templateStats({ v: 1, tasks: [{ content: 'a' }], sections: [] }).minDay, null);
});
