// Een korte toon bij het afvinken van een taak (Instellingen › Algemeen › Geluid). Gemaakt met de Web Audio-API: geen geluidsbestand,
// dus niets extra te laden. Zonder ondersteuning, of zolang de browser nog geen geluid toestaat, gebeurt er niets.

let context = null;

/** De twee tonen van het geluid: een lage en een hogere kort erna (frequentie in Hz, begin en duur in seconden). */
export const DONE_TONES = Object.freeze([{ hz: 660, at: 0, length: 0.09 }, { hz: 880, at: 0.08, length: 0.14 }]);

/** Speel het geluid van een afgevinkte taak. Geeft true als er een toon is gestart. */
export function playDone() {
  try {
    const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioCtx) return false;
    context ??= new AudioCtx();
    if (context.state === 'suspended') context.resume?.();
    const start = context.currentTime;
    for (const tone of DONE_TONES) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.hz;
      // zacht aan en uit, zodat het niet knapt
      gain.gain.setValueAtTime(0.0001, start + tone.at);
      gain.gain.exponentialRampToValueAtTime(0.12, start + tone.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.length);
      osc.connect(gain).connect(context.destination);
      osc.start(start + tone.at);
      osc.stop(start + tone.at + tone.length + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}
