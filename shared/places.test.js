import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, validateValue } from './schema.js';
import { distanceMeters, formatDistance, parseCoordinates, validCoordinates, PLACE_RADIUS_DEFAULT, PLACE_RADIUS_MAX, PLACE_RADIUS_MIN } from './places.js';

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} verwacht ${expected} ± ${tolerance}, kreeg ${actual}`);

test('afstand: zelfde punt is nul, en de afstand is symmetrisch', () => {
  assert.equal(distanceMeters(52.37, 4.89, 52.37, 4.89), 0);
  const ab = distanceMeters(52.37, 4.89, 51.92, 4.48);
  const ba = distanceMeters(51.92, 4.48, 52.37, 4.89);
  near(ab, ba, 1e-6);
  near(ab, 57_328, 50, 'ongeveer 57 km');
});

test('afstand: bekende maten (een graad breedte is ongeveer 111,2 km; een graad lengte op de evenaar ook)', () => {
  near(distanceMeters(0, 0, 1, 0), 111_195, 50);
  near(distanceMeters(0, 0, 0, 1), 111_195, 50);
  near(distanceMeters(60, 10, 61, 10), 111_195, 50);
  // een graad lengte wordt korter naar de polen: op 60 graden de helft
  near(distanceMeters(60, 10, 60, 11), 55_597, 60);
});

test('afstand: kleine afstanden zijn nauwkeurig (100 m noord en oost)', () => {
  const dLat = 100 / 111_195;
  near(distanceMeters(52, 5, 52 + dLat, 5), 100, 0.2);
  const dLon = 100 / (111_195 * Math.cos((52 * Math.PI) / 180));
  near(distanceMeters(52, 5, 52, 5 + dLon), 100, 0.2);
});

test('afstand: over de datumgrens is de weg kort, niet de halve wereld', () => {
  near(distanceMeters(0, 179.9995, 0, -179.9995), 111.2, 0.5);
  near(distanceMeters(-17.5, 179.99, -17.5, -179.99), 2_117, 5);
  near(distanceMeters(10, 180, 10, -180), 0, 1e-6, 'dezelfde meridiaan');
});

test('afstand: bij de polen', () => {
  near(distanceMeters(90, 0, 90, 123), 0, 1e-6, 'alle lengtes zijn op de pool hetzelfde punt');
  near(distanceMeters(-90, 10, -90, -170), 0, 1e-6);
  near(distanceMeters(89.9, 0, 89.9, 180), 22_239, 30, 'over de pool heen: 0,2 graad');
  near(distanceMeters(90, 0, 89, 77), 111_195, 50);
  near(distanceMeters(90, 0, -90, 0), 20_015_087, 100, 'van pool tot pool');
});

test('afstand: tegenpolen halen de wortel niet boven 1 (afrondingsfouten)', () => {
  const half = distanceMeters(0, 0, 0, 180);
  near(half, 20_015_087, 100);
  assert.ok(Number.isFinite(distanceMeters(45, 10, -45, -170)));
  // punten waarvoor de formule door afronding net boven 1 uitkomt (asin zou dan NaN geven)
  for (const [la, lo, la2, lo2] of [[65.83308609468821, -125.70935538627661, -65.83308609468821, 54.29064461372339], [74.49786860864089, 97.25021525177806, -74.49786860864089, -82.74978474822194], [-50.599430700720696, 16.195317900573173, 50.599430700720696, -163.80468209942683]]) {
    near(distanceMeters(la, lo, la2, lo2), 20_015_087, 100, 'bijna tegenpolen');
  }
  assert.ok(Number.isFinite(distanceMeters(33.3, 44.4, -33.3, -135.6)));
});

test('coordinaten: grenzen', () => {
  assert.ok(validCoordinates(90, 180));
  assert.ok(validCoordinates(-90, -180));
  assert.ok(!validCoordinates(90.0001, 0));
  assert.ok(!validCoordinates(0, 180.0001));
  assert.ok(!validCoordinates(NaN, 0));
  assert.ok(!validCoordinates(0, Infinity));
  assert.ok(!validCoordinates('1', 2));
});

test('plakken: gewone getallen, met punt of komma als decimaalteken', () => {
  assert.deepEqual(parseCoordinates('52.0907, 5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('52.0907,5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('52,0907 5,1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('52,0907; 5,1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('  (-33.8688, 151.2093)  '), { lat: -33.8688, lon: 151.2093 });
  assert.deepEqual(parseCoordinates('0, 0'), { lat: 0, lon: 0 });
});

test('plakken: geo:-links', () => {
  assert.deepEqual(parseCoordinates('geo:52.0907,5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('geo:52.0907,5.1214?z=15'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('geo:52.0907,5.1214;u=35'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('GEO:52.0907,5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('geo:0,0?q=52.0907,5.1214(Thuis)'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('geo:0,0?q=52.0907%2C5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('geo:0,0'), { lat: 0, lon: 0 });
  assert.equal(parseCoordinates('geo:0,0?q=Hoofdstraat+1+Plaats'), null, 'een zoekopdracht naar een adres is geen positie');
  assert.equal(parseCoordinates(`https://kaart.example/@52.0907,5.1214,${'a'.repeat(2000)}`), null, 'een veel te lange invoer wordt niet gelezen');
});

