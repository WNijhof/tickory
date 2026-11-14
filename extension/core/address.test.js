// Het serveradres en de regel voor http: dezelfde gevallen als de Android-app (ServerAddressTest.kt en LocalNetworkTest in
// SmallPartsTest.kt), zodat beide clients hetzelfde toestaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleartextAllowed, hostLooksLocal, ipv6Bytes, isLocalAddress, isLoopbackHost, parseServer, permissionPattern } from './address.js';

const ok = (input) => {
  const r = parseServer(input);
  assert.equal(r.ok, true, `'${input}' hoort geldig te zijn, maar gaf ${JSON.stringify(r)}`);
  return r;
};
const problem = (input) => {
  const r = parseServer(input);
  assert.equal(r.ok, false, `'${input}' hoort ongeldig te zijn, maar gaf ${JSON.stringify(r)}`);
  return r.problem;
};

test('een adres wordt de oorsprong: schema, host in kleine letters en een poort als die niet de standaard is', () => {
  const https = ok('https://taken.voorbeeld.nl');
  assert.deepEqual(https, { ok: true, origin: 'https://taken.voorbeeld.nl', host: 'taken.voorbeeld.nl', https: true, schemeAssumed: false });
  const http = ok('http://192.168.1.10:8787');
  assert.equal(http.origin, 'http://192.168.1.10:8787');
  assert.equal(http.host, '192.168.1.10');
  assert.equal(http.https, false);
  for (const input of ['https://taken.voorbeeld.nl/', 'https://taken.voorbeeld.nl/app/index.html?x=1&y=2#task=abc', 'https://taken.voorbeeld.nl?x=1', 'https://taken.voorbeeld.nl#top',
    '  HTTPS://Taken.Voorbeeld.NL  ', 'https://taken.voorbeeld.nl.', 'https://taken.voorbeeld.nl/pad@iets']) {
    assert.equal(ok(input).origin, 'https://taken.voorbeeld.nl', input);
  }
  assert.equal(ok('http://192.168.1.10:8787/een pad met spaties').origin, 'http://192.168.1.10:8787');
  assert.equal(ok('\tHttp://NAS:8787\n').origin, 'http://nas:8787');
  assert.equal(ok('https://a.nl:443').origin, 'https://a.nl');
  assert.equal(ok('http://a.nl:80/').origin, 'http://a.nl');
  assert.equal(ok('https://a.nl:80').origin, 'https://a.nl:80');
  assert.equal(ok('http://a.nl:443').origin, 'http://a.nl:443');
  assert.equal(ok('https://a.nl:8443').origin, 'https://a.nl:8443');
  assert.equal(ok('http://a.nl:65535').origin, 'http://a.nl:65535');
  assert.equal(ok('http://a.nl:1').origin, 'http://a.nl:1');
  assert.equal(ok('http://a.nl:0080').origin, 'http://a.nl', 'een poort met voorloopnullen is de standaardpoort');
  assert.equal(ok('http://a_b.lan').host, 'a_b.lan', 'een liggend streepje mag (zoals in de app)');
});

test('zonder schema nemen we https aan', () => {
  const r = ok('taken.voorbeeld.nl');
  assert.equal(r.origin, 'https://taken.voorbeeld.nl');
  assert.equal(r.schemeAssumed, true);
  assert.equal(ok('192.168.1.10:8787').origin, 'https://192.168.1.10:8787');
  assert.equal(ok('nas:8787').origin, 'https://nas:8787');
  assert.equal(ok('taken.voorbeeld.nl/app').origin, 'https://taken.voorbeeld.nl');
});

test('alleen http en https; geen inloggegevens in het adres; leeg is leeg', () => {
  for (const input of ['ftp://taken.voorbeeld.nl', 'file:///etc/passwd', 'javascript://taken.voorbeeld.nl/%0aalert(1)', 'ws://taken.voorbeeld.nl', 'content://taken.voorbeeld.nl', '://taken.voorbeeld.nl', 'chrome-extension://abc']) {
    assert.equal(problem(input), 'SCHEME', input);
  }
  for (const input of ['javascript:alert(1)', 'mailto:iemand@voorbeeld.nl', 'http:/192.168.1.10']) assert.equal(parseServer(input).ok, false, input);
  for (const input of ['https://anna:geheim@taken.voorbeeld.nl', 'https://anna@taken.voorbeeld.nl', 'anna:geheim@taken.voorbeeld.nl', 'http://@192.168.1.10']) {
    assert.equal(problem(input), 'CREDENTIALS', input);
  }
  for (const input of ['', '   ', '\n\t', null, undefined, 42]) assert.equal(problem(input), 'EMPTY');
});

