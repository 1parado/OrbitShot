/**
 * Compare 侧边栏 ↔ SW 通信服务。
 * - 命令走 chrome.runtime.sendMessage（一次性请求/响应）
 * - 状态推送走 runtime.Port 长连接（BATCH_STATE_SNAPSHOT），断连自动重连
 */
import type { CompareBatch, CompareAiId, BatchStateSnapshot } from '../../shared/compare-types'
import { COMPARE_PORT } from '../../shared/compare-types'

export async function dispatchBatch(payload: {
  prompt: string
  aiIds: CompareAiId[]
}): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  return chrome.runtime.sendMessage({ type: 'DISPATCH_BATCH', payload })
}

export function retryRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  return chrome.runtime.sendMessage({ type: 'RETRY_REQUEST', requestId })
}

export function cancelRequest(requestId: string): Promise<{ ok: boolean }> {
  return chrome.runtime.sendMessage({ type: 'CANCEL_REQUEST', requestId })
}

export function cancelBatch(): Promise<{ ok: boolean }> {
  return chrome.runtime.sendMessage({ type: 'CANCEL_BATCH' })
}

export function getBatchState(): Promise<BatchStateSnapshot> {
  return chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' })
}

/** Port 订阅：返回取消订阅函数。断连后自动重连（SW 唤醒后端口失效场景）。 */
export function connectPort(onBatch: (b: CompareBatch | undefined) => void): () => void {
  let port: chrome.runtime.Port | null = null
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    port = chrome.runtime.connect({ name: COMPARE_PORT })
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'BATCH_STATE_SNAPSHOT') onBatch(msg.batch)
    })
    port.onDisconnect.addListener(() => {
      if (closed) return
      // SW 休眠 / 重启：1s 后重连，重连后主动拉一次状态
      retryTimer = setTimeout(() => {
        connect()
        getBatchState()
          .then((s) => s?.ok && onBatch(s.batch))
          .catch(() => {})
      }, 1000)
    })
  }
  connect()
  // 首次拉取
  getBatchState()
    .then((s) => s?.ok && onBatch(s.batch))
    .catch(() => {})

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    try {
      port?.disconnect()
    } catch {
      /* 已断开 */
    }
  }
}
