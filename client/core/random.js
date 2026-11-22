// Willekeurige uuid's voor commando's, ook waar `crypto.randomUUID()` niet bestaat. Die functie is er alleen in een "veilige context"
// (https of localhost); wie Tickory opent via http op een ander adres (een thuisnetwerk, Tailscale, een IP-adres) heeft hem niet, en
// dan mislukte elke wijziging stil. `crypto.getRandomValues` is er wel altijd, en geeft dezelfde willekeur.

/**
 * Een uuid volgens RFC 4122 versie 4 ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", 36 tekens).
 * @param {(n: number) => Uint8Array} [randomBytes] alleen voor de tests
 */
export function randomUuid(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // versie 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
