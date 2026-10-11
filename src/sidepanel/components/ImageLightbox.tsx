/**
 * 图片大图预览（Lightbox，GPT 网页风格）。
 *
 * - 全屏深色遮罩：点击图片以外的任意区域 / Esc 关闭；
 * - 滚轮缩放（0.4×~4×）、缩放后可拖动平移、双击在适应/2× 间切换，
 *   切图时重置；
 * - 工具栏：下载（fetch → blob → a[download]，扩展页面有 <all_urls>
 *   host 权限，跨域图片可直接抓取落盘）、新标签页打开原图、关闭；
 * - ←/→ 在同卡片的多张图间切换；图片自适应视口（max 90vw / 80vh）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../shared/dicts'
import type { Lang } from '../../shared/settings'

/** 从 URL / MIME 推断下载文件名 */
function filenameFromUrl(u: string, mime: string): string {
  try {
    const p = decodeURIComponent(new URL(u).pathname.split('/').pop() ?? '')
    if (p && /\.[a-z0-9]{2,5}$/i.test(p)) return p
  } catch {
    /* 非法 URL 走默认名 */
  }
  const ext = mime.startsWith('image/')
    ? '.' + mime.slice(6).replace('jpeg', 'jpg').replace('svg+xml', 'svg')
    : '.png'
  return `orbitshot-image-${Date.now()}${ext}`
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export default function ImageLightbox(props: {
  urls: string[]
  index: number
  lang: Lang
  onClose: () => void
}) {
  const [idx, setIdx] = useState(() => Math.min(Math.max(0, props.index), props.urls.length - 1))
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 缩放 / 平移
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  const url = props.urls[idx]

  const resetView = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const prev = useCallback(() => setIdx((v) => (v > 0 ? v - 1 : v)), [])
  const next = useCallback(() => setIdx((v) => (v < props.urls.length - 1 ? v + 1 : v)), [props.urls.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === '+' || e.key === '=') setZoom((z) => clamp(z * 1.2, 0.4, 4))
      else if (e.key === '-') setZoom((z) => clamp(z / 1.2, 0.4, 4))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, prev, next])

  // 切图重置视图与加载态
  useEffect(() => {
    resetView()
    setLoaded(false)
    setErr('')
  }, [idx, resetView])

  const flashErr = (msg: string) => {
    setErr(msg)
    if (errTimer.current) clearTimeout(errTimer.current)
    errTimer.current = setTimeout(() => setErr(''), 2600)
  }

  const download = async () => {
    if (busy) return
    setBusy(true)
    try {
      const resp = await fetch(url)
      const blob = await resp.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filenameFromUrl(url, blob.type)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objUrl), 30_000)
    } catch {
      flashErr(t(props.lang, 'cmp.img.dlfail'))
    } finally {
      setBusy(false)
    }
  }

  // 滚轮缩放（以视口中心为锚；缩回 1× 时清零平移）
  const onWheel = (e: React.WheelEvent) => {
    setZoom((z) => {
      const nz = clamp(z * (e.deltaY < 0 ? 1.16 : 1 / 1.16), 0.4, 4)
      if (nz === 1) setOffset({ x: 0, y: 0 })
      return nz
    })
  }

  // 缩放后拖动平移
  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return
    setDragging(true)
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!dragging || !d) return
    setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) })
  }
  const endDrag = () => {
    setDragging(false)
    dragRef.current = null
  }

  const btn =
    'flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/25'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/85 backdrop-blur-sm" onClick={props.onClose}>
      {/* 顶栏：计数 + 工具（阻止冒泡：点工具不关闭） */}
      <div className="flex shrink-0 items-center gap-1.5 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/80">
          {idx + 1} / {props.urls.length}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {err && (
            <span className="rounded-lg bg-red-500/90 px-2.5 py-1 text-[11px] text-white">{err}</span>
          )}
          <button type="button" title={t(props.lang, 'cmp.img.download')} disabled={busy} onClick={download} className={btn}>
            {busy ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
              </svg>
            )}
          </button>
          <button type="button" title={t(props.lang, 'cmp.img.open')} onClick={() => chrome.tabs.create({ url })} className={btn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
          <button type="button" title={t(props.lang, 'cmp.img.close')} onClick={props.onClose} className={btn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18 M6 6l12 12" />
            </svg>
          </button>
        </span>
      </div>

      {/* 主图区：滚轮缩放；点击图片以外的空白区关闭；双击 1×/2× */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-10 pb-6"
        onWheel={onWheel}
        onDoubleClick={() => setZoom((z) => (z > 1.01 ? 1 : 2))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        {!loaded && !err && (
          <span className="absolute h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        )}
        <img
          key={url}
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(true)
            setErr(t(props.lang, 'cmp.img.loadfail'))
          }}
          onClick={(e) => e.stopPropagation() /* 点图片本身不关闭，点周围空白关 */}
          onDoubleClick={(e) => e.stopPropagation() /* 双击缩放由容器处理，不让冒泡重复触发 */}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? 'none' : 'transform 0.12s ease-out',
            cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          }}
          className={`max-h-[80vh] max-w-[90vw] select-none rounded-xl object-contain shadow-2xl transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
        {/* 左右切换（阻止冒泡防误关） */}
        {props.urls.length > 1 && idx > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              prev()
            }}
            className="absolute left-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/25"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
        )}
        {props.urls.length > 1 && idx < props.urls.length - 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              next()
            }}
            className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/25"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        )}
      </div>
    </div>
  )
}
