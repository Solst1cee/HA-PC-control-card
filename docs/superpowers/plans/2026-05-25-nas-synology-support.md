# NAS / Synology Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class NAS support to the PC Control Card — a Restart action, accurate uptime from a dedicated sensor, per-volume usage bars plus per-physical-disk health/temperature, a NAS icon, editor + docs/demo coverage — all driven by Home Assistant's built-in Synology DSM integration.

**Architecture:** The card remains a thin presentation layer: it reads HA entities and calls HA services, never talking to the NAS directly. All additions are optional config keys with defaults that preserve current PC behavior. New pure logic (uptime parsing, drive-health mapping) is extracted into exported functions and unit-tested; rendering is verified with jsdom DOM tests. Distribution stays a single dependency-free file; tests are dev-only.

**Tech Stack:** Vanilla ES module (no framework, no build). Tests: Node's built-in `node:test` runner + `jsdom` (devDependency only). HA `<ha-form>` for the visual editor.

---

## File Structure

- `pc-control-card.js` — the card (root, shipped). All card/editor logic.
- `docs/pc-control-card.js` — byte-identical demo copy served by GitHub Pages.
- `docs/index.html` — interactive demo with a mock `hass`.
- `package.json` — add `"type": "module"`, `jsdom` devDependency, `test` script.
- `test/jsdom-setup.js` — installs jsdom globals before the card module loads.
- `test/*.test.js` — unit + DOM tests (new).
- `README.md` — user docs.
- `docs/superpowers/specs/2026-05-25-nas-synology-support-design.md` — the approved spec.

**Key anchors in `pc-control-card.js` (current line numbers):**
- `CARD_VERSION` — line 23
- `META` state table — lines 34-41
- `ICONS` — lines 415-420
- constructor — lines 425-434
- `setConfig` defaults — lines 442-472
- `set hass` — lines 474-485
- `_derivedStatus` — lines 533-540
- `_uptime` — lines 542-548
- `_normalizeStorages` — lines 554-573
- `_metricValue` — lines 581-631
- action handlers — lines 650-681
- `_build` — lines 698-734
- `_update` — lines 742-918
- `TEMPLATES` + `metricRow` — lines 925-1019
- editor `STORAGE_SLOTS` / schema / labels / flatten / unflatten — lines 1067-1237

---

## Task 1: Dev test harness (jsdom + node:test)

**Files:**
- Modify: `package.json`
- Create: `test/jsdom-setup.js`
- Create: `test/smoke.test.js`

- [ ] **Step 1: Add `type: module`, devDependency, and test script to `package.json`**

Edit `package.json` — change the top of the file so it reads:

```json
{
  "name": "pc-control-card",
  "version": "1.0.0",
  "description": "A Lovelace custom card for controlling a PC from Home Assistant — turn on, sleep, shutdown, with live CPU/RAM/GPU metrics.",
  "type": "module",
  "main": "pc-control-card.js",
  "files": ["pc-control-card.js"],
  "scripts": {
    "test": "node --test"
  },
```

(Insert `"type": "module",` after the `description` line, and the `"scripts"` block after `"files"`. Leave the rest of the file unchanged.)

- [ ] **Step 2: Install jsdom as a devDependency**

Run: `npm install --save-dev jsdom`
Expected: `package.json` gains a `devDependencies.jsdom` entry, `package-lock.json` is created, `node_modules/` is populated (already gitignored).

- [ ] **Step 3: Create the jsdom global setup**

Create `test/jsdom-setup.js`:

```js
// Installs a minimal DOM into Node globals so importing the card module
// (which extends HTMLElement and calls customElements.define at load)
// works under `node --test`. Imported first by every test file.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.customElements = dom.window.customElements;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
```

- [ ] **Step 4: Write the smoke test**

Create `test/smoke.test.js`:

```js
import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

test('registers the pc-control-card custom element', () => {
  assert.ok(customElements.get('pc-control-card'));
});

test('registers the editor element', () => {
  assert.ok(customElements.get('pc-control-card-editor'));
});
```

- [ ] **Step 5: Run the smoke test**

