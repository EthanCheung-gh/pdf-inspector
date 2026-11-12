# 文档体检与审计报告

`pdf-inspector audit` 对一份 PDF 做整档检查：字体、页面、图片、元数据、结构与安全。检查结果是一组带严重级别的 **finding**，可以输出为人类可读摘要、确定性 JSON（`AuditReport`）或单文件 HTML 报告，并按阈值映射退出码。

同一套审计引擎（`sidecar/audit.py`）被三个入口复用：

- **Web / 桌面界面**：工具栏 `Audit` 打开独立的审计工作区，可筛选、查看证据与建议、跳转到对应页面，并导出 JSON。
- **CLI**：`python sidecar/cli.py audit FILE.pdf`，适合本地检查与脚本。
- **Composite action**：[`audit/action.yml`](../audit/action.yml)，在 GitHub Actions 中安装依赖、运行审计、写步骤摘要并按 `fail-on` 决定步骤成败。

审计引擎只接收本地文件路径，不发起网络请求；CLI 与 action 会拒绝 `http(s)` URL。Web 端先用既有的“Open URL”流程把远程文档下载到临时目录，再对本地副本做审计。

## 工作区

点击工具栏 `Audit` 进入审计工作区；它和 Diff 一样替换 Inspect 区域，两者互斥。`Back to Inspect` 返回原文档，Inspect 的文档、页码、缩放与选中状态在往返后保持不变。

- **摘要**：`Errors` / `Warnings` / `Info` / `Total` 计数，以及页数、PDF 版本、是否加密、是否标记（Tagged）与文档语言。
- **筛选**：按严重级别与类别过滤，`Reset` 清除筛选；列表与计数同步更新。
- **发现列表**：按固定顺序显示严重级别徽标、类别、页码与标题；选中行高亮。
- **详情**：标题、类别、严重级别、页码、说明、`Evidence` 与 `Recommendation`。带页码的发现提供 `Open page`，点击后关闭 Audit 并在 Inspect 中导航到该页；当前阶段不在审计工作区内嵌 PDF 预览。
- **分批进度**：文档级检查完成后，页面检查按每 10 页一批顺序执行，界面显示 `Auditing pages N/M…`，批次之间保持可交互。
- **导出 JSON**：`Export JSON` 通过保存对话框写出完整 `AuditReport`，建议文件名为 `<pdf 文件名>.audit.json`。
- **重新运行**：`Re-run` 重新执行整档审计；失败会显示错误信息，不会清空已打开文档的 Inspect 状态。

## 检查项与严重级别

严重级别只有三档，不提供 0–100 的“健康分”：

| 严重级别 | 含义 |
|---|---|
| `error` | 无法完成检查。当前唯一来源是**页面提取失败**：该页不可读，其余页面仍会继续审计。 |
| `warning` | 明确影响可移植性、可访问性或输出的缺陷，例如字体未嵌入、图片分辨率过低。 |
| `info` | 诊断性提示，例如缺少可选元数据、未标记 PDF、旋转页面。 |

### 字体（`fonts`）

| 发现 | 级别 | 说明 |
|---|---|---|
| `Font not embedded: <name>` | `warning` | 字体没有嵌入字体程序，查看器会自行替换，换行与字形可能变化。Standard 14 字体永远不会被报告为缺失。 |
| `Font embedding unknown: <name>` | `info` | 字体数据不可读，无法判断嵌入状态。 |
| `Font has no ToUnicode mapping: <name>` | `warning` | 非 Standard 14、非 Type3 字体缺少 `/ToUnicode` CMap，复制、搜索或提取的文本可能出错。 |

### 页面（`pages`）

| 发现 | 级别 | 范围 | 说明 |
|---|---|---|---|
| `Page N could not be analysed` | `error` | 页面 | 该页提取失败，`Evidence` 记录异常类型，其余页面继续审计。 |
| `Page N has no content` | `info` | 页面 | 页面没有字符、单词、矢量图形、图片或表格。 |
| `Mixed page sizes` | `warning` | 文档 | 存在多个不同的 MediaBox 尺寸，`Evidence` 列出尺寸与对应页面。 |
| `Rotated pages` | `info` | 文档 | 存在 `/Rotate` 不为 0 的页面；旋转页上的对象叠加层不可用。 |
| `Page box outside MediaBox` | `warning` | 文档 | CropBox / TrimBox / BleedBox / ArtBox 超出 MediaBox，列出页面与框名。 |

