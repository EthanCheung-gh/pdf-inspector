# 原始 PDF 对象树与内容流

PDF Inspector 的 `Raw` 工作区把 PDF 的**对象图**与**解码后的页面内容流**暴露给开发者：从 trailer 根开始逐层展开字典、数组与引用，按页读取 `BT` / `Tf` / `Tj` / `Do` 等操作符及其操作数。它是纯只读的诊断视图，不编辑对象、不改写流、不解密，也不执行内容流。

数据来源是已经打开的 Python 侧车（pdfminer）文档对象：`sidecar/raw.py` 读取 trailer、catalog 与 `PDFObjRef` / `PDFStream`，`PDFContentParser` 解码页面内容流。渲染层只收到有界、不可执行的 JSON，桌面端与 Web 端使用同一套类型、store 与组件。

## 请求接口

三个 RPC 方法都要求侧车已经通过 `open` 打开文档，且只返回 JSON：

| 方法 | 参数 | 返回 |
|---|---|---|
| `raw_document` | 无 | `RawDocument`：`pages` / `version` / `encrypted` / `roots` |
| `raw_object` | `object_number`（必填，≥1）、`generation`（可选，≥0） | `RawObject`：`ref` / `value` / `summary` |
| `raw_page_content` | `page`（必填，1 起，不能超过页数） | `RawPageContent`：`page` / `streams` / `truncated` |

调用示例：

```json
{ "id": 3, "method": "raw_object", "params": { "object_number": 11, "generation": 0 } }
```

错误统一通过 JSON-RPC 错误返回，消息面向用户、有长度上限：

- 没有打开文档：`No PDF open`；
- 页码越界：`Page 9 out of range (document has 2 pages)`；
- 对象不存在：`Object 999 not found`；
- generation 不匹配：`Object 11 has generation 0, not 1`；
- 对象无法读取：`Cannot read object 11: ...`。

超时：侧车请求预算为 `RAW_TIMEOUT_MS = 120_000`，渲染层的整体预算为 `RAW_RENDERER_TIMEOUT_MS = 125_000`；Web 后端的 RPC 白名单只放行上面三个方法。

## Trailer 根

`raw_document` 只读取 xref trailer 与 catalog，不做页面提取或布局分析。`roots` 顺序固定为：

| 标签 | 值 |
|---|---|
| `Catalog` | trailer 的 `Root`（文档目录） |
| `Info` | trailer 的 `Info`（文档信息字典） |
| `Encrypt` | trailer 的 `Encrypt`（加密字典，未加密时为 `null`） |
| `ID` | trailer 的 `ID` 数组 |
| `Pages` | catalog 的 `Pages`（页面树根） |

每个根的形状是 `{ label, ref, value }`：`ref` 是 `{ objectNumber, generation }` 或 `null`；`value` 只对非间接值（例如 `ID` 数组）直接给出。`pages` / `version` / `encrypted` 来自已打开的文档对象，`version` 无法确定时为 `null`。

展开根只是一次 `raw_object` 调用，不会遍历页面树或对象图。

## 值序列化

`RawValue` 是判别联合，与 `src/renderer/types/raw-pdf.ts` 一一对应：

| `kind` | 字段 | 说明 |
|---|---|---|
| `null` | — | PDF `null` |
| `boolean` | `value` | `true` / `false` |
| `number` | `value` | 整数或浮点数 |
| `string` | `value`、`truncated` | 解码后的文本，最多 `MAX_STRING` 字符 |
| `name` | `value` | `/Name`，去掉前导斜杠 |
| `ref` | `ref` | `{ objectNumber, generation }`，**不会自动解析** |
| `array` | `items`、`truncated` | 最多 `MAX_ITEMS` 项 |
| `dict` | `entries`、`truncated` | `{ key, value }`，最多 `MAX_ITEMS` 项 |
| `stream` | `dict`、`length`、`filters`、`preview`、`truncated` | 流只给元数据与有界预览 |

