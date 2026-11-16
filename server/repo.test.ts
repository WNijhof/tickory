// Samenhang in de repo die anders pas bij een release opvalt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = (path: string) => new URL(`../${path}`, import.meta.url);

test('de Android-workflow controleert de Gradle-wrapper met de controlesom van de wrapper die in de repo staat', () => {
  // De workflow (alleen bij een versie-tag) weigert een andere gradle-wrapper.jar. Werkt iemand de wrapper bij (Dependabot), dan
  // moet de controlesom in .github/workflows/android.yml mee; anders mislukt pas de release.
  const workflow = readFileSync(file('.github/workflows/android.yml'), 'utf8');
  const m = /echo "([0-9a-f]{64}) {2}gradle\/wrapper\/gradle-wrapper\.jar" \| sha256sum --check/.exec(workflow);
  assert.ok(m, 'de controle staat in de workflow');
  const actual = createHash('sha256').update(readFileSync(file('android/gradle/wrapper/gradle-wrapper.jar'))).digest('hex');
  assert.equal(m![1], actual, 'de controlesom in android.yml hoort bij android/gradle/wrapper/gradle-wrapper.jar');
});

test('de versie in package.json is een gewone versie (de tag v<versie> en de APK volgen hem)', () => {
  const { version } = JSON.parse(readFileSync(file('package.json'), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
