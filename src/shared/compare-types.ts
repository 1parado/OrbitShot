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

/** 对比支持的平台 id = 内置 AI 列表的 id（与 settings.DEFAULT_AI_LIST 对齐，含自定义项） */
export type CompareAiId = string

export interface ComparePlatform {
  id: string
  name: string
  url: string
}

/**
 * 从用户 AI 列表构建对比平台表：仅保留启用的项。
 * Side Panel 平台选择器与 dispatcher 都以此为准——对比覆盖全部内置 AI 与自定义 AI。
 */
export function platformsFromAiList(aiList: { id: string; name: string; url: string; enabled: boolean }[]): ComparePlatform[] {
  return aiList
    .filter((s) => s.enabled)
    .map((s) => ({ id: s.id, name: s.name, url: s.url }))
}

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
  /**
   * 思考/推理过程（独立于正文；DOM 抓取路径由平台 thinking 探针分离，
   * 与 grok2api ChatStreamSnapshot.reasoning 同构）。空串 = 无思考内容。
   */
  thinking: string
  /** 回答中的图片 URL 列表（DOM 抓取路径提取；不含 data: 内嵌） */
  images: string[]
  /** 生成完成的完整 Markdown 回复 */
  error?: string
  startedAt?: number
  endedAt?: number
  /** 消费于 UI：耗时展示 */
  durationMs?: number
  /** 该任务使用的标签页（重试可复用） */
  tabId?: number
  /**
   * 多轮对话：本任务所属轮次（从 1 起）。追问会在同一批 tasks 数组中
   * 追加新任务（新 requestId，同 aiId，turn+1），旧轮任务保留供 UI 展示历史。
   */
  turn?: number
  /** 本轮的追问文本（turn >= 2 时有值；turn 1 即 batch.prompt） */
  turnPrompt?: string
}

export interface CompareBatch {
  batchId: string
  /** 第一轮的问题 */
  prompt: string
  createdAt: number
  tasks: CompareTask[]
  /**
   * 多轮对话历史（扁平序，用于在 AI 页面侧理解上下文——实际上下文由
   * 各 AI 站点自己的会话保持，这里主要用于 UI 展示与「新标签页冷启动」时
   * 把历史一次性拼接提交）。
   */
  turns?: { turn: number; prompt: string; askedAt: number; attachments?: CompareAttachment[] }[]
  /** 当前最新轮次（从 1 起） */
  currentTurn?: number
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
  | 'FOLLOWUP_BATCH' // 多轮追问：同一批平台在既有会话上继续提问
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

/** 追问载荷：batchId 定位现有批次，prompt 为本轮问题 */
export interface FollowupPayload {
  batchId: string
  prompt: string
  timeoutMs?: number
  /** 随追问一起注入各平台的附件（图片/文件，dataUrl 传输） */
  attachments?: CompareAttachment[]
}

/**
 * 随问题批量发送的附件（图片 / PDF / 文档等任意 MIME）。
 * 传输用 dataUrl；注入端转 File 走 paste 通道（各 AI 站输入框的通用
 * 受支持交互，参考 grok2api asset_upload：官方通道收 fileName+MIME+base64，
 * 任意类型同构，网页侧即 paste 任意 File）。
 */
export interface CompareAttachment {
  /** 原始文件名（注入端用它构造 File，站点展示附件名） */
  name: string
  /** MIME 类型（如 image/png、application/pdf） */
  mime: string
  /** base64 dataUrl（含前缀） */
  dataUrl: string
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

/** 上行事件 payload：结构化回答快照（text 为兼容旧字段，恒等于 content） */
export interface CompareAnswerPayload {
  /** 正式回答 markdown */
  content?: string
  /** 思考/推理过程（独立于正文） */
  thinking?: string
  /** 回答中的图片 URL */
  images?: string[]
  /** 兼容旧协议：等价于 content */
  text?: string
  error?: string
}

/** Port 名称与 storage key 约定 */
export const COMPARE_PORT = 'orbitshot-compare'
export const COMPARE_STORAGE_PREFIX = 'orbitshot.compare.'
export const COMPARE_CURRENT_KEY = COMPARE_STORAGE_PREFIX + 'current'
export const COMPARE_HISTORY_KEY = COMPARE_STORAGE_PREFIX + 'history'

/**
 * 生成阶段超时语义（双层）：
 * - idle 超时：距最后一次流式增量 45s 无更新 → 判超时（流式正常推进的任务永不误杀）；
 * - 总时长上限：整个生成阶段最多 600s（DeepSeek R1 思考 + 长回答的保守上限；
 *   思考/正文心跳会持续续期 idle，总上限只防真正的无限挂起）。
 * 提交链路（开页/等CS/提交）超时由各阶段自身等待窗口约束，不走看门狗。
 * 「AI 长时间不回复」的真静默场景由 CS 侧 DOM 活动检测报 NO_RESPONSE，
 * 不依赖时间猜测。
 */
export const IDLE_TIMEOUT_MS = 45_000
export const MAX_GENERATION_MS = 600_000
/** 兼容旧引用：任务级默认超时（现仅作为 dispatchBatch 的入参缺省） */
export const DEFAULT_TASK_TIMEOUT_MS = IDLE_TIMEOUT_MS
