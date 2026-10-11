import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

const states = () => ({
  states: {
    'binary_sensor.nas': { state: 'on', last_changed: new Date().toISOString(), attributes: {} },
    'sensor.d1_status': { state: 'normal', attributes: {} },
    'sensor.d1_temp': { state: '38', attributes: { unit_of_measurement: '°C' } },
    'sensor.volume_used': { state: '2.1', attributes: { unit_of_measurement: 'TB' } },
    'sensor.volume_total': { state: '3.6', attributes: { unit_of_measurement: 'TB' } },
  },
  callService() {},
});

test('drives render only their health and temperature row', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({
    variant: 'feature',
    status_entity: 'binary_sensor.nas',
    drives: [{
      status: 'sensor.d1_status',
      temp: 'sensor.d1_temp',
      name: 'Drive 1',
      volumes: [{ entity: 'sensor.volume_used', total: 'sensor.volume_total', name: 'Volume 1' }],
    }],
  });
  card.hass = states();
  assert.ok(card.shadowRoot.querySelector('.drive[data-key="drive_0"]'));
  assert.equal(card.shadowRoot.querySelectorAll('.drive').length, 1);
  assert.equal(card.shadowRoot.querySelectorAll('[data-key^="dvol_"]').length, 0);
  assert.equal(card.shadowRoot.querySelector('.metrics').classList.contains('has-drive-volumes'), false);
  card.disconnectedCallback();
});

test('editor removes nested volumes from drive configuration', () => {
  const el = document.createElement('pc-control-card-editor');
  const cfg = {
    status_entity: 'binary_sensor.nas',
    drives: [{
      status: 'sensor.d1_status',
      temp: 'sensor.d1_temp',
      name: 'Drive 1',
      volumes: [{ entity: 'sensor.volume_used' }],
    }],
  };
  el.setConfig(cfg);
  const round = el._unflatten(el._flatten(cfg));
  assert.deepEqual(round.drives, [{
    status: 'sensor.d1_status',
    temp: 'sensor.d1_temp',
    name: 'Drive 1',
  }]);
});
