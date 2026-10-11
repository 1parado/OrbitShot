/**
 * Compare content 入口：在 AI 平台页面接收 SW 指令，提交问题并观察流式回答。
 *
 * 关键设计：
 * - 页面归属：SW 下发任务时带 aiId（从用户 AI 列表解析），本模块不再按 host
 *   硬编码映射——自定义 AI 也能走通用启发式。
 * - 只读取「本次请求的回答」：提交前记录当前回答数（N），生成后定位第 N+1 个
 *   回答节点，历史回答不混入。
 * - 通用启发式：无 answer 探针的平台，锁定「输入区最近的文本增长容器」——
 *   以提交后 DOM 中新增的、包含非空文本的大块容器为本次回答。
 * - MutationObserver + 500ms 节流批量上报；完成判定 = 曾生成中（或已有回答）
 *   + 无停止按钮 + 文本稳定 800ms（多信号，不只看一个）。
 * - 页面卸载时上报 CONTENT_UNAVAILABLE；attempt 校验过滤过期请求。
 */
import { waitForSelector, fillComposer, clickSubmit, isVisible, TextStability } from './base-adapter'
import { probeFor } from './registry'
import type { DomProbe } from './base-adapter'
import { serializeAnswer } from './dom-to-md'

interface ActiveSession {
  aiId: string
  batchId: string
  requestId: string
  attempt: number
  probe: DomProbe
  /** 本次提交的问题（用于剥离回答容器里的问题回显） */
  prompt: string
  observer: MutationObserver
  pollTimer: ReturnType<typeof setInterval> | null
  reportTimer: ReturnType<typeof setTimeout> | null
  reportedText: string
  /** 提交前各 answer 选择器命中的节点数：读取时只认 index ≥ 基线的新增节点 */
  baselineCounts: Record<string, number>
  /** 提交前最后一个命中节点的文本（in-place 更新型站点：节点数不变但内容变了） */
  baselineNodeText: string
  /** 提交前通用启发式全部合格候选的文本指纹（generic 路径排除旧回答/侧栏/免责） */
  preexistingFingerprints: string[]
  stopped: boolean
  /** 上次结构化快照（去重：三字段组合不变则不重复上报） */
  lastKey: string
}
let session: ActiveSession | null = null

const EMPTY_SNAPSHOT: { content: string; thinking: string; images: string[] } = {
  content: '',
  thinking: '',
  images: [],
}

function report(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg)
  } catch {
    // 扩展上下文失效（扩展被更新/关闭）：无法上报，本地清理
    disposeSession()
  }
}

function disposeSession(): void {
  if (!session) return
  session.observer.disconnect()
  if (session.pollTimer) clearInterval(session.pollTimer)
  if (session.reportTimer) clearTimeout(session.reportTimer)
  session = null
}

/**
 * 已知探针：本次回答 = 提交后新增的回答节点（index ≥ 各自选择器基线）。
 *
 * 三条铁律（旧会话页抓错内容的三个来源，缺一不可）：
 * 1. 不取「最后一个」——复用的旧会话页上一轮回答还在 DOM 里，新回答未渲染时
 *    会把旧回答误认成本次回答；只读基线之后的新增节点。
 * 2. 探针命中过（站点有回答结构）但还没有新增节点时，返回**空快照**而不是
 *    null——null 会让通用启发式兜底，后者在旧会话页会抓到思考文本、
 *    免责声明或历史回答（DeepSeek 显示思考文本、Gemini 只剩免责声明的根因）。
 * 3. 基线之后的所有新增节点**拼接**为本次回答——块级站点（DeepSeek 的
 *    ds-markdown--block 等 `:last-of-type` 探针，每回答命中一块）只取单个
 *    节点会漏掉前面所有段。
 * 另兼容 in-place 更新型站点：节点数没增但最后节点内容 ≠ 提交前基线文本，
 * 视为站点在原节点内渲染新回答。
 */
