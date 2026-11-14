// Het scherm "Plaatsen": de plaatsen waarop je een herinnering kunt zetten ("herinner me als ik bij Thuis aankom"), en,
// in de Android-app, de status van de locatiecontrole.
//
// Privacy: een plaats is alleen van jou (privé, ook in een gedeeld project). Je positie wordt alleen op je toestel met je
// plaatsen vergeleken; de server en de browser krijgen die nooit te zien.

import { PLACE_RADIUS_DEFAULT, PLACE_RADIUS_PRESETS, formatDistance, parseCoordinates } from '../../shared/places.js';
import { androidBridge } from '../core/android.js';
import { t, getLanguage } from '../core/i18n.js';
import { PositionError, currentPosition, formatCoordinates, locationAdvice, placeProblem, placeRows, remindersAtPlace, roundCoordinate } from '../core/places.js';
import { h, confirmDialog, openDialog, replace } from './dom.js';

const decimal = () => (getLanguage() === 'nl' ? ',' : '.');
const toNumber = (text) => (String(text).trim() === '' ? NaN : Number(String(text).trim().replace(',', '.')));

const when = (ms) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
};

/** Een mislukte positiebepaling als tekst. */
export function positionErrorText(err) {
  switch (err instanceof PositionError ? err.code : 'unavailable') {
    case 'denied': return t('places.positionDenied');
    case 'timeout': return t('places.positionTimeout');
    case 'unsupported': return t('places.positionUnsupported');
    default: return t('places.positionUnavailable');
  }
}

/** De uitleg bij de toestand van de locatiecontrole op dit toestel. */
export function adviceText(advice, status) {
  if (advice === 'off') return status?.declined ? t('places.android.declined') : t('places.android.off');
  if (advice === 'services') return t('places.android.services');
  if (advice === 'permission') return status?.approximate ? t('places.android.approximate') : t('places.android.permission');
  if (advice === 'background') return t('places.android.background');
  return status?.needed ? t('places.android.okNeeded') : t('places.android.okIdle');
}

/**
 * @param {{ store: object, actions: object, bridge?: ReturnType<typeof androidBridge> }} options
 * @returns {Promise<unknown>} sluit als het venster sluit
 */
