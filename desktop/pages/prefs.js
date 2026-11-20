// Het serveradres kiezen (bij de eerste start) en de instellingen van de desktop-app. Praat alleen via window.TickoryPages.
(async () => {
  const api = window.TickoryPages;
  const { mode, texts, settings, lang, accents } = await api.load();
  document.documentElement.lang = lang;
  const $ = (id) => document.getElementById(id);
  // het thema: licht/donker volgt Windows (de app zet dat om), de accentkleur staat als data-accent op de html (pages.css)
  const showAccent = (accent) => {
    if (accent && accent !== 'tomato') document.documentElement.dataset.accent = accent;
    else delete document.documentElement.dataset.accent;
  };
  showAccent(settings.appearance?.accent);
  for (const name of accents ?? []) {
    const option = document.createElement('option');
    option.value = name;
    option.dataset.t = `accent_${name}`;
    $('accent').append(option);
  }
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = texts[el.dataset.t] ?? el.dataset.t;

  if (mode === 'setup') {
    $('setup').hidden = false;
    if (settings.server) $('server').value = settings.server;
    $('server').focus();
    $('server-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('server-error').textContent = '';
      const button = e.submitter;
      if (button) button.disabled = true;
      const res = await api.setServer($('server').value);
      if (button) button.disabled = false;
      if (!res.ok) $('server-error').textContent = texts[`serverError_${res.error}`] ?? res.error;
    });
    return;
  }

  $('prefs').hidden = false;
  $('sc-quickadd').value = settings.shortcuts.quickAdd;
  $('sc-activate').value = settings.shortcuts.activate;
  $('open-at-login').checked = settings.openAtLogin;
  $('start-minimized').checked = settings.startMinimized;
  $('stay-in-tray').checked = settings.stayInTray;
  $('server-now').textContent = settings.server ?? '';
  const look = () => ({ theme: $('theme').value, accent: $('accent').value });
  const fill = (a) => {
    $('theme').value = a.theme;
    $('accent').value = a.accent;
    showAccent(a.accent);
  };
  fill(settings.appearance);
  // werkt meteen (zoals Weergave in de web-app), los van Bewaren
  for (const id of ['theme', 'accent']) {
    $(id).addEventListener('change', async () => {
      showAccent($('accent').value);
      await api.setAppearance(look());
    });
  }
  api.onAppearance?.(fill);
  $('close').addEventListener('click', () => api.close());
  $('prefs-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('prefs-error').textContent = '';
    const res = await api.save({
      shortcuts: { quickAdd: $('sc-quickadd').value.trim(), activate: $('sc-activate').value.trim() },
      openAtLogin: $('open-at-login').checked,
      startMinimized: $('start-minimized').checked,
      stayInTray: $('stay-in-tray').checked,
    });
    if (res.ok) api.close();
    else $('prefs-error').textContent = texts[res.error] ?? res.error;
  });
})();
