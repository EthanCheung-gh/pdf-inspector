# PDF Diff：页面对齐、视觉对比、忽略区域与文档资源

Diff 以**对象级比较**为事实来源：word / char / rect / line / curve / image /
table 七类对象逐页比较，输出 `added` / `removed` / `moved` / `modified`，
`DiffResult.schemaVersion` 保持 `1`。在此之上有四组能力：

- **页面对齐信息**（2.0）：每个配对页带 `match.score` 与 `match.reordered`，摘要带
  `pagesReordered`，CLI/HTML/action 可以按“页序变化”单独判定。
- **视觉对比视图（仅 UI）**（2.0）：在浏览器 canvas 中把旧页/新页渲染成同一张位图，
  提供 Blend、Heatmap、Boxes 三种显示方式与像素统计。
- **可绘制的忽略区域**（2.0）：在页面上拖框得到 MediaBox 坐标矩形，由引擎过滤与
  区域相交的变更（对象与有 BBox 的资源），并由视觉热力图同步遮罩。
- **注释、链接、表单、元数据与页面标签**（3.0）：Python 侧车只读收集这些“文档资源”
  并比较，结果与对象变更共存于同一份 `DiffResult`（见
  “注释、链接、表单与文档元数据”），不改变对象计数、页面对齐、忽略区域与 50k 上限
  的既有语义。

CLI 与 GitHub Action 不包含视觉对比，也不需要无头渲染器；它们消费对象级结果、
文档资源变更、页面对齐字段与区域参数。

## 页面对齐与重排语义

### 页面签名与快速路径

每页在配对前先算两个**不看排版**的键（都直接读 pdfminer 对象，不触发
pdfplumber 的 layout，也不做对象抽取）：

1. **签名**（`sidecar/diff.py: _page_signature`）：SHA-256
   - 归一化后的 MediaBox / CropBox 与 `/Rotate`；
   - 每个内容流的解码字节（按页内顺序，带分隔符）；
   - 页面资源字典的递归摘要（字典按键排序、列表按顺序、间接引用按**指向的
     内容**而不是对象编号参与哈希，资源深度上限 3 层，循环引用收敛为标记）。

2. **对齐键**（`_page_alignment_key`）：页面尺寸/旋转 + 内容流中文本字符串
   字面量的**多重集**哈希。它只用于回答“这是不是同一页（可能被改过）”。

`diff_files` 先用签名做页面对齐之外的判定；页面判为 `unchanged` 还要求两侧
**页面资源摘要**（`page_resource_digest`，注释/链接/表单的规范化指纹）相同——对象相同
但注释被改过的页因此不会被跳过：

| 情形 | 行为 |
|------|------|
| 两份文件字节完全相同（SHA-256 相同） | 只扫描一侧页面几何，全部页直接判为 `unchanged` |
| 配对页签名相同且资源摘要相同 | 直接输出 `unchanged`（尺寸取自页面字典，`score: 1.0`），**完全不抽取页面** |
| 配对页签名相同、资源摘要不同 | 页面状态为 `changed`（`score: 1.0`），但**只比较资源、不抽取对象**；没有资源变更时仍是 `unchanged` |
| 配对页签名不同 | 正常抽取两侧页面并做对象级比较与资源比较 |
| 单侧页（新增/删除） | 正常抽取该页并展开为 added/removed 变更 |

因此**未改动的页面永远不会被完整抽取**：开销与“改动页数”成正比，而不是与
“总页数”成正比。未改动页面也不会再走 pdfplumber 的 layout，内存保持逐页平坦。

### 指纹与 `match.score`

配对结果里的 `match.score` 由签名派生的指纹计算（`_signature_fingerprint`）：

| 情形 | 分数 |
|------|------|
| 两页签名相同 | 恰好 `1.0` |
| 签名不同（尺寸相同） | `0.7`（尺寸、旋转、对象计数分量相同，签名分量不同） |
| 单侧页 | `match` 为 `null` |

也就是说这个分数回答的是“两页是否逐字节同源”，不再是“文本有多相似”的连续
度量。要知道具体改了什么，看该页的 `changes`。

### 配对的宽松度

对齐用**对齐键**而不是签名，所以“页换了位置并且页内内容也改了”的页仍然会被
配对（否则会退化成 removed + added 两页）。签名只决定这一对是否需要抽取。

### 左侧按页结果与跳页

Diff 工作区左侧不是一张扁平变更表，而是**每页一个独立组**：