Run: `npm test`
Expected: PASS — 2 tests passing. (Confirms the card module loads cleanly under jsdom.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json test/jsdom-setup.js test/smoke.test.js
git commit -m "test: add jsdom + node:test dev harness"
```

---

## Task 2: Export helpers + `uptimeMsFromEntity`

**Files:**
- Modify: `pc-control-card.js` (helpers near lines 90, 112)
- Create: `test/helpers.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/helpers.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/helpers.test.js`
Expected: FAIL — `uptimeMsFromEntity` is not exported (import resolves to `undefined`, assertions throw / `TypeError`).

- [ ] **Step 3: Export `parseAction` and add `uptimeMsFromEntity`**

In `pc-control-card.js`, change the `parseAction` declaration (line 90) from:

```js
function parseAction(raw) {
```

to:

```js
export function parseAction(raw) {
```

Then, immediately after the `fmtUptime` function (after its closing `}` at line 121), add:

```js

// Compute uptime in milliseconds from an uptime/last-boot entity, or null.
// Handles a timestamp sensor (device_class 'timestamp' or any ISO-parseable
// state) and a numeric duration sensor (unit-aware: d/h/min, default seconds).
// `Number(raw)` — not parseFloat — is used so date strings like "2024-01-01"
// (which parseFloat would read as 2024) fall through to date parsing.
export function uptimeMsFromEntity(ent, now = Date.now()) {
  if (!ent || ent.state == null) return null;
  const raw = String(ent.state);
  const num = Number(raw);
  if (ent.attributes?.device_class === 'timestamp' || !Number.isFinite(num)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? now - t : null;
  }
  const unit = (ent.attributes?.unit_of_measurement || '').toLowerCase();
  const mult =
    /^(d|day|days)$/.test(unit)            ? 86_400_000 :
    /^(h|hr|hrs|hour|hours)$/.test(unit)   ? 3_600_000  :
    /^(min|m|minute|minutes)$/.test(unit)  ? 60_000     :
    1000;
  return num * mult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/helpers.test.js`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add pc-control-card.js test/helpers.test.js
git commit -m "feat: add uptimeMsFromEntity helper, export parseAction"
```

---

## Task 3: Drive-health helper (`driveHealthy` + `DEFAULT_HEALTHY`)

**Files:**
- Modify: `pc-control-card.js` (add near the helpers section, ~line 130)
- Modify: `test/helpers.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/helpers.test.js` — first update the import line at the top to:

```js
import { uptimeMsFromEntity, parseAction, driveHealthy, DEFAULT_HEALTHY } from '../pc-control-card.js';
```

Then add at the bottom of the file:

```js
test('DEFAULT_HEALTHY contains the common healthy states', () => {
  assert.deepEqual(DEFAULT_HEALTHY, ['normal', 'ok', 'healthy', 'good']);
});

test('driveHealthy: case-insensitive membership', () => {
  assert.equal(driveHealthy('normal', DEFAULT_HEALTHY), true);
  assert.equal(driveHealthy('Normal', DEFAULT_HEALTHY), true);
  assert.equal(driveHealthy(' OK ', DEFAULT_HEALTHY), true);
  assert.equal(driveHealthy('crashed', DEFAULT_HEALTHY), false);
  assert.equal(driveHealthy(undefined, DEFAULT_HEALTHY), false);
  assert.equal(driveHealthy('healthy', ['normal']), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/helpers.test.js`
Expected: FAIL — `driveHealthy` / `DEFAULT_HEALTHY` undefined.

- [ ] **Step 3: Implement the helper**

In `pc-control-card.js`, immediately after the `fmtNum` function (after its closing `}` at line 130), add:

```js

// Default set of drive/volume status states treated as healthy. Synology
// reports "normal" for healthy disks and volumes. Overridable per card via
// the `healthy_states` config key.
export const DEFAULT_HEALTHY = ['normal', 'ok', 'healthy', 'good'];

// True when a status state string is considered healthy. `healthyStates`
// must already be lowercased by the caller.
export function driveHealthy(state, healthyStates) {
  if (state == null) return false;
  return healthyStates.includes(String(state).trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/helpers.test.js`
Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add pc-control-card.js test/helpers.test.js
git commit -m "feat: add driveHealthy helper + DEFAULT_HEALTHY"
```

---

## Task 4: Wire `uptime_entity` into the card

**Files:**
- Modify: `pc-control-card.js` (`setConfig` defaults ~line 442, `_uptime` ~line 542)
- Create: `test/uptime.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/uptime.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/uptime.test.js`
Expected: FAIL — first test returns the `last_changed`-derived `'1m'` instead of `'2d 0h 0m'` (the `uptime_entity` path does not exist yet).

- [ ] **Step 3: Add the `uptime_entity` default**

In `setConfig` defaults, change (line 445):

```js
      status_entity: 'binary_sensor.pc_status',
```

to:

```js
      status_entity: 'binary_sensor.pc_status',
      uptime_entity: null,
```

- [ ] **Step 4: Use `uptime_entity` in `_uptime`**

Replace the whole `_uptime` method (lines 542-548) with:

```js
  _uptime() {
    const ent = this._hass?.states[this._config.status_entity];
    if (!ent || ent.state !== 'on') return null;
    // Prefer an explicit uptime / last-boot sensor when configured.
    if (this._config.uptime_entity) {
      const ms = uptimeMsFromEntity(this._hass?.states[this._config.uptime_entity], Date.now());
      if (ms != null && ms >= 0) return fmtUptime(ms);
    }
    const changed = new Date(ent.last_changed).getTime();
    if (!Number.isFinite(changed)) return null;
    return fmtUptime(Date.now() - changed);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/uptime.test.js`
Expected: PASS — 2 tests passing.

- [ ] **Step 6: Commit**

```bash
git add pc-control-card.js test/uptime.test.js
git commit -m "feat: support uptime_entity with last_changed fallback"
```

---

## Task 5: Restart action (state machine + buttons)

**Files:**
- Modify: `pc-control-card.js` (constants, META, ICONS, constructor, setConfig, set hass, _derivedStatus, action handlers, _build, _update, TEMPLATES)
- Create: `test/restart.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/restart.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/restart.test.js`
Expected: FAIL — `.btn-restart` element does not exist; `_onRestart` is not a function.

- [ ] **Step 3: Add the restart timeout constant**

In `pc-control-card.js`, change (lines 30-32):

```js
const PENDING_TIMEOUT_MS = 90_000;
const SLEEP_DISPLAY_MS   = 6_000;
const ARM_TIMEOUT_MS     = 2_400;
```

to:

```js
const PENDING_TIMEOUT_MS = 90_000;
const RESTART_TIMEOUT_MS = 300_000; // NAS reboots are slower than a PC boot
const SLEEP_DISPLAY_MS   = 6_000;
const ARM_TIMEOUT_MS     = 2_400;
```

- [ ] **Step 4: Add the `restarting` META entry**

Change (line 39, inside `META`):

```js
  shutting: { label: 'Shutting down', tone: 'alert', pulse: true  },
```

to:

```js
  shutting:   { label: 'Shutting down', tone: 'alert', pulse: true  },
  restarting: { label: 'Restarting',    tone: 'warm',  pulse: true  },
```

- [ ] **Step 5: Add the restart icon**

In `ICONS`, change the `moon` line (line 417) to add a `restart` icon after it:

```js
  moon:  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>',
```

- [ ] **Step 6: Initialize restart state in the constructor**

Change (line 430):

```js
    this._armed = { sleep: false, shutdown: false };
```

to:

```js
    this._armed = { sleep: false, shutdown: false, restart: false };
    this._restartDipped = false;
```

- [ ] **Step 7: Add restart config defaults**

In `setConfig` defaults, change (lines 448-449):

```js
      sleep: null,
      shutdown: null,
```

to:

```js
      sleep: null,
      restart: null,
      shutdown: null,
```

and change (line 453):

```js
      confirm_sleep: false,
```

to:

```js
      confirm_sleep: false,
      confirm_restart: true,
```

and change (line 456):

```js
      show_sleep: true,
```

to:

```js
      show_sleep: true,
      show_restart: false,
```

- [ ] **Step 8: Parse the restart action**

Change (lines 465-469):

```js
    this._actions = {
      turn_on:  parseAction(this._config.turn_on),
      sleep:    parseAction(this._config.sleep),
      shutdown: parseAction(this._config.shutdown),
    };
```

to:

```js
    this._actions = {
      turn_on:  parseAction(this._config.turn_on),
      sleep:    parseAction(this._config.sleep),
      restart:  parseAction(this._config.restart),
      shutdown: parseAction(this._config.shutdown),
    };
```

- [ ] **Step 9: Add restart resolution to `set hass`**

Replace the pending-resolution block (lines 477-483) — from:

```js
    if (this._pending && hass) {
      const s = hass.states[this._config.status_entity]?.state;
      const elapsed = Date.now() - this._pendingSince;
      if (this._pending === 'on'       && s === 'on'  ) this._clearPending();
      if (this._pending === 'shutdown' && s === 'off' ) this._clearPending();
      if (elapsed > PENDING_TIMEOUT_MS) this._clearPending();
    }
```

to:

```js
    if (this._pending && hass) {
      const s = hass.states[this._config.status_entity]?.state;
      const elapsed = Date.now() - this._pendingSince;
      if (this._pending === 'on'       && s === 'on'  ) this._clearPending();
      if (this._pending === 'shutdown' && s === 'off' ) this._clearPending();
      if (this._pending === 'restart') {
        // Reboot takes the box down (off/unavailable) then back to on.
        if (s !== 'on') this._restartDipped = true;
        if (this._restartDipped && s === 'on') this._clearPending();
        if (elapsed > RESTART_TIMEOUT_MS) this._clearPending();
      } else if (elapsed > PENDING_TIMEOUT_MS) {
        this._clearPending();
      }
    }
```

- [ ] **Step 10: Add `restarting` to `_derivedStatus`**

Change (lines 535-537):

```js
    if (this._pending === 'on')       return 'booting';
    if (this._pending === 'shutdown') return 'shutting';
    if (this._pending === 'sleep')    return 'sleeping';
```

to:

```js
    if (this._pending === 'on')       return 'booting';
    if (this._pending === 'shutdown') return 'shutting';
    if (this._pending === 'restart')  return 'restarting';
    if (this._pending === 'sleep')    return 'sleeping';
```

- [ ] **Step 11: Add the `_onRestart` handler**

Immediately after the `_onShutdown` method (after its closing `}` at line 681), add:

```js
  _onRestart() {
    if (this._derivedStatus() !== 'on' || this._pending) return;
    if (!this._actions.restart) return;
    if (this._config.confirm_restart && !this._armed.restart) {
      this._arm('restart');
      return;
    }
    this._disarm('restart');
    this._restartDipped = false;
    this._setPending('restart');
    this._callAction('restart');
  }
```

- [ ] **Step 12: Wire the restart button click in `_build`**

Change (lines 727-729):

```js
    $('.btn-on').addEventListener('click', () => this._onTurnOn());
    $('.btn-sleep').addEventListener('click', () => this._onSleep());
    $('.btn-shutdown').addEventListener('click', () => this._onShutdown());
```

to:

```js
    $('.btn-on').addEventListener('click', () => this._onTurnOn());
    $('.btn-sleep').addEventListener('click', () => this._onSleep());
    $('.btn-restart').addEventListener('click', () => this._onRestart());
    $('.btn-shutdown').addEventListener('click', () => this._onShutdown());
```

- [ ] **Step 13: Compute button visibility with a `vis` object in `_update`**

Replace the `anyBtn` block (lines 757-761) — from:

```js
    const anyBtn =
      this._config.show_turn_on  !== false ||
      this._config.show_sleep    !== false ||
      this._config.show_shutdown !== false;
    root.classList.toggle('no-actions', !anyBtn);
```

to:

```js
    const vis = {
      on:       this._config.show_turn_on  !== false,
      sleep:    this._config.show_sleep    !== false,
      restart:  !!this._config.show_restart,
      shutdown: this._config.show_shutdown !== false,
    };
    const anyBtn = vis.on || vis.sleep || vis.restart || vis.shutdown;
    root.classList.toggle('no-actions', !anyBtn);
```

- [ ] **Step 14: Query the restart button and set its visibility**

Change (lines 872-874):

```js
    const onBtn = root.querySelector('.btn-on');
    const sleepBtn = root.querySelector('.btn-sleep');
    const shutBtn = root.querySelector('.btn-shutdown');
```

to:

```js
    const onBtn = root.querySelector('.btn-on');
    const sleepBtn = root.querySelector('.btn-sleep');
    const restartBtn = root.querySelector('.btn-restart');
    const shutBtn = root.querySelector('.btn-shutdown');
```

Then change the display lines (lines 880-882):

```js
    onBtn.style.display    = this._config.show_turn_on  === false ? 'none' : '';
    sleepBtn.style.display = this._config.show_sleep    === false ? 'none' : '';
    shutBtn.style.display  = this._config.show_shutdown === false ? 'none' : '';
```

to:

```js
    onBtn.style.display      = vis.on       ? '' : 'none';
    sleepBtn.style.display   = vis.sleep    ? '' : 'none';
    restartBtn.style.display = vis.restart  ? '' : 'none';
    shutBtn.style.display    = vis.shutdown ? '' : 'none';
```

- [ ] **Step 15: Add the restart `setBtn` call**

Change (line 905, the start of the shutdown `setBtn`):

```js
    setBtn(shutBtn, {
```

to:

```js
    setBtn(restartBtn, {
      disabled: !on || pend,
      busy: this._pending === 'restart',
      armed: this._armed.restart,
      iconKey: 'restart',
      label: 'Restart',
      armedLabel: this._config.confirm_restart ? 'Confirm?' : null,
    });
    setBtn(shutBtn, {
```

- [ ] **Step 16: Add the Restart button to the tile template**

Change (lines 937-938):

```js
        <button class="btn btn-sleep compact" title="Sleep"></button>
        <button class="btn btn-shutdown danger compact" title="Shut down"></button>
```

to:

```js
        <button class="btn btn-sleep compact" title="Sleep"></button>
        <button class="btn btn-restart compact" title="Restart"></button>
        <button class="btn btn-shutdown danger compact" title="Shut down"></button>
```

- [ ] **Step 17: Add the Restart button to the chip and feature templates**

These two templates share an identical actions snippet, so use replace-all. Replace every occurrence of:

```js
        <button class="btn btn-sleep" title="Sleep"></button>
        <button class="btn btn-shutdown danger" title="Shut down"></button>
```

with:

```js
        <button class="btn btn-sleep" title="Sleep"></button>
        <button class="btn btn-restart" title="Restart"></button>
        <button class="btn btn-shutdown danger" title="Shut down"></button>
```

(Use the editor's replace-all so both the chip and feature templates are updated.)

- [ ] **Step 18: Run tests to verify they pass**

Run: `node --test test/restart.test.js`
Expected: PASS — 4 tests passing.

- [ ] **Step 19: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 20: Commit**

```bash
git add pc-control-card.js test/restart.test.js
git commit -m "feat: add Restart action (4th optional button) with reboot state handling"
```

---

## Task 6: Drive health + NAS icon

**Files:**
- Modify: `pc-control-card.js` (STYLES, ICONS, setConfig, add `_normalizeDrives`/`_driveValue`, `_build`, `_update` feature+chip, TEMPLATES, `driveRow`)
- Create: `test/drives.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/drives.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/drives.test.js`
Expected: FAIL — no `.drive` rows / no `drives_summary` are rendered.

- [ ] **Step 3: Add the `--spc-ok` CSS variable**

In `STYLES`, change (line 142):

```js
  --spc-alert:  var(--error-color, #db4437);
```

to:

```js
  --spc-alert:  var(--error-color, #db4437);
  --spc-ok:     var(--success-color, #2f9e6e);
```

- [ ] **Step 4: Add drive-row styles**

In `STYLES`, change the last feature rule (line 410):

```js
.feature.no-actions .metrics { padding-bottom: 22px; }
```

to:

```js
.feature.no-actions .metrics { padding-bottom: 22px; }

/* ── Drive health (NAS) ───────────────────────────────────────── */
.feature .drive { display: flex; align-items: center; gap: 8px; }
.feature .drive .ddot {
  width: 8px; height: 8px; border-radius: 999px;
  background: var(--spc-fg-2); flex-shrink: 0;
}
.feature .drive .ddot.ok  { background: var(--spc-ok); }
.feature .drive .ddot.bad { background: var(--spc-alert); }
.feature .drive .dname { font-size: 12px; color: var(--spc-fg); flex: 1; min-width: 0; }
.feature .drive .dval {
  font-size: 12px; color: var(--spc-fg-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.chip .mini-stat .mval.bad { color: var(--spc-alert); }
```

- [ ] **Step 5: Add the NAS icon**

In `ICONS`, change the `pc` line (line 418) to add a `nas` icon after it:

```js
  pc:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  nas:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01"/><path d="M8 17.5h.01"/></svg>',
```

- [ ] **Step 6: Add drive/icon config defaults**

In `setConfig` defaults, change (line 459):

```js
      show_storage:   true,
```

to:

```js
      show_storage:   true,
      show_drives:    true,
```

and change (line 460):

```js
      accent_color: null,
```

to:

```js
      accent_color: null,
      healthy_states: null,
      icon: 'pc',
```

- [ ] **Step 7: Compute `_drives` and `_healthyStates` in `setConfig`**

Change (line 464):

```js
    this._storages = this._normalizeStorages();
```

to:

```js
    this._storages = this._normalizeStorages();
    this._drives = this._normalizeDrives();
    this._healthyStates = (Array.isArray(this._config.healthy_states) && this._config.healthy_states.length
      ? this._config.healthy_states
      : DEFAULT_HEALTHY).map((s) => String(s).toLowerCase());
```

- [ ] **Step 8: Add `_normalizeDrives` and `_driveValue` methods**

Immediately after the `_normalizeStorages` method (after its closing `}` at line 573), add:

```js
  // Normalize the optional top-level `drives` array into clean
  // { status, temp, name } records — one per physical disk. Mirrors
  // _normalizeStorages; entries without a `status` sensor are dropped.
  _normalizeDrives() {
    const d = this._config.drives;
    if (!Array.isArray(d)) return [];
    return d
      .filter((x) => x && x.status)
      .map((x, i) => ({
        status: x.status,
        temp: x.temp || null,
        name: x.name || (i === 0 ? 'Drive' : `Drive ${i + 1}`),
      }));
  }

  // Display string for a drive row: temperature ("38 °C") when a temp
  // sensor is configured and numeric, otherwise the capitalized status.
  _driveValue(d) {
    if (d.temp) {
      const te = this._hass?.states[d.temp];
      const n = parseFloat(te?.state);
      if (Number.isFinite(n)) {
        const unit = te.attributes?.unit_of_measurement || '°C';
        return `${Math.round(n)} ${unit}`;
      }
    }
    const st = this._hass?.states[d.status]?.state;
    if (st) return st.charAt(0).toUpperCase() + st.slice(1);
    return '—';
  }
```

- [ ] **Step 9: Pass drives + icon into the template in `_build`**

Change (line 700):

```js
    const html = TEMPLATES[variant](this._storages || []);
```

to:

```js
    const html = TEMPLATES[variant](this._storages || [], this._drives || [], ICONS[this._config.icon] || ICONS.pc);
```

- [ ] **Step 10: Render drive rows in the feature `_update` block**

Change (lines 829-831) — from:

```js
      });
    }

    // Chip-only: inline uptime + mini stats (cpu/ram/gpu + temps + first disk)
```

to:

```js
      });

      // Per-drive health rows (status dot + temperature).
      (this._drives || []).forEach((d, i) => {
        const row = root.querySelector(`.drive[data-key="drive_${i}"]`);
        if (!row) return;
        const enabled = this._config.show_drives !== false;
        row.style.display = enabled ? '' : 'none';
        if (!enabled) return;
        const dot = row.querySelector('.ddot');
        const valEl = row.querySelector('.dval');
        if (isOn) {
          const healthy = driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates);
          dot.classList.toggle('ok', healthy);
          dot.classList.toggle('bad', !healthy);
          valEl.textContent = this._driveValue(d);
        } else {
          dot.classList.remove('ok', 'bad');
          valEl.textContent = '—';
        }
      });
    }

    // Chip-only: inline uptime + mini stats (cpu/ram/gpu + temps + first disk)
```

- [ ] **Step 11: Render the drives summary in the chip `_update` block**

Change (lines 866-868) — from:

```js
        cell.textContent = m ? m.compactValue : '—';
      });
      mini.style.display = (isOn && anyMini) ? '' : 'none';
```

to:

```js
        cell.textContent = m ? m.compactValue : '—';
      });

      // Drives summary mini-stat (healthy/total), red if any unhealthy.
      if ((this._drives || []).length) {
        const stat = mini.querySelector('.mini-stat[data-key="drives_summary"]');
        if (stat) {
          const enabled = this._config.show_drives !== false;
          stat.style.display = enabled ? '' : 'none';
          if (enabled) {
            anyMini = true;
            const cell = stat.querySelector('.mval');
            if (isOn) {
              const total = this._drives.length;
              const healthy = this._drives.filter(
                (d) => driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates),
              ).length;
              cell.textContent = `${healthy}/${total}`;
              cell.classList.toggle('bad', healthy < total);
            } else {
              cell.textContent = '—';
              cell.classList.remove('bad');
            }
          }
        }
      }
      mini.style.display = (isOn && anyMini) ? '' : 'none';
