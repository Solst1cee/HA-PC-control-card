import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

const groupedStates = () => ({
  states: {
    'binary_sensor.nas': { state: 'on', last_changed: new Date().toISOString(), attributes: {} },
    'sensor.d1_status':  { state: 'normal', attributes: {} },
    'sensor.d1_temp':    { state: '38', attributes: { unit_of_measurement: '°C' } },
    'sensor.d1_v1_used':  { state: '2.1', attributes: { unit_of_measurement: 'TB' } },
    'sensor.d1_v1_total': { state: '3.6', attributes: { unit_of_measurement: 'TB' } },
    'sensor.d1_v2_used':  { state: '0.8', attributes: { unit_of_measurement: 'TB' } },
    'sensor.d1_v2_total': { state: '1.8', attributes: { unit_of_measurement: 'TB' } },
    'sensor.d2_status':  { state: 'normal', attributes: {} },
    'sensor.d2_temp':    { state: '41', attributes: { unit_of_measurement: '°C' } },
    'sensor.d2_v1_used':  { state: '1.0', attributes: { unit_of_measurement: 'TB' } },
    'sensor.d2_v1_total': { state: '2.0', attributes: { unit_of_measurement: 'TB' } },
  },
  callService() {},
});

const groupedDrives = () => [
  { status: 'sensor.d1_status', temp: 'sensor.d1_temp', name: 'Drive 1', volumes: [
    { entity: 'sensor.d1_v1_used', total: 'sensor.d1_v1_total', name: 'Volume 1' },
    { entity: 'sensor.d1_v2_used', total: 'sensor.d1_v2_total', name: 'Volume 2' },
  ] },
  { status: 'sensor.d2_status', temp: 'sensor.d2_temp', name: 'Drive 2', volumes: [
    { entity: 'sensor.d2_v1_used', total: 'sensor.d2_v1_total', name: 'Volume 1' },
  ] },
];

function featureCard(extra = {}) {
  const card = document.createElement('pc-control-card');
  card.setConfig({ variant: 'feature', status_entity: 'binary_sensor.nas', drives: groupedDrives(), ...extra });
  return card;
}

test('feature renders one group per drive with nested volume bars', () => {
  const card = featureCard();
  card.hass = groupedStates();
  const groups = card.shadowRoot.querySelectorAll('.drive-group');
  assert.equal(groups.length, 2);
  assert.ok(card.shadowRoot.querySelector('.metrics').classList.contains('has-drive-volumes'));

  const g0 = card.shadowRoot.querySelector('.drive-group[data-drive="0"]');
  assert.ok(g0.querySelector('.drive[data-key="drive_0"] .ddot').classList.contains('ok'));
  const v0 = g0.querySelector('.metric[data-key="dvol_0_0"]');
  assert.equal(v0.querySelector('.mval').textContent, '2.10 / 3.60 TB'); // fmtNum pads <10 to 2dp
  assert.ok(v0.querySelector('.fill').style.width.startsWith('58')); // 2.1/3.6 ≈ 58%
  assert.ok(v0.classList.contains('nested'));
  assert.ok(g0.querySelector('.metric[data-key="dvol_0_1"]'));

  const g1 = card.shadowRoot.querySelector('.drive-group[data-drive="1"]');
  assert.equal(g1.querySelectorAll('.metric').length, 1);
  assert.ok(g1.querySelector('.metric[data-key="dvol_1_0"]'));
  card.disconnectedCallback();
});

test('flat drives (no volumes) render health rows without grouping markers', () => {
  const card = document.createElement('pc-control-card');
  card.setConfig({ variant: 'feature', status_entity: 'binary_sensor.nas',
    drives: [{ status: 'sensor.d1_status', temp: 'sensor.d1_temp', name: 'Drive 1' }] });
  card.hass = groupedStates();
  assert.ok(!card.shadowRoot.querySelector('.metrics').classList.contains('has-drive-volumes'));
  assert.equal(card.shadowRoot.querySelectorAll('.metric.nested').length, 0);
  assert.ok(card.shadowRoot.querySelector('.drive[data-key="drive_0"]'));
  card.disconnectedCallback();
});

test('show_drives:false hides the drive groups', () => {
  const card = featureCard({ show_drives: false });
  card.hass = groupedStates();
  const g0 = card.shadowRoot.querySelector('.drive-group[data-drive="0"]');
  assert.equal(g0.style.display, 'none');
  card.disconnectedCallback();
});

test('off device blanks the nested volume bars', () => {
  const card = featureCard();
  const s = groupedStates();
  s.states['binary_sensor.nas'] = { state: 'off', last_changed: new Date().toISOString(), attributes: {} };
  card.hass = s;
  const v0 = card.shadowRoot.querySelector('.metric[data-key="dvol_0_0"]');
  assert.equal(v0.querySelector('.mval').textContent, '—');
  assert.equal(v0.querySelector('.fill').style.width, '0%');
  card.disconnectedCallback();
});

test('editor preserves nested drive volumes through flatten/unflatten', () => {
  const el = document.createElement('pc-control-card-editor');
  const cfg = { status_entity: 'binary_sensor.nas', drives: [
    { status: 'sensor.d1_status', name: 'Drive 1', volumes: [
      { entity: 'sensor.d1_v1_used', total: 'sensor.d1_v1_total', name: 'Volume 1' },
    ] },
  ] };
  el.setConfig(cfg);
  const round = el._unflatten(el._flatten(cfg));
  assert.deepEqual(round.drives[0].volumes, cfg.drives[0].volumes);
});
