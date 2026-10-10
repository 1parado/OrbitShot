// OrbitShot 内容脚本入口：编排 截图 → 标注 → 环形菜单 → AI 路由
import cssText from './content.css?inline'
import { startSelection, cropCanvas } from './selector'
import type { SelRect } from './selector'
import { startAnnotator } from './annotator'
import type { Ann } from './annotator'
import { showRadial, RADIAL_ICON } from './radial'
import type { RadialItem } from './radial'
import { captureFullPage } from './fullpage'
import { loadSettings, iconForSite, faviconCandidates, comboFromEvent } from '../shared/settings'
import type { AiSite, Lang } from '../shared/settings'
import { t } from '../shared/i18n'
import { initCompareContent } from './compare/compare-entry'

// 多模型对比模块：仅在 ChatGPT / Claude / Gemini 页面注册监听（内部自行判断 host）
initCompareContent()

let host: HTMLDivElement | null = null
let shadow: ShadowRoot | null = null
let active = false

// 语言与自定义快捷键缓存（storage 变化时自动刷新）
let lang: Lang = 'zh-CN'
let hotkey = ''
function refreshCache() {
  loadSettings().then((s) => {
    lang = s.lang ?? 'zh-CN'
    hotkey = s.hotkey ?? ''
  })
}
refreshCache()
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') refreshCache()
  })
}

function ensureShadow(): ShadowRoot {
  if (!host || !document.documentElement.contains(host)) {
    host = document.createElement('div')
    host.id = 'orbitshot-root'
    host.style.cssText = 'position:fixed;width:0;height:0;z-index:2147483647;'
    document.documentElement.appendChild(host)
    shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = cssText
    shadow.appendChild(style)
  }
  return shadow!
}

// ---- 基础能力 ----

async function requestCapture(): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE' })) as {
    ok: boolean
    dataUrl?: string
    error?: string
  }
  if (!resp?.ok || !resp.dataUrl) throw new Error(resp?.error || 'captureVisibleTab 失败')
  return resp.dataUrl
}

function loadImg(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('截图数据解析失败'))
    img.src = dataUrl
  })
}

function toast(shadow: ShadowRoot, text: string, ms = 2600) {
  const t = document.createElement('div')
  t.className = 'os-toast'
  t.textContent = text
  shadow.appendChild(t)
  setTimeout(() => t.remove(), ms)
}

async function copyCanvas(canvas: HTMLCanvasElement): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png')
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

function downloadCanvas(canvas: HTMLCanvasElement) {
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/png')
  a.download = `orbitshot-${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[T:]/g, '-')}.png`
  a.click()
}

function aiIcon(site: AiSite): string {
  return site.name.charAt(0).toUpperCase()
}

function firstLevelItems(): RadialItem[] {
  return [
    { id: 'ai', label: t(lang, 'radial.ai'), icon: '✨', svg: RADIAL_ICON.ai },
    { id: 'stash', label: t(lang, 'radial.stash'), icon: '📥', svg: RADIAL_ICON.stash },
    { id: 'annotate', label: t(lang, 'radial.annotate'), icon: '✏️', svg: RADIAL_ICON.annotate },
    { id: 'copy', label: t(lang, 'radial.copy'), icon: '📋', svg: RADIAL_ICON.copy },
    { id: 'download', label: t(lang, 'radial.download'), icon: '⬇️', svg: RADIAL_ICON.download },
    { id: 'recapture', label: t(lang, 'radial.recapture'), icon: '🔄', svg: RADIAL_ICON.recapture },
    { id: 'close', label: t(lang, 'radial.close'), icon: '✕', svg: RADIAL_ICON.close },
  ]
}

async function secondLevelItems(): Promise<RadialItem[]> {
  const { aiList } = await loadSettings()
  const enabled = aiList.filter((s) => s.enabled)
  const items: RadialItem[] = enabled.map((s) => {
    const builtin = iconForSite(s.id)
    const candidates = builtin ? [] : faviconCandidates(s.url)
    return {
      id: 'ai:' + s.id,
      label: s.name,
      icon: aiIcon(s),
      iconUrl: builtin ?? candidates[0],
      iconFallbacks: builtin ? undefined : candidates.slice(1),
      selectable: true,
    }
  })
  items.push({ id: 'back', label: t(lang, 'radial.back'), icon: '←', svg: RADIAL_ICON.back })
  items.push({ id: 'settings', label: t(lang, 'radial.customize'), icon: '⚙️', svg: RADIAL_ICON.settings })
  return items
}

