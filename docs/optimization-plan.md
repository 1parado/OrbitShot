# OrbitShot 批量发送 / 多模型对比 — 优化方案

> 状态：评审中（本文档只做分析，不含代码改动）
> 范围：`feature/multi-model-compare` 分支当前工作区（含未提交改动）
> 日期：2026-10-10

---

## 1. 结论先行

批量发送成功率低的根因**不是单点 bug，而是链路上每一环都在漏**。按影响从大到小排列：

| # | 问题 | 影响 | 预估收益 | 难度 |
|---|------|------|---------|------|
| P0-1 | **批量发送是串行的**，N 站依次开页注入，最慢站 30s+，前面的站可能被 SW 休眠/用户操作打断 | 全批次失败率随站数放大 | 高 | 低 |
| P0-2 | **截图流程与对比任务无并发预算**，8+ 标签页同时开/刷新时 Chrome 节流 SW | 全批次超时 | 高 | 中 |
| P0-3 | `RESPONSE_SNAPSHOT` 每 500ms **全量写入 chrome.storage**，长回答把 storage 写成瓶颈，SW 频繁写盘增加被杀概率 | 稳定性 | 高 | 低 |
| P0-4 | **提交失败无自动重试**：CS_NOT_READY / COMPOSER_NOT_FOUND / FILL_VERIFY_FAILED 直接落 failed，等用户手点 | 单站成功率 | 高 | 低 |
| P0-5 | 通用启发式 `readAnswerGeneric` 每次全页 `querySelectorAll` + 逐元素 textContent（**O(页面节点数) × 每 500ms**），大页面上明显卡顿 | 性能 | 高 | 中 |
| P1-6 | 完成判定「宁多等不截断」+ 120s 全局超时互斥：长回答超时截断，短回答白等 6s | 成功率/体验 | 中 | 中 |
| P1-7 | 截图批次完成后 `screenshotBatches`/`panelOpenedFor` **永不清理**，长会话内存泄漏 | 稳定性 | 中 | 低 |
| P1-8 | 复用标签页策略太激进：直接在用户**当前打开的对话页**上提交，可能污染用户历史会话；且被复用页若正开着半输入的草稿会被覆盖 | 正确性 | 中 | 中 |
| P1-9 | `fillComposer` 验证用 `includes(text.slice(0,120))`，长 prompt 截断后误判；`execCommand('insertText')` 在部分站点已失效 | 单站成功率 | 中 | 低 |
| P1-10 | SW 重启后 `recoverOrphans` 把 `generating` 之外的任务标 failed，但**超时看门狗已随 SW 丢失**，generating 任务可能永久挂起 | 稳定性 | 中 | 中 |
| P2 | 其余：错误码不落地、历史批次只存 ID 不存内容、`waitTabComplete` 轮询写法等 | 可维护性 | 低 | 低 |

下面逐条展开：现象 → 根因（附代码位置）→ 建议方案。

---

## 2. P0：直接影响批量成功率的根因

### P0-1 批量发送是串行的，且「注入截图」和「对比任务」耦合在一条 30s+ 的长链上

**现象**：选 6 个平台批量发送，常常只有 2~3 个站出回答，越靠后的站失败率越高。

**根因链**（`src/content/index.ts:365-374` → `src/background/index.ts:108-154`）：

```ts
for (const s of sites) {
  await sendToAi(shadow, canvas, s, batch)   // ← 串行 await！
}
```

每一站 `sendToAi` 的耗时 = `waitTabComplete`（最多 20s）+ `injectAiImages`（找编辑器轮询最多 30s + 逐张粘贴探测 2.8s/张 + 最终验证最多 12s）。**6 站串行最坏 4 分钟**。期间：

- 起点页面的 content script 一直挂着 await，用户切走标签页/页面刷新即断（`chrome.runtime.sendMessage` 的响应丢失，`resp = null`，后续站全部跳过）；
- MV3 Service Worker 在无事件时约 30s 即可被回收，长串行链路中段 SW 一死，`handleSendToAi` 的 Promise 链全部蒸发，**后面几站根本不会发送**——用户看到的现象就是「批量发了一半没反应」；
- 即使 SW 活着，`COMPARE_BATCH_DONE` 也没发（还在循环里），面板迟迟不开，用户以为失败。

**建议**：

1. **注入阶段改并行**：`Promise.all(sites.map(s => sendToAi(...)))`（去 await）。各站本就互不依赖，Chrome 对并发 `scripting.executeScript` 无限制。这一条改动最小、收益最大。
2. **注入与提交解耦**：`handleSendToAi` 完成注入后立即返回，把 `noteCompareBatch` 挪到 SW 侧独立执行（现在是 `await` 在注入结果之后，见 `background/index.ts:147-149`），注入结果 toast 不必等提交链。
3. **SW 存活保障**：批量进行期间用 `chrome.runtime.getPlatformInfo` 心跳或 `chrome.alarms`（最小 30s 周期）拉住 SW；至少要保证 `sendResponse` 链不因 SW 回收而蒸发。MV3 下更稳的做法是**把「逐站注入」状态记进 storage**，SW 重启后能续跑剩余站点。

