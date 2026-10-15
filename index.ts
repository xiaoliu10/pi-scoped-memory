/**
 * pi-scoped-memory — pi coding agent 双层持久记忆扩展（全局 + 项目级）。
 *
 * 注入：session_start 读一次全局/项目索引，冻结快照拼进 systemPrompt（KV cache 稳定）。
 * 工具：memory_write（target 路由）/ memory_read / memory_search（关键词）/ memory_status。
 * 依赖：零运行时依赖；模型不需要配置（无自动提取，v2 再加 agent_settled 提取）。
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { buildMemoryBlock } from './src/inject.js';
import { applyProposal, collectConsolidationCandidates, loadProposal, memoryStatus, readMemory, saveProposal, searchMemory, writeFact, type CandidateCluster, type Proposal, type Target } from './src/store.js';

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

  pi.registerTool({
    name: 'memory_consolidate',
    label: 'Memory Consolidate',
    description: `跨项目记忆泛化的机械部分（显式触发，零模型依赖）。不自动写全局层。
action=propose（无参）：扫描全部项目层 + 全局层，粗筛候选簇（同 name 归一化跨 ≥2 来源，全局既有等价条目纳入供 merge 判定，legacy- 前缀排除），返回结构化候选。会话 agent 据候选与判定规则产出 proposals 数组后，再调 propose（带 proposals）落提案文件（.consolidation/proposals/<ts>.{json,md}），不写任何记忆层。
action=apply（带 proposalId）：用户复查 <ts>.md 并确认后执行——类型门（只 user|feedback）→敏感扫描（IP/密码/token/私钥）→CAS 校验（sha256 防 TOCTOU）→写全局（force 覆盖已有 origin + provenance）→源条目加 promotedTo 标注（不删）→完成验证+journal。force=true 放行敏感命中。
判定规则（由会话 agent 执行，非本工具）：只提升 user|feedback；抹掉项目细节后仍可执行才 promote；等价重复→promote/merge、同主题不等价→noop、两条不能同时为真→conflict；与全局既有语义等价→merge；sourceProjects≥2 才 promote；拿不准→noop。
review gate：propose 落提案后、apply 前，必须向用户展示提案摘要并取得确认。`,
    parameters: consolidateSchema(),
    async execute(_id: string, rawParams: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      const params = rawParams as { action?: string; proposals?: Proposal[]; proposalId?: string; force?: boolean };
      const action = params.action ?? 'propose';

      if (action === 'propose') {
        if (params.proposals?.length) {
          // 二次调用：落提案
          const pid = saveProposal(params.proposals);
          return { content: [{ type: 'text', text: `Proposal saved: ${pid}\nReview ${pid}.md then call memory_consolidate {action:'apply', proposalId:'${pid}'} after user confirms.` }], details: { proposalId: pid } };
        }
        const clusters = collectConsolidationCandidates();
        if (!clusters.length) {
          return { content: [{ type: 'text', text: 'No consolidation candidates found.' }], details: { clusters: [] as CandidateCluster[] } };
        }
        const lines = clusters.map((c) => {
          const head = `[${c.id}] key=${c.key}（${c.members.length} 条，来源 ${c.projectSlugs.length} 项目${c.hasGlobalMember ? ' + 全局既有' : ''}）`;
          const ms = c.members.map((m) => `  - ${m.target}${m.projectSlug ? '/' + m.projectSlug : ''} ${m.name} [type=${m.type ?? '?'}] — ${m.description.slice(0, 80)}`);
          return [head, ...ms].join('\n');
        });
        return { content: [{ type: 'text', text: lines.join('\n\n') }], details: { clusters } };
      }

      if (action === 'apply') {
        if (!params.proposalId) {
          return { content: [{ type: 'text', text: 'Error: apply 需要 proposalId' }], details: { applied: 0 } };
        }
        const result = applyProposal(params.proposalId, params.force === true);
        const text = result.ok
          ? `Applied ${result.applied} proposal(s). Journal: ${result.journalFile ?? 'n/a'}`
          : `Applied ${result.applied}, skipped ${result.skipped}. Errors:\n${result.errors.join('\n')}`;
        return { content: [{ type: 'text', text }], details: { result } };
      }

      return { content: [{ type: 'text', text: `Error: unknown action ${action}` }], details: {} };
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
function consolidateSchema() {
  const { Type } = typebox();
  return Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('propose'), Type.Literal('apply')], { description: 'propose=扫描候选/落提案（默认）；apply=按 proposalId 执行' })),
    proposals: Type.Optional(Type.Array(Type.Object({}), { description: 'propose 二次调用时传入的结构化提案数组' })),
    proposalId: Type.Optional(Type.String({ description: 'apply 时传入的提案 id' })),
    force: Type.Optional(Type.Boolean({ description: 'apply 时放行敏感命中的 globalBody（默认 false）' })),
  });
}
// typebox 由 pi host 提供（peerDependencies *），经 createRequire 从扩展位置解析。
import { createRequire } from 'node:module';
const hostRequire = createRequire(import.meta.url);
function typebox(): { Type: any } {
  return hostRequire('typebox');
}
