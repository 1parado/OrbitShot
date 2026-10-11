# PRD：截图公式识别（Formula → LaTeX）

| | |
|---|---|
| 产品 | OrbitShot — 截图 · 标注 · AI 路由 |
| 功能 | 标注编辑器内新增「公式识别」工具：框选公式区域，本地推理转 LaTeX，可复制 |
| 版本目标 | v0.4.0 |
| 状态 | 待评审 |
| 参考实现 | Snow Shot（github.com/mg-chao/snow-apps）的 LaTeX 识别链路：专用模型/视觉模型双路径、输出校验（`completeLatexSource`）、本地公式预览（MicroTeX） |

---

## 1. 背景与问题

OrbitShot 目前的核心链路是「截图 → 标注 → 环形菜单 → 发送到网页版 AI」。用户在遇到数学公式时（论文、课件、网页中的公式图片），当前只有一条路：把截图丢给 AI 让它转 LaTeX。这带来三个问题：

1. **多一步来回**：截图 → 打开 AI → 等待回答 → 手动摘出 LaTeX，链路长；
2. **结果不可信**：大模型可能"顺手"化简、改写甚至解题，得到的不是"忠实转录"；
3. **隐私顾虑**：包含学术内容的截图被上传到第三方。

本项目在截图工具内部提供**一键、本地、免费**的公式 → LaTeX 转换，把"识别"这一步从 AI 对话中剥离出来，用户拿到纯 LaTeX 后再去 AI 做后续处理（或直接粘贴进 Markdown/Word/笔记软件）。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量方式 |
|---|---|---|
| G1 | 从框选到拿到可复制 LaTeX ≤ 5 秒（模型已就绪时） | 本地计时埋点 |
| G2 | 纯本地推理：识别过程零网络请求（模型首次下载除外） | 代码审查 + 网络面板验证 |
| G3 | 扩展安装包体积不因本功能显著增长（< 2MB） | 构建产物对比 |
| G4 | 用户对模型下载知情可控：默认不下载、进度可见、可删除 | 验收用例 A 组 |
| G5 | 常见印刷体公式（分数/上下标/根号/积分/求和/矩阵/方程组）识别可读率 ≥ 80%（主观评测集 30 题） | 内部评测 |

### 2.2 非目标（本版本不做）

- ❌ 手写公式识别（模型不支持，v2 考虑）
- ❌ 整页/多公式批量识别（单次一个区域）
- ❌ 通用文字 OCR（PP-OCR 文本识别是独立需求，另行立项）
- ❌ 云端识别路径（架构预留接口，本版本不实现，见 §8）
- ❌ 公式插入为标注对象（识别结果不污染截图）

## 3. 用户与场景

**目标用户**：学生、科研人员、技术写作者——需要把看到的公式搬进笔记/文档/LLM 对话的人。

**核心场景**：

- **S1 网页论文里的公式**：看到一条积分表达式，想贴进自己的笔记。以前：截图→开 AI→等它转→复制。现在：截图 → 点 ∑ → 框住公式 → 复制。
- **S2 课件 PDF/图片中的公式**：同上，但源内容不在网页里，而是粘贴到页面里的图片——同样适用（截的是屏幕显示内容）。
- **S3 给 AI 提问前先给公式**：想问 AI"这个式子怎么化简"，但 AI 网页输入框里手写 LaTeX 太慢。先识别拿到 LaTeX，粘贴过去。

## 4. 功能详述

### 4.1 入口：标注工具栏「∑ 公式识别」

**位置**：标注编辑器工具栏（箭头/矩形/椭圆/画笔/文字/高亮/模糊/橡皮擦之后，撤销/重做之前），与既有绘制工具同排同风格。

**交互**：

- 与现有绘制工具一致的状态机语义：
  - 点击 `∑` → 进入公式框选模式（按钮高亮，画布光标变十字线）；
  - 再次点击 `∑` 或按 Esc → 退出回选择/编辑模式；
  - 快捷键 `F`（与现有 V=选择、E=橡皮擦 命名风格一致）。
