// De verbinding voor bijlagen: uploaden met XMLHttpRequest, ophalen en de grenzen, met nagebootste XHR en fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidBridge } from './android.js';
import { AttachmentError, createAttachmentsApi } from './attachmentsApi.js';
import { AuthError } from './syncClient.js';
import { fetchSharedFiles, shareFromHash, sharedFiles } from './share.js';
import { SHRINK_MAX_EDGE, shrinkImage } from './imageResize.js';

/** Een nagebootste XMLHttpRequest: `reply` bepaalt wat er na send() gebeurt. */
function fakeXhr(reply) {
  const instances = [];
  class FakeXhr {
    constructor() {
      this.headers = {};
      this.upload = {};
      this.status = 0;
      this.responseText = '';
      instances.push(this);
    }

    open(method, url) { this.method = method; this.url = url; }

    setRequestHeader(k, v) { this.headers[k] = v; }

    abort() { this.aborted = true; this.onabort?.(); }

    send(body) {
      this.body = body;
      reply(this);
    }
  }
  return { XHR: FakeXhr, instances };
}
const respond = (xhr, status, body) => { xhr.status = status; xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body); xhr.onload(); };

const blob = new Blob(['inhoud'], { type: 'text/plain' });
const goodReply = { id: 'bijlage-00001', size: 6, sha256: 'a'.repeat(64), mime: 'text/plain' };

test('upload: het bestand gaat als body, het token in een header en nooit in het adres, met voortgang', async () => {
  const progress = [];
  const { XHR, instances } = fakeXhr((x) => { x.upload.onprogress({ lengthComputable: true, loaded: 3, total: 6 }); respond(x, 200, goodReply); });
  const api = createAttachmentsApi({ getToken: () => 'tky_geheim', XHR });
  const out = await api.upload({ id: 'bijlage-00001', taskId: 'taak/met spatie', blob, mime: 'text/plain', onProgress: (f) => progress.push(f) });
  assert.deepEqual(out, goodReply);
  const [x] = instances;
  assert.equal(x.method, 'POST');
  assert.equal(x.url, '/api/v1/attachments?id=bijlage-00001&task_id=taak%2Fmet%20spatie');
  assert.ok(!x.url.includes('tky_geheim'));
  assert.equal(x.headers.Authorization, 'Bearer tky_geheim');
  assert.equal(x.headers['Content-Type'], 'text/plain');
  assert.equal(x.body, blob);
  assert.deepEqual(progress, [0.5, 1]);
});

test('upload: zonder token meteen een AuthError, zonder iets te versturen', async () => {
  const { XHR, instances } = fakeXhr(() => assert.fail('er hoort niets verstuurd te worden'));
  const api = createAttachmentsApi({ getToken: () => null, XHR });
  await assert.rejects(api.upload({ id: 'bijlage-00001', taskId: 'taak-00000001', blob, mime: '' }), AuthError);
  assert.equal(instances.length, 0);
});

test('upload: wat de server weigert is niet te herhalen, wat tijdelijk is wel', async () => {
  const cases = [
    [401, { error_code: 'UNAUTHORIZED', error: 'x' }, AuthError, null],
    [404, { error_code: 'NOT_FOUND', error: 'deze taak bestaat niet' }, AttachmentError, false],
    [413, { error_code: 'TOO_LARGE', error: 'te groot' }, AttachmentError, false],
    [409, { error_code: 'LIMIT_REACHED', error: 'vol' }, AttachmentError, false],
    [507, { error_code: 'STORAGE_FULL', error: 'geen ruimte' }, AttachmentError, false],
    [400, { error_code: 'INVALID_ARG', error: 'onzin' }, AttachmentError, false],
    [408, { error_code: 'TIMEOUT', error: 'te langzaam' }, AttachmentError, true],
    [429, { error_code: 'X', error: 'te vaak' }, AttachmentError, true],
    [500, { error_code: 'INTERNAL', error: 'oeps' }, AttachmentError, true],
    [502, '<html>Bad gateway</html>', AttachmentError, true],
    [200, 'geen json', AttachmentError, false],
  ];
  for (const [status, body, klass, retryable] of cases) {
    const { XHR } = fakeXhr((x) => respond(x, status, body));
    const api = createAttachmentsApi({ getToken: () => 't', XHR });
    await assert.rejects(api.upload({ id: 'bijlage-00001', taskId: 'taak-00000001', blob, mime: 'text/plain' }), (err) => {
      assert.ok(err instanceof klass, `${status}: ${err}`);
      if (retryable !== null) assert.equal(err.retryable, retryable, String(status));
      if (typeof body === 'object' && klass === AttachmentError) assert.equal(err.code, body.error_code);
      return true;
    });
  }
});

