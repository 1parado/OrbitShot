/**
 * Compare 标签页管理：优先复用同源 AI 标签页，否则后台新建。
 * 复用策略与现有 background/index.ts 的 handleSendToAi 一致，但对比功能
 * 不激活已有标签页（用户可能正在别的页面工作），仅在无复用对象时静默新建。
 */
import type { ComparePlatform } from '../../shared/compare-types'

export interface ManagedTab {
  tabId: number
  reused: boolean
}

/** 查找已打开的同源标签页（含 pendingUrl；忽略 hash 与查询串差异） */
export async function findReusableTab(url: string): Promise<number | undefined> {
  let origin: string
  let pathname: string
  try {
    const u = new URL(url)
    origin = u.origin
    pathname = u.pathname
  } catch {
    return undefined
  }
  const tabs = await chrome.tabs.query({})
  const match = tabs.find((x) => {
    const u2raw = x.url || x.pendingUrl || ''
    if (!u2raw.startsWith(origin)) return false
    let p: URL
    try {
      p = new URL(u2raw)
    } catch {
      return false
    }
    // Gemini 等入口带子路径：路径前缀一致即视为同页面
    return p.pathname === pathname || p.pathname.startsWith(pathname === '/' ? '/' : pathname)
  })
  return match?.id
}

/** 确保目标平台有可用标签页：复用优先，否则后台新建（不抢焦点） */
export async function ensureAiTab(platform: ComparePlatform): Promise<ManagedTab> {
  const reused = await findReusableTab(platform.url)
  if (reused) return { tabId: reused, reused: true }
  const tab = await chrome.tabs.create({ url: platform.url, active: false })
  if (!tab.id) throw new Error('create tab failed')
  return { tabId: tab.id, reused: false }
}

/** 等待标签页加载完成（软超时不阻塞——CS 侧还会继续等编辑器） */
export async function waitTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t.status === 'complete') {
        await new Promise((r) => setTimeout(r, 600)) // SPA 水合缓冲
        return
      }
    } catch {
      throw new Error('TAB_CLOSED') // 标签页被用户关闭
    }
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** PING content script（对比模块监听器），探测其是否就绪 */
export async function pingCompareCs(tabId: number, tries: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'COMPARE_PING' })
      return true
    } catch {
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return false
}