- 组头显示 `Old page N`、`Old N → New M` 或 `New page N`，以及 `changed` /
  `added` / `removed` / `unchanged` 状态与变更数；
- 组头本身是按钮：点击会选中该页并展开/收起自己的变更列表，`aria-expanded`
  与 `aria-controls` 指向唯一的列表 id；
- 新结果默认展开当前页（或首个有变更的页），其他页折叠；Prev/Next、Go to page
  或从变更详情切换页时，目标组会自动展开；手动折叠状态在过滤切换时保留；
- `Go to page` 输入接受 `1..totalPages`，空值/小数/非数字被忽略，越界会夹到
  有效范围；Enter 或 `Go` 跳转，左侧同时显示 `N of M`；
- `Expand all` / `Collapse all` 批量展开/折叠；过滤后只显示有匹配变更的页面组，
  但不会把不同页合并成一张列表。

### 配对

`pair_pages` 用 `difflib.SequenceMatcher`（`autojunk=False`，确定性）对齐两个
对齐键序列：

- `equal` 段按顺序一一配对；
- `replace` 段按相对顺序配对，多出的页成为单侧页；
- `insert` / `delete` 段产生单侧页（`status` 为 `added` / `removed`）；
- 若整份文档没有任何配对（例如页面全部被替换），退化为同序号配对，多余页
  按顺序追加为单侧页。

`reordered` 的定义是**配对页的旧/新页码不同**：

```ts
export interface DiffPageMatch {
  score: number;      // 0..1，3 位小数
  reordered: boolean; // oldIndex !== newIndex
}
```

注意它表示“这一页在修订版中换了页码”，不是“对象顺序变化”，也不等价于
“内容被移动到了另一页”。被 `SequenceMatcher` 视为删除 + 新增的页不会配对，
因此不会标记 `reordered`。

### 示例：`diff-reordered-old.pdf` → `diff-reordered.pdf`

修订 A：`Draft notice, Cover, Summary, Charts, Appendix`；修订 B 删除首页草稿、
追加 `Release notes`，并把每页页眉分隔线下移 3 pt（文本不变，但内容流不同，
因此签名不同、需要重新比较）。结果：

| 旧页 | 新页 | status | match |
|------|------|--------|-------|
| 1 | — | removed | `null` |
| 2 | 1 | changed | `{ score: 0.7, reordered: true }` |
| 3 | 2 | changed | `{ score: 0.7, reordered: true }` |
| 4 | 3 | changed | `{ score: 0.7, reordered: true }` |
| 5 | 4 | changed | `{ score: 0.7, reordered: true }` |
| — | 5 | added | `null` |

摘要：`pagesReordered: 4`、`pagesAdded: 1`、`pagesRemoved: 1`、
`pagesChanged: 4`。界面的页面列表与页面栏显示 `Old 2 → New 1` 形式的新旧页码，
单侧页显示 `Old page 1` / `New page 5`。

HTML 报告的 “Page alignment” 表列出旧/新页码、`match` 分数与 `reordered`
徽标；摘要区同时显示 `Pages reordered`。

### 快速路径的边界

签名只承认“同一份绘制程序 + 同一份资源”，这是有意的取舍：

- **重新保存/重新编码过的页面**：内容相同但内容流被重写（不同的压缩、不同的
  操作符合并、不同工具导出）时签名不同，该页会退回完整比较——结果仍然正确，
  只是慢一点；
- **增量更新或对象重排**：对象编号不参与哈希，所以换过 xref 顺序的同一页仍然
  匹配；但页面内容流本身被改写就不匹配；
- **无法计算签名的页**（页面树损坏、内容流无法解码）：该页使用每侧唯一的
  标记，强制走完整比较，绝不因为“算不出来”而被判为未改动；
- **未改动页不做对象级校验**：签名与资源摘要都相同的页直接判 `unchanged`，即使
  `ignoreTypes` / `ignoreFonts` 等选项本来会改变对象级结果——两侧字节相同，
  任何对象级差异都不存在；资源摘要只覆盖本次实际比较的资源类型，所以关闭某个
  `ignore*` 资源开关会改变哪些页需要重新比较；
- **改动页的分数固定为 0.7**：`match.score` 不再是文本相似度的连续度量。


## 视觉对比（仅 UI）

`Visual` 视图把旧页与新页渲染到**同一张位图**后比较：

1. 取两页中较大的宽与高组成共享位图，再按 `maxDimension` 等比缩放；每页再按
   contain 方式居中绘制（不拉伸），避免因比例不同放大像素差异；
