// Het script van de website: zoeken in de handleiding, de lijst met pagina's inklappen op een smal scherm, en een
// kopieerknop bij codeblokken. Zonder dit script werkt de site ook; alles hierboven is dan gewoon niet zichtbaar.
// Geen bibliotheken, geen verzoeken naar buiten: de zoekindex is een bestand van de site zelf.

const body = document.body;
const text = (key) => body.dataset[key] ?? '';

// ---------- codeblokken kopiëren ----------

if (navigator.clipboard) {
  for (const pre of document.querySelectorAll('pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = text('copy');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? '');
        button.textContent = text('copied');
        setTimeout(() => { button.textContent = text('copy'); }, 1600);
      } catch { /* geen toestemming: de tekst is nog gewoon te selecteren */ }
    });
    pre.append(button);
  }
}

// ---------- de lijst met pagina's ----------

const pageList = document.querySelector('.guide-nav-list');
if (pageList && matchMedia('(max-width: 900px)').matches) pageList.open = false;

// ---------- zoeken ----------

/** Kleine letters zonder accenten, zodat "één" ook "een" vindt en "Café" ook "cafe". */
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9#@/{}~]+/).filter(Boolean);

/** Het pad van `to` gezien vanaf de map van `from` (beide ten opzichte van de taalmap). */
function relative(from, to) {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
  return '../'.repeat(a.length) + b.join('/');
}

const form = document.querySelector('form.search');
if (form) {
  const input = form.querySelector('input');
  const list = form.querySelector('.search-results');
  const status = form.querySelector('.search-status');
  let index = null;
  let loading = null;

  const load = () => {
    loading ??= fetch(`${body.dataset.root}assets/search-${body.dataset.lang}.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((entries) => {
        index = entries.map((e) => ({ ...e, fh: fold(e.h), fp: fold(e.p), fx: fold(e.x) }));
      });
    return loading;
  };

  /** Elk zoekwoord moet voorkomen (als begin van een woord); een treffer in een kop telt zwaarder dan in de tekst. */
  function search(query) {
    const terms = words(query);
    if (terms.length === 0) return [];
    const hits = [];
    for (const e of index) {
      let score = 0;
      for (const term of terms) {
        const at = (hay) => {
          const i = hay.indexOf(term);
          return i < 0 ? 0 : i === 0 || /[^a-z0-9]/.test(hay[i - 1]) ? 2 : 1; // begin van een woord telt dubbel
        };
        const s = at(e.fh) * 6 + at(e.fp) * 3 + at(e.fx);
        if (s === 0) { score = 0; break; }
        // een stuk waarin het woord vaker voorkomt, gaat er meer over
        score += s + Math.min(e.fx.split(term).length - 1, 6) * 0.25;
      }
      // de woorden direct achter elkaar ("tweede dinsdag") is de beste treffer
      if (score > 0 && terms.length > 1 && (e.fh.includes(terms.join(' ')) || e.fx.includes(terms.join(' ')))) score += 8;
      if (score > 0) hits.push({ e, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 8).map((h) => h.e);
  }

  /** Een stukje van de tekst rond de eerste treffer, met de zoekwoorden gemarkeerd. Tekst gaat altijd als tekst de pagina in. */
  function snippet(entry, terms) {
    const span = document.createElement('span');
    span.className = 'hit-text';
    let start = -1;
    for (const term of terms) {
      const i = entry.fx.indexOf(term);
      if (i >= 0 && (start < 0 || i < start)) start = i;
    }
    if (start < 0 && !entry.x) return null;
    const from = Math.max(0, (start < 0 ? 0 : start) - 40);
    // Zonder accenten kan de tekst iets van lengte verschillen; voor een stukje voorbeeldtekst is dat nauwkeurig genoeg.
    const piece = entry.x.slice(from, from + 130);
    const folded = fold(piece);
    let pos = 0;
    const marks = [];
    for (const term of terms) for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + term.length)) marks.push([i, i + term.length]);
    marks.sort((a, b) => a[0] - b[0]);
    if (from > 0) span.append('… ');
    for (const [a, b] of marks) {
      if (a < pos) continue;
      span.append(piece.slice(pos, a));
      const mark = document.createElement('mark');
      mark.textContent = piece.slice(a, b);
      span.append(mark);
      pos = b;
    }
    span.append(piece.slice(pos), from + 130 < entry.x.length ? ' …' : '');
    return span;
  }

  function show(query) {
    const terms = words(query);
    list.replaceChildren();
    if (terms.length === 0) {
      list.hidden = true;
      status.textContent = '';
      return;
    }
    const results = search(query);
    list.hidden = false;
    if (results.length === 0) {
      const li = document.createElement('li');
      li.className = 'search-empty';
      li.textContent = form.dataset.none;
      list.append(li);
      status.textContent = form.dataset.none;
      return;
    }
    status.textContent = results.length === 1 ? form.dataset.one : form.dataset.many.replace('{n}', String(results.length));
    for (const entry of results) {
      const a = document.createElement('a');
      a.href = relative(body.dataset.page, entry.u);
      const title = document.createElement('span');
      title.className = 'hit-title';
      title.textContent = entry.h;
      if (entry.h !== entry.p) {
        const page = document.createElement('span');
        page.className = 'hit-page';
        page.textContent = entry.p;
        a.append(page);
      }
      a.append(title);
      const piece = snippet(entry, terms);
      if (piece) a.append(piece);
      const li = document.createElement('li');
      li.append(a);
      list.append(li);
    }
  }

  const run = () => {
    const query = input.value;
    load().then(() => {
      if (input.value === query) show(query);
    }, () => {
      list.hidden = false;
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'search-empty', textContent: form.dataset.failed }));
    });
  };

  form.hidden = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    list.querySelector('a')?.click(); // Enter opent het eerste resultaat
  });
  input.addEventListener('focus', () => { load().catch(() => {}); }, { once: true });
  input.addEventListener('input', run);
  form.addEventListener('keydown', (e) => {
    const links = [...list.querySelectorAll('a')];
    const at = links.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && links.length > 0) {
      e.preventDefault();
      links[Math.min(at + 1, links.length - 1)].focus();
    } else if (e.key === 'ArrowUp' && at >= 0) {
      e.preventDefault();
      (at === 0 ? input : links[at - 1]).focus();
    } else if (e.key === 'Escape' && (input.value || at >= 0)) {
      input.value = '';
      show('');
      input.focus();
    }
  });
  // "/" zet de cursor in het zoekveld (zoals op veel documentatiesites), behalve als je al aan het typen bent
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    e.preventDefault();
    if (pageList && !pageList.open && matchMedia('(max-width: 900px)').matches) input.scrollIntoView({ block: 'center' });
    input.focus();
  });
}
