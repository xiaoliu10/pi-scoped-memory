import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { containedPath, factFile, globalMemoryRoot, projectMemoryRoot } from '../src/paths.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sm-'));
}

beforeEach(() => {
  process.env.PI_SCOPED_MEMORY_HOME = tmpHome();
});

describe('projectMemoryRoot', () => {
  it('derives slug + sha256[:16] from normalized cwd', () => {
    const root = projectMemoryRoot('/tmp/demo-app');
    const base = path.basename(process.env.PI_SCOPED_MEMORY_HOME!);
    expect(root).toContain(`${path.sep}memory-projects${path.sep}demo-app-`);
    expect(root).toMatch(/-[0-9a-f]{16}$/);
    void base;
  });
  it('caches per normalized path (Bash cd must not change root)', () => {
    expect(projectMemoryRoot('/tmp/demo-app')).toBe(projectMemoryRoot('/tmp/demo-app'));
    expect(projectMemoryRoot('/tmp/other')).not.toBe(projectMemoryRoot('/tmp/demo-app'));
  });
  it('windows path casing collapses to one key', () => {
    const a = projectMemoryRoot('/tmp/Demo-App');
    const b = projectMemoryRoot('/tmp/demo-app');
    if (process.platform === 'win32') expect(a).toBe(b);
    else expect(a).not.toBe(b);
  });
});

describe('globalMemoryRoot', () => {
  it('points at <home>/memory (pi-memory compatible layout)', () => {
    expect(globalMemoryRoot()).toBe(path.join(process.env.PI_SCOPED_MEMORY_HOME!, 'memory'));
  });
});

describe('containedPath', () => {
  const root = '/tmp/root';
  it('allows direct children only', () => {
    expect(containedPath(root, 'foo.md')).toBe(path.join(root, 'foo.md'));
    expect(containedPath(root, 'sub/foo.md')).toBeUndefined();
  });
  it('rejects traversal and reserved/unsafe names', () => {
    expect(containedPath(root, '../evil.md')).toBeUndefined();
    expect(containedPath(root, 'a/b/../../../evil.md')).toBeUndefined();
    expect(containedPath(root, 'fo<b>.md')).toBeUndefined();
    expect(containedPath(root, '')).toBeUndefined();
  });
});

describe('factFile', () => {
  it('enforces kebab-case names', () => {
    const root = '/tmp/r';
    expect(factFile(root, 'api-base-url')).toBe(path.join(root, 'api-base-url.md'));
    expect(factFile(root, 'Bad_Name')).toBeUndefined();
    expect(factFile(root, '-x')).toBeUndefined();
  });
});