function showRadialAsync(
  shadow: ShadowRoot,
  center: { x: number; y: number },
  items: RadialItem[]
): Promise<string> {
  return new Promise((resolve) =>
    showRadial(shadow, center, items, (id) => resolve(id), { hubTitle: t(lang, 'radial.drag') })
  )
}

/** 二级 AI 菜单（多选模式）：普通点击单发；Ctrl+点击多选后点中心批量发送 */
type MultiPick =
  | { kind: 'pick'; id: string } // 单个 ai:id
  | { kind: 'confirm'; ids: string[] } // 批量发送
  | { kind: 'back' }
  | { kind: 'settings' }
  | { kind: 'dismiss' }

function showRadialAsyncMulti(
  shadow: ShadowRoot,
  center: { x: number; y: number },
  items: RadialItem[]
): Promise<MultiPick> {
  return new Promise((resolve) =>
    showRadial(
      shadow,
      center,
      items,
      (id) => {
        if (id === 'back') resolve({ kind: 'back' })
        else if (id === 'settings') resolve({ kind: 'settings' })
        else if (id === 'dismiss') resolve({ kind: 'dismiss' })
        else resolve({ kind: 'pick', id })
      },
      {
        hubTitle: t(lang, 'radial.drag'),
        multi: {
          hint: t(lang, 'radial.multi'),
          onConfirm: (ids) => resolve({ kind: 'confirm', ids }),
        },
      }
    )
  )
}

/**
 * 存入暂存区：同时保存「最终合成图」与「干净底图 + 标注数据」。
 * 底图与标注用于暂存区内重新标注；blur 的 patch 是画布不可序列化，剔除后
 * 由渲染层编辑时按需从底图重采样。失败（容量满/配额不足）时提示并返回 false。
 */
async function stashShot(
  shadow: ShadowRoot,
  base: HTMLCanvasElement,
  final: HTMLCanvasElement,
  anns: Ann[]
): Promise<boolean> {
  // 剔除不可克隆的 HTMLCanvasElement 字段（structured clone 会抛错）
  const cleanAnns = anns.map((a) => (a.kind === 'blur' ? { ...a, patch: undefined } : a))
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'SAVE_SHOT',
      dataUrl: final.toDataURL('image/png'),
      baseDataUrl: base.toDataURL('image/png'),
      width: final.width,
      height: final.height,
      anns: cleanAnns,
    })) as { ok: boolean; count?: number; error?: string }
    if (resp?.ok) {
      toast(shadow, t(lang, 'toast.stashed', { n: resp.count ?? 1 }))
      return true
    }
    if (resp?.error?.startsWith('FULL:')) {
      toast(shadow, t(lang, 'toast.stash.full', { n: Number(resp.error.split(':')[1]) || 50 }), 3600)
    } else if (resp?.error?.startsWith('QUOTA:')) {
      toast(shadow, t(lang, 'stash.err.quota'), 3600)
    } else {
      toast(shadow, t(lang, 'toast.stash.failed', { msg: resp?.error ?? 'unknown' }), 3600)
    }
    return false
  } catch (e) {
    toast(shadow, t(lang, 'toast.stash.failed', { msg: e instanceof Error ? e.message : String(e) }), 3600)
    return false
  }
}