- 进入模式时页面顶部显示提示条：「拖拽框选要识别的公式区域 · Esc 取消」（复用 `.os-hint` 样式）。
- 工具 tooltip（三语）：「公式识别：框选公式区域，本地转为 LaTeX 并复制（再次点击退出）」。

### 4.2 框选与裁剪

- 在截图画布上拖拽出矩形区域，手势与画矩形完全一致；拖拽过程中显示半透明高亮遮罩 + 尺寸角标（复用选择器视觉）。
- 松开鼠标后：
  - 区域宽或高 < 24 设备像素 → toast 提示「框选区域太小，请框住完整公式」，不发起识别，留在框选模式；
  - 否则从 `base`（干净底图，非标注合成图）裁剪该区域（含 4px 外扩 padding，保证公式边缘不被裁掉），以 PNG dataUrl 通过消息发给后台。
- 框选可连续进行：识别结果浮层关闭后自动回到框选模式，方便逐个识别多个公式。Esc 退出。

### 4.3 识别管线（后台 offscreen document）

#### 4.3.1 架构与职责划分

```
annotator.ts (content script)
  │ sendMessage { type: 'FORMULA_OCR', dataUrl, requestId }
  ▼
background/index.ts (Service Worker)
  │  纯路由：不跑推理、不解码图片（SW 无 DOM）
  │  ├─ ensureOffscreen() —— 按 chrome.offscreen API 创建推理文档（单例）
  │  └─ 转发消息，等待 offscreen 响应，透传进度事件
  ▼
background/formula-ocr-offscreen.ts (offscreen document，有 DOM)
  ├─ ModelStore：模型下载 / IndexedDB 缓存 / 读取 / 删除
  ├─ Preprocess：解码 → 灰度 → 尺寸对齐 → 归一化 → tensor
  ├─ Inference：onnxruntime-web 推理（encoder + 自回归 decoder）
  └─ Postprocess：token → LaTeX 字符串 → 校验清洗
```

#### 4.3.2 模型选择

采用 **LaTeX-OCR（pix2tex）架构的 ONNX 移植版**：图像 encoder（ViT）+ 自回归 transformer decoder，直接输出 LaTeX token 序列。这是目前唯一在浏览器端"图片直接出 LaTeX"的成熟开源方案（RapidLaTeXOCR 与其同源）。

- **不选 PP-OCRv4**：它输出纯文本，无法表达分数/矩阵等二维结构，不满足需求（此前讨论已排除）。
- **int8 量化版本**，总下载量控制在 **~40MB**（fp32 版本 ~120MB 不采用）。
- 模型文件清单：
  | 文件 | 用途 | 预计大小 |
  |---|---|---|
  | `encoder_model.onnx`（int8） | 图像编码 | ~18MB |
  | `decoder_model.onnx`（int8） | LaTeX 自回归解码 | ~16MB |
  | `tokenizer.json` | token ↔ LaTeX 映射 | ~2MB |
  | onnxruntime-web WASM 运行时 | 推理引擎 | ~8MB（wasm + js） |
- 下载源默认 jsDelivr CDN（备选 GitHub Release），URL 常量集中在一个配置文件中，设置页可展示不可编辑（v0.4）。
- 每个文件下载完成后记录 SHA-256 校验（随清单文件下发），防止 CDN 篡改/截断。

#### 4.3.3 模型生命周期（用户可控，默认不下载）⭐

本节为 PRD 核心诉求，状态机如下：

```
                    ┌────────────────────────────────────────────┐
                    │  state: not-downloaded（默认，装机即此状态）   │
                    └────────────────────────────────────────────┘
                        │ 用户点「下载模型」            ▲
                        ▼                            │ 用户点「删除模型」
                    ┌────────────┐    下载失败可重试   │
                    │ downloading │──────────────────┘
                    │ (可取消)     │
                    └─────┬──────┘
                          │ 全部文件完成 + SHA 校验通过
                          ▼
                    ┌────────────────┐
                    │ ready（离线可用）│←──────── 任何识别请求直接推理
                    └────────────────┘
```

**规则：**

