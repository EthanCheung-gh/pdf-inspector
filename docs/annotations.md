# 注释、链接与表单

PDF Inspector 在对象检查之外，用 PDF.js 的 `page.getAnnotations({ intent: 'display' })` 读取当前页的交互层：链接（Link）、表单字段（Widget）、标记（Highlight 等）与注释（Text 等）。这部分是**纯只读检查**：不新建或修改注释，不填写或提交表单，不验证数字签名，也不修改 PDF 文件。

数据来源只有渲染层的 PDF.js：没有新增侧车 RPC，也没有额外的 Python 依赖。桌面端与 Web 端使用同一套归一化逻辑与界面。

## 支持的数据

每个注释归一化为一个与 UI 解耦的模型（`src/renderer/types/annotations.ts`）：

| 字段 | 说明 |
|---|---|
| `subtype` / `kind` | PDF.js 原始 subtype 与派生类别：`link` / `form` / `markup` / `note` / `stamp` / `other` |
| `page` | 所属页码（1 起），列表与详情都按页限定 |
| `rect` | 相对 MediaBox 原点的未旋转 PDF 点坐标；几何不可用时为 `null`，注释仍保留在列表中 |
| `title` / `contents` | 标题与内容，优先使用 PDF.js 的 `titleObj` / `contentsObj`，并清理控制字符 |
| `modificationDate` | 可解析的 PDF 日期会转为 ISO 8601，否则显示原始字符串 |
| `color` / `opacity` | `#rrggbb` 颜色与不透明度 |
| `hidden` | `data.hidden` 或 `HIDDEN` / `NOVIEW` 注释标志 |
| `link` | 外部 URL、原始 `unsafeUrl`、解析出的内部页码、是否要求新窗口 |
| `form` | 字段名、字段类型（`Tx` / `Btn` / `Ch` / `Sig`）、值、默认值、Flags 与选项 |

处理规则：

- Popup 注释不单独列出，改为显示其父注释的内容。
- 隐藏注释保留在列表中并带 `Hidden` 标记，但默认不绘制画布框。
- 矩形必须由四个有限数字组成且 `x0 <= x1`、`y0 <= y1`；非法几何只影响画布框，不影响文字与表单数据。
- 同一文档同一页的归一化结果按 `PDFDocumentProxy` 缓存，调用方拿到的是副本，UI 无法改动缓存。

## 界面

### `Annots` 标签页

左侧面板的第五个标签页，标签简写为 `Annots`（完整名称在按钮 tooltip 中），在 200px 最小面板宽度下与其他标签一样使用省略号截断，不会为它单独加宽面板。

- **汇总**：`N annotations · L links · F form fields`；启用过滤时显示为 `2 of 5 annotations`，后两个计数描述当前可见行。
- **Show boxes**：控制画布上的注释框，默认开启；关闭后画布点击回到对象层。
- **过滤**：`Kind`（All kinds / Link / Form field / Markup / Note / Stamp / Other）与 `Subtype`（当前页出现的原始 subtype）。过滤条件在翻页后保留；如果新页面没有该 subtype，选项仍会保留以避免筛选器变空。
- **列表行**：类别徽标、subtype、`p.N` 页码、`Hidden` 标记，以及一行预览——链接目标、`字段 = 值`，或标题/内容。点击行会选中注释并自动切到 Inspector 的 `Inspect`。
- **状态**：加载中、没有注释、没有匹配项、加载失败（带 `Retry`）都有独立提示；页面几何未就绪时不会误报为“无注释”。

列表只包含当前页，没有跨页索引或全文搜索。

### 画布

- 注释框按类别着色：链接蓝、表单紫、标记黄、注释橙、图章青、其他灰；悬停时更亮，选中为金色描边。
- 选中注释与选中对象互斥：点击注释会清除对象选中与悬停，点击对象会清除注释选中，空白处点击两者都清除。
- 注释命中测试优先于对象命中测试；关闭 `Show boxes` 后注释框不绘制，也不再参与命中测试。
- 旋转页（`/Rotate` 90/180/270）不绘制注释框，只提供列表与 Inspector 详情，与对象叠加层的限制一致。

### Inspector

选中注释后，`Inspect` 标签页显示注释详情，而不是对象详情：

- **Annotation**：类别、subtype、页码、Rect、是否隐藏。
- **Content**：标题、内容、修改时间、颜色（含色块）与不透明度。
- **Link**：目标 URL 或内部页码；安全的外部链接提供 `Open link`，解析出的内部目标提供 `Go to page N`。
- **Form field**：字段名、字段类型、值、默认值、Flags（Read only / Required / Check box / Radio button / Push button / Multi-line / Combo box）与选项（`label (value)`）；签名字段附“Signature not verified”。
- **Clear selection**：清除当前注释选中。

`Filter` / `Results` / `Page` 标签页保持原有对象与页面功能不变。

## 链接策略

链接永远不会自动打开，也不会在加载或渲染页面时触发网络请求。

**外部链接**

- 只有 `http(s)` 绝对 URL 可以打开；`javascript:`、`data:`、`file:`、`mailto:`、空值与相对地址都是显示用。
- 使用 PDF.js 的 `url`（已清洗）作为点击目标，原始 `unsafeUrl` 只用于展示“这个链接原本指向哪里”。
- 用户必须显式点击 `Open link`。渲染层先校验一次，桌面端通过 IPC 调用主进程的 `shell.openExternal` 再校验一次；Web 端由 `window.open(url, '_blank', 'noopener,noreferrer')` 打开，同样只接受清洗后的 URL。
- 打开失败或目标不安全时，错误显示在 Inspector 内，不弹系统对话框，也不影响文档状态。

