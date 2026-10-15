/**
 * memory_write / memory_read / memory_search / memory_status 的核心逻辑（与扩展 API 解耦，便于单测）。
 * 写入路由默认规则：type=user|feedback → 全局层；type=project|reference → 项目层（target 显式指定时覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { containedPath, ensureDir, enumerateProjectRoots, factFile, globalMemoryRoot, indexFile, projectMemoryRoot } from './paths.js';
import { indexLine, parseFact, readText, renderFact, upsertIndexLine, type FactMeta, type FactType } from './facts.js';

export type Target = 'global' | 'project';

export function resolveTarget(type: FactType, explicit?: Target): Target {
  if (explicit) return explicit;
  return type === 'user' || type === 'feedback' ? 'global' : 'project';
}

export function layerRoot(target: Target, cwd: string | undefined): string {
  return target === 'global' ? globalMemoryRoot() : projectMemoryRoot(cwd ?? process.cwd());
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  file?: string;
  root?: string;
}

export function writeFact(input: {
  cwd: string | undefined;
  name: string;
  description: string;
  type: FactType;
  body: string;
  target?: Target;
  sessionId?: string;
}): WriteResult {
  const target = resolveTarget(input.type, input.target);
  if (target === 'project' && !input.cwd) return { ok: false, error: '项目层写入需要会话 cwd（当前为全局/无项目上下文），请显式 target=global。' };
  const root = layerRoot(target, input.cwd);
  const file = factFile(root, input.name);
  if (!file) return { ok: false, error: `非法记忆名（限小写字母数字与连字符，≤80 字符）：${input.name}` };
  ensureDir(root);
  const meta: FactMeta = { name: input.name, description: input.description, type: input.type, originSessionId: input.sessionId };
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch { /* 新文件 */ }
  const content = renderFact(existing, meta, input.body);
  try {
    fs.writeFileSync(file, content);
  } catch (error) {
    return { ok: false, error: `写入失败：${(error as Error).message}` };
  }
  // 索引 pointer：同名原位替换，否则追加；索引不存在则新建带标题的。
  const indexPath = indexFile(root);
  const currentIndex = readText(indexPath) ?? '# Memory Index\n';
  const updated = upsertIndexLine(currentIndex, indexLine(meta), input.name);
  try {
    fs.writeFileSync(indexPath, updated.endsWith('\n') ? updated : `${updated}\n`);
  } catch { /* 索引写失败不回滚事实文件；下次写入会重试 upsert */ }
  return { ok: true, file, root };
}

export function readMemory(cwd: string | undefined, target: Target, name: string): { ok: boolean; content?: string; error?: string } {
  const root = layerRoot(target, cwd);
  if (name === 'MEMORY.md') {
    const content = readText(indexFile(root));
    return content === null ? { ok: false, error: `${target} 层索引不存在` } : { ok: true, content };
  }
  const file = factFile(root, name);
  if (!file) return { ok: false, error: `非法记忆名：${name}` };
  const content = readText(file);
  return content === null ? { ok: false, error: `${target} 层不存在记忆 ${name}` } : { ok: true, content };
}

export interface SearchHit {
  target: Target;
  name: string;
  description: string;
  snippet: string;
}

/** 关键词检索（大小写不敏感，name/description/body 全匹配）。v2 再接 qmd。 */
export function searchMemory(cwd: string | undefined, query: string, target?: Target): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const targets: Target[] = target ? [target] : ['project', 'global'];
  const hits: SearchHit[] = [];
  for (const t of targets) {
    const root = layerRoot(t, cwd);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch { /* 层不存在 = 空结果 */ }
    for (const entry of entries) {
      const rel = containedPath(root, entry);
      if (!rel) continue;
      const raw = readText(rel);
      if (!raw) continue;
      const parsed = parseFact(raw);
      const haystack = `${entry}\n${parsed.meta?.description ?? ''}\n${parsed.body}`.toLowerCase();
      const at = haystack.indexOf(q);
      if (at < 0) continue;
      hits.push({
        target: t,
        name: entry.replace(/\.md$/, ''),
        description: parsed.meta?.description ?? '',
        snippet: raw.slice(Math.max(0, at - 40), at + 80).replace(/\n/g, ' '),
      });
    }
  }
  return hits;
}

export function memoryStatus(cwd: string | undefined): string {
  const lines: string[] = [];
  for (const target of ['global', 'project'] as const) {
    const root = layerRoot(target, cwd);
    let count = 0;
    try {
      count = fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
    } catch { /* 不存在 */ }
    lines.push(`${target}: ${root} (${count} facts)`);
  }
  return lines.join('\n');
}