| 规则 | 说明 |
|---|---|
| R1 默认不下载 | 安装后模型不存在。设置页与首次识别浮层均显示"未下载"状态与模型大小 |
| R2 显式触发 | 仅在两处可发起下载：① 首次识别时浮层内的「下载模型」按钮；② 设置页「公式识别」卡片的「下载模型」按钮。**绝不在无提示情况下自动下载** |
| R3 进度可见 | 下载中浮层/设置页显示：整体百分比（按字节加权）、当前文件名、已下载/总 MB 数；进度事件经 SW 广播到所有打开的 UI |
| R4 可取消 | 下载中可点「取消」，中止后回到 not-downloaded，已下载的部分字节丢弃 |
| R5 断点容错 | 单文件下载失败可「重试」，仅重下未完成的文件；SHA 校验失败视为失败并重下该文件 |
| R6 一致性锁 | 下载与删除互斥；识别请求在 downloading 期间到达 → 提示"模型正在下载"；ready 前不发推理 |
| R7 删除可控 | 设置页显示当前占用（如「已用 42MB 本地空间」）+「删除模型」按钮，二次确认后清空 IndexedDB 中模型数据并回到 not-downloaded |
| R8 存储位置 | 模型二进制存 IndexedDB（`orbitshot` 库新建 `models` store，与截图暂存区同库不同 store），不占 chrome.storage 配额 |
| R9 运行时文件 | onnxruntime-web 的 .wasm 同样不打包：首用时与模型一起下载缓存，运行时以 Blob URL 提供（MV3 禁止远程加载 wasm，但允许本地 blob） |

#### 4.3.4 推理流程（ready 状态）

1. **预处理**（对齐 pix2tex 输入规范，参考 Snow Shot `prepareLatexImage` 的 max_width=672 / max_height=192 约束）：
   - PNG 解码 → 灰度化；
   - 等比缩放至模型输入范围（长边 ≤ 672、短边按比例；过小区域放大到最小可识别尺寸）；
   - 归一化到 [0,1]，pad 到批处理尺寸，输出 Float32 tensor。
2. **Encoder**：单次前向，得到图像记忆序列。
3. **Decoder 自回归循环**：
   - 起始 token → 逐步喂入已生成序列 → 每步 argmax 取下一个 token；
   - 终止条件：EOS token，或达到长度上限（256 token）；
   - 每步 KV 缓存（如导出的 ONNX 支持）以控制延迟；不支持则整段重算（慢 ~2 倍，仍可接受）。
4. **后处理**：
   - token id 序列 → tokenizer 解码为 LaTeX 字符串；
   - 剥离 `$`/`$$`/`\(` `\)` 定界符与首尾空白；
   - **结构校验**（移植 Snow Shot `completeLatexSource` 思路，JS 实现）：`{}` 配平、`\begin{env}/\end{env}` 栈配平、`$` 定界配对、拒收 HTML/JSON/自然语言前言包装；
   - 校验失败不拦截展示，但在浮层标记「识别结果可能不完整，请对照预览检查源码」。
5. **性能预期**：WASM 单线程 2–6 秒；WebGPU（若可用）0.5–2 秒。运行时后端选择：`webgpu` 可用则优先，失败自动回落 `wasm`，对 UI 透明。

#### 4.3.5 并发与生命周期

- 同一时刻仅允许 1 个推理任务，后续请求排队（SW 侧 FIFO）；
- offscreen document 懒创建：首次「下载模型」或首次「识别」时创建；空闲 5 分钟且无排队任务时通过 `chrome.offscreen.closeDocument()` 关闭；
- SW 被浏览器回收时：下载中任务中断（回到可重试状态，规则 R5 兜底）；ready 状态不受影响（模型在 IndexedDB）。

### 4.4 结果浮层（content script）

**位置与形态**：锚定在用户框选区域的下方（空间不足时翻转到上方），宽度 min(420px, 视口-边距)，Shadow DOM 内渲染，风格与现有 toast/工具栏一致（白底圆角、浅描边、投影）。

**布局（自上而下）**：

