// Service Worker: 截图 captureVisibleTab + AI 图片注入 + 快捷键 + 右键菜单 + 按需注入 content script
// + 截图暂存区（IndexedDB：入队 / 计数；读取与整理由扩展页直连同源库）
import { loadSettings } from '../shared/settings'
import { t } from '../shared/dicts'
import type { Lang } from '../shared/settings'
import { injectAiImages } from './ai-injector'
import type { InjectResult } from './ai-injector'
import { addShot, getShot, countShots, blobToDataUrl, MAX_SHOTS } from './shots'
import { pingTab, ensureContentScript } from './cs-utils'
import {
  dispatchBatch,
  retryRequest,
  cancelRequest,
  cancelBatch,
  handleUpstream,
  attachComparePort,
  recoverOrphans,
  loadCurrentBatch,
  attachScreenshotTask,
  finishScreenshotBatch,
  setPanelOpener,
} from './compare/dispatcher'
import type {
  DispatchBatchPayload,
  BatchStateSnapshot,
} from '../shared/compare-types'

export interface CaptureResp {
  ok: boolean
  dataUrl?: string
  error?: string
}

// 完全无法注入 content script 的受限地址（内部页 / 特殊协议 / 商店页）
const RESTRICTED_RE =
  /^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|view-source|data|blob|file|javascript):/i
const WEBSTORE_RE = /^https?:\/\/([\w-]+\.)?chromewebstore\.google\.com|^https?:\/\/chrome\.google\.com\/webstore/i

/** 检查地址是否可注入，不可注入时返回给用户看的提示 */
function restrictedReason(url: string): string | null {
  if (RESTRICTED_RE.test(url)) {
    if (url.startsWith('file:')) {
      return 'file:// 本地文件需要先在扩展详情里开启「允许访问文件网址」'
    }
    return '浏览器内部页面（新标签页、设置页等）无法截图，请切换到普通网页'
  }
  if (WEBSTORE_RE.test(url)) {
    return 'Chrome 商店页面禁止扩展注入，无法截图'
  }
  return null
}

/** 带 PING 的等待：content script（模块）注册消息监听器是异步的，需要稍作轮询 */


async function handleRun(type: 'RUN_FLOW' | 'RUN_FULLPAGE'): Promise<{ ok: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { ok: false, error: '找不到活动标签页' }
  const url = tab.url || tab.pendingUrl || ''
  const reason = restrictedReason(url)
  if (reason) return { ok: false, error: reason }
  // URL 还没拿到（页面导航中）时也先尝试注入，失败会给出具体原因
  const ready = await ensureContentScript(tab.id)
  if (!ready.ok) return { ok: false, error: ready.error }
  try {
    await chrome.tabs.sendMessage(tab.id, { type })
    return { ok: true }
  } catch {
    return { ok: false, error: '通信失败，请刷新页面后重试' }
  }
}

interface SendToAiMsg {
  type: 'SEND_TO_AI' | 'SEND_TO_AI_BATCH'
  url: string
  name: string
  /** 单图（content 流程直接带 dataUrl） */
  dataUrl?: string
  /** 多图（暂存区批量分发：只传 id，图片由 SW 从 IndexedDB 读取，避免大体积过消息通道） */
  shotIds?: string[]
  /**
   * 多平台批量发送上下文（content 确认批量时生成）：
   * aiIds = 本批全部平台；batchKey = 批次标识；prompt = 用户当场输入的问题
   * （空串 = 用户未输入，走纯批量注入，不进对比）。
   */
  batchSend?: { aiIds: string[]; batchKey: string; prompt: string }
}

