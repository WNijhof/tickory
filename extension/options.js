// De instellingen: verbinden met de eigen server (adres, toestemming van de browser voor precies die host, inloggen met wachtwoord
// en zo nodig de tweede stap, of met een koppelcode uit de web-app), en uitloggen. De logica staat in core/connect.js.

import { createClient } from './core/api.js';
import { browserName, checkAddress, connectionFrom, deviceName, loginOptions, pairCodeInput } from './core/connect.js';
import { errorText } from './core/errors.js';
import { localize, msgFrom } from './core/i18n.js';

const ext = globalThis.browser ?? globalThis.chrome;
const msg = msgFrom((key, subs) => ext.i18n.getMessage(key, subs));
const $ = (id) => document.getElementById(id);
const browser = browserName({ extensionUrl: ext.runtime.getURL(''), userAgent: navigator.userAgent });

/** De poging die loopt: het gecontroleerde adres en de client voor die server, en het tussentoken van de tweede stap. */
let target = null;
let challenge = null;

const views = { server: $('server-view'), login: $('login-view'), connected: $('connected-view') };
function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function busy(button, on) {
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = msg('buttonBusy');
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

const say = (el, err, context) => { el.textContent = err ? errorText(err, msg, context) : ''; };

// ---- 1. het adres, en toestemming voor die host ----
$('server-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say($('server-error'));
  $('server-status').textContent = '';
  const check = checkAddress($('server').value);
  if (!check.ok) return say($('server-error'), { code: check.code });
  // De toestemming vragen vóór elke andere wachttijd: Firefox staat de vraag alleen toe als direct gevolg van de klik.
  let granted = false;
  try {
    granted = await ext.permissions.request({ origins: [check.pattern] });
  } catch { /* geweigerd of niet mogelijk */ }
  if (!granted) return say($('server-error'), { code: 'PERMISSION_DENIED' });
  const button = $('connect');
  busy(button, true);
  try {
    const client = createClient({ origin: check.address.origin });
    const methods = loginOptions(await client.methods());
    target = { ...check, client };
    showLogin(methods);
  } catch (err) {
    say($('server-error'), err, { https: check.address.https });
  } finally {
    busy(button, false);
  }
  return undefined;
});

function showLogin(methods) {
  $('login-heading').textContent = msg('loginHeading', [new URL(target.address.origin).host]);
  $('password-form').hidden = !methods.password;
  $('code-form').hidden = true;
  $('or').hidden = !methods.password;
  $('password-off').hidden = methods.password;
  $('password-off').textContent = methods.password ? '' : msg('passwordOff', [methods.sso ?? 'SSO']);
  say($('login-error'));
  show('login');
  (methods.password ? $('username') : $('pair-code')).focus();
}

$('other-server').addEventListener('click', () => {
  target = null;
  challenge = null;
  show('server');
  $('server').focus();
});

// ---- 2. inloggen: wachtwoord (en de tweede stap), of een koppelcode ----
$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say($('login-error'));
  const button = $('login');
  busy(button, true);
  try {
    const res = await target.client.login($('username').value.trim(), $('password').value, deviceName(browser, msg));
    $('password').value = '';
    if (res.two_factor_required) {
      challenge = res.challenge;
      $('password-form').hidden = true;
      $('code-form').hidden = false;
      $('code').value = '';
      $('code').focus();
    } else {
      await finish(res);
    }
  } catch (err) {
    say($('login-error'), err);
    $('password').value = '';
    $('password').focus();
  } finally {
    busy(button, false);
  }
});

function backToPassword() {
  challenge = null;
  $('code-form').hidden = true;
  $('password-form').hidden = false;
  $('password').focus();
}
$('code-back').addEventListener('click', () => { say($('login-error')); backToPassword(); });

$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say($('login-error'));
  const button = $('verify');
  busy(button, true);
  try {
    await finish(await target.client.loginCode(challenge, $('code').value.trim()));
  } catch (err) {
    say($('login-error'), err);
    if (err.code === 'CHALLENGE_EXPIRED') backToPassword();
    else {
      $('code').value = '';
      $('code').focus();
    }
  } finally {
    busy(button, false);
  }
});

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say($('login-error'));
  const code = pairCodeInput($('pair-code').value);
  if (!code) return say($('login-error'), { code: 'PAIR_CODE_FORMAT' });
  const button = $('pair');
  busy(button, true);
  try {
    await finish(await target.client.pair(code, deviceName(browser, msg)));
    $('pair-code').value = '';
  } catch (err) {
    say($('login-error'), err);
  } finally {
    busy(button, false);
  }
  return undefined;
});

/** Na een gelukte aanmelding: alleen in de lokale opslag van deze computer (niet gesynchroniseerd met andere computers). */
async function finish(result) {
  const connection = { ...connectionFrom(result, target.address, browser), inboxId: result.me?.inbox_project_id ?? null };
  await ext.storage.local.set({ connection });
  await ext.storage.local.remove(['lists', 'lastProject']);
  target = null;
  challenge = null;
  showConnected(connection);
}

// ---- 3. verbonden, en uitloggen ----
async function showConnected(connection) {
  $('connected-as').textContent = msg('connectedAs', [connection.origin, connection.user.name || connection.user.username, connection.user.username]);
  show('connected');
  try {
    const shortcut = (await ext.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut;
    $('shortcut').textContent = shortcut ? msg('shortcutNote', [shortcut]) : msg('shortcutNone');
  } catch {
    $('shortcut').textContent = '';
  }
}

$('logout').addEventListener('click', async () => {
  const button = $('logout');
  busy(button, true);
  const { connection } = await ext.storage.local.get('connection');
  let offline = false;
  try {
    if (connection?.token) await createClient({ origin: connection.origin, token: connection.token }).logout();
  } catch (err) {
    // een sessie die de server al niet meer kent, is al afgemeld; anders moet de gebruiker het in Tickory zelf doen
    offline = err.code !== 'UNAUTHORIZED';
  }
  await ext.storage.local.remove(['connection', 'lists', 'lastProject']);
  try {
    if (connection?.pattern) await ext.permissions.remove({ origins: [connection.pattern] });
  } catch { /* een vaste toestemming (zoals in de test) is niet weg te halen */ }
  busy(button, false);
  $('server').value = connection?.origin ?? '';
  show('server');
  $('server-status').textContent = msg(offline ? 'logoutOffline' : 'loggedOut');
});

async function main() {
  localize(document, msg);
  document.documentElement.lang = msg('lang');
  const { connection } = await ext.storage.local.get('connection');
  if (connection?.token) return showConnected(connection);
  $('server').value = connection?.origin ?? '';
  if (connection) $('server-error').textContent = msg('reconnect'); // het token is ingetrokken of verlopen
  show('server');
  $('server').focus();
  return undefined;
}

main();