```
┌─────────────────────────────────────┐
│ 公式识别                       ✕ 关闭 │
│ ─────────────────────────────────── │
│ 预览                                │
│ ┌─────────────────────────────────┐ │
│ │   [KaTeX 渲染的公式，白底]        │ │
│ └─────────────────────────────────┘ │
│ LaTeX 源码（可编辑）                  │
│ ┌─────────────────────────────────┐ │
│ │ \int_{0}^{\infty} e^{-x^2}dx    │ │  ← textarea，随输入实时重渲染预览
│ └─────────────────────────────────┘ │
│ ⚠ 识别结果可能不完整（仅校验失败时显示）│
│ ─────────────────────────────────── │
│ [ 📋 复制 LaTeX ]        图像仅在本机推理，不会上传 │
└─────────────────────────────────────┘
```

**交互细节：**

| 元素 | 行为 |
|---|---|
| KaTeX 预览 | 源码编辑防抖 150ms 后重渲染；KaTeX 渲染失败（语法错误）时预览区显示原样源码 + 灰色提示，不弹错误框 |
| 源码编辑 | textarea 支持选中/光标编辑；Esc 在 textarea 内不关闭浮层（先失焦），点空白处才关闭 |
| 复制按钮 | `navigator.clipboard.writeText(latex)`；成功后按钮短暂变为「✓ 已复制」，1.5s 恢复；浮层保持打开（用户可能继续微调再复制） |
| 关闭 | 点 ✕、点浮层外区域、或按 Esc（textarea 未聚焦时）→ 浮层关闭，回到框选模式（§4.2 的连续识别流） |
| 加载态 | 识别中：预览区显示 spinner + 「正在识别公式…（本地推理，无需联网）」，此态下复制/编辑禁用 |
| 失败态 | 显示错误信息 + 「重试」按钮（重新提交同一区域） |

**KaTeX 引入方式**：`katex.min.css + katex.min.js` 随扩展打包（合计 ~350KB，gzip 后 ~110KB，满足 G3 <2MB 预算）；css 内联进 Shadow DOM（KaTeX 字体文件经 `web_accessible_resources` 暴露，`@font-face` 使用 `chrome-extension://` 绝对地址）。

### 4.5 模型未下载时的引导流（首次体验路径）

用户首次点击 `∑` 并框选公式后，浮层进入「引导态」：

```
┌─────────────────────────────────────┐
│ 公式识别                              │
│                                     │
│ 首次使用需下载本地公式识别模型           │
│ （约 40MB，下载后离线可用，              │
│   之后无需再联网）                      │
│                                     │
│ 🔒 图像仅在本机推理，不会上传            │
│                                     │
│ [ ⬇ 下载模型 ]   [ 取消 ]             │
└─────────────────────────────────────┘
```

- 点击「下载模型」→ 进入下载态：按钮变为进度条（百分比 + 当前文件 + MB 数）+「取消」链接；
- 完成 → 短暂显示「✓ 模型已就绪」→ **自动继续执行本次识别**（用户不需要再框一次）；
- 失败 → 错误信息 + 「重试下载」；
- 「取消」→ 关闭浮层，回到框选模式。

### 4.6 设置页（Options）新增「公式识别」卡片

挂在「偏好设置」分组下（或独立一级分组，实现时按信息架构密度决定）：

```
公式识别
───────────────────────────────────────
本地公式识别模型        [ 未下载 | 下载中 63% | 已下载 ]
约 40MB · 下载后离线可用 · 识别在本机完成，图像不上传
[ 下载模型 / 取消 / 删除模型 ]
已用 42MB 本地空间（仅 ready 态显示）
```

- 状态徽章与操作按钮随 §4.3.3 状态机联动，与识别浮层的进度事件共享同一数据源；
- 「删除模型」需二次确认（文案见 i18n `formula.model.delete.confirm`）。

## 5. 信息架构与文案

新增 i18n key（zh-CN / zh-TW / en 三语，已拟定，见 §10 附表）：`formula.*` 命名空间，覆盖工具 tooltip、框选提示、浮层标题/按钮/状态、模型引导/下载/删除全流程文案。

