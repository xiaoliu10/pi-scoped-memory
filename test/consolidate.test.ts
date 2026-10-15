import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { clearProjectRootCache, enumerateProjectRoots, projectMemoryRoot, globalMemoryRoot } from '../src/paths.js';
import { applyProposal, collectConsolidationCandidates, collectProjectFacts, loadProposal, readGlobalFacts, saveProposal, scanSensitive, type Proposal } from '../src/store.js';
import { createHash } from 'node:crypto';

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

describe('scanSensitive', () => {
  it('命中 IP / 密码 / token / 私钥', () => {
    expect(scanSensitive('connect to 10.20.30.201 via ssh')).toContain('ipv4');
    expect(scanSensitive('password: hunter2')).toContain('password-eq');
    expect(scanSensitive('api_key=sk-abcdef123456')).toContain('secret-eq');
    expect(scanSensitive('-----BEGIN RSA PRIVATE KEY-----')).toContain('private-key');
  });
  it('正常文本无命中', () => {
    expect(scanSensitive('用户偏好用 pnpm 打包，中文回复')).toEqual([]);
  });
});

function sha256Of(root: string, name: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(root, `${name}.md`))).digest('hex');
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'c1',
    decision: 'promote',
    globalName: 'pref-pnpm',
    globalType: 'user',
    globalBody: '用户偏好用 pnpm 管理前端依赖。',
    sourceProjects: ['proj-a', 'proj-b'],
    sourceFiles: [],
    reasoning: '两项目均出现 pnpm 偏好',
    ...overrides,
  };
}

describe('saveProposal / loadProposal', () => {
  it('落盘 json + md，可按 id 读回', () => {
    const pid = saveProposal([makeProposal()]);
    expect(pid).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const rec = loadProposal(pid);
    expect(rec).not.toBeNull();
    expect(rec!.proposals).toHaveLength(1);
    expect(rec!.proposals[0]!.globalName).toBe('pref-pnpm');
    expect(fs.existsSync(path.join(globalMemoryRoot(), '.consolidation', 'proposals', `${pid}.md`))).toBe(true);
  });
  it('loadProposal 不存在的 id 返回 null', () => {
    expect(loadProposal('nonexistent')).toBeNull();
  });
});