test('ongeldige adressen', () => {
  const bad = [
    'https://', 'https:///pad', 'http://:8787', 'http://host:99999', 'http://host:0', 'http://host:abc', 'http://host:',
    'http://host:-1', 'http://host:80:80', 'https://taken voorbeeld.nl', 'https://taken..voorbeeld.nl', 'https://.nl',
    'https://-a.nl', 'https://a-.nl', 'https://taken.voorbeeld.nl\\pad', 'http://[::1', 'http://[::1]x', 'http://[::1]x80', 'http://[zz::1]',
    'http://[]', 'http://::1', 'https://a.nl:44 3', 'https://ex%61mple.nl', 'https://a,b.nl', `https://${'a'.repeat(64)}.nl`,
    `https://${'a.'.repeat(127)}nl`, 'http://[1:2:3:4:5:6:7:8:9]', 'http://[1.2.3.4]', 'http://[1::2::3]', 'http://[::12345]',
    'https://a.nl\u0000', 'https://a\u007f.nl', 'https://goed.nl\\.fout.nl', 'http://host:65536',
  ];
  for (const input of bad) assert.equal(problem(input), 'INVALID', input);
  // een browser leest "\" als "/": "https://goed.nl\@fout.nl" is voor een browser goed.nl; wij keuren het hele adres af
  assert.equal(parseServer('https://goed.nl\\@fout.nl').ok, false);
});

test('IPv6 tussen blokhaken, in de vorm die de browser gebruikt; namen met bijzondere tekens worden punycode', () => {
  assert.equal(ok('http://[FE80::1]:8787').origin, 'http://[fe80::1]:8787');
  assert.equal(ok('http://[FE80::1]:8787').host, '[fe80::1]');
  assert.equal(ok('[::1]').origin, 'https://[::1]');
  assert.equal(ok('https://[2001:db8::10]:443/x').origin, 'https://[2001:db8::10]');
  assert.equal(ok('http://[0:0:0:0:0:0:0:1]').host, '[::1]');
  const idn = ok('https://tëst.voorbeeld.nl');
  assert.match(idn.origin, /^https:\/\/xn--[a-z0-9-]+\.voorbeeld\.nl$/);
  assert.equal(ok('https://TËST.voorbeeld.nl').origin, idn.origin);
  assert.equal(problem('https://tëst..nl'), 'INVALID');
});

test('IPv6 als bytes, met "::" en een IPv4-staart', () => {
  assert.deepEqual(ipv6Bytes('::1'), [...Array(15).fill(0), 1]);
  assert.deepEqual(ipv6Bytes('fe80::1'), [0xfe, 0x80, ...Array(13).fill(0), 1]);
  assert.deepEqual(ipv6Bytes('1:2:3:4:5:6:7:8'), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  assert.deepEqual(ipv6Bytes('::ffff:192.168.1.10'), [...Array(10).fill(0), 0xff, 0xff, 192, 168, 1, 10]);
  assert.deepEqual(ipv6Bytes('1:2:3:4:5:6:1.2.3.4'), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4]);
  assert.deepEqual(ipv6Bytes('::'), Array(16).fill(0));
  assert.deepEqual(ipv6Bytes('abcd::'), [0xab, 0xcd, ...Array(14).fill(0)]);
  for (const bad of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', '::12345', 'g::1', '1.2.3.4::', '::1.2.3.4.5', '::256.1.1.1', '::1.2.3.4:5', '1:2:3:4:5:6:7::8', '']) {
    assert.equal(ipv6Bytes(bad), null, bad);
  }
});

