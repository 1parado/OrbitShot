/**
 * 截图查看器（模态层，覆盖暂存区）：
 * - 缩放：按钮步进 / 滚轮以鼠标为中心，10%~800%；适应窗口为默认
 * - 平移：放大后按住拖动，按缩放后尺寸钳制边界，图片不会被拖出可视区
 * - 切换：左右圆形按钮 + ArrowLeft/ArrowRight；Escape 关闭；单张时禁用
 * - 数据：只读预览，不改动记录；删除/编辑由父级处理，父级持有当前索引
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../shared/i18n'
import type { Lang } from '../shared/settings'
import type { ShotRecord } from '../background/shots'

const MIN_SCALE = 0.1
const MAX_SCALE = 8

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
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M16 21h3a2 2 0 0 0 2-2v-3 M8 21H5a2 2 0 0 1-2-2v-3',
  actual: 'M3 9V5a2 2 0 0 1 2-2h4 M21 9V5a2 2 0 0 0-2-2h-4 M3 15v4a2 2 0 0 0 2 2h4 M21 15v4a2 2 0 0 1-2 2h-4 M8 12h8',
  left: 'm15 18-6-6 6-6',
  right: 'm9 18 6-6-6-6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  pencil:
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z M15 5l4 4',
  check: 'M20 6 9 17l-5-5',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5',
}

export default function Viewer(props: {
  shots: ShotRecord[]
  index: number
  lang: Lang
  selected: boolean
  onIndex: (i: number) => void
  onClose: () => void
  onToggleSel: (id: string) => void
  onEdit: (shot: ShotRecord) => void
  onDelete: (shot: ShotRecord) => void
}) {
  const { shots, index, lang } = props
  const shot = shots[index]
  const [url, setUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState(false)
  const [nonce, setNonce] = useState(0) // 加载失败重试：重建 objectURL
  /** null = 适应窗口（默认）；数值为用户指定缩放 */
  const [scale, setScale] = useState<number | null>(null)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [fitScale, setFitScale] = useState(1)
  const boxRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(1)
  scaleRef.current = scale ?? fitScale
  const fitRef = useRef(1)
  fitRef.current = fitScale
  /** 动态下限：不低于适应窗口的一半（滚轮连滑也不会把图缩到看不见） */
  const minScaleOf = () => Math.max(MIN_SCALE, fitRef.current * 0.5)

  // 当前大图的 objectURL 生命周期：切图/关闭时立即释放
  useEffect(() => {
    if (!shot) return
    setLoaded(false)
    setLoadErr(false)
    const u = URL.createObjectURL(shot.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [shot, nonce])

  // 适应窗口比例：随容器尺寸（ResizeObserver）与图片尺寸重算
  const measure = useCallback(() => {
    const box = boxRef.current
    if (!box || !shot) return
    const s = Math.min(box.clientWidth / shot.width, box.clientHeight / shot.height, 1)
    setFitScale(s > 0 ? s : 1)
  }, [shot])
  useEffect(() => {
    measure()
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [measure])

  // 切图后重置视图（适应窗口、居中）
  useEffect(() => {
    setScale(null)
    setOff({ x: 0, y: 0 })
  }, [shot?.id])

  // 平移钳制：缩放后尺寸超出容器才允许移动，且图片边缘不越过容器边缘
  const clampOff = useCallback(
    (nx: number, ny: number, s: number): { x: number; y: number } => {
      const box = boxRef.current
      if (!box || !shot) return { x: 0, y: 0 }
      const maxX = Math.max(0, (shot.width * s - box.clientWidth) / 2)
      const maxY = Math.max(0, (shot.height * s - box.clientHeight) / 2)
      return {
        x: Math.max(-maxX, Math.min(maxX, nx)),
        y: Math.max(-maxY, Math.min(maxY, ny)),
      }
    },
    [shot]
  )

  // 缩放变化后重钳偏移
  useEffect(() => {
    const s = scale ?? fitScale
    setOff((o) => clampOff(o.x, o.y, s))
  }, [scale, fitScale, shot?.id, clampOff])

  /** 缩放到指定倍率；(mx,my) 为缩放中心相对容器中心的偏移（滚轮 = 鼠标位置，按钮 = 中心） */
  const zoomTo = useCallback(
    (ns: number, mx = 0, my = 0) => {
      const s = scaleRef.current
      const next = Math.min(MAX_SCALE, Math.max(minScaleOf(), ns))
      const r = next / s
      setScale(next)
      setOff((o) => clampOff(r * o.x + (1 - r) * mx, r * o.y + (1 - r) * my, next))
    },
    [clampOff]
  )

  // 滚轮缩放（以鼠标位置为中心；非被动监听以阻止页面滚动）
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = box.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2
      zoomTo(scaleRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12), mx, my)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // 键盘：左右切换 / Escape 关闭（输入场景不响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      } else if (e.key === 'ArrowLeft') {
        if (index > 0) {
          e.preventDefault()
          props.onIndex(index - 1)
        }
      } else if (e.key === 'ArrowRight') {
        if (index < shots.length - 1) {
          e.preventDefault()
          props.onIndex(index + 1)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, shots.length, props.onClose, props.onIndex])

  // 拖动平移（与切换按钮、底层卡片互不干扰：capture 到图片区自身）
  // 注意：不能无条件 capture——按钮上按下时会把后续指针事件全部重定向到图片区，
  // 导致按钮 click 永远不触发；仅在图片区空白/图片本身且可平移时才启动
  const pan = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a')) return // 按钮点击走原生 click
    const box = boxRef.current
    if (!box || !shot) return
    const s = scaleRef.current
    const canPan = shot.width * s > box.clientWidth + 1 || shot.height * s > box.clientHeight + 1
    if (!canPan) return // 适应窗口内无需平移，也不捕获，避免干扰点击
    pan.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y }
    try {
      box.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已释放 */
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return
    const s = scaleRef.current
    setOff((o) =>
      clampOff(pan.current!.ox + (e.clientX - pan.current!.px), pan.current!.oy + (e.clientY - pan.current!.py), s)
    )
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pan.current = null
    try {
      boxRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* 已释放 */
    }
  }

  if (!shot) return null
  const s = scale ?? fitScale
  const isFit = scale === null
  const isActual = scale === 1
  const minScale = Math.max(MIN_SCALE, fitScale * 0.5)
  const pannable = shot.width * s > (boxRef.current?.clientWidth ?? 0) + 1 || shot.height * s > (boxRef.current?.clientHeight ?? 0) + 1

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `orbitshot-${new Date(shot.createdAt).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`
    a.click()
  }

  const navBtn =
    'flex h-11 w-11 items-center justify-center rounded-full border border-black/5 bg-white/85 text-slate-600 shadow-lg backdrop-blur transition hover:bg-white hover:text-[#3478f6] disabled:pointer-events-none disabled:opacity-25'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#f2f4f8]/95 backdrop-blur-xl">
      {/* 顶部工具栏 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#e8ecf2] bg-white/80 px-4 backdrop-blur">
        <span className="text-[13px] font-semibold tabular-nums text-[#202124]">
          {index + 1} / {shots.length}
        </span>
        <span className="text-xs tabular-nums text-[#7b8494]">
          {shot.width} × {shot.height}
        </span>
        <span className="text-xs tabular-nums text-[#7b8494]">{Math.round(s * 100)}%</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button title={t(lang, 'stash.viewer.zoomout')} onClick={() => zoomTo(s / 1.25)} disabled={s <= minScale + 1e-6} className="rounded-lg p-2 text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124] disabled:opacity-30 disabled:hover:bg-transparent">
            <Icon d={ICONS.minus} />
          </button>
          <span className="w-12 text-center text-xs font-medium tabular-nums text-[#7b8494]">{Math.round(s * 100)}%</span>
          <button title={t(lang, 'stash.viewer.zoomin')} onClick={() => zoomTo(s * 1.25)} disabled={s >= MAX_SCALE - 1e-6} className="rounded-lg p-2 text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124] disabled:opacity-30 disabled:hover:bg-transparent">
            <Icon d={ICONS.plus} />
          </button>
          <span className="mx-1 h-4 w-px bg-[#e8ecf2]" />
          <button title={t(lang, 'stash.viewer.fit')} onClick={() => { setScale(null); setOff({ x: 0, y: 0 }) }} className={`rounded-lg p-2 transition hover:bg-[#eef1f6] ${isFit ? 'text-[#3478f6]' : 'text-[#7b8494] hover:text-[#202124]'}`}>
            <Icon d={ICONS.fit} />
          </button>
          <button title={t(lang, 'stash.viewer.actual')} onClick={() => { setScale(1); setOff({ x: 0, y: 0 }) }} className={`rounded-lg p-2 transition hover:bg-[#eef1f6] ${isActual ? 'text-[#3478f6]' : 'text-[#7b8494] hover:text-[#202124]'}`}>
            <Icon d={ICONS.actual} />
          </button>
          <span className="mx-1 h-4 w-px bg-[#e8ecf2]" />
          <button title={t(lang, 'stash.viewer.download')} onClick={download} className="rounded-lg p-2 text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124]">
            <Icon d={ICONS.download} />
          </button>
          <button title={t(lang, 'stash.close')} onClick={props.onClose} className="rounded-lg p-2 text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124]">
            <Icon d={ICONS.close} />
          </button>
        </div>
      </header>

      {/* 中央图片区 */}
      <div
        ref={boxRef}
        className={`relative flex-1 overflow-hidden ${pannable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 浅灰底纹（低对比，突出图片主体） */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#dde2ea_1px,transparent_1px)] [background-size:22px_22px] opacity-60" />

        {loadErr ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span className="text-sm text-[#7b8494]">{t(lang, 'stash.viewer.loadfail')}</span>
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-medium text-[#3478f6] shadow-sm ring-1 ring-[#e8ecf2] transition hover:bg-[#f0f5ff]"
            >
              <Icon d={ICONS.refresh} size={13} />
              {t(lang, 'stash.retry')}
            </button>
          </div>
        ) : (
          <>
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-[#c9d2de] border-t-[#3478f6]" />
              </div>
            )}
            {url && (
              <img
                src={url}
                alt=""
                draggable={false}
                onLoad={() => setLoaded(true)}
                onError={() => setLoadErr(true)}
                className="absolute left-1/2 top-1/2 select-none rounded-lg bg-white shadow-[0_4px_24px_rgba(15,23,42,0.12)] ring-1 ring-black/5"
                style={{
                  width: shot.width,
                  height: shot.height,
                  transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px)) scale(${s})`,
                  visibility: loaded ? 'visible' : 'hidden',
                }}
              />
            )}
          </>
        )}

        {/* 左右切换：置于图片区两侧，不遮挡图片主体 */}
        <button title={t(lang, 'stash.viewer.prev')} disabled={index <= 0} onClick={(e) => { e.stopPropagation(); if (index > 0) props.onIndex(index - 1) }} className={`${navBtn} absolute left-4 top-1/2 -translate-y-1/2`}>
          <Icon d={ICONS.left} size={18} />
        </button>
        <button title={t(lang, 'stash.viewer.next')} disabled={index >= shots.length - 1} onClick={(e) => { e.stopPropagation(); if (index < shots.length - 1) props.onIndex(index + 1) }} className={`${navBtn} absolute right-4 top-1/2 -translate-y-1/2`}>
          <Icon d={ICONS.right} size={18} />
        </button>
      </div>

      {/* 底部操作 */}
      <footer className="flex h-12 shrink-0 items-center justify-center gap-1.5 border-t border-[#e8ecf2] bg-white/80 backdrop-blur">
        <button
          onClick={() => props.onToggleSel(shot.id)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            props.selected ? 'bg-[#eef4ff] text-[#3478f6]' : 'text-[#7b8494] hover:bg-[#eef1f6] hover:text-[#202124]'
          }`}
        >
          <Icon d={ICONS.check} size={13} />
          {props.selected ? t(lang, 'stash.select.none') : t(lang, 'stash.select.all')}
        </button>
        <button
          onClick={() => props.onEdit(shot)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#7b8494] transition hover:bg-[#eef1f6] hover:text-[#202124]"
        >
          <Icon d={ICONS.pencil} size={13} />
          {t(lang, 'stash.edit')}
        </button>
        <button
          onClick={() => props.onDelete(shot)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#7b8494] transition hover:bg-red-50 hover:text-red-600"
        >
          <Icon d={ICONS.trash} size={13} />
          {t(lang, 'stash.delete.one')}
        </button>
      </footer>
    </div>
  )
}