```

- [ ] **Step 12: Update the tile template signature + icon**

Change (line 926):

```js
  tile: () => `
```

to:

```js
  tile: (_storages, _drives, iconSvg) => `
```

and change (line 929):

```js
        <button class="circle" title="Toggle">${ICONS.pc}</button>
```

to:

```js
        <button class="circle" title="Toggle">${iconSvg}</button>
```

- [ ] **Step 13: Update the chip template signature, icon, and summary slot**

Change (line 943):

```js
  chip: (storages) => `
```

to:

```js
  chip: (storages, drives, iconSvg) => `
```

Change (line 946):

```js
        <div class="icon-box chip-icon">${ICONS.pc}<span class="ring" style="display:none"></span></div>
```

to:

```js
        <div class="icon-box chip-icon">${iconSvg}<span class="ring" style="display:none"></span></div>
```

Change (lines 964-969) — the storage mini-stats map — from:

```js
          ${storages.map((s, i) => `
          <div class="mini-stat" data-key="storage_${i}">
            <div class="mlabel">${escapeHtml(s.name).toUpperCase()}</div>
            <div class="mval">—</div>
          </div>
          `).join('')}
        </div>
```

to:

```js
          ${storages.map((s, i) => `
          <div class="mini-stat" data-key="storage_${i}">
            <div class="mlabel">${escapeHtml(s.name).toUpperCase()}</div>
            <div class="mval">—</div>
          </div>
          `).join('')}
          ${drives.length ? `
          <div class="mini-stat drives-summary" data-key="drives_summary">
            <div class="mlabel">DRIVES</div>
            <div class="mval">—</div>
          </div>
          ` : ''}
        </div>