2. 位图最长边限制为 `1600` px（`MAX_PIXEL_BITMAP_DIMENSION`）；超过时按整数
   `step` 采样，采样块整体着色，保证热力图仍然覆盖对应区域；
3. 以**新页**为底图；旧页按 `Old page opacity`（默认 `0.55`）叠加；
4. 页面栏显示 `Pixel diff: {changed} / {total} px changed ({百分比})`。

三种显示方式：

| 模式 | 行为 |
|------|------|
| `Blend` | 新页为底，旧页半透明叠加；透明度滑杆 `0..100`（默认 55%）。 |
| `Heatmap` | 在新页底图上叠加逐像素热力遮罩：小差异偏黄、大差异偏红，透明度随差值增大。 |
| `Boxes` | 不比较像素，只显示变更框（对象与有 BBox 的资源；移除红、新增绿、移动橙、修改蓝），适合定位改动位置。 |

像素判定使用**最大通道差**（R/G/B）：

```ts
delta = max(|oldR-newR|, |oldG-newG|, |oldB-newB|);
changed = delta > 24; // DEFAULT_PIXEL_THRESHOLD
```

alpha 忽略（两侧都在不透明白底上渲染）。被忽略区域覆盖的采样点计入
`ignoredPixels`，并从 `totalPixels`（分母）中排除，所以遮罩区域不会稀释百分比。

单侧页：只显示存在的一侧并给出说明；视觉统计不产生（没有可比较的另一侧）。

## 忽略区域

### 数据结构

```ts
export interface DiffIgnoreRegion {
  oldPage: number | null; // 1-based 旧页页码；该侧不存在时为 null
  newPage: number | null; // 1-based 新页页码；该侧不存在时为 null
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
```

- 坐标单位为 **MediaBox 相对的 PDF pt**，与 `DiffChange.oldBBox` / `newBBox`
  完全一致（原点在页面左下角）。
- 引擎校验：页码必须 ≥ 1 或 `null`，至少命名一页，坐标必须是有限数且
  `x0 <= x1`、`y0 <= y1`；非法区域返回错误而不是静默忽略。UI 绘制时会先
  归一化（任意方向拖拽都会交换角点）。
- RPC 使用 snake_case（`old_page` / `new_page` / `bbox`），TS 侧由
  `diffOptionsToRpc()` 转换；CLI/JSON 使用 camelCase。
- 结果中的 `options.ignoreRegions` 以 camelCase 回显（输入会先规范化），便于复现。

### 过滤规则

- 变更的 `oldBBox` 与某个 `oldPage` 匹配的区域相交 → 忽略；
- 变更的 `newBBox` 与某个 `newPage` 匹配的区域相交 → 忽略；
- 页面尺寸/旋转变化用页面 MediaBox 作为盒子，任意一侧的区域都可以屏蔽；
- 单侧页只用存在那一侧的区域；
- 相交判定包含边界（接触即相交），与 UI 的矩形命中一致。

区域在对象匹配**之后**、排序之前应用，所以移除区域后重新运行会恢复变更。
区域只读，永远不会写入或修改 PDF。

### UI 操作

1. 打开 Diff 工作区，切到 `Side by side` 或 `Overlay`；
2. 点击工具栏 `Ignore region`；
3. 在任一页面拖动矩形（`Esc` 取消当前拖拽）；
4. 左侧 `Ignore regions` 列出 `both · page 1` / `old … → new …` 与 bbox，虚线框
   同步绘制在页面上；
5. 点击 `Apply & re-run` 才会重新比较（拖动不会每次触发 diff）；
6. `Remove` 删除单条区域，`Clear regions` 清空；再次 `Apply & re-run` 恢复。

区域属于当前比较：更换文件或重置工作区会清空。`Visual` 视图不能绘制区域，
但会用半透明灰蓝遮罩标出已绘制的区域，并保留虚线轮廓。

### CLI JSON 示例

```json
[
  {
    "oldPage": 1,
    "newPage": 1,
    "bbox": { "x0": 59.1, "y0": 604.3, "x1": 242.4, "y1": 651.6 }
  }
]
```

```sh
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-regions regions.json \
  --format json --output diff.json
```

`summary` 会随过滤后的变更更新；`options.ignoreRegions` 以规范化后的 camelCase
回显，便于审查。

## 注释、链接、表单与文档元数据

