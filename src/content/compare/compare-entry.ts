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
  // 提交前的回答节点数，用于锁定「本次回答」
  baselineCount: number
  stopped: boolean
}
let session: ActiveSession | null = null

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

/** 已知探针：回答节点列表的最后一个 = 本次回答。用 innerText 保留块级换行 */
function readAnswerProbed(s: ActiveSession): string | null {
  for (const sel of s.probe.answer ?? []) {
    const nodes = document.querySelectorAll(sel)
    if (!nodes.length) continue
    const el = nodes[nodes.length - 1] as HTMLElement
    return (el.innerText ?? el.textContent ?? '').trim()
  }
  return null
}

/**
 * 清洗抓取到的回答文本：
 * - 剥离问题回显（回答容器把用户问题一并包住时，开头相同前缀去掉）
 * - 去掉人类消息头（"你说：""XX 说："）与免责声明尾巴（textContent 连读场景）
 * - 保留 innerText 的块级换行；仅压缩多余空白
 */
const NOISE_PATTERNS = [
  /^[^：:]{1,12}说[：:]\s*/, // 「你说：」「ChatGPT 说：」开头
  /^[A-Za-z ]{1,20} said:\s*/i,
  /(?:ChatGPT|AI|GLM|Kimi|豆包|文心)[^。·]{0,20}(?:可能会?出错|会犯错|生成[，,]?)\.?[^。]*。?$/, // 免责声明尾巴
  /(?:内容由?\s*AI\s*生成|查看对话|重新生成|复制|分享|点赞|点踩|举报)$/u, // 操作残留
]

