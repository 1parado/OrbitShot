/**
 * 截图暂存工作台（Tendedero 式「晾衣绳」的浏览器扩展重设计）：
 * - 连续截图入队不打断流程；本页集中预览、选择、排序、重标注、删除、批量分发
 * - 数据直连同源 IndexedDB（background/shots.ts），图片 Blob 本地存储，不上传
 * - 缩略图：按需生成 ≤480px 的小图（WeakMap 按 Blob 实例缓存，编辑后自动重生成），
 *   避免网格一次性解码全部原图；查看器才加载全尺寸
 * - 分发经 SW：SEND_TO_AI_BATCH 按顺序多图注入；逐个 AI 顺序执行，状态独立、失败可单独重试
 * - 其他扩展上下文（SW 入队/编辑）改动通过计数轮询 + focus 刷新感知
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import { t, useLang } from '../shared/i18n'
import { loadSettings, iconForSite, faviconCandidates } from '../shared/settings'
import type { AiSite, Lang } from '../shared/settings'
import {
  listShots,
  deleteShot,
  deleteShots,
  clearShots,
  reorderShots,
  updateShot,
  countShots,
  MAX_SHOTS,
} from '../background/shots'
import type { ShotRecord } from '../background/shots'
import { startAnnotator } from '../content/annotator'
import type { Ann } from '../content/annotator'
import contentCss from '../content/content.css?inline'
import Viewer from './Viewer'

type SendState = 'sending' | 'ok' | 'unverified' | 'noEditor' | 'failed'
interface AiStatus {
  state: SendState
  detail?: string
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
    <path d={d} />
  </svg>
)
const ICONS = {
  close: 'M18 6 6 18 M6 6l12 12',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6',
  pencil:
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z M15 5l4 4',
  check: 'M20 6 9 17l-5-5',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5',
  camera:
    'M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5z M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  plus: 'M12 5v14 M5 12h14',
}

/** 生成缩略图 objectURL（≤480px） */
async function makeThumb(blob: Blob, max = 480): Promise<string> {
  const bmp = await createImageBitmap(blob)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('缩略图生成失败'))), 'image/png')
  )
}

/** AI 图标：内置 logo → favicon 链 → 首字母 */
function SiteIcon({ site }: { site: AiSite }) {
  const [idx, setIdx] = useState(0)
  const builtin = iconForSite(site.id)
  const candidates = builtin ? [] : faviconCandidates(site.url)
  const url = builtin ?? candidates[idx]
  return url ? (
    <img src={url} alt="" className="h-5 w-5 shrink-0 rounded-md object-contain" draggable={false} onError={() => setIdx((i) => i + 1)} />
  ) : (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#eef1f6] text-[10px] font-bold text-[#7b8494]">
      {site.name.charAt(0).toUpperCase()}
    </span>
  )
}

