// Tests for the pure metric/storage value resolver+formatter.
// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeMetricDisplay, PcControlCard } from '../pc-control-card.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// A HASS.Agent storage entity: state is the volume LABEL (a string),
// the usable numbers live in attributes.
const haAgentDisk = () => ({
  state: 'Windows',
  attributes: {
    Name: 'C', Label: 'Windows', FileSystem: 'NTFS',
    TotalSizeMB: 953674, AvailableSpaceMB: 476837, UsedSpaceMB: 476837,
    AvailableSpacePercentage: 50, UsedSpacePercentage: 50,
  },
});

// ── New behavior ────────────────────────────────────────────────────

test('auto-detects HASS.Agent UsedSpacePercentage when state is non-numeric', () => {
  const r = computeMetricDisplay(haAgentDisk(), null, { autoDetect: true });
  assert.deepEqual(r, { displayValue: '50%', compactValue: '50%', barPct: 50 });
});

test('reads an explicit attribute instead of state', () => {
  const r = computeMetricDisplay(haAgentDisk(), null, { attribute: 'UsedSpacePercentage' });
  assert.deepEqual(r, { displayValue: '50%', compactValue: '50%', barPct: 50 });
});

test('reads value and total from attributes on the same entity', () => {
  const r = computeMetricDisplay(haAgentDisk(), null, {
    attribute: 'UsedSpaceMB',
    totalAttribute: 'TotalSizeMB',
    totalConfigured: true,
  });
  assert.equal(r.displayValue, '476837 / 953674');
  assert.equal(r.compactValue, '476837');
  assert.equal(r.barPct, 50);
});

test('explicit attribute overrides auto-detect', () => {
  // AvailableSpacePercentage is also 50 here; use a distinct value to prove
  // the explicit attribute wins rather than the auto-detected one.
  const ent = haAgentDisk();
  ent.attributes.AvailableSpacePercentage = 73;
  const r = computeMetricDisplay(ent, null, { attribute: 'AvailableSpacePercentage', autoDetect: true });
  assert.equal(r.displayValue, '73%');
});

test('an explicit MB unit auto-scales used/total up to GB', () => {
  const r = computeMetricDisplay(haAgentDisk(), null, {
    attribute: 'UsedSpaceMB', totalAttribute: 'TotalSizeMB', totalConfigured: true, unit: 'MB',
  });
  assert.equal(r.displayValue, '466 / 931 GB');
  assert.equal(r.compactValue, '466 GB');
  assert.equal(r.barPct, 50);
});

test('an explicit unit scales a single value (no total) and shows no bar', () => {
  const r = computeMetricDisplay(haAgentDisk(), null, { attribute: 'UsedSpaceMB', unit: 'MB' });
  assert.deepEqual(r, { displayValue: '466 GB', compactValue: '466 GB', barPct: null });
});

test('scaling climbs two steps to TB when the value is large enough', () => {
  const ent = { state: 'x', attributes: { U: 1000000, T: 2000000 } };
  const r = computeMetricDisplay(ent, null, { attribute: 'U', totalAttribute: 'T', totalConfigured: true, unit: 'MB' });
  assert.equal(r.displayValue, '0.95 / 1.91 TB');
});

test('a unit whose values are below 1024 is left at that unit', () => {
  const used = { state: '6.8', attributes: {} };
  const total = { state: '16', attributes: {} };
  const r = computeMetricDisplay(used, total, { totalConfigured: true, unit: 'GB' });
  assert.equal(r.displayValue, '6.80 / 16.0 GB');
});

// ── Preserved (characterization) behavior ───────────────────────────

test('numeric state renders as a percent with the bar set', () => {
  const cpu = { state: '42', attributes: { unit_of_measurement: '%' } };
  const r = computeMetricDisplay(cpu, null, {});
  assert.deepEqual(r, { displayValue: '42%', compactValue: '42%', barPct: 42 });
});

test('value with a separate total entity renders used / total', () => {
  const used = { state: '6.8', attributes: { unit_of_measurement: 'GB' } };
  const total = { state: '16', attributes: {} };
  const r = computeMetricDisplay(used, total, { totalConfigured: true });
  assert.equal(r.displayValue, '6.80 / 16.0 GB');
  assert.equal(r.compactValue, '6.80 GB');
  assert.equal(r.barPct, 42.5);
});