/** 软等待标签页加载完成（超时不阻塞——注入函数内部还会轮询编辑器就绪） */
async function waitTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t.status === 'complete') {
        // SPA 水合需要一点时间，注入函数会继续轮询编辑器
        await new Promise((r) => setTimeout(r, 600))
        return
      }
    } catch {
      return // 标签页被关闭
    }
    if (Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function handleSendToAi(msg: SendToAiMsg): Promise<{ ok: boolean; status?: InjectResult['status']; detail?: string; error?: string }> {
  try {
    // 0) 汇总待注入图片：单图直取；批量按暂存记录顺序从 IndexedDB 读取
    const dataUrls: string[] = []
    if (msg.dataUrl) {
      dataUrls.push(msg.dataUrl)
    }
    if (Array.isArray(msg.shotIds)) {
      for (const id of msg.shotIds) {
        const rec = await getShot(id)
        if (rec?.blob) dataUrls.push(await blobToDataUrl(rec.blob))
      }
    }
    if (!dataUrls.length) return { ok: false, error: '没有可发送的截图' }

    // 1) 复用同源标签页（激活并聚焦），否则新建
    const origin = new URL(msg.url).origin
    const tabs = await chrome.tabs.query({ url: origin + '/*' })
    let tab = tabs.find((x) => x.id)
    let tabId: number
    if (tab?.id) {
      tabId = tab.id
      chrome.tabs.update(tabId, { active: true })
      if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    } else {
      tab = await chrome.tabs.create({ url: msg.url, active: true })
      tabId = tab.id!
    }

    // 2) 等页面加载完，再注入适配器（等编辑器 → 逐张合成 paste → 验证预览数量）
    await waitTabComplete(tabId, 20000)
    const { lang } = await loadSettings() // 页内提示 pill 跟随扩展语言设置
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectAiImages,
      args: [dataUrls, 30000, lang ?? 'zh-CN'],
    })
    const r = results?.[0]?.result as InjectResult | undefined
    // 多模型对比：批量（≥2 平台）且开关开启且有问题时，注入截图成功 → 同标签页提交问题并观察
    if (okStatus(r?.status) && msg.batchSend) {
      await noteCompareBatch(msg.batchSend, tabId, msg.url)
    }
    return { ok: true, status: r?.status ?? 'error', detail: r?.detail }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function okStatus(s?: InjectResult['status']): boolean {
  return s === 'inserted' || s === 'pasted-unverified'
}

/** 按 URL 匹配用户 AI 列表中的平台 id（所有站均支持自动提交文本） */
async function compareAiIdForUrl(url: string): Promise<string | null> {
  try {
    const target = new URL(url)
    const s = await loadSettings()
    const hit = s.aiList.find((a) => {
      try {
        const u = new URL(a.url)
        return u.hostname === target.hostname
      } catch {
        return false
      }
    })
    return hit?.id ?? null
  } catch {
    return null
  }
}

/**
 * 对比模式核心：截图已注入该站标签页 → 在同一页提交用户问题并开始观察回答。
 * 所有 AI 站均支持（aiId 由用户列表按 url 匹配，含自定义站）。
 * 失败只标记该站任务，不影响其他站；compareMode 关闭 / 无问题文本时直接跳过（原行为）。
 */
async function noteCompareBatch(
  batch: { aiIds: string[]; batchKey: string; prompt: string },
  tabId: number,
  url: string
): Promise<void> {
  try {
    const s = await loadSettings()
    if (s.compareMode !== true) return
    if (!batch.prompt) return // 用户没输入问题：纯批量注入（原行为），不进对比
    const aiId = await compareAiIdForUrl(url)
    if (!aiId) {
      console.info('[compare] site not in AI list, skip text submit:', url)
      return
    }
    const out = await attachScreenshotTask({
      aiId,
      prompt: batch.prompt,
      tabId,
      batchKey: batch.batchKey,
    })
    if (!out.ok) console.warn('[compare] attach task failed:', out.error)
  } catch (e) {
    console.warn('[compare] noteCompareBatch error:', e)
  }
}

/** 暂存区入队（content 流程「存入暂存」调用）：不覆盖已有记录，容量满时明确报错 */
async function handleSaveShot(msg: {
  dataUrl: string
  baseDataUrl: string
  width: number
  height: number
  anns: unknown[]
}): Promise<{ ok: boolean; id?: string; count?: number; error?: string }> {
  try {
    const count = await countShots()
    if (count >= MAX_SHOTS) {
      return { ok: false, error: 'FULL:' + MAX_SHOTS, count }
    }
    const blob = await (await fetch(msg.dataUrl)).blob()
    const baseBlob = await (await fetch(msg.baseDataUrl)).blob()
    const id = await addShot({
      blob,
      baseBlob,
      width: msg.width,
      height: msg.height,
      anns: Array.isArray(msg.anns) ? msg.anns : [],
    })
    return { ok: true, id, count: count + 1 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {  if (msg?.type === 'CAPTURE_VISIBLE') {
    const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT
    chrome.tabs
      .captureVisibleTab(windowId, { format: 'png' })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true // async
  }

  if (msg?.type === 'OPEN_AI') {
    chrome.tabs.create({ url: msg.url, active: true })
    sendResponse({ ok: true })
    return
  }

  // 自动把截图注入目标 AI 页面的输入区（复用已打开标签页，否则新建）
  // SEND_TO_AI = 单图；SEND_TO_AI_BATCH = 暂存区多图（按 shotIds 从 IndexedDB 读取）
  if (msg?.type === 'SEND_TO_AI' || msg?.type === 'SEND_TO_AI_BATCH') {
    handleSendToAi(msg as SendToAiMsg)
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true // async
  }

  // 多平台批量发送结束：有对比任务登记时打开面板（纯注入批次不打开）
  if (msg?.type === 'COMPARE_BATCH_DONE') {
    finishScreenshotBatch(String(msg.batchKey || ''))
      .then(async (hasTasks) => {
        if (hasTasks) await openCompareSidePanel()
        sendResponse({ ok: true })
      })
      .catch(() => sendResponse({ ok: true }))
    return true
  }

  // 截图暂存区：入队 + 计数（列表/删除/排序/编辑由扩展页直连同源 IndexedDB）
  if (msg?.type === 'SAVE_SHOT') {
    handleSaveShot(msg)
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === 'STASH_COUNT') {
    countShots()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }

  if (msg?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage()
    sendResponse({ ok: true })
    return
  }

  if (msg?.type === 'RUN_FLOW' || msg?.type === 'RUN_FULLPAGE') {
    handleRun(msg.type).then(sendResponse)
    return true // async
  }

  // ---- 多模型对比（Compare）----

  // CS 上行事件：PROMPT_ACCEPTED / GENERATION_* / RESPONSE_* / CONTENT_UNAVAILABLE
  const COMPARE_UPSTREAM = new Set(['PROMPT_ACCEPTED', 'RESPONSE_DELTA', 'RESPONSE_SNAPSHOT', 'CONTENT_UNAVAILABLE'])
  if ((typeof msg?.type === 'string' && (msg.type.startsWith('GENERATION_') || COMPARE_UPSTREAM.has(msg.type)))) {
    handleUpstream(msg).catch(() => {})
    return // 上行事件不需要响应体
  }

  if (msg?.type === 'DISPATCH_BATCH') {
    dispatchBatch(msg.payload as DispatchBatchPayload)
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === 'RETRY_REQUEST') {
    retryRequest(msg.requestId)
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === 'CANCEL_REQUEST') {
    cancelRequest(msg.requestId)
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === 'CANCEL_BATCH') {
    cancelBatch()
      .then(sendResponse)
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
  if (msg?.type === 'GET_BATCH_STATE') {
    loadCurrentBatch()
      .then((batch) => sendResponse({ ok: true, batch } satisfies BatchStateSnapshot))
      .catch((e: Error) => sendResponse({ ok: false, error: String(e?.message || e) }))
    return true
  }
})

// 快捷键：Alt+Shift+S 截图（按需注入）/ Alt+Shift+O 打开暂存区（已打开则聚焦该标签页）
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-staging') {
    const url = chrome.runtime.getURL('src/staging/index.html')
    const all = await chrome.tabs.query({})
    const existing = all.find((x) => (x.url || x.pendingUrl || '').split('#')[0] === url)
    if (existing?.id) {
      chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true }).catch(() => {})
    } else {
      chrome.tabs.create({ url })
    }
    return
  }
  if (command !== 'take-screenshot') return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  const reason = restrictedReason(tab.url || tab.pendingUrl || '')
  if (reason) return
  const ready = await ensureContentScript(tab.id)
  if (!ready.ok) return
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RUN_FLOW' })
  } catch {
    // 忽略
  }
})