### 图片（`images`）

| 发现 | 级别 | 说明 |
|---|---|---|
| `Page N has images but no extractable text` | `warning` | 页面只有图片、没有可提取文本，可能是扫描页。 |
| `Page N has a low-resolution image` | `warning` | 图片有效分辨率低于 **96 dpi**；按 `min(像素宽 / (绘制宽 / 72), 像素高 / (绘制高 / 72))` 计算。`Evidence` 包含像素尺寸、绘制框尺寸与有效 dpi。无法读取像素尺寸时跳过该检查，不猜测。 |

### 元数据（`metadata`）

| 发现 | 级别 | 说明 |
|---|---|---|
| `Missing document title` | `info` | 文档信息字典没有 Title。 |
| `Missing document author` | `info` | 文档信息字典没有 Author。 |
| `Missing document language` | `info` | 文档 catalog 没有 `/Lang`，辅助技术无法判断文本语言。 |

### 结构（`structure`）

结构类别基于 tagged PDF 的 `/StructTreeRoot`、`/RoleMap`、`/ParentTree` 与页面 `/StructParents` 生成启发式发现：

| 发现 | 级别 | 说明 |
|---|---|---|
| `PDF is not tagged` | `info` | 既没有 `/StructTreeRoot`，也没有 `/MarkInfo /Marked true`。这只是诊断提示，不是 PDF/A 认证。 |
| `Structure tree has no ParentTree` | `warning` | 有 `/StructTreeRoot` 但缺 `/ParentTree`，MCID 无法映射回结构元素。 |
| `Page N has no structure parent entry` | `warning` | 文档已标记且存在 `/ParentTree`，但该页有内容却没有 `/StructParents`；只列举前 10 页，`Evidence` 带总数。 |
| `Structure element has no role` | `warning` | 结构元素缺少可读的 `/S`。 |
| `Unknown structure role: X` | `warning` | 角色不在 ISO 32000-1 标准集合中，也未在 RoleMap 中定义。 |
| `RoleMap cycle` | `warning` | RoleMap 的解析出现循环，部分角色无法映射到标准角色。 |
| `Figure has no alternative text` | `warning` | `Figure` 元素缺少 `/Alt`。 |
| `Formula has no alternative text` | `warning` | `Formula` 元素缺少 `/Alt`。 |
| `Link has no alternate description` | `warning` | `Link` 元素没有 `/Alt`、`/ActualText` 或 `/T`。 |
| `Heading levels are skipped` | `warning` | 按树顺序出现 `H1 → H3` 这类跨级；首个标题之前的层级缺失不报告。 |
| `List has no list items` | `warning` | `L` 下没有 `LI` 子项。 |
| `List item has no LBody` | `info` | `LI` 缺少 `LBody`，条目文本没有被分组。 |
| `Table has no rows` | `warning` | `Table` 下没有 `TR`。 |
| `Table header cell has no scope` | `info` | `TH` 缺少 `/Scope` 属性。 |
| `Structure tree truncated` | `warning` | 节点/深度/子项/属性/扫描/循环上限或 RoleMap/ParentTree 列表上限触发，`Evidence` 列出计数与上限。 |
| `Accessibility parse skipped N element(s)` | `warning` | 有畸形或不可读的结构条目被跳过，结构树可能不完整。 |

同一条件只产生一条发现，`Evidence` 列出前 3 个受影响的节点路径/role/页码；未标记文档只输出 `PDF is not tagged`，不再叠加依赖结构树的检查。所有检查都是启发式的，不构成 PDF/UA、PDF/A 或 WCAG 合规认证。结构模型、字段、资源上限、Audit `Structure` 视图与 `accessibility` CLI 见[无障碍与结构树检查](accessibility.md)。

### 安全（`security`）

| 发现 | 级别 | 说明 |
|---|---|---|
| `Document is encrypted` | `warning` | 文档已加密，文本提取或打印可能受权限限制。 |