Diff 3.0 在对象级比较之上增加**文档资源比较**：注释（annotation）、链接（link）、
表单控件（form）、文档元数据（metadata）与页面标签（page label，来自 `/PageLabels`）。
对象级结果仍然是事实来源——资源变更不改变对象计数、页面对齐、视觉对比与
`MAX_DIFF_CHANGES` 的既有语义，只是在同一份 `DiffResult` 里增加额外条目。资源由
Python 侧车（`sidecar/diff_resources.py`）直接读取 PDF 字典收集，因此 CLI/CI 与 UI
消费同一份结果，既不依赖渲染层 PDF.js，也没有新增运行时依赖。

### 比较什么

| 资源 | 读取位置 | 比较字段 |
|---|---|---|
| `annotation` | 页面 `/Annots` 中除 Link/Widget 之外的注释 | subtype、title、contents、color、opacity、flags、rect |
| `link` | `/Annots` 中的 Link（`/A`、`/Dest`） | uri、internalPage、unsafeUrl、target、action、contents、rect |
| `form` | `/AcroForm` 字段树与 `/Subtype /Widget` 控件 | fieldType、fieldName、value、defaultValue、options、flags、rect |
| `metadata` | Info 字典与 catalog `/Lang` | title、author、subject、keywords、creator、producer、creationDate、modDate、language |
| `page-label` | catalog `/PageLabels` 数字树 | 每页标签文本，以及 style / prefix / start |

- 链接只解析目标文本与内部页码：不打开 URI、不执行 `/Launch`、不探测外部地址；
  `unsafeUrl` 只是“目标不是 `http(s)`”的布尔标记。
- 表单只读字段值、默认值、Flags 与选项：不填写、不重置、不提交，也不导入 XFA。
- 页面标签只支持标准 `/Nums` / `/Kids` 数字树；畸形结构降级为无标签，不会中断比较。
- 视觉对比（像素）不参与资源比较：`Visual` 视图仍然只比较渲染出来的像素。

### identity 与配对

同一页内先按稳定 identity 配对，配不上的条目分别报告 added / removed：

| 资源 | identity |
|---|---|
| `annotation` | `/NM` → `ann:nm:<NM>`；没有 `/NM` 时退化为 subtype + rect + contents |
| `link` | `/NM` → `link:nm:<NM>`；否则按 URI / 内部页码 / 目标文本 / 纯 rect 生成，并带上 rect |
| `form` | 完整字段名 `/T` + widget rect；没有字段名时退回 rect |

- 字段名由 `/AcroForm` 字段树补全（嵌套字段以点号连接），同名控件再按 rect 区分。
- 同一 identity 冲突（同一页出现多条完全相同的资源）时按出现顺序追加 `#2`、`#3`
  后缀，避免误合并。
- identity 里已经包含 rect 的资源（没有 `/NM` 的注释、所有表单、按 URI/页码/目标
  配对的链接）移动后 identity 会变化，因此移动被报告为**一条 removed + 一条
  added**；只有 `/NM` identity 能报告 `moved`。这是有意的保守取舍：凭空做位置模糊
  匹配会把无关资源合并到一起。

### 结果放在哪里

| 位置 | 内容 |
|---|---|
| `pages[].changes` | 页级 `annotation` / `link` / `form` 变更，结构与对象变更完全一致（kind、type、old/new page、old/new BBox、text，`details.resource` / `details.identity`，以及每个变化字段的 `{ old, new }`） |
| `documentChanges` | 文档级 `metadata`（`page` 为 `null`，`field` 为元数据键）与 `page-label`（`page` 为 1-based 页码，`field` 为 `page-label`，`details` 带 style/prefix/start 差异） |
| `summary` | 资源计数器 `resourcesAdded` / `resourcesRemoved` / `resourcesModified` / `resourcesMoved`，以及 `documentChanges` 条数 |

- 页面标签只出现在 `documentChanges` 中，不会再写进页级 `changes`，避免重复计数。
- 对象计数器（`objectsAdded` 等）**不含**资源变更：只想去重对象的消费者不受影响。
- 资源计数器是加法字段，只有本次运行真的比较了资源并发现差异时才出现；纯对象结果
  保持历史形状。

### schema 兼容

`schemaVersion` 仍然是 `1`，所有新增字段都是可选字段：

```ts
// DiffResult
documentChanges?: DiffDocumentChange[];        // metadata / page-label
// DiffSummary
resourcesAdded?: number;
resourcesRemoved?: number;
resourcesModified?: number;
resourcesMoved?: number;
resourcesTruncated?: boolean;
documentChanges?: number;
// DiffOptions（默认全部 false，即默认比较全部资源）
ignoreAnnotations?: boolean;
ignoreLinks?: boolean;
ignoreForms?: boolean;
ignoreMetadata?: boolean;
ignorePageLabels?: boolean;
```