test('total configured but unavailable falls back to the single value, no bar', () => {
  const used = { state: '6.8', attributes: { unit_of_measurement: 'GB' } };
  const r = computeMetricDisplay(used, null, { totalConfigured: true });
  assert.deepEqual(r, { displayValue: '6.80 GB', compactValue: '6.80 GB', barPct: null });
});

test('non-numeric state with no attribute and no auto-detect returns null', () => {
  const r = computeMetricDisplay({ state: 'Windows', attributes: {} }, null, {});
  assert.equal(r, null);
});

test('auto-detect with no matching attribute returns null', () => {
  const r = computeMetricDisplay({ state: 'unknown', attributes: {} }, null, { autoDetect: true });
  assert.equal(r, null);
});

test('a missing entity returns null', () => {
  assert.equal(computeMetricDisplay(null, null, {}), null);
});

// ── Card wiring (_normalizeStorages + _metricValue) ─────────────────

const normalize = (config) => PcControlCard.prototype._normalizeStorages.call({ _config: config });
const metricValue = (ctx, key) => PcControlCard.prototype._metricValue.call(ctx, key);

test('_normalizeStorages carries attribute / total_attribute / unit and defaults the name', () => {
  const out = normalize({ metrics: { storages: [
    { entity: 'sensor.a', attribute: 'UsedSpacePercentage' },
    { entity: 'sensor.b', total_attribute: 'TotalSizeMB', name: 'Data' },
    { entity: 'sensor.c', attribute: 'UsedSpaceMB', total_attribute: 'TotalSizeMB', unit: 'MB', name: 'OS' },
    { bogus: true }, // no entity → filtered out
  ] } });
  assert.deepEqual(out, [
    { entity: 'sensor.a', attribute: 'UsedSpacePercentage', total: null, totalAttribute: null, unit: null, name: 'Disk' },
    { entity: 'sensor.b', attribute: null, total: null, totalAttribute: 'TotalSizeMB', unit: null, name: 'Data' },
    { entity: 'sensor.c', attribute: 'UsedSpaceMB', total: null, totalAttribute: 'TotalSizeMB', unit: 'MB', name: 'OS' },
  ]);
});

test('_metricValue auto-detects a HASS.Agent storage entity (storage_0)', () => {
  const ctx = {
    _config: { metrics: {} },
    _storages: [{ entity: 'sensor.pc_storage_c', attribute: null, total: null, totalAttribute: null, name: 'C:' }],
    _hass: { states: { 'sensor.pc_storage_c': haAgentDisk() } },
  };
  assert.deepEqual(metricValue(ctx, 'storage_0'),
    { displayValue: '50%', compactValue: '50%', barPct: 50 });
});

test('_metricValue resolves a non-zero storage index and explicit attribute', () => {
  const disk = haAgentDisk();
  disk.attributes.UsedSpacePercentage = 88;
  const ctx = {
    _config: { metrics: {} },
    _storages: [
      { entity: 'sensor.c', attribute: null, total: null, totalAttribute: null, name: 'C:' },
      { entity: 'sensor.d', attribute: 'UsedSpacePercentage', total: null, totalAttribute: null, name: 'D:' },
    ],
    _hass: { states: { 'sensor.d': disk } },
  };
  assert.equal(metricValue(ctx, 'storage_1').displayValue, '88%');
});

test('_metricValue scales a storage entry that declares a unit', () => {
  const ctx = {
    _config: { metrics: {} },
    _storages: [{ entity: 'sensor.c', attribute: 'UsedSpaceMB', total: null, totalAttribute: 'TotalSizeMB', unit: 'MB', name: 'C:' }],
    _hass: { states: { 'sensor.c': haAgentDisk() } },
  };
  assert.equal(metricValue(ctx, 'storage_0').displayValue, '466 / 931 GB');
});

// ── Distribution invariant ──────────────────────────────────────────

test('docs/ demo copy is byte-identical to the root card', () => {
  const a = readFileSync(join(root, 'pc-control-card.js'));
  const b = readFileSync(join(root, 'docs', 'pc-control-card.js'));
  assert.ok(a.equals(b), 'pc-control-card.js and docs/pc-control-card.js have diverged');
});
