import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import {
  b64u, encryptPayload, fromB64u, generateVapidKeys, isAllowedEndpoint, isValidVapid, publicKeyOf, sendWebPush, vapidAuthorization,
} from './webpush.ts';
import type { PushSubscriptionData } from './webpush.ts';

// ---------- de officiële testwaarden uit RFC 8291, Appendix A ----------
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/**
 * Een eigen, onafhankelijke ontvanger: volgt de formules uit de RFC met losse HMAC-stappen (dus niet met dezelfde
 * hkdfSync-aanroep als de zender), zoals de browser het zou doen met zijn privésleutel.
 */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const record = body.subarray(21 + idLen);
  assert.ok(record.length <= rs, 'het record past in de opgegeven recordgrootte');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  const prkKey = hmac(authSecret, secret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 0x02, 'laatste record eindigt op het scheidingsteken 0x02');
  return plain.subarray(0, plain.length - 1);
}

function newDevice() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const sub: PushSubscriptionData = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(authSecret) },
  };
  return { sub, uaPrivate: ecdh.getPrivateKey(), uaPublic: ecdh.getPublicKey(), authSecret };
}

test('RFC 8291, Appendix A: precies dezelfde versleutelde body als in de officiële voorbeelden', () => {
  assert.equal(fromB64u(RFC.plaintext).toString(), 'When I grow up, I want to be a watermelon');
  const body = encryptPayload(fromB64u(RFC.plaintext), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret), {
    serverPrivateKey: fromB64u(RFC.asPrivate),
    salt: fromB64u(RFC.salt),
  });
  assert.equal(b64u(body), RFC.body);
});

test('de eigen ontvanger kan het voorbeeld uit de RFC ontsleutelen, en onze berichten ook', () => {
  const rfcPlain = decrypt(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret));
  assert.equal(rfcPlain.toString(), 'When I grow up, I want to be a watermelon');

  const d = newDevice();
  for (const text of ['', 'x', 'Café reserveren om 9:00 – IJs kopen', 'a'.repeat(1000), JSON.stringify({ title: 'Zoë bellen', body: 'ë'.repeat(500) })]) {
    const body = encryptPayload(Buffer.from(text, 'utf8'), d.uaPublic, d.authSecret);
    assert.equal(decrypt(body, d.uaPrivate, d.uaPublic, d.authSecret).toString('utf8'), text);
  }
});

test('elk bericht gebruikt een eigen salt en een eigen sleutel; een ander apparaat kan het niet lezen', () => {
  const a = newDevice();
  const b = newDevice();
  const one = encryptPayload(Buffer.from('hallo'), a.uaPublic, a.authSecret);
  const two = encryptPayload(Buffer.from('hallo'), a.uaPublic, a.authSecret);
  assert.notDeepEqual(one, two, 'zelfde bericht, andere versleuteling');
  assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16), 'andere salt');
  assert.throws(() => decrypt(one, b.uaPrivate, b.uaPublic, b.authSecret));
  assert.throws(() => decrypt(one, a.uaPrivate, a.uaPublic, randomBytes(16)), 'ook met een verkeerd auth-geheim lukt het niet');
});

test('te grote berichten en ongeldige sleutels worden geweigerd', () => {
  const d = newDevice();
  assert.throws(() => encryptPayload(Buffer.alloc(4096), d.uaPublic, d.authSecret), /te groot/);
  assert.doesNotThrow(() => encryptPayload(Buffer.alloc(4079), d.uaPublic, d.authSecret));
  assert.throws(() => encryptPayload(Buffer.from('x'), Buffer.alloc(65), d.authSecret), /ongeldig/);
  assert.throws(() => encryptPayload(Buffer.from('x'), d.uaPublic, randomBytes(8)), /ongeldig/);
});

test('VAPID-sleutels: 65 bytes publiek, bij elkaar horend, en herkenbaar als geldig', () => {
  const k = generateVapidKeys();
  assert.equal(fromB64u(k.publicKey).length, 65);
  assert.equal(fromB64u(k.publicKey)[0], 0x04);
  assert.equal(publicKeyOf(k.privateKey), k.publicKey);
  assert.equal(isValidVapid(k), true);
  assert.equal(isValidVapid({ ...k, publicKey: generateVapidKeys().publicKey }), false, 'sleutels van verschillende paren');
  assert.equal(isValidVapid({ publicKey: 'kapot', privateKey: 'kapot' }), false);
  assert.notEqual(generateVapidKeys().publicKey, k.publicKey);
});