`truncated` 与 `summary.changesTruncated` 仍是原有的截断标记；资源块命中收集上限时
额外出现 `summary.resourcesTruncated: true`（见“上限与截断”）。

### 忽略选项与忽略区域

- 设置对话框的 `Content` 分组提供 Annotations / Links / Forms / Metadata /
  Page labels 五个开关，默认全开；CLI 与 action 使用同名选项
  （`--ignore-annotations` 等）。
- 忽略某一类资源时，该类型不收集、不比较，也不进入 `pages[].changes`、
  `documentChanges` 与资源计数器；页面资源摘要同样把它当空，因此“只有被忽略类型
  不同”的页会重新回到 `unchanged`。
- 五类全部忽略时资源比较整体跳过，JSON 里不出现任何资源字段。
- 忽略区域（`DiffIgnoreRegion`）只对有 BBox 的条目生效：`annotation` / `link` /
  `form` 与对象变更共用“变更 BBox 与区域相交即忽略”的规则；元数据与页面标签没有
  BBox，**不受区域影响**。

### 页面状态与快速路径

- 配对页只有在**页面签名相同且页面资源摘要也相同**时才直接判为 `unchanged`；
  签名相同、只有注释/链接/表单不同时，页面状态是 `changed`，只做资源比较（不抽取
  对象，`match.score` 仍是 `1.0`，对象计数为 0）。
- 资源摘要只包含本次实际比较的资源类型（被忽略的类型按空处理），所以忽略选项会
  影响哪些页需要重新比较。
- 只有元数据或页面标签变化时，所有页面保持 `unchanged`：这类变化只出现在
  `documentChanges`，不会把页面标成 changed。
- UI 侧边栏摘要显示 `Annotations` / `Links` / `Forms` / `Document changes` 计数；
  页级资源变更与对象变更共用 Kind / Type 过滤（新增 `Annotation`、`Link`、`Form`、
  `Metadata`、`Page label` 类型），`Document changes` 是页组上方的独立折叠组，
  `Page label` 行可以 `Go to page` 跳到对应页。
- 有 BBox 的资源变更为虚线框，对象框保持实线；没有 BBox 的条目只在详情里显示。
  详情展示 subtype / title / contents / color / opacity / flags、链接 target 与
  `unsafeUrl`、表单 value / default / options / flags，以及元数据/页面标签的旧值与
  新值。

### 上限与截断

| 限制 | 值 |
|---|---:|
| 每页注释 | 500 |
| 全文档注释 | 5000 |
| 单条注释文本 | 4096 字符 |
| 目标/URL 展示长度 | 2048 字符 |
| 表单字段 | 2000 |
| 单字段选项 | 100 |
| 元数据字段 | 32 |
| PageLabels 条目 | 5000 |
| 嵌套字段 / 数字树深度 | 8 |

- 资源变更与对象变更共用 `MAX_DIFF_CHANGES = 50_000` 的变更预算，异常 PDF 无法用
  百万条注释撑爆 JSON。
- 命中任一收集上限，或某个资源块无法读取（畸形注释/表单被跳过）时，结果带
  `truncated: true`、`summary.changesTruncated: true` 与
  `summary.resourcesTruncated: true`——被截断的结果不会伪装成“干净无差异”。
- 单个畸形注释/表单/标签不会让整次 diff 失败，它只被跳过并计入截断标记。

### CLI 示例

```sh
# 资源与对象一起比较（默认）
python sidecar/cli.py diff old.pdf new.pdf

# 只比较元数据与页面标签：忽略注释、链接与表单
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-annotations --ignore-links --ignore-forms

# 只比较注释、链接与表单：忽略元数据与页面标签
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-metadata --ignore-page-labels

# 资源变化同样受 --fail-on 约束：资源 modified 也返回 1
python sidecar/cli.py diff old.pdf new.pdf --fail-on modified \
  --format json --output diff.json
```

`--fail-on` 对资源变更的覆盖：

| `--fail-on` | 资源相关条件 |
|---|---|
| `any` | 任意资源变化，或 `documentChanges` 非空 |
| `added` / `removed` | 新增/删除的资源（同时仍覆盖对象与页面） |
| `modified` | modified 或 moved 的资源，以及任意 `documentChanges`（元数据/页面标签） |
| `page-count` / `reordered` | 只看页面计数与页序，资源变化不参与 |

