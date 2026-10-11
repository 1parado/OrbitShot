/**
 * Compare 调度器：一批多平台并行执行，逐平台独立状态机。
 *
 * - 状态持久化在 chrome.storage.local（ orbitshot.compare.* ），SW 被杀后
 *   Side Panel 通过 GET_BATCH_STATE 恢复；重试 = attempt+1 的新任务。
 * - 所有下行（SW→CS）与上行（CS→SW）消息都校验 batchId/requestId/attempt，
 *   旧 attempt 的迟到消息直接丢弃，不会覆盖新请求状态。
 * - 推送走 runtime.Port（COMPARE_PORT），Side Panel 断开后由其重连时拉取兜底。
 * - 每个任务独立超时/失败，互不阻塞。
 */
import type {
  CompareAiId,
  CompareBatch,
  CompareTask,
  CompareTaskStatus,
} from '../../shared/compare-types'
import {
  COMPARE_CURRENT_KEY,
  COMPARE_HISTORY_KEY,
  COMPARE_PORT,
  DEFAULT_TASK_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_GENERATION_MS,
  isActiveStatus,
  platformsFromAiList,
} from '../../shared/compare-types'
import type { ComparePlatform } from '../../shared/compare-types'
import { ensureAiTab, waitTabComplete, pingCompareCs } from './tab-manager'
import { ensureContentScript } from '../cs-utils'
import { injectFiles } from '../ai-injector'
import type { InjectResult } from '../ai-injector'
// 静态导入：SW 里禁止动态 import()——Vite 会包上 __vitePreload 助手，
// 其内部引用 document/window，在 Service Worker 上下文抛 "window is not defined"
import { loadSettings } from '../../shared/settings'

// ---- 批次存取（chrome.storage.local） ----

export async function loadCurrentBatch(): Promise<CompareBatch | undefined> {
  const res = await chrome.storage.local.get(COMPARE_CURRENT_KEY)
  return res?.[COMPARE_CURRENT_KEY] as CompareBatch | undefined
}

async function saveBatch(batch: CompareBatch): Promise<void> {
  await chrome.storage.local.set({ [COMPARE_CURRENT_KEY]: batch })
}

async function archiveBatch(batch: CompareBatch): Promise<void> {
  const res = await chrome.storage.local.get(COMPARE_HISTORY_KEY)
  const hist = (res?.[COMPARE_HISTORY_KEY] as string[] | undefined) ?? []
  // 只保留最近 10 个 batchId，防止无限膨胀
  const next = [batch.batchId, ...hist.filter((id) => id !== batch.batchId)].slice(0, 10)
  await chrome.storage.local.set({ [COMPARE_HISTORY_KEY]: next })
}

function taskOf(batch: CompareBatch, requestId: string): CompareTask | undefined {
  return batch.tasks.find((t) => t.requestId === requestId)
}

/**
 * 更新单个任务并推送快照；返回 false 表示 batch/request 已不存在。
 *
 * 落盘节流：流式期间 CS 每 500ms 发一次全量快照，若每次都把整个 batch
 * （含所有任务的完整 response）写 chrome.storage，长回答时写入量会成为
 * SW 的主要开销。这里把「非终态」写盘合并到 ≥2s 一次（内存 batch 始终
 * 最新，Port 推送不受影响）；终态（completed/failed/timeout/cancelled）
 * 立即落盘，保证 SW 被杀后状态可恢复。
 */
const FLUSH_MIN_INTERVAL_MS = 2000
let lastFlushAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushBatchNow(batch: CompareBatch): void {
  lastFlushAt = Date.now()
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  void saveBatch(batch)
}

function scheduleFlush(batch: CompareBatch, terminal: boolean): void {
  if (terminal) {
    flushBatchNow(batch)
    return
  }
  // 内存对象已更新，落盘只是持久化：合并写即可
  if (flushTimer) return
  const wait = Math.max(0, FLUSH_MIN_INTERVAL_MS - (Date.now() - lastFlushAt))
  flushTimer = setTimeout(() => {
    flushTimer = null
    void saveBatch(batch)
  }, wait)
}

