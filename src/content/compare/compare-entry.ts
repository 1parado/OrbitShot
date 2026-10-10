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

/** 已知探针：回答节点列表的最后一个 = 本次回答 */
function readAnswerProbed(s: ActiveSession): string | null {
  for (const sel of s.probe.answer ?? []) {
    const nodes = document.querySelectorAll(sel)
    if (!nodes.length) continue
    return (nodes[nodes.length - 1].textContent ?? '').trim()
  }
  return null
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
  return best ? (best.el.textContent ?? '').trim() : ''
}

function readAnswer(s: ActiveSession): string {
  const probed = readAnswerProbed(s)
  return probed ?? readAnswerGeneric(s)
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
 * 监听循环。完成条件（全部满足）：
 *  1. 曾观察到生成中状态或已有非空回答
 *  2. 当前无停止按钮（不在生成）
 *  3. 回答文本连续 800ms 稳定
 */
function startWatch(s: ActiveSession): void {
  const stability = new TextStability()
  let sawGenerating = false

  const check = () => {
    if (s.stopped) return
    const text = readAnswer(s)
    if (text) scheduleReport(s)
    if (isGenerating(s)) {
      sawGenerating = true
      stability.feed('') // 重置稳定性时钟
      return
    }
    if (!text) return
    if (stability.feed(text) && sawGenerating) {
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

  // 5. 验证提交生效：输入区已清空 或 出现生成中标志 或 已出现新回答节点
  const composerText =
    composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : (composer.textContent ?? '')
  const newCount = answerSel ? document.querySelectorAll(answerSel).length : 0
  const gen = isGenerating({ aiId, batchId, requestId, attempt, probe } as ActiveSession)
  if (composerText.trim().length > prompt.length / 2 && !gen && newCount === baselineCount) {
    return { ok: false, error: 'SUBMIT_NOT_TAKEN' }
  }

  // 6. 启动观察
  session = {
    aiId,
    batchId,
    requestId,
    attempt,
    probe,
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
