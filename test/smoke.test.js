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