/**
 * 节点是否位于思考容器内：DeepSeek R1 等思考模型的思考文本在流式期间
 * 可能直接流经正文容器（完成后才折叠进 think 区）——凡 closest 命中
 * thinking 探针的节点一律视为思考，不当正文采信。
 */
function insideThinking(el: Element, thinkingSel?: string[]): boolean {
  if (!thinkingSel?.length) return false
  for (const sel of thinkingSel) {
    try {
      if (el.closest(sel)) return true
    } catch {
      /* 非法选择器忽略 */
    }
  }
  return false
}

function readAnswerProbed(s: ActiveSession): { content: string; thinking: string; images: string[] } | null {
  for (const sel of s.probe.answer ?? []) {
    const nodes = document.querySelectorAll(sel)
    if (!nodes.length) continue // 该选择器未命中（站点可能是另一布局），尝试下一个
    const baseline = s.baselineCounts[sel] ?? 0
    if (nodes.length > baseline) {
      const parts: string[] = []
      const images: string[] = []
      let thinking = ''
      for (let i = baseline; i < nodes.length; i++) {
        const node = nodes[i] as HTMLElement
        // 思考容器内的节点（含流式期间思考流经正文容器的形态）不当正文
        if (insideThinking(node, s.probe.thinking)) continue
        const r = serializeAnswer(node, s.probe.thinking ?? [])
        // 只收正文：纯思考块/骨架节点剥离后 content 为空，跳过（DeepSeek R1
        // 的首个新增节点是思考容器，混入会把思考文本当成回答）
        if (r.content.trim()) parts.push(r.content)
        if (!thinking && r.thinking) thinking = r.thinking
        images.push(...r.images)
      }
      const content = parts.join('\n\n')
      return content || thinking
        ? { content, thinking, images: [...new Set(images)] }
        : { ...EMPTY_SNAPSHOT }
    }
    // 节点数没增：in-place 更新型站点（同节点重渲染）？比较最后节点文本与基线
    const last = nodes[nodes.length - 1] as HTMLElement
    const cur = (last.innerText ?? last.textContent ?? '').trim()
    if (cur && cur !== s.baselineNodeText && !insideThinking(last, s.probe.thinking)) {
      return serializeAnswer(last, s.probe.thinking ?? [])
    }
    // 探针命中但没有任何新内容：绝不兜底 generic（会抓旧内容），等新回答渲染
    return { ...EMPTY_SNAPSHOT }
  }
  return null // 所有 answer 选择器都没命中 → 站点无回答结构，generic 兜底
}

/**
 * 清洗抓取到的回答文本：
 * - 剥离问题回显（回答容器把用户问题一并包住时，开头相同前缀去掉）
 * - 去掉人类消息头（"你说：""XX 说："）与免责声明尾巴（textContent 连读场景）
 * - 保留 innerText 的块级换行；仅压缩多余空白
 */
const NOISE_PATTERNS = [
  /^[^：:\n]{1,20}说[：:]\s*/, // 「你说：」「ChatGPT 说：」「DeepSeek 说：」开头
  /^[A-Za-z ]{1,20} said:\s*/i,
  /(?:ChatGPT|AI|GLM|Kimi|豆包|文心)[^。·]{0,20}(?:可能会?出错|会犯错|生成[，,]?)\.?[^。]*。?$/, // 免责声明尾巴
  /(?:内容由?\s*AI\s*生成|查看对话|重新生成|复制|分享|点赞|点踩|举报)$/u, // 操作残留
  // 英文免责声明（Gemini 等的回答骨架先于正文渲染，整段只剩免责时剥空，
  // 防止骨架被当成完整回答提前判完成）
  /\n?\s*(?:Gemini is an AI|Gemini may display|This is an AI|AI-generated content|Responses? (?:are|may be))[^\n]*(?:mistakes|inaccurate|wrong|errors)[^\n]*$/i,
]

