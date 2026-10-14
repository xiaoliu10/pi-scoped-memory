/**
 * pi-scoped-memory — pi coding agent 双层持久记忆扩展（全局 + 项目级）。
 *
 * 注入：session_start 读一次全局/项目索引，冻结快照拼进 systemPrompt（KV cache 稳定）。
 * 工具：memory_write（target 路由）/ memory_read / memory_search（关键词）/ memory_status。
 * 依赖：零运行时依赖；模型不需要配置（无自动提取，v2 再加 agent_settled 提取）。
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { buildMemoryBlock } from './src/inject.js';
import { memoryStatus, readMemory, searchMemory, writeFact, type Target } from './src/store.js';

export default function scopedMemoryExtension(pi: ExtensionAPI) {
  let memoryBlock = '';
  let currentCwd: string | undefined;

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    try {
      currentCwd = ctx.cwd;
      memoryBlock = buildMemoryBlock(ctx.cwd);
    } catch {
      memoryBlock = ''; // 注入面任何异常都降级为无记忆，绝不阻断会话
    }
  });

  pi.on('before_agent_start', (event) => {
    if (!memoryBlock) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}` };
  });

  pi.registerTool({
    name: 'memory_write',
    label: 'Memory Write',
    description: `Write one durable fact to scoped memory. Layers: "global" (cross-project user preferences and collaboration conventions, ~/.pi/agent/memory/) and "project" (this repo's constraints/decisions, hash-keyed central store). Default routing by type: user|feedback → global; project|reference → project. One file per fact; the MEMORY.md index line is updated automatically. For conventions that must apply everywhere, prefer the user's AGENTS.md over memory when the user asks for guaranteed instruction-level persistence.`,
    parameters: typeboxSchema(),
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { name?: string; description?: string; type?: string; body?: string; target?: string };
      const result = writeFact({
        cwd: ctx.cwd,
        name: String(params.name ?? ''),
        description: String(params.description ?? ''),
        type: (params.type ?? 'project') as never,
        body: String(params.body ?? ''),
        target: params.target ? (String(params.target) as Target) : undefined,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      const text = result.ok
        ? `Saved to ${inferTarget(params)} memory: ${result.file}`
        : `Error: ${result.error}`;
      return { content: [{ type: 'text', text }], details: result };
    },
  });

  pi.registerTool({
    name: 'memory_read',
    label: 'Memory Read',
    description: 'Read a memory file (fact name or MEMORY.md) from the global or project layer.',
    parameters: readSchema(),
    async execute(_id, rawParams) {
      const params = rawParams as { name?: string; target?: string };
      const result = readMemory(currentCwd, (String(params.target ?? 'project') as Target) ?? 'project', String(params.name ?? ''));
      return { content: [{ type: 'text', text: result.ok ? result.content! : `Error: ${result.error}` }], details: result };
    },
  });

  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: 'Keyword search across global and project memory (both layers by default). Case-insensitive substring match on file names, descriptions and bodies.',
    parameters: searchSchema(),
    async execute(_id, rawParams) {
      const params = rawParams as { query?: string; target?: string };
      const hits = searchMemory(currentCwd, String(params.query ?? ''), params.target ? (String(params.target) as Target) : undefined);
      if (!hits.length) return { content: [{ type: 'text', text: 'No matches.' }], details: { hits: [] } };
      const text = hits.map((h) => `[${h.target}] ${h.name} — ${h.description}\n  …${h.snippet}…`).join('\n');
      return { content: [{ type: 'text', text }], details: { hits } };
    },
  });

  pi.registerTool({
    name: 'memory_status',
    label: 'Memory Status',
    description: 'Show both memory layer roots and fact counts.',
    parameters: emptySchema(),
    async execute() {
      const status = memoryStatus(currentCwd);
      return { content: [{ type: 'text', text: status }], details: { status } };
    },
  });
}

function inferTarget(params: Record<string, unknown>): 'global' | 'project' {
  return params.type === 'project' || params.type === 'reference' ? 'project' : 'global';
}

// typebox 运行时由 pi host 提供（peer）；这里动态取，保持零依赖打包。
function typeboxSchema() {
  const { Type } = typebox();
  return Type.Object({
    name: Type.String({ description: 'Fact name: lowercase kebab-case, ≤80 chars, one file per fact' }),
    description: Type.String({ description: 'One-line recall summary (also used as the index hook)' }),
    type: Type.Union([Type.Literal('user'), Type.Literal('feedback'), Type.Literal('project'), Type.Literal('reference')], { description: 'Fact kind. Default routing: user|feedback→global; project|reference→project' }),
    body: Type.String({ description: 'The fact itself. feedback/project facts should include "Why:" and "How to apply:" lines' }),
    target: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('project')], { description: 'Override the default layer routing' })),
  });
}
function readSchema() {
  const { Type } = typebox();
  return Type.Object({
    name: Type.String({ description: 'Fact file name (without .md) or MEMORY.md' }),
    target: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('project')])),
  });
}
function searchSchema() {
  const { Type } = typebox();
  return Type.Object({
    query: Type.String({ description: 'Keyword (case-insensitive substring)' }),
    target: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('project')])),
  });
}
function emptySchema() {
  const { Type } = typebox();
  return Type.Object({});
}
// typebox 由 pi host 提供（peerDependencies *），经 createRequire 从扩展位置解析。
import { createRequire } from 'node:module';
const hostRequire = createRequire(import.meta.url);
function typebox(): { Type: any } {
  return hostRequire('typebox');
}
