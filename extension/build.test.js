// De gebouwde extensie (scripts/build-extension.ts): het manifest voor Chrome/Edge en Firefox (verplichte velden, alleen de rechten
// die de code gebruikt, geen toegang tot alle websites), de teksten in beide talen, geen inline scripts of verzoeken naar elders,
// de snelle invoer uit de web-app, en de zelfgeschreven zip (teruggelezen met een eigen lezer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { FIREFOX_DATA, GECKO_ID, ICON_SIZES, build, bundle, importsOf, manifests, quickAddFiles, sourceFiles, version, zip } from '../scripts/build-extension.ts';
import { ERROR_KEYS } from './core/errors.js';

const base = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { chrome, firefox } = manifests(base, pkg.version);
const files = bundle(chrome);
const text = (name) => files.get(name).toString('utf8');
const own = [...files.keys()].filter((n) => !n.startsWith('lib/'));
const ownJs = own.filter((n) => n.endsWith('.js'));
const html = own.filter((n) => n.endsWith('.html'));
const locales = { nl: JSON.parse(text('_locales/nl/messages.json')), en: JSON.parse(text('_locales/en/messages.json')) };

/** Leest een zip zonder de schrijver te gebruiken: de eindrecord, de centrale map en per bestand de lokale kop. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'eindrecord');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  assert.equal(p + buf.readUInt32LE(end + 12), end, 'de centrale map loopt tot de eindrecord');
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `lokale kop van ${name}`);
    assert.equal(buf.subarray(offset + 30, offset + 30 + buf.readUInt16LE(offset + 26)).toString('utf8'), name);
    assert.equal(buf.readUInt32LE(offset + 14), crc);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.ok(method === 0 || method === 8, 'opgeslagen of deflate');
    assert.equal(data.length, size, name);
    assert.equal(crc32(data), crc, name);
    out.push({ name, data, flags, method, mode });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const pngSize = (buf) => (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);

test('het manifest voor Chrome en Edge: Manifest V3 met de verplichte velden, en alles waar het naar wijst bestaat', () => {
  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.version, pkg.version);
  assert.match(chrome.version, /^\d+(\.\d+){0,3}$/);
  assert.equal(version(), pkg.version);
  assert.equal(chrome.default_locale, 'nl', 'Nederlands is de standaard');
  for (const key of ['name', 'description']) assert.match(chrome[key], /^__MSG_\w+__$/, key);
  assert.ok(chrome.name.length <= 75 && chrome.short_name.length <= 12);
  assert.deepEqual(Object.keys(chrome.icons).map(Number), ICON_SIZES);
  for (const [size, path] of Object.entries(chrome.icons)) assert.deepEqual(pngSize(files.get(path)), [Number(size), Number(size)], path);
  for (const path of Object.values(chrome.action.default_icon)) assert.ok(files.has(path), path);
  assert.ok(files.has(chrome.action.default_popup));
  assert.ok(files.has(chrome.options_ui.page));
  assert.ok(files.has(chrome.background.service_worker));
  assert.equal(chrome.background.type, undefined, 'een gewoon script: werkt als service worker en als achtergrondscript van Firefox');
  assert.match(chrome.commands._execute_action.suggested_key.default, /^(Alt|Ctrl)\+Shift\+[A-Z]$/);
  assert.match(chrome.commands._execute_action.description, /^__MSG_\w+__$/);
});

test('alleen de rechten die de code gebruikt; geen toegang tot alle websites, de server pas bij het verbinden', () => {
  for (const m of [chrome, firefox]) {
    assert.deepEqual([...m.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
    assert.equal(m.host_permissions, undefined, 'geen vaste toegang tot een host');
    assert.deepEqual(m.optional_host_permissions, ['https://*/*', 'http://*/*'], 'pas bij het verbinden, voor één host');
    assert.ok(!JSON.stringify(m).includes('<all_urls>'));
    assert.equal(m.content_scripts, undefined, 'geen scripts in elke pagina');
    assert.equal(m.web_accessible_resources, undefined, 'geen bestanden die websites kunnen laden');
    assert.equal(m.externally_connectable, undefined);
  }
  const code = ownJs.map(text).join('\n');
  // gebruikt: elk recht heeft een aanroep die het nodig heeft
  assert.match(code, /contextMenus\.create\(/);
  assert.match(code, /scripting\.executeScript\(/);
  assert.match(code, /storage\.local\.(get|set)\(/);
  assert.match(code, /tabs\.query\(\{ active: true, currentWindow: true \}\)/, 'activeTab: titel en adres van het tabblad waar je de extensie opent');
  // en geen API die een recht vraagt dat er niet staat
  const apis = new Set([...code.matchAll(/\bext\.(\w+)\./g)].map((m) => m[1]));
  const free = ['runtime', 'i18n', 'tabs', 'action', 'windows', 'permissions', 'commands'];
  for (const api of apis) assert.ok(free.includes(api) || chrome.permissions.includes(api), `${api} vraagt een recht dat niet in het manifest staat`);
  assert.doesNotMatch(code, /\bext\.(?:history|cookies|webRequest|bookmarks|downloads|management)\b|\btabs\.(?:executeScript|captureVisibleTab)/);
});

test('een strenge CSP en geen code van buiten: geen inline scripts, geen eval, geen HTML uit tekst', () => {
  const csp = chrome.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe|https?:|\*/);
  for (const name of html) {
    const page = text(name);
    for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1], /\bsrc="[\w./-]+\.js"/, `${name}: een script uit een eigen bestand`);
      assert.equal(m[2].trim(), '', `${name}: geen inline script`);
    }
    assert.doesNotMatch(page, /\son\w+\s*=/i, `${name}: geen inline event-handlers`);
    assert.doesNotMatch(page, /\b(?:src|href)="(?:https?:)?\/\//i, `${name}: niets van buiten`);
    for (const m of page.matchAll(/\b(?:src|href)="([^"]+)"/g)) assert.ok(files.has(m[1]), `${name}: ${m[1]} bestaat`);
  }
  for (const name of [...ownJs, ...[...files.keys()].filter((n) => n.startsWith('lib/'))]) {
    const code = text(name);
    assert.doesNotMatch(code, /\beval\(|new Function\(|\.innerHTML\b|outerHTML\s*=|insertAdjacentHTML|document\.write/, name);
    assert.doesNotMatch(code, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/, name);
    if (name !== 'core/api.js') assert.doesNotMatch(code, /\bfetch\(/, `${name}: alleen core/api.js doet verzoeken`);
    for (const m of code.matchAll(/\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.?\//, `${name}: alleen eigen modules`);
  }
  assert.match(text('core/api.js'), /fetchFn\(`\$\{origin\}\$\{path\}`/, 'alleen naar het eigen adres');
});

test('het manifest voor Firefox: een achtergrondscript, een neutrale id en de opgave van wat er verstuurd wordt', () => {
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, ['background.js']);
  assert.equal(firefox.minimum_chrome_version, undefined);
  const gecko = firefox.browser_specific_settings.gecko;
  assert.equal(gecko.id, GECKO_ID);
  assert.match(gecko.id, /^[a-z0-9-]+@[a-z0-9-]+\.invalid$/, 'een id zonder naam van een persoon, op een domein dat nooit bestaat');
  assert.ok(Number.parseFloat(gecko.strict_min_version) >= 128, 'optional_host_permissions in Manifest V3');
  assert.deepEqual(gecko.data_collection_permissions.required, FIREFOX_DATA);
  const known = ['authenticationInfo', 'bookmarksInfo', 'browsingActivity', 'financialAndPaymentInfo', 'healthInfo', 'locationInfo', 'personalCommunications', 'personallyIdentifyingInfo', 'searchTerms', 'websiteActivity', 'websiteContent'];
  for (const d of gecko.data_collection_permissions.required) assert.ok(known.includes(d), d);
  const { background: _b, browser_specific_settings: _s, minimum_chrome_version: _m, ...restChrome } = chrome;
  const { background: _b2, browser_specific_settings: _s2, ...restFirefox } = firefox;
  assert.deepEqual(restFirefox, restChrome, 'verder hetzelfde manifest');
});

test('de teksten: dezelfde sleutels en plaatshouders in het Nederlands en het Engels, alle gebruikt, en alles wat gebruikt wordt bestaat', () => {
  assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.nl).sort());
  for (const [key, entry] of Object.entries(locales.nl)) {
    assert.match(key, /^[A-Za-z0-9_]+$/);
    const other = locales.en[key];
    assert.ok(entry.message && other.message, key);
    assert.deepEqual(Object.keys(other.placeholders ?? {}), Object.keys(entry.placeholders ?? {}), `${key}: plaatshouders`);
    for (const e of [entry, other]) {
      const named = [...e.message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase());
      assert.deepEqual([...new Set(named)].sort(), Object.keys(e.placeholders ?? {}).sort(), `${key}: elke plaatshouder staat in de tekst`);
    }
  }
  assert.equal(locales.nl.lang.message, 'nl');
  assert.equal(locales.en.lang.message, 'en');
  const sources = [...ownJs, ...html].map(text).join('\n') + JSON.stringify(chrome);
  const used = new Set([
    ...[...sources.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
    ...[...sources.matchAll(/data-i18n(?:-[a-z-]+)?="(\w+)"/g)].map((m) => m[1]),
    ...[...sources.matchAll(/\bmsg\('(\w+)'/g)].map((m) => m[1]),
    ...[...sources.matchAll(/getMessage\('(\w+)'/g)].map((m) => m[1]),
    ...ERROR_KEYS,
  ]);
  for (const key of used) assert.ok(locales.nl[key], `gebruikt maar niet vertaald: ${key}`);
  // een sleutel die alleen als tekst in een keuze voorkomt (msg(x ? 'a' : 'b')) telt ook als gebruikt
  const literals = new Set([...sources.matchAll(/'(\w+)'/g)].map((m) => m[1]));
  const unused = Object.keys(locales.nl).filter((k) => !used.has(k) && !literals.has(k));
  assert.deepEqual(unused, [], 'ongebruikte teksten');
});

test('de snelle invoer komt ongewijzigd uit de web-app, met alles wat ze importeert, en niets anders', () => {
  const lib = quickAddFiles();
  assert.ok(lib.has('client/core/quickadd.js'));
  assert.ok(lib.has('client/vendor/nlDatum.generated.js'), 'de datumherkenner');
  for (const [path, data] of lib) {
    assert.ok(files.get(`lib/${path}`).equals(data), `${path} ongewijzigd`);
    assert.equal(data.equals(readFileSync(new URL(`../${path}`, import.meta.url))), true);
    for (const spec of importsOf(data.toString('utf8'))) {
      const target = new URL(spec, new URL(`../${path}`, import.meta.url)).pathname.split('/tickory-ext/').pop() ?? '';
      assert.ok([...lib.keys()].some((k) => target.endsWith(k)), `${path} importeert ${spec}, en dat gaat mee`);
    }
  }
  assert.ok(![...lib.keys()].some((k) => k.startsWith('server/') || k.includes('ui/')), 'geen server of interface');
  assert.deepEqual(importsOf("import a from './a.js';\nimport { b } from \"../b.js\";\nexport { c } from './c.js';\nimport './d.js';\nconst x = 'import y from \"z\"';"), ['./a.js', '../b.js', './c.js', './d.js']);
  // een import van een pakket of van buiten client/ en shared/ laat de bouw mislukken
  const root = mkdtempSync(join(tmpdir(), 'tickory-ext-'));
  try {
    mkdirSync(join(root, 'client/core'), { recursive: true });
    writeFileSync(join(root, 'client/core/quickadd.js'), "import x from 'chrono-node';\n");
    assert.throws(() => quickAddFiles(root), /pakket/);
    writeFileSync(join(root, 'client/core/quickadd.js'), "import x from '../../server/sync.ts';\n");
    assert.throws(() => quickAddFiles(root), /buiten client\/ en shared\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in het pakket: geen tests, de licenties wel, en de eigen bestanden uit extension/', () => {
  assert.ok(![...files.keys()].some((n) => /\.test\.|README/.test(n)));
  assert.ok(files.has('LICENSE') && files.has('THIRD_PARTY_NOTICES.md'));
  assert.ok(text('THIRD_PARTY_NOTICES.md').includes('chrono-node'));
  for (const name of sourceFiles().keys()) assert.ok(files.has(name), name);
  for (const name of ['popup.html', 'popup.js', 'options.html', 'options.js', 'background.js', 'ui.css', 'core/model.js', '_locales/nl/messages.json']) assert.ok(files.has(name), name);
});

test('de zip: met een eigen lezer terug te lezen, dezelfde bestanden, vaste volgorde en tijd (dezelfde bron = dezelfde zip)', () => {
  const buf = zip(files);
  const entries = readZip(buf);
  assert.deepEqual(entries.map((e) => e.name), [...files.keys()].sort());
  for (const e of entries) {
    assert.ok(e.data.equals(files.get(e.name)), e.name);
    assert.equal(e.flags & 0x0800, 0x0800, 'namen in UTF-8');
    assert.equal(e.mode, 0o100644);
  }
  assert.ok(entries.some((e) => e.method === 8) && entries.some((e) => e.name.endsWith('.png')));
  assert.ok(zip(bundle(chrome)).equals(buf), 'reproduceerbaar');
  // klein geval: een leeg bestand en een naam met een accent
  const small = readZip(zip(new Map([['é.txt', Buffer.from('café')], ['leeg', Buffer.alloc(0)]])));
  assert.deepEqual(small.map((e) => [e.name, e.data.toString()]), [['leeg', ''], ['é.txt', 'café']]);
  assert.equal(small[0].method, 0, 'wat niet kleiner wordt, gaat ongecomprimeerd');
});

test('bouwen: twee uitgepakte mappen en twee zips met de versie in de naam; de testvariant alleen als erom gevraagd wordt', () => {
  const out = mkdtempSync(join(tmpdir(), 'tickory-dist-'));
  try {
    const r = build(out);
    assert.deepEqual(readdirSync(out).sort(), ['extension', `tickory-extension-${pkg.version}-firefox.zip`, `tickory-extension-${pkg.version}.zip`]);
    assert.equal(r.testDir, null);
    assert.equal(JSON.parse(readFileSync(join(r.chromeDir, 'manifest.json'), 'utf8')).host_permissions, undefined);
    assert.ok(JSON.parse(readFileSync(join(r.firefoxDir, 'manifest.json'), 'utf8')).browser_specific_settings);
    const fromZip = readZip(readFileSync(r.firefoxZip)).find((e) => e.name === 'manifest.json');
    assert.deepEqual(JSON.parse(fromZip.data.toString('utf8')), firefox);
    const t = build(out, { testHosts: ['http://127.0.0.1/*'] });
    assert.deepEqual(JSON.parse(readFileSync(join(t.testDir, 'manifest.json'), 'utf8')).host_permissions, ['http://127.0.0.1/*']);
    const zipped = JSON.parse(readZip(readFileSync(t.chromeZip)).find((e) => e.name === 'manifest.json').data.toString('utf8'));
    assert.equal(zipped.host_permissions, undefined, 'de zip heeft nooit een vaste toestemming');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