export function placesDialog({ store, actions, bridge = androidBridge() }) {
  let unsubscribe = () => {};
  let onStatus = () => {};
  return openDialog((finish) => {
    // ---------- het formulier ----------
    let editingId = null;
    const nameInput = h('input', { class: 'field', type: 'text', maxlength: '100', 'aria-label': t('places.name'), placeholder: t('places.namePlaceholder'), autocomplete: 'off', dataset: { role: 'place-name' } });
    const here = h('button', { type: 'button', class: 'button', dataset: { role: 'place-here' } }, t('places.useHere'));
    const hereNote = h('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const paste = h('input', { class: 'field', type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': t('places.paste'), placeholder: t('places.pastePlaceholder'), dataset: { role: 'place-paste' } });
    const latInput = h('input', { class: 'field', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('places.lat'), placeholder: '52.09070', dataset: { role: 'place-lat' } });
    const lonInput = h('input', { class: 'field', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('places.lon'), placeholder: '5.12140', dataset: { role: 'place-lon' } });
    const radiusSelect = h('select', { class: 'field', 'aria-label': t('places.radius'), dataset: { role: 'place-radius' } });
    const error = h('p', { class: 'hint hint-bad', role: 'alert', dataset: { role: 'place-error' } });
    const save = h('button', { type: 'submit', class: 'button button-primary', dataset: { role: 'place-save' } });
    const cancel = h('button', { type: 'button', class: 'button', hidden: true }, t('common.cancel'));
    const formTitle = h('h3', { class: 'subheading' });

    const fillRadius = (value) => {
      const values = [...new Set([...PLACE_RADIUS_PRESETS, value])].sort((a, b) => a - b);
      replace(radiusSelect, values.map((v) => h('option', { value: String(v), selected: v === value }, `${v} m`)));
      radiusSelect.value = String(value);
    };
    const resetForm = () => {
      editingId = null;
      nameInput.value = '';
      paste.value = '';
      latInput.value = '';
      lonInput.value = '';
      hereNote.textContent = '';
      error.textContent = '';
      fillRadius(PLACE_RADIUS_DEFAULT);
      formTitle.textContent = t('places.add');
      save.textContent = t('places.addButton');
      cancel.hidden = true;
    };
    const edit = (place) => {
      editingId = place.id;
      nameInput.value = place.name;
      paste.value = '';
      latInput.value = String(roundCoordinate(place.lat));
      lonInput.value = String(roundCoordinate(place.lon));
      hereNote.textContent = '';
      error.textContent = '';
      fillRadius(place.radius);
      formTitle.textContent = t('places.edit');
      save.textContent = t('places.saveButton');
      cancel.hidden = false;
      nameInput.focus();
    };
    cancel.addEventListener('click', resetForm);

    const setPosition = ({ lat, lon }) => {
      latInput.value = String(roundCoordinate(lat));
      lonInput.value = String(roundCoordinate(lon));
    };
    here.addEventListener('click', async () => {
      error.textContent = '';
      hereNote.textContent = t('places.positionBusy');
      here.disabled = true;
      try {
        const p = await currentPosition({ bridge });
        setPosition(p);
        hereNote.textContent = p.accuracy === null ? t('places.positionDone') : t('places.positionDoneAccuracy', { accuracy: formatDistance(p.accuracy, decimal()) });
        if (!nameInput.value.trim()) nameInput.focus();
      } catch (err) {
        hereNote.textContent = '';
        error.textContent = positionErrorText(err);
      } finally {
        here.disabled = false;
      }
    });
    const readPaste = () => {
      const text = paste.value.trim();
      if (!text) { error.textContent = ''; return; }
      const found = parseCoordinates(text);
      if (found) {
        setPosition(found);
        error.textContent = '';
        hereNote.textContent = t('places.pasteDone');
      } else {
        error.textContent = t('places.pasteInvalid');
      }
    };
    paste.addEventListener('change', readPaste);
    paste.addEventListener('input', () => { if (parseCoordinates(paste.value)) readPaste(); });

    const submit = async (e) => {
      e.preventDefault();
      error.textContent = '';
      const values = { name: nameInput.value, lat: toNumber(latInput.value), lon: toNumber(lonInput.value), radius: Number(radiusSelect.value) };
      const problem = placeProblem(values);
      if (problem) {
        error.textContent = problem === 'name' ? t('places.problemName') : problem === 'coordinates' ? t('places.problemCoordinates') : t('places.problemRadius');
        (problem === 'name' ? nameInput : problem === 'coordinates' ? latInput : radiusSelect).focus();
        return;
      }
      const clean = { ...values, lat: roundCoordinate(values.lat), lon: roundCoordinate(values.lon) };
      if (editingId) await actions.updatePlace(editingId, clean);
      else await actions.addPlace(clean);
      resetForm();
    };

    // ---------- de lijst ----------
    const list = h('ul', { class: 'device-list', dataset: { role: 'place-list' } });
    const drawList = () => {
      const rows = placeRows(store.view, store.userId, bridge.available ? bridge.locationStatus() : null);
      replace(list, rows.length > 0
        ? rows.map(({ place, distance, inside }) => h('li', { class: 'device', dataset: { place: place.id } },
          h('span', { class: 'device-info' },
            h('strong', {}, place.name),
            h('span', { class: 'hint' }, [`${place.radius} m`, formatCoordinates(place.lat, place.lon),
              inside === true ? t('places.insideNow') : distance !== null ? t('places.distanceNow', { distance: formatDistance(distance, decimal()) }) : null].filter(Boolean).join(' · '))),
          h('span', { class: 'device-buttons' },
            h('button', { type: 'button', class: 'button button-small', 'aria-label': `${t('places.editLabel')}: ${place.name}`, onclick: () => edit(place) }, t('places.editButton')),
            h('button', { type: 'button', class: 'button button-small', 'aria-label': `${t('places.remove')}: ${place.name}`, onclick: () => removePlace(place) }, '×'))))
        : [h('li', { class: 'hint' }, t('places.none'))]);
    };
    const removePlace = async (place) => {
      const n = remindersAtPlace(store.view, place.id, store.userId);
      const ok = await confirmDialog({ title: t('places.deleteTitle'), text: n > 0 ? t('places.deleteTextReminders', { name: place.name, count: n }) : t('places.deleteText', { name: place.name }) });
      if (!ok) return;
      if (editingId === place.id) resetForm();
      await actions.deletePlace(place.id);
    };

    // ---------- de locatiecontrole (alleen in de Android-app) ----------
    const device = h('div', { class: 'section-form', dataset: { role: 'location-status' } });
    const drawDevice = () => {
      if (!bridge.available) {
        replace(device, h('p', { class: 'hint', dataset: { role: 'browser-note' } }, t('places.browserNote')));
        return;
      }
      const status = bridge.locationStatus();
      const advice = locationAdvice(status);
      const buttons = [];
      if (advice === 'off') {
        buttons.push(h('button', { type: 'button', class: 'button button-primary', onclick: () => bridge.requestLocationPermission() }, t('places.android.turnOn')));
        // Eerder geweigerd: Android vraagt dan soms niet meer, en alleen de instellingen van de app helpen.
        if (status?.declined) buttons.push(h('button', { type: 'button', class: 'button', onclick: () => bridge.openLocationSettings() }, t('places.android.openSettings')));
      } else {
        if (advice === 'permission' || advice === 'background') buttons.push(h('button', { type: 'button', class: 'button button-primary', onclick: () => (status?.declined ? bridge.openLocationSettings() : bridge.requestLocationPermission()) }, status?.declined ? t('places.android.openSettings') : t('places.android.grant')));
        if (advice === 'services') buttons.push(h('button', { type: 'button', class: 'button', onclick: () => bridge.openLocationSettings() }, t('places.android.openSettings')));
        buttons.push(h('button', { type: 'button', class: 'button', dataset: { role: 'check-now' }, onclick: () => { bridge.checkLocationNow(); } }, t('places.android.checkNow')));
        buttons.push(h('button', { type: 'button', class: 'button', onclick: () => { bridge.setLocationEnabled(false); drawDevice(); } }, t('places.android.turnOff')));
      }
      const lines = [];
      if (status?.enabled) {
        lines.push(status.lastCheckAt ? t('places.android.lastCheck', { when: when(status.lastCheckAt) }) : t('places.android.neverChecked'));
        if (status.lastFixAt && Number.isFinite(status.accuracy)) lines.push(t('places.android.accuracy', { accuracy: formatDistance(status.accuracy, decimal()) }));
        if (status.hasGps === false) lines.push(t('places.android.noGps'));
      }
      replace(device,
        h('p', { class: 'hint' }, t('places.android.info')),
        h('p', { role: 'status', dataset: { role: 'location-advice' } }, adviceText(advice, status)),
        lines.length > 0 && h('p', { class: 'hint', dataset: { role: 'location-lines' } }, lines.join(' · ')),
        h('div', { class: 'dialog-buttons dialog-buttons-start' }, buttons));
    };
    onStatus = () => { drawDevice(); drawList(); };
    window.addEventListener('tickory-android-status', onStatus);

    unsubscribe = store.subscribe(drawList);
    resetForm();
    drawList();
    drawDevice();

    return h('div', { class: 'dialog-form places-dialog' },
      h('h2', {}, t('places.title')),
      h('p', { class: 'hint' }, t('places.privacy')),
      h('details', { class: 'section', open: true }, h('summary', {}, t('places.mine')), list),
      h('details', { class: 'section', open: true }, h('summary', {}, t('places.formTitle')),
        h('form', { class: 'section-form', onsubmit: submit, novalidate: true },
          formTitle,
          h('label', { class: 'field-label' }, t('places.name'), nameInput),
          h('div', { class: 'reminder-add' }, here, hereNote),
          h('label', { class: 'field-label' }, t('places.paste'), paste, h('span', { class: 'hint' }, t('places.pasteHint'))),
          h('div', { class: 'places-coords' },
            h('label', { class: 'field-label' }, t('places.lat'), latInput),
            h('label', { class: 'field-label' }, t('places.lon'), lonInput)),
          h('label', { class: 'field-label' }, t('places.radius'), radiusSelect, h('span', { class: 'hint' }, t('places.radiusHint'))),
          error,
          h('div', { class: 'dialog-buttons' }, cancel, save))),
      h('details', { class: 'section', open: true }, h('summary', {}, t('places.android.title')), device),
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true, onClose: () => { unsubscribe(); window.removeEventListener('tickory-android-status', onStatus); } });
}