function cleanAnswerText(raw: string, prompt?: string): string {
  let text = raw.replace(/\u00a0/g, ' ')
  // ChatGPT 新版把附件标注为「用户附件」，抓取容器常以它开头
  text = text.replace(/^\s*(?:用户附件|附件|Attachments?)\s*/i, '')
  // 问题回显剥离：回显通常在容器开头；若前面还有短前缀（如「你说：\n」），
  // 允许在开头 24 字符内定位问题文本并从那里截断（把前缀一并剥掉）。
  // 门槛 3 字符：完整 startsWith 匹配本身就很精确，过高的门槛会把短问题
  // 的回显留在正文里（Grok 卡片显示用户回显的根因）
  if (prompt) {
    const p = prompt.trim()
    if (p.length > 3) {
      if (text.startsWith(p)) {
        text = text.slice(p.length).replace(/^[\s\n：:]+/, '')
      } else {
        const idx = text.indexOf(p)
        if (idx > 0 && idx <= 24) text = text.slice(idx).replace(/^/, '')
      }
    }
  }
  text = text.replace(NOISE_PATTERNS[0], '').replace(NOISE_PATTERNS[1], '')
  for (let i = 2; i < NOISE_PATTERNS.length; i++) {
    text = text.replace(NOISE_PATTERNS[i], '')
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 收集提交前主内容区所有「叶子性」合格候选的文本指纹（前 100 字符）。
 * 通用启发式读取时据此排除旧回答/侧栏推荐/免责声明——旧会话页有多个
 * 历史候选，只排除"最大的那一个"防不住，必须全体排除。
 */
function collectLeafFingerprints(composerSel?: string): string[] {
  const main = document.querySelector('main') || document.body
  const composer = composerSel ? document.querySelector(composerSel) : null
  const fingerprints: string[] = []
  for (const el of main.querySelectorAll('div, section, article, li, p, span')) {
    if (composer && (el === composer || composer.contains(el) || el.contains(composer))) continue
    const text = (el.textContent ?? '').trim()
    if (text.length < 20) continue
    const childTextLen = Array.from(el.children).reduce(
      (n, c) => n + (c.textContent ?? '').length,
      0
    )
    if (text.length - childTextLen > 20) continue
    if (el.querySelector('[contenteditable="true"], textarea')) continue
    fingerprints.push(text.slice(0, 100))
  }
  return fingerprints
}

/**
 * 通用启发式回答读取（无 answer 探针 / 探针失效）：
 * 在主内容区找「文本量最大的最后渲染容器」——对话类站点流式回答通常是
 * 最近插入的大文本块。以 contenteditable 输入区的祖先容器为界，避免读到输入框。
 * 同样走 DOM 序列化（表格/公式/代码可还原），仅定位逻辑是启发式的。
 * 防旧内容混入：排除提交时已存在的全部合格候选（按文本指纹）。
 */
function readAnswerGeneric(s: ActiveSession): { content: string; thinking: string; images: string[] } {
  const main = document.querySelector('main') || document.body
  // 排除输入区自身及其祖先
  const composer = s.probe.composer.length ? document.querySelector(s.probe.composer[0]) : null
  const stale = new Set(s.preexistingFingerprints)
  let best: { el: Element; len: number } | null = null
  const candidates = main.querySelectorAll(
    'div, section, article, li, p, span'
  )
  for (const el of candidates) {
    if (composer && (el === composer || composer.contains(el) || el.contains(composer))) continue
    // 思考容器内的块不是正文（DeepSeek R1 流式思考等）
    if (insideThinking(el, s.probe.thinking)) continue
    const text = (el.textContent ?? '').trim()
    if (text.length < 20) continue
    // 提交前已存在的候选（旧回答/侧栏/免责）不是本次回答
    if (stale.has(text.slice(0, 100))) continue
    // 只要「叶子性」容器（子元素不再包含更大的独立文本块）：取文本长度/子节点比高的
    const childTextLen = Array.from(el.children).reduce(
      (n, c) => n + (c.textContent ?? '').length,
      0
    )
    const own = text.length - childTextLen
    if (own > 20) continue // 文本几乎全在子节点 → 跳过，等更内层
    if (el.querySelector('[contenteditable="true"], textarea')) continue
    if (!best || text.length > best.len) best = { el, len: text.length }
  }
  if (!best) return { ...EMPTY_SNAPSHOT }
  const r = serializeAnswer(best.el as HTMLElement, s.probe.thinking ?? [])
  return { content: cleanAnswerText(r.content, s.prompt), thinking: r.thinking, images: r.images }
}

interface AnswerSnapshot {
  content: string
  thinking: string
  images: string[]
}

function readAnswer(s: ActiveSession): AnswerSnapshot {
  const probed = readAnswerProbed(s)
  if (probed !== null) {
    const cleaned = { ...probed, content: cleanAnswerText(probed.content, s.prompt) }
    // 思考期旁路：DeepSeek R1 等思考模型思考文本在独立容器里流式（正文
    // 容器长时间为空）——把思考文本作为 thinking 上报：SW 看门狗据此续期
    // （否则思考期 >45s 无增量会被误杀超时），面板也能实时显示思考过程
    if (!cleaned.content && !cleaned.thinking) {
      const think = readThinkingTail(s)
      if (think) cleaned.thinking = think
    }
    return cleaned
  }
  return readAnswerGeneric(s)
}

/** 思考期活动信号：抓思考容器（probe.thinking）当前最长的思考文本 */
function readThinkingTail(s: ActiveSession): string {
  let best = ''
  for (const sel of s.probe.thinking ?? []) {
    try {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim()
        if (t.length > best.length) best = t
      }
    } catch {
      /* 非法选择器忽略 */
    }
  }
  return best
}

/** 生成中检测：停止按钮可见（只需探针，不需要完整会话） */
function isGenerating(probe: DomProbe): boolean {
  for (const sel of probe.generating ?? []) {
    const el = document.querySelector(sel)
    if (el && isVisible(el)) return true
  }
  return false
}

/** 节流上报：500ms 内的 DOM 变化合并为一次 RESPONSE_SNAPSHOT（结构化三字段） */
function scheduleReport(s: ActiveSession): void {
  if (s.reportTimer) return
  s.reportTimer = setTimeout(() => {
    s.reportTimer = null
    if (s.stopped) return
    const r = readAnswer(s)
    // 去重：三字段组合不变则不重复上报
    const key = `${r.content.length}|${r.content.slice(-40)}|${r.thinking.length}|${r.images.length}`
    if ((r.content || r.thinking) && key !== s.lastKey) {
      s.lastKey = key
      report({
        type: 'RESPONSE_SNAPSHOT',
        batchId: s.batchId,
        requestId: s.requestId,
        aiId: s.aiId,
        attempt: s.attempt,
        timestamp: Date.now(),
        payload: { content: r.content, thinking: r.thinking, images: r.images, text: r.content },
      })
    }
  }, 500)
}

/**
 * 监听循环。完成判定（多信号，参考主流开源对话抓取实现）：
 *  A. 确认通道：站点探针给出「生成中」标志（停止按钮）时，标志消失 + 文本稳定 800ms。
 *  B. 兜底通道：探针完全没匹配到生成标志（DeepSeek 等）→ 需满足全部条件才判完成：
 *     文本稳定 STABLE_DONE_MS 且观测期足够长，且文本经历过实质性增长（相对自身
 *     峰值有增量，防止模型推理停顿/慢渲染中途被截断）。短回答（< MIN_GROWTH）
 *     只要求稳定期足够长，避免"是。""3.14"这类回答永远等不到完成。
 */
const STABLE_DONE_MS = 3000
const MIN_BEFORE_DONE_MS = 6000
/** B 通道：认为经历过「实质增长」的最小文本增量 */
const MIN_GROWTH = 60
/** 短回答通道：稳定判定所需的更长稳定期（短回答缺乏增长信号，用时间换置信） */
const SHORT_STABLE_DONE_MS = 6000
/**
 * 「真静默」判定：DOM 完全无变化 + 无正文无思考持续这么久，说明 AI 实际
 * 没有在回复（人机验证/排队失败/模型卡死/需登录）——如实报 NO_RESPONSE
 * 失败，而不是靠超时猜。思考期/流式期 DOM 持续变化，永远不会触发。
 */
const SILENT_NO_RESPONSE_MS = 30_000

function startWatch(s: ActiveSession): void {
  // 稳定窗口 1.2s：流式渲染的停顿（0.5~1s 很常见）不应被当成「已稳定」——
  // 传 0 时一个轮询间隙就判稳定，是 Grok 长回答中途截断的根因
  const stability = new TextStability(1200)
  let sawGenerating = false
  let sawTextAt = 0
  let maxLen = 0
  let lastContent = ''
  // 最后一次页面 DOM 活动时刻（MutationObserver 每次触发刷新）：
  // 它是「站点还活着」的确定性信号，时间窗口只做兜底
  let lastDomActivity = Date.now()
  const startedAt = Date.now()

  const check = () => {
    if (s.stopped) return
    lastDomActivity = Date.now()
    const r = readAnswer(s)
    const text = r.content
    if (text || r.thinking) scheduleReport(s)
    if (text.length > maxLen) maxLen = text.length // 记录历史峰值
    const generating = isGenerating(s.probe)
    if (generating) {
      sawGenerating = true
      stability.feed('') // 生成中：重置稳定性时钟
      return
    }
    if (!text && !r.thinking) {
      // 真静默：页面 DOM 完全无变化且始终无正文/思考 → AI 实际没有回复
      // （人机验证/排队失败/需登录/模型卡死）。如实失败并提示用户，
      // 不伪装成超时，也不无限干等。
      if (Date.now() - lastDomActivity >= SILENT_NO_RESPONSE_MS && Date.now() - startedAt >= SILENT_NO_RESPONSE_MS) {
        s.stopped = true
        report({
          type: 'GENERATION_FAILED',
          batchId: s.batchId,
          requestId: s.requestId,
          aiId: s.aiId,
          attempt: s.attempt,
          timestamp: Date.now(),
          payload: { error: 'NO_RESPONSE' },
        })
        disposeSession()
      }
      return
    }
    if (!sawTextAt) sawTextAt = Date.now()
    const stable = stability.feed(text || r.thinking)
    if (!stable) return
    // A 通道：见过生成标志 → 标志消失 + 文本稳定 + 最小观测期 + **必须有正文**。
    // 正文门槛防「思考期停顿误判完成」（DeepSeek R1 思考可停顿数秒，此刻
    // 尚无正文，判完成会把思考当回答）。
    if (sawGenerating && text && Date.now() - startedAt >= MIN_BEFORE_DONE_MS) finishWith(r)
    // B 通道：从未见过生成标志 → 需要观测期 + 有正文 + 增长/稳定性双重置信
    else if (
      text.length > 0 &&
      Date.now() - sawTextAt >= (maxLen >= MIN_GROWTH ? STABLE_DONE_MS : SHORT_STABLE_DONE_MS) &&
      Date.now() - startedAt >= MIN_BEFORE_DONE_MS &&
      (maxLen >= MIN_GROWTH || (lastContent === text && Date.now() - sawTextAt >= SHORT_STABLE_DONE_MS))
    ) {
      finishWith(r)
    }
    lastContent = text
    // 其余情况：继续观察（宁多等不截断）
  }

  const finishWith = (r: AnswerSnapshot) => {
    s.stopped = true
    const done = {
      type: 'GENERATION_COMPLETED',
      batchId: s.batchId,
      requestId: s.requestId,
      aiId: s.aiId,
      attempt: s.attempt,
      timestamp: Date.now(),
      payload: { content: r.content, thinking: r.thinking, images: r.images, text: r.content },
    }
    disposeSession()
    report(done)
  }

  s.observer = new MutationObserver(() => check())
  s.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  // 兜底轮询：节点替换可能不触发 characterData
  s.pollTimer = setInterval(check, 500)
}

/** 提交问题并启动观察 */
/** 附件预览计数（与 injectFiles 同款选择器）：注入过附件的页面提交后应清零 */
function countAttachmentPreviews(): number {
  return document.querySelectorAll(
    'img[src^="blob:"], img[src^="data:"], [style*="blob:"], [style*="data:image"]'
  ).length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 等待附件上传完成：粘贴附件后站点要先把文件传完才允许发送
 * （Gemini/ChatGPT 上传中发送按钮 disabled）。以发送按钮的 disabled
 * 状态为信号轮询等待，找不到按钮或已可用则立即返回。
 */
async function waitAttachmentUpload(composer: HTMLElement, probe: DomProbe, timeoutMs: number): Promise<void> {
  if (!countAttachmentPreviews()) return // 无附件
  const findBtn = (): HTMLButtonElement | null => {
    for (const sel of [...(probe.submit ?? []), 'button[type="submit"]']) {
      for (const b of document.querySelectorAll<HTMLButtonElement>(sel)) {
        if (isVisible(b)) return b
      }
    }
    return null
  }
  const t0 = Date.now()
  for (;;) {
    const btn = findBtn()
    if (!btn) return
    if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return
    if (Date.now() - t0 > timeoutMs) return
    await sleep(350)
  }
}

async function submitPrompt(
  aiId: string,
  batchId: string,
  requestId: string,
  attempt: number,
  prompt: string
): Promise<{ ok: boolean; error?: string }> {
  if (session) {
    disposeSession() // 已有会话（连续对比）：先清理旧观察
  }
  const probe = probeFor(aiId)

  // 1. 等输入区
  const composer = await waitForSelector(probe.composer, 15_000)
  if (!composer) return { ok: false, error: 'COMPOSER_NOT_FOUND' }

  // 2. 记录基线：本次回答 = 提交后新增的回答节点（按 answer 选择器分别计数）；
  //    同时记录最后命中节点的文本（in-place 更新检测）与全部候选指纹（generic 排除）
  const baselineCounts: Record<string, number> = {}
  let baselineNodeText = ''
  for (const sel of probe.answer ?? []) {
    const nodes = document.querySelectorAll(sel)
    baselineCounts[sel] = nodes.length
    if (!baselineNodeText && nodes.length) {
      const last = nodes[nodes.length - 1] as HTMLElement
      baselineNodeText = (last.innerText ?? last.textContent ?? '').trim()
    }
  }
  const preexistingFingerprints = collectLeafFingerprints(probe.composer[0])
  // 附件基线：截图/文件注入流程先于本函数，粘贴过的附件预览此刻还在输入区，
  // 提交成功后必须随消息发出（清零），残留 = 消息没带图（Gemini 常见）
  const attachmentsBefore = countAttachmentPreviews()

  // 3. 填充 + 验证
  const filled = await fillComposer(composer, prompt)
  if (!filled) return { ok: false, error: 'FILL_VERIFY_FAILED' }

  // 4. 等附件上传完成再提交（发送按钮从 disabled 恢复；最多 12s），然后提交
  await waitAttachmentUpload(composer, probe, 12_000)
  await clickSubmit(composer, probe.submit)
  await sleep(600)

  // 5. 验证提交生效（a/b/c 任一即可，另有 d 附件残留检查）：
  //    a) 输入区已基本清空（提交后站点清空输入是通用行为）
  //    b) 出现生成中标志（停止按钮）
  //    c) 已出现新回答节点（极快站点）
  //    d) 附件预览已随消息发出（提交前 >0 时应清零）——不清零说明消息
  //       发出时没带图（上传未完成就被发送），等上传完成补一次提交
  const verify = () => {
    const composerText =
      composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : (composer.textContent ?? '')
    const firstSel = probe.answer?.[0]
    const newCount = firstSel ? document.querySelectorAll(firstSel).length : 0
    const gen = isGenerating(probe)
    const composerCleared = composerText.trim().length < Math.max(8, prompt.length / 2)
    const attachmentsGone = !attachmentsBefore || countAttachmentPreviews() < attachmentsBefore
    return { composerCleared, gen, newCount, attachmentsGone }
  }

  let v = verify()
  // 附件残留：轮询最多 8s（上传完成后很多站自动把附件挂上待发状态）
  if (attachmentsBefore && !v.attachmentsGone) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await sleep(400)
      v = verify()
      if (v.attachmentsGone) break
    }
    // 仍残留：补一次提交（文本若已发出，这次只带附件；模型至少能收到图）
    if (!v.attachmentsGone) {
      await waitAttachmentUpload(composer, probe, 10_000)
      await clickSubmit(composer, probe.submit)
      await sleep(800)
      v = verify()
    }
  }
  if (!v.composerCleared && !v.gen) {
    // 仍不能断定失败：站点可能清空慢。放宽为「软失败」——照常启动观察，
    // 若真的没发送，观察期内不会有回答，最终由超时兜底。
    console.warn('[compare] submit unverified (composer not cleared, no generating signal)')
  }

  // 6. 启动观察
  session = {
    aiId,
    batchId,
    requestId,
    attempt,
    probe,
    prompt,
    observer: null as unknown as MutationObserver,
    pollTimer: null,
    reportTimer: null,
    reportedText: '',
    baselineCounts,
    baselineNodeText,
    preexistingFingerprints,
    stopped: false,
    lastKey: '',
  }
  report({ type: 'GENERATION_STARTED', batchId, requestId, aiId, attempt, timestamp: Date.now() })
  startWatch(session)
  return { ok: true }
}