test('upload: geen verbinding is te herhalen; zelf afbreken niet; een upload zonder voortgang wordt afgebroken', async () => {
  const net = fakeXhr((x) => x.onerror());
  await assert.rejects(createAttachmentsApi({ getToken: () => 't', XHR: net.XHR }).upload({ id: 'bijlage-00001', taskId: 'taak-00000001', blob, mime: '' }),
    (err) => err.retryable === true && err.code === 'NETWORK');

  const controller = new AbortController();
  const hang = fakeXhr(() => { /* geen antwoord */ });
  const pending = createAttachmentsApi({ getToken: () => 't', XHR: hang.XHR }).upload({ id: 'bijlage-00001', taskId: 'taak-00000001', blob, mime: '', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'ABORTED' && err.retryable === false);

  const stall = fakeXhr(() => { /* geen antwoord en geen voortgang */ });
  await assert.rejects(createAttachmentsApi({ getToken: () => 't', XHR: stall.XHR, stallMs: 30 }).upload({ id: 'bijlage-00001', taskId: 'taak-00000001', blob, mime: '' }),
    (err) => err.code === 'ABORTED' && err.retryable === true);
});

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => new Blob(['x']) });

test('limits en download: met het token in een header, fouten als AttachmentError of AuthError', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([url, init.headers]);
    if (url.endsWith('/limits')) return jsonResponse(200, { max_upload_bytes: 5, quota_bytes: 10, used_bytes: 1, per_task: 20 });
    if (url.includes('weg')) return jsonResponse(404, { error_code: 'NOT_FOUND', error: 'deze bijlage bestaat niet' });
    if (url.includes('401')) return jsonResponse(401, null);
    if (url.includes('net')) throw new TypeError('fetch failed');
    return jsonResponse(200, null);
  };
  const api = createAttachmentsApi({ getToken: () => 'tky_x', fetch: fetchFn });
  assert.deepEqual(await api.limits(), { max_upload_bytes: 5, quota_bytes: 10, used_bytes: 1, per_task: 20 });
  assert.equal((await api.download('bijlage 1/x')).size, 1);
  assert.equal(calls[1][0], '/api/v1/attachments/bijlage%201%2Fx', 'het id wordt als pad-deel ontsnapt');
  assert.equal(calls[0][1].Authorization, 'Bearer tky_x');
  await assert.rejects(api.download('weg'), (e) => e instanceof AttachmentError && e.code === 'NOT_FOUND' && !e.retryable);
  await assert.rejects(api.download('401'), AuthError);
  await assert.rejects(api.download('net'), (e) => e instanceof AttachmentError && e.retryable);
  await assert.rejects(createAttachmentsApi({ getToken: () => null, fetch: fetchFn }).download('x'), AuthError);
  await assert.rejects(createAttachmentsApi({ getToken: () => null, fetch: fetchFn }).limits(), AuthError);
});

// ---------- de brug naar Android ----------

test('de brug: bijlagen openen of opslaan kan alleen als de app het kent; een oudere app doet niets', () => {
  const seen = [];
  const bridge = androidBridge({ openAttachment: (...a) => seen.push(['open', ...a]), saveAttachment: (...a) => seen.push(['save', ...a]) });
  assert.equal(bridge.canOpenAttachments(), true);
  bridge.openAttachment('bijlage-00001', 'foto.png', 'image/png');
  bridge.saveAttachment('bijlage-00001', 'foto.png', 'image/png');
  assert.deepEqual(seen, [['open', 'bijlage-00001', 'foto.png', 'image/png'], ['save', 'bijlage-00001', 'foto.png', 'image/png']]);
  const old = androidBridge({ setSession: () => {} });
  assert.equal(old.canOpenAttachments(), false);
  assert.doesNotThrow(() => old.openAttachment('x', 'y', 'z'));
  assert.equal(androidBridge(undefined).canOpenAttachments(), false);
});

// ---------- delen naar Tickory met bestanden ----------

const hashOf = (obj) => `#share=${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`;
const TOKEN = 'abcdefghijklmnop0123456789';

test('delen met bestanden: tekst, token en bestanden komen als gecontroleerde gegevens binnen', () => {
  const draft = shareFromHash(hashOf({ title: 'Foto’s van de zolder', text: 'Kijk even', token: TOKEN, files: [{ name: '../IMG 01.jpg', mime: 'IMAGE/JPEG', size: 123456 }, { name: 'plan.pdf', mime: 'application/pdf', size: 99 }] }));
  assert.deepEqual(draft, {
    title: 'Foto’s van de zolder', description: 'Kijk even', token: TOKEN,
    files: [{ name: '_IMG 01.jpg', mime: 'image/jpeg', size: 123456 }, { name: 'plan.pdf', mime: 'application/pdf', size: 99 }],
  });
});

test('delen met alleen bestanden: de titel is de naam van het eerste bestand zonder uitgang', () => {
  const draft = shareFromHash(hashOf({ title: '', text: '', token: TOKEN, files: [{ name: 'Rekening café.pdf', mime: 'application/pdf', size: 10 }] }));
  assert.equal(draft.title, 'Rekening café');
  assert.equal(draft.description, '');
  assert.equal(draft.files.length, 1);
});