/** 发送到单个 AI：剪贴板兜底复制 → 后台开/复用标签页并自动注入 → 按真实结果提示 */
async function sendToAi(
  shadow: ShadowRoot,
  canvas: HTMLCanvasElement,
  site: AiSite,
  batch?: { aiIds: string[]; batchKey: string; prompt: string }
): Promise<void> {
  let copied = true
  try {
    await copyCanvas(canvas)
  } catch {
    copied = false // 自动注入失败时兜底也失效，提示里说明
  }
  const dataUrl = canvas.toDataURL('image/png')
  let resp: { ok?: boolean; status?: string; error?: string } | null = null
  try {
    resp = (await chrome.runtime.sendMessage({
      type: 'SEND_TO_AI',
      url: site.url,
      name: site.name,
      dataUrl,
      // 多平台批量：SW 注入截图成功后接着提交问题文本并观察回答（compareMode 开启时）
      ...(batch ? { batchSend: batch } : {}),
    })) as { ok?: boolean; status?: string; error?: string } | null
  } catch {
    resp = null
  }
  if (!resp?.ok) {
    toast(shadow, t(lang, copied ? 'toast.injectError' : 'toast.copy.failed', { name: site.name }), 3600)
    return
  }
  switch (resp.status) {
    case 'inserted':
      toast(shadow, t(lang, 'toast.inserted', { name: site.name }), 3600)
      break
    case 'pasted-unverified':
      toast(shadow, t(lang, 'toast.unverified', { name: site.name }), 4200)
      break
    case 'no-editor':
      toast(shadow, t(lang, copied ? 'toast.noEditor' : 'toast.injectError', { name: site.name }), 4200)
      break
    default:
      toast(shadow, t(lang, copied ? 'toast.injectError' : 'toast.copy.failed', { name: site.name }), 3600)
  }
}

/**
 * 多模型对比：批量确认后当场弹出输入框，问题文本与截图一起提交。
 * 返回 null 表示用户取消（不发送）。
 */
function showComparePrompt(shadow: ShadowRoot, sites: AiSite[]): Promise<string | null> {
  return new Promise((resolve) => {
    const box = document.createElement('div')
    box.className = 'os-cmp-box'

    const title = document.createElement('div')
    title.className = 'os-cmp-box-title'
    title.textContent = t(lang, 'cmp.send.title')

    const chips = document.createElement('div')
    chips.className = 'os-cmp-chips'
    for (const s of sites) {
      const chip = document.createElement('span')
      chip.className = 'os-cmp-chip'
      const icon = iconForSite(s.id)
      if (icon) {
        const img = document.createElement('img')
        img.src = icon
        img.alt = ''
        chip.appendChild(img)
      }
      chip.appendChild(document.createTextNode(s.name))
      chips.appendChild(chip)
    }

    const ta = document.createElement('textarea')
    ta.className = 'os-cmp-text'
    ta.placeholder = t(lang, 'cmp.ph')
    ta.rows = 3

    const actions = document.createElement('div')
    actions.className = 'os-cmp-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'os-cmp-btn os-cmp-btn-cancel'
    cancelBtn.textContent = t(lang, 'cmp.send.cancel')
    const sendBtn = document.createElement('button')
    sendBtn.className = 'os-cmp-btn os-cmp-btn-send'
    sendBtn.textContent = t(lang, 'cmp.send.go')

    const hint = document.createElement('div')
    hint.className = 'os-cmp-hint'
    hint.textContent = t(lang, 'cmp.send.hint')

    const done = (v: string | null) => {
      box.remove()
      resolve(v)
    }
    cancelBtn.addEventListener('click', () => done(null))
    sendBtn.addEventListener('click', () => done(ta.value.trim()))
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        done(ta.value.trim())
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        done(null)
      }
    })

    actions.append(cancelBtn, sendBtn)
    box.append(title, chips, ta, actions, hint)
    shadow.appendChild(box)
    ta.focus()
  })
}