序列化规则：

- **引用保持引用**。`15 0 R` 始终是 `{ kind: 'ref' }`，由用户显式展开或点击后才读取该对象；因此循环引用不会导致递归，树也不会因为一次展开而遍历整份文档。
- **字典与数组最多展开 `MAX_DEPTH = 4` 层**，超过时返回空的 `entries` / `items` 并置 `truncated: true`。
- **字符串与流预览最多 `MAX_STRING = 4096` 字符**，超出部分丢弃并置 `truncated: true`。
- **流不返回字节**。`length` 来自 `/Length`（不可读时为 `null`），`filters` 是过滤器名称列表，`preview` 只在载荷可解码且看起来是文本时给出（例如内容流），图片等二进制过滤器一律 `preview: null`。流的字典本身仍按普通字典序列化，因此可以看到 `/Subtype`、`/Width`、`/Height` 等元数据。
- **无法读取的值**降级为有界的占位字符串（如 `<unreadable PDFStream>`），不会让整个请求失败。
- 序列化结果只包含 JSON 标量、数组与对象：没有时间戳、绝对路径或原始文件字节。

## 对象详情

`raw_object` 用 `doc.getobj(object_number)` 读取单个间接对象，并校验 `generation`（能取到 xref generation 时）。返回：

```json
{
  "ref": { "objectNumber": 11, "generation": 0 },
  "summary": "dict (3 entries)",
  "value": { "kind": "dict", "entries": [], "truncated": false }
}
```

`summary` 是右侧面板标题旁的简短描述：`dict (n entries)`、`array (n items)`、`stream (FlateDecode, 750 bytes)`、`ref 7 0 R`、`name Page` 等。对象不存在或无法读取时返回 RPC 错误，界面显示错误并允许重试，不会清空已加载的树。

## 内容流

`raw_page_content` 读取页面的 `/Contents`（单条流或流数组），用 `PDFContentParser` 解码并逐条配对操作数与操作符：

```json
{
  "page": 1,
  "streams": [
    {
      "ref": { "objectNumber": 12, "generation": 0 },
      "length": 771,
      "filters": ["ASCII85Decode", "FlateDecode"],
      "operators": [
        { "index": 0, "offset": 12, "operator": "cm", "operands": [
          { "kind": "number", "value": 1 }, { "kind": "number", "value": 0 },
          { "kind": "number", "value": 0 }, { "kind": "number", "value": 1 },
          { "kind": "number", "value": 0 }, { "kind": "number", "value": 0 }
        ] },
        { "index": 1, "offset": 16, "operator": "BT", "operands": [] },
        { "index": 2, "offset": 26, "operator": "Tf", "operands": [
          { "kind": "name", "value": "F1" }, { "kind": "number", "value": 12 }
        ] }
      ],
      "truncated": false,
      "error": null
    }
  ],
  "truncated": false
}
```

- `page` 为 1 起页码，默认跟随 Inspect 当前页，可在面板中切换。
- 每条内容流独立成段，显示引用（`12 0 R`）、长度、过滤器与操作符数量。
- `index` 在页内跨流连续编号，`offset` 是操作符在解码字节中的偏移（便于对照原始流）。
- 操作数是 `RawValue`：数字、名称、字符串、数组等；引用操作数保持 `{ kind: 'ref' }`，点击可跳到对应对象。
- `BT` / `Tf` / `Tj` / `Do` / `cm` / `q` 等操作符只是被列出，**不会被求值或执行**；字体、图形状态和 XObject 都不会被渲染。
- 单条流解码或解析失败时记录 `error`、保留已解析的操作符并置 `truncated: true`；整页仍会返回。页内超过 `MAX_OPERATORS` 时停止解析并标记截断。

## 上限

上限集中在 `sidecar/raw.py`，界面文案与之一致：

