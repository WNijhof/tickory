// De handleiding in de app, het deel zonder scherm (te testen in node): het adres #help=…, veilige links, en zoeken. Het scherm
// zelf staat in ui/help.js; de inhoud maakt scripts/build-help.ts in client/help/<taal>.js.

/** Een `#help…`-adres als route, of null. `#help` alleen is de inhoudsopgave. */
export function helpRouteFromHash(hash) {
  const m = /^#help(?:=([a-z0-9-]{1,60})(?:~([A-Za-z0-9_-]{1,80}))?)?$/.exec(String(hash ?? ''));
  if (!m) return null;
  return m[1] && m[1] !== 'index' ? { type: 'help', id: m[1], ...(m[2] ? { anchor: m[2] } : {}) } : { type: 'help' };
}

export const isHelpRoute = (r) => Boolean(r && r.type === 'help' && (r.id === undefined || typeof r.id === 'string'));

/** Een veilig adres voor een link in de handleiding, of null (dan wordt het gewone tekst). */
export function safeHref(href) {
  const s = String(href ?? '');
  if (/^#help(=[a-z0-9-]+(~[A-Za-z0-9_-]+)?)?$/.test(s)) return s;
  if (/^(https:\/\/|mailto:)[^\s"<>]+$/.test(s)) return s;
  return null;
}

/** De woorden van een zoekvraag, zonder hoofdletters en accenten. */
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Zoeken in de handleiding: elk stuk onder een kop (h1, h2, h3) is een resultaat; alle woorden moeten erin staan. Een woord in de
 * kop of de titel telt zwaarder dan in de tekst. Hooguit `max` resultaten.
 * @param {{ pages: Record<string, { title: string, html: string }> }} data
 * @returns {{ id: string, anchor: string | null, page: string, heading: string, snippet: string }[]}
 */
export function searchHelp(data, query, { max = 30, sections = helpSections(data) } = {}) {
  const words = fold(query).split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const hits = [];
  for (const s of sections) {
    const head = fold(`${s.page} ${s.heading}`);
    const body = fold(s.text);
    if (!words.every((w) => head.includes(w) || body.includes(w))) continue;
    const score = words.reduce((n, w) => n + (head.includes(w) ? 10 : 0) + (body.includes(w) ? 1 : 0), 0);
    const at = body.indexOf(words[0]);
    const from = Math.max(0, at - 60);
    const snippet = `${from > 0 ? '…' : ''}${s.text.slice(from, from + 180).trim()}${from + 180 < s.text.length ? '…' : ''}`;
    hits.push({ id: s.id, anchor: s.anchor, page: s.page, heading: s.heading, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, max).map(({ score, ...rest }) => rest);
}

/** De stukken onder elke kop, als platte tekst (voor het zoeken). */
export function helpSections(data) {
  const out = [];
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
  for (const [id, page] of Object.entries(data.pages)) {
    for (const part of page.html.split(/(?=<h[123][\s>])/)) {
      const head = /^<(h[123])([^>]*)>([\s\S]*?)<\/\1>/.exec(part);
      if (!head) continue;
      const anchor = head[1] === 'h1' ? null : /\sid="([^"]+)"/.exec(head[2])?.[1] ?? null;
      out.push({ id, anchor, page: page.title, heading: text(head[3]), text: text(part.slice(head[0].length)) });
    }
  }
  return out;
}
