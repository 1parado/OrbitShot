/**
 * 多模型并行对比（Compare）集中消息协议与共享类型。
 *
 * 设计要点：
 * - 所有任务消息都带 type / batchId / requestId / aiId / attempt / timestamp，
 *   便于过滤迟到与过期事件（重试 attempt 递增，旧 attempt 的消息一律丢弃）。
 * - 状态持久化到 chrome.storage.local（BATCH 前缀 key），Service Worker 被杀后
 *   Side Panel 重开时仍能恢复任务元数据；回复正文只存 local（绝不进 sync）。
 * - SW 与 Side Panel 之间用 runtime.Port 长连接推送快照，避免高频
 *   sendMessage 的通道开销；断连由双方按 GET_BATCH_STATE 拉取兜底。
 */

// ---- 平台定义 ----

export type CompareAiId = 'chatgpt' | 'claude' | 'gemini'

export interface ComparePlatform {
  id: CompareAiId
  name: string
  url: string
}

/** 首期支持的三个平台（与现有 DEFAULT_AI_LIST 中的 id 对齐） */
export const COMPARE_PLATFORMS: ComparePlatform[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
]

// ---- 任务状态机 ----

/**
 * queued → opening_tab → waiting_cs → submitting → generating → completed
 * 任意状态可 → failed / timeout / cancelled
 */
export type CompareTaskStatus =
  | 'queued'
  | 'opening_tab'
  | 'waiting_cs'
  | 'submitting'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'

export const ACTIVE_STATUSES: CompareTaskStatus[] = [
  'queued',
  'opening_tab',
  'waiting_cs',
  'submitting',
  'generating',
]

export function isActiveStatus(s: CompareTaskStatus): boolean {
  return ACTIVE_STATUSES.includes(s)
}

// ---- 任务与批次 ----

export interface CompareTask {
  batchId: string
  requestId: string
  aiId: CompareAiId
  /** 重试时递增；旧 attempt 的消息一律忽略 */
  attempt: number
  status: CompareTaskStatus
  /** 流式回复快照（completed / generating 时有值） */
  response: string
  /** 生成完成的完整 Markdown 回复 */
  error?: string
  startedAt?: number
  endedAt?: number
  /** 消费于 UI：耗时展示 */
  durationMs?: number
  /** 该任务使用的标签页（重试可复用） */
  tabId?: number
}

export interface CompareBatch {
  batchId: string
  prompt: string
  createdAt: number
  tasks: CompareTask[]
}

// ---- 消息信封 ----

export interface CompareEnvelope {
  type: string
  batchId?: string
  requestId?: string
  aiId?: CompareAiId
  attempt?: number
  timestamp?: number
  payload?: unknown
}

// ---- SW ↔ Side Panel 消息（runtime.sendMessage / Port） ----

export type ComparePanelMsgType =
  | 'DISPATCH_BATCH'
  | 'RETRY_REQUEST'
  | 'CANCEL_REQUEST'
  | 'CANCEL_BATCH'
  | 'GET_BATCH_STATE'
  | 'BATCH_STATE_SNAPSHOT'
  | 'COMPARE_EVENTS' // Port 推送：状态变更 + 快照

export interface DispatchBatchPayload {
  prompt: string
  aiIds: CompareAiId[]
  /** 超时毫秒数（默认 120s） */
  timeoutMs?: number
}

export interface BatchStateSnapshot {
  ok: boolean
  batch?: CompareBatch
  error?: string
}

// ---- SW ↔ Content Script 消息（tabs.sendMessage） ----

export type CompareContentMsgType =
  | 'SUBMIT_PROMPT'
  | 'CANCEL_TASK'
  | 'COMPARE_PING'
  | 'DETACH_OBSERVER'

export interface SubmitPromptPayload {
  prompt: string
  requestId: string
  attempt: number
}

// ---- Content → SW 事件（runtime.sendMessage 上行） ----

export type CompareUpstreamType =
  | 'PROMPT_ACCEPTED'
  | 'GENERATION_STARTED'
  | 'RESPONSE_DELTA'
  | 'RESPONSE_SNAPSHOT'
  | 'GENERATION_COMPLETED'
  | 'GENERATION_FAILED'
  | 'CONTENT_UNAVAILABLE' // 页面刷新 / 导航 / CS 失效

/** Port 名称与 storage key 约定 */
export const COMPARE_PORT = 'orbitshot-compare'
export const COMPARE_STORAGE_PREFIX = 'orbitshot.compare.'
export const COMPARE_CURRENT_KEY = COMPARE_STORAGE_PREFIX + 'current'
export const COMPARE_HISTORY_KEY = COMPARE_STORAGE_PREFIX + 'history'

/** 单次任务默认超时 */
export const DEFAULT_TASK_TIMEOUT_MS = 120_000
