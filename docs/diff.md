# PDF Diff 2.0：页面对齐、视觉对比与忽略区域

Diff 仍然以**对象级比较**为事实来源：word / char / rect / line / curve / image /
table 七类对象逐页比较，输出 `added` / `removed` / `moved` / `modified`，
`DiffResult.schemaVersion` 保持 `1`。Diff 2.0 在此基础上增加三件事：

- **页面对齐信息**：每个配对页带 `match.score` 与 `match.reordered`，摘要带
  `pagesReordered`，CLI/HTML/action 可以按“页序变化”单独判定。
- **视觉对比视图（仅 UI）**：在浏览器 canvas 中把旧页/新页渲染成同一张位图，
  提供 Blend、Heatmap、Boxes 三种显示方式与像素统计。
- **可绘制的忽略区域**：在页面上拖框得到 MediaBox 坐标矩形，由引擎在对象级
  过滤相交的变更，并由视觉热力图同步遮罩。

CLI 与 GitHub Action 不包含视觉对比，也不需要无头渲染器；它们只消费对象级
结果、页面对齐字段与区域参数。

## 页面对齐与重排语义

### 页面指纹

配对前先为每页计算一个轻量指纹（`sidecar/diff.py: page_fingerprint`），只用于
识别“这是不是同一页”，不参与对象级比较：

| 组成 | 说明 |
|------|------|
| 页面尺寸 | MediaBox 宽/高（保留 2 位小数） |
| `/Rotate` | 归一化到 `0..359` |
| 文本哈希 | 按阅读顺序拼接、空白归一化后的 word 文本的 SHA-256 |
| 对象计数 | 七类对象各自的计数 |
| 表格哈希 | 表格单元格文本（按行/单元格拼接）的 SHA-256 |

颜色、字体与图片字节**不进入**指纹：这些属于对象级变更，不是页面身份。

`match.score`（`0..1`，3 位小数）是各分量的加权和，权重固定：

| 分量 | 权重 | 计算 |
|------|------|------|
| 尺寸 | 0.35 | 宽/高比例相似度的均值 |
| 旋转 | 0.10 | 完全相等为 1，否则 0 |
| 文本哈希 | 0.30 | 完全相等为 1，否则 0 |
| 对象计数 | 0.15 | 七类计数比例相似度的均值 |
| 表格哈希 | 0.10 | 完全相等为 1，否则 0 |

完全相同的指纹得分恰好 `1.0`；单侧页（`oldIndex` 或 `newIndex` 为 `null`）
没有 `match`，字段为 `null`。

### 配对

`pair_pages` 用 `difflib.SequenceMatcher`（`autojunk=False`，确定性）对齐两个
指纹序列：

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
追加 `Release notes`，并把每页页眉分隔线下移 3 pt（文本与对象计数不变，因此
指纹仍然匹配）。结果：

| 旧页 | 新页 | status | match |
|------|------|--------|-------|
| 1 | — | removed | `null` |
| 2 | 1 | changed | `{ score: 1.0, reordered: true }` |
| 3 | 2 | changed | `{ score: 1.0, reordered: true }` |
| 4 | 3 | changed | `{ score: 1.0, reordered: true }` |
| 5 | 4 | changed | `{ score: 1.0, reordered: true }` |
| — | 5 | added | `null` |

摘要：`pagesReordered: 4`、`pagesAdded: 1`、`pagesRemoved: 1`、
`pagesChanged: 4`。界面的页面列表与页面栏显示 `Old 2 → New 1` 形式的新旧页码，
单侧页显示 `Old page 1` / `New page 5`。

HTML 报告的 “Page alignment” 表列出旧/新页码、`match` 分数与 `reordered`
徽标；摘要区同时显示 `Pages reordered`。

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
| `Boxes` | 不比较像素，只显示对象框（移除红、新增绿、移动橙、修改蓝），适合定位对象级改动。 |

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

## CLI 与 Action

### 阈值

