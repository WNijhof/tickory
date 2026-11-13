// Bewaakt dat de app offline compleet is: elk bestand dat de app laadt, moet in de lijst van de service worker
// staan, en alles in die lijst (en in het manifest) moet door de server geleverd kunnen worden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStatic } from '../../server/main.ts';

const clientDir = fileURLToPath(new URL('../', import.meta.url));
const sharedDir = fileURLToPath(new URL('../../shared/', import.meta.url));
const read = (file) => readFileSync(file, 'utf8');

const sw = read(resolve(clientDir, 'sw.js'));
const shell = [...sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** Het URL-pad waaronder de server een bestand aanbiedt. */
function urlOf(file) {
  const inShared = file.startsWith(resolve(sharedDir) + sep);
  const rel = relative(inShared ? sharedDir : clientDir, file).split(sep).join('/');
  assert.ok(!rel.startsWith('..'), `${file} ligt buiten de app`);
  return inShared ? `/shared/${rel}` : `/${rel}`;
}

/** Alle modules die vanaf het startpunt worden geïmporteerd. */
function moduleGraph(entry) {
  const seen = new Set();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) {
      todo.push(resolve(dirname(file), m[1] ?? m[2]));
    }
  }
  return [...seen];
}

test('de lijst van de service worker bevat alle modules van de app', () => {
  const modules = moduleGraph(resolve(clientDir, 'ui/app.js'));
  assert.ok(modules.length >= 12, `verwacht een flinke modulegraaf, vond ${modules.length}`);
  for (const file of modules) {
    assert.ok(existsSync(file), `geïmporteerd bestand ontbreekt: ${file}`);
    assert.ok(shell.includes(urlOf(file)), `${urlOf(file)} ontbreekt in SHELL van sw.js (zonder werkt de app niet offline)`);
  }
});

test('alles in de lijst kan door de server geleverd worden', () => {
  assert.equal(new Set(shell).size, shell.length, 'dubbele vermelding in SHELL');
  for (const path of shell) {
    const target = resolveStatic(path, clientDir, sharedDir);
    assert.ok(target, `${path} wordt door de server geweigerd`);
    assert.ok(existsSync(target.file), `${path} bestaat niet op schijf`);
  }
});

test('index.html en het manifest verwijzen alleen naar bestaande, bewaarde bestanden', () => {
  const html = read(resolve(clientDir, 'index.html'));
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  const manifest = JSON.parse(read(resolve(clientDir, 'manifest.webmanifest')));
  for (const path of [...refs, ...manifest.icons.map((i) => i.src)]) {
    const target = resolveStatic(path, clientDir, sharedDir);
    assert.ok(target && existsSync(target.file), `${path} bestaat niet of wordt niet geleverd`);
  }
  for (const path of refs) assert.ok(shell.includes(path), `${path} uit index.html ontbreekt in SHELL`);
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'geen inline scripts (de Content-Security-Policy staat ze niet toe)');
  assert.ok(!/\sstyle="/i.test(html), 'geen inline stijlen');
  assert.equal(manifest.start_url, '/');
});
