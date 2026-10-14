/**
 * 注入：session 初始化读一次，冻结快照（KV cache 稳定——turn 间字节不变）。
 * 结构（对齐 ZCode request-user-context 多 source 标注）：
 *   ## Scoped Memory
 *   ### Global memory (~/...)        ← 全局层索引
 *   ### Project memory (<root>)      ← 项目层索引
 * 截断：每段 ≤200 行且 ≤25,000 字符（ZCode default-index 同参数），从文件头保留。
 * 任一层缺失/空/不可读 → 该段静默跳过；两层全空 → 不注入（返回 ''）。
 */
import { globalMemoryRoot, projectMemoryRoot } from './paths.js';
import { readText, sanitizeInjected } from './facts.js';

export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_CHARS = 25_000;

export interface MemoryLayer {
  label: string;
  root: string;
  index: string;
}

export function collectLayers(cwd: string | undefined): MemoryLayer[] {
  const layers: MemoryLayer[] = [];
  const gRoot = globalMemoryRoot();
  const gIndex = readText(sanitizeIndex(gRoot));
  if (gIndex?.trim()) layers.push({ label: `Global memory (${gRoot})`, root: gRoot, index: gIndex });
  if (cwd) {
    const pRoot = projectMemoryRoot(cwd);
    const pIndex = readText(sanitizeIndex(pRoot));
    if (pIndex?.trim()) layers.push({ label: `Project memory (${pRoot})`, root: pRoot, index: pIndex });
  }
  return layers;
}

function sanitizeIndex(root: string): string {
  return `${root}/MEMORY.md`;
}

export function truncateIndex(content: string): string {
  const cleaned = content.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return '';
  const allLines = cleaned.split('\n');
  const byLines = allLines.length > MAX_INDEX_LINES ? allLines.slice(0, MAX_INDEX_LINES).join('\n') : cleaned;
  if (byLines.length > MAX_INDEX_CHARS) {
    return `${byLines.slice(0, MAX_INDEX_CHARS)}\n…（索引超限，已截断）`;
  }
  return allLines.length > MAX_INDEX_LINES ? `${byLines}\n…（索引超限，已截断）` : byLines;
}

/** 构建注入块。两层全空返回 ''（调用方据此跳过注入）。 */
export function buildMemoryBlock(cwd: string | undefined): string {
  const layers = collectLayers(cwd);
  if (!layers.length) return '';
  const sections = layers.map((layer) => {
    const index = truncateIndex(layer.index);
    if (!index) return '';
    return `### ${layer.label}\n\nContents of ${layer.root}/MEMORY.md (auto-memory index, persists across conversations):\n\n${index}`;
  }).filter(Boolean);
  if (!sections.length) return '';
  return [
    '## Scoped Memory',
    '',
    'You have persistent file-based memory in two layers. Facts are one file each under the layer root, with frontmatter (name/description/metadata.type: user|feedback|project|reference). Update MEMORY.md index (one pointer line per fact) after writing a fact file. Prefer updating an existing file over creating duplicates; delete facts that turned out wrong.',
    '',
    'Shared user preferences and cross-project conventions belong to the global layer; project-specific constraints and decisions belong to the project layer. Truly stable cross-project conventions should ultimately live in ~/.pi/agent/AGENTS.md (instructions layer) instead of memory.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

export { sanitizeInjected };
