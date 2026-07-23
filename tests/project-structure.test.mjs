import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('distributable Skill bundle matches project runtime', () => {
  const result = spawnSync('node', ['scripts/check-skill-bundle.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
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