```

- [ ] **Step 14: Update the feature template signature, icon, and drive rows**

Change (line 981):

```js
  feature: (storages) => `
```

to:

```js
  feature: (storages, drives, iconSvg) => `
```

Change (line 984):

```js
        <div class="icon-box lg">${ICONS.pc}<span class="ring" style="display:none"></span></div>
```

to:

```js
        <div class="icon-box lg">${iconSvg}<span class="ring" style="display:none"></span></div>
```

Change (lines 995-998) — the metrics block — from:

```js
      <div class="metrics">
        ${METRIC_KEYS.map((k) => metricRow(k, METRIC_LABELS[k])).join('')}
        ${storages.map((s, i) => metricRow(`storage_${i}`, escapeHtml(s.name).toUpperCase())).join('')}
      </div>
```

to:

```js
      <div class="metrics">
        ${METRIC_KEYS.map((k) => metricRow(k, METRIC_LABELS[k])).join('')}
        ${storages.map((s, i) => metricRow(`storage_${i}`, escapeHtml(s.name).toUpperCase())).join('')}
        ${drives.map((d, i) => driveRow(`drive_${i}`, escapeHtml(d.name).toUpperCase())).join('')}
      </div>
```

- [ ] **Step 15: Add the `driveRow` template helper**

Immediately after the `metricRow` function (after its closing `}` at line 1019), add:

```js
function driveRow(key, label) {
  return `
    <div class="drive" data-key="${key}">
      <span class="ddot"></span>
      <span class="dname">${label}</span>
      <span class="dval">—</span>
    </div>
  `;
}
```

- [ ] **Step 16: Run tests to verify they pass**

Run: `node --test test/drives.test.js`
Expected: PASS — 3 tests passing.

- [ ] **Step 17: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 18: Commit**

```bash
git add pc-control-card.js test/drives.test.js
git commit -m "feat: add per-drive health display + NAS icon"
```

---

## Task 7: Visual editor support

**Files:**
- Modify: `pc-control-card.js` (`STORAGE_SLOTS`/`DRIVE_SLOTS`, `EDITOR_SCHEMA`, `EDITOR_LABELS`, `_flatten`, `_unflatten`)
- Create: `test/editor.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/editor.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/editor.test.js`
Expected: FAIL — `_unflatten` does not produce `drives`; `_flatten` does not produce `_drive_*` fields.

- [ ] **Step 3: Add `DRIVE_SLOTS`**

Change (line 1067):

```js
const STORAGE_SLOTS = 3;
```

to:

```js
const STORAGE_SLOTS = 3;
const DRIVE_SLOTS = 4;
```

- [ ] **Step 4: Add `uptime_entity` to the top-level schema**

Change (line 1079):

```js
  { name: 'status_entity', selector: { entity: { domain: ['binary_sensor', 'sensor', 'switch'] } } },
