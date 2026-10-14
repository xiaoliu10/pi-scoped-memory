import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { writeFact, readMemory, searchMemory, resolveTarget, memoryStatus } from '../src/store.js';
import { globalMemoryRoot, projectMemoryRoot } from '../src/paths.js';
import { parseFact } from '../src/facts.js';

beforeEach(() => {
  process.env.PI_SCOPED_MEMORY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sm-w-'));
});

describe('resolveTarget routing', () => {
  it('user|feedback → global; project|reference → project; explicit wins', () => {
    expect(resolveTarget('user')).toBe('global');
    expect(resolveTarget('feedback')).toBe('global');
    expect(resolveTarget('project')).toBe('project');
    expect(resolveTarget('reference')).toBe('project');
    expect(resolveTarget('user', 'project')).toBe('project');
    expect(resolveTarget('project', 'global')).toBe('global');
  });
});

describe('writeFact', () => {
  it('routes by type and writes frontmatter + index line', () => {
    const r1 = writeFact({ cwd: '/tmp/app', name: 'likes-short-answers', description: '偏好简短', type: 'user', body: 'Why: 明确说过。', sessionId: 's1' });
    expect(r1.ok).toBe(true);
    expect(r1.file).toContain(globalMemoryRoot());
    const raw1 = fs.readFileSync(r1.file!, 'utf8');
    const p1 = parseFact(raw1);
    expect(p1.meta).toMatchObject({ name: 'likes-short-answers', type: 'user', originSessionId: 's1' });
    expect(raw1).toContain('  node_type: memory');

    const r2 = writeFact({ cwd: '/tmp/app', name: 'deploys-via-qmt', description: '部署走 QMT', type: 'project', body: 'Why: 盒子固定。' });
    expect(r2.file).toContain(projectMemoryRoot('/tmp/app'));
    const idx = readMemory('/tmp/app', 'project', 'MEMORY.md');
    expect(idx.ok).toBe(true);
    expect(idx.content).toContain('[deploys-via-qmt](deploys-via-qmt.md) — 部署走 QMT');
  });
  it('preserves existing originSessionId verbatim', () => {
    const r = writeFact({ cwd: '/tmp/app', name: 'keep-origin', description: 'd', type: 'project', body: 'old', sessionId: 's-old' });
    const before = fs.readFileSync(r.file!, 'utf8');
    const r2 = writeFact({ cwd: '/tmp/app', name: 'keep-origin', description: 'd2', type: 'project', body: 'new body', sessionId: 's-new' });
    const after = fs.readFileSync(r2.file!, 'utf8');
    expect(after).toBe(before); // 已有 origin：原样保留
    expect(parseFact(after).meta?.originSessionId).toBe('s-old');
  });
  it('replaces same-name index line in place', () => {
    writeFact({ cwd: '/tmp/app', name: 'dup', description: 'v1', type: 'project', body: 'b' });
    writeFact({ cwd: '/tmp/app', name: 'dup', description: 'v2', type: 'project', body: 'b2' });
    const idx = readMemory('/tmp/app', 'project', 'MEMORY.md').content!;
    expect(idx.match(/dup\.md/g)?.length).toBe(1);
    expect(idx).toContain('v2');
  });
  it('rejects invalid names and project writes without cwd', () => {
    expect(writeFact({ cwd: undefined, name: 'x', description: 'd', type: 'project', body: 'b' }).ok).toBe(false);
    expect(writeFact({ cwd: '/tmp/app', name: 'BAD', description: 'd', type: 'project', body: 'b' }).ok).toBe(false);
    // 无 cwd 但显式 global 可写
    expect(writeFact({ cwd: undefined, name: 'g-fact', description: 'd', type: 'user', body: 'b', target: 'global' }).ok).toBe(true);
  });
});

describe('readMemory / searchMemory / memoryStatus', () => {
  beforeEach(() => {
    writeFact({ cwd: '/tmp/app', name: 'global-habit', description: '全局习惯', type: 'user', body: 'early lunch' });
    writeFact({ cwd: '/tmp/app', name: 'proj-qmt', description: 'QMT 部署', type: 'project', body: 'deploy via 192.168.2.190' });
  });
  it('reads across layers with explicit target', () => {
    expect(readMemory('/tmp/app', 'global', 'global-habit').content).toContain('early lunch');
    expect(readMemory('/tmp/app', 'project', 'proj-qmt').content).toContain('192.168.2.190');
    expect(readMemory('/tmp/app', 'project', 'global-habit').ok).toBe(false);
  });
  it('searches both layers by default, filters by target on demand', () => {
    const all = searchMemory('/tmp/app', 'qmt');
    expect(all.map((h) => h.name)).toContain('proj-qmt');
    expect(searchMemory('/tmp/app', 'deploy', 'global')).toHaveLength(0);
    expect(searchMemory('/tmp/app', 'early', 'global').length).toBe(1);
  });
  it('status reports both roots', () => {
    const status = memoryStatus('/tmp/app');
    expect(status).toContain('global:');
    expect(status).toContain('project:');
    expect(status).toMatch(/1 facts\).*\nproject:/s);
  });
});
