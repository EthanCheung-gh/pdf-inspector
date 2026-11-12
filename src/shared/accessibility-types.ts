/**
 * Tagged-PDF accessibility data contract shared by the main process, the
 * preload bridge, the web server, the browser adapter and the renderer.
 *
 * It lives in src/shared (not src/renderer/types) for the same reason as
 * `audit-types.ts`, `security-types.ts` and `diff-types.ts`: the composite node
 * tsconfig project (main/preload) can import it without pulling renderer files
 * in.
 *
 * The engine (`sidecar/accessibility.py` + `sidecar/audit.py::accessibility_report`)
 * serialises this contract directly: field names are camelCase on both sides,
 * the report is deterministic (no timestamps, absolute paths or random ids) and
 * `schemaVersion` is bumped only when the report shape changes. The report is
 * read-only evidence: nothing here executes a content stream, resolves an
 * external resource or edits a tag, and the findings are heuristics rather than
 * a PDF/UA, PDF/A or WCAG compliance verdict.
 */

import type { AuditFinding, AuditSummary, AuditTool } from './audit-types';

/**
 * The accessibility report reuses the audit contract's finding/summary/tool
 * shapes, so consumers can import them from either module.
 */
export type { AuditFinding, AuditSummary, AuditTool };

export type StructureNodeKind = 'element' | 'mcid' | 'object';

export interface AccessibilityDocumentInfo {
  pages: number;
  version: string;
  encrypted: boolean;
  /** /StructTreeRoot 或 /MarkInfo /Marked true。 */
  tagged: boolean;
  /** catalog /StructTreeRoot 是否存在。 */
  hasStructTreeRoot: boolean;
  /** /StructTreeRoot /ParentTree 是否存在。 */
  hasParentTree: boolean;
  language: string | null;
  title: string | null;
  /** 已解析的 RoleMap；最多 100 项。 */
  roleMap: Record<string, string>;
  /** 结构树是否因节点/深度/子项上限被截断。 */
  truncated: boolean;
  /** 解析时跳过的畸形元素数量。 */
  skipped: number;
}

export interface StructureNode {
  /** 稳定路径，例如 "0/2/1"；不依赖对象 id。 */
  id: string;
  kind: StructureNodeKind;
  /** 解析后的 role；MCID/OBJR 节点为 "MCID" / "OBJR"。 */
  role: string;
  /** 原始 /S；MCID/OBJR 为 null。 */
  rawRole: string | null;
  title: string | null;
  alt: string | null;
  actualText: string | null;
  lang: string | null;
  /** 1-based 页码；无法确定时为 null。 */
  page: number | null;
  /** MCID 或 OBJR 的内容 id；普通元素为 null。 */
  mcid: number | null;
  /** OBJR 的目标对象号；普通元素/MCID 为 null。 */
  objectNumber: number | null;
  /** 有界属性表；最多 20 项，字符串最多 512 字符。 */
  attributes: Record<string, string | null>;
  /** 子节点；超过上限时父节点带 truncated 标记。 */
  children: StructureNode[];
  /** 子节点是否被截断。 */
  truncated: boolean;
}

export interface AccessibilityReport {
  schemaVersion: 1;
  tool: AuditTool;
  document: AccessibilityDocumentInfo;
  /** 根结构元素森林；通常只有一个根，但允许多个。 */
  structure: StructureNode[];
  findings: AuditFinding[];
  summary: AuditSummary;
}
