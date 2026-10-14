/**
 * 事实文件 frontmatter：name/description/metadata(type, originSessionId)。
 * 写入边界只在 originSessionId 缺失时序列化一次补齐 node_type + session id（ZCode 同语义）；
 * 已有非空 origin 的文件原样保留，不做格式规范化。
 * 注入面清理：invisible/bidi 字符剥除（对齐 yandy 的 injection sanitising）。
 */
import fs from 'node:fs';

export type FactType = 'user' | 'feedback' | 'project' | 'reference';

export interface FactMeta {
  name: string;
  description: string;
  type: FactType;
  originSessionId?: string;
}

const BIDI_AND_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;

export function sanitizeInjected(text: string): string {
  return text.replace(BIDI_AND_INVISIBLE, '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ParsedFact {
  meta: FactMeta | null; // null = 无 frontmatter 或解析失败（仍可作为无 meta 候选注入）
  body: string;
  raw: string;
}

export function parseFact(raw: string): ParsedFact {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: null, body: normalized, raw: normalized };
  const meta = parseFrontmatter(match[1]!);
  return { meta, body: match[2] ?? '', raw: normalized };
}

function parseFrontmatter(block: string): FactMeta | null {
  const get = (key: string): string | undefined => {
    const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : undefined;
  };
  const name = get('name');
  const description = get('description');
  if (!name || !description) return null;
  const typeBlock = block.match(/^metadata:\s*\n((?:\s{2,}\w+:.*\n?)+)/m);
  const metaBlock = typeBlock ? typeBlock[1]! : block;
  const type = metaBlock.match(/^\s+type:\s*(\w+)/m)?.[1];
  const origin = metaBlock.match(/^\s+originSessionId:\s*(\S+)/m)?.[1];
  const validType = ['user', 'feedback', 'project', 'reference'].includes(type ?? '') ? (type as FactType) : undefined;
  if (!validType) return null;
  return { name, description, type: validType, originSessionId: origin || undefined };
}

/** 生成事实文件全文。origin 缺失时补入；已有 origin 原样保留 body 原文。 */
export function renderFact(existing: string | null, meta: FactMeta, body: string): string {
  if (existing !== null) {
    const parsed = parseFact(existing);
    // 已有非空 origin：整文件原样保留（由调用方决定覆盖策略），这里不重写。
    if (parsed.meta?.originSessionId) return existing;
    // 缺 origin：只补 frontmatter，body 保持原文。
    const head = renderFrontmatter({ ...meta, originSessionId: parsed.meta?.originSessionId ?? meta.originSessionId });
    return `${head}\n${parsed.body}`;
  }
  return `${renderFrontmatter(meta)}\n${body.replace(/\n+$/, '')}\n`;
}

function renderFrontmatter(meta: FactMeta): string {
  return [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${meta.type}`,
    ...(meta.originSessionId ? [`  originSessionId: ${meta.originSessionId}`] : []),
    '---',
    '',
  ].join('\n');
}

/** 索引 pointer 行（default-index 分支：一行一条 `- [Title](file.md) — hook`）。 */
export function indexLine(meta: FactMeta): string {
  return `- [${meta.name}](${meta.name}.md) — ${meta.description.replace(/\n/g, ' ')}`;
}

/** 追加/更新索引行：同名条目原位替换，否则追加到末尾（头部手工标题保留）。 */
export function upsertIndexLine(indexContent: string, line: string, fileStem: string): string {
  const lines = indexContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const pattern = new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${fileStem}\\.md\\)`);
  const at = lines.findIndex((l) => pattern.test(l));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return lines.join('\n');
}

/** 读文本：不存在返回 null；读失败按 null（降级为空层，绝不抛错阻断会话）。 */
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