```

to:

```js
  { name: 'status_entity', selector: { entity: { domain: ['binary_sensor', 'sensor', 'switch'] } } },
  { name: 'uptime_entity', selector: { entity: { domain: 'sensor' } } },
```

- [ ] **Step 5: Add `restart` to the Actions group**

Change (lines 1081-1085):

```js
  { type: 'expandable', title: 'Actions', icon: 'mdi:gesture-tap', schema: [
    { name: 'turn_on',  selector: { entity: { domain: ['switch', 'script', 'button', 'input_button'] } } },
    { name: 'sleep',    selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
    { name: 'shutdown', selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
  ] },
```

to:

```js
  { type: 'expandable', title: 'Actions', icon: 'mdi:gesture-tap', schema: [
    { name: 'turn_on',  selector: { entity: { domain: ['switch', 'script', 'button', 'input_button'] } } },
    { name: 'sleep',    selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
    { name: 'restart',  selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
    { name: 'shutdown', selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
  ] },
```

- [ ] **Step 6: Add `confirm_restart` and `show_restart`**

Change (lines 1087-1096):

```js
  { type: 'expandable', title: 'Confirmation', icon: 'mdi:shield-check', schema: [
    { name: 'confirm_shutdown', selector: { boolean: {} } },
    { name: 'confirm_sleep',    selector: { boolean: {} } },
  ] },

  { type: 'expandable', title: 'Visible buttons', icon: 'mdi:eye', schema: [
    { name: 'show_turn_on',  selector: { boolean: {} } },
    { name: 'show_sleep',    selector: { boolean: {} } },
    { name: 'show_shutdown', selector: { boolean: {} } },
  ] },
```

to:

```js
  { type: 'expandable', title: 'Confirmation', icon: 'mdi:shield-check', schema: [
    { name: 'confirm_shutdown', selector: { boolean: {} } },
    { name: 'confirm_sleep',    selector: { boolean: {} } },
    { name: 'confirm_restart',  selector: { boolean: {} } },
  ] },

  { type: 'expandable', title: 'Visible buttons', icon: 'mdi:eye', schema: [
    { name: 'show_turn_on',  selector: { boolean: {} } },
    { name: 'show_sleep',    selector: { boolean: {} } },
    { name: 'show_restart',  selector: { boolean: {} } },
    { name: 'show_shutdown', selector: { boolean: {} } },
  ] },
```

- [ ] **Step 7: Add `show_drives` to Visible metrics**

Change (line 1104):

```js
    { name: 'show_storage',   selector: { boolean: {} } },
  ] },
```

to:

```js
    { name: 'show_storage',   selector: { boolean: {} } },
    { name: 'show_drives',    selector: { boolean: {} } },
  ] },
```

- [ ] **Step 8: Add the `icon` selector to Appearance**

Change (lines 1107-1109):

```js
  { type: 'expandable', title: 'Appearance', icon: 'mdi:palette', schema: [
    { name: 'accent_color', selector: { color_rgb: {} } },
  ] },
```

to:

```js
  { type: 'expandable', title: 'Appearance', icon: 'mdi:palette', schema: [
    { name: 'icon', selector: { select: { mode: 'dropdown', options: [
      { value: 'pc',  label: 'PC (monitor)' },
      { value: 'nas', label: 'NAS (drive bays)' },
    ] } } },
    { name: 'accent_color', selector: { color_rgb: {} } },
  ] },
```

- [ ] **Step 9: Add the Drives expandable group after Storage**

Change (lines 1120-1133):

```js
  { type: 'expandable', title: 'Storage (multi-disk)', icon: 'mdi:harddisk', schema: [
    { name: '_storage_1_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_name',   selector: { text: {} } },

    { name: '_storage_2_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_name',   selector: { text: {} } },

    { name: '_storage_3_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_name',   selector: { text: {} } },
  ] },
];
```

to:

```js
  { type: 'expandable', title: 'Storage (multi-disk)', icon: 'mdi:harddisk', schema: [
    { name: '_storage_1_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_name',   selector: { text: {} } },

    { name: '_storage_2_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_name',   selector: { text: {} } },

    { name: '_storage_3_entity', selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_total',  selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_name',   selector: { text: {} } },
  ] },

  { type: 'expandable', title: 'Drives (NAS health)', icon: 'mdi:harddisk-plus', schema: [
    { name: '_drive_1_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_1_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_1_name',   selector: { text: {} } },

    { name: '_drive_2_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_2_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_2_name',   selector: { text: {} } },

    { name: '_drive_3_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_3_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_3_name',   selector: { text: {} } },

    { name: '_drive_4_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_4_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_4_name',   selector: { text: {} } },
  ] },
];
```

- [ ] **Step 10: Add editor labels**

Change (line 1138):

```js
  status_entity: 'Status sensor (on = device is reachable)',
```

to:

```js
  status_entity: 'Status sensor (on = device is reachable)',
  uptime_entity: 'Uptime / last-boot sensor (optional, more accurate)',
```

Change (line 1141):

```js
  sleep: 'Sleep action',
```

to:

```js
  sleep: 'Sleep action',
  restart: 'Restart action (e.g. NAS reboot button)',
```

Change (line 1143):

```js
  confirm_sleep: 'Require confirm for Sleep',
```

to:

```js
  confirm_sleep: 'Require confirm for Sleep',
  confirm_restart: 'Require confirm for Restart',
```

Change (line 1146):

```js
  show_sleep: 'Show Sleep button',
```

to:

```js
  show_sleep: 'Show Sleep button',
  show_restart: 'Show Restart button',
```

Change (line 1152):

```js
  show_storage:   'Show Storage',
```

to:

```js
  show_storage:   'Show Storage',
  show_drives:    'Show Drive health',
```

Change (line 1153):

```js
  accent_color: 'Accent color (overrides theme)',
```

to:

```js
  accent_color: 'Accent color (overrides theme)',
  icon: 'Header icon',