### P0-2 并发开页没有预算控制，浏览器节流反噬

**根因**：并行化后（或 dispatcher 路径 `dispatchBatch` 里 `runTask` 全并行，`dispatcher.ts:168-172`），一次开 6~12 个新标签页。Chrome 对后台标签页的 timer/网络有节流；`ensureAiTab` 新建的页（`tab-manager.ts:44` `active: false`）经常被 Chrome 延迟加载（discarded-like 状态），`waitTabComplete` 20s 软超时后 CS 还没起来 → `CS_NOT_READY`。

**建议**：

- 引入并发闸（concurrency limiter，同时最多 3~4 个站在 `opening_tab → waiting_cs` 阶段），提交完成进入 `generating` 后释放名额——生成阶段不需要预算，观察是纯被动的。
- `waitTabComplete` 超时后不要直接走，改为配合 `pingCompareCs` 的重试窗口（现在 ping 只有 ~5s，对被节流的页太短，建议 15s、间隔 500ms）。

### P0-3 RESPONSE_SNAPSHOT 全量写 storage 是性能与稳定的双重隐患

**根因**（`dispatcher.ts:52-68` + `compare-entry.ts:155-176`）：

- CS 侧每 500ms 发一次全量快照（短回答没事，长回答如 5k 字 = 每秒 10KB 消息 + 2 次 storage 写）。
- `patchTask` 每次 `saveBatch(batch)`——**整个 batch（含所有任务的完整 response）序列化写 chrome.storage.local**。4 站 × 3k 字回答 ≈ 每次 delta 全量重写 ~50KB，120s 生命周期内写上百次。
- chrome.storage 写入有配额与速率开销，也是 MV3 SW 常驻内存压力的来源；写盘期间 `broadcastSnapshot` 还要 postMessage 全量 batch 给面板。

**建议**：

1. **节流降频**：流式期间 storage 写入合并到 ≥2s 一次（快照推送可保持 500ms，只把「落盘」单独节流）。
2. **落盘瘦身**：流式期间 storage 只写 `{status, responseLength}` 这类元数据，完整 response **只留在内存 batch + 推送给面板**；任务终态（completed/failed/timeout）时才全量落盘一次。面板断线重连的场景用「向 SW 要内存快照」兜底（现在 `GET_BATCH_STATE` 已经读 storage，改成读内存 `running` 表即可）。
3. 面板侧 `broadcastSnapshot` 同理：response 前缀未变的 delta 可以只推 `tail`，面板本地拼接（可选优化，收益次之）。

### P0-4 提交链路失败零重试

**根因**：`runTask`（`dispatcher.ts:280-332`）与 `attachScreenshotTask`（`dispatcher.ts:181-255`）里任何一步抛错直接 `finalizeFailed`。而最常见错误恰是**瞬时性的**：

- `CS_NOT_READY`：页面刚导航完、SPA 还在 hydrate；
- `COMPOSER_NOT_FOUND`：15s 等不到输入区（慢站/GDPR 弹窗/登录浮层）；
- `FILL_VERIFY_FAILED`：execCommand 偶发失败；
- `SUBMIT_FAILED`：按钮点击时站点正在重排 DOM。

用户必须手动点卡片上的重试按钮，批量场景下体验割裂。

**建议**：引入**分类自动重试**——`opening_tab/waiting_cs/submitting` 阶段的错误自动重试 1~2 次（指数退避 2s/5s），复用现有 attempt 机制（`retryRequest` 已实现 attempt+1，抽出来即可）。`generating` 阶段之后不再自动重试（避免重复发送消息）。失败分类表：

| 错误 | 自动重试 | 动作 |
|------|---------|------|
| CS_NOT_READY | ✅ ×2 | 重新 ensureContentScript |
| COMPOSER_NOT_FOUND | ✅ ×1 | 换 probe 候选 |
| FILL_VERIFY_FAILED | ✅ ×1 | 重填 |
| SUBMIT_FAILED / SUBMIT_NOT_TAKEN | ✅ ×1 | 重提 |
| TIMEOUT / GENERATION_FAILED | ❌ | 仅手动 |
| TAB_CLOSED / PAGE_UNLOAD | ❌ | 仅手动 |

### P0-5 通用启发式回答读取是 O(N) 全页扫描，每 500ms 一次