| 常量 | 值 | 作用 |
|---|---|---|
| `MAX_DEPTH` | 4 | 直接嵌套的字典/数组序列化层数 |
| `MAX_ITEMS` | 100 | 每个字典/数组返回的条目数 |
| `MAX_STRING` | 4096 | 字符串与流文本预览的字符数 |
| `MAX_OPERATORS` | 5000 | 每页解析的操作符总数 |
| `MAX_CONTENT_STREAMS` | 20 | 每页读取的内容流条数 |

渲染层另有树的上限：展开深度 8 层、每个容器最多 100 行。命中的位置显示截断提示或深度提示，而不是静默省略。

## 界面

### 入口与工作区

- 工具栏 `Raw` 按钮打开 `Raw` 工作区；没有打开文档或 Diff / Audit 正在使用时禁用。
- Raw、Diff、Audit 互斥；Inspect 保持挂载但被隐藏，页码、缩放、选中、筛选与导出状态不受影响。
- 工作区顶部显示文件名、`Object` / `Content stream` 两个标签、`Reload` 与 `Back to Inspect`。
- **Raw 不是左侧第六个标签页**：它使用独立工作区，左侧面板仍只有 `Objects` / `Outline` / `Fonts` / `Layers` / `Annots` 五个标签，200px 最小宽度不受影响。

### 对象树

- 根行固定为 `Catalog`、`Info`、`Encrypt`、`ID`、`Pages`；`Encrypt` 在未加密文档中显示 `not present`。
- 引用行显示 `15 0 R`，点击引用选中对象（右侧显示详情），点击箭头展开；展开与选中是两个独立动作。
- 展开一个引用只调用一次 `raw_object`，结果按对象缓存；折叠再展开不会重复请求，重新打开或 `Reload` 会清空缓存。
- 树节点标记来源：`Pages`、`Kids`、`[0]`、`Page 1` 与字典键名；引用不会自动递归解析，因此不会出现无界循环。
- 深度达到 8 层时显示 `Depth limit reached; deeper references stay collapsed.`，选中行高亮。

### 对象面板

- 标题显示 `Object 11 0 R · dict (3 entries)` 这样的引用与摘要，右侧提供 `Copy JSON`（普通文本，不使用 `dangerouslySetInnerHTML`）。
- 值树区分类型：字典键、数组下标、布尔/数字/名称、带引号的字符串、引用按钮。
- 流显示长度、过滤器、`Preview binary / withheld` 或截断的文本预览，以及 `truncated` 提示。
- 点击任意引用按钮会加载并选中该对象，自动切回 `Object` 标签。
- 加载失败显示错误与 `Retry`，不会影响已加载的其他对象。

### 内容流面板

- 页选择器范围 `1..pages`，默认是进入 Raw 前的 Inspect 当前页。
- 每条流一段，显示引用、长度、过滤器、操作符数量；操作符表列为 `#` / `Offset` / `Operator` / `Operands`。
- 操作数与对象面板使用同一个只读渲染器，字符串按文本显示、引用可点击；截断或解析错误有独立提示。
- `Reload page` 会跳过缓存重新读取当前页；状态栏显示 `Raw: page 1/2 · 95 operators` 或加载/错误状态。

## 安全与只读

- 不提供任何写路径：没有对象编辑、流重写、增量保存、注释/表单修改或页面操作。
- 不解密、不绕过权限；加密文档能否读取取决于 pdfminer 的解密结果，读不到时返回错误或空结果。
- 不执行 PDF 内容：内容流只解析为操作符与操作数，不构建图形状态、不执行 JavaScript、不解析内嵌文件。
- 不返回完整流字节：文本预览有长度上限，图片等二进制流只有元数据。
- 所有文本按普通 React 文本/`<pre>` 渲染，不使用 `dangerouslySetInnerHTML`；引用与字符串都经过转义。
- 载荷不含时间戳、绝对路径或文件名，便于比较与缓存。

## 非目标