```

Change (lines 1166-1168):

```js
  _storage_3_entity: 'Disk 3 · used / percent sensor',
  _storage_3_total:  'Disk 3 · total sensor',
  _storage_3_name:   'Disk 3 · label',
};
```

to:

```js
  _storage_3_entity: 'Disk 3 · used / percent sensor',
  _storage_3_total:  'Disk 3 · total sensor',
  _storage_3_name:   'Disk 3 · label',
  _drive_1_status: 'Drive 1 · status sensor', _drive_1_temp: 'Drive 1 · temperature sensor', _drive_1_name: 'Drive 1 · label',
  _drive_2_status: 'Drive 2 · status sensor', _drive_2_temp: 'Drive 2 · temperature sensor', _drive_2_name: 'Drive 2 · label',
  _drive_3_status: 'Drive 3 · status sensor', _drive_3_temp: 'Drive 3 · temperature sensor', _drive_3_name: 'Drive 3 · label',
  _drive_4_status: 'Drive 4 · status sensor', _drive_4_temp: 'Drive 4 · temperature sensor', _drive_4_name: 'Drive 4 · label',
};
```

- [ ] **Step 11: Flatten the drives array in `_flatten`**

Change the end of `_flatten` (lines 1198-1206):

```js
    const storages = Array.isArray(m.storages) ? m.storages : [];
    for (let i = 0; i < STORAGE_SLOTS; i++) {
      const s = storages[i] || {};
      flat[`_storage_${i + 1}_entity`] = s.entity;
      flat[`_storage_${i + 1}_total`]  = s.total;
      flat[`_storage_${i + 1}_name`]   = s.name;
    }
    return flat;
  }
```

to:

```js
    const storages = Array.isArray(m.storages) ? m.storages : [];
    for (let i = 0; i < STORAGE_SLOTS; i++) {
      const s = storages[i] || {};
      flat[`_storage_${i + 1}_entity`] = s.entity;
      flat[`_storage_${i + 1}_total`]  = s.total;
      flat[`_storage_${i + 1}_name`]   = s.name;
    }

    const drives = Array.isArray(migrated.drives) ? migrated.drives : [];
    for (let i = 0; i < DRIVE_SLOTS; i++) {
      const d = drives[i] || {};
      flat[`_drive_${i + 1}_status`] = d.status;
      flat[`_drive_${i + 1}_temp`]   = d.temp;
      flat[`_drive_${i + 1}_name`]   = d.name;
    }
    return flat;
  }
```

- [ ] **Step 12: Unflatten the drives fields in `_unflatten`**

Change the end of `_unflatten` (lines 1233-1237):

```js
    if (storages.length) metrics.storages = storages;
    if (Object.keys(metrics).length) next.metrics = metrics;
    else delete next.metrics;
    return next;
  }
```

to:

```js
    if (storages.length) metrics.storages = storages;
    if (Object.keys(metrics).length) next.metrics = metrics;
    else delete next.metrics;

    const drives = [];
    for (let i = 1; i <= DRIVE_SLOTS; i++) {
      const status = next[`_drive_${i}_status`];
      if (status) {
        const item = { status };
        if (next[`_drive_${i}_temp`]) item.temp = next[`_drive_${i}_temp`];
        if (next[`_drive_${i}_name`]) item.name = next[`_drive_${i}_name`];
        drives.push(item);
      }
      delete next[`_drive_${i}_status`];
      delete next[`_drive_${i}_temp`];
      delete next[`_drive_${i}_name`];
    }
    if (drives.length) next.drives = drives;
    else delete next.drives;
    return next;
  }
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `node --test test/editor.test.js`
Expected: PASS — 3 tests passing.

- [ ] **Step 14: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 15: Commit**

```bash
git add pc-control-card.js test/editor.test.js
git commit -m "feat: editor support for restart, uptime, drives, icon"
```

---

## Task 8: Version bump + demo sync + sync guard

**Files:**
- Modify: `pc-control-card.js` (`CARD_VERSION`)
- Modify: `package.json` (`version`)
- Modify: `docs/pc-control-card.js` (regenerated copy)
- Create: `test/sync.test.js`

- [ ] **Step 1: Write the failing sync test**

Create `test/sync.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('docs demo copy is byte-identical to the root card', () => {
  const a = readFileSync(join(root, 'pc-control-card.js'), 'utf8');
  const b = readFileSync(join(root, 'docs', 'pc-control-card.js'), 'utf8');
  assert.equal(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL — the root card now differs from the stale `docs/pc-control-card.js`.

- [ ] **Step 3: Bump `CARD_VERSION`**

Change (line 23):

```js
const CARD_VERSION = '1.0.1';
```

to:

```js
const CARD_VERSION = '1.1.0';
```

- [ ] **Step 4: Bump the package version**

In `package.json`, change `"version": "1.0.0",` to `"version": "1.1.0",`.

- [ ] **Step 5: Sync the demo copy**

Run: `node -e "require('fs').copyFileSync('pc-control-card.js','docs/pc-control-card.js')"`
Expected: `docs/pc-control-card.js` is overwritten with the current root card.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 8: Commit**

```bash
git add pc-control-card.js package.json docs/pc-control-card.js test/sync.test.js
git commit -m "chore: bump to 1.1.0, sync docs demo, add sync guard test"
```

---

## Task 9: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "NAS / multi-disk setup" section with a Synology section**

In `README.md`, replace the entire block from the `### NAS / multi-disk setup` heading (line 126) through its closing code fence and the following `---` (line 155) with:

````markdown
### NAS / Synology setup

The same card works for a NAS. **No agent is needed on the NAS** — Home Assistant's built-in **[Synology DSM](https://www.home-assistant.io/integrations/synology_dsm/)** integration provides the data:

- **Reboot** and **Shutdown** are native button entities → use them for `restart` and `shutdown`.
- **Volume** used / total / % and per-physical-**disk** status + temperature are native sensors.
- **Uptime** is a native sensor — but it's **disabled by default**, so enable it (and the **Volume Total size** sensor, also disabled by default, if you want "used / total" bars) under the integration's entities.
- **Powering the NAS on** isn't possible through the integration (the box is off), so `turn_on` uses **Wake-on-LAN**, exactly like a PC. `status_entity` stays a ping `binary_sensor`.

```yaml
type: custom:pc-control-card
variant: feature
name: NAS
icon: nas                                  # drive-bay header icon
status_entity: binary_sensor.nas_ping      # `on` = reachable (ping)
uptime_entity: sensor.nas_uptime           # enable this entity in the Synology integration
turn_on:  switch.nas_wol                   # Wake-on-LAN switch
restart:  button.nas_reboot                # native Synology DSM button
shutdown: button.nas_shutdown              # native Synology DSM button
show_sleep: false                          # most NAS firmware doesn't sleep
show_restart: true                         # off by default — turn it on for a NAS
show_gpu_usage: false                      # no GPU on a NAS
confirm_restart: true
confirm_shutdown: true
metrics:
  cpu_usage: sensor.nas_cpu_utilization_total
  ram_usage: sensor.nas_memory_usage_real
  storages:                                # one bar per volume
    - entity: sensor.nas_volume_1_used_space
      total:  sensor.nas_volume_1_total_size   # enable Total size in the integration
      name: Volume 1
    - entity: sensor.nas_volume_2_used_space
      total:  sensor.nas_volume_2_total_size
      name: Volume 2
drives:                                    # one row per physical disk (health + temp)
  - status: sensor.nas_drive_1_status
    temp:   sensor.nas_drive_1_temperature
    name: Drive 1
  - status: sensor.nas_drive_2_status
    temp:   sensor.nas_drive_2_temperature
    name: Drive 2
```

