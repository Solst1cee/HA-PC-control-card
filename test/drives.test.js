import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

const driveStates = () => ({
  states: {
    'binary_sensor.nas': { state: 'on', last_changed: new Date().toISOString(), attributes: {} },
    'sensor.d1_status': { state: 'normal', attributes: {} },
    'sensor.d1_temp':   { state: '38', attributes: { unit_of_measurement: '°C' } },
    'sensor.d2_status': { state: 'crashed', attributes: {} },
    'sensor.d2_temp':   { state: '45', attributes: { unit_of_measurement: '°C' } },
  },
  callService() {},
});

test('feature renders one row per drive with health dot + temperature', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({
    variant: 'feature',
    status_entity: 'binary_sensor.nas',
    drives: [
      { status: 'sensor.d1_status', temp: 'sensor.d1_temp', name: 'Drive 1' },
      { status: 'sensor.d2_status', temp: 'sensor.d2_temp', name: 'Drive 2' },
    ],
  });
  card.hass = driveStates();
  assert.equal(card.shadowRoot.querySelectorAll('.drive').length, 2);
  const d1 = card.shadowRoot.querySelector('.drive[data-key="drive_0"]');
  assert.ok(d1.querySelector('.ddot').classList.contains('ok'));
  assert.equal(d1.querySelector('.dval').textContent, '38 °C');
  const d2 = card.shadowRoot.querySelector('.drive[data-key="drive_1"]');
  assert.ok(d2.querySelector('.ddot').classList.contains('bad'));
  card.disconnectedCallback();
});

test('chip renders a drives summary that goes red when a drive is unhealthy', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({
    variant: 'chip',
    status_entity: 'binary_sensor.nas',
    drives: [
      { status: 'sensor.d1_status', name: 'Drive 1' },
      { status: 'sensor.d2_status', name: 'Drive 2' },
    ],
  });
  card.hass = driveStates();
  const cell = card.shadowRoot.querySelector('.mini-stat[data-key="drives_summary"] .mval');
  assert.equal(cell.textContent, '1/2');
  assert.ok(cell.classList.contains('bad'));
  card.disconnectedCallback();
});

test('PC config (no drives) renders no drive rows and no summary', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({ variant: 'feature', status_entity: 'binary_sensor.pc' });
  card.hass = { states: { 'binary_sensor.pc': { state: 'on', last_changed: new Date().toISOString(), attributes: {} } }, callService() {} };
  assert.equal(card.shadowRoot.querySelectorAll('.drive').length, 0);
  card.disconnectedCallback();
});
