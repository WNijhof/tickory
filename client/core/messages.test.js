import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCommand, describeCommandError } from './messages.js';

test('welk soort handeling het was, in het Nederlands', () => {
  assert.equal(describeCommand('task_update'), 'taak wijzigen');
  assert.equal(describeCommand('label_add'), 'label toevoegen');
  assert.equal(describeCommand('task_complete'), 'taak afvinken');
  assert.equal(describeCommand('task_uncomplete'), 'taak heropenen');
  assert.equal(describeCommand('project_delete'), 'project verwijderen');
  assert.equal(describeCommand('task_move'), 'taak verplaatsen');
  assert.equal(describeCommand('comment_add'), 'opmerking toevoegen');
  assert.equal(describeCommand('onzin'), '');
  assert.equal(describeCommand(undefined), '');
});

test('elke foutcode geeft een Nederlandse melding zonder technische veldnamen', () => {
  const codes = ['NOT_FOUND', 'DUPLICATE', 'CYCLE', 'CONFLICT', 'ID_EXISTS', 'TOO_LARGE', 'UNKNOWN_COMMAND', 'INTERNAL', 'INVALID_ARG', 'MISSING_ARG', 'UNKNOWN_ARG', 'READONLY', 'IMMUTABLE'];
  for (const error_code of codes) {
    const text = describeCommandError({ cmd: { type: 'task_update' }, error_code, error: 'task.priority: moet een van 1, 2, 3, 4 zijn' });
    assert.match(text, /^Niet gelukt \(taak wijzigen\)\. /);
    assert.ok(!/task\.|priority|moet een van/.test(text), `${error_code} lekt technische tekst: ${text}`);
    assert.ok(text.endsWith('.'), text);
  }
  assert.equal(describeCommandError({ cmd: { type: 'task_update' }, error_code: 'NOT_FOUND' }), 'Niet gelukt (taak wijzigen). Dit bestaat niet meer; misschien is het op een ander apparaat verwijderd.');
  assert.equal(describeCommandError({ cmd: { type: 'label_add' }, error_code: 'DUPLICATE' }), 'Niet gelukt (label toevoegen). Er bestaat al een label met die naam.');
});

test('onbekende code: de tekst van de server blijft staan; zonder alles een nette standaardtekst', () => {
  assert.equal(describeCommandError({ cmd: { type: 'task_add' }, error_code: 'RARE_CODE', error: 'iets bijzonders' }), 'Niet gelukt (taak toevoegen). Iets bijzonders');
  assert.equal(describeCommandError({ error_code: 'RARE_CODE' }), 'Niet gelukt. De wijziging is niet doorgevoerd.');
  assert.equal(describeCommandError({}), 'Niet gelukt. De wijziging is niet doorgevoerd.');
});

test('delen: eigen zinnen, en de duidelijke melding van de server blijft staan', () => {
  assert.equal(describeCommand('project_share'), 'project delen');
  assert.equal(describeCommand('project_unshare'), 'iemand uit een project halen');
  assert.equal(describeCommand('project_leave'), 'project verlaten');
  assert.equal(
    describeCommandError({ cmd: { type: 'project_share' }, error_code: 'NOT_FOUND', error: 'deze gebruiker bestaat niet' }),
    'Niet gelukt (project delen). Deze gebruiker bestaat niet.',
  );
  assert.equal(
    describeCommandError({ cmd: { type: 'project_share' }, error_code: 'FORBIDDEN', error: 'alleen de eigenaar kan een project delen' }),
    'Niet gelukt (project delen). Alleen de eigenaar kan een project delen.',
  );
  // zonder melding van de server valt het terug op de algemene tekst
  assert.match(describeCommandError({ cmd: { type: 'project_leave' }, error_code: 'NOT_FOUND' }), /^Niet gelukt \(project verlaten\)\. Dit bestaat niet meer/);
  assert.equal(
    describeCommandError({ cmd: { type: 'label_update' }, error_code: 'FORBIDDEN', error: 'dit label is van iemand anders; je kunt het alleen lezen' }),
    'Niet gelukt (label wijzigen). Dit label is van iemand anders; je kunt het alleen lezen',
  );
});
