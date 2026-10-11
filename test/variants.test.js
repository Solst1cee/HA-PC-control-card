import './jsdom-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../pc-control-card.js';

const stateFor = (state) => ({
  states: {
    'binary_sensor.pc': {
      state,
      last_changed: new Date().toISOString(),
      attributes: {},
    },
  },
  callService() {},
});

test('all variants use the same icon container dimensions', () => {
  const expected = [
    '.tile .circle {',
    '.chip .icon-box.chip-icon {',
    '.feature .icon-box.lg {',
  ];

  for (const selector of expected) {
    const card = document.createElement('pc-control-card');
    const variant = selector.includes('tile') ? 'tile' : selector.includes('chip') ? 'chip' : 'feature';
    card.setConfig({ variant, status_entity: 'binary_sensor.pc' });
    const styles = card.shadowRoot.querySelector('style').textContent;
    const start = styles.indexOf(selector);
    assert.notEqual(start, -1);
    const block = styles.slice(start, styles.indexOf('}', start));
    assert.match(block, /width: 44px/);
    assert.match(block, /height: 44px/);
    assert.match(block, /border-radius: 12px/);
    card.disconnectedCallback();
  }
});

test('status tone classes are available on every card variant', () => {
  for (const variant of ['tile', 'chip', 'feature']) {
    const card = document.createElement('pc-control-card');
    card.setConfig({ variant, status_entity: 'binary_sensor.pc' });

    card.hass = stateFor('on');
    assert.ok(card.shadowRoot.querySelector('.status').classList.contains('live'));

    card._pending = 'sleep';
    card._update();
    assert.ok(card.shadowRoot.querySelector('.status').classList.contains('warm'));

    card._pending = null;
    card._showActionError('shutdown_timeout');
    card._update();
    assert.ok(card.shadowRoot.querySelector('.status').classList.contains('alert'));

    card.disconnectedCallback();
  }
});