| `--fail-on` | 返回 1 的条件 |
|---|---|
| `any` | 任意对象或页面变化（默认） |
| `added` / `removed` | 新增/删除的对象**或页面** |
| `modified` | modified、moved 对象，以及页面尺寸/旋转变化 |
| `page-count` | 页面增删、页数变化、页面几何变化 |
| `reordered` | `pagesReordered > 0`（配对页换了页码） |
| `none` | 永不返回 1（输入错误仍返回 2） |

退出码：`0` 无失败；`1` `--fail-on` 命中；`2` 参数/输入/解析/输出错误。

### CLI

```sh
# 摘要（默认）：显示 pages / pages reordered / objects 与变更列表
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
  "summary": { "pagesReordered": 4 },
  "pages": [
    {
      "oldIndex": 2,
      "newIndex": 1,
      "status": "changed",
      "match": { "score": 1.0, "reordered": true },
      "changes": []
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

## 确定性与安全

- 页面指纹、配对、`page_match_score` 与区域过滤都是纯函数，不依赖时间、随机数
  或网络；相同输入 + 相同选项产生逐字节一致的 JSON。
- `score` 只保留 3 位小数；变更、页面与区域顺序稳定。
- CLI/Action 只读本地路径，拒绝 `http(s)`；区域 JSON 只包含数字与页码，不执行
  任何内容。
- 视觉对比完全在浏览器内运行：不上传额外数据、不写入 PDF、不产生服务端渲染
  依赖；位图上限避免大页面占用过多内存。
- 忽略区域只是过滤展示结果，不会修改输入文件，也不会改变已保存的 JSON（除非
  重新运行）。

## 示例文件

`python scripts/generate-web-samples.py` 确定性生成（`invariant=1`，固定元数据、
无网络、无随机数；重复运行逐字节一致）：

| 文件 | 内容 |
|------|------|
| `web-samples/diff-visual-old.pdf` / `diff-visual-new.pdf` | 两页；第 1 页状态徽标由 `STATUS: DRAFT`（琥珀色）变为 `STATUS: FINAL`（绿色），红色色块改为紫色，蓝色色块右移 28 pt，正文 `42` 改为 `48`；第 2 页完全相同。 |
| `web-samples/diff-reordered-old.pdf` / `diff-reordered.pdf` | 五页；修订 B 删除首页草稿、追加发布说明，并把每页页眉分隔线下移 3 pt，得到 4 个重排配对 + 1 个删除页 + 1 个新增页。 |

验证用命令：

```sh
# 视觉示例：1 个 changed 页、16 个对象变更、pagesReordered = 0
python sidecar/cli.py diff web-samples/diff-visual-old.pdf web-samples/diff-visual-new.pdf

# 重排示例：pagesReordered = 4、pagesAdded = 1、pagesRemoved = 1
python sidecar/cli.py diff web-samples/diff-reordered-old.pdf web-samples/diff-reordered.pdf --fail-on reordered
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
  `New page 5 added`）。
- 1280×800 与 1600×1000 下 `documentElement.scrollWidth === clientWidth`
  （无横向溢出），控制台与页面错误为空。

## 已知限制

- 视觉对比只在 UI 中运行，CLI/JSON/HTML/action 都是对象级；没有 headless
  渲染依赖。
- 像素阈值固定为通道差 > 24，位图最长边上限 1600 px；百分比是采样统计，
  不是逐设备像素的精确值，也不提供阈值/上限设置项。
- 忽略区域是页面坐标矩形，按“变更 BBox 与区域相交”过滤；一个较大的区域可能
  同时屏蔽多个对象（例如整张表格）。
- 区域只在当前比较内有效，不跨运行共享，也不能按区域预设批量复用。
- 旋转页（`/Rotate` 为 90/180/270）不能绘制忽略区域；`Visual` 视图仍会渲染页面，
  但对象框与区域遮罩使用未旋转的 MediaBox 坐标，可能整体偏移。
- 页面对齐基于内容指纹 + `SequenceMatcher`：真正“交换”的页可能表现为
  `removed` + `added`，只有被配对的页才标记 `reordered`；重复页按顺序配对。
- `match` 与 `pagesReordered` 是加法字段，`schemaVersion` 仍为 `1`；读取方不应
  假定字段集合完全固定，但可以忽略未知字段。