// 设置页录制的暂存区快捷键 → 同步到 Chrome 原生命令（空字符串 = 清除/恢复默认）
// 注：当前 @types/chrome 未含 commands.update，用最小断言
type CommandsApi = { update: (name: string, details: { shortcut?: string }) => Promise<void> }
async function applyStashHotkey() {
  try {
    const s = await loadSettings()
    await (chrome.commands as unknown as CommandsApi).update('open-staging', { shortcut: s.stashHotkey || '' })
  } catch {
    /* 组合键不合法或 API 异常：保持现状 */
  }
}
applyStashHotkey()
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') applyStashHotkey()
})

// ---- 右键菜单：OrbitShot → 区域截图 / 整页截图（标题跟随语言设置） ----

const MENU_ROOT = 'orbitshot-root'
const MENU_REGION = 'orbitshot-region'
const MENU_FULLPAGE = 'orbitshot-fullpage'
// 覆盖页面任意位置的右键（普通区域/链接/图片/选中文本/媒体等）
const MENU_CONTEXTS: chrome.contextMenus.ContextType[] = [
  'page',
  'frame',
  'link',
  'image',
  'selection',
  'video',
  'audio',
]

async function rebuildContextMenus(): Promise<void> {
  const s = await loadSettings()
  const lang: Lang = s.lang ?? 'zh-CN'
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ROOT, title: 'OrbitShot', contexts: MENU_CONTEXTS })
    chrome.contextMenus.create({
      id: MENU_REGION,
      parentId: MENU_ROOT,
      title: t(lang, 'menu.region'),
      contexts: MENU_CONTEXTS,
    })
    chrome.contextMenus.create({
      id: MENU_FULLPAGE,
      parentId: MENU_ROOT,
      title: t(lang, 'menu.fullpage'),
      contexts: MENU_CONTEXTS,
    })
  })
}