/** 批量发送：compareMode 开启且 ≥2 平台时当场输入问题，文本+截图一起逐站提交并对比；关闭则完全原行为 */
async function sendToSites(
  shadow: ShadowRoot,
  canvas: HTMLCanvasElement,
  siteIds: string[]
): Promise<void> {
  const { aiList, compareMode } = await loadSettings()
  const sites = siteIds
    .map((id) => aiList.find((s) => s.id === id.replace(/^ai:/, '')))
    .filter((s): s is AiSite => !!s)
  if (!sites.length) return

  // 对比模式唯一入口：开关开启 + ≥2 平台 → 当场弹输入框（问题与截图一起发送）；取消则中止
  // 开关关闭 → 无输入框、无文本提交、无对比面板，与原有批量行为完全一致
  let prompt = ''
  const isCompare = compareMode === true && sites.length >= 2
  if (isCompare) {
    const input = await showComparePrompt(shadow, sites)
    if (input === null) return
    prompt = input
  }

  toast(shadow, t(lang, 'toast.sending', { n: sites.length }))
  // prompt 为空（用户留空）= 纯批量注入，不带对比上下文
  const batch =
    isCompare && prompt
      ? { aiIds: sites.map((s) => s.id), batchKey: crypto.randomUUID(), prompt }
      : undefined
  for (const s of sites) {
    await sendToAi(shadow, canvas, s, batch)
  }
  if (batch) {
    try {
      await chrome.runtime.sendMessage({ type: 'COMPARE_BATCH_DONE', batchKey: batch.batchKey })
    } catch {
      /* 忽略 */
    }
  }
}

// ---- 流程一：可视区域框选截图 ----

async function startFlow() {
  if (active) return
  active = true
  const shadow = ensureShadow()
  try {
    const dataUrl = await requestCapture()
    const img = await loadImg(dataUrl)
    const dpr = img.naturalWidth / window.innerWidth

    const sel: SelRect | null = await startSelection(shadow, img)
    if (!sel) {
      toast(shadow, t(lang, 'toast.canceled'))
      return
    }

    let center = { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 }
    // 底图与标注分离：base 始终是原始截图，标注列表可跨「继续标注」保留与撤销
    const baseCanvas = cropCanvas(img, sel, dpr)
    let finalCanvas = baseCanvas
    let anns: Ann[] = []

    let exit = false
    while (!exit) {
      const res = await startAnnotator(shadow, baseCanvas, sel, dpr, anns)
      if (res.canceled) {
        toast(shadow, t(lang, 'toast.canceled'))
        return
      }
      finalCanvas = res.canvas!
      anns = res.anns ?? []
      center = res.center ?? center // 编辑器内整体平移过，环形菜单跟随当前视口中心

      let action = await showRadialAsync(shadow, center, firstLevelItems())
      // 二级 AI 菜单（多选模式）
      while (action === 'ai') {
        const res = await showRadialAsyncMulti(shadow, center, await secondLevelItems())
        if (res.kind === 'confirm' && res.ids.length) {
          await sendToSites(shadow, finalCanvas, res.ids)
          exit = true
          break
        }
        if (res.kind === 'back' || res.kind === 'dismiss') {
          action = await showRadialAsync(shadow, center, firstLevelItems())
          continue
        }
        if (res.kind === 'settings') {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })
          toast(shadow, t(lang, 'toast.openOptions'))
          exit = true
          break
        }
        if (res.kind === 'pick' && res.id.startsWith('ai:')) {
          const siteId = res.id.slice(3)
          const { aiList } = await loadSettings()
          const site = aiList.find((s) => s.id === siteId)
          if (site) {
            await sendToAi(shadow, finalCanvas, site)
          }
          exit = true
          break
        }
        // 其他情况视为关闭
        exit = true
        break
      }

      if (exit) break

      switch (action) {
        case 'annotate':
          continue // 回到标注
        case 'stash': {
          // Tendedero 式暂存：截图挂上「晾衣绳」但不打断流程——存完即结束，可继续截下一张
          const ok = await stashShot(shadow, baseCanvas, finalCanvas, anns)
          if (ok) exit = true
          else continue // 存储失败（满/配额）时留在流程里，用户可选择其他操作
          break
        }
        case 'copy':
          try {
            await copyCanvas(finalCanvas)
            toast(shadow, t(lang, 'toast.copied'))
          } catch {
            toast(shadow, t(lang, 'toast.copy.failed'))
          }
          exit = true
          break
        case 'download':
          downloadCanvas(finalCanvas)
          toast(shadow, t(lang, 'toast.saved'))
          exit = true
          break
        case 'recapture':
          active = false
          setTimeout(() => startFlow(), 60)
          return
        case 'close':
        case 'dismiss':
        default:
          exit = true
      }
    }
  } catch (e) {
    toast(shadow, t(lang, 'toast.failed', { msg: e instanceof Error ? e.message : String(e) }))
  } finally {
    // 清理可能残留的 UI
    const style = shadow.querySelector('style')
    shadow.innerHTML = ''
    if (style) shadow.appendChild(style)
    active = false
  }
}

