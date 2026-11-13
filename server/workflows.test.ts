// De werkstromen van GitHub (.github/): vastgezette acties, geen onnodige rechten, geen debug-APK in een Release, Dependabot.
// Er is geen YAML-lezer in Node; dit zijn controles op de tekst, genoeg om te zien dat een regel niet stilletjes verdwijnt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../.github/', import.meta.url));
const workflows = readdirSync(join(dir, 'workflows')).filter((f) => f.endsWith('.yml')).map((f) => ({ name: f, text: readFileSync(join(dir, 'workflows', f), 'utf8') }));
/** De tekst zonder commentaarregels (daar staan de uitleg en dus ook de woorden die we niet in de code willen). */
const withoutComments = (text: string): string => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const get = (name: string): string => withoutComments(workflows.find((w) => w.name === name)!.text);

test('er zijn werkstromen, en elke actie van derden staat vast op een commit (met de versie als commentaar)', () => {
  assert.ok(workflows.length >= 4);
  for (const w of workflows) {
    const uses = [...w.text.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0 || w.name === 'x', w.name);
    for (const [, action, rest] of uses) {
      assert.match(action, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${w.name}: ${action} staat niet op een commit`);
      assert.match(rest, /#\s*v\d/, `${w.name}: ${action} mist de versie als commentaar`);
    }
  }
});

test('de checkout laat het token niet in de werkmap staan', () => {
  for (const w of workflows) {
    const lines = w.text.split('\n');
    lines.forEach((line, i) => {
      if (/uses:\s*actions\/checkout@/.test(line)) assert.match(lines.slice(i + 1, i + 4).join('\n'), /persist-credentials:\s*false/, `${w.name} regel ${i + 1}`);
    });
  }
});

test('schrijfrechten staan alleen bij de stap die ze nodig heeft: de release-job van de Android-workflow en het publiceren van de image en de site', () => {
  for (const w of workflows) assert.match(w.text, /^permissions:\n\s+contents: read/m, `${w.name}: de standaardrechten zijn alleen lezen`);
  const android = get('android.yml');
  const release = android.slice(android.indexOf('\n  release:'));
  assert.ok(release.includes('contents: write'), 'de release-job schrijft');
  assert.equal(android.slice(0, android.indexOf('\n  release:')).includes('write'), false, 'de bouwjob heeft geen schrijfrechten');
  assert.doesNotMatch(release, /actions\/checkout/, 'de release-job draait geen code uit de repo');
  for (const name of ['ci.yml', 'pages.yml']) assert.doesNotMatch(get(name), /contents:\s*write/, name);
  assert.doesNotMatch(get('image.yml'), /contents:\s*write/);
});

test('een release krijgt nooit een debug-APK: zonder sleutel mislukt de bouw bij een tag, en alleen een getekende bouw wordt gepubliceerd', () => {
  const android = get('android.yml');
  const signing = android.slice(android.indexOf('id: signing'), android.indexOf('APK bouwen, getekend'));
  assert.match(signing, /elif \[ "\$IS_TAG" = "true" \]; then[\s\S]*?exit 1/);
  assert.match(android, /if: startsWith\(github\.ref, 'refs\/tags\/v'\) && needs\.apk\.outputs\.signed == 'true'/);
  const publish = android.slice(android.indexOf('gh release'));
  assert.doesNotMatch(publish, /debug/i);
});

test('geen onveilige invoer in de werkstromen: niet pull_request_target, en niets van de aanvrager in een commando', () => {
  for (const w of workflows) {
    assert.doesNotMatch(w.text, /pull_request_target/, w.name);
    assert.doesNotMatch(w.text, /\$\{\{\s*github\.(head_ref|event\.)/, `${w.name}: tekst van een aanvrager in een expressie`);
    // geheimen en refs gaan via env, niet rechtstreeks in een run-regel
    for (const line of w.text.split('\n')) {
      if (/^\s*run:/.test(line) || /^\s{10,}(?!#)[^:]*\$\{\{\s*(secrets|github\.ref_name)/.test(line)) {
        assert.doesNotMatch(line, /\$\{\{\s*(secrets\.|github\.ref_name)/, `${w.name}: ${line.trim()}`);
      }
    }
  }
});

test('Dependabot houdt acties, Gradle, Docker en npm bij', () => {
  const text = readFileSync(join(dir, 'dependabot.yml'), 'utf8');
  for (const ecosystem of ['github-actions', 'gradle', 'docker', 'npm']) assert.match(text, new RegExp(`package-ecosystem:\\s*${ecosystem}\\b`), ecosystem);
  assert.match(text, /directory:\s*\/android/);
});