describe('applyProposal', () => {
  it('promote：写全局 + 索引 + 源标注全部落盘', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'pref-pnpm', 'user', '用 pnpm', 'body A');
    writeFactAt(b, 'pref-pnpm', 'user', '用 pnpm', 'body B');
    const p = makeProposal({
      sourceFiles: [
        { target: 'project', projectSlug: path.basename(a), name: 'pref-pnpm', sha256: sha256Of(a, 'pref-pnpm') },
        { target: 'project', projectSlug: path.basename(b), name: 'pref-pnpm', sha256: sha256Of(b, 'pref-pnpm') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    // 全局事实存在
    const gFile = path.join(globalMemoryRoot(), 'pref-pnpm.md');
    expect(fs.existsSync(gFile)).toBe(true);
    expect(fs.readFileSync(gFile, 'utf8')).toContain('Promoted from');
    // 全局索引含 pointer
    expect(fs.readFileSync(path.join(globalMemoryRoot(), 'MEMORY.md'), 'utf8')).toMatch(/pref-pnpm\.md/);
    // 源标注
    expect(fs.readFileSync(path.join(a, 'pref-pnpm.md'), 'utf8')).toContain('promotedTo: pref-pnpm');
    expect(fs.readFileSync(path.join(b, 'pref-pnpm.md'), 'utf8')).toContain('promotedTo: pref-pnpm');
  });

  it('敏感命中且未 force → 拒绝，不写全局', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'ssh-access', 'project', 'ssh', 'body A');
    writeFactAt(b, 'ssh-access', 'project', 'ssh', 'body B');
    const p = makeProposal({
      globalName: 'ssh-access', globalType: 'feedback',
      globalBody: '测试服务器 10.20.30.201 的 SSH 要用 sshpass',
      sourceFiles: [
        { target: 'project', projectSlug: path.basename(a), name: 'ssh-access', sha256: sha256Of(a, 'ssh-access') },
        { target: 'project', projectSlug: path.basename(b), name: 'ssh-access', sha256: sha256Of(b, 'ssh-access') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors.join('')).toMatch(/敏感.*ipv4/);
    expect(fs.existsSync(path.join(globalMemoryRoot(), 'ssh-access.md'))).toBe(false);
  });

  it('敏感命中且 force=true → 放行但记录', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'deploy-host', 'user', 'h', 'b A');
    writeFactAt(b, 'deploy-host', 'user', 'h', 'b B');
    const p = makeProposal({
      globalName: 'deploy-host', globalType: 'user',
      globalBody: '部署主机 192.168.1.1',
      sourceFiles: [
        { target: 'project', projectSlug: path.basename(a), name: 'deploy-host', sha256: sha256Of(a, 'deploy-host') },
        { target: 'project', projectSlug: path.basename(b), name: 'deploy-host', sha256: sha256Of(b, 'deploy-host') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid, true);
    expect(r.applied).toBe(1);
    expect(fs.existsSync(path.join(globalMemoryRoot(), 'deploy-host.md'))).toBe(true);
  });

  it('CAS 失败（源文件中途被改）→ 跳过该项', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'cas-fact', 'user', 'c', 'body A');
    writeFactAt(b, 'cas-fact', 'user', 'c', 'body B');
    const p = makeProposal({
      globalName: 'cas-fact', globalType: 'user', globalBody: '泛化 body',
      sourceFiles: [
        { target: 'project', projectSlug: path.basename(a), name: 'cas-fact', sha256: sha256Of(a, 'cas-fact') },
        { target: 'project', projectSlug: path.basename(b), name: 'cas-fact', sha256: 'deadbeef' }, // 错误 hash
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors.join('')).toMatch(/CAS/);
  });

  it('类型门：promote 的 globalType=project → 拒绝', () => {
    const p = makeProposal({ decision: 'promote', globalType: 'project' as never, globalName: 'type-gate' });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.skipped).toBe(1);
    expect(r.errors.join('')).toMatch(/类型门/);
  });

  it('类型门放行 merge：globalType=project 的 merge 不受类型门约束（litellm 迁移双层重复处置）', () => {
    const g = globalMemoryRoot();
    const a = projectMemoryRoot('/tmp/proj-a');
    // 全局既有 project 类型条目（litellm 迁移遗留形态）
    writeFactAt(g, 'migrated-proj-fact', 'project', '迁移遗留', '全局 project body', 'sess_migrated');
    writeFactAt(a, 'migrated-proj-fact', 'project', '迁移遗留', '项目层副本');
    const p = makeProposal({
      decision: 'merge',
      globalType: 'project' as never,
      globalName: 'migrated-proj-fact',
      globalBody: '全局 project body（merge 不改类型，仅标注项目层）',
      sourceProjects: [path.basename(a)],
      sourceFiles: [
        { target: 'global', name: 'migrated-proj-fact', sha256: sha256Of(g, 'migrated-proj-fact') },
        { target: 'project', projectSlug: path.basename(a), name: 'migrated-proj-fact', sha256: sha256Of(a, 'migrated-proj-fact') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    // merge 放行：applied=1，不因 project 类型被挡
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(0);
    // 项目层加标注（处置双层重复）
    expect(fs.readFileSync(path.join(a, 'migrated-proj-fact.md'), 'utf8')).toContain('promotedTo: migrated-proj-fact');
  });

  it('merge：全局已有等价条目 → force 覆盖全局 + 源标注', () => {
    const g = globalMemoryRoot();
    const a = projectMemoryRoot('/tmp/proj-a');
    writeFactAt(g, 'existing-fact', 'user', '旧描述', '旧 body', 'sess_orig');
    writeFactAt(a, 'existing-fact', 'user', '项目版', '项目 body');
    const p = makeProposal({
      decision: 'merge', globalName: 'existing-fact', globalType: 'user',
      globalBody: '更新后的全局 body',
      sourceFiles: [
        { target: 'global', name: 'existing-fact', sha256: sha256Of(g, 'existing-fact') },
        { target: 'project', projectSlug: path.basename(a), name: 'existing-fact', sha256: sha256Of(a, 'existing-fact') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.applied).toBe(1);
    // 全局被 force 覆盖（renderFact force=true 路径）
    expect(fs.readFileSync(path.join(g, 'existing-fact.md'), 'utf8')).toContain('更新后的全局 body');
    expect(fs.readFileSync(path.join(g, 'existing-fact.md'), 'utf8')).toContain('consolidated-');
    // 项目层加标注
    expect(fs.readFileSync(path.join(a, 'existing-fact.md'), 'utf8')).toContain('promotedTo: existing-fact');
  });

  it('journal 落盘', () => {
    const a = projectMemoryRoot('/tmp/proj-a');
    const b = projectMemoryRoot('/tmp/proj-b');
    writeFactAt(a, 'j-fact', 'user', 'j', 'bA');
    writeFactAt(b, 'j-fact', 'user', 'j', 'bB');
    const p = makeProposal({
      globalName: 'j-fact', globalType: 'user', globalBody: '泛化',
      sourceFiles: [
        { target: 'project', projectSlug: path.basename(a), name: 'j-fact', sha256: sha256Of(a, 'j-fact') },
        { target: 'project', projectSlug: path.basename(b), name: 'j-fact', sha256: sha256Of(b, 'j-fact') },
      ],
    });
    const pid = saveProposal([p]);
    const r = applyProposal(pid);
    expect(r.journalFile).toBeDefined();
    expect(fs.existsSync(r.journalFile!)).toBe(true);
    const j = JSON.parse(fs.readFileSync(r.journalFile!, 'utf8'));
    expect(j.journal).toHaveLength(1);
    expect(j.journal[0].ok).toBe(true);
  });
});