action 提供同名输入 `ignore-annotations` / `ignore-links` / `ignore-forms` /
`ignore-metadata` / `ignore-page-labels`，并透传为 CLI 选项。

### 只读边界

- 不打开链接、不执行 `/Launch` 或其他动作、不发起网络请求；`target` 与 `unsafeUrl`
  只用于显示。
- 不填写、重置或提交表单，不导入 XFA，不验证签名。
- 不创建、修改或删除注释，不写回 PDF；资源比较是纯读取。
- 资源变更也不进入对象导出 JSON/CSV，`Annots` 的导出 schema 保持不变。

### 示例与预期结果

`web-samples/diff-resources-old.pdf` / `web-samples/diff-resources-new.pdf` 由
`python scripts/generate-diff-resource-samples.py` 确定性生成（无随机数、无时间戳、
无网络）。两页的页面几何、内容流与对象完全相同，只有资源不同：注释内容与颜色、
外部链接目标 `…/v1` → `…/v2`、表单值 `Alice` → `Bob`、元数据 title 与 author、
第 1 页页面标签 `i` → `ii`。

```sh
python sidecar/cli.py diff web-samples/diff-resources-old.pdf web-samples/diff-resources-new.pdf
```

预期结果：`pages 2 -> 2`（1 changed、1 unchanged）、`objects 0`（0/0/0/0）、
`resources 0 added, 0 removed, 3 modified, 0 moved`、`document changes: 3`
（title、author、page label）。默认 `--fail-on any` 因此返回 `1`；同时加上五类
`--ignore-*` 后返回 `0` 并输出 `documents match`。

## CLI 与 Action

### 阈值

| `--fail-on` | 返回 1 的条件 |
|---|---|
| `any` | 任意对象、资源、文档元数据或页面变化（默认） |
| `added` / `removed` | 新增/删除的对象、资源**或页面** |
| `modified` | modified、moved 的对象与资源，任意 `documentChanges`，以及页面尺寸/旋转变化 |
| `page-count` | 页面增删、页数变化、页面几何变化 |
| `reordered` | `pagesReordered > 0`（配对页换了页码） |
| `none` | 永不返回 1（输入错误仍返回 2） |

退出码：`0` 无失败；`1` `--fail-on` 命中；`2` 参数/输入/解析/输出错误。

### CLI

```sh
# 摘要（默认）：显示 pages / pages reordered / objects / resources 与变更列表
python sidecar/cli.py diff old.pdf new.pdf

# 页序门禁
python sidecar/cli.py diff old.pdf new.pdf --fail-on reordered

# 区域 + JSON + HTML
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-regions regions.json \
  --format json --output diff.json
python sidecar/cli.py diff old.pdf new.pdf \
  --format html --output diff.html --fail-on none
```

`--format json` 输出完整的 `DiffResult`；新增字段是加法的：

```json
{
  "schemaVersion": 1,
  "summary": {
    "pagesReordered": 4,
    "resourcesModified": 3,
    "documentChanges": 3
  },
  "pages": [
    {
      "oldIndex": 2,
      "newIndex": 1,
      "status": "changed",
      "match": { "score": 1.0, "reordered": true },
      "changes": []
    }
  ],
  "documentChanges": [
    {
      "kind": "modified",
      "type": "page-label",
      "page": 1,
      "field": "page-label",
      "oldValue": "i",
      "newValue": "ii",
      "details": { "start": { "old": 1, "new": 2 } }
    }
  ]
}
```

### GitHub Action

```yaml
- uses: <owner>/pdf-inspector@v1
  with:
    old: baseline.pdf
    new: docs/report.pdf
    fail-on: reordered            # 只把页序变化当作门禁
    ignore-regions: regions.json  # 可选：与 CLI 相同的 JSON 数组
    format: json
    json-path: artifacts/pdf-diff.json
```

action 的 `fail-on` 接受 `reordered`；`ignore-regions` 会先校验文件存在且非空，
再透传给 CLI。退出码仍先写入 `exit-code` 输出，再让步骤失败，因此后续步骤可以
读取 JSON/HTML artifact 与 `exit-code`。

## 长任务保护与上限

Diff 走后台通道，桌面端与 Web 后端共用同一套预算与保护。它们是**保护**，不是让
病态页面变快的手段：某一页本身就要算很久时，工具最终仍会按预算放弃。