原则：

- 下载相关文案必须明确「约 40MB」「下载后离线可用」两个事实；
- 隐私声明（「图像仅在本机推理，不会上传」）在引导态与结果态常驻；
- 错误文案给出下一步动作（重试/手动复制）。

## 6. 技术方案摘要

### 6.1 新增/改动文件

| 文件 | 变更 |
|---|---|
| `src/content/annotator.ts` | `Tool` 联合类型加 `'formula'`；TOOL_LIST 加 `∑` 项；框选手势复用 rect 分支（独立模式，不产生标注）；裁剪与消息发送；结果浮层挂载点 |
| `src/content/formula-panel.ts`（新） | 结果浮层组件：引导/下载/加载/结果/失败五态；KaTeX 渲染；复制 |
| `src/background/formula-ocr.ts`（新） | SW 侧编排：offscreen 生命周期、消息路由、请求队列、进度广播 |
| `src/background/formula-offscreen.html + .ts`（新） | offscreen 推理文档：ModelStore / Preprocess / Inference / Postprocess |
| `src/shared/formula-models.ts`（新） | 模型清单常量（URL、SHA-256、大小）、下载状态类型、消息协议类型 |
| `src/shared/settings.ts` | `Settings` 增加公式识别相关字段（§6.3） |
| `src/shared/dicts.ts` | `formula.*` 三语词条 |
| `src/content/content.css` | 浮层与框选高亮样式（`.os-formula-*`） |
| `manifest.config.ts` | permissions 增加 `'offscreen'`；web_accessible_resources 增加 KaTeX 字体 |
| `src/options/Options.tsx` | 「公式识别」卡片 |
| `vite.config.ts` | offscreen html 作为构建入口 |

### 6.2 消息协议（content ↔ SW ↔ offscreen）

```ts
// content → SW
{ type: 'FORMULA_OCR', requestId: string, dataUrl: string }
{ type: 'FORMULA_MODEL_STATE' }                     // 查询当前状态机
{ type: 'FORMULA_MODEL_DOWNLOAD' }                  // 触发下载（浮层/设置页共用）
{ type: 'FORMULA_MODEL_CANCEL' }                    // 取消下载
{ type: 'FORMULA_MODEL_DELETE' }                    // 删除已下载模型

// SW → offscreen
{ type: 'ORC_INIT' }                                // 加载模型 → 就绪
{ type: 'ORC_RECOGNIZE', requestId, dataUrl }
{ type: 'ORC_DOWNLOAD', } { type: 'ORC_CANCEL' } { type: 'ORC_DELETE' }

// 广播（SW → 所有扩展页/content，chrome.runtime.sendMessage 广播语义）
{ type: 'FORMULA_PROGRESS', stage: 'downloading'|'initializing'|'ready', percent, file, receivedBytes, totalBytes }
{ type: 'FORMULA_STATE', state: ModelState }
{ type: 'FORMULA_RESULT', requestId, ok, latex?, warning?, error? }
```

- `requestId`（content 生成的 uuid）用于多请求排队时结果回投匹配；
- content 侧浮层在识别期间监听 `FORMULA_PROGRESS` 更新下载进度。

### 6.3 设置字段

```ts
export interface Settings {
  // ...现有字段
  formulaModelDeletedOnce?: boolean  // 用户删除过模型：再次引导时文案改为「重新下载」
}
```

模型状态机（not-downloaded / downloading / ready）**不进 settings**，以 IndexedDB `models` store 的实际存在性 + SW 内存中的下载态为准（单一事实来源，避免状态漂移）。

### 6.4 IndexedDB 模型存储

```
DB: orbitshot（现有库，version 1 → 2）
  store: models
    key: 文件名（'encoder_model.onnx' | 'decoder_model.onnx' | 'tokenizer.json' | 'ort-wasm.wasm' ...）
    value: { data: ArrayBuffer, sha256: string, size: number, downloadedAt: number }
```

- 升级库版本时不得破坏现有 `shots` store；
- 「已用空间」= 各记录 size 求和；
- 删除 = 清空该 store。