### 顺序与确定性

发现按固定规则排序：

1. 类别顺序：`fonts` → `pages` → `images` → `metadata` → `structure` → `security`；
2. 同一类别内按页码升序，文档级发现（`page: null`）排在最前；
3. 同页按标题、说明、证据、建议排序。

发现不含时间戳、绝对路径或运行环境信息，因此相同 PDF 的 JSON 输出逐字节一致，可以直接提交、diff 或缓存。不可读的 catalog 值按“缺失”处理，不会让整次审计失败。

## JSON 报告（`AuditReport`）

`--format json` 与界面 `Export JSON` 输出同一 schema：

```json
{
  "schemaVersion": 1,
  "tool": { "name": "pdf-inspector", "version": "0.2.0" },
  "document": {
    "pages": 4,
    "version": "1.7",
    "encrypted": false,
    "title": "Example",
    "author": "Example Author",
    "producer": "ReportLab",
    "language": "zh-CN",
    "tagged": false
  },
  "summary": { "total": 3, "errors": 0, "warnings": 1, "info": 2 },
  "findings": [
    {
      "category": "images",
      "severity": "warning",
      "page": 3,
      "title": "Page 3 has a low-resolution image",
      "detail": "Image 0 on page 3 is drawn at 72 dpi, below the 96 dpi threshold, ...",
      "evidence": "pixels 240 x 140, box 240 x 140 pt, effective 72 dpi",
      "recommendation": "Use a higher-resolution image, or draw the image at a smaller size."
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | `1` | 当前固定为 `1`。 |
| `tool` | `{name, version}` | 生成报告的 CLI/引擎名称与版本。 |
| `document` | `object` | `pages`、`version`、`encrypted`、`title`、`author`、`producer`、`language`、`tagged`；不可读或缺失的文本字段为 `null`，`version` 不可读时为 `"unknown"`。 |
| `summary` | `{total, errors, warnings, info}` | 按严重级别计数。 |
| `findings` | `array` | 每条包含 `category`、`severity`、`page`、`title`、`detail`、`evidence`、`recommendation`。 |

`category` 取值：`fonts`、`pages`、`images`、`metadata`、`structure`、`security`。
`severity` 取值：`error`、`warning`、`info`。
`page` 为 1 起的页码；文档级发现为 `null`。
`evidence` 与 `recommendation` 在没有内容时为 `null`。

## CLI

```bash
# 人类可读摘要（默认），退出码 0/1/2
python sidecar/cli.py audit report.pdf

# 确定性 JSON 与 HTML 报告
python sidecar/cli.py audit report.pdf \
  --format json --output report.audit.json
python sidecar/cli.py audit report.pdf \
  --format html --output report.audit.html

# 发现 warning/error 时退出 1（适合作为质量门禁）
python sidecar/cli.py audit report.pdf --fail-on warning

# Node 包装器：解析 Python 并原样转发参数与退出码
node bin/pdf-inspector.mjs audit report.pdf --format json --output report.audit.json
```

### 常用选项

| 选项 | 说明 |
|---|---|
| `--format` | `summary`（默认）/ `json` / `html`。 |
| `--output PATH` | 把格式化结果写入文件；stdout 仍打印摘要。 |
| `--fail-on` | `error` / `warning` / `none`（默认 `none`）。`warning` 同时覆盖 errors；`error` 只覆盖 errors；`none` 永不返回 1。 |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML 输出。 |

`--format summary` 只打印人类摘要；选择 `json` / `html` 且省略 `--output` 时，payload 写到 stdout。所有诊断信息都写到 stderr，因此 JSON 输出可以安全地管道给其他工具。

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 没有严重级别命中 `--fail-on`。 |
| `1` | `--fail-on` 命中（`warning` 或 `error`）。 |
| `2` | 参数、输入、读取或审计错误（文件不存在、非 PDF、URL、输出路径不可写等）。`--fail-on none` 只抑制 1，不会抑制 2。 |

CLI 只接受本地路径；输入会先校验 `%PDF-` 文件头。打包后的桌面应用不包含 CLI。

## GitHub Action

仓库提供 composite action（[`audit/action.yml`](../audit/action.yml)），会安装 Python 与 `sidecar/requirements.txt` 依赖，运行 `python sidecar/cli.py audit`，把结果写入步骤摘要，并按 `fail-on` 决定步骤成败。

```yaml
name: PDF audit

