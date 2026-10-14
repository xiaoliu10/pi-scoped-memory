/**
 * 存储路径解析：全局层 + 项目层（ZCode project-root.ts 形态移植）。
 *
 * - 全局层沿用 pi-memory 0.4.2 的 ~/.pi/agent/memory/（兼容既有数据）。
 * - 项目层 ~/.pi/agent/memory-projects/<slug>-<hash16>/：
 *   隔离键 = 规范化 workspacePath 的 sha256 前 16 位（Windows 转小写）；
 *   slug 取 basename 清洗。不进 cwd（无误提交 git 的隐私问题）。
 * - 环境变量只用于测试注入（PI_SCOPED_MEMORY_HOME），生产路径写死。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_NAME = /[<>:"|?*\u0000-\u001f]/;

/** 会话级缓存：同一 root 解析结果在进程内冻结（Bash cd 不换 root）。 */
const projectRootCache = new Map<string, string>();

function homeRoot(): string {
  const override = process.env.PI_SCOPED_MEMORY_HOME;
  if (override && path.isAbsolute(override)) return override;
  return path.join(os.homedir(), '.pi', 'agent');
}

/** 全局层根：兼容 pi-memory 既有布局（MEMORY.md / SCRATCHPAD.md / daily/）。 */
export function globalMemoryRoot(): string {
  return path.join(homeRoot(), 'memory');
}

/** 项目层根：`<home>/memory-projects/<slug>-<hash16>`。 */
export function projectMemoryRoot(cwd: string): string {
  const normalized = path.resolve(cwd);
  const cacheKey = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const cached = projectRootCache.get(cacheKey);
  if (cached) return cached;
  const hash = createHash('sha256').update(cacheKey).digest('hex').slice(0, 16);
  const slug = sanitizeSlug(path.basename(normalized) || 'project');
  const root = path.join(homeRoot(), 'memory-projects', `${slug}-${hash}`);
  projectRootCache.set(cacheKey, root);
  return root;
}

function sanitizeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug.length > 0 ? slug : 'project';
}

/** containment：candidate 必须落在 root 内且不含 traversal/敏感字符。返回绝对路径或 undefined。 */
export function containedPath(root: string, candidate: string): string | undefined {
  if (!candidate || SENSITIVE_NAME.test(candidate)) return undefined;
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  // 只允许一层（扁平存储：事实文件与 MEMORY.md 平级，不做子目录）
  if (rel.includes(path.sep)) return undefined;
  return resolved;
}

/** 索引文件名（每层 root 顶层的 MEMORY.md）。 */
export function indexFile(root: string): string {
  return path.join(root, 'MEMORY.md');
}

export function factFile(root: string, name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) return undefined;
  return containedPath(root, `${name}.md`);
}

/** 首次目录创建 best-effort：失败只记 debug，不阻断注入（ZCode 同语义）。 */
export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 实际 Write 工具会返回原始文件错误；这里保持静默。
  }
}