async function patchTask(
  batch: CompareBatch,
  requestId: string,
  patch: Partial<CompareTask> & { status?: CompareTaskStatus }
): Promise<boolean> {
  const t = taskOf(batch, requestId)
  if (!t) return false
  Object.assign(t, patch)
  const terminal =
    !!patch.status &&
    (patch.status === 'completed' ||
      patch.status === 'failed' ||
      patch.status === 'timeout' ||
      patch.status === 'cancelled')
  if (terminal && !t.endedAt) {
    t.endedAt = Date.now()
    if (t.startedAt) t.durationMs = t.endedAt - t.startedAt
  }
  scheduleFlush(batch, terminal)
  broadcastSnapshot(batch)
  return true
}

// ---- Port 推送 ----

type Port = chrome.runtime.Port
const ports = new Set<Port>()

export function attachComparePort(port: Port): void {
  if (port.name !== COMPARE_PORT) return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  // Side Panel 重连/主动拉取：立即回当前快照
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'GET_BATCH_STATE') {
      loadCurrentBatch().then((batch) => {
        try {
          port.postMessage({ type: 'BATCH_STATE_SNAPSHOT', ok: true, batch })
        } catch {
          ports.delete(port)
        }
      })
    }
  })
}

function broadcastSnapshot(batch: CompareBatch): void {
  const msg = { type: 'BATCH_STATE_SNAPSHOT', ok: true, batch }
  for (const p of ports) {
    try {
      p.postMessage(msg)
    } catch {
      ports.delete(p)
    }
  }
}

// ---- 运行中任务表（内存加速，真源仍是 storage） ----

interface Running {
  batch: CompareBatch
  requestId: string
  attempt: number
  tabId: number
  timer?: ReturnType<typeof setTimeout>
  cancelled?: boolean
  /** 生成阶段开始时刻（看门狗总时长上限用；提交阶段为 undefined） */
  startedAt?: number
}
const running = new Map<string, Running>() // key = requestId

function clearTimeoutOf(r: Running | undefined) {
  if (r?.timer) clearTimeout(r.timer)
}

/**
 * 生成阶段看门狗（idle 语义，双层）：
 * - 距最后一次流式增量 IDLE_TIMEOUT_MS 无更新 → 超时；
 * - 整个生成阶段超过 MAX_GENERATION_MS → 超时。
 * 每次收到 RESPONSE_* 增量时由 handleUpstream 调 armGenerationWatchdog 续期。
 */
function armGenerationWatchdog(r: Running, idleMs: number): void {
  clearTimeoutOf(r)
  const totalLeft = r.startedAt ? MAX_GENERATION_MS - (Date.now() - r.startedAt) : MAX_GENERATION_MS
  const wait = Math.max(1000, Math.min(idleMs, totalLeft))
  r.timer = setTimeout(() => {
    void handleTimeout(r.batch, r.requestId)
  }, wait)
}

/**
 * 把批次内仍在进行的任务重新纳入运行表（SW 重启/批次恢复后 running 表丢失时
 * 调用）：逐个重建 Running，generating 任务重挂 idle 看门狗——否则它们的流式
 * 事件会被 validUpstream 丢弃而永久卡住。已在表中的任务跳过。
 */
function adoptRunningTasks(batch: CompareBatch): void {
  for (const t of batch.tasks) {
    if (!isActiveStatus(t.status) || running.has(t.requestId)) continue
    const r: Running = {
      batch,
      requestId: t.requestId,
      attempt: t.attempt,
      tabId: t.tabId ?? -1,
      startedAt: t.startedAt ?? Date.now(),
    }
    running.set(t.requestId, r)
    if (t.status === 'generating') armGenerationWatchdog(r, IDLE_TIMEOUT_MS)
  }
}

// ---- 主入口：DISPATCH_BATCH ----

/** 平台表：从用户 AI 设置构建（启用项），带短缓存 */
let platformCache: { at: number; list: ComparePlatform[] } | null = null
async function getPlatforms(): Promise<ComparePlatform[]> {
  if (platformCache && Date.now() - platformCache.at < 5000) return platformCache.list
  const s = await loadSettings()
  const list = platformsFromAiList(s.aiList)
  platformCache = { at: Date.now(), list }
  return list
}