chrome.runtime.onInstalled.addListener(() => {
  rebuildContextMenus()
})

// ---- Side Panel（多模型对比工作台）----
// 用户点击工具栏图标时打开侧边栏；SW 重启时恢复上一世代未完成任务状态
chrome.runtime.onConnect.addListener(attachComparePort)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {})
// 对比首站登记成功即开面板（dispatcher 回调，避免跨模块依赖 sidePanel）
setPanelOpener(() => {
  openCompareSidePanel().catch((e) => console.warn('[compare] panel open failed:', e))
})
recoverOrphans()

/**
 * 打开对比面板：优先 Side Panel（同窗口），失败回退为独立标签页。
 * sidePanel.open 要求用户手势且不接受 WINDOW_ID_CURRENT 伪 ID——批量注入
 * 在后台跑了几十秒后调用基本无手势，因此标签页回退是常态路径，不是异常。
 */
async function openCompareSidePanel(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId })
      return
    }
  } catch (e) {
    console.warn('[compare] sidePanel.open failed, falling back to tab:', e)
  }
  // 回退：独立标签页（同暂存区模式）。已有面板标签页则聚焦
  try {
    const url = chrome.runtime.getURL('src/sidepanel/index.html')
    const all = await chrome.tabs.query({})
    const existing = all.find((x) => (x.url || x.pendingUrl || '').split('#')[0] === url)
    if (existing?.id) {
      chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true }).catch(() => {})
    } else {
      chrome.tabs.create({ url })
    }
  } catch (e) {
    console.error('[compare] open panel tab failed:', e)
  }
}

// 语言变化时同步重建右键菜单标题
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['orbitshot.settings']) rebuildContextMenus()
})

/** 页面内轻量 toast（content script 尚未就绪时用于报错提示） */
function pageToast(tabId: number, text: string): void {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (msg: string) => {
        const d = document.createElement('div')
        d.textContent = msg
        d.style.cssText =
          'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.92);color:#f8fafc;padding:10px 18px;border-radius:10px;z-index:2147483647;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);'
        document.body.appendChild(d)
        setTimeout(() => d.remove(), 2800)
      },
      args: [text],
    })
    .catch(() => {
      // 页面连脚本都注入不了，无 UI 可用，静默
    })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const type =
    info.menuItemId === MENU_REGION
      ? 'RUN_FLOW'
      : info.menuItemId === MENU_FULLPAGE
        ? 'RUN_FULLPAGE'
        : null
  if (!type || !tab?.id) return
  const reason = restrictedReason(tab.url || tab.pendingUrl || '')
  if (reason) {
    pageToast(tab.id, reason)
    return
  }
  const ready = await ensureContentScript(tab.id)
  if (!ready.ok) {
    pageToast(tab.id, ready.error ?? '截图启动失败')
    return
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type })
  } catch {
    pageToast(tab.id, '通信失败，请刷新页面后重试')
  }
})