### 6.5 依赖

| 依赖 | 引入方式 | 体积影响（包内） |
|---|---|---|
| katex | npm 依赖，随包打包 | ~350KB raw |
| onnxruntime-web | npm 依赖；**wasm 二进制不打包**，运行时经 Blob URL 提供 | 包内仅 ~1MB js |
| 模型文件 | 运行时下载，IndexedDB | 0 |

构建产物体积预算：新增 **< 2MB**（满足 G3）。

## 7. 验收标准

### A 组：模型生命周期（G4）

| 用例 | 步骤 | 期望 |
|---|---|---|
| A1 | 全新安装 → 设置页查看公式识别卡片 | 显示「未下载」+ 大小说明；无任何自动下载行为 |
| A2 | 首次截图 → ∑ → 框选公式 | 浮层显示引导态（下载按钮 + 大小 + 隐私说明），**不自动开始下载** |
| A3 | 点「下载模型」 | 进度条出现，百分比/文件名/MB 数实时更新 |
| A4 | 下载中点「取消」 | 回到「未下载」态，无残留；再点下载可重来 |
| A5 | 断网后点「下载模型」 | 失败提示 + 「重试下载」；恢复网络后重试成功 |
| A6 | 下载完成后识别 | 无网络（DevTools Offline）状态下推理正常 |
| A7 | 设置页删除模型 → 确认 | 「未下载」态；再次使用重新走 A2 引导 |
| A8 | 下载中关闭浏览器 → 重开 | 回到可重试态（或自动续传），不出现假 ready |
| A9 | 下载中发起识别 | 提示「模型正在下载」，不报错不崩溃 |

### B 组：核心识别流（G1/G2/G5）

| 用例 | 步骤 | 期望 |
|---|---|---|
| B1 | ready 后框选一条分数公式 | ≤5s 出结果；KaTeX 预览正确；源码可编辑 |
| B2 | 编辑源码 | 预览 150ms 防抖刷新；非法 LaTeX 时预览区灰显不崩 |
| B3 | 点复制 | 剪贴板为当前源码；按钮反馈「✓ 已复制」 |
| B4 | 识别后关闭浮层 | 回到框选模式，可继续框选下一个公式 |
| B5 | 框选区域 < 24px | toast 提示太小，不发起请求 |
| B6 | 推理期间再框选一个区域 | 排队执行，两个结果顺序弹出 |
| B7 | 框选非公式区域（普通文字/图片） | 返回空或乱码时给出「可能不完整」警告，浮层可编辑可复制，不闪退 |
| B8 | 识别全程抓包 | 除首次模型下载外零网络请求（G2） |

### C 组：回归

| 用例 | 期望 |
|---|---|
| C1 | 既有标注工具（箭头~橡皮擦）行为不变，∑ 不干扰其快捷键 |
| C2 | 暂存区/发送 AI/整页截图全流程回归通过 |
| C3 | 设置页其它卡片不受新卡片影响；三语切换完整 |
| C4 | 扩展包体积增量 < 2MB |

## 8. 架构预留（本版本不实现）

- **云端识别路径**：`formula-ocr.ts` 的引擎调度函数签名形如 `recognize(input, engine)`，engine 预留 `'local' | 'vision-llm'`；未来接入 OpenAI 兼容视觉接口（prompt 采用 Snow Shot `latexVisionPrompt` 的转录纪律 + 提示词注入防护条款），并在浮层显示「云端」徽章与隐私差异说明。
- **通用文字 OCR**：PP-OCRv4 det/rec 同样走 offscreen + ModelStore 管线，模型存储与下载进度组件直接复用。
- **识别历史**：offscreen 结果可顺带写入 IndexedDB 供后续「历史 LaTeX」面板使用。