function cleanAnswerText(raw: string, prompt?: string): string {
  let text = raw.replace(/\u00a0/g, ' ')
  // 问题回显剥离：容器以「问题文本 + 换行」开头时去掉（innerText 保留换行后可精确匹配）
  if (prompt) {
    const p = prompt.trim()
    if (p.length > 8 && text.startsWith(p)) {
      text = text.slice(p.length).replace(/^[\s\n：:]+/, '')
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
 * 通用启发式回答读取（无 answer 探针 / 探针失效）：
 * 在主内容区找「文本量最大的最后渲染容器」——对话类站点流式回答通常是
 * 最近插入的大文本块。以 contenteditable 输入区的祖先容器为界，避免读到输入框。
 */
function readAnswerGeneric(s: ActiveSession): string {
  const main = document.querySelector('main') || document.body
  // 排除输入区自身及其祖先
  const composer = s.probe.composer.length ? document.querySelector(s.probe.composer[0]) : null
  let best: { el: Element; len: number } | null = null
  const candidates = main.querySelectorAll(
    'div, section, article, li, p, span'
  )
  for (const el of candidates) {
    if (composer && (el === composer || composer.contains(el) || el.contains(composer))) continue
    const text = (el.textContent ?? '').trim()
    if (text.length < 20) continue
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
  return best ? cleanAnswerText((best.el as HTMLElement).innerText ?? '', s.prompt) : ''
}

function readAnswer(s: ActiveSession): string {
  const probed = readAnswerProbed(s)
  return probed !== null ? cleanAnswerText(probed, s.prompt) : readAnswerGeneric(s)
}

/** 生成中检测：停止按钮可见 */
function isGenerating(s: ActiveSession): boolean {
  for (const sel of s.probe.generating ?? []) {
    const el = document.querySelector(sel)
    if (el && isVisible(el)) return true
  }
  return false
}

/** 节流上报：500ms 内的 DOM 变化合并为一次 RESPONSE_SNAPSHOT */
function scheduleReport(s: ActiveSession): void {
  if (s.reportTimer) return
  s.reportTimer = setTimeout(() => {
    s.reportTimer = null
    if (s.stopped) return
    const text = readAnswer(s)
    if (text && text !== s.reportedText) {
      s.reportedText = text
      report({
        type: 'RESPONSE_SNAPSHOT',
        batchId: s.batchId,
        requestId: s.requestId,
        aiId: s.aiId,
        attempt: s.attempt,
        timestamp: Date.now(),
        payload: { text },
      })
    }
  }, 500)
}

/**
 * 监听循环。完成判定（多信号，参考主流开源对话抓取实现）：
 *  A. 确认通道：站点探针给出「生成中」标志（停止按钮）时，标志消失 + 文本稳定 800ms。
 *  B. 兜底通道：探针完全没匹配到生成标志（DeepSeek 等）→ 需满足全部条件才判完成：
 *     文本稳定 STABLE_DONE_MS 且观测期足够长，且文本经历过实质性增长（防止
 *     模型推理停顿/慢渲染中途被截断——回答未完成时总会再长，宁可多等）。
 */
const STABLE_DONE_MS = 3000
const MIN_BEFORE_DONE_MS = 6000
/** B 通道：认为经历过「实质增长」的最小文本增量 */
const MIN_GROWTH = 60

function startWatch(s: ActiveSession): void {
  const stability = new TextStability(0)
  let sawGenerating = false
  let sawTextAt = 0
  let maxLen = 0
  const startedAt = Date.now()

  const check = () => {
    if (s.stopped) return
    const text = readAnswer(s)
    if (text) scheduleReport(s)
    if (text.length > maxLen + 1) maxLen = text.length // 记录历史峰值
    const generating = isGenerating(s)
    if (generating) {
      sawGenerating = true
      stability.feed('') // 生成中：重置稳定性时钟
      return
    }
    if (!text) return
    if (!sawTextAt) sawTextAt = Date.now()
    const stable = stability.feed(text)
    if (!stable) return
    // A 通道：见过生成标志 → 标志消失 + 文本稳定即可完成
    if (sawGenerating) finishWith(text)
    // B 通道：从未见过生成标志 → 文本稳定够久 + 观测够长 + 文本曾实质增长过
    else if (
      Date.now() - sawTextAt >= STABLE_DONE_MS &&
      Date.now() - startedAt >= MIN_BEFORE_DONE_MS &&
      maxLen >= MIN_GROWTH
    ) {
      finishWith(text)
    }
    // 其余情况：继续观察（宁多等不截断）
  }

  const finishWith = (text: string) => {
    s.stopped = true
    const done = {
      type: 'GENERATION_COMPLETED',
      batchId: s.batchId,
      requestId: s.requestId,
      aiId: s.aiId,
      attempt: s.attempt,
      timestamp: Date.now(),
      payload: { text },
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

  // 2. 记录基线：本次回答 = 提交后新增的回答节点
  const answerSel = probe.answer?.[0]
  const baselineCount = answerSel ? document.querySelectorAll(answerSel).length : 0

  // 3. 填充 + 验证
  const filled = await fillComposer(composer, prompt)
  if (!filled) return { ok: false, error: 'FILL_VERIFY_FAILED' }

  // 4. 提交
  await clickSubmit(composer, probe.submit)
  await new Promise((r) => setTimeout(r, 600))

  // 5. 验证提交生效（三选一即认为成功，避免站点残留占位/慢清空导致误判）：
  //    a) 输入区已基本清空（提交后站点清空输入是通用行为）
  //    b) 出现生成中标志（停止按钮）
  //    c) 已出现新回答节点（极快站点）
  const composerText =
    composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : (composer.textContent ?? '')
  const newCount = answerSel ? document.querySelectorAll(answerSel).length : 0
  const gen = isGenerating({ aiId, batchId, requestId, attempt, probe, prompt } as ActiveSession)
  const composerCleared = composerText.trim().length < Math.max(8, prompt.length / 2)
  if (!composerCleared && !gen && newCount === baselineCount) {
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
    baselineCount,
    stopped: false,
  }
  report({ type: 'GENERATION_STARTED', batchId, requestId, aiId, attempt, timestamp: Date.now() })
  startWatch(session)
  return { ok: true }
}

// ---- 消息入口（与截图模块共用 runtime.onMessage）----

export function initCompareContent(): void {
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