// ---- 流程二：整页截图（beta） ----

async function startFullPageFlow() {
  if (active) return
  active = true
  const shadow = ensureShadow()
  try {
    const canvas = await captureFullPage(shadow, requestCapture)
    if (!canvas) {
      toast(shadow, t(lang, 'toast.fp.canceled'))
      return
    }
    // 预览
    const preview = document.createElement('div')
    preview.className = 'os-preview'
    preview.appendChild(canvas)
    shadow.appendChild(preview)

    const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const exitWith = async (id: string) => {
      if (id === 'copy') {
        try {
          await copyCanvas(canvas)
          toast(shadow, t(lang, 'toast.copied'))
        } catch {
          toast(shadow, t(lang, 'toast.copy.failed'))
        }
      } else if (id === 'download') {
        downloadCanvas(canvas)
        toast(shadow, t(lang, 'toast.saved'))
      } else if (id === 'ai') {
        const res = await showRadialAsyncMulti(shadow, center, await secondLevelItems())
        if (res.kind === 'confirm' && res.ids.length) {
          await sendToSites(shadow, canvas, res.ids)
        } else if (res.kind === 'pick' && res.id.startsWith('ai:')) {
          const siteId = res.id.slice(3)
          const { aiList } = await loadSettings()
          const site = aiList.find((s) => s.id === siteId)
          if (site) {
            await sendToAi(shadow, canvas, site)
          }
        } else if (res.kind === 'settings') {
          chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })
        }
      }
      preview.remove()
    }

    const items: RadialItem[] = [
      { id: 'ai', label: t(lang, 'radial.ai'), icon: '✨', svg: RADIAL_ICON.ai },
      { id: 'copy', label: t(lang, 'radial.copy'), icon: '📋', svg: RADIAL_ICON.copy },
      { id: 'download', label: t(lang, 'radial.download'), icon: '⬇️', svg: RADIAL_ICON.download },
      { id: 'recapture', label: t(lang, 'radial.recapture'), icon: '🔄', svg: RADIAL_ICON.recapture },
      { id: 'close', label: t(lang, 'radial.close'), icon: '✕', svg: RADIAL_ICON.close },
    ]
    let action = await showRadialAsync(shadow, center, items)
    while (action === 'recapture') {
      preview.remove()
      active = false
      setTimeout(() => startFullPageFlow(), 60)
      return
    }
    await exitWith(action)
  } catch (e) {
    toast(shadow, t(lang, 'toast.fp.failed', { msg: e instanceof Error ? e.message : String(e) }))
  } finally {
    const style = shadow.querySelector('style')
    shadow.innerHTML = ''
    if (style) shadow.appendChild(style)
    active = false
  }
}

// ---- 消息入口 ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true })
    return
  }
  if (msg?.type === 'RUN_FLOW' || msg?.type === 'START_FLOW') {
    sendResponse({ ok: true })
    setTimeout(() => startFlow(), 80) // 等 popup 关闭、页面拿到焦点
  }
  if (msg?.type === 'RUN_FULLPAGE' || msg?.type === 'START_FULLPAGE') {
    sendResponse({ ok: true })
    setTimeout(() => startFullPageFlow(), 80)
  }
})

// ---- 自定义快捷键（设置页配置，页面级监听） ----

window.addEventListener(
  'keydown',
  (e) => {
    if (!hotkey || active) return
    // 输入场景不触发（输入框、可编辑元素）
    const a = document.activeElement as HTMLElement | null
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) {
      return
    }
    if (comboFromEvent(e) === hotkey) {
      e.preventDefault()
      e.stopPropagation()
      startFlow()
    }
  },
  true
)