on:
  pull_request:
    paths:
      - 'docs/**/*.pdf'

permissions:
  contents: read

jobs:
  pdf-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Audit docs/report.pdf
        id: audit
        uses: <owner>/pdf-inspector/audit@v1
        with:
          path: docs/report.pdf
          fail-on: error
          format: html
          report-path: artifacts/pdf-audit.html

      - name: Upload the audit report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: pdf-audit
          path: artifacts/
          if-no-files-found: ignore
```

在仓库内部使用 `uses: ./audit`，见 `.github/workflows/ci.yml` 的 `audit-action` 任务。

### 输入

| 输入 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `path` | 是 | — | PDF 路径，绝对路径或相对 workspace；只接受本地文件，拒绝 `http(s)` URL。 |
| `fail-on` | 否 | `error` | `error` / `warning` / `none`；`warning` 同时覆盖 errors。 |
| `format` | 否 | `summary` | `summary` / `json` / `html`，用于步骤摘要与默认 artifact 路径。JSON/HTML payload 写入文件，不进入日志。 |
| `json-path` | 否 | `''` | JSON 报告路径；`format: json` 且留空时写入 runner 临时目录。 |
| `report-path` | 否 | `''` | HTML 报告路径；`format: html` 且留空时写入 runner 临时目录。 |
| `python-version` | 否 | `3.12` | 运行审计 CLI 的 Python 版本。 |

### 输出

| 输出 | 说明 |
|---|---|
| `exit-code` | CLI 退出码（`0`/`1`/`2`）；`fail-on: none` 不会因发现返回 1，但读取/参数/artifact 错误仍为 2。 |
| `json-path` | 本次运行写出的 JSON 报告路径；未请求或未生成时为空。 |
| `report-path` | 本次运行写出的 HTML 报告路径；未请求或未生成时为空。 |

说明：

- `json-path` / `report-path` 的父目录会自动创建；相对路径相对于 workspace。
- 如果请求的 artifact 不属于 `format`（例如 `format: summary` 加 `json-path`），action 会额外执行一次 `--quiet --fail-on none` 的 CLI 以生成该文件。
- 非零退出码会先写入 `exit-code` 输出与步骤摘要，再让步骤失败，便于后续步骤仍然读取输出。
- action 只读取传入的本地文件，不需要额外凭据；默认 `contents: read` 足够。

## 确定性、安全与非目标

- **确定性**：相同 PDF 产生相同的发现集合、顺序与 JSON/HTML 字节；报告不含时间戳、绝对路径或机器相关信息。
- **安全**：审计引擎只读取本地文件；CLI 与 action 拒绝 URL，因此没有 SSRF 面；HTML 报告内联 CSS、无脚本、无外部资源，所有 PDF 元数据与发现文本都经过 HTML 转义。
- **本地优先**：CLI 与 action 需要 Python 3.10+ 与 `sidecar/requirements.txt`（`pdfplumber`、`Pillow`）；打包后的桌面应用不包含 CLI。
- **非目标**：
  - 不做 OCR，也不识别扫描页中的文字；扫描页只能得到“有图片但无可提取文本”的提示。
  - **不做 PDF/A 合规认证**，不验证数字签名；“未标记 PDF”只是诊断提示。
  - 不做像素级比较、PDF 编辑、注释或表单写入。
  - 不在旋转页或 CropBox 偏移页上做对象级定位；这些检查的发现只到页面级。
  - 不提供 0–100 健康分，也不维护跨运行的历史趋势。
- **启发式**：检查基于提取出的对象、字体信息、页面框与 catalog 元数据，可能有误报/漏报；`--fail-on` 与 action 的阈值应结合项目实际情况设置。
- **性能**：页面级检查按 10 页一批串行执行，与字体分析共享同一个侧车；超大文档耗时较长，但工作区会显示进度并保持可交互。
- **Web 端**：审计接口与检查器一样没有身份认证；请仅在可信网络使用，或放在带认证的反向代理之后。