export async function dispatchBatch(payload: {
  prompt: string
  aiIds: CompareAiId[]
  timeoutMs?: number
}): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  const prompt = payload.prompt?.trim()
  if (!prompt) return { ok: false, error: 'PROMPT_EMPTY' }
  const platforms = await getPlatforms()
  const aiIds = (payload.aiIds ?? []).filter(
    (id, i, a) => platforms.some((p) => p.id === id) && a.indexOf(id) === i
  )
  if (!aiIds.length) return { ok: false, error: 'NO_PLATFORM' }

  const timeoutMs = payload.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const batchId = crypto.randomUUID()
  const now = Date.now()
  const batch: CompareBatch = {
    batchId,
    prompt,
    createdAt: now,
    tasks: aiIds.map((aiId) => ({
      batchId,
      requestId: crypto.randomUUID(),
      aiId,
      attempt: 1,
      status: 'queued' as CompareTaskStatus,
      response: '',
      thinking: '',
      images: [],
      turn: 1,
    })),
    turns: [{ turn: 1, prompt, askedAt: now }],
    currentTurn: 1,
  }
  await saveBatch(batch)
  broadcastSnapshot(batch)

  // 并行启动所有任务；任何一条失败不影响其他任务
  for (const t of batch.tasks) {
    runTask(batch, t, timeoutMs).catch((e) => {
      console.error('[compare] task crashed', t.aiId, e)
    })
  }
  return { ok: true, batchId }
}

/**
 * 截图批量发送路径：SEND_TO_AI 注入成功后，把该站登记为对比任务并在
 * **同一标签页**上提交问题（页面已加载完成，无需 dispatcher 再开页）。
 * 后续流式事件沿用统一上行通道；超时/取消/重试也复用现有机制。
 */
/** 生成阶段任务（runTask/runFollowupTask/attachScreenshotTask）共用的提交尾部 */
async function submitPromptToTab(opts: {
  batch: CompareBatch
  r: Running
  requestId: string
  aiId: CompareAiId
  tabId: number
  prompt: string
  attempt: number
  idleMs: number
  followup?: boolean
}): Promise<void> {
  const resp = (await chrome.tabs.sendMessage(opts.tabId, {
    type: 'SUBMIT_PROMPT',
    batchId: opts.batch.batchId,
    requestId: opts.requestId,
    aiId: opts.aiId,
    attempt: opts.attempt,
    timestamp: Date.now(),
    payload: {
      prompt: opts.prompt,
      requestId: opts.requestId,
      attempt: opts.attempt,
      aiId: opts.aiId,
      ...(opts.followup ? { followup: true } : {}),
    },
  })) as { ok: boolean; error?: string } | undefined
  if (opts.r.cancelled) return
  if (!resp?.ok) throw new Error(resp?.error || 'SUBMIT_FAILED')
  opts.r.startedAt = Date.now()
  armGenerationWatchdog(opts.r, opts.idleMs)
}

export async function attachScreenshotTask(opts: {
  aiId: CompareAiId
  prompt: string
  tabId: number
  batchKey: string
  timeoutMs?: number
}): Promise<{ ok: boolean; error?: string }> {
  const prompt = opts.prompt?.trim()
  if (!prompt) return { ok: false, error: 'PROMPT_EMPTY' }

  // 一个 batchKey 建一个 batch（首站创建，后续站追加任务）。
  // turns/currentTurn 必须初始化：面板追问栏依赖 currentTurn 判定可追问。
  let batch = screenshotBatches.get(opts.batchKey)
  if (!batch) {
    // SW 在两站注入之间可能被回收：内存表丢失时必须从 storage 恢复同批次，
    // 否则重建的新 batch 会覆盖掉已登记任务（面板只剩一张卡片的根因）。
    const existing = await loadCurrentBatch()
    if (existing && existing.batchId === opts.batchKey) {
      batch = existing
    } else {
      batch = {
        batchId: opts.batchKey,
        prompt,
        createdAt: Date.now(),
        tasks: [],
        turns: [{ turn: 1, prompt, askedAt: Date.now() }],
        currentTurn: 1,
      }
    }
    screenshotBatches.set(opts.batchKey, batch)
    // 恢复的批次里可能有仍在进行的任务（SW 重启丢失 running 表）：重建，
    // 否则它们的流式事件会被 validUpstream 丢弃而永久卡住
    adoptRunningTasks(batch)
    await saveBatch(batch)
    broadcastSnapshot(batch)
  }
  // 同站重复消息（理论不会有）忽略
  if (batch.tasks.some((t) => t.aiId === opts.aiId)) return { ok: true }

  // 首站登记即打开面板：不等全部站点（最慢站可能几十秒），回答流式补上
  if (!panelOpenedFor.has(opts.batchKey)) {
    panelOpenedFor.add(opts.batchKey)
    panelOpener?.()
  }

  const task: CompareTask = {
    batchId: batch.batchId,
    requestId: crypto.randomUUID(),
    aiId: opts.aiId,
    attempt: 1,
    status: 'submitting',
    response: '',
    thinking: '',
    images: [],
    turn: 1,
  }
  batch.tasks.push(task)
  await saveBatch(batch)
  broadcastSnapshot(batch)

  const r: Running = { batch, requestId: task.requestId, attempt: 1, tabId: opts.tabId }
  running.set(task.requestId, r)

  // 同页直接提交。截图注入用的是一次性函数注入，不代表常驻 CS 还活着
  // （标签页被丢弃/挂起/刚导航都会导致 "Receiving end does not exist"）——
  // 这里先 ensureContentScript：未就绪就重新注入并等待 PING。
  try {
    const cs = await ensureContentScript(opts.tabId)
    if (!cs.ok) throw new Error('CS_NOT_READY')
    await submitPromptToTab({
      batch,
      r,
      requestId: task.requestId,
      aiId: opts.aiId,
      tabId: opts.tabId,
      prompt,
      attempt: 1,
      idleMs: opts.timeoutMs ?? IDLE_TIMEOUT_MS,
    })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finalizeFailed(batch, task.requestId, msg)
    return { ok: false, error: msg }
  }
}

