/**
 * memory_write / memory_read / memory_search / memory_status 的核心逻辑（与扩展 API 解耦，便于单测）。
 * 写入路由默认规则：type=user|feedback → 全局层；type=project|reference → 项目层（target 显式指定时覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { containedPath, ensureDir, enumerateProjectRoots, factFile, globalMemoryRoot, indexFile, projectMemoryRoot } from './paths.js';
import { appendPromotedToAnnotation, indexLine, parseFact, readText, renderFact, upsertIndexLine, type FactMeta, type FactType } from './facts.js';

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

// ─── P2：propose 落提案 + apply 确定性执行（护栏）──────────────────────────

/** 单条泛化提案（由会话 LLM 据候选簇产出，apply 按此确定性执行）。 */
export interface Proposal {
  id: string;                  // 引用候选簇 id（c1, c2…），便于审计
  decision: 'promote' | 'merge' | 'noop' | 'conflict';
  globalName: string;          // 目标全局事实名（promote 新建 / merge 既有）
  globalType: 'user' | 'feedback'; // 类型门：只允许 user|feedback 上浮
  globalBody: string;
  sourceProjects: string[];    // 来源项目 slug
  sourceFiles: Array<{ target: Target; projectSlug?: string; name: string; sha256: string }>; // CAS 锚点
  reasoning: string;
}

export interface ProposalRecord {
  proposalId: string;          // 时间戳 id
  createdAt: string;
  proposals: Proposal[];
}

export interface ApplyResult {
  ok: boolean;
  proposalId: string;
  applied: number;
  skipped: number;
  errors: string[];
  journalFile?: string;
}

