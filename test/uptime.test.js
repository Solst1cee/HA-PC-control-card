import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

function makeCard(config) {
  const card = document.createElement('pc-control-card');
  card.setConfig(config);
  return card;
}

test('_uptime uses uptime_entity timestamp when present', () => {
  const card = makeCard({ status_entity: 'binary_sensor.nas', uptime_entity: 'sensor.nas_uptime' });
  const now = Date.now();
  card.hass = {
    states: {
      'binary_sensor.nas': { state: 'on', last_changed: new Date(now - 60_000).toISOString(), attributes: {} },
      'sensor.nas_uptime': { state: new Date(now - 2 * 86400 * 1000).toISOString(), attributes: { device_class: 'timestamp' } },
    },
    callService() {},
  };
  assert.equal(card._uptime(), '2d 0h 0m');
  card.disconnectedCallback();
});

test('_uptime falls back to status last_changed when uptime_entity absent', () => {
  const card = makeCard({ status_entity: 'binary_sensor.nas' });
  const now = Date.now();
  card.hass = {
    states: { 'binary_sensor.nas': { state: 'on', last_changed: new Date(now - 3 * 3600 * 1000).toISOString(), attributes: {} } },
    callService() {},
  };
  assert.equal(card._uptime(), '3h 0m');
  card.disconnectedCallback();
});