/** 截图批次登记表：batchKey → batch */
const screenshotBatches = new Map<string, CompareBatch>()

/** 面板打开回调（background 注入，避免 dispatcher 直接依赖 sidePanel） */
let panelOpener: (() => void) | null = null
let panelOpenedFor = new Set<string>() // 已开过面板的 batchKey

export function setPanelOpener(fn: () => void): void {
  panelOpener = fn
}

/**
 * 截图批次全部站点处理完毕（COMPARE_BATCH_DONE）。
 * 面板在首站登记成功时即已提前打开（不等最慢站），这里只做收尾广播。
 */
export async function finishScreenshotBatch(batchKey: string): Promise<boolean> {
  const batch = screenshotBatches.get(batchKey)
  if (!batch) return false // 非 compareMode 批次（无登记）→ 不开面板
  broadcastSnapshot(batch)
  return true
}

/**
 * 多轮追问：在既有批次上继续提问。
 *
 * 前提：该批次此前至少跑过一轮（每平台有自己的标签页与会话上下文）。
 * - 每个平台复用 task.tabId（第一轮开过的页面），页面里的 AI 会话自带
 *   完整上下文——直接提交追问即可「接着回答」。
 * - 页面丢失（被关闭/被丢弃）的平台：该任务标 failed（FOLLOWUP_TAB_LOST），
 *   不阻塞其他平台；用户可对其单独重试（重试会走冷启动路径）。
 * - 批次 turns 追加本轮记录；tasks 追加 turn+1 的新任务（旧轮保留供 UI 展示）。
 */
export async function followUpBatch(payload: {
  batchId: string
  prompt: string
  timeoutMs?: number
  attachments?: { name: string; mime: string; dataUrl: string }[]
}): Promise<{ ok: boolean; error?: string }> {
  const prompt = payload.prompt?.trim()
  if (!prompt) return { ok: false, error: 'PROMPT_EMPTY' }
  const batch = await loadCurrentBatch()
  if (!batch || batch.batchId !== payload.batchId) return { ok: false, error: 'NO_BATCH' }
  if (batch.tasks.some((t) => isActiveStatus(t.status))) return { ok: false, error: 'STILL_RUNNING' }

  const timeoutMs = payload.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const turn = (batch.currentTurn ?? 1) + 1
  const attachments = (payload.attachments ?? []).filter((a) => a?.dataUrl)

  // 本轮参与平台：上一轮已有任务的平台（保持阵容稳定）
  const prevByAi = new Map<string, CompareTask>()
  for (const t of batch.tasks) {
    const prev = prevByAi.get(t.aiId)
    if (!prev || t.turn === (batch.currentTurn ?? 1)) prevByAi.set(t.aiId, t)
  }

  batch.turns = [
    ...(batch.turns ?? []),
    { turn, prompt, askedAt: Date.now(), attachments: attachments.length ? attachments : undefined },
  ]
  batch.currentTurn = turn

  const newTasks: CompareTask[] = []
  for (const [aiId, prev] of prevByAi) {
    const task: CompareTask = {
      batchId: batch.batchId,
      requestId: crypto.randomUUID(),
      aiId,
      attempt: 1,
      status: 'queued',
      response: '',
      thinking: '',
      images: [],
      turn,
      turnPrompt: prompt,
      // 复用上一轮的标签页（会话上下文就在那个页面里）
      tabId: prev.tabId,
    }
    batch.tasks.push(task)
    newTasks.push(task)
  }
  await saveBatch(batch)
  broadcastSnapshot(batch)

  for (const t of newTasks) {
    runFollowupTask(batch, t, prompt, timeoutMs, attachments).catch((e) => {
      console.error('[compare] followup crashed', t.aiId, e)
    })
  }
  return { ok: true }
}

