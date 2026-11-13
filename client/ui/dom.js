// Kleine hulpmiddelen voor de interface. Tekst van de gebruiker gaat altijd als tekst het document in
// (nooit als HTML), zodat een taaknaam nooit code kan uitvoeren.

/**
 * Maakt een element. Eigenschappen die met "on" beginnen zijn gebeurtenissen; `class` en `dataset` spreken voor zich.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...(Node | string | null | undefined | false | (Node | string | null | undefined | false)[])} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

/** Meldingen onderin beeld, optioneel met een knop (bijvoorbeeld "Ongedaan maken"). */
export function toast(message, { action = null, timeout = 6000, kind = 'info' } = {}) {
  const host = document.getElementById('toasts');
  const close = () => el.remove();
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' },
    h('span', { class: 'toast-text' }, message),
    action && h('button', { class: 'toast-action', type: 'button', onclick: () => { close(); action.run(); } }, action.label),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Sluiten', onclick: close }, '×'),
  );
  host.append(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

/** Opent een dialoogvenster en geeft de uitkomst terug zodra het sluit. Het venster wordt daarna opgeruimd. */
function openDialog(build) {
  return new Promise((resolve) => {
    let outcome = null;
    const dialog = h('dialog', { class: 'dialog' });
    const finish = (value) => {
      outcome = value;
      dialog.close();
    };
    dialog.append(build(finish));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Vraagt om één regel tekst. Geeft de tekst terug, of null bij annuleren. */
export function promptDialog({ title, label, value = '', okText = 'Opslaan', placeholder = '', type = 'text', hint = '' }) {
  return openDialog((finish) => {
    const input = h('input', { type, value, placeholder, required: true, class: 'field', 'aria-label': label, autocomplete: 'off' });
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text) finish(text);
      },
    },
    h('h2', {}, title),
    h('label', { class: 'field-label' }, label, input),
    hint && h('p', { class: 'hint' }, hint),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, 'Annuleren'),
      h('button', { type: 'submit', class: 'button button-primary' }, okText),
    ));
  });
}

/** Vraagt om bevestiging. Geeft true of false terug. */
export function confirmDialog({ title, text, okText = 'Verwijderen', danger = true }) {
  return openDialog((finish) =>
    h('div', { class: 'dialog-form' },
      h('h2', {}, title),
      h('p', {}, text),
      h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'button', onclick: () => finish(false) }, 'Annuleren'),
        h('button', { type: 'button', class: `button ${danger ? 'button-danger' : 'button-primary'}`, onclick: () => finish(true) }, okText),
      ),
    )).then(Boolean);
}

/** Keuzemenu als dialoog: een lijst knoppen. Geeft de gekozen waarde terug, of null. */
export function menuDialog({ title, items }) {
  return openDialog((finish) =>
    h('div', { class: 'dialog-form' },
      h('h2', {}, title),
      h('div', { class: 'menu' }, items.map((item) =>
        h('button', { type: 'button', class: `menu-item ${item.danger ? 'menu-danger' : ''}`, onclick: () => finish(item.value) }, item.label))),
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, 'Sluiten')),
    ));
}
