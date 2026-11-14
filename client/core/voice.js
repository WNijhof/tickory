// Spraakinvoer voor het venster "Taak toevoegen": je spreekt de taak in ("Bel de tandarts morgen om negen uur") en de herkende
// tekst komt in het invoerveld, waar de gewone herkenning van datum, project en prioriteit hem oppakt. Er wordt niets aangemaakt
// voordat je op Toevoegen tikt.
//
// Twee wegen, nooit allebei:
//  - In de Android-app: het spraakscherm van Android (brug `TickoryAndroid.startVoiceInput`); de tekst komt als gebeurtenis
//    `tickory-voice` terug. Heeft het toestel geen herkenner (`voiceAvailable()` is false), dan is er geen knop.
//  - In een browser: de Web Speech API (`SpeechRecognition`), waar de browser die heeft. NB: Chrome en Edge sturen de opname
//    naar de spraakdienst van de browsermaker; dat staat in de handleiding. Firefox heeft het niet.
// Alles hier is injecteerbaar (`env`) zodat het zonder browser te testen is.

export const VOICE_EVENT = 'tickory-voice';

/** Foutcodes waar de interface een melding bij heeft. */
export const VOICE_ERRORS = ['no-speech', 'denied', 'network', 'unavailable', 'cancelled', 'error'];

const recognitionOf = (env) => env.SpeechRecognition ?? env.webkitSpeechRecognition ?? null;

/** 'android', 'browser' of null als spraakinvoer hier niet kan. */
export function voiceSupport(env = globalThis) {
  const bridge = env.TickoryAndroid;
  if (bridge) {
    // In de app telt alleen het spraakscherm van Android; de browser-API van de WebView werkt daar niet.
    try {
      return typeof bridge.voiceAvailable === 'function' && bridge.voiceAvailable() === true ? 'android' : null;
    } catch {
      return null;
    }
  }
  return recognitionOf(env) ? 'browser' : null;
}

/** Foutnamen van de Web Speech API naar onze vaste lijst. */
export function browserErrorCode(name) {
  if (name === 'no-speech') return 'no-speech';
  if (name === 'not-allowed' || name === 'service-not-allowed') return 'denied';
  if (name === 'network') return 'network';
  if (name === 'aborted') return 'cancelled';
  if (name === 'audio-capture' || name === 'language-not-supported') return 'unavailable';
  return 'error';
}

const recognitionLanguage = (lang) => (lang === 'en' ? 'en-US' : 'nl-NL');

/**
 * Begint met luisteren. Roept precies één keer `onResult(tekst)` of `onError(code)` aan, en daarna `onEnd()`.
 * @param {{ lang: string, onResult: (text: string) => void, onError: (code: string) => void, onEnd?: () => void, env?: any }} options
 * @returns {{ stop: () => void } | null} null als het niet kan (dan is `onError('unavailable')` al aangeroepen)
 */
export function startVoice({ lang, onResult, onError, onEnd = () => {}, env = globalThis }) {
  const kind = voiceSupport(env);
  let finished = false;
  const finish = (fn, value) => {
    if (finished) return;
    finished = true;
    if (kind === 'android') env.removeEventListener?.(VOICE_EVENT, onAndroid);
    fn(value);
    onEnd();
  };
  function onAndroid(e) {
    const d = e?.detail ?? {};
    if (typeof d.text === 'string' && d.text.trim()) finish(onResult, d.text.trim());
    else finish(onError, VOICE_ERRORS.includes(d.error) ? d.error : 'error');
  }

  if (kind === 'android') {
    env.addEventListener(VOICE_EVENT, onAndroid);
    try {
      env.TickoryAndroid.startVoiceInput(lang === 'en' ? 'en' : 'nl');
    } catch {
      finish(onError, 'unavailable');
    }
    return { stop: () => finish(onError, 'cancelled') };
  }

  if (kind === 'browser') {
    const Recognition = recognitionOf(env);
    let recognition;
    try {
      recognition = new Recognition();
      recognition.lang = recognitionLanguage(lang);
      recognition.interimResults = false;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (e) => {
        const text = String(e?.results?.[0]?.[0]?.transcript ?? '').trim();
        if (text) finish(onResult, text);
        else finish(onError, 'no-speech');
      };
      recognition.onerror = (e) => finish(onError, browserErrorCode(e?.error));
      recognition.onend = () => finish(onError, 'no-speech'); // einde zonder resultaat of fout
      recognition.start();
    } catch {
      finish(onError, 'unavailable');
      return null;
    }
    return { stop: () => { try { recognition.stop(); } catch { /* al gestopt */ } } };
  }

  finish(onError, 'unavailable');
  return null;
}