test('adressen op het eigen netwerk', () => {
  const local = [
    '192.168.1.10', '192.168.178.1', '10.0.0.5', '10.0.2.2', '172.16.0.1', '172.31.255.254', '169.254.10.20', '100.64.0.1', '100.127.1.1',
    '[fe80::1]', '[fd12:3456:789a::1]', '[fc00::1]', '[::ffff:192.168.1.10]', '[febf::1]', '[::ffff:c0a8:10a]',
    'nas', 'raspberrypi', 'taken.local', 'server.lan', 'mijn.fritz.box', 'pc.home.arpa', 'TAKEN.LOCAL', 'taken.local.', 'x.home', 'x.internal', 'x.localdomain',
  ];
  for (const host of local) assert.equal(hostLooksLocal(host), true, host);
});

test('adressen op internet of op de computer zelf', () => {
  const notLocal = [
    '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.1.1', '100.63.0.1', '100.128.0.1', '11.0.0.1', '127.0.0.1', '999.1.1.1', '10.0.0.256', '192.168.1.300', '169.253.1.1', '191.168.1.1',
    '[2001:db8::1]', '[2a02:a45f::1]', '[::1]', '[::ffff:8.8.8.8]', '[geen-adres]', '[fec0::1]', '[fe00::1]', '[fe80::1',
    'taken.voorbeeld.nl', 'voorbeeld.nl', 'localhost', 'wnijhof.github.io', 'mijnlocal.nl', 'local.voorbeeld.nl',
  ];
  for (const host of notLocal) assert.equal(hostLooksLocal(host), false, host);
  assert.equal(isLocalAddress([192, 168, 0, 1]), true);
  assert.equal(isLocalAddress([93, 184, 216, 34]), false);
  assert.equal(isLocalAddress([]), false);
  assert.equal(isLocalAddress(Array(7).fill(0)), false);
  assert.equal(isLocalAddress([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xff, 0xff, 192, 168, 1, 1]), false, 'geen ::ffff:-adres als er iets anders voor staat');
  assert.equal(isLocalAddress([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xfe, 192, 168, 1, 1]), false);
});

test('de computer zelf', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['localhost.voorbeeld.nl', '127.0.0.1.voorbeeld.nl', '128.0.0.1', '[::2]', 'nas']) assert.equal(isLoopbackHost(host), false, host);
});

test('http alleen op het eigen netwerk of de computer zelf; https altijd', () => {
  assert.equal(cleartextAllowed(ok('https://taken.voorbeeld.nl')), true);
  assert.equal(cleartextAllowed(ok('https://8.8.8.8')), true);
  assert.equal(cleartextAllowed(ok('http://192.168.1.10:8787')), true);
  assert.equal(cleartextAllowed(ok('http://nas.local')), true);
  assert.equal(cleartextAllowed(ok('http://nas:8787')), true);
  assert.equal(cleartextAllowed(ok('http://taken.voorbeeld.nl')), false, 'een naam op internet');
  assert.equal(cleartextAllowed(ok('http://203.0.113.9:8787')), false, 'een openbaar IP-adres');
  assert.equal(cleartextAllowed(ok('http://127.0.0.1:8795')), true, 'de computer zelf (de tests)');
  assert.equal(cleartextAllowed(ok('http://localhost:8787')), true);
  assert.equal(cleartextAllowed(ok('http://[::1]:8787')), true);
  assert.equal(cleartextAllowed(ok('http://[fd00::5]:8787')), true);
  assert.equal(cleartextAllowed(ok('http://127.0.0.1.voorbeeld.nl')), false, 'een naam die er alleen op lijkt');
  assert.equal(cleartextAllowed(ok('http://localhost.voorbeeld.nl')), false);
});

test('de toestemming geldt voor precies die host en dat schema (elke poort)', () => {
  assert.equal(permissionPattern(ok('https://taken.voorbeeld.nl:8443/app')), 'https://taken.voorbeeld.nl/*');
  assert.equal(permissionPattern(ok('http://192.168.1.10:8787')), 'http://192.168.1.10/*');
  assert.equal(permissionPattern(ok('http://[FE80::1]:8787')), 'http://[fe80::1]/*');
  assert.equal(permissionPattern(ok('taken.voorbeeld.nl')), 'https://taken.voorbeeld.nl/*');
});