- **每页进度**：`diff_documents` 依次上报 `start`（页数）→ 每页、每侧的
  `fingerprints` → 配对后的 `pages 0/N` → 每页比较完的 `pages i/N` → `done`。
  每个进度行都是独立的 `{"id": <request id>, "progress": {...}}`，父进程收到后只
  重置该请求的空闲计时器。
- **5s 心跳**：单页再慢也可能长时间没有“页完成”事件，因此 `diff_documents`
  执行期间 `sidecar/main.py` 每 5s 额外发一次
  `{"progress": {"stage": "heartbeat"}}`。心跳与逐页进度共用同一把 stdout 锁，
  不会出现交错的 JSON 行；请求结束（含出错）时心跳线程会被停止并 join，绝不会
  在响应之后继续输出，也不会为其他方法发送。
- **300s 无进展预算**：`DIFF_TIMEOUT_MS = 300_000` 是空闲预算而非总时长上限；
  有进度或心跳就会续期，总耗时可以超过 300s。完全沉默满 300s 才失败，错误固定为
  `Request "diff_documents" timed out after 300s without progress`。
- **超时只重启后台通道**：该错误说明 Python 进程可能仍在计算被放弃的 diff。桌面端
  `src/main/ipc-handlers.ts` 与 Web 端 `server/web-server.ts` 会调用
  `restartBackground()`（绝不会重启交互通道）以杀掉遗留计算，然后仍然把原始超时
  错误返回给调用方（Web 为 504）。重启是尽力而为且受 sidecar 自身 stop/ready 超时
  约束；重启失败只记录日志，不掩盖原错误。
- **50k 变更上限**：整次运行最多保留 `MAX_DIFF_CHANGES = 50_000` 条变更（资源变更与
  对象变更共用这份预算），超出时结果带 `truncated: true` 与
  `summary.changesTruncated: true`，页面状态仍然完整。资源收集器自己的上限另有
  `summary.resourcesTruncated: true`，含义相同：结果不完整。
- **字符级比较是选项**：引擎与 CLI 默认比较全部类型；UI 默认把 `"char"` 放进
  `ignoreTypes`（只报 word 级变更），由 “Character-level changes” 复选框开启。
  大文本 PDF 的逐字符差异可能产生海量变更，因此 50k 上限与截断标记同时存在。
- **开销与改动页数成正比**：页面签名（见“页面签名与快速路径”）让未改动页跳过
  pdfplumber layout 与对象抽取，字节相同的两份文件只扫描一遍页面几何。实测
  2000 页、每页 40 行文本的合成文档：整份未改动从约 340s 降到约 2.5s；只改 1 页
  约 2.7s（仅抽取该页两侧）。

## 确定性与安全

- **页面指纹、签名、配对、`page_match_score`、区域过滤与资源比较都是纯函数**，不依赖
  时间、随机数或网络；相同输入 + 相同选项产生逐字节一致的 JSON。
- `score` 只保留 3 位小数；变更、页面、资源与区域顺序稳定。
- CLI/Action 只读本地路径，拒绝 `http(s)`；区域 JSON 只包含数字与页码，不执行
  任何内容。
- 资源只读：不打开链接、不执行 `/Launch` 或其他动作、不发起网络请求、不填写或提交
  表单、不验证签名、不写回 PDF（见“注释、链接、表单与文档元数据 → 只读边界”）。
- 视觉对比完全在浏览器内运行：不上传额外数据、不写入 PDF、不产生服务端渲染
  依赖；位图上限避免大页面占用过多内存。
- 忽略区域只是过滤展示结果，不会修改输入文件，也不会改变已保存的 JSON（除非
  重新运行）。

## 示例文件

`python scripts/generate-web-samples.py` 确定性生成（`invariant=1`，固定元数据、
无网络、无随机数；重复运行逐字节一致）；资源样例由
`python scripts/generate-diff-resource-samples.py` 生成（同样确定性、无压缩、无时钟）：

| 文件 | 内容 |
|------|------|
| `web-samples/diff-visual-old.pdf` / `diff-visual-new.pdf` | 两页；第 1 页状态徽标由 `STATUS: DRAFT`（琥珀色）变为 `STATUS: FINAL`（绿色），红色色块改为紫色，蓝色色块右移 28 pt，正文 `42` 改为 `48`；第 2 页完全相同。 |
| `web-samples/diff-reordered-old.pdf` / `diff-reordered.pdf` | 五页；修订 B 删除首页草稿、追加发布说明，并把每页页眉分隔线下移 3 pt，得到 4 个重排配对 + 1 个删除页 + 1 个新增页。 |
| `web-samples/diff-resources-old.pdf` / `diff-resources-new.pdf` | 两页，对象与内容流完全相同；只有注释内容/颜色、链接目标、表单值、元数据 title/author 与第 1 页页面标签变化，得到 0 个对象变更、3 个资源变更与 3 条 `documentChanges`。 |

