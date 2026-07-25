import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('distributable Skill bundle matches project runtime', () => {
  const result = spawnSync('node', ['scripts/check-skill-bundle.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('bundled FDD harness uses the same trusted validators as PI', () => {
  const bundled = path.join(root, 'test-support/functional-domain-design/validators');
  assert.equal(treeDigest(path.join(root, 'validators')), treeDigest(bundled));
});

test('golden generator defaults to the bundled FDD harness', () => {
  const source = readFileSync(path.join(root, 'assets/golden-simulated/generate.mjs'), 'utf8');
  assert.match(source, /test-support\/functional-domain-design/);
  assert.doesNotMatch(source, /\.\.\/functional-domain-design/);
});

test('installed Skill script resolves independently of caller cwd', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'implementation-skill-cwd-'));
  try {
    const script = path.join(root, 'skills/project-implementation/scripts/prepare-implementation.mjs');
    const result = spawnSync('node', [script], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: prepare-implementation/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('unsupported user-waiver preparation entrypoint is absent', () => {
  assert.equal(existsSync(path.join(root, 'scripts/prepare-user-waiver-implementation.mjs')), false);
  assert.equal(existsSync(path.join(root, 'skills/project-implementation/scripts/prepare-user-waiver-implementation.mjs')), false);
});

function treeDigest(dir) { const hash = createHash('sha256'); for (const file of walk(dir)) hash.update(path.relative(dir, file)).update('\0').update(readFileSync(file)).update('\0'); return hash.digest('hex'); }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]).sort(); }