test('plakken: kaartlinks (zonder iets op te halen)', () => {
  assert.deepEqual(parseCoordinates('https://www.google.com/maps/place/Thuis/@52.0907,5.1214,17z/data=!3m1!4b1'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('https://www.google.com/maps/place/X/@52.1,5.2,17z/data=!4m5!3m4!1s0x0:0x0!8m2!3d52.0907!4d5.1214'), { lat: 52.0907, lon: 5.1214 }, 'het gemarkeerde punt gaat voor het midden van de kaart');
  assert.deepEqual(parseCoordinates('https://maps.example.org/?q=52.0907,5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('https://maps.example.org/?ll=52.0907%2C5.1214&z=10'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('https://www.openstreetmap.org/?mlat=52.0907&mlon=5.1214#map=16/52.1/5.2'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('https://www.openstreetmap.org/#map=16/52.0907/5.1214'), { lat: 52.0907, lon: 5.1214 });
  assert.deepEqual(parseCoordinates('https://example.org/@-33.8688,151.2093'), { lat: -33.8688, lon: 151.2093 });
});

test('plakken: wat geen coordinaten zijn, geeft null (geen opzoeken van adressen)', () => {
  for (const bad of ['', '   ', 'Hoofdstraat 1, Utrecht', 'Thuis', '52.0907', '91, 5', '52, 181', '1;2;3', 'https://example.org/pagina', 'geo:abc', 'geo:', null, undefined, 42, 'x'.repeat(3000)]) {
    assert.equal(parseCoordinates(bad), null, String(bad).slice(0, 40));
  }
});

test('afstand als tekst', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(84.6), '85 m');
  assert.equal(formatDistance(999.4), '999 m');
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(1234, ','), '1,2 km');
  assert.equal(formatDistance(12_340), '12 km');
  assert.equal(formatDistance(Infinity), '');
});

test('de plaats in het datamodel: grenzen van straal, breedte en lengte', () => {
  const col = (name) => ENTITIES.place.cols.find((c) => c.name === name);
  assert.deepEqual([PLACE_RADIUS_MIN, PLACE_RADIUS_DEFAULT, PLACE_RADIUS_MAX], [100, 150, 5000]);
  assert.equal(col('radius').default, 150);
  assert.equal(validateValue(col('radius'), 99), 'minimaal 100');
  assert.equal(validateValue(col('radius'), 5001), 'maximaal 5000');
  assert.equal(validateValue(col('radius'), 100), null);
  assert.equal(validateValue(col('lat'), 90), null);
  assert.equal(validateValue(col('lat'), 90.1), 'maximaal 90');
  assert.equal(validateValue(col('lon'), -180), null);
  assert.equal(validateValue(col('lon'), -180.1), 'minimaal -180');
  assert.equal(validateValue(col('lat'), '52'), 'moet een getal zijn');
  assert.equal(validateValue(col('lat'), NaN), 'moet een getal zijn');
  assert.equal(validateValue(col('lon'), Infinity), 'moet een getal zijn');
  assert.equal(validateValue(col('lat'), null), 'mag niet null zijn');
});
