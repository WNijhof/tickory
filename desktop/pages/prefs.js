// Het serveradres kiezen (bij de eerste start) en de instellingen van de desktop-app. Praat alleen via window.TickoryPages.
(async () => {
  const api = window.TickoryPages;
  const { mode, texts, settings, lang } = await api.load();
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = texts[el.dataset.t] ?? el.dataset.t;
  const $ = (id) => document.getElementById(id);

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
