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
