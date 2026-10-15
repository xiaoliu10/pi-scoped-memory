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

/** 生成事实文件全文。origin 缺失时补入；已有 origin 原样保留 body 原文。
 *  force=true（consolidation apply 用）：已有 origin 也允许重写 frontmatter + body。
 *  默认 force=false，行为不变——writeFact 不受影响。 */
export function renderFact(existing: string | null, meta: FactMeta, body: string, force = false): string {
  if (existing !== null) {
    const parsed = parseFact(existing);
    // 已有非空 origin 且未强制：整文件原样保留（由调用方决定覆盖策略）。
    if (parsed.meta?.originSessionId && !force) return existing;
    // 缺 origin 或 force：补/重写 frontmatter，body 按传入值（force 用新 body，否则保持原文）。
    // force 时优先用传入的 meta.originSessionId 覆盖旧 origin（consolidation 覆盖语义）。
    const useBody = force ? body.replace(/\n+$/, '') : parsed.body;
    const origin = force ? (meta.originSessionId ?? parsed.meta?.originSessionId) : (parsed.meta?.originSessionId ?? meta.originSessionId);
    const head = renderFrontmatter({ ...meta, originSessionId: origin });
    return `${head}\n${useBody}`;
  }
  return `${renderFrontmatter(meta)}\n${body.replace(/\n+$/, '')}\n`;
}

/**
 * 给项目层源条目加 promotedTo 标注（consolidation apply 的非破坏性处置）。
 * frontmatter metadata 块加 promotedTo 字段；body 尾追加人类可读注释。
 * 已有 promotedTo 则原样返回（幂等）。返回新文件全文。
 */
export function appendPromotedToAnnotation(raw: string, promotedTo: string, note: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  // 已标注过同一个 promotedTo → 幂等（用 includes 避免 RegExp 转义问题）
  if (normalized.includes(`promotedTo: ${promotedTo}`)) {
    return raw;
  }
  // 在 frontmatter 闭合行 ---\n 前插入 promotedTo（找第一个 --- 后的闭合 ---）
  // 格式：---\n<frontmatter body>\n---\n
  const fmClose = normalized.indexOf('\n---\n', normalized.indexOf('---\n') >= 0 ? 4 : 0);
  let withFm: string;
  if (fmClose >= 0) {
    withFm = normalized.slice(0, fmClose) + `  promotedTo: ${promotedTo}\n` + normalized.slice(fmClose);
  } else {
    // 无 frontmatter：不动 frontmatter，只补 body 注释
    withFm = normalized;
  }
  // body 尾追加注释（若已包含同一注释则不重复，用 includes 避免正则转义问题）
  const noteMarker = note.slice(0, 40);
  if (withFm.includes(noteMarker)) return withFm;
  return `${withFm.replace(/\n+$/, '')}\n\n> ${note}\n`;
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
