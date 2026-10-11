import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

function nasCard(extra = {}) {
  const card = document.createElement('pc-control-card');
  card.setConfig({
    variant: 'feature',
    status_entity: 'binary_sensor.nas',
    turn_on: 'switch.nas_wol',
    restart: 'button.nas_reboot',
    shutdown: 'button.nas_shutdown',
    confirm_restart: false,
    ...extra,
  });
  return card;
}

const onHass = (calls = []) => ({
  states: { 'binary_sensor.nas': { state: 'on', last_changed: new Date().toISOString(), attributes: {} } },
  callService: (d, s, data) => calls.push([d, s, data]),
});

test('restart button visible when restart action is configured', () => {
  const card = nasCard();
  card.hass = onHass();
  assert.equal(card.shadowRoot.querySelector('.btn-restart').style.display, '');
  card.disconnectedCallback();
});

test('restart button hidden by default (PC config)', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({ variant: 'feature', status_entity: 'binary_sensor.pc', sleep: 'button.pc_sleep' });
  card.hass = { states: { 'binary_sensor.pc': { state: 'on', last_changed: new Date().toISOString(), attributes: {} } }, callService() {} };
  assert.equal(card.shadowRoot.querySelector('.btn-restart').style.display, 'none');
  card.disconnectedCallback();
});

test('pressing restart calls reboot service and enters restarting state', () => {
  const card = nasCard();
  const calls = [];
  card.hass = onHass(calls);
  card._onRestart();
  assert.deepEqual(calls, [['button', 'press', { entity_id: 'button.nas_reboot' }]]);
  assert.equal(card._derivedStatus(), 'restarting');
  card.disconnectedCallback();
});

test('restarting clears after status dips then returns to on', () => {
  const card = nasCard();
  const base = (st) => ({ states: { 'binary_sensor.nas': { state: st, last_changed: new Date().toISOString(), attributes: {} } }, callService() {} });
  card.hass = base('on');
  card._onRestart();
  assert.equal(card._derivedStatus(), 'restarting');
  card.hass = base('off');  // reboot takes it down
  assert.equal(card._derivedStatus(), 'restarting');
  card.hass = base('on');   // back up
  assert.equal(card._derivedStatus(), 'on');
  card.disconnectedCallback();
});

test('confirm_restart arms on first press, fires on second', () => {
  const card = nasCard({ confirm_restart: true });
  const calls = [];
  card.hass = onHass(calls);
  card._onRestart();                            // first press → arm only
  assert.equal(calls.length, 0);
  assert.equal(card._armed.restart, true);
  assert.equal(card._derivedStatus(), 'on');    // not yet restarting
  card._onRestart();                            // second press → fire
  assert.deepEqual(calls, [['button', 'press', { entity_id: 'button.nas_reboot' }]]);
  assert.equal(card._derivedStatus(), 'restarting');
  card.disconnectedCallback();
});

test('restarting keeps waiting when the dip is never seen before the timeout', () => {
  const card = nasCard();
  const base = (st) => ({ states: { 'binary_sensor.nas': { state: st, last_changed: new Date().toISOString(), attributes: {} } }, callService() {} });
  card.hass = base('on');
  card._onRestart();
  assert.equal(card._derivedStatus(), 'restarting');
  assert.ok(card._pendingTimer);
  card.disconnectedCallback();
});

test('restarting clears when the status returns on after an unseen state update', () => {
  const card = nasCard();
  const base = (st, changedAt) => ({
    states: {
      'binary_sensor.nas': {
        state: st,
        last_changed: new Date(changedAt).toISOString(),
        attributes: {},
      },
    },
    callService() {},
  });
  const beforeAction = Date.now() - 1_000;
  card.hass = base('on', beforeAction);
  card._onRestart();
  assert.equal(card._derivedStatus(), 'restarting');
  card.hass = base('on', Date.now() + 1_000);
  assert.equal(card._derivedStatus(), 'on');
  card.disconnectedCallback();
});

test('restarting clears when the status stays on after the confirmation delay', () => {
  const card = nasCard();
  const base = () => ({
    states: {
      'binary_sensor.nas': {
        state: 'on',
        last_changed: new Date().toISOString(),
        attributes: {},
      },
    },
    callService() {},
  });
  card.hass = base();
  card._onRestart();
  card._pendingSince = Date.now() - 3_001;
  card.hass = base();
  assert.equal(card._derivedStatus(), 'on');
  card.disconnectedCallback();
});

test('timeout errors use alert styling on the whole card', () => {
  const card = nasCard();
  card.hass = onHass();
  card._showActionError('restart_timeout');
  card._update();
  assert.equal(card._derivedStatus(), 'restart_timeout');
  assert.match(card.shadowRoot.querySelector('.status .label').textContent, /Restart timeout/);
  assert.equal(card.shadowRoot.querySelector('.card').classList.contains('action-error'), true);
  assert.match(card.shadowRoot.querySelector('style').textContent, /spcCardError/);
  card.disconnectedCallback();
});