> Entity IDs above follow the Synology DSM integration's naming — confirm yours in **Developer Tools → States**. Drive health shows a green dot when the status sensor reads one of `healthy_states` (default `normal`, `ok`, `healthy`, `good`) and red otherwise. In the chip variant, drives collapse to a `healthy/total` summary that turns red if any drive is unhealthy.

---
````

- [ ] **Step 2: Add the new config keys to the configuration table**

In `README.md`, in the configuration table, change the `sleep` row (line 165):

```markdown
| `sleep`            | no       | same                              | —                        | Same |
```

to:

```markdown
| `sleep`            | no       | same                              | —                        | Same |
| `restart`          | no       | same                              | —                        | Restart/reboot action (e.g. `button.nas_reboot`). Hidden unless `show_restart: true`. |
| `uptime_entity`    | no       | sensor entity                     | —                        | When set, uptime is read from this sensor (timestamp or numeric duration) instead of `status_entity`'s `last_changed`. |
```

Change the `confirm_sleep` row (line 168):

```markdown
| `confirm_sleep`    | no       | boolean                           | `false`                  | Set `true` to require 2-tap confirm on sleep too. |
```

to:

```markdown
| `confirm_sleep`    | no       | boolean                           | `false`                  | Set `true` to require 2-tap confirm on sleep too. |
| `confirm_restart`  | no       | boolean                           | `true`                   | 2-tap confirm for Restart (reboot interrupts service). |
| `show_restart`     | no       | boolean                           | `false`                  | Show the Restart button. Off by default; enable for a NAS. |
```

Change the `show_storage` row (line 175):

```markdown
| `show_storage`     | no       | boolean                           | `true`                   | Show all disk rows. |
```

to:

```markdown
| `show_storage`     | no       | boolean                           | `true`                   | Show all volume usage rows. |
| `show_drives`      | no       | boolean                           | `true`                   | Show the per-drive health rows (feature) / summary (chip). Only renders when `drives` is set. |
| `icon`             | no       | `pc` \| `nas`                     | `pc`                     | Header glyph. `nas` shows stacked drive bays. |
| `healthy_states`   | no       | string[]                          | `[normal, ok, healthy, good]` | Status values (case-insensitive) treated as a healthy drive. |
| `drives`           | no       | array of `{ status, temp?, name? }` | —                      | One entry per physical disk. `status` is the text status sensor; `temp` an optional °C sensor; `name` the row label (default `Drive`, `Drive 2`, …). |
```

- [ ] **Step 3: Add a Synology note to the companion integrations section**

In `README.md`, change (line 270):

```markdown
- **Sleep / shutdown** — an agent running on the PC that exposes buttons in HA. [HASS.Agent](https://github.com/LAB02-Research/HASS.Agent), [IOT Link](https://gitlab.com/iotlink/iotlink), or any MQTT-based shell command works.
```

to:

```markdown
- **Sleep / shutdown** — an agent running on the PC that exposes buttons in HA. [HASS.Agent](https://github.com/LAB02-Research/HASS.Agent), [IOT Link](https://gitlab.com/iotlink/iotlink), or any MQTT-based shell command works.
- **Synology NAS** — the built-in [Synology DSM](https://www.home-assistant.io/integrations/synology_dsm/) integration provides CPU/RAM/temperature, per-volume usage, per-drive status/temperature, uptime, and native Reboot/Shutdown buttons — no agent required. Pair with Wake-on-LAN for power-on.
```

- [ ] **Step 4: Verify the README has no broken references**

Run: `node --test`
Expected: PASS (no test depends on README, but confirms nothing else broke). Visually skim the edited section for correct YAML indentation.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: rewrite NAS section for Synology DSM + document new keys"
```

---

## Task 10: Interactive demo (index.html)

**Files:**
- Modify: `docs/index.html`

This task makes the live demo exercise the new Restart button and drive health. All edits are additive and live alongside the existing PC demo.

- [ ] **Step 1: Add mock entities for restart + drives**

In `docs/index.html`, change (lines 371-372):

```js
    'button.my_pc_sleep':           { state: 'unknown', changed: 0, attrs: {} },
    'button.my_pc_shutdown':        { state: 'unknown', changed: 0, attrs: {} },
```

to:

```js
    'button.my_pc_sleep':           { state: 'unknown', changed: 0, attrs: {} },
    'button.my_pc_restart':         { state: 'unknown', changed: 0, attrs: {} },
    'button.my_pc_shutdown':        { state: 'unknown', changed: 0, attrs: {} },
    'sensor.my_pc_drive1_status':   { state: 'normal',  changed: 0, attrs: {} },
    'sensor.my_pc_drive1_temp':     { state: '36', changed: 0, attrs: { unit_of_measurement: '°C' } },
    'sensor.my_pc_drive2_status':   { state: 'normal',  changed: 0, attrs: {} },
    'sensor.my_pc_drive2_temp':     { state: '41', changed: 0, attrs: { unit_of_measurement: '°C' } },
```

- [ ] **Step 2: Handle the reboot press in the mock `callService`**

Change (lines 431-439):

```js
      if (domain === 'button' && service === 'press') {
        if (ent?.includes('shutdown')) {
          clearTimeout(pendingShutTimer);
          pendingShutTimer = setTimeout(() => setState('binary_sensor.pc_status', 'off'), 2600);
        } else if (ent?.includes('sleep')) {
          clearTimeout(pendingSleepTimer);
          pendingSleepTimer = setTimeout(() => setState('binary_sensor.pc_status', 'off'), 2000);
        }
      }
```

to:

```js
      if (domain === 'button' && service === 'press') {
        if (ent?.includes('shutdown')) {
          clearTimeout(pendingShutTimer);
          pendingShutTimer = setTimeout(() => setState('binary_sensor.pc_status', 'off'), 2600);
        } else if (ent?.includes('restart') || ent?.includes('reboot')) {
          // Reboot: go down briefly, then back up — drives the "Restarting" overlay.
          clearTimeout(pendingShutTimer);
          clearTimeout(pendingBootTimer);
          pendingShutTimer = setTimeout(() => setState('binary_sensor.pc_status', 'off'), 1500);
          pendingBootTimer = setTimeout(() => setState('binary_sensor.pc_status', 'on'), 5000);
        } else if (ent?.includes('sleep')) {
          clearTimeout(pendingSleepTimer);
          pendingSleepTimer = setTimeout(() => setState('binary_sensor.pc_status', 'off'), 2000);
        }
      }
```

- [ ] **Step 3: Add a Restart toggle to the buttons control**

Change (lines 298-302):

```html
      <div class="seg" id="buttons-seg">
        <button data-btn="turn_on" class="active">Turn on</button>
        <button data-btn="sleep" class="active">Sleep</button>
        <button data-btn="shutdown" class="active">Shut down</button>
      </div>
```

to:

```html
      <div class="seg" id="buttons-seg">
        <button data-btn="turn_on" class="active">Turn on</button>
        <button data-btn="sleep" class="active">Sleep</button>
        <button data-btn="restart">Restart</button>
        <button data-btn="shutdown" class="active">Shut down</button>
      </div>
```

- [ ] **Step 4: Add `restart` to the demo defaults/state**

Change (line 451):

```js
    visibility: { turn_on: true, sleep: true, shutdown: true },