**内部链接**

- 字符串命名目标先经 `pdfDoc.getDestination(name)` 解析，数组目标直接取第一项，再用 `getPageIndex` 得到 1 起页码。
- 解析成功才显示 `Go to page N`，并使用与 Prev/Next 相同的受保护翻页导航 `usePageNavigation().navigate(page)`。
- 无法解析的目标显示 `No resolvable link target.`，不提供跳转。

## 表单只读

表单字段只以文本形式呈现：字段名、字段类型、当前值、默认值、Flags 与选项。实现中没有 `<input>`、没有表单元素、没有提交或写回路径，也不存在“重置”“应用”之类的动作。

- 多选/下拉字段的值可能是数组，显示时用 `, ` 连接。
- 选项统一显示为 `label (value)`，同时保留 export value 与 display value。
- 签名字段只作为 `Sig` 字段展示，并明确标注未验证。
- 表单值来自 PDF.js 读取，不会写回 PDF，也不会触发 AcroForm 事件或 JavaScript。

## 当前页范围

- 列表、画布框与选中都是页级状态；`usePageAnnotations` 在页码或文档变化时重新加载，并用请求守卫丢弃过期结果。
- 翻页会清除上一页的选中与悬停，避免出现“列表是第 2 页、详情还是第 1 页”的情况。
- 画布层只绘制 `page` 与当前页一致的注释数据；加载中的新页不会短暂显示旧页的框。
- 过滤条件与 `Show boxes` 会跨页保留，属于用户偏好，不属于页面数据。

## 非目标

以下能力不在本阶段范围内，代码中也没有对应入口：

- 注释的创建、编辑、删除、回复、图章、密文标注。
- 表单填写、重置、提交、导入 XFA 数据。
- 数字签名验证。
- 整档注释导出、`JSON`/`CSV` 导出集成、注释级 Diff、Audit 注释检查或 CLI/action 支持；导出、Diff 与审计仍只处理对象层。
- 使用 PDF.js 原生 `AnnotationLayer` 渲染控件外观；自定义列表与只读框才是唯一数据来源。
- 旋转页上的对象级注释框、滚动到目标坐标（内部链接只跳页）。

## 已知限制

- 仅当前页；没有整档注释索引、跨页搜索或批量导出。
- 旋转页只提供列表与详情，不绘制画布框，也不参与画布命中测试。
- CropBox 小于 MediaBox 时，注释框以 MediaBox 为基准，可能与 PDF.js 按 CropBox 渲染的内容整体偏移，与既有对象叠加层表现一致。
- 外部链接只支持 `http(s)`；其他协议只能查看原始目标字符串。
- 内部链接只跳转到解析出的页码，不恢复滚动位置或缩放。
- 注释与表单不参与导出、Diff、Audit 与 CLI，Pipeline 中如需这些信息需要另行读取 PDF。
- 加密或权限受限的 PDF 是否能读到注释取决于 PDF.js 的解密结果；读不到时列表为空并显示空状态。

## 验证

自动化测试：

```bash
npx vitest run \
  src/renderer/services/__tests__/annotations.test.ts \
  src/renderer/services/__tests__/annotation-view.test.ts \
  src/renderer/store/__tests__/annotation-store.test.ts \
  src/renderer/hooks/__tests__/usePageAnnotations.test.ts \
  src/renderer/components/LeftPanel/AnnotationsTab.test.ts \
  src/renderer/components/PdfViewport/AnnotationOverlay.test.ts \
  src/renderer/components/PdfViewport/OverlayCanvasAnnotations.test.ts \
  src/renderer/components/InspectorPanel/AnnotationDetails.test.ts
```

演示文档由 `scripts/generate-web-samples.py` 生成，输出 `web-samples/annotations.pdf`（已 gitignore，可用 `.venv/bin/python scripts/generate-web-samples.py` 重建）。第 1 页包含外部链接、指向第 2 页的内部链接、一条 Text 注释、一条 Highlight、`full_name` 文本字段（值为 Alice）、必填复选框 `agree`（选中）与组合框 `plan`；第 2 页是内部链接与 `page2` 书签目标。生成过程固定元数据、注释日期与 URL，`invariant=1`，两次运行输出逐字节一致；PDF.js `getAnnotations` 能看到 Link / Widget / Text / Highlight 四类注释。

手工检查（Web 构建）：

1. 打开 `/samples/annotations.pdf`，切到 `Annots`，确认汇总为 `7 annotations · 2 links · 3 form fields`。
2. 选中 `plan` 行：Inspector 显示 `Choice (Ch)`、值 `Pro`、`Combo box` 与三个选项，画布框与页面上的组合框对齐。
3. 选中外部链接：`Open link` 可用，目标为 `https://example.com/pdf-inspector`；选中内部链接：`Go to page 2` 跳转到第 2 页。
4. 在 1280 / 1440 / 1600 宽度与 200px 左侧面板下检查：无横向溢出、`Annots` 标签可用且有 tooltip、无控制台或页面错误。
