import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildMemoryBlock, truncateIndex } from '../src/inject.js';
import { writeFact } from '../src/store.js';

beforeEach(() => {
  process.env.PI_SCOPED_MEMORY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sm-inj-'));
});

describe('buildMemoryBlock', () => {
  it('empty layers → no injection', () => {
    expect(buildMemoryBlock('/tmp/nothing')).toBe('');
    expect(buildMemoryBlock(undefined)).toBe('');
  });
  it('global and project layers render with source labels in order', () => {
    writeFact({ cwd: '/tmp/app', name: 'user-prefers-brief', description: '回复要简短', type: 'user', body: 'Why: 用户明确要求。\nHow to apply: 默认精简。' });
    writeFact({ cwd: '/tmp/app', name: 'uses-vitest', description: '测试用 vitest', type: 'project', body: 'Why: package.json 固定。\nHow to apply: 新测试一律 vitest。' });
    const block = buildMemoryBlock('/tmp/app');
    expect(block).toContain('## Scoped Memory');
    expect(block).toContain('### Global memory (');
    expect(block).toContain('### Project memory (');
    expect(block.indexOf('Global memory')).toBeLessThan(block.indexOf('Project memory'));
    expect(block).toContain('[user-prefers-brief](user-prefers-brief.md) — 回复要简短');
    expect(block).toContain('[uses-vitest](uses-vitest.md) — 测试用 vitest');
  });
  it('is byte-stable across calls (KV cache snapshot)', () => {
    writeFact({ cwd: '/tmp/app', name: 'fact-a', description: 'd', type: 'project', body: 'b' });
    expect(buildMemoryBlock('/tmp/app')).toBe(buildMemoryBlock('/tmp/app'));
  });
});

describe('truncateIndex', () => {
  it('strips frontmatter and caps at 200 lines / 25000 chars', () => {
    const long = Array.from({ length: 300 }, (_, i) => `- line ${i}`).join('\n');
    const out = truncateIndex(long);
    expect(out.split('\n').length).toBeLessThanOrEqual(201);
    expect(out).toContain('（索引超限，已截断）');
    expect(truncateIndex('---\nname: x\n---\n- real line')).toBe('- real line');
    expect(truncateIndex('   ')).toBe('');
  });
});