/**
 * 追问单任务生命周期：与 runTask 的差异——不开新标签页、不做冷启动等待，
 * 直接在上一轮的页面上提交（页面是活会话）。页面不可用 → failed 可重试。
 * 带附件时先注入（任意 MIME paste），注入失败该任务标 failed 不阻塞其他平台。
 */
async function runFollowupTask(
  batch: CompareBatch,
  task: CompareTask,
  prompt: string,
  timeoutMs: number,
  attachments: { name: string; mime: string; dataUrl: string }[] = []
): Promise<void> {
  const requestId = task.requestId
  const r: Running = { batch, requestId, attempt: 1, tabId: task.tabId ?? -1 }
  running.set(requestId, r)
  try {
    patchTask(batch, requestId, { status: 'submitting' })
    const tabId = task.tabId
    if (!tabId || tabId <= 0) throw new Error('FOLLOWUP_TAB_LOST')
    // 标签页还在吗
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      throw new Error('FOLLOWUP_TAB_LOST')
    }
    if (!tab) throw new Error('FOLLOWUP_TAB_LOST')
    // CS 可能随导航失效：确保就绪
    const cs = await ensureContentScript(tabId)
    if (!cs.ok) throw new Error('CS_NOT_READY')

    // 附件先注入（页面内 paste），成功后提交文本
    if (attachments.length) {
      const { lang } = await loadSettings()
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectFiles,
        args: [attachments, 15000, lang ?? 'zh-CN'],
      })
      const ir = results?.[0]?.result as InjectResult | undefined
      if (!ir || ir.status === 'no-editor' || ir.status === 'error') {
        throw new Error('ATTACH_INJECT_FAILED')
      }
    }

    await submitPromptToTab({
      batch,
      r,
      requestId,
      aiId: task.aiId,
      tabId,
      prompt,
      attempt: 1,
      idleMs: timeoutMs,
      followup: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (r.cancelled) return
    await finalizeFailed(batch, requestId, msg)
  }
}

