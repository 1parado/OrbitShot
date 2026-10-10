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
  isActiveStatus,
  platformsFromAiList,
} from '../../shared/compare-types'
import type { ComparePlatform } from '../../shared/compare-types'
import { ensureAiTab, waitTabComplete, pingCompareCs } from './tab-manager'

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

/** 更新单个任务并落盘推送；返回 false 表示 batch/request 已不存在 */
async function patchTask(
  batch: CompareBatch,
  requestId: string,
  patch: Partial<CompareTask> & { status?: CompareTaskStatus }
): Promise<boolean> {
  const t = taskOf(batch, requestId)
  if (!t) return false
  Object.assign(t, patch)
  if (patch.status && !patch.durationMs && (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'timeout' || patch.status === 'cancelled')) {
    t.endedAt = Date.now()
    if (t.startedAt) t.durationMs = t.endedAt - t.startedAt
  }
  await saveBatch(batch)
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
}
const running = new Map<string, Running>() // key = requestId

function clearTimeoutOf(r: Running | undefined) {
  if (r?.timer) clearTimeout(r.timer)
}

// ---- 主入口：DISPATCH_BATCH ----

/** 平台表：从用户 AI 设置构建（启用项），带短缓存 */
let platformCache: { at: number; list: ComparePlatform[] } | null = null
async function getPlatforms(): Promise<ComparePlatform[]> {
  if (platformCache && Date.now() - platformCache.at < 5000) return platformCache.list
  const { loadSettings } = await import('../../shared/settings')
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
    })),
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