/* ---------- 顶栏图标按钮（统一 32px 命中区） ---------- */
function TBtn(props: { title: string; onClick?: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode; label?: string }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent ${
        props.danger
          ? 'text-[#7b8494] hover:bg-red-50 hover:text-red-600'
          : 'text-[#7b8494] hover:bg-[#eef1f6] hover:text-[#202124]'
      }`}
    >
      {props.children}
      {props.label}
    </button>
  )
}

export default function Staging() {
  const [lang] = useLang()
  const [shots, setShots] = useState<ShotRecord[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiSites, setAiSites] = useState<AiSite[]>([])
  const [aiSel, setAiSel] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Record<string, AiStatus>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [viewerIdx, setViewerIdx] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const dragId = useRef<string | null>(null)
  const shotsRef = useRef<ShotRecord[]>([])
  shotsRef.current = shots

  const flashNote = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote((v) => (v === msg ? null : v)), 2600)
  }

  const refresh = useCallback(async () => {
    try {
      const list = await listShots()
      setShots(list)
      setSelected((prev) => {
        const alive = new Set(list.map((s) => s.id))
        return new Set([...prev].filter((id) => alive.has(id)))
      })
      setLoadErr(null)
    } catch (e) {
      setLoadErr(t(lang, 'stash.err.load', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }, [lang])

  useEffect(() => {
    refresh()
    loadSettings().then((s) => {
      const enabled = s.aiList.filter((x) => x.enabled)
      setAiSites(enabled)
      setAiSel(new Set(enabled.slice(0, 1).map((x) => x.id)))
    })
  }, [refresh])

  // 其他上下文（SW 入队 / 编辑）改动感知：轻量计数轮询 + 窗口聚焦刷新
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const c = await countShots()
        if (c !== shotsRef.current.length) refresh()
      } catch {
        /* 忽略轮询错误 */
      }
    }, 1800)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(iv)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  // 缩略图：只为缺少/已更新的 Blob 生成（WeakMap 按 Blob 实例缓存），卸载时统一释放
  const thumbCache = useRef(new WeakMap<Blob, string>())
  const createdUrls = useRef<string[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next: Record<string, string> = {}
      for (const s of shots) {
        const hit = thumbCache.current.get(s.blob)
        if (hit) {
          next[s.id] = hit
          continue
        }
        try {
          const url = await makeThumb(s.blob)
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          thumbCache.current.set(s.blob, url)
          createdUrls.current.push(url)
          next[s.id] = url
        } catch {
          // 缩略图生成失败：回退全图 URL，保证卡片始终可显示（不影响其他卡片）
          const url = URL.createObjectURL(s.blob)
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          thumbCache.current.set(s.blob, url)
          createdUrls.current.push(url)
          next[s.id] = url
        }
      }
      if (!cancelled) setThumbs(next)
    })()
    return () => {
      cancelled = true
    }
  }, [shots])
  useEffect(() => () => createdUrls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  const selectedIds = useMemo(() => shots.filter((s) => selected.has(s.id)).map((s) => s.id), [shots, selected])
  const allSelected = shots.length > 0 && selected.size === shots.length

  // ---- 选择 ----
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ---- 删除 / 清空 ----
  const removeOne = async (shot: ShotRecord, fromViewer = false) => {
    if (!window.confirm(t(lang, 'stash.delete.one'))) return
    const idx = shots.findIndex((s) => s.id === shot.id)
    await deleteShot(shot.id)
    await refresh()
    if (fromViewer) {
      const remain = shots.length - 1
      setViewerIdx(remain <= 0 ? null : Math.min(Math.max(idx, 0), remain - 1))
    } else if (viewerIdx !== null) {
      // 底层删除时同步收紧查看器索引
      setViewerIdx((v) => (v === null ? null : Math.min(v, Math.max(0, shots.length - 2))))
    }
  }
  const removeSelected = async () => {
    if (!selectedIds.length) return
    if (!window.confirm(t(lang, 'stash.delete.confirm', { n: selectedIds.length }))) return
    await deleteShots(selectedIds)
    await refresh()
    setViewerIdx((v) => (v !== null && shots.length - selectedIds.length <= 0 ? null : v))
  }
  const clearAll = async () => {
    if (!shots.length) return
    if (!window.confirm(t(lang, 'stash.clear.confirm', { n: shots.length }))) return
    await clearShots()
    await refresh()
    setViewerIdx(null)
  }

  // ---- 继续截图（触发活动标签页的截图流程，本页保持打开） ----
  const captureMore = async () => {
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'RUN_FLOW' })) as { ok?: boolean; error?: string }
      if (resp && !resp.ok && resp.error) flashNote(resp.error)
    } catch {
      flashNote(t(lang, 'stash.err.load', { msg: 'runtime' }))
    }
  }

  // ---- 拖拽排序 ----
  const onDrop = async (targetId: string) => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const arr = [...shots]
    const fi = arr.findIndex((s) => s.id === from)
    const ti = arr.findIndex((s) => s.id === targetId)
    if (fi < 0 || ti < 0) return
    const [moved] = arr.splice(fi, 1)
    arr.splice(ti, 0, moved)
    setShots(arr.map((s, i) => ({ ...s, order: i })))
    await reorderShots(arr.map((s) => s.id))
  }

  // ---- 重标注：复用内容脚本标注器（底图 + 已有标注），保存后更新原记录 ----
  const openEditor = useCallback(
    async (shot: ShotRecord) => {
      if (editing) return
      setEditing(true)
      // 从查看器进入编辑时记住位置，编辑结束后返回查看器（刷新后的记录对象已更新）
      const returnIdx = viewerIdx !== null && shots[viewerIdx]?.id === shot.id ? viewerIdx : null
      setViewerIdx(null)
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;width:0;height:0;z-index:2147483647;'
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = contentCss
      shadow.appendChild(style)
      document.documentElement.appendChild(host)
      try {
        const img = new Image()
        img.src = URL.createObjectURL(shot.baseBlob)
        await new Promise((res, rej) => {
          img.onload = () => res(null)
          img.onerror = () => rej(new Error('底图加载失败'))
        })
        const base = document.createElement('canvas')
        base.width = img.naturalWidth
        base.height = img.naturalHeight
        base.getContext('2d')!.drawImage(img, 0, 0)
        URL.revokeObjectURL(img.src)

        const maxW = Math.max(200, window.innerWidth - 120)
        const maxH = Math.max(160, window.innerHeight - 160)
        const scale = Math.min(1, maxW / base.width, maxH / base.height)
        const w = Math.max(1, Math.round(base.width * scale))
        const h = Math.max(1, Math.round(base.height * scale))
        const sel = { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h }
        const dpr = base.width / w

        const res = await startAnnotator(shadow, base, sel, dpr, (shot.anns as Ann[]) ?? [])
        if (!res.canceled) {
          const blob = await new Promise<Blob>((resolve, reject) =>
            res.canvas!.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png')
          )
          const cleanAnns = (res.anns ?? []).map((a) => (a.kind === 'blur' ? { ...a, patch: undefined } : a))
          await updateShot(shot.id, { blob, anns: cleanAnns, width: res.canvas!.width, height: res.canvas!.height })
          await refresh()
        }
      } catch {
        /* 编辑失败静默返回（底图损坏等罕见情况） */
      } finally {
        host.remove()
        setEditing(false)
        // 标注数据/缩略图已随 refresh 更新；回到查看器时展示新图
        if (returnIdx !== null && returnIdx < shotsRef.current.length) setViewerIdx(returnIdx)
      }
    },
    [editing, refresh, viewerIdx, shots]
  )

  // ---- 分发：逐个 AI 顺序执行，状态独立，失败可单独重试 ----
  const sendTo = async (
    site: AiSite,
    ids: string[],
    batch?: { aiIds: string[]; batchKey: string }
  ) => {
    setStatus((p) => ({ ...p, [site.id]: { state: 'sending' } }))
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'SEND_TO_AI_BATCH',
        url: site.url,
        name: site.name,
        shotIds: ids,
        // 多平台批量：SW 注入成功后记录对比上下文（compareMode 开启时）
        ...(batch ? { batchSend: batch } : {}),
      })) as { ok?: boolean; status?: string; detail?: string; error?: string }
      const state: SendState = !resp?.ok
        ? 'failed'
        : resp.status === 'inserted'
          ? 'ok'
          : resp.status === 'pasted-unverified'
            ? 'unverified'
            : resp.status === 'no-editor'
              ? 'noEditor'
              : 'failed'
      setStatus((p) => ({ ...p, [site.id]: { state, detail: resp?.detail ?? resp?.error } }))
    } catch (e) {
      setStatus((p) => ({ ...p, [site.id]: { state: 'failed', detail: e instanceof Error ? e.message : String(e) } }))
    }
  }
  const sendAll = async () => {
    if (busy || !selectedIds.length || !aiSel.size) return
    setBusy(true)
    const sites = aiSites.filter((s) => aiSel.has(s.id))
    // 多平台批量：一次性带完整平台列表（SW 写对比 pending），全部结束后开对比面板
    const batch =
      sites.length >= 2
        ? { aiIds: sites.map((s) => s.id), batchKey: crypto.randomUUID() }
        : undefined
    for (const site of sites) {
      await sendTo(site, selectedIds, batch) // 顺序执行：避免多标签页同时注入互相抢焦点
    }
    if (batch) {
      try {
        await chrome.runtime.sendMessage({ type: 'COMPARE_BATCH_DONE', batchKey: batch.batchKey })
      } catch {
        /* 忽略 */
      }
    }
    setBusy(false)
  }

  const statusText = (s: AiStatus): string => {
    switch (s.state) {
      case 'sending':
        return t(lang, 'stash.sending')
      case 'ok':
        return t(lang, 'stash.status.ok')
      case 'unverified':
        return t(lang, 'stash.status.unverified', { detail: s.detail ?? '' })
      case 'noEditor':
        return t(lang, 'stash.status.noEditor')
      default:
        return t(lang, 'stash.status.failed') + (s.detail ? `（${s.detail}）` : '')
    }
  }
  const statusCls = (s: AiStatus): string =>
    s.state === 'ok'
      ? 'text-emerald-600 bg-emerald-50 border-emerald-100'
      : s.state === 'sending'
        ? 'text-[#3478f6] bg-[#eef4ff] border-[#d8e4fb]'
        : 'text-red-600 bg-red-50 border-red-100'

  return (
    <div className="flex h-screen flex-col bg-[#f5f7fa] text-[#202124]">
      {/* ---------- 顶部工具栏 ---------- */}
      <header className="z-10 flex h-14 shrink-0 items-center gap-3 border-b border-[#e8ecf2] bg-white/85 px-5 backdrop-blur">
        <img src={logoUrl} alt="OrbitShot" className="h-8 w-8 rounded-[10px] ring-1 ring-[#e8ecf2]" draggable={false} />
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-tight">{t(lang, 'stash.title')}</span>
          <span className="rounded-full bg-[#eef4ff] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#3478f6]">
            {t(lang, 'stash.count', { n: shots.length })}
          </span>
          {shots.length >= MAX_SHOTS && <span className="hidden text-[11px] text-red-500 sm:inline">{t(lang, 'stash.err.full', { n: MAX_SHOTS })}</span>}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <TBtn title={t(lang, 'stash.add')} onClick={captureMore}>
            <Icon d={ICONS.camera} size={15} />
            <span className="hidden md:inline">{t(lang, 'stash.add')}</span>
          </TBtn>
          {shots.length > 0 && (
            <>
              <TBtn
                title={t(lang, allSelected ? 'stash.select.none' : 'stash.select.all')}
                onClick={() => setSelected(allSelected ? new Set() : new Set(shots.map((s) => s.id)))}
              >
                {t(lang, allSelected ? 'stash.select.none' : 'stash.select.all')}
              </TBtn>
              <TBtn title={t(lang, 'stash.delete')} onClick={removeSelected} disabled={!selectedIds.length} danger>
                <Icon d={ICONS.trash} size={14} />
                <span className="hidden md:inline">{t(lang, 'stash.delete')}</span>
              </TBtn>
              <TBtn title={t(lang, 'stash.clear')} onClick={clearAll} danger>
                <span className="md:hidden">{t(lang, 'stash.clear')}</span>
              </TBtn>
            </>
          )}
          <span className="mx-1.5 h-5 w-px bg-[#e8ecf2]" />
          <TBtn title={t(lang, 'stash.close')} onClick={() => window.close()}>
            <Icon d={ICONS.close} />
          </TBtn>
        </div>
      </header>

      {/* ---------- 主内容（独立滚动） ---------- */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-5 py-5">
          {loadErr && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 ring-1 ring-red-100">
              <span>{loadErr}</span>
              <button onClick={refresh} className="flex shrink-0 items-center gap-1 text-xs font-medium text-[#3478f6] hover:underline">
                <Icon d={ICONS.refresh} size={12} />
                {t(lang, 'stash.retry')}
              </button>
            </div>
          )}

          {shots.length === 0 && !loadErr ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#d5dce6] bg-white/70 py-24 text-center">
              <img src={logoUrl} alt="" className="h-14 w-14 opacity-40" draggable={false} />
              <p className="mt-4 text-[15px] font-semibold text-[#7b8494]">{t(lang, 'stash.empty')}</p>
              <kbd className="mt-4 rounded-lg border border-[#e8ecf2] bg-[#f5f7fa] px-3 py-1.5 text-xs font-semibold text-[#7b8494]">
                {t(lang, 'stash.go.capture')}
              </kbd>
            </div>
          ) : (
            <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {shots.map((shot, i) => {
                const isSel = selected.has(shot.id)
                return (
                  <div
                    key={shot.id}
                    draggable
                    onDragStart={(e) => {
                      dragId.current = shot.id
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      onDrop(shot.id)
                    }}
                    className={`group relative overflow-hidden rounded-2xl border bg-white transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(15,23,42,0.1)] ${
                      isSel ? 'border-[#3478f6] ring-2 ring-[#3478f6]/20' : 'border-[#e8ecf2] shadow-[0_1px_3px_rgba(15,23,42,0.05)]'
                    }`}
                  >
                    {/* 缩略图主体：点击打开查看器 */}
                    <button
                      className="block w-full cursor-zoom-in bg-[#f2f4f8]"
                      onClick={() => setViewerIdx(i)}
                      title={t(lang, 'stash.preview')}
                    >
                      {thumbs[shot.id] ? (
                        <img src={thumbs[shot.id]} alt="" className="h-40 w-full object-contain" draggable={false} />
                      ) : (
                        <div className="flex h-40 w-full items-center justify-center">
                          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#d5dce6] border-t-[#3478f6]" />
                        </div>
                      )}
                    </button>

                    {/* 选择勾选控件：与「点击查看」分离 */}
                    <button
                      title={isSel ? t(lang, 'stash.select.none') : t(lang, 'stash.select.all')}
                      onClick={() => toggleSel(shot.id)}
                      className={`absolute left-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full border shadow-sm transition ${
                        isSel
                          ? 'border-[#3478f6] bg-[#3478f6] text-white'
                          : 'border-[#d5dce6] bg-white/90 text-transparent hover:border-[#3478f6]'
                      } ${isSel ? '' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                      <Icon d={ICONS.check} size={13} />
                    </button>

                    {/* 序号 */}
                    <span className="absolute right-2.5 top-2.5 rounded-full bg-[#202124]/55 px-2 py-0.5 text-[10px] font-bold tabular-nums text-white backdrop-blur">
                      {i + 1}
                    </span>

                    {/* 悬停操作 */}
                    <div className="absolute bottom-2.5 right-2.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
                      <button
                        title={t(lang, 'stash.edit')}
                        onClick={() => openEditor(shot)}
                        className="rounded-lg bg-white/95 p-1.5 text-[#7b8494] shadow-sm ring-1 ring-[#e8ecf2] transition hover:text-[#3478f6]"
                      >
                        <Icon d={ICONS.pencil} size={13} />
                      </button>
                      <button
                        title={t(lang, 'stash.delete.one')}
                        onClick={() => removeOne(shot)}
                        className="rounded-lg bg-white/95 p-1.5 text-[#7b8494] shadow-sm ring-1 ring-[#e8ecf2] transition hover:text-red-600"
                      >
                        <Icon d={ICONS.trash} size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>

      {/* ---------- 批量操作栏（紧凑单行；选中截图后才突出发送操作） ---------- */}
      {shots.length > 0 && (
        <footer className="z-10 shrink-0 border-t border-[#e8ecf2] bg-white/85 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2.5 px-5 py-2.5">
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums transition ${
                selectedIds.length ? 'bg-[#eef4ff] text-[#3478f6]' : 'bg-[#eef1f6] text-[#7b8494]'
              }`}
            >
              {t(lang, 'stash.selected', { n: selectedIds.length, m: shots.length })}
            </span>
            {selected.size > 0 && (
              <button
                onClick={() => setSelected(new Set())}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124]"
              >
                {t(lang, 'stash.select.none')}
              </button>
            )}

            {/* AI 平台选择：统一尺寸图标，单行横向滚动 */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:thin]">
              {aiSites.map((site) => {
                const on = aiSel.has(site.id)
                const st = status[site.id]
                return (
                  <button
                    key={site.id}
                    onClick={() =>
                      setAiSel((prev) => {
                        const next = new Set(prev)
                        if (next.has(site.id)) next.delete(site.id)
                        else next.add(site.id)
                        return next
                      })
                    }
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition ${
                      on
                        ? 'border-[#3478f6] bg-[#eef4ff] text-[#3478f6]'
                        : 'border-[#e8ecf2] bg-white text-[#7b8494] hover:border-[#b9cdf3]'
                    }`}
                  >
                    <SiteIcon site={site} />
                    {site.name}
                    {st && st.state !== 'ok' && (
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.state === 'sending' ? 'animate-pulse bg-[#3478f6]' : 'bg-red-400'}`} />
                    )}
                  </button>
                )
              })}
            </div>

            {selectedIds.length > 0 && (
              <TBtn title={t(lang, 'stash.delete')} onClick={removeSelected} danger>
                <Icon d={ICONS.trash} size={15} />
              </TBtn>
            )}
            <button
              onClick={sendAll}
              disabled={busy || !selectedIds.length || !aiSel.size}
              className={`shrink-0 rounded-xl px-4 py-1.5 text-xs font-semibold transition active:scale-[.98] disabled:cursor-not-allowed ${
                selectedIds.length > 0 || busy
                  ? 'bg-[#3478f6] text-white shadow-sm shadow-[#3478f6]/25 hover:bg-[#2f6ce0] disabled:opacity-60'
                  : 'bg-[#eef1f6] text-[#9aa3b2]'
              }`}
            >
              {busy
                ? t(lang, 'stash.sending')
                : aiSel.size > 1
                  ? t(lang, 'stash.send.multi', { n: aiSel.size })
                  : t(lang, 'stash.send')}
            </button>
          </div>

          {/* 每 AI 状态 + 重试（发送后出现） */}
          {Object.keys(status).length > 0 && (
            <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-2.5">
              {aiSites
                .filter((s) => status[s.id])
                .map((site) => {
                  const st = status[site.id]
                  return (
                    <div key={site.id} className="flex items-center gap-2 text-xs">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${statusCls(st)}`}>
                        {st.state === 'sending' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3478f6]" />}
                        {site.name}: {statusText(st)}
                      </span>
                      {(st.state === 'failed' || st.state === 'noEditor' || st.state === 'unverified') && (
                        <button
                          onClick={() => sendTo(site, selectedIds)}
                          disabled={busy}
                          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#3478f6] transition hover:bg-[#eef4ff] disabled:opacity-40"
                        >
                          <Icon d={ICONS.refresh} size={11} />
                          {t(lang, 'stash.retry')}
                        </button>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
        </footer>
      )}

      {/* ---------- 截图查看器 ---------- */}
      {viewerIdx !== null && shots[viewerIdx] && (
        <Viewer
          shots={shots}
          index={viewerIdx}
          lang={lang}
          selected={selected.has(shots[viewerIdx].id)}
          onIndex={setViewerIdx}
          onClose={() => setViewerIdx(null)}
          onToggleSel={toggleSel}
          onEdit={openEditor}
          onDelete={(shot) => removeOne(shot, true)}
        />
      )}

      {/* 重标注遮罩提示 */}
      {editing && (
        <div className="pointer-events-none fixed left-1/2 top-4 z-[2147483647] -translate-x-1/2 rounded-full bg-[#202124]/85 px-4 py-2 text-xs text-white shadow-lg">
          {t(lang, 'stash.edit.hint')}
        </div>
      )}

      {/* 轻量提示（继续截图失败等） */}
      {note && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2 rounded-full bg-[#202124]/85 px-4 py-2 text-xs text-white shadow-lg">
          {note}
        </div>
      )}
    </div>
  )
}
