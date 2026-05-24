import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { uptimeMsFromEntity, parseAction } from '../pc-control-card.js';

test('uptimeMsFromEntity: timestamp device_class', () => {
  const now = Date.UTC(2024, 0, 1, 12, 0, 0);
  const ent = { state: '2024-01-01T10:00:00+00:00', attributes: { device_class: 'timestamp' } };
  assert.equal(uptimeMsFromEntity(ent, now), 2 * 3600 * 1000);
});

test('uptimeMsFromEntity: ISO string without device_class', () => {
  const now = Date.UTC(2024, 0, 1, 12, 0, 0);
  const ent = { state: '2024-01-01T11:00:00+00:00', attributes: {} };
  assert.equal(uptimeMsFromEntity(ent, now), 3600 * 1000);
});

test('uptimeMsFromEntity: numeric seconds (no unit)', () => {
  const ent = { state: '3600', attributes: {} };
  assert.equal(uptimeMsFromEntity(ent, 0), 3600 * 1000);
});

test('uptimeMsFromEntity: unit-aware days', () => {
  const ent = { state: '2', attributes: { unit_of_measurement: 'd' } };
  assert.equal(uptimeMsFromEntity(ent, 0), 2 * 86400 * 1000);
});

test('uptimeMsFromEntity: unparseable / missing returns null', () => {
  assert.equal(uptimeMsFromEntity(undefined, 0), null);
  assert.equal(uptimeMsFromEntity({ state: 'unknown', attributes: {} }, 0), null);
});

test('parseAction infers button.press for a reboot button', () => {
  assert.deepEqual(parseAction('button.nas_reboot'), {
    entity: 'button.nas_reboot', domain: 'button', service: 'press',
  });
});
