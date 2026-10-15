import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { clearProjectRootCache, enumerateProjectRoots, projectMemoryRoot, globalMemoryRoot } from '../src/paths.js';
import { collectConsolidationCandidates, collectProjectFacts, readGlobalFacts } from '../src/store.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sm-cons-'));
}

function writeFactAt(root: string, name: string, type: string, description: string, body: string, origin?: string) {
  fs.mkdirSync(root, { recursive: true });
  const meta = `  node_type: memory\n  type: ${type}${origin ? `\n  originSessionId: ${origin}` : ''}`;
  const content = `---\nname: ${name}\ndescription: ${description}\nmetadata:\n${meta}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(root, `${name}.md`), content);
}

beforeEach(() => {
  process.env.PI_SCOPED_MEMORY_HOME = tmpHome();
  clearProjectRootCache();
});

describe('enumerateProjectRoots', () => {
  it('空母目录返回空数组', () => {
    expect(enumerateProjectRoots()).toEqual([]);
  });
  it('列出每个项目层 root（mkdir 即生效）', () => {
    const r1 = projectMemoryRoot('/tmp/proj-a');
    const r2 = projectMemoryRoot('/tmp/proj-b');
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    const roots = enumerateProjectRoots();
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r === r1)).toBe(true);
    expect(roots.some((r) => r === r2)).toBe(true);
  });
});

describe('collectConsolidationCandidates', () => {
  it('同 name 跨 2 项目 → 成簇', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'deploy-via-git', 'user', '不直接改服务器', 'rule body A');
    writeFactAt(b, 'deploy-via-git', 'user', '不直接改服务器', 'rule body B');
    const clusters = collectConsolidationCandidates();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
    expect(clusters[0]!.projectSlugs).toHaveLength(2);
    expect(clusters[0]!.hasGlobalMember).toBe(false);
  });

  it('单项目单条不成簇', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    writeFactAt(a, 'solo-fact', 'project', '只有一条', 'body');
    expect(collectConsolidationCandidates()).toHaveLength(0);
  });

  it('legacy-* 前缀排除出候选（含 legacy-local- 与 legacy- 两形态）', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'legacy-local-memory-abc', 'project', '归档', 'old');
    writeFactAt(b, 'legacy-daily-2026-09-30', 'project', '归档', 'old');
    expect(collectConsolidationCandidates()).toHaveLength(0);
  });

  it('全局既有等价条目纳入簇（hasGlobalMember=true，供 merge 判定）', () => {
    const g = globalMemoryRoot();
    const a = projectMemoryRoot('/tmp/proj-a');
    writeFactAt(g, 'dropdown-cap-visible-rows', 'feedback', 'UI 偏好', 'global body');
    writeFactAt(a, 'dropdown-cap-visible-rows', 'feedback', 'UI 偏好', 'project body');
    const clusters = collectConsolidationCandidates();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.hasGlobalMember).toBe(true);
    expect(clusters[0]!.members.some((m) => m.target === 'global')).toBe(true);
  });

  it('name 归一化：去日期/hash 后缀仍成簇', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'prod-deploy-20260913', 'project', '发布记录', 'body');
    writeFactAt(b, 'prod-deploy-20260917', 'project', '发布记录', 'body');
    const clusters = collectConsolidationCandidates();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
  });

  it('meta 解析失败（无 frontmatter）仍进候选池，type=null', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'bare-fact.md'), 'no frontmatter body');
    fs.writeFileSync(path.join(b, 'bare-fact.md'), 'no frontmatter body');
    const clusters = collectConsolidationCandidates();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.every((m) => m.type === null)).toBe(true);
  });

  it('collectProjectFacts 与 readGlobalFacts 分层正确', () => {
    const g = globalMemoryRoot();
    const a = projectMemoryRoot('/tmp/proj-a');
    writeFactAt(g, 'global-only', 'user', 'g', 'gb');
    writeFactAt(a, 'proj-only', 'project', 'p', 'pb');
    expect(readGlobalFacts()).toHaveLength(1);
    expect(collectProjectFacts()).toHaveLength(1);
    expect(collectConsolidationCandidates()).toHaveLength(0); // 不同 name，不成簇
  });
});