/** 敏感模式扫描（apply 第①步）：命中返回命中模式列表。 */
const SENSITIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'password-eq', re: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
  { name: 'secret-eq', re: /(?:secret|api[_-]?key|token|access[_-]?key)\s*[:=]\s*[A-Za-z0-9_\-]{8,}/i },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
];
export function scanSensitive(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SENSITIVE_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

/** sha256（CAS 锚点）。 */
function sha256File(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 落提案（propose 第⑤步）：写 .consolidation/proposals/<ts>.{json,md}，返回 proposalId。 */
export function saveProposal(proposals: Proposal[]): string {
  const dir = path.join(globalMemoryRoot(), '.consolidation', 'proposals');
  ensureDir(dir);
  const id = timestampId();
  const record: ProposalRecord = { proposalId: id, createdAt: new Date().toISOString(), proposals };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  // 人类可读预览（review gate 展示物）
  const md = proposals.map((p) =>
    `### [${p.id}] ${p.decision} → ${p.globalName} (type=${p.globalType})\n来源: ${p.sourceProjects.join(', ')}\n理由: ${p.reasoning}\n\n${p.globalBody}\n`
  ).join('\n');
  fs.writeFileSync(path.join(dir, `${id}.md`), `# Consolidation Proposal ${id}\n\n${md}\n`);
  return id;
}

export function loadProposal(proposalId: string): ProposalRecord | null {
  const file = path.join(globalMemoryRoot(), '.consolidation', 'proposals', `${proposalId}.json`);
  const raw = readText(file);
  if (!raw) return null;
  try { return JSON.parse(raw) as ProposalRecord; } catch { return null; }
}

/**
 * apply 提案（确定性执行，6 步护栏）。
 * force=true 时放行敏感命中的 globalBody（仍记录在 errors）。
 * 完成标准：每个 proposal 的全局正文 + 全局索引 + 全部源标注均落盘才算 applied；否则 skipped + errors。
 * journal 记录写入前状态（回滚依据）。
 */
export function applyProposal(proposalId: string, force = false): ApplyResult {
  const record = loadProposal(proposalId);
  if (!record) return { ok: false, proposalId, applied: 0, skipped: 0, errors: [`proposal not found: ${proposalId}`] };

  const gRoot = globalMemoryRoot();
  const journalDir = path.join(gRoot, '.consolidation', 'journal');
  ensureDir(journalDir);
  const journalFile = path.join(journalDir, `${timestampId()}.json`);
  const journal: Array<{ proposal: string; action: string; file: string; beforeSha?: string | null; ok: boolean }> = [];

  let applied = 0, skipped = 0;
  const errors: string[] = [];

  for (const p of record.proposals) {
    if (p.decision === 'noop' || p.decision === 'conflict') { skipped++; continue; }
    // 类型门：只允许 user|feedback
    if (p.globalType !== 'user' && p.globalType !== 'feedback') {
      skipped++; errors.push(`[${p.id}] 类型门拦截：globalType=${p.globalType}（只允许 user|feedback）`); continue;
    }
    // ① 敏感扫描
    const sensitive = scanSensitive(p.globalBody);
    if (sensitive.length && !force) {
      skipped++; errors.push(`[${p.id}] 敏感命中 ${sensitive.join(',')}（force=true 才放行）`); continue;
    }
    // ② CAS 校验源文件
    let casOk = true;
    for (const src of p.sourceFiles) {
      const root = src.target === 'global' ? gRoot : path.join(path.dirname(gRoot), 'memory-projects', src.projectSlug!);
      const file = factFile(root, src.name);
      if (!file) { casOk = false; errors.push(`[${p.id}] 源文件名非法: ${src.name}`); break; }
      const cur = sha256File(file);
      if (cur !== src.sha256) { casOk = false; errors.push(`[${p.id}] CAS 失败: ${src.name} 已变更（TOCTOU）`); break; }
    }
    if (!casOk) { skipped++; continue; }

    // ③ 写全局（force 覆盖已有 origin；frontmatter 补 provenance）
    const gFile = factFile(gRoot, p.globalName);
    if (!gFile) { skipped++; errors.push(`[${p.id}] 全局名非法: ${p.globalName}`); continue; }
    const gBeforeSha = sha256File(gFile);
    const existing = readText(gFile);
    const meta: FactMeta = {
      name: p.globalName,
      description: p.reasoning.slice(0, 120),
      type: p.globalType,
      originSessionId: `consolidated-${record.proposalId}`,
    };
    const bodyWithProv = `${p.globalBody}\n\n> Promoted from ${p.sourceProjects.join(', ')}（proposal ${record.proposalId}, ${new Date().toISOString().slice(0,10)}）`;
    try {
      fs.writeFileSync(gFile, renderFact(existing, meta, bodyWithProv, true));
    } catch (e) {
      skipped++; errors.push(`[${p.id}] 全局写入失败: ${(e as Error).message}`); continue;
    }
    // ④ 全局索引 upsert
    const idxPath = indexFile(gRoot);
    const idxBefore = readText(idxPath) ?? '# Memory Index\n';
    try {
      fs.writeFileSync(idxPath, upsertIndexLine(idxBefore, indexLine(meta), p.globalName));
    } catch (e) {
      errors.push(`[${p.id}] 索引写入失败（全局正文已写）: ${(e as Error).message}`);
    }

    // ⑤ 源标注：项目层源条目加 promotedTo（非破坏性，不删）
    for (const src of p.sourceFiles) {
      if (src.target === 'global') continue; // 全局既有等价条目（merge 场景）不加标注
      const root = path.join(path.dirname(gRoot), 'memory-projects', src.projectSlug!);
      const file = factFile(root, src.name);
      if (!file) continue;
      const before = readText(file);
      if (!before) continue;
      const annotated = appendPromotedToAnnotation(before, p.globalName, `Promoted to global memory \`${p.globalName}\` (${record.proposalId}). 原项目层文件保留作语境细节。`);
      try { fs.writeFileSync(file, annotated); } catch { /* 标注失败不回滚全局 */ }
    }

    journal.push({ proposal: p.id, action: `write global ${p.globalName} + annotate ${p.sourceFiles.length} sources`, file: gFile, beforeSha: gBeforeSha, ok: true });
    applied++;
  }

  try { fs.writeFileSync(journalFile, JSON.stringify({ proposalId: record.proposalId, journal }, null, 2)); } catch { /* journal 失败不影响已应用 */ }
  return { ok: skipped === 0, proposalId: record.proposalId, applied, skipped, errors, journalFile };
}
