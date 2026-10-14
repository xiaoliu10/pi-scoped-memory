/**
 * memory_write / memory_read / memory_search / memory_status 的核心逻辑（与扩展 API 解耦，便于单测）。
 * 写入路由默认规则：type=user|feedback → 全局层；type=project|reference → 项目层（target 显式指定时覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { containedPath, ensureDir, factFile, globalMemoryRoot, indexFile, projectMemoryRoot } from './paths.js';
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
