# 文档体检与审计报告

`pdf-inspector audit` 对一份 PDF 做整档检查：字体、页面、图片、元数据、结构与安全。检查结果是一组带严重级别的 **finding**，可以输出为人类可读摘要、确定性 JSON（`AuditReport`）、单文件 HTML 报告或 SARIF 2.1.0，并按阈值映射退出码。

每条 finding 还带一个稳定的**指纹**，因此可以把当前报告与上一份报告比较：区分新增、已存在、换页、级别升级、已修复，并且只让新增或升级的问题触发 `--fail-on`。仓库还可以提交**有原因、有到期日**的豁免清单；过期豁免自动失效。

同一套审计引擎（`sidecar/audit.py`）被三个入口复用：

- **Web / 桌面界面**：工具栏 `Audit` 打开独立的审计工作区，可筛选、查看证据与建议、跳转到对应页面、加载基线只显示新增，并导出 JSON。
- **CLI**：`python sidecar/cli.py audit FILE.pdf`，适合本地检查与脚本；支持基线、豁免与 SARIF。`python sidecar/cli.py audit-dir ROOT` 审计整棵目录并输出批量汇总，见[目录批量审计](#目录批量审计)。
- **Composite action**：[`audit/action.yml`](../audit/action.yml)，在 GitHub Actions 中安装依赖、运行审计、写步骤摘要并按 `fail-on` 决定步骤成败。`path` 可以是单个 PDF，也可以是一棵目录。

审计引擎只接收本地文件路径，不发起网络请求；CLI 与 action 会拒绝 `http(s)` URL。Web 端先用既有的“Open URL”流程把远程文档下载到临时目录，再对本地副本做审计。

## 工作区

点击工具栏 `Audit` 进入审计工作区；它和 Diff 一样替换 Inspect 区域，两者互斥。`Back to Inspect` 返回原文档，Inspect 的文档、页码、缩放与选中状态在往返后保持不变。

- **摘要**：`Errors` / `Warnings` / `Info` / `Total` 计数，以及页数、PDF 版本、是否加密、是否标记（Tagged）与文档语言。
- **筛选**：按严重级别与类别过滤，`Reset` 清除筛选；列表与计数同步更新。
- **发现列表**：按固定顺序显示严重级别徽标、类别、页码与标题；选中行高亮。
- **详情**：标题、类别、严重级别、页码、说明、`Evidence` 与 `Recommendation`。带页码的发现提供 `Open page`，点击后关闭 Audit 并在 Inspect 中导航到该页；当前阶段不在审计工作区内嵌 PDF 预览。
- **基线对比**：`Findings` 头部的 `Baseline…` 选择一个本地 `AuditReport` JSON，加载后摘要区显示 `Baseline: 2 new · 5 existing · 1 moved · 3 fixed`，`New only` 只保留新增与升级的发现，列表行显示 `New` / `Moved` / `Escalated` 徽标，`Clear` 清除基线。基线只在本机内存中解析，见[工作区基线](#工作区基线)。
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

发现不含时间戳、绝对路径或运行环境信息，因此相同 PDF 的 JSON 输出逐字节一致，可以直接提交、diff 或缓存。不可读的 catalog 值按“缺失”处理，不会让整次审计失败。新增的 `fingerprint` 是 finding 其他字段的纯函数，不参与排序，也不进入人类摘要，因此不影响上述确定性。

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
      "recommendation": "Use a higher-resolution image, or draw the image at a smaller size.",
      "fingerprint": "38bd8b47dec06dece44fd894f0578c19"
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
| `findings` | `array` | 每条包含 `category`、`severity`、`page`、`title`、`detail`、`evidence`、`recommendation`，以及引擎生成的 `fingerprint`（32 位小写十六进制）。 |

`category` 取值：`fonts`、`pages`、`images`、`metadata`、`structure`、`security`。
`severity` 取值：`error`、`warning`、`info`。
`page` 为 1 起的页码；文档级发现为 `null`。
`evidence` 与 `recommendation` 在没有内容时为 `null`。
`fingerprint` 是**新增的可选字段**：`schemaVersion` 仍是 `1`，旧消费者可以忽略它；旧版报告可能没有这个字段，见[发现指纹](#发现指纹)。

## 基线与豁免

### 发现指纹

每条 finding 的 `fingerprint` 是 32 位小写十六进制，由引擎（`sidecar/audit.py` 的 `finding_fingerprint()`）在生成 finding 时写入，CLI、action、界面与 SARIF 共用同一个值，界面**不**重新计算哈希。

| 参与哈希 | 不参与哈希 |
|---|---|
| `category`、`title`、`detail`、`evidence`（其中指向本条 finding 自身页码的引用会先归一化） | `page` 字段本身、`severity`、`recommendation` |

- 哈希输入是 `pdf-inspector-finding-v1` 版本前缀加上表四个字段，用 `\x1f`（U+001F）连接，取 SHA-256 的前 32 个十六进制字符。
- **自身页码归一化**：页面级检查会把页码写进标题和说明（`Page 3 has a low-resolution image`、`Image 0 on page 3 ...`），如果照原样哈希，换页就会变成“新问题 + 已修复”。因此当 `page` 为 `3` 时，`title` / `detail` / `evidence` 中的 `Page 3` 会替换为 `Page #`，`page 3` 替换为 `page #`（单词大小写保留），然后才参与哈希。
  - 只归一化本条 finding 自身的正整数页码；同一段文本里提到的其他页码按原样哈希（例如 `page 7` 仍参与哈希）。
  - 文档级 finding（`page: null`）不做任何归一化。
  - 其他写法不归一化：`p. 3`、`PAGE 3`、`Pages 3`（以及 `pages 3, 4` 这类列表）都按原文哈希，所以页面级检查的措辞应保持 `Page N` / `page N`。
- 缺失值按空字符串处理（`None` 与 `""` 是同一身份）。
- 指纹描述“问题身份”，不描述位置与级别：页面级 finding 在哈希文本只引用自身页码时，换页、级别升高、建议改写都不改变指纹；`title` / `detail` / `evidence` 的文案变化仍会产生新指纹，这是有意为之——检查器措辞变了，基线必须重新生成。
- 版本前缀保证算法升级时旧基线**失配**而不是悄悄匹配错。
- 指纹不出现在人类摘要里，但会写进 `--format json`、`--format sarif` 和比较产物。
- 旧版报告（没有指纹）在 CLI 侧由同一函数补齐：`--baseline`、`--waivers` 和 SARIF 都接受这种文件。界面相反，明确拒绝缺少指纹的基线，提示用当前版本重新生成。

因为有了自身页码归一化，真实报告里“同一问题换了页”会得到 `moved` 而不是 `new` + `fixed`：`moved` 只计数、不触发 `--fail-on`；只有真正新出现的页面级问题才是 `new` 并计入阈值。该结论适用于哈希文本只引用自身页码的页面级 finding；聚合型 finding（例如结构树问题在 `evidence` 中列出多个页码）整体换页后 `evidence` 文本会变，仍会表现为 `new` + `fixed`。

### 生成与使用基线

基线就是一份普通的 `AuditReport` JSON，不需要新格式。用**当前版本**的 CLI 生成，提交到仓库，之后每次审计与它比较：

```bash
# 1) 生成基线（建议用仓库相对路径提交）
python sidecar/cli.py audit docs/report.pdf \
  --format json --output ci/pdf-audit-baseline.json

# 2) 之后每次审计都与基线比较；只有新增/升级的问题会让 --fail-on 命中
python sidecar/cli.py audit docs/report.pdf \
  --baseline ci/pdf-audit-baseline.json \
  --baseline-output artifacts/audit-comparison.json \
  --fail-on warning
```

- `--baseline PATH` 必须是本地文件；URL 会被拒绝（退出码 2）。文件必须在 PDF 打开**之前**通过校验：JSON 对象、`schemaVersion: 1`、`findings` 数组。
- 基线必须是 `audit --format json` 产出的 `AuditReport`。把 `--baseline-output` 的比较产物（`BaselineComparison`）当作基线传入会退出 2：它的顶层带 `current` / `baseline`，finding 条目又带 `status` / `current` / `baseline`，与报告不是同一形状。两个文件都有 `schemaVersion: 1`，光看版本号无法区分，所以要传对文件。
- 每条 finding 也会校验：`category` 必须是六个类别之一，`severity` 必须是 `error` / `warning` / `info`，`title` 与 `detail` 必须是字符串，`page` 必须是 `null` 或正整数，`evidence` / `recommendation` 必须是 `null` 或字符串；`fingerprint` 存在时必须是 32 位小写十六进制。
- 缺少 `fingerprint`（旧版报告）时，CLI 用同一函数补齐后继续比较，因此引入指纹之前生成的报告仍可直接使用；界面则会拒绝缺少指纹的基线并要求重新生成（见[工作区基线](#工作区基线)）。
- 校验失败只输出一行 `pdf-inspector: error: ...` 并退出 2，不写任何 payload。
- `--baseline-output PATH` 写出独立的 `BaselineComparison`，必须与 `--baseline` 同时使用，否则退出 2。
- `--output` 与 `--baseline-output` 不能是同一个文件（退出 2）；两者也都不允许覆盖输入 PDF、基线文件或豁免文件，避免一次运行把自己的输入或另一个产物改掉。
- 没有 `--baseline` 时，摘要、JSON、HTML 与退出码与引入基线之前逐字节一致。
- 人类摘要在严重级别计数之后追加一行，例如 `baseline: 0 new, 3 existing, 0 moved, 0 escalated, 0 fixed, 0 waived`；HTML 报告增加 `Baseline` 小节，列出六种状态的计数和逐条状态徽标（换页项显示 `p.3 → p.5`）。没有基线时不渲染这些内容。

### 六种状态

比较结果里的 `status` 只有六个取值。匹配按指纹分组、组内按页升序，并用**多重集**配对：同一页出现两条完全相同的 finding 时逐条配对，不会合并成一条。

| 状态 | 含义 | 计入 `--fail-on` |
|---|---|---|
| `new` | 当前 finding 的指纹在基线里不存在 | 是 |
| `existing` | 同指纹、同页，与基线逐条配对 | 否 |
| `moved` | 同指纹但换了页（剩余同指纹项按页序配对） | 否 |
| `escalated` | 配对成功，且严重级别升高（`info` < `warning` < `error`） | 是 |
| `fixed` | 基线里有、当前报告里没有 | 否（不是当前问题） |
| `waived` | 被有效的豁免接受，覆盖以上所有当前状态 | 否 |

- 级别**降低**保持 `existing` / `moved`，不算 `escalated`；未知级别按 `info` 处理，畸形报告不会制造升级。
- `moved` 依赖指纹的自身页码归一化：页面级检查把页码写进标题/说明，归一化后同一问题换页仍是同一身份，所以真实报告里换页会报成 `moved` 而不是 `new` + `fixed`。`moved` 单独计数并显示 `p.3 → p.5`：它不阻塞门禁，但可见，避免“换页不算新问题”掩盖真实移动。
- 取舍：如果旧页上的问题消失、同时另一页出现文案相同的问题，会被报成 `moved`（计数行显示 `p.3 → p.9`），不会触发阈值。这是“换页不算新问题”的有意取舍——真实移动靠 `moved` 计数可见，而不是靠 `--fail-on` 拦截。基线里该页的问题仍然存在时，同页配对优先（`existing`），多出来的当前项才是 `new`。
- `waived` 覆盖基线状态，但仍保留配对信息；被豁免的项不再计入 `new` / `existing` / `moved` / `escalated`。

### fail-on 与基线

| 配置 | `--fail-on warning` / `--fail-on error` 统计的对象 |
|---|---|
| 无 `--baseline` | 整份报告中的 warnings/errors，减去被有效豁免的项 |
| 有 `--baseline` | 只有状态为 `new` 或 `escalated` 的当前 finding，其中 warning/error 触发退出 1 |

- `existing`、`moved`、`waived` 不触发，`fixed` 不是当前问题。
- `--fail-on none` 永不返回 1；`--fail-on error` 只被 `new` / `escalated` 的 error 触发。
- 命中时 stderr 输出一行原因，例如 `pdf-inspector: 0 new or escalated audit error(s) and 1 new or escalated warning(s) found (fail-on warning)`。
- 因此有历史 warning 的仓库可以先提交基线、开启 `--fail-on warning`，只拦新增问题；修掉问题后重新生成基线即可。

### 豁免文件

豁免是仓库评审过的**策略文件**，不是隐式忽略列表。路径由 `--waivers PATH` 指定，可以与 `--baseline` 组合，也可以单独使用：

```json
{
  "schemaVersion": 1,
  "waivers": [
    {
      "fingerprint": "0123456789abcdef0123456789abcdef",
      "page": 7,
      "reason": "Legacy template; tracked in DOC-1234",
      "expires": "2026-12-31"
    }
  ]
}
```

| 规则 | 行为 |
|---|---|
| 顶层 | 必须是对象，`schemaVersion` 必须是 `1`，`waivers` 必须是数组。 |
| 允许的键 | 每项只能是 `fingerprint` / `page` / `reason` / `expires`，出现其他键即报错。 |
| `fingerprint` | 必须是 32 位小写十六进制，必须来自 `--format json` 的 `findings[].fingerprint`（CLI 不会替你补算）。 |
| `page` | 可选正整数；缺省或 `null` 表示匹配任意页。 |
| `reason` | 必须是字符串，去除首尾空白后至少 3 个字符。 |
| `expires` | 必须是合法的 `YYYY-MM-DD` 日期；**含当天**，从次日起失效。 |
| 重复定义 | 同一 `fingerprint + page` 出现两次即报错，避免策略歧义。 |

任何一条不满足都退出 2，并只输出一行 `pdf-inspector: error: ...` 诊断；坏文件在 PDF 解析之前就被拒绝。

匹配与生命周期：

- 一个 finding 最多命中一个豁免（文件顺序中的第一个），一个豁免最多接受一个 finding。
- `page` 缺省时匹配该指纹在任意页的出现；指定页码时要求页码完全相等。
- 过期豁免不抑制任何 finding，也不算作 `unused`；`waivers: N applied, N expired, N unused` 摘要行与比较产物的 `waivers.expired` 会把它计入，并在 stderr 一次性提示 `pdf-inspector: N waiver(s) expired and were not applied`。这条提示属于策略诊断，**即使加了 `--quiet` 也会输出**（`--quiet` 只关闭 stdout 上的人类摘要）。
- 仍然有效但没有匹配到任何 finding 的豁免计为 `unused`，方便清理过期策略。
- 被豁免的 error 不触发 `--fail-on error`；删掉豁免后同一基线立刻恢复命中。
- 豁免文件路径不会写进 JSON / HTML / SARIF 或比较产物，输出里只有策略事实（状态、原因、到期日）。
- 豁免新增应当像代码一样评审：`expires` 必填、到期即失效、未使用可计数。

### 比较产物

`--baseline-output PATH` 写出独立的 `BaselineComparison`（`schemaVersion: 1`），不改写 `--format json` 的 `AuditReport`：

```json
{
  "schemaVersion": 1,
  "tool": { "name": "pdf-inspector", "version": "0.3.3" },
  "current": { "pages": 12, "findings": 9 },
  "baseline": { "pages": 12, "findings": 11 },
  "summary": {
    "new": 2,
    "existing": 5,
    "moved": 1,
    "escalated": 1,
    "fixed": 3,
    "waived": 1
  },
  "waivers": { "applied": 1, "expired": 1, "unused": 0 },
  "findings": [
    {
      "status": "new",
      "fingerprint": "0123456789abcdef0123456789abcdef",
      "current": { "category": "fonts", "severity": "warning", "page": 3, "title": "…" },
      "baseline": null
    }
  ]
}
```

- `findings` 先按当前报告顺序列出**所有**当前 finding（含 `waived`），再按基线顺序列出 `fixed` 项（其 `current` 为 `null`）；每项携带完整的当前/基线 finding，消费方无需再读两份报告。
- `moved` 项同时带 `baseline.page` 与 `current.page`；`waived` 项额外带 `waiver: {reason, expires}`。
- `summary.waived` 与 `waivers.applied` 本期语义相同；保留两个字段是为了报告层与策略层各自可读。
- `summary` 在没有 `--waivers` 时也包含 `waived: 0`，消费方可以依赖固定形状；`waivers` 块只在加载了豁免文件时出现。
- 产物不含绝对路径、时间戳或主机名，相同输入与选项产生逐字节一致的文件。

### 工作区基线

`Findings` 头部提供 `Baseline…`（隐藏的 `<input type="file" accept=".json,application/json">`）与已加载时的 `Clear`：

- 必须已有当前报告才能加载基线，否则按钮禁用。
- 基线文件必须是 `audit --format json` 的 `AuditReport`：`schemaVersion: 1`、`findings` 数组，每条 finding 形状正确且带 32 位十六进制 `fingerprint`。坏 JSON、非数组结构、旧版无指纹的报告都会显示内联错误，且**不会**清空已加载的基线。
- 加载 `--baseline-output` 的比较产物会被拒绝，并说明这是 `BaselineComparison`、应加载 `AuditReport`；基线缺少指纹时提示用当前版本重新生成基线。
- 界面**不**为缺失的指纹补算（与 CLI 不同），所以基线必须由当前版本生成。
- 如果**当前**报告本身没有指纹（例如来自旧版引擎的缓存结果），基线仍会加载，但计数不可用：界面显示内联错误，提示用当前引擎重新审计。
- 加载后摘要区显示 `Baseline: 2 new · 5 existing · 1 fixed`（`moved` / `escalated` / `waived` 只在大于 0 时出现，悬停可看到完整六项计数），`New only` 只保留 `new` + `escalated`，括号里显示这两类的总数。
- `New only` 与严重级别/类别筛选叠加生效，计数行始终显示全量结果。
- `fixed` 只显示计数：没有当前行可以选中，也不提供“已修复列表”。
- 列表行显示 `New` / `Moved` / `Escalated` 徽标。
- 基线在 `Re-run` 后保留并重新计算；切换文档或 `reset()` 会清空；关闭工作区后返回仍保留。
- 界面不读取豁免文件，因此 `waived` 始终为 `0`；豁免只在 CLI / action 中生效。
- 基线内容只在本机内存中：不写入 localStorage、不上传服务端、不进入 `Export JSON`、不随会话恢复。

## SARIF

`--format sarif` 是 audit 的第四种格式（仅 audit 支持），把同一份 `AuditReport`（以及可选的基线、豁免）映射为 SARIF 2.1.0。它只是格式化：不引入 headless 渲染、不上传、不访问网络。

```bash
# SARIF 写到 stdout（相对输入路径让 uri 保持相对）
python sidecar/cli.py audit docs/report.pdf --format sarif --fail-on none

# SARIF 文件 + 人类摘要；--baseline 变成 baselineState，--waivers 变成 suppressions
python sidecar/cli.py audit docs/report.pdf \
  --format sarif --output artifacts/audit.sarif \
  --sarif-uri docs/report.pdf \
  --baseline ci/pdf-audit-baseline.json \
  --waivers ci/pdf-audit-waivers.json \
  --fail-on warning
```

### 映射

| SARIF 字段 | 来源 |
|---|---|
| `$schema` / `version` | `https://json.schemastore.org/sarif-2.1.0.json` / `2.1.0` |
| `runs[0].tool.driver.name` | `pdf-inspector` |
| `runs[0].tool.driver.version` | 报告的 `tool.version` |
| `runs[0].tool.driver.informationUri` | 项目仓库地址 |
| `runs[0].tool.driver.rules[]` | 按 `ruleId` 去重后排序的规则（标题、建议、类别/级别标签） |
| `runs[0].columnKind` | `utf16CodeUnits` |
| `ruleId` | `pdf-inspector/<category>/<slug(title)>` |
| `ruleIndex` | 指向 `rules[]` 中的同一条规则 |
| `results[].level` | `error` → `error`，`warning` → `warning`，`info` → `note` |
| `results[].message.text` | `title: detail`，没有 detail 时只用 `title` |
| `results[].locations[0]...artifactLocation.uri` | `--sarif-uri`，否则用调用时传入的输入路径（`\` 转 `/`） |
| `results[].locations[0]...region.startPage` | `finding.page`；文档级 finding 没有 `locations` |
| `results[].partialFingerprints["pdfInspectorFinding/v1"]` | finding 的 `fingerprint` |
| `results[].baselineState` | 有基线时：`new`/`escalated` → `new`，`existing`/`moved` → `unchanged`；无基线省略 |
| `results[].suppressions[]` | 被豁免项：`kind: "external"`、`status: "accepted"`、`justification: <reason>` |

- `ruleId` 的 slug 只保留小写 ASCII 字母与数字，其他字符折叠成 `-`，最长 64 字符，为空时退化为 `finding`。两个不同标题落到同一 slug 时，两条都会追加 `-<标题 sha256 前 8 位>`，一条规则不会吞掉另一条。
- `pdfInspectorFinding/v1` 是消费方契约的一部分：改这个键会让 code scanning 把已有告警当成新问题，所以它与版本前缀一起固定。
- 被豁免的结果只带 `suppressions`，不再带 `baselineState`；`fixed` 没有当前结果，因此不出现在 SARIF 里。
- 与基线一样，旧版无指纹的报告在渲染 SARIF 时会用同一函数补算，所以每个结果都带 `partialFingerprints`。
- `--sarif-uri` 只允许与 `--format sarif` 一起使用；与 `summary` / `json` / `html` 组合是用法错误（退出 2，一行 `pdf-inspector: error: ...`，且不写 payload），因为静默忽略会产出路径非预期的结果。

### 确定性与隐私

- 规则按 `ruleId` 排序，结果保持报告顺序；不含时间戳、主机名或工具生成的绝对路径，同一输入与选项两次运行逐字节一致，所以 SARIF 可以提交、缓存或 diff。
- 默认的 `uri` 就是调用方传入的路径：CI 建议传仓库相对路径，或用 `--sarif-uri` 指定代码扫描能解析的仓库相对路径。
- 基线与豁免只影响 `baselineState` 与 `suppressions`，不会改变检测结果；SARIF 渲染不读 PDF、不写文件（除非给了 `--output`）、不联网。
- 上传到 GitHub code scanning 由 workflow 用 `github/codeql-action/upload-sarif` 完成，见 [CI 文档](ci.md)；工具本身不上传任何内容。

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

# 与基线比较：只有新增/升级的问题触发 --fail-on，并写出比较产物
python sidecar/cli.py audit report.pdf \
  --baseline ci/pdf-audit-baseline.json \
  --baseline-output artifacts/audit-comparison.json \
  --fail-on warning

# 可过期豁免：被接受的发现不计数，过期项在 stderr 提示
python sidecar/cli.py audit report.pdf \
  --waivers ci/pdf-audit-waivers.json --fail-on warning

# SARIF 2.1.0（代码扫描），可同时带基线
python sidecar/cli.py audit report.pdf \
  --format sarif --output artifacts/audit.sarif \
  --sarif-uri docs/report.pdf \
  --baseline ci/pdf-audit-baseline.json

# Node 包装器：解析 Python 并原样转发参数与退出码
node bin/pdf-inspector.mjs audit report.pdf --format json --output report.audit.json
```

### 常用选项

| 选项 | 说明 |
|---|---|
| `--format` | `summary`（默认）/ `json` / `html` / `sarif`；`sarif` 输出 SARIF 2.1.0，仅 audit 支持。 |
| `--output PATH` | 把格式化结果写入文件；stdout 仍打印摘要。不能覆盖输入 PDF、基线或豁免文件，也不能与 `--baseline-output` 指向同一个文件。 |
| `--baseline PATH` | 与上一次的 `AuditReport` JSON（`--format json` 的产物，本地文件）比较；只有 `new` / `escalated` 计入 `--fail-on`。 |
| `--baseline-output PATH` | 写出 `BaselineComparison` JSON；必须同时给 `--baseline`，且不能与 `--output` 同名。 |
| `--waivers PATH` | 可过期豁免策略 JSON（本地文件）；被接受的发现不计入 `--fail-on`，过期项只提示不报错。 |
| `--sarif-uri PATH` | SARIF 的 `artifactLocation.uri`，默认用输入参数；只允许与 `--format sarif` 一起使用。 |
| `--fail-on` | `error` / `warning` / `none`（默认 `none`）。`warning` 同时覆盖 errors；`error` 只覆盖 errors；`none` 永不返回 1。有 `--baseline` 时只统计 `new` / `escalated`。 |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML/SARIF 输出；过期豁免提示仍会写到 stderr。 |

`--format summary` 只打印人类摘要；选择 `json` / `html` / `sarif` 且省略 `--output` 时，payload 写到 stdout。所有诊断信息都写到 stderr，因此 JSON/SARIF 输出可以安全地管道给其他工具。

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 没有严重级别命中 `--fail-on`。 |
| `1` | `--fail-on` 命中（`warning` 或 `error`）；有 `--baseline` 时只可能是 `new` / `escalated` 的当前发现。 |
| `2` | 参数、输入、读取或审计错误（文件不存在、非 PDF、URL、基线/豁免文件非法、基线传入的是比较产物、输出路径不可写、`--baseline-output` 缺 `--baseline`、`--output` 与 `--baseline-output` 同名、`--sarif-uri` 未配 `--format sarif` 等）。`--fail-on none` 只抑制 1，不会抑制 2。 |

过期豁免不是错误：它只是不抑制 finding，摘要与 stderr 给出计数，退出码仍由 `--fail-on` 与剩余结果决定。

CLI 只接受本地路径；输入会先校验 `%PDF-` 文件头。打包后的桌面应用不包含 CLI。

## 目录批量审计

`audit-dir` 用一条命令审计一棵本地目录下的所有 PDF，并把每份 `AuditReport` 聚合成一份确定性的批量报告。它是**独立子命令**：`audit` 的 flag、输出、退出码与默认值完全不变，单文件与目录语义不会被同一个命令猜测。CI 里不必为每个 PDF 各配一个 action。

```bash
# 人类摘要 + 进度（进度写 stderr）
python sidecar/cli.py audit-dir docs

# JSON + HTML artifact + 供步骤摘要读取的计数文件；坏 PDF 不阻断其余文件
python sidecar/cli.py audit-dir docs \
  --format json --output artifacts/pdf-audit-batch.json \
  --stats artifacts/pdf-audit-batch-stats.json \
  --fail-on error

# 只审计 reports/ 下的文件，跳过草稿、最多 200 个文件；HTML 报告是单文件 artifact
python sidecar/cli.py audit-dir docs \
  --include 'reports/*' --exclude '*draft*' --max-files 200 \
  --format html --output artifacts/pdf-audit-batch.html --quiet

# Node 包装器同样转发子命令、参数与退出码
node bin/pdf-inspector.mjs audit-dir docs --fail-on warning
```

### 发现规则

| 规则 | 行为 |
|---|---|
| 遍历 | 从 `ROOT` 递归；**不跟随符号链接**（符号链接目录不进入，符号链接文件不收）。 |
| 后缀 | 只收 `.pdf`，**大小写不敏感**（`.PDF` / `.Pdf` 都算）。 |
| 跳过 | 隐藏条目（以 `.` 开头的文件与目录），以及 `node_modules`、`.git`、`.hg`、`.svn`、`__pycache__` 目录。 |
| 过滤 | `--include` / `--exclude` 是相对 root 的 POSIX 路径（如 `reports/a.pdf`）上的 `fnmatch` glob；多个 `--include` 任一命中即可，`--exclude` 优先。`fnmatch` 的 `*` 也匹配 `/`，所以 `--include '*.pdf'` 等价于不限层级，`--include 'reports/*'` 覆盖 `reports/` 下的所有层级。glob **大小写敏感**（`fnmatch.fnmatchcase`），因此 `--include '*.pdf'` 不会匹配 `REPORT.PDF`；要覆盖混合大小写的后缀请用 `--include '*.PDF'` 或 `--include '*.[Pp][Dd][Ff]'`。发现阶段的 `.pdf` 后缀判断本身仍是大小写不敏感的。 |
| 顺序 | 按相对 POSIX 路径排序（先 `casefold`，再按原文做稳定次序），与文件系统的目录列举顺序无关。 |
| 上限 | `--max-files` 默认 500，允许 1–5000；发现数量超过上限直接退出 2，**不会**悄悄只审计一个子集。 |
| 根 | `ROOT` 必须是本地目录；URL、已存在的文件、不存在或不可读的路径都退出 2（一行 `pdf-inspector: error: ...`）。 |

### 选项

```text
audit-dir ROOT [--include GLOB]... [--exclude GLOB]...
  [--max-files N] [--format summary|json|html] [--output PATH]
  [--stats PATH] [--fail-on error|warning|none] [--quiet]
```

| 选项 | 说明 |
|---|---|
| `ROOT` | 要递归审计的本地目录。 |
| `--include GLOB` | 可重复；只审计相对路径匹配任一 GLOB 的 PDF。 |
| `--exclude GLOB` | 可重复；跳过匹配 GLOB 的 PDF，优先于 `--include`。 |
| `--max-files N` | 发现上限，默认 500，允许 1–5000；超出退出 2。 |
| `--format` | `summary`（默认）/ `json` / `html`；目录模式**没有** `sarif`。 |
| `--output PATH` | 把格式化结果写入文件；给了 `--output` 时 stdout 仍打印人类摘要（与单文件 `audit` 一致）。省略 `--output` 且选择 `json` / `html` 时 payload 写到 stdout。不能覆盖 root 目录本身，也不能覆盖 root 下的任何 `.pdf`。 |
| `--stats PATH` | 额外写一份小 JSON 计数产物（只有 `schemaVersion` / `tool` / `root` / `summary`，没有逐文件条目），供 CI 步骤摘要读取。任何 `--format` 都会写，`--quiet` 也不抑制；不能覆盖 root、root 下的 PDF 或 `--output` 指向的文件。 |
| `--fail-on` | `error` / `warning` / `none`（默认 `none`）。`warning` 同时覆盖 warnings 与 errors；**失败文件计入 errors**，所以两种模式都会拦截读不了的文件。 |
| `--quiet` | 关闭 stderr 进度行与 stdout 人类摘要；JSON/HTML payload 与 `--stats` 不受影响，错误诊断仍写 stderr。 |

进度写在 **stderr**，格式为 `audit-dir: [2/5] reports/b.pdf`（正在审计第 2 个文件），因此 `--format json` 的 stdout 可以安全地管道给其他工具。

### 摘要输出

```text
pdf-inspector 0.3.3 - PDF audit directory
root: docs
files: 3 (2 audited, 1 failed)
findings: 1 error, 5 warnings, 0 info (6 total)
  ok    a.pdf: 0 errors, 0 warnings
  ok    reports/b.PDF: 0 errors, 5 warnings
  error reports/broken.pdf: Cannot open PDF 'reports/broken.pdf': No /Root object! - Is this really a PDF?
```

- `files: N (A audited, F failed)` 给出发现数、成功审计数与失败文件数。
- `findings` 行的 `(N total)` 是同一行三个计数之和，因此**包含**失败文件贡献的 error；JSON 的 `summary.findings` 只统计 finding。
- 最多列 50 个文件，其余打印 `... N more file(s)`；目录里没有 PDF 时打印 `no PDF files found` 并退出 0。
- 每份文件的错误信息压成一行并截断到 160 字符，损坏 PDF 不会刷满终端或换行。

### JSON（`BatchReport`）

```json
{
  "schemaVersion": 1,
  "tool": { "name": "pdf-inspector", "version": "0.3.3" },
  "root": { "name": "docs", "files": 3, "bytes": 123456 },
  "summary": {
    "files": 3,
    "audited": 2,
    "failed": 1,
    "findings": 5,
    "errors": 1,
    "warnings": 5,
    "info": 0
  },
  "files": [
    {
      "path": "reports/a.pdf",
      "status": "ok",
      "bytes": 45678,
      "document": {
        "pages": 4,
        "version": "1.7",
        "encrypted": false,
        "title": null,
        "author": null,
        "producer": null,
        "language": "en-US",
        "tagged": true
      },
      "summary": { "total": 0, "errors": 0, "warnings": 0, "info": 0 },
      "findings": []
    },
    {
      "path": "reports/broken.pdf",
      "status": "error",
      "bytes": 789,
      "error": "Cannot open PDF 'reports/broken.pdf': ..."
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | `1` | 批量报告版本，固定为 `1`。 |
| `tool` | `{name, version}` | 与单文件报告相同的工具标识。 |
| `root` | `{name, files, bytes}` | 只保存目录**名**（不保存路径）、发现文件数与这些文件的字节总和。 |
| `summary` | object | `files` 为发现数，`audited` 为成功审计数，`failed` 为 `status: "error"` 数，`findings` 为全部 finding 总数，`errors` = finding 的 error 数 **+ 失败文件数**，`warnings` / `info` 为 finding 计数。 |
| `files[]` | array | 按发现顺序（相对路径排序）。 |
| `files[].path` | string | 相对 root 的 POSIX 路径（`/` 分隔），永不含绝对路径。 |
| `files[].status` | string | `ok` 或 `error`。 |
| `files[].bytes` | int | 文件字节数；读取失败时为 `0`。 |
| `files[].document` / `.summary` / `.findings` | object / object / array | 仅 `status: "ok"` 时出现，字段与单文件 `AuditReport` 相同；finding 保留完整字段（含 `fingerprint`），因此批量 JSON 可以拆回单文件报告而不必重跑。 |
| `files[].error` | string | 仅 `status: "error"` 时出现：一行错误信息（绝对路径已改写为相对路径）。 |

上面的示例是节选：`files[]` 里只列了无发现的 `reports/a.pdf` 与损坏的 `reports/broken.pdf`，被省略的第三个成功文件贡献了 5 条 warning；真实输出会列出每一个被发现的文件，finding 的形状与单文件 `AuditReport` 完全相同（含 `fingerprint`）。

- 批量 JSON 不含时间戳、主机名或绝对路径，键顺序固定，相同目录与选项产生逐字节一致的文件，可以直接提交、diff 或缓存。
- `--stats` 写出同一份数据的子集（`schemaVersion` / `tool` / `root` / `summary`），不含 `files` 数组与 finding；只要审计跑完就始终写入，与 `--format` 和 `--quiet` 无关（参数/root/发现/输出错误退出 2 时不会留下该文件），因此 CI 步骤摘要和 JSON/HTML artifact 永远不会描述不同的结果。

### 退出码

| 退出码 | 条件 |
|---|---|
| `0` | 没有命中阈值（包括空目录、`--fail-on none`）。 |
| `1` | `--fail-on error` 且存在 finding error 或失败文件；`--fail-on warning` 且存在 warning / error 或失败文件。 |
| `2` | 参数、root、发现或输出错误：URL / 不存在 / 非目录 / 不可读 root、`--max-files` 越界、发现数超过上限、目录遍历失败、payload 路径不可写、`--output` 与 `--stats` 同名或指向 root 下的 PDF。 |

`--fail-on none` 不会因 finding 或失败文件返回 1，但参数、root 与输出错误仍是 2。

### HTML

`--format html` 渲染**一个**自包含 HTML 文件：内联 CSS、无脚本、无外部资源、无缩略图，标题为 `PDF audit report - N files`（单个文件时是 `PDF audit report - 1 file`）。

- 顶部：root 名、文件数与字节数、`audited` / `failed`，以及 errors / warnings / info / total。
- 文件表：path、status、pages、errors / warnings / info 与错误信息。
- 每个成功文件一个 `<section>`：文档信息、严重级别计数与全部 finding（标题、页码、说明、证据、建议）；失败文件只有一个错误块。
- 所有路径、元数据、证据与错误文本都经过 HTML 转义，报告不含绝对路径与时间戳，相同 payload 渲染出逐字节一致的 HTML。
- 体积随文件数与 finding 数增长（默认上限 500 个文件），它是 artifact，不适合打进步骤日志。

### 与单文件、基线、豁免和 SARIF 的边界

- 目录模式**不支持**基线（`--baseline` / `--baseline-output`）、豁免（`--waivers`）与 SARIF（`--format sarif`）。这些 flag 没有注册到 `audit-dir`，传了就是 `unrecognized arguments` 退出 2；action 的目录模式也会在安装 Python 之前以退出 2 拒绝它们，不会静默忽略。
- 需要在目录级别做增量门禁或策略豁免时，对单份文件运行 `audit`（基线与豁免按单文件 `fingerprint` 设计），或先用 `audit-dir --format json` 找出有问题的文件再逐个处理。
- 单个文件失败是**数据**而不是整体崩溃：文件损坏、无法打开/不可读（包括需要密码而无法打开）时记为 `status: "error"` 并继续审计其余文件；失败文件计入 `summary.failed` 与 `summary.errors`，因此 `--fail-on error` 会拦截它。
- 能打开但已加密的文件**不是**失败文件：它是 `status: "ok"`，并带一条 `security` 类别、`warning` 级别的 `Document is encrypted` 发现（见[检查项](#安全security)）。因此 `--fail-on error` 不会因它失败，`--fail-on warning` 会；只有根本打不开（例如需要密码）时才算失败文件。
- 目录模式只读：不写 PDF、不执行内容、不联网。

### Action 目录模式

action 的 `path` 可以是单个 PDF，也可以是一棵目录；目录时执行 `audit-dir`，文件时仍执行 `audit`（单文件路径的输入、输出与失败语义与之前一致）。

```yaml
name: PDF audit (directory)

on:
  pull_request:
    paths:
      - 'docs/**/*.pdf'

permissions:
  contents: read

jobs:
  pdf-audit-directory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Audit docs/
        id: audit
        continue-on-error: true
        uses: <owner>/pdf-inspector/audit@v1
        with:
          path: docs                     # a directory: one aggregate result
          fail-on: error                 # a file that cannot be read counts as one error
          format: json
          json-path: artifacts/pdf-audit-batch.json
          report-path: artifacts/pdf-audit-batch.html

      - name: Enforce the audit gate
        if: steps.audit.outputs.exit-code != '0'
        run: exit '${{ steps.audit.outputs.exit-code }}'
```

| 目录模式的约定 | 行为 |
|---|---|
| `format` | 只接受 `summary` / `json` / `html`；`sarif` 在“校验输入”阶段退出 2。 |
| 被拒绝的输入 | `baseline-path`、`baseline-output-path`、`waivers-path`、`sarif-path`、`sarif-uri` 与 `format: sarif` 都会在**安装 Python 之前**退出 2，并给出说明。 |
| 默认 artifact | `json-path` / `report-path` 留空且格式匹配时写入 runner 临时目录，规则与单文件模式相同；`sarif-path` 输出在目录模式下恒为空。 |
| 步骤摘要 | 额外列出 `mode: directory` 与 `root`、`files`、`audited`、`failed`、`errors`、`warnings`、`info`；数据来自 CLI 的 `--stats` 产物，因此与 JSON/HTML 同源。 |
| `exit-code` | 语义不变：`0` / `1` / `2`。 |

更多 CI 示例、artifact 与失败文件语义见 [CI 文档](ci.md)。

## GitHub Action

仓库提供 composite action（[`audit/action.yml`](../audit/action.yml)），会安装 Python 与 `sidecar/requirements.txt` 依赖，运行 `python sidecar/cli.py audit`（`path` 是目录时改用 `audit-dir`），把结果写入步骤摘要，并按 `fail-on` 决定步骤成败。

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

在仓库内部使用 `uses: ./audit`，见 `.github/workflows/ci.yml` 的 `audit-action` 任务。基线、豁免与 SARIF 上传的完整 workflow 见 [CI 文档](ci.md)。

把 `path` 改成目录即可切换到目录批量模式（`audit-dir`），完整示例、限制与边界见[目录批量审计](#目录批量审计)与 [CI 文档](ci.md)。

### 输入

| 输入 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `path` | 是 | — | 一个 PDF 的路径，或一棵目录的路径；绝对路径或相对 workspace，只接受本地路径并拒绝 `http(s)` URL。目录会被递归审计并给出一条聚合结果；单文件仍校验 `%PDF-` 文件头。 |
| `fail-on` | 否 | `error` | `error` / `warning` / `none`；`warning` 同时覆盖 errors。设置 `baseline-path` 时只统计 `new` / `escalated` 的发现。目录模式下无法读取的文件计为一个 error。 |
| `format` | 否 | `summary` | `summary` / `json` / `html` / `sarif`，用于步骤摘要与默认 artifact 路径。JSON/HTML/SARIF payload 写入文件，不进入日志。`path` 是目录时只接受 `summary` / `json` / `html`（SARIF 是单文件功能）。 |
| `json-path` | 否 | `''` | JSON 报告路径；`format: json` 且留空时写入 runner 临时目录。 |
| `report-path` | 否 | `''` | HTML 报告路径；`format: html` 且留空时写入 runner 临时目录。 |
| `baseline-path` | 否 | `''` | 用于比较的上一次 `AuditReport` JSON（`audit --format json` 的产物，本地文件）；文件不存在或 URL 会在审计前退出 2。传入比较产物同样被拒绝（见下方说明）。目录模式会拒绝该输入。 |
| `baseline-output-path` | 否 | `''` | `BaselineComparison` JSON 的输出路径；需要同时设置 `baseline-path`，且不能与 `json-path` / `report-path` / `sarif-path` 相同。目录模式会拒绝该输入。 |
| `waivers-path` | 否 | `''` | 可过期豁免策略 JSON（本地文件）；被接受的发现不会让步骤失败，过期项在 stderr 提示。目录模式会拒绝该输入。 |
| `sarif-path` | 否 | `''` | SARIF 2.1.0 的输出路径；`format: sarif` 且留空时写入 runner 临时目录。目录模式会拒绝该输入，且该模式下输出恒为空。 |
| `sarif-uri` | 否 | `''` | SARIF 的 `artifactLocation.uri`，默认取 `path`；只允许与 `format: sarif` 一起使用。目录模式会拒绝该输入。 |
| `python-version` | 否 | `3.12` | 运行审计 CLI 的 Python 版本。 |

### 输出

| 输出 | 说明 |
|---|---|
| `exit-code` | CLI 退出码（`0`/`1`/`2`）；`fail-on: none` 不会因发现返回 1，但读取/参数/artifact 错误仍为 2。目录模式下失败文件按 finding 处理：`fail-on: none` 返回 0。 |
| `json-path` | 本次运行写出的 JSON 报告路径；未请求或未生成时为空。目录模式下是 `BatchReport`。 |
| `report-path` | 本次运行写出的 HTML 报告路径；未请求或未生成时为空。目录模式下是单文件批量报告。 |
| `sarif-path` | 本次运行写出的 SARIF payload 路径；未请求或未生成时为空；目录模式恒为空。 |

说明：

- `json-path` / `report-path` / `sarif-path` 的父目录会自动创建；相对路径相对于 workspace。
- 如果请求的 artifact 不属于 `format`（例如 `format: summary` 加 `json-path`），action 会额外执行一次 `--quiet --fail-on none` 的 CLI 以生成该文件；基线与豁免参数同样传给这次额外执行，否则摘要与 artifact 会描述不同的比较结果。目录模式下这次额外执行同样是 `audit-dir`，不带任何基线/豁免/SARIF 参数。
- 目录模式在校验输入阶段（安装 Python 之前）就拒绝 `format: sarif`、`baseline-path`、`baseline-output-path`、`waivers-path`、`sarif-path` 与 `sarif-uri`，退出 2：`audit-dir` 没有这些功能，静默忽略会让调用方以为它们生效了。
- 目录模式在 runner 临时目录额外写一份 `--stats` 计数产物，步骤摘要用它的 `root` / `files` / `audited` / `failed` / `errors` / `warnings` / `info`；该文件与 JSON/HTML artifact 来自同一次审计。
- `baseline-path` / `waivers-path` 在上一步“校验输入”中检查：缺文件或 URL 直接让步骤失败，不会先跑一次审计。
- `baseline-output-path` 与 `json-path` / `report-path` / `sarif-path` 必须指向不同文件（比较时忽略开头的 `./` 与结尾的 `/`），否则在校验阶段退出 2：同一个文件被写两次会静默覆盖前一个产物。
- `baseline-path` 必须是报告而不是比较产物；传入 `--baseline-output` 生成的 `BaselineComparison` 会由 CLI 以退出码 2 拒绝（它的 finding 条目带 `status` / `current` / `baseline`）。
- 非零退出码会先写入 `exit-code` 输出与步骤摘要，再让步骤失败，便于后续步骤仍然读取输出。
- 步骤摘要列出退出码、`fail-on`、格式，以及已设置的基线、豁免和 artifact 路径；目录模式还会列出 `mode`、`root` 与聚合计数。
- action 只读取传入的本地文件或目录，不需要额外凭据；默认 `contents: read` 足够。需要上传 SARIF 时由 workflow 授予 `security-events: write`，见 [CI 文档](ci.md)。

## 确定性、安全与非目标

- **确定性**：相同 PDF 产生相同的发现集合、顺序、指纹与 JSON/HTML/SARIF 字节；相同目录产生相同的批量 `summary` / `BatchReport` / `--stats` / 批量 HTML 字节。报告、比较产物与 SARIF 都不含时间戳、机器信息或工具生成的绝对路径（目录模式只写相对 POSIX 路径与 root 名）。
- **安全**：审计引擎只读取本地文件；CLI 与 action 拒绝 URL，因此没有 SSRF 面；HTML 报告内联 CSS、无脚本、无外部资源，所有 PDF 元数据与发现文本都经过 HTML 转义；SARIF 只做格式映射，不上传、不联网。
- **基线与豁免的只读边界**：基线、豁免和比较产物都只描述“当前结果与策略”，不修改 PDF、不修改 `AuditReport`、不回写基线。比较产物与 SARIF 只记录策略事实（状态、原因、到期日），不记录基线/豁免文件的路径；界面加载基线只在本机内存中进行，不写 localStorage、不上传、不进入导出 JSON。
- **本地优先**：CLI 与 action 需要 Python 3.10+ 与 `sidecar/requirements.txt`（`pdfplumber`、`Pillow`）；打包后的桌面应用不包含 CLI。
- **非目标**：
  - 不做 OCR，也不识别扫描页中的文字；扫描页只能得到“有图片但无可提取文本”的提示。
  - **不做 PDF/A 或 PDF/UA 合规认证**，不验证数字签名；“未标记 PDF”只是诊断提示。
  - 不自动修复、编辑或重写 PDF，也不做像素级比较、注释或表单写入。
  - 不在旋转页或 CropBox 偏移页上做对象级定位；这些检查的发现只到页面级。
  - 不提供 0–100 健康分，也不维护跨运行的历史趋势或数据库；基线就是一份提交在仓库里的 JSON。
  - 不在界面里编辑豁免或写回基线；界面只做本地只读加载。
  - 不上传 SARIF，也不评论 PR；上传由 workflow 用 `upload-sarif` 自行完成。
- **启发式**：检查基于提取出的对象、字体信息、页面框与 catalog 元数据，可能有误报/漏报；`--fail-on` 与 action 的阈值应结合项目实际情况设置。
- **性能**：页面级检查按 10 页一批串行执行，与字体分析共享同一个侧车；超大文档耗时较长，但工作区会显示进度并保持可交互。
- **Web 端**：审计接口与检查器一样没有身份认证；请仅在可信网络使用，或放在带认证的反向代理之后。