- PDF 编辑、增量保存、对象/流重写。
- xref 表/对象流偏移视图、对象搜索或查询语言。
- 原始对象/内容流的 Diff、Export 或 CLI/action 集成；Diff、Audit 与导出仍只处理提取后的对象层。
- 内容流执行跟踪（操作数栈、图形状态、渲染结果）。
- XFA、结构树/标记 PDF 的原始节点浏览。
- 内联图片（`BI` / `ID` / `EI`）的二进制检查，只有操作符本身可见。
- 为十万级对象做虚拟滚动；树保持懒加载并有上限。

## 已知限制

- 对象图是懒加载的，不保证完整：只有被展开或点击的引用会被读取。
- 展开状态与对象缓存只属于当前文档与当前 Raw 会话；重新打开、`Reload` 或切换文件都会回到 trailer 根。
- 内容流按页读取，没有整档索引；页选择器每次只显示一页。
- 流预览只对可解码的文本载荷有意义，二进制流只能看到长度、过滤器与字典元数据。
- 单条流失败只影响该流（保留部分操作符），但整页操作符预算用尽后其余流不再解析。
- 加密或损坏文档的 raw 结果取决于 pdfminer 能否解析；失败时显示错误而不是完整对象图。

## 验证

自动化测试：

```bash
.venv/bin/python -m pytest sidecar/__tests__/test_raw.py -q
npx vitest run \
  src/renderer/types/__tests__/raw-pdf.test.ts \
  src/renderer/store/__tests__/raw-store.test.ts \
  src/renderer/components/Raw/RawTree.test.ts \
  src/renderer/components/Raw/RawObjectPanel.test.ts \
  src/renderer/components/Raw/RawContentPanel.test.ts \
  src/renderer/components/Raw/RawValueView.test.ts \
  src/renderer/components/Raw/RawWorkspace.test.ts \
  src/renderer/services/__tests__/ipc-client-raw.test.ts \
  src/web/__tests__/ipc-adapter-raw.test.ts \
  server/__tests__/web-raw.test.ts
```

演示文档：`scripts/generate-web-samples.py` 生成 `web-samples/raw.pdf`（已 gitignore），两页，`invariant=1`，固定元数据与图片字节，两次运行输出逐字节一致。第 1 页包含标题与正文（`BT` / `Tf` / `Tj`）、多个命名字体资源（`/F1`–`/F4`）、一个图片 XObject（`/Subtype /Image`，通过 `Do` 放置）与 reportlab 自然生成的嵌套 `/Resources` 字典；第 2 页只有简单文本。

快速验证序列化结果：

```bash
.venv/bin/python - <<'PY'
import sys
sys.path.insert(0, 'sidecar')
from extractor import PdfExtractor
from raw import raw_document, raw_page_content

ex = PdfExtractor('web-samples/raw.pdf')
doc = raw_document(ex)
print([root['label'] for root in doc['roots']])          # Catalog/Info/Encrypt/ID/Pages
ops = [o['operator'] for s in raw_page_content(ex, 1)['streams'] for o in s['operators']]
print(sorted({'BT', 'Tf', 'Tj', 'Do'} - set(ops)))        # []
PY
```

手工检查（Web 构建）：

1. 打开 `/samples/raw.pdf`，点击工具栏 `Raw`；左侧出现 trailer 根，右侧默认选中 catalog。
2. 展开 `Catalog` → `Pages` → `Kids` → `[0]` → `Resources`，确认 `Font`（`/F1`–`/F4`）与 `XObject`（图片）都存在，选中图片引用可看到 `/Subtype /Image` 与流长度、过滤器。
3. 切到 `Content stream`，确认第 1 页同时显示 `BT`、`Tf`、`Tj` 与 `Do`，页选择器可切到第 2 页。
4. 在 1280 / 1440 / 1600 宽度下检查：无横向溢出，对象树与内容流区域可滚动，控制台与页面错误为空，左侧仍只有五个标签。

截图：`docs/images/raw-object-tree.png`（对象树与流元数据）、`docs/images/raw-content-stream.png`（第 1 页操作符与操作数）。