## 9. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| pix2tex ONNX 移植版解码步进慢（WASM 自回归无 KV cache） | 高 | §4.3.4 优先 KV cache 导出；WebGPU 优先；单区域期望值放宽至 5s；评测不达标则换 RapidLaTeXOCR 轻量模型 |
| CDN 下载被墙/速度差 | 中 | 双源（jsDelivr + GitHub Release）顺序回退；URL 常量集中便于换源 |
| IndexedDB 大 blob 写入失败（配额/隐私模式） | 中 | 下载前 `navigator.storage.estimate()` 预检并提示；隐私模式明确告知不可用 |
| KaTeX 字体在 content script CSP 下加载失败 | 中 | 字体经 `web_accessible_resources` + `chrome-extension://` 绝对地址引用（MV3 允许）；构建时验证 |
| offscreen 文档与 SW 消息时序（SW 随时被杀） | 中 | 请求带 requestId 幂等；offscreen 收到未知 requestId 静默丢弃；关键状态以 IndexedDB 为准 |
| 识别质量不达 G5 | 中 | 结果浮层强制"可编辑 + 预览对照"兜底；警告机制（§4.3.4 步骤 4）保证用户感知 |

## 10. 附录 A：i18n 词条清单（zh-CN 为准，zh-TW/en 同步翻译）

| key | zh-CN |
|---|---|
| `formula.tool` | 公式识别：框选公式区域，本地转为 LaTeX 并复制（再次点击退出） |
| `formula.hint` | 拖拽框选要识别的公式区域 · Esc 取消 |
| `formula.region.small` | 框选区域太小，请框住完整公式 |
| `formula.title` | 公式识别 |
| `formula.recognizing` | 正在识别公式…（本地推理，无需联网） |
| `formula.preview` | 预览 |
| `formula.source` | LaTeX 源码（可编辑） |
| `formula.copy` | 复制 LaTeX |
| `formula.copied` | ✓ LaTeX 已复制到剪贴板 |
| `formula.copy.failed` | 复制失败，请手动选择源码复制 |
| `formula.close` | 关闭 |
| `formula.failed` | 识别失败：{msg} |
| `formula.suspect` | 识别结果可能不完整，请对照预览检查源码 |
| `formula.model.needed` | 首次使用需下载本地公式识别模型 |
| `formula.model.size` | （约 {n}MB，下载后离线可用，之后无需再联网） |
| `formula.model.download` | 下载模型 |
| `formula.model.downloading` | 正在下载 {n}%… |
| `formula.model.verifying` | 下载完成，正在初始化… |
| `formula.model.ready` | ✓ 模型已就绪 |
| `formula.model.failed` | 模型下载失败：{msg} |
| `formula.model.retry` | 重试下载 |
| `formula.model.delete` | 删除模型 |
| `formula.model.delete.confirm` | 确定删除已下载的公式识别模型？之后再次使用需重新下载。 |
| `formula.model.deleted` | ✓ 模型已删除 |
| `formula.model.usage` | 已用 {n}MB 本地空间 |
| `formula.privacy` | 图像仅在本机推理，不会上传 |

（三语词条已在 `src/shared/dicts.ts` 预置。）

## 11. 附录 B：与 Snow Shot 实现的对照

| Snow Shot 机制 | 本 PRD 对应 |
|---|---|
| `extractLatex`（专用模型，服务端 RapidLaTeXOCR） | 不复用其服务端；本地跑同源开源模型（pix2tex ONNX int8） |
| `extractLatexVision`（视觉 LLM + prompt） | §8 预留云端路径，prompt 直接借鉴其"转录纪律 + 注入防护"条款 |
| `prepareLatexImage`（672×192 预处理约束） | §4.3.4 预处理对齐同参数 |
| `completeLatexSource`（结构校验） | §4.3.4 后处理，JS 移植（配平 + 拒收包装器），语义从"拒绝"改为"警告" |
| MicroTeX 本地渲染预览 | 换 KaTeX（Web 生态标准件），交互保留"可编辑草稿 + 实时预览"设计 |
| 识别结果按模型缓存 + 可编辑草稿 | v0.4 单模型无缓存需求；"可编辑"保留 |

---

*评审通过后按 §6.1 文件清单实施；实施顺序：消息协议与 ModelStore → offscreen 推理管线 → content 浮层 → 设置页 → 验收用例跑测。*