/** 单任务全生命周期：开页 → 等 CS → 提交 → 等流式事件（事件驱动，非轮询） */
async function runTask(batch: CompareBatch, task: CompareTask, timeoutMs: number): Promise<void> {
  const requestId = task.requestId
  const r: Running = { batch, requestId, attempt: task.attempt, tabId: -1 }
  running.set(requestId, r)

  try {
    // 1) opening_tab
    patchTask(batch, requestId, { status: 'opening_tab' })
    const platforms = await getPlatforms()
    const platform = platforms.find((p) => p.id === task.aiId)
    if (!platform) throw new Error('PLATFORM_REMOVED')
    const tab = await ensureAiTab(platform)
    // 标签页在开页阶段被用户关闭
    if (r.cancelled) return
    r.tabId = tab.tabId
    patchTask(batch, requestId, { tabId: tab.tabId })

    // 2) waiting_cs：等页面加载 + 对比 CS 模块就绪
    patchTask(batch, requestId, { status: 'waiting_cs' })
    try {
      await waitTabComplete(tab.tabId, 20_000)
    } catch {
      throw new Error('TAB_CLOSED')
    }
    const ready = await pingCompareCs(tab.tabId, 20, 250) // ~5s
    if (r.cancelled) return
    if (!ready) throw new Error('CS_NOT_READY')

    // 3) submitting：发送提交指令（PROMPT_ACCEPTED / GENERATION_* 由上行事件驱动）
    patchTask(batch, requestId, { status: 'submitting' })
    await submitPromptToTab({
      batch,
      r,
      requestId,
      aiId: task.aiId,
      tabId: tab.tabId,
      prompt: batch.prompt,
      attempt: task.attempt,
      idleMs: timeoutMs,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (r.cancelled) return
    // 归类：标签页被关 → failed（用户可重试；瞬时错误走自动重试）
    await finalizeFailed(batch, requestId, msg)
  }
}

async function handleTimeout(batch: CompareBatch, requestId: string): Promise<void> {
  const r = running.get(requestId)
  if (!r || r.cancelled) return
  const t = taskOf(batch, requestId)
  if (!t || !isActiveStatus(t.status)) return
  // 通知 CS 停止观察，然后落定状态
  try {
    if (r.tabId > 0) {
      await chrome.tabs.sendMessage(r.tabId, {
        type: 'DETACH_OBSERVER',
        requestId,
        attempt: r.attempt,
      })
    }
  } catch {
    /* 标签页可能已关闭，忽略 */
  }
  running.delete(requestId)
  // 已收到大段内容却标 timeout 是最差的体验：保留已收内容标 completed
  // （error 字段带 TIMEOUT_TRUNCATED，卡片上显示截断说明，内容仍可复制）。
  // 思考模型（DeepSeek R1）思考期只有 thinking 增量，同样保留。
  if ((t.response && t.response.length > 80) || (t.thinking && t.thinking.length > 80)) {
    patchTask(batch, requestId, { status: 'completed', error: 'TIMEOUT_TRUNCATED' })
  } else {
    patchTask(batch, requestId, { status: 'timeout', error: 'TIMEOUT' })
  }
}

/** 重置任务字段到「attempt N 重跑」起点（不触碰 turn/turnPrompt/tabId） */
function resetTaskFields(t: CompareTask, attempt: number): void {
  t.attempt = attempt
  t.status = 'queued'
  t.response = ''
  t.thinking = ''
  t.images = []
  t.error = undefined
  t.startedAt = undefined
  t.endedAt = undefined
  t.durationMs = undefined
}

async function finalizeFailed(batch: CompareBatch, requestId: string, error: string): Promise<void> {
  const r = running.get(requestId)
  clearTimeoutOf(r)
  running.delete(requestId)
  const t = taskOf(batch, requestId)
  if (!t || !isActiveStatus(t.status)) return

  // 自动重试：提交链路（开页/等CS/填空/提交）的失败多数是瞬时性的
  // （SPA 未就绪、DOM 重排、CS 刚注入），落 failed 前先自动重试 1 次。
  // 同 requestId 原对象重跑：attempt+1，旧 attempt 的迟到事件因校验被丢弃。
  // generating 之后不进这里（不走 finalizeFailed 的重试分支，仅手动）。
  const attemptLeft = AUTO_RETRY_ATTEMPTS - (t.attempt - 1)
  if (attemptLeft > 0 && AUTO_RETRY_ERRORS.has(error)) {
    console.warn('[compare] auto-retry', t.aiId, error, 'attempt', t.attempt)
    resetTaskFields(t, t.attempt + 1)
    scheduleFlush(batch, true)
    broadcastSnapshot(batch)
    runTask(batch, t, DEFAULT_TASK_TIMEOUT_MS).catch((e) => {
      console.error('[compare] auto-retry crashed', t.aiId, e)
    })
    return
  }
  patchTask(batch, requestId, { status: 'failed', error })
}

/** 提交链路瞬时错误：自动重试（attempt 2）后仍失败才标 failed */
const AUTO_RETRY_ATTEMPTS = 2
const AUTO_RETRY_ERRORS = new Set([
  'CS_NOT_READY',
  'COMPOSER_NOT_FOUND',
  'FILL_VERIFY_FAILED',
  'SUBMIT_FAILED',
  'SUBMIT_NOT_TAKEN',
])

// ---- 上行事件（content → background）----

interface UpstreamMsg {
  type: string
  batchId?: string
  requestId?: string
  attempt?: number
  payload?: unknown
}

/** 校验消息属于当前运行中请求，防旧 attempt / 旧批次串线 */
function validUpstream(msg: UpstreamMsg): { r: Running; batch: CompareBatch } | null {
  if (!msg?.requestId || !msg?.batchId) return null
  const r = running.get(msg.requestId)
  if (!r || r.cancelled) return null
  if (r.batch.batchId !== msg.batchId) return null
  if (typeof msg.attempt === 'number' && msg.attempt !== r.attempt) return null
  return { r, batch: r.batch }
}

/**
 * 从 storage 复活内存表丢失的任务：SW 在流式阶段被回收重启后 running 表为空，
 * 后续上行事件若直接丢弃，任务会永久卡在 generating（面板转圈不落定）。
 * 校验通过则重建整批运行表（adoptRunningTasks，批内其他活跃任务一并接力）
 * 并重挂 idle 看门狗。
 */
async function reviveFromStorage(msg: UpstreamMsg): Promise<{ r: Running; batch: CompareBatch } | null> {
  if (!msg?.requestId || !msg?.batchId) return null
  const batch = await loadCurrentBatch()
  if (!batch || batch.batchId !== msg.batchId) return null
  const t = taskOf(batch, msg.requestId)
  if (!t || !isActiveStatus(t.status)) return null
  if (typeof msg.attempt === 'number' && msg.attempt !== t.attempt) return null
  adoptRunningTasks(batch)
  const r = running.get(t.requestId)
  if (!r) return null
  console.info('[compare] revived running entry from storage', t.aiId, msg.type)
  return { r, batch }
}

export async function handleUpstream(msg: UpstreamMsg): Promise<void> {
  let v = validUpstream(msg)
  if (!v) v = await reviveFromStorage(msg)
  if (!v) return
  const { r, batch } = v
  const requestId = msg.requestId!
  const p = (msg.payload ?? {}) as {
    text?: string
    content?: string
    thinking?: string
    images?: string[]
    error?: string
  }
  // 兼容两种上行：新协议 { content, thinking, images }；旧协议 { text }
  const content = p.content ?? p.text ?? ''
  const thinking = p.thinking ?? ''

  switch (msg.type) {
    case 'PROMPT_ACCEPTED':
      // CS 已确认问题真实进入输入区（尚未点发送 / 或已发送）
      patchTask(batch, requestId, { status: 'submitting' })
      break
    case 'GENERATION_STARTED':
      patchTask(batch, requestId, {
        status: 'generating',
        startedAt: Date.now(),
        response: '',
        thinking: '',
        images: [],
      })
      // 生成阶段开始：挂 idle 看门狗（流式增量会持续续期）
      r.startedAt = Date.now()
      armGenerationWatchdog(r, IDLE_TIMEOUT_MS)
      break
    case 'RESPONSE_DELTA': {
      const t = taskOf(batch, requestId)
      if (!t) return
      // delta 语义：CS 侧保证按序增量追加，这里只做拼接
      patchTask(batch, requestId, {
        status: t.status === 'completed' ? 'completed' : 'generating',
        response: t.response + (p.text ?? ''),
      })
      armGenerationWatchdog(r, IDLE_TIMEOUT_MS) // 流式推进中：续期
      break
    }
    case 'RESPONSE_SNAPSHOT': {
      // snapshot 语义：整体覆盖（DOM 重挂载 / 分段重渲染时用）
      patchTask(batch, requestId, {
        response: content,
        thinking,
        images: Array.isArray(p.images) ? p.images : [],
      })
      if (content || thinking) armGenerationWatchdog(r, IDLE_TIMEOUT_MS) // 流式推进中：续期
      break
    }
    case 'GENERATION_COMPLETED':
      clearTimeoutOf(r)
      running.delete(requestId)
      patchTask(batch, requestId, {
        status: 'completed',
        response: content,
        thinking,
        images: Array.isArray(p.images) ? p.images : [],
      })
      // 全部任务落定后归档（顺带清理截图批次登记表）
      await maybeArchive(batch)
      break
    case 'GENERATION_FAILED':
      await finalizeFailed(batch, requestId, p.error || 'GENERATION_FAILED')
      break
    case 'CONTENT_UNAVAILABLE':
      // 页面刷新 / 导航导致任务无法继续
      await finalizeFailed(batch, requestId, p.error || 'CONTENT_UNAVAILABLE')
      break
  }
}

async function maybeArchive(batch: CompareBatch): Promise<void> {
  if (batch.tasks.some((t) => isActiveStatus(t.status))) return
  // 全部落定：内存表清理 + 存 history
  for (const t of batch.tasks) running.delete(t.requestId)
  // 顺带清理已收尾的截图批次登记（Map/Set 只增不减会随长会话累积）
  for (const [key, b] of screenshotBatches) {
    if (b.batchId === batch.batchId && !b.tasks.some((tk) => isActiveStatus(tk.status))) {
      screenshotBatches.delete(key)
      panelOpenedFor.delete(key)
    }
  }
  await archiveBatch(batch)
}

// ---- 重试 / 取消 ----

export async function retryRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  const batch = await loadCurrentBatch()
  if (!batch) return { ok: false, error: 'NO_BATCH' }
  const old = taskOf(batch, requestId)
  if (!old) return { ok: false, error: 'NO_TASK' }
  if (isActiveStatus(old.status)) return { ok: false, error: 'STILL_RUNNING' }

  // 重试 = 同一任务原对象重跑（attempt+1）；旧 attempt 的迟到事件因校验被丢弃。
  // 追问轮任务（turn >= 2）重试仍走活会话路径；首轮任务重试走冷启动。
  const isFollowup = (old.turn ?? 1) >= 2
  resetTaskFields(old, old.attempt + 1)
  await saveBatch(batch)
  broadcastSnapshot(batch)
  const runner = isFollowup
    ? runFollowupTask(batch, old, old.turnPrompt || batch.prompt, DEFAULT_TASK_TIMEOUT_MS)
    : runTask(batch, old, DEFAULT_TASK_TIMEOUT_MS)
  runner.catch((e) => {
    console.error('[compare] retry crashed', old.aiId, e)
  })
  return { ok: true }
}

/** 通知 CS 停止观察（尽力而为：标签页可能已关闭） */
function detachObserver(r: Running | undefined, requestId: string): void {
  if (r?.tabId && r.tabId > 0) {
    chrome.tabs
      .sendMessage(r.tabId, { type: 'DETACH_OBSERVER', requestId, attempt: r.attempt })
      .catch(() => {})
  }
}

export async function cancelRequest(requestId: string): Promise<{ ok: boolean }> {
  const r = running.get(requestId)
  clearTimeoutOf(r)
  detachObserver(r, requestId)
  if (r) r.cancelled = true
  running.delete(requestId)
  const batch = await loadCurrentBatch()
  if (batch && patchTask(batch, requestId, { status: 'cancelled' })) {
    flushBatchNow(batch)
  }
  return { ok: true }
}

export async function cancelBatch(): Promise<{ ok: boolean }> {
  const batch = await loadCurrentBatch()
  if (!batch) return { ok: true }
  let changed = false
  for (const t of batch.tasks) {
    if (!isActiveStatus(t.status)) continue
    const r = running.get(t.requestId)
    clearTimeoutOf(r)
    detachObserver(r, t.requestId)
    if (r) r.cancelled = true
    running.delete(t.requestId)
    // 终态字段直接落内存，收尾一次性落盘 + 广播（避免 N 次 patchTask 的
    // storage 写与全量广播）
    t.status = 'cancelled'
    t.endedAt = Date.now()
    if (t.startedAt) t.durationMs = t.endedAt - t.startedAt
    changed = true
  }
  if (changed) {
    flushBatchNow(batch)
    broadcastSnapshot(batch)
  }
  return { ok: true }
}

/**
 * SW 启动时恢复：上一世代的活跃任务**不标记失败**——CS 里的 MutationObserver
 * 独立于 SW 存活，仍在上报事件；这里把任务重置为 generating（等待下一事件续上）。
 * 仅状态为 opening/waiting/submitting（SW 中断点）的任务标为 failed 可重试。
 * generating 任务重新挂 idle 看门狗（旧 timer 已随 SW 死亡，否则站点停止
 * 流式时任务会永久挂在 generating）。
 */
export async function recoverOrphans(): Promise<void> {
  const batch = await loadCurrentBatch()
  if (!batch) return
  let dirty = false
  for (const t of batch.tasks) {
    if (!isActiveStatus(t.status)) continue
    if (t.status === 'generating') {
      // 页面侧观察器还活着：保留任务（adoptRunningTasks 统一重建运行表并
      // 重挂看门狗），继续接收事件
      continue
    }
    t.status = 'failed'
    t.error = 'SW_RESTARTED'
    t.endedAt = Date.now()
    dirty = true
  }
  if (dirty) {
    await saveBatch(batch)
    broadcastSnapshot(batch)
  }
  adoptRunningTasks(batch)
}