// ---- 消息入口（与截图模块共用 runtime.onMessage）----

export function initCompareContent(): void {
  // 注入幂等守卫：重复注入（ensureContentScript PING 假阴性 → executeScript
  // 重注入）会注册双份监听器，SUBMIT_PROMPT 被处理两次 = 消息双重提交
  const w = window as unknown as { __orbitshotCompareInit?: boolean }
  if (w.__orbitshotCompareInit) return
  w.__orbitshotCompareInit = true

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'COMPARE_PING') {
      // 任何页面都响应：归属判断在 SW（aiId 由任务携带），本页只需就绪
      sendResponse({ ok: true })
      return
    }
    if (msg?.type === 'SUBMIT_PROMPT') {
      const { prompt, requestId, attempt, aiId } = msg.payload ?? {}
      const batchId = msg.batchId
      if (!prompt || !requestId || !batchId || !aiId) {
        sendResponse({ ok: false, error: 'BAD_PAYLOAD' })
        return
      }
      submitPrompt(String(aiId), batchId, requestId, attempt ?? 1, String(prompt))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }))
      return true // async
    }
    if (msg?.type === 'DETACH_OBSERVER') {
      if (session && session.requestId === msg.requestId) disposeSession()
      sendResponse({ ok: true })
      return
    }
  })

  // 页面刷新 / 导航：通知 SW 任务无法继续
  window.addEventListener('beforeunload', () => {
    if (session) {
      report({
        type: 'CONTENT_UNAVAILABLE',
        batchId: session.batchId,
        requestId: session.requestId,
        aiId: session.aiId,
        attempt: session.attempt,
        timestamp: Date.now(),
        payload: { error: 'PAGE_UNLOAD' },
      })
    }
  })
}