**根因**（`compare-entry.ts:104-131`）：`readAnswerGeneric` 对 `main` 下所有 `div/section/article/li/p/span` 做循环，每个元素调用 `textContent`（强制 layout 无关但仍是全子树遍历）+ 子元素 textContent 再算一遍。一次扫描 ≈ 数万次节点访问；MutationObserver 高频触发 + 500ms 轮询兜底，**在长对话页面上每次都是全页扫**。智谱/Copilot/星火等无 answer 探针的平台全走这条路径，页面越聊越长越卡。

另外 `readAnswerProbed` 也有一个放大器：`nodes[nodes.length - 1]` 每次 `querySelectorAll` 全列表，只为取最后一个。

**建议**：

1. **记录上次命中的元素**：`readAnswerGeneric` 先检查上次 best 元素是否仍在 DOM 且文本在增长（流式回答通常是同一容器），命中则直接序列化它；失效才重新全扫。把 O(N×每500ms) 降为 O(1) 常态 + 偶发 O(N)。
2. `readAnswerProbed` 的 `:last-of-type` 类探针改成 `querySelector(sel + ':last-of-type')` 之类单元素查询，或至少 `document.querySelectorAll(sel)` 后只取尾元素（现状已是，但选择器本身如 `[data-message-author-role="assistant"]` 每次返回全历史列表——列表越长开销越大；可用 `findLast` 思路或 `:nth-last-of-type` 优化）。
3. MutationObserver 回调里 `check()` 已经同步执行重扫描，建议 observer 只置脏标记，实际扫描统一由 500ms 节流器执行（现状是 observer 触发 + 轮询双通道各自全扫，开销 ×2）。

---

## 3. P1：正确性与体验

### P1-6 完成判定与超时策略互斥，两头受损

**现状**：完成判定「宁多等不截断」（A 通道需生成标志消失 + 稳定 800ms→3000ms；B 通道需 6s 观测 + 3~6s 稳定，`compare-entry.ts:186-229`），而任务级看门狗是**固定 120s**（`compare-types.ts:179`）。结果：

- DeepSeek R1 / o 系列长推理 + 长回答 > 120s → **TIMEOUT，前面 2 分钟白等**，正文已经在面板上流出来却标成失败（`handleTimeout` 直接置 timeout，不保留已收文本——`dispatcher.ts:334-353`）；
- 「是。」「3.14」这类短回答要白等 6~9s 才标完成。

**建议**：

1. 超时语义改为「**距最后增量 N 秒无更新**」的 idle 超时（如 45s），而非任务总时长；任务总时长上限放宽到 300s。流式正常推进的任务永不误杀。
2. `handleTimeout` 时**保留已收到的 response**（现在只置状态），状态改为 `completed` + 标注 `truncated: true`，或者新增 `partial` 状态——已有 80% 内容的卡片标红「失败」是最差的体验。
3. 短回答通道：`maxLen < MIN_GROWTH` 且出现过生成标志缺失时，稳定 3s 即可（现在 6s）。

### P1-7 screenshotBatches / panelOpenedFor 永不清理

**根因**（`dispatcher.ts:208-210, 258-262`）：两个内存 Map/Set 只增不减。SW 通常活得短，泄漏有限，但批量重度使用 + SW 被消息持续拉活时（恰好 P0-3 让 SW 一直有事做），会累积。另外 `finishScreenshotBatch` 只广播不清理，批次完成事件（P0-1 修复后）可能早于最后一个任务落定，此时清理会导致 `attachScreenshotTask` 查不到 batch。

**建议**：任务全部落定时（`maybeArchive` 扩展为同时处理 screenshot 批次）删除对应 Map/Set 条目；或 Map 值带 `createdAt`，定期（每次 dispatch 时顺手）清理 >10 分钟的。

### P1-8 复用标签页可能污染用户会话

**根因**：

- 截图路径 `handleSendToAi` 复用同源 tab 并 `active: true`（`background/index.ts:125-135`）；compare 路径 `ensureAiTab` 复用但不激活。两者都会在**用户现有的对话历史页**上继续追加提问——对「我正在和 ChatGPT 聊别的事」的用户是侵入性的；对需要干净上下文的多模型对比，**旧会话上下文还会影响回答质量**（同一对话继续问，模型带着前文）。
- 复用页若输入框有用户未发送草稿，`fillComposer` 直接覆盖（`base-adapter.ts:70-104`），**用户草稿丢失**。

**建议**：

1. 对比任务优先开 `平台 URL + ?orbitshot=new`（或直接 `chatgpt.com/?model=...` 类新会话入口），带标记参数开新会话；复用仅作 fallback。
2. 填充前检测输入区非空且内容 ≠ 本次 prompt → 先存草稿到 sessionStorage 汇报面板（至少 console 告知），再覆盖。

### P1-9 fillComposer 验证与注入路径的边界问题

**根因**（`base-adapter.ts:70-104`）：

