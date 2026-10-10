/**
 * Compare content 入口：在 AI 平台页面接收 SW 指令，提交问题并观察流式回答。
 *
 * 关键设计：
 * - 只读取「本次请求的回答」：提交前记录当前回答数（N），生成后定位第 N+1 个
 *   回答节点，历史回答不混入。
 * - MutationObserver + 500ms 节流批量上报：DOM 高频变化不会打爆消息通道。
 * - 完成判定 = 停止按钮消失 + 回答文本连续 800ms 稳定（多信号，不只看一个）。
 * - 页面卸载时上报 CONTENT_UNAVAILABLE，SW 侧把任务落定为失败（可重试）。
 * - attempt 校验：过期请求的 CANCEL/DETACH 不影响新请求。
 */
import { waitForSelector, fillComposer, clickSubmit, isVisible, TextStability } from './base-adapter'
import { PROBES, platformForHost } from './registry'
import type { CompareAiId } from '../../shared/compare-types'

interface ActiveSession {
  aiId: CompareAiId
  batchId: string
  requestId: string
  attempt: number
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

/** 定位「本次回答」的当前文本 */
function readAnswer(session: ActiveSession): string {
  const probe = PROBES[session.aiId]
  for (const sel of probe.answer) {
    const nodes = document.querySelectorAll(sel)
    if (!nodes.length) continue
    // 回答数超过 baseline：最后一个就是本次回答
    const target = nodes[nodes.length - 1]
    return (target.textContent ?? '').trim()
  }
  return ''
}

/** 生成中检测：停止按钮可见 */
function isGenerating(aiId: CompareAiId): boolean {
  const probe = PROBES[aiId]
  if (!probe.generating) return false
  for (const sel of probe.generating) {
    const el = document.querySelector(sel)
    if (el && isVisible(el)) return true
  }
  return false
}

/** 节流上报增量：500ms 内的 DOM 变化合并为一次 RESPONSE_SNAPSHOT */
function scheduleReport(session: ActiveSession): void {
  if (session.reportTimer) return
  session.reportTimer = setTimeout(() => {
    session.reportTimer = null
    if (session.stopped) return
    const text = readAnswer(session)
    if (text && text !== session.reportedText) {
      session.reportedText = text
      report({
        type: 'RESPONSE_SNAPSHOT',
        batchId: session.batchId,
        requestId: session.requestId,
        aiId: session.aiId,
        attempt: session.attempt,
        timestamp: Date.now(),
        payload: { text },
      })
    }
  }, 500)
}

/**
 * 监听循环：MutationObserver 触发 → 节流上报 + 稳定性检查。
 * 完成条件（全部满足）：
 *  1. 曾观察到生成中状态或已有非空回答
 *  2. 当前无停止按钮（不在生成）
 *  3. 回答文本连续 800ms 稳定
 */
function startWatch(session: ActiveSession): void {
  const stability = new TextStability()
  let sawGenerating = false

  const check = () => {
    if (session.stopped) return
    const text = readAnswer(session)
    if (text) scheduleReport(session)
    if (isGenerating(session.aiId)) {
      sawGenerating = true
      stability.feed('') // 重置稳定性时钟
      return
    }
    if (!text) return
    // 不在生成：文本稳定 800ms 即完成
    if (stability.feed(text) && sawGenerating) {
      session.stopped = true
      const done = {
        type: 'GENERATION_COMPLETED',
        batchId: session.batchId,
        requestId: session.requestId,
        aiId: session.aiId,
        attempt: session.attempt,
        timestamp: Date.now(),
        payload: { text },
      }
      disposeSession()
      report(done)
    }
  }

  session.observer = new MutationObserver(() => check())
  session.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  // 兜底轮询：有些站点替换节点可能不触发 characterData，500ms 巡检
  session.pollTimer = setInterval(check, 500)
}

/** 提交问题并启动观察 */
async function submitPrompt(
  aiId: CompareAiId,
  batchId: string,
  requestId: string,
  attempt: number,
  prompt: string
): Promise<{ ok: boolean; error?: string }> {
  if (session) {
    // 已有会话（连续对比）：先清理旧观察
    disposeSession()
  }
  const probe = PROBES[aiId]

  // 1. 等输入区
  const composer = await waitForSelector(probe.composer, 15_000)
  if (!composer) return { ok: false, error: 'COMPOSER_NOT_FOUND' }

  // 2. 记录基线：本次回答 = 提交后新增的回答节点
  const probeAnswerSel = probe.answer[0]
  const baselineCount = probeAnswerSel ? document.querySelectorAll(probeAnswerSel).length : 0

  // 3. 填充 + 验证
  const filled = await fillComposer(composer, prompt)
  if (!filled) return { ok: false, error: 'FILL_VERIFY_FAILED' }

  // 4. 提交
  await clickSubmit(composer, probe.submit)
  await new Promise((r) => setTimeout(r, 600))

  // 5. 验证提交生效：输入区已清空 或 出现生成中标志 或 已出现新回答节点
  const composerText = (composer.textContent ?? '').trim()
  const newCount = probeAnswerSel ? document.querySelectorAll(probeAnswerSel).length : 0
  const generating = isGenerating(aiId)
  if (composerText.length > prompt.length / 2 && !generating && newCount === baselineCount) {
    return { ok: false, error: 'SUBMIT_NOT_TAKEN' }
  }

  // 6. 启动观察
  session = {
    aiId,
    batchId,
    requestId,
    attempt,
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
  const aiId = platformForHost(location.host)
  if (!aiId) return // 非目标平台，不注册

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'COMPARE_PING') {
      sendResponse({ ok: true, aiId })
      return
    }
    if (msg?.type === 'SUBMIT_PROMPT') {
      const { prompt, requestId, attempt } = msg.payload ?? {}
      const batchId = msg.batchId
      if (!prompt || !requestId || !batchId) {
        sendResponse({ ok: false, error: 'BAD_PAYLOAD' })
        return
      }
      submitPrompt(aiId, batchId, requestId, attempt ?? 1, String(prompt))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }))
      return true // async
    }
    if (msg?.type === 'DETACH_OBSERVER') {
      // 仅当属于当前会话才清理（过期 attempt 忽略）
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