验证用命令：

```sh
# 视觉示例：1 个 changed 页、16 个对象变更、pagesReordered = 0
python sidecar/cli.py diff web-samples/diff-visual-old.pdf web-samples/diff-visual-new.pdf

# 重排示例：pagesReordered = 4、pagesAdded = 1、pagesRemoved = 1
python sidecar/cli.py diff web-samples/diff-reordered-old.pdf web-samples/diff-reordered.pdf --fail-on reordered

# 资源示例：objects 0、resources 3 个 modified、document changes 3
python sidecar/cli.py diff web-samples/diff-resources-old.pdf web-samples/diff-resources-new.pdf
```

## 验证记录

- `npx tsc -b`、`npx tsc -p tsconfig.web.json`、`npx vitest run`、
  `.venv/bin/python -m pytest sidecar/__tests__ -q` 全部通过。
- `npm run build:web` 与 `npm run build:web-server` 通过；Web 服务在
  `http://127.0.0.1:8080` 运行。
- 截图（1440×900，`agent-browser`）：`docs/images/diff-visual.png`（Heatmap +
  `14,838 / 484,704 px changed (3.06%)`）、`docs/images/diff-regions.png`
  （区域 `both · page 1`，重新运行后变更从 16 条降到 7 条）、
  `docs/images/diff-reordered.png`（`Old 2 → New 1` … `Old 5 → New 4` 与
  `New page 5 added`）、`docs/images/diff-page-groups.png`（按页折叠、`Go to page`
  跳到 `4 of 6` 并自动展开 `Old 4 → New 3`）、`docs/images/diff-resources.png`
  （对象 0 变更、资源 3 条、`Document changes` 3 条、资源虚线框与只读详情）。
- 1280×800 与 1600×1000 下 `documentElement.scrollWidth === clientWidth`
  （无横向溢出），控制台与页面错误为空。

## 已知限制

- 视觉对比只在 UI 中运行；CLI/JSON/HTML/action 不渲染页面，但它们除了对象变更也
  输出文档资源变更（注释、链接、表单、元数据、页面标签）。
- 像素阈值固定为通道差 > 24，位图最长边上限 1600 px；百分比是采样统计，
  不是逐设备像素的精确值，也不提供阈值/上限设置项。
- 忽略区域是页面坐标矩形，按“变更 BBox 与区域相交”过滤；一个较大的区域可能
  同时屏蔽多个对象或注释/链接/表单（例如整张表格）。元数据与页面标签没有 BBox，
  不受区域影响。
- 区域只在当前比较内有效，不跨运行共享，也不能按区域预设批量复用。
- 旋转页（`/Rotate` 为 90/180/270）不能绘制忽略区域；`Visual` 视图仍会渲染页面，
  但对象框、资源框与区域遮罩使用未旋转的 MediaBox 坐标，可能整体偏移。
- 页面对齐基于“内容流文本字面量的多重集 + 页面尺寸”（`_page_alignment_key`）
  与 `SequenceMatcher`：真正“交换”的页可能表现为 `removed` + `added`，只有被配对
  的页才标记 `reordered`；重复页按顺序配对。
- 未改动页的判定是**字节级**的（页面签名）：内容相同但被重新编码/重新保存过的
  页会退回完整比较（结果不变，只是慢）；想让这类页也走快速路径，需要按渲染结果
  比较，目前不做。
- 没有 `/NM` 的资源（注释、表单、按 URI/页码/目标配对的链接）把 rect 写进 identity，
  因此移动会表现为 `removed` + `added`，而不是 `moved`；只有 `/NM` 资源能报告
  `moved`。这是保守取舍，不做位置模糊匹配。
- 页面标签只解析标准 `/Nums` / `/Kids` 数字树；自定义或损坏的标签结构会被跳过，并
  通过 `resourcesTruncated` 标记结果不完整。XFA 数据、附件与签名内容不参与资源比较。
- `match`、`pagesReordered`、`documentChanges` 与资源计数器都是加法字段，
  `schemaVersion` 仍为 `1`；读取方不应假定字段集合完全固定，但可以忽略未知字段。