test('delen: een ongeldig token, geen lijst of vreemde gegevens geven geen bestanden; zonder tekst en bestanden is er niets', () => {
  assert.equal(shareFromHash(hashOf({ title: 'x', text: '', token: 'kort', files: [{ name: 'a', mime: 'a/b', size: 1 }] })).files, undefined);
  assert.equal(shareFromHash(hashOf({ title: 'x', token: TOKEN, files: 'geen lijst' })).files, undefined);
  assert.equal(shareFromHash(hashOf({ title: '', text: '', token: 'kort', files: [{ name: 'a', mime: 'a/b', size: 1 }] })), null);
  assert.deepEqual(sharedFiles({ token: TOKEN, files: [null, 5, { name: 7 }, { name: 'ok.txt', mime: 'rommel', size: -5 }] }), [{ name: 'ok.txt', mime: 'application/octet-stream', size: 0 }]);
  assert.equal(sharedFiles({ token: TOKEN, files: Array.from({ length: 50 }, () => ({ name: 'a', mime: 'a/b', size: 1 })) }).length, 20, 'hooguit 20');
  assert.deepEqual(sharedFiles(null), []);
});

test('gedeelde bestanden ophalen: elk bij het adres van de app met het token; wat ontbreekt wordt overgeslagen', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url.endsWith('/1')) return { ok: false, status: 404 };
    if (url.endsWith('/2')) throw new TypeError('weg');
    return { ok: true, blob: async () => new Blob(['inhoud']) };
  };
  const shared = { token: TOKEN, files: [{ name: 'a.txt', mime: 'text/plain', size: 6 }, { name: 'b.txt', mime: 'text/plain', size: 6 }, { name: 'c.txt', mime: 'text/plain', size: 6 }] };
  const files = await fetchSharedFiles(shared, fetchFn);
  assert.deepEqual(urls, [`/__tickory_share/${TOKEN}/0`, `/__tickory_share/${TOKEN}/1`, `/__tickory_share/${TOKEN}/2`]);
  assert.deepEqual(files.map((f) => [f.name, f.type, f.size]), [['a.txt', 'text/plain', 6]]);
  assert.deepEqual(await fetchSharedFiles({ token: '../../x', files: shared.files }, fetchFn), []);
  assert.equal(urls.length, 3, 'met een ongeldig token wordt niets opgehaald');
});

// ---------- foto's verkleinen ----------

const bigPhoto = (name, type, size) => new File([new Uint8Array(size)], name, { type });

test('foto verkleinen: alleen grote foto’s, tot de lange kant op 2048, de rest blijft zoals het is', async () => {
  const seen = [];
  const decode = async () => ({ width: 4000, height: 3000, close: () => seen.push('close') });
  const encode = async (bitmap, w, h, type, q) => { seen.push([w, h, type, q]); return new Blob([new Uint8Array(100_000)], { type }); };
  const out = await shrinkImage(bigPhoto('foto.jpeg', 'image/jpeg', 3_000_000), { decode, encode });
  assert.equal(out.name, 'foto.jpeg');
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.size, 100_000);
  assert.deepEqual(seen[0], [SHRINK_MAX_EDGE, 1536, 'image/jpeg', 0.85]);
  assert.equal(seen.includes('close'), true);

  const webp = await shrinkImage(bigPhoto('plaatje.webp', 'image/webp', 3_000_000), { decode, encode });
  assert.equal(webp.name, 'plaatje.jpg', 'een webp wordt een jpeg, met de juiste uitgang');
  assert.equal(webp.type, 'image/jpeg');
  const png = await shrinkImage(bigPhoto('scan.png', 'image/png', 3_000_000), { decode, encode });
  assert.equal(png.type, 'image/png');

  const small = bigPhoto('klein.jpg', 'image/jpeg', 10_000);
  assert.equal(await shrinkImage(small, { decode, encode }), small, 'een kleine foto blijft');
  const pdf = bigPhoto('doc.pdf', 'application/pdf', 3_000_000);
  assert.equal(await shrinkImage(pdf, { decode, encode }), pdf, 'alleen afbeeldingen');
  const already = bigPhoto('al-klein.jpg', 'image/jpeg', 3_000_000);
  assert.equal(await shrinkImage(already, { decode: async () => ({ width: 1000, height: 800 }), encode }), already, 'al klein genoeg in pixels');
  assert.equal(await shrinkImage(already, { decode, encode: async () => new Blob([new Uint8Array(5_000_000)]) }), already, 'wordt het niet kleiner, dan blijft het origineel');
  assert.equal(await shrinkImage(already, { decode: async () => { throw new Error('geen afbeelding'); }, encode }), already, 'een fout laat het bestand ongemoeid');
});
