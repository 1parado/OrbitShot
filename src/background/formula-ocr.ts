/**
 * 公式识别 SW 侧编排（PRD §4.3.1）：纯路由——不跑推理、不解码图片。
 *
 * - offscreen document 懒创建（首次下载/识别时），单例；空闲不主动关闭
 *   （推理任务间隔短，关闭/重建成本高于常驻内存占用）；
 * - 识别请求 FIFO 排队（同一时刻仅 1 个推理），逐个转发给 offscreen；
 * - 下载/删除等状态变更转发；offscreen 的 ORC_* 回传转广播给所有 UI；
 * - SW 被杀：下载中断（offscreen 同灭，用户重试即可，R5）；ready 态模型在
 *   IndexedDB 不受影响。
 */
import type { FormulaModelState, FormulaOffscreenReply } from '../shared/formula-models'
import { FORMULA_MODEL_FILES } from '../shared/formula-models'
import { hasAllModelFiles } from './formula-model-store'

// vite 多页构建入口产出到 dist/src/background/（与 staging/sidepanel 同级）
const OFFSCREEN_URL = 'src/background/formula-offscreen.html'

let creating: Promise<void> | null = null

async function hasOffscreen(): Promise<boolean> {
  if (!chrome.runtime.getContexts) return false
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  return contexts.length > 0
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
        justification: 'Local LaTeX formula recognition (onnxruntime-web inference)',
      })
      .catch((e) => {
        // 并发创建时后到者报 EXISTING —— 视为成功
        if (!String(e).includes('EXISTING')) throw e
      })
      .then(() => {})
  }
  await creating
  creating = null
}

/** 派发消息到 offscreen（必要时先创建文档） */
async function sendToOffscreen(msg: Record<string, unknown>): Promise<void> {
  await ensureOffscreen()
  chrome.runtime.sendMessage(msg).catch(() => {})
}

// ---- 识别请求 FIFO 队列 ----

const pending: { requestId: string; dataUrl: string }[] = []
let inFlight = false

async function pumpQueue(): Promise<void> {
  if (inFlight) return
  const next = pending.shift()
  if (!next) return
  inFlight = true
  try {
    await sendToOffscreen({ type: 'ORC_RECOGNIZE', requestId: next.requestId, dataUrl: next.dataUrl })
  } finally {
    inFlight = false
    void pumpQueue()
  }
}

// ---- 模型状态查询（IndexedDB 存在性为事实来源；downloading 态在 SW 内存） ----

let downloadingNow = false

export async function getFormulaModelState(): Promise<FormulaModelState> {
  if (downloadingNow) return 'downloading'
  const ready = await hasAllModelFiles(FORMULA_MODEL_FILES.map((f) => f.name))
  return ready ? 'ready' : 'not-downloaded'
}

// ---- 事件回传处理（offscreen → 所有 UI 广播） ----

export function handleFormulaOffscreenReply(msg: FormulaOffscreenReply): void {
  switch (msg.type) {
    case 'ORC_STATE':
      if (msg.state !== 'downloading') downloadingNow = false
      chrome.runtime.sendMessage({ type: 'FORMULA_STATE', state: msg.state }).catch(() => {})
      break
    case 'ORC_PROGRESS':
      if (msg.progress.state === 'downloading') downloadingNow = true
      if (msg.progress.state === 'ready') downloadingNow = false
      chrome.runtime.sendMessage({ type: 'FORMULA_PROGRESS', progress: msg.progress }).catch(() => {})
      break
    case 'ORC_READY':
      downloadingNow = false
      chrome.runtime.sendMessage({ type: 'FORMULA_STATE', state: 'ready' }).catch(() => {})
      break
    case 'ORC_RESULT':
      chrome.runtime.sendMessage({ type: 'FORMULA_RESULT', ...msg }).catch(() => {})
      break
  }
}

// ---- content/Options → SW 的 FORMULA_* 入口（由 background/index.ts 调用） ----

export async function handleFormulaContentMsg(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case 'FORMULA_OCR': {
      const requestId = String(msg.requestId)
      const dataUrl = String(msg.dataUrl)
      const state = await getFormulaModelState()
      if (state === 'downloading') return { ok: false, error: 'MODEL_DOWNLOADING' }
      if (state !== 'ready') return { ok: false, error: 'MODEL_NOT_DOWNLOADED' }
      pending.push({ requestId, dataUrl })
      void pumpQueue()
      return { ok: true, queued: pending.length }
    }
    case 'FORMULA_MODEL_STATE':
      return { ok: true, state: await getFormulaModelState() }
    case 'FORMULA_MODEL_DOWNLOAD':
      downloadingNow = true
      await sendToOffscreen({ type: 'ORC_DOWNLOAD' })
      return { ok: true }
    case 'FORMULA_MODEL_CANCEL':
      downloadingNow = false
      await sendToOffscreen({ type: 'ORC_CANCEL' })
      return { ok: true }
    case 'FORMULA_MODEL_DELETE':
      await sendToOffscreen({ type: 'ORC_DELETE' })
      return { ok: true }
    default:
      return { ok: false, error: 'UNKNOWN_FORMULA_MSG' }
  }
}