test('VAPID-handtekening: de JWT is te controleren met de publieke sleutel en bevat de juiste claims', () => {
  const k = generateVapidKeys();
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const auth = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', k, 'mailto:beheer@voorbeeld.nl', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth);
  assert.ok(m, `onverwachte vorm: ${auth}`);
  const [, h, c, s, kpub] = m;
  assert.equal(kpub, k.publicKey);
  assert.deepEqual(JSON.parse(fromB64u(h).toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(fromB64u(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'alleen de herkomst, zonder pad');
  assert.equal(claims.sub, 'mailto:beheer@voorbeeld.nl');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600);
  assert.equal(fromB64u(s).length, 64, 'r || s, zoals JWT het wil (niet DER)');
  const raw = fromB64u(k.publicKey);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(s)), true);
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}x`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(s)), false, 'gewijzigde inhoud valt door de mand');
  // nooit langer dan 24 uur geldig, wat je ook vraagt
  const long = vapidAuthorization('https://fcm.googleapis.com/x', k, 'mailto:a@b.nl', now, 30 * 24 * 3600);
  assert.equal(JSON.parse(fromB64u(/t=[\w-]+\.([\w-]+)\./.exec(long)![1]).toString()).exp, Math.floor(now / 1000) + 24 * 3600);
});

test('alleen bekende pushdiensten zijn toegestaan als bestemming', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://web.push.apple.com/abc',
  ];
  for (const e of ok) assert.equal(isAllowedEndpoint(e), true, e);
  const bad = [
    'http://fcm.googleapis.com/x', 'https://192.168.1.10/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x',
    'https://intern.nas.lan/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x',
    'https://notfcm.googleapis.com.evil.nl/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'geen-url', '',
  ];
  for (const e of bad) assert.equal(isAllowedEndpoint(e), false, e);
  assert.equal(isAllowedEndpoint('https://push.mijnserver.nl/up/abc'), false);
  assert.equal(isAllowedEndpoint('https://push.mijnserver.nl/up/abc', ['mijnserver.nl']), true, 'uit te breiden voor een eigen pushdienst');
  assert.equal(isAllowedEndpoint('https://evil.com/x', ['mijnserver.nl']), false);
});

function fakeFetch(respond: (url: string, init: any) => { status: number; headers?: Record<string, string> } | Error) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = respond(url, init);
    if (r instanceof Error) throw r;
    return new Response(null, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('verzenden: juiste headers, ontsleutelbare inhoud, en de uitkomst per antwoord van de pushdienst', async () => {
  const d = newDevice();
  const vapid = generateVapidKeys();
  const base = { vapid, subject: 'mailto:beheer@voorbeeld.nl', now: () => 1_800_000_000_000 };

  const ok = fakeFetch(() => ({ status: 201 }));
  const r = await sendWebPush(d.sub, JSON.stringify({ title: 'Tandarts bellen' }), { ...base, fetch: ok.fn, topic: 'x'.repeat(50) });
  assert.deepEqual(r, { ok: true, status: 201, gone: false, retryable: false });
  const h = ok.calls[0].init.headers;
  assert.equal(ok.calls[0].init.method, 'POST');
  assert.match(h.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.equal(h.TTL, '3600');
  assert.equal(h.Urgency, 'high', 'herinneringen doorbreken de Doze-stand');
  assert.equal(h.Topic.length, 32, 'onderwerp is maximaal 32 tekens');
  assert.equal(ok.calls[0].init.redirect, 'error', 'geen omleidingen volgen');
  assert.equal(decrypt(ok.calls[0].init.body, d.uaPrivate, d.uaPublic, d.authSecret).toString(), '{"title":"Tandarts bellen"}');

  for (const [status, expected] of [
    [410, { gone: true, retryable: false }], [404, { gone: true, retryable: false }],
    [400, { gone: false, retryable: false }], [401, { gone: false, retryable: false }], [403, { gone: false, retryable: false }], [413, { gone: false, retryable: false }],
    [429, { gone: false, retryable: true }], [500, { gone: false, retryable: true }], [503, { gone: false, retryable: true }],
  ] as const) {
    const f = fakeFetch(() => ({ status }));
    const res = await sendWebPush(d.sub, 'x', { ...base, fetch: f.fn });
    assert.equal(res.ok, false, `status ${status}`);
    assert.equal(res.status, status);
    assert.equal(res.gone, expected.gone, `gone bij ${status}`);
    assert.equal(res.retryable, expected.retryable, `retryable bij ${status}`);
  }
  const limited = await sendWebPush(d.sub, 'x', { ...base, fetch: fakeFetch(() => ({ status: 429, headers: { 'retry-after': '120' } })).fn });
  assert.equal(limited.retryAfterSeconds, 120);

  const offline = await sendWebPush(d.sub, 'x', { ...base, fetch: fakeFetch(() => new TypeError('fetch failed')).fn });
  assert.deepEqual([offline.ok, offline.status, offline.gone, offline.retryable], [false, null, false, true]);
  assert.match(offline.error!, /geen verbinding/);
});

test('verzenden weigert niet-toegestane bestemmingen zonder iets te versturen, en ongeldige sleutels', async () => {
  const d = newDevice();
  const f = fakeFetch(() => ({ status: 201 }));
  const base = { vapid: generateVapidKeys(), subject: 'mailto:a@b.nl', fetch: f.fn };
  const internal = await sendWebPush({ ...d.sub, endpoint: 'https://192.168.1.5/admin' }, 'x', base);
  assert.deepEqual([internal.ok, internal.retryable], [false, false]);
  assert.match(internal.error!, /niet toegestaan/);
  const broken = await sendWebPush({ ...d.sub, keys: { p256dh: 'kapot', auth: 'kapot' } }, 'x', base);
  assert.deepEqual([broken.ok, broken.retryable], [false, false]);
  const huge = await sendWebPush(d.sub, 'x'.repeat(5000), base);
  assert.equal(huge.ok, false);
  assert.equal(f.calls.length, 0, 'in geen van deze gevallen is er een verzoek verstuurd');
});