// ─── consolidation 候选收集（P1：纯机械，无写入）───────────────────────────
// 设计依据 docs/design/memory-consolidation.md §4。propose 阶段只做扫描+粗筛，
// 语义判定（promote/merge/noop/conflict）由调用会话的 LLM 完成——工具零模型依赖。

/** 单条事实的扁平视图（跨项目扫描用，meta=null 兜底）。 */
export interface FactEntry {
  target: Target;
  projectSlug?: string;   // 项目层目录名（slug-hash）；全局层为 undefined
  name: string;           // 文件名去 .md
  description: string;    // frontmatter description，无则 ''
  type: FactType | null;  // 解析失败为 null
  body: string;
  raw: string;
  isLegacy: boolean;      // legacy-local-* 归档前缀，默认排除出候选
}

/** 候选簇：跨 ≥2 项目（或 ≥1 项目+全局既有）的同主题条目。 */
export interface CandidateCluster {
  id: string;             // 稳定短 ID：c1, c2…
  key: string;            // 粗筛键（归一化 name 或 token 重叠签名）
  members: FactEntry[];   // 候选成员（已排除 legacy，含全局既有等价物）
  projectSlugs: string[]; // 去重的来源项目
  hasGlobalMember: boolean;
}

/** 解析某层 root 下全部 .md 事实（跳过 MEMORY.md/SCRATCHPAD.md/daily/）。 */
function scanLayer(target: Target, root: string, projectSlug?: string): FactEntry[] {
  const out: FactEntry[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'SCRATCHPAD.md');
  } catch { return out; }
  for (const entry of entries) {
    const file = containedPath(root, entry);
    if (!file) continue;
    const raw = readTextSafe(file);
    if (raw === null) continue;
    const parsed = parseFact(raw);
    const name = entry.replace(/\.md$/, '');
    out.push({
      target,
      projectSlug,
      name,
      description: parsed.meta?.description ?? '',
      type: parsed.meta?.type ?? null,
      body: parsed.body,
      raw,
      isLegacy: name.startsWith('legacy-'),
    });
  }
  return out;
}

// readText 兜底：facts.ts 的 readText 已捕获异常，这里跨文件扫描同样语义
function readTextSafe(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** 读全局层全部事实。 */
export function readGlobalFacts(): FactEntry[] {
  return scanLayer('global', globalMemoryRoot());
}

/** 读全部项目层事实（枚举 memory-projects/ 下每个 root）。 */
export function collectProjectFacts(): FactEntry[] {
  const all: FactEntry[] = [];
  for (const root of enumerateProjectRoots()) {
    const slug = path.basename(root);
    all.push(...scanLayer('project', root, slug));
  }
  return all;
}

/** 归一化 name 作粗筛键：小写、去 legacy 前缀/日期后缀/连词变体。 */
function normalizeNameKey(name: string): string {
  return name
    .replace(/^legacy-local-(?:zcode-)?/, '')
    .replace(/-d{8}$/, '')           // 去日期后缀 _yyyyMMdd
    .replace(/-(?:d{6,}|[0-9a-f]{8,})$/, '') // 去 hash/短哈希后缀
    .toLowerCase();
}

/**
 * 收集 consolidation 候选簇（propose 机械部分）。
 * 策略：(a) 同 normalizeNameKey 跨 ≥2 来源；(b) 跨 ≥2 来源的同 type user|feedback。
 * 排除 isLegacy；全局既有等价条目纳入成员（供 merge 判定，Graphiti #1956：不靠检索排名）。
 * 不做语义判定——只产出候选，decision 留给 LLM。
 */
export function collectConsolidationCandidates(): CandidateCluster[] {
  const project = collectProjectFacts().filter((f) => !f.isLegacy);
  const global = readGlobalFacts();
  const all = [...project, ...global];

  // 按 name 键分组
  const byKey = new Map<string, FactEntry[]>();
  for (const f of all) {
    const key = normalizeNameKey(f.name);
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(f);
    byKey.set(key, arr);
  }

  const clusters: CandidateCluster[] = [];
  let n = 0;
  for (const [key, members] of byKey) {
    // 簇成立条件：≥2 个不同来源（项目 slug 或 global）
    const sources = new Set(members.map((m) => m.projectSlug ?? '__global__'));
    if (sources.size < 2) continue;
    const projectSlugs = [...new Set(members.filter((m) => m.projectSlug).map((m) => m.projectSlug!))];
    const hasGlobalMember = members.some((m) => m.target === 'global');
    clusters.push({
      id: `c${++n}`,
      key,
      members,
      projectSlugs,
      hasGlobalMember,
    });
  }
  // 簇内成员按 (global 优先, 然后 slug) 排序，便于 LLM 对照
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters;
}
