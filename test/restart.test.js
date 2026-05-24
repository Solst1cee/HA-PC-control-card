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
    show_sleep: false,
    show_restart: true,
    confirm_restart: false,
    ...extra,
  });
  return card;
}

const onHass = (calls = []) => ({
  states: { 'binary_sensor.nas': { state: 'on', last_changed: new Date().toISOString(), attributes: {} } },
  callService: (d, s, data) => calls.push([d, s, data]),
});

test('restart button visible when show_restart is true', () => {
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