- 验证逻辑 `cur.replace(/\s+/g,'').includes(text.replace(/\s+/g,'').slice(0,120))`：text ≤ 120 时等价全文匹配没问题；但用 `includes` 而非 `startsWith`，若输入区已有其他文本（复用页草稿），**可能误判成功**。
- `execCommand('insertText')` 在 Chrome 已标记过时，部分站点的自定义编辑器（Gemini Quill 某些版本、豆包新版）不生效，回退的 paste 合成事件又只对监听 paste 的编辑器有效。
- 无 `beforeinput`/`input` 事件重试路径。

**建议**：验证改为「前缀匹配 + 长度匹配」双条件；插入失败时补一条 `beforeinput` 路径；仍失败则报 `FILL_VERIFY_FAILED`（配 P0-4 自动重试）。

### P1-10 SW 重启后 generating 任务看门狗丢失

**根因**（`dispatcher.ts:542-562`）：`recoverOrphans` 把 `generating` 任务留在原状「等待下一事件续上」，但**超时 timer 已随旧 SW 死亡**。若站点停止流式（生成结束但 CS 判定未达标 / 网络断），任务永久停在 generating，面板永远转圈。

**建议**：`recoverOrphans` 时给 surviving 的 generating 任务**重新挂 idle 超时**（P1-6 改造后即「距上次更新 45s」），SW 侧恢复 timer；同时 `patchTask` 里 `startedAt` 有值时可推算已耗时长，直接补偿进新 timer。

---

## 4. P2：次要问题（顺手修）

1. **错误码未翻译就展示**：`errText`（`ModelResponseCard.tsx:228-242`）缺 `SUBMIT_FAILED`、`CS_NOT_READY` 已有但 `create tab failed`、`BAD_PAYLOAD`、`PLATFORM_REMOVED` 部分缺失，用户会看到裸英文码。补全映射 + 兜底文案。
2. **历史批次只存 batchId**（`archiveBatch`，`dispatcher.ts:40-46`）：面板没有「查看历史」功能，这个 history 列表目前没人消费；要么实现历史回看，要么删掉省一次 storage 写。
3. **`waitTabComplete` 两份实现**（`background/index.ts:90-106` 与 `tab-manager.ts:50-65`），行为略有差异（TAB_CLOSED 一个 throw 一个吞）。统一到 tab-manager。
4. **`compareAiIdForUrl` 每站 `loadSettings`**（`background/index.ts:161-177`）：批量 N 站读 N 次 storage；P0-1 并行化后建议批量开头读一次传递。
5. **`getPlatforms` 5s 缓存但 settings 变化不失效**（`dispatcher.ts:123-131`）：用户改了 AI 列表后 5s 内 dispatch 会用旧表。改用 `chrome.storage.onChanged` 失效。
6. **`dispatchBatch` 从面板发出但 UI 无此入口**：`CompareApp.tsx` 只有结果展示，`dispatchBatch` API 存在而面板无输入框。要么加「纯文本对比」入口（顺手成为调试利器），要么移除。
7. **`DEFAULT_TASK_TIMEOUT_MS = 120s` 对推理模型太短**：见 P1-6，建议默认 300s + idle 超时。
8. **构建无 lint/test 脚本**（`package.json`）：只有 `tsc --noEmit`。建议加 eslint（至少 no-floating-promises）——`runTask().catch` 这类边界现在靠手写。

---

## 5. 建议实施顺序

```
第一批（成功率速效，1~2 天）：
  P0-1 串行→并行 + SW 存活保障
  P0-4 自动重试（复用 attempt 机制）
  P1-6 timeout 保留已收文本 + idle 超时
  P2-1 错误码翻译补全
  → 预期效果：批量成功率从「过半失败」提升到大多数站稳定出结果

第二批（稳定性，2~3 天）：
  P0-3 storage 写节流 + 内存快照
  P0-2 并发闸（3~4 个）
  P1-7 内存表清理
  P1-10 recoverOrphans 重挂超时
  → 预期效果：长回答不再拖垮 SW，挂起任务可自愈

第三批（性能与打磨）：
  P0-5 启发式扫描缓存
  P1-8 新会话策略 + 草稿保护
  P1-9 fillComposer 验证强化
  P2 其余
```

## 6. 验证方案（优化后如何度量）

1. **成功率统计**：batch 落定时对 `tasks[].status` 做计数，面板顶部显示「本批 5/6 成功」；连续 10 批记录到 console 表格，作为回归基线。
2. **脚本化冒烟**：`npm run build` 后加载 dist，选 4 平台（ChatGPT/Claude/DeepSeek/Kimi）各发 3 批，记录每站状态分布。
3. **性能对照**：长对话页（>50 轮）开启对比任务，Performance 面板对比 `readAnswerGeneric` 修复前后的自耗时。
4. **SW 存活**：批量期间 `chrome://serviceworker-internals` 观察 SW 是否中途被杀；被杀后批次能否续跑。