/** 单任务全生命周期：开页 → 等 CS → 提交 → 等流式事件（事件驱动，非轮询） */
async function runTask(batch: CompareBatch, task: CompareTask, timeoutMs: number): Promise<void> {
  const requestId = task.requestId
  const r: Running = { batch, requestId, attempt: task.attempt, tabId: -1 }
  running.set(requestId, r)

  try {
    // 1) opening_tab
    await patchTask(batch, requestId, { status: 'opening_tab' })
    const platforms = await getPlatforms()
    const platform = platforms.find((p) => p.id === task.aiId)
    if (!platform) throw new Error('PLATFORM_REMOVED')
    const tab = await ensureAiTab(platform)
    // 标签页在开页阶段被用户关闭
    if (r.cancelled) return
    r.tabId = tab.tabId
    await patchTask(batch, requestId, { tabId: tab.tabId })

    // 2) waiting_cs：等页面加载 + 对比 CS 模块就绪
    await patchTask(batch, requestId, { status: 'waiting_cs' })
    try {
      await waitTabComplete(tab.tabId, 20_000)
    } catch {
      throw new Error('TAB_CLOSED')
    }
    const ready = await pingCompareCs(tab.tabId, 20, 250) // ~5s
    if (r.cancelled) return
    if (!ready) throw new Error('CS_NOT_READY')

    // 3) submitting：发送提交指令（PROMPT_ACCEPTED / GENERATION_* 由上行事件驱动）
    await patchTask(batch, requestId, { status: 'submitting' })
    const resp = (await chrome.tabs.sendMessage(tab.tabId, {
      type: 'SUBMIT_PROMPT',
      batchId: batch.batchId,
      requestId,
      aiId: task.aiId,
      attempt: task.attempt,
      timestamp: Date.now(),
      payload: { prompt: batch.prompt, requestId, attempt: task.attempt, aiId: task.aiId },
    })) as { ok: boolean; error?: string } | undefined
    if (r.cancelled) return
    if (!resp?.ok) throw new Error(resp?.error || 'SUBMIT_FAILED')

    // 4) 超时看门狗：整个生成阶段共享一个计时器
    r.timer = setTimeout(() => {
      void handleTimeout(batch, requestId)
    }, timeoutMs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (r.cancelled) return
    // 归类：标签页被关 → failed（用户可重试）
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
  await patchTask(batch, requestId, { status: 'timeout', error: 'TIMEOUT' })
}

async function finalizeFailed(batch: CompareBatch, requestId: string, error: string): Promise<void> {
  const r = running.get(requestId)
  clearTimeoutOf(r)
  running.delete(requestId)
  const t = taskOf(batch, requestId)
  if (!t || !isActiveStatus(t.status)) return
  await patchTask(batch, requestId, { status: 'failed', error })
}

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

export async function handleUpstream(msg: UpstreamMsg): Promise<void> {
  const v = validUpstream(msg)
  if (!v) return
  const { r, batch } = v
  const requestId = msg.requestId!
  const p = (msg.payload ?? {}) as { text?: string; error?: string }

  switch (msg.type) {
    case 'PROMPT_ACCEPTED':
      // CS 已确认问题真实进入输入区（尚未点发送 / 或已发送）
      await patchTask(batch, requestId, { status: 'submitting' })
      break
    case 'GENERATION_STARTED':
      await patchTask(batch, requestId, {
        status: 'generating',
        startedAt: Date.now(),
        response: '',
      })
      break
    case 'RESPONSE_DELTA': {
      const t = taskOf(batch, requestId)
      if (!t) return
      // delta 语义：CS 侧保证按序增量追加，这里只做拼接
      await patchTask(batch, requestId, {
        status: t.status === 'completed' ? 'completed' : 'generating',
        response: t.response + (p.text ?? ''),
      })
      break
    }
    case 'RESPONSE_SNAPSHOT': {
      // snapshot 语义：整体覆盖（DOM 重挂载 / 分段重渲染时用）
      await patchTask(batch, requestId, { response: p.text ?? '' })
      break
    }
    case 'GENERATION_COMPLETED':
      clearTimeoutOf(r)
      running.delete(requestId)
      await patchTask(batch, requestId, { status: 'completed', response: p.text ?? '' })
      // 全部任务落定后归档
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
  await archiveBatch(batch)
}

// ---- 重试 / 取消 ----

export async function retryRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  const batch = await loadCurrentBatch()
  if (!batch) return { ok: false, error: 'NO_BATCH' }
  const old = taskOf(batch, requestId)
  if (!old) return { ok: false, error: 'NO_TASK' }
  if (isActiveStatus(old.status)) return { ok: false, error: 'STILL_RUNNING' }

  // 重试 = 新 attempt 的全新任务；旧记录的迟到事件因 attempt 不匹配被丢弃
  const task: CompareTask = {
    ...old,
    attempt: old.attempt + 1,
    status: 'queued',
    response: '',
    error: undefined,
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
  }
  old.status = task.status
  old.attempt = task.attempt
  old.response = ''
  old.error = undefined
  old.startedAt = undefined
  old.endedAt = undefined
  old.durationMs = undefined
  await saveBatch(batch)
  broadcastSnapshot(batch)
  runTask(batch, task, DEFAULT_TASK_TIMEOUT_MS).catch((e) => {
    console.error('[compare] retry crashed', task.aiId, e)
  })
  return { ok: true }
}

export async function cancelRequest(requestId: string): Promise<{ ok: boolean }> {
  const r = running.get(requestId)
  clearTimeoutOf(r)
  const batch = await loadCurrentBatch()
  if (batch) {
    // 通知 CS 停止观察（尽力而为）
    if (r?.tabId && r.tabId > 0) {
      try {
        await chrome.tabs.sendMessage(r.tabId, {
          type: 'DETACH_OBSERVER',
          requestId,
          attempt: r.attempt,
        })
      } catch {
        /* 忽略 */
      }
    }
    const t = taskOf(batch, requestId)
    if (t && isActiveStatus(t.status)) {
      await patchTask(batch, requestId, { status: 'cancelled' })
    }
  }
  if (r) r.cancelled = true
  running.delete(requestId)
  return { ok: true }
}

export async function cancelBatch(): Promise<{ ok: boolean }> {
  const batch = await loadCurrentBatch()
  if (!batch) return { ok: true }
  for (const t of batch.tasks) {
    if (isActiveStatus(t.status)) await cancelRequest(t.requestId)
  }
  return { ok: true }
}

/** SW 启动时清理：把上一世代的活跃任务标记为 failed（元数据仍在，可重试） */
export async function recoverOrphans(): Promise<void> {
  const batch = await loadCurrentBatch()
  if (!batch) return
  let dirty = false
  for (const t of batch.tasks) {
    if (isActiveStatus(t.status)) {
      t.status = 'failed'
      t.error = 'SW_RESTARTED'
      t.endedAt = Date.now()
      dirty = true
    }
  }
  if (dirty) {
    await saveBatch(batch)
    broadcastSnapshot(batch)
  }
}
