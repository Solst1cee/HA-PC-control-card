import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

const editor = () => document.createElement('pc-control-card-editor');

test('unflatten builds a drives array from flat fields', () => {
  const out = editor()._unflatten({
    status_entity: 'binary_sensor.nas',
    _drive_1_status: 'sensor.d1_status',
    _drive_1_temp: 'sensor.d1_temp',
    _drive_1_name: 'Drive 1',
    _drive_2_status: 'sensor.d2_status',
  });
  assert.deepEqual(out.drives, [
    { status: 'sensor.d1_status', temp: 'sensor.d1_temp', name: 'Drive 1' },
    { status: 'sensor.d2_status' },
  ]);
  assert.equal(out._drive_1_status, undefined);
});

test('flatten spreads a drives array into flat fields', () => {
  const flat = editor()._flatten({ status_entity: 'binary_sensor.nas', drives: [{ status: 'sensor.d1_status', name: 'Drive 1' }] });
  assert.equal(flat._drive_1_status, 'sensor.d1_status');
  assert.equal(flat._drive_1_name, 'Drive 1');
  assert.equal(flat._drive_2_status, undefined);
});

test('restart + uptime + icon keys survive the flatten/unflatten round-trip', () => {
  const cfg = {
    status_entity: 'binary_sensor.nas',
    uptime_entity: 'sensor.nas_uptime',
    restart: 'button.nas_reboot',
    show_restart: true,
    confirm_restart: false,
    icon: 'nas',
  };
  const round = editor()._unflatten(editor()._flatten(cfg));
  assert.equal(round.uptime_entity, 'sensor.nas_uptime');
  assert.equal(round.restart, 'button.nas_reboot');
  assert.equal(round.show_restart, true);
  assert.equal(round.confirm_restart, false);
  assert.equal(round.icon, 'nas');
});