```

to:

```js
    visibility: { turn_on: true, sleep: true, restart: false, shutdown: true },
```

- [ ] **Step 5: Add restart + drives to the card config**

Change (lines 506-524) — the `base` config object — from:

```js
      const base = {
        status_entity: 'binary_sensor.pc_status',
        turn_on:  'switch.my_pc',
        sleep:    'button.my_pc_sleep',
        shutdown: 'button.my_pc_shutdown',
        confirm_shutdown: true,
        confirm_sleep: false,
        show_turn_on:   state.visibility.turn_on,
        show_sleep:     state.visibility.sleep,
        show_shutdown:  state.visibility.shutdown,
        show_cpu_usage: state.metricVis.cpu_usage,
        show_cpu_temp:  state.metricVis.cpu_temp,
        show_gpu_usage: state.metricVis.gpu_usage,
        show_gpu_temp:  state.metricVis.gpu_temp,
        show_ram_usage: state.metricVis.ram_usage,
        show_storage:   state.metricVis.storage,
        accent_color:   state.accent || null,
        metrics,
      };
```

to:

```js
      const base = {
        status_entity: 'binary_sensor.pc_status',
        turn_on:  'switch.my_pc',
        sleep:    'button.my_pc_sleep',
        restart:  'button.my_pc_restart',
        shutdown: 'button.my_pc_shutdown',
        confirm_shutdown: true,
        confirm_sleep: false,
        confirm_restart: false,
        show_turn_on:   state.visibility.turn_on,
        show_sleep:     state.visibility.sleep,
        show_restart:   state.visibility.restart,
        show_shutdown:  state.visibility.shutdown,
        show_cpu_usage: state.metricVis.cpu_usage,
        show_cpu_temp:  state.metricVis.cpu_temp,
        show_gpu_usage: state.metricVis.gpu_usage,
        show_gpu_temp:  state.metricVis.gpu_temp,
        show_ram_usage: state.metricVis.ram_usage,
        show_storage:   state.metricVis.storage,
        accent_color:   state.accent || null,
        metrics,
        drives: [
          { status: 'sensor.my_pc_drive1_status', temp: 'sensor.my_pc_drive1_temp', name: 'Drive 1' },
          { status: 'sensor.my_pc_drive2_status', temp: 'sensor.my_pc_drive2_temp', name: 'Drive 2' },
        ],
      };
```

- [ ] **Step 6: Emit restart + drives in the copyable YAML**

Change (lines 588-592):

```js
      'sleep:    button.YOUR_PC_SLEEP',
      'shutdown: button.YOUR_PC_SHUTDOWN',
      'confirm_shutdown: true',
      'confirm_sleep: false',
      `show_turn_on:   ${visibility.turn_on}`,
```

to:

```js
      'sleep:    button.YOUR_PC_SLEEP',
      'restart:  button.YOUR_NAS_REBOOT          # Synology DSM reboot button',
      'shutdown: button.YOUR_PC_SHUTDOWN',
      'confirm_shutdown: true',
      'confirm_sleep: false',
      'confirm_restart: true',
      `show_turn_on:   ${visibility.turn_on}`,
```

Change (lines 593-594):

```js
      `show_sleep:     ${visibility.sleep}`,
      `show_shutdown:  ${visibility.shutdown}`,
```

to:

```js
      `show_sleep:     ${visibility.sleep}`,
      `show_restart:   ${visibility.restart}`,
      `show_shutdown:  ${visibility.shutdown}`,
```

Then change the storage block tail (lines 607-609):

```js
      ...ramLines,
      ...storageLines,
    ].join('\n');
```

to:

```js
      ...ramLines,
      ...storageLines,
      'drives:                                   # per-physical-disk health + temp',
      '  - status: sensor.YOUR_NAS_DRIVE_1_STATUS',
      '    temp:   sensor.YOUR_NAS_DRIVE_1_TEMP',
      '    name: Drive 1',
      '  - status: sensor.YOUR_NAS_DRIVE_2_STATUS',
      '    temp:   sensor.YOUR_NAS_DRIVE_2_TEMP',
      '    name: Drive 2',
    ].join('\n');
```

- [ ] **Step 7: Drift drive temperatures while on (optional polish)**

Change (lines 645-646):

```js
    drift('sensor.my_pc_storage2_percent',    20, 30);
    drift('sensor.my_pc_storage2_used',       1.0, 1.5);
```

to:

```js
    drift('sensor.my_pc_storage2_percent',    20, 30);
    drift('sensor.my_pc_storage2_used',       1.0, 1.5);
    drift('sensor.my_pc_drive1_temp',         32, 46);
    drift('sensor.my_pc_drive2_temp',         34, 48);
```

- [ ] **Step 8: Verify the demo loads in a browser**

Run: open `docs/index.html` (e.g. `npx serve docs` then visit the URL, or open the file directly).
Expected: Three cards render. Toggling **Restart** in the Buttons control shows a Restart button; clicking it shows the pulsing "Restarting" state, the status dips then returns to On. The feature card shows two Drive rows with green dots and temperatures; the chip shows a `DRIVES 2/2` summary. No console errors.

- [ ] **Step 9: Commit**

```bash
git add docs/index.html
git commit -m "docs: demo Restart button + drive health"
```

---

## Self-Review

**Spec coverage:**
- Data sourcing via Synology DSM, no agent → README Task 9 (Synology section + companion note). ✓
- Restart as 4th optional button (`restart`, `show_restart` default false, `confirm_restart`) → Task 5. ✓
- Button order On · Sleep · Restart · Shut down; up to 4 → Task 5 Steps 16-17. ✓
- `restarting` pending state with dip-detection + `RESTART_TIMEOUT_MS` → Task 5 Steps 3, 9-11. ✓
- `uptime_entity` (timestamp + numeric duration), fallback to `last_changed` → Tasks 2 & 4. ✓
- Volume usage bars → already supported (reused `storages`); demonstrated in README/demo. ✓
- Per-drive health (feature rows; chip summary; tile none) → Task 6. ✓
- `healthy_states` config + green/red dot via `--spc-ok`/`--spc-alert` → Tasks 3 & 6. ✓
- NAS `icon` → Task 6. ✓
- Visual editor: restart, confirm_restart, show_restart, show_drives, uptime_entity, icon, Drives slots → Task 7. ✓
- Backward compatibility (defaults preserve PC behavior) → covered by defaults in Tasks 4-6; verified by the "PC config" tests in Tasks 5 & 6. ✓
- Docs + demo sync + version bump → Tasks 8-10; sync guarded by Task 8 test. ✓
- Dev-only tests via jsdom + node:test → Task 1; single-file distribution untouched. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows full code. ✓

**Type/name consistency:** `_drives`, `_healthyStates`, `_restartDipped`, `_normalizeDrives`, `_driveValue`, `driveHealthy`, `uptimeMsFromEntity`, `DEFAULT_HEALTHY`, `RESTART_TIMEOUT_MS`, `DRIVE_SLOTS`, template params `(storages, drives, iconSvg)`, data-keys `drive_${i}` / `drives_summary`, classes `.drive`/`.ddot`/`.dname`/`.dval`/`.mval.bad` — used identically across tasks. ✓

**Note on line numbers:** anchors are from the current file; after early tasks insert lines, later anchors shift. Each edit's `old_string` context is unique enough to locate regardless of exact line number — match on the code, not the line.
