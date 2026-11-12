/**
 * Document security data contract shared by the main process, the preload
 * bridge, the web server, the browser adapter and the renderer.
 *
 * It lives in src/shared (not src/renderer/types) for the same reason as
 * `audit-types.ts` and `diff-types.ts`: the composite node tsconfig project
 * (main/preload) can import it without pulling renderer files in.
 *
 * The engine (`sidecar/security.py` + `sidecar/audit.py::security_report`)
 * serialises this contract directly: field names are camelCase on both sides,
 * the report is deterministic (no timestamps, absolute paths or random ids) and
 * `schemaVersion` is bumped only when the report shape changes. The report is
 * read-only evidence: nothing here executes JavaScript, opens an attachment or
 * verifies a signature.
 */

import type { AuditFinding, AuditSummary, AuditTool } from './audit-types';

export interface SecurityDocumentInfo {
  pages: number;
  version: string;
  encrypted: boolean;
  /** 存在 /AcroForm /XFA（数组或 stream）。 */
  xfa: boolean;
  /** 存在 catalog /Metadata。 */
  hasMetadata: boolean;
  /** /OutputIntents 的数量，0 表示没有。 */
  outputIntents: number;
}

export interface SecurityAttachment {
  /** 展示名，来自 /UF、/F 或 name tree 键；不做文件系统路径解析。 */
  name: string;
  description: string | null;
  /** 流声明大小；不可读时为 null。 */
  size: number | null;
  mimeType: string | null;
  modified: string | null;
  /** 解码后字节的 SHA-256；超出上限或不可读时为 null。 */
  sha256: string | null;
  /** 名称含路径分隔符或扩展名属于常见可执行类型。 */
  risky: boolean;
}

export interface SecurityJavaScript {
  /** name tree 键或动作名称；没有名称时为 null。 */
  name: string | null;
  /** 例如 "Names", "OpenAction", "Page 3", "Annotation 12"。 */
  location: string;
  page: number | null;
  /** 有界源码预览，最多 4096 字符。 */
  source: string;
  truncated: boolean;
}

export interface SecurityAction {
  location: string;
  page: number | null;
  /** JavaScript / Launch / URI / GoTo / SubmitForm / ImportData / Named / ... */
  subtype: string;
  /** URI、文件说明、目标名等展示值；不解析、不访问。 */
  target: string | null;
  /** Launch、JavaScript、SubmitForm、ImportData 等需要人工确认的动作。 */
  risky: boolean;
}

export interface SecuritySignature {
  fieldName: string | null;
  page: number | null;
  signer: string | null;
  signedAt: string | null;
  reason: string | null;
  location: string | null;
  subFilter: string | null;
  /** ByteRange 是否结构完整；null 表示没有或不可读。 */
  byteRangeValid: boolean | null;
  /** 固定为 false：本工具不做密码学验证。 */
  verified: false;
}

export interface SecurityPermissions {
  raw: number | null;
  print: boolean | null;
  modify: boolean | null;
  copy: boolean | null;
  annotate: boolean | null;
  fillForms: boolean | null;
  accessibility: boolean | null;
  assemble: boolean | null;
  highQualityPrint: boolean | null;
}

export interface SecurityEncryption {
  filter: string | null; // 通常是 Standard
  version: number | null; // /V
  revision: number | null; // /R
  keyLength: number | null; // /Length
  permissions: SecurityPermissions;
}

export interface SecurityReport {
  schemaVersion: 1;
  tool: AuditTool;
  document: SecurityDocumentInfo;
  attachments: SecurityAttachment[];
  javascript: SecurityJavaScript[];
  actions: SecurityAction[];
  signatures: SecuritySignature[];
  encryption: SecurityEncryption | null;
  findings: AuditFinding[];
  summary: AuditSummary;
}
