// 标注编辑器：Canvas 绘制 箭头/矩形/椭圆/画笔/文字/高亮/模糊/橡皮擦
// + 工具状态机：选择/编辑（默认）↔ 绘制工具（再次点击同工具退出）+ 空格/空白拖动整体平移
// + 选中模型（点选高亮）+ 拖动 + 8 向手柄缩放（Shift 等比）+ 箭头端点调节
// + 多行文字（textarea：Enter 换行、Ctrl+Enter 完成、Esc 取消、双击再编辑）
// + Delete 删除选中 + 橡皮擦可擦除任意标注（含文字） + 撤销重做 + 滚轮调线宽
import type { SelRect } from './selector'

type Tool = 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text' | 'marker' | 'blur' | 'eraser'

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#111827']
const SIZES = [2, 4, 7] // CSS px
const TOOL_LIST: { id: Tool | 'select'; icon: string; title: string }[] = [
  { id: 'select', icon: '↖', title: '选择 / 编辑（点选标注拖动、手柄缩放、双击改字、Delete 删除；拖空白区域平移整个截图）' },
  { id: 'arrow', icon: '➤', title: '箭头（再次点击退出绘制）' },
  { id: 'rect', icon: '▭', title: '矩形（再次点击退出绘制）' },
  { id: 'ellipse', icon: '◯', title: '椭圆（再次点击退出绘制）' },
  { id: 'pen', icon: '✎', title: '画笔（再次点击退出绘制）' },
  { id: 'text', icon: 'T', title: '文字（点击输入，Enter 换行；双击已有文字可重新编辑）' },
  { id: 'marker', icon: '🖍', title: '高亮（再次点击退出绘制）' },
  { id: 'blur', icon: '▒', title: '模糊（拖拽框选 / 单击打码，滚轮调粗细；再次点击退出）' },
  { id: 'eraser', icon: '🧽', title: '橡皮擦（点击或划过标注即可擦除，含文字框）' },
]

export interface Ann {
  kind: Tool
  color?: string
  width?: number // CSS px
  // rect/ellipse/blur/text
  x?: number
  y?: number
  w?: number
  h?: number
  // arrow
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  // pen / marker
  pts?: { x: number; y: number }[]
  // text
  text?: string
  size?: number
  // blur
  patch?: HTMLCanvasElement
}

export interface AnnotatorResult {
  canceled: boolean
  canvas?: HTMLCanvasElement
  anns?: Ann[]
  center?: { x: number; y: number }
  sel?: SelRect
}

/** 标注的几何快照（用于缩放/编辑的撤销重做） */
type Geom = Partial<Pick<Ann, 'x' | 'y' | 'w' | 'h' | 'x1' | 'y1' | 'x2' | 'y2' | 'pts' | 'size' | 'text'>>

const geomOf = (a: Ann): Geom => ({
  x: a.x,
  y: a.y,
  w: a.w,
  h: a.h,
  x1: a.x1,
  y1: a.y1,
  x2: a.x2,
  y2: a.y2,
  pts: a.pts?.map((p) => ({ ...p })),
  size: a.size,
  text: a.text,
})

const setGeom = (a: Ann, g: Geom) => {
  if (g.x !== undefined) a.x = g.x
  if (g.y !== undefined) a.y = g.y
  if (g.w !== undefined) a.w = g.w
  if (g.h !== undefined) a.h = g.h
  if (g.x1 !== undefined) a.x1 = g.x1
  if (g.y1 !== undefined) a.y1 = g.y1
  if (g.x2 !== undefined) a.x2 = g.x2
  if (g.y2 !== undefined) a.y2 = g.y2
  if (g.pts) a.pts = g.pts.map((p) => ({ ...p }))
  if (g.size !== undefined) a.size = g.size
  if (g.text !== undefined) a.text = g.text
  if (a.kind === 'blur') a.patch = undefined // 几何变化后由渲染层/提交时重新取样
}

/** 撤销/重做的最小操作单元（增删/移动/缩放/改字均可逆） */
type Op =
  | { type: 'add'; ann: Ann }
  | { type: 'remove'; ann: Ann; index: number }
  | { type: 'move'; ann: Ann; dx: number; dy: number }
  | { type: 'geom'; ann: Ann; before: Geom; after: Geom }

type HandleMode = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'p1' | 'p2'

export function startAnnotator(
  shadow: ShadowRoot,
  base: HTMLCanvasElement,
  sel: SelRect,
  dpr: number,
  initialAnns: Ann[] = []
): Promise<AnnotatorResult> {
  return new Promise((resolve) => {
    let tool: Tool | null = null // null = 选择/编辑模式（默认）；再次点击已激活工具回到该模式
    let color = COLORS[0]
    let widthIdx = 1
    const anns: Ann[] = [...initialAnns]
    const undoStack: Op[] = []
    const redoStack: Op[] = []
    let current: Ann | null = null
    let rafPending = false

    // ---- DOM ----
    const wrap = document.createElement('div')
    wrap.className = 'os-canvas-wrap'
    wrap.style.left = sel.x + 'px'
    wrap.style.top = sel.y + 'px'
    wrap.style.width = sel.w + 'px'
    wrap.style.height = sel.h + 'px'

    const canvas = document.createElement('canvas')
    canvas.width = base.width
    canvas.height = base.height
    const ctx = canvas.getContext('2d')!

    // ---- 文本排版：渲染 / 命中检测 / 导出共用，保证预览与导出一致 ----
    const fontFor = (a: { size?: number }) =>
      `${a.size ?? 16}px ui-sans-serif, system-ui, -apple-system, sans-serif`
    const lineHeightOf = (a: { size?: number }) => (a.size ?? 16) * 1.35

    /** 多行排版：显式 \n 换行 + 超出可用宽度时自然换行（中英文混排逐字符贪心） */
    const wrapLines = (a: Ann): string[] => {
      ctx.font = fontFor(a)
      const maxW = Math.max(40 * dpr, canvas.width - a.x! - 10 * dpr)
      const out: string[] = []
      for (const raw of (a.text ?? '').split('\n')) {
        if (!raw) {
          out.push('')
          continue
        }
        if (ctx.measureText(raw).width <= maxW) {
          out.push(raw)
          continue
        }
        let cur = ''
        for (const ch of raw) {
          if (cur && ctx.measureText(cur + ch).width > maxW) {
            out.push(cur)
            cur = ch
          } else {
            cur += ch
          }
        }
        out.push(cur)
      }
      return out.length ? out : ['']
    }

    const toolbar = document.createElement('div')
    toolbar.className = 'os-toolbar'

    wrap.appendChild(canvas)
    canvas.style.cursor = 'default' // 默认进入选择/编辑模式

    // ---- 渲染 ----
    const drawShape = (c: Ann) => {
      const lw = Math.max(1, (c.width ?? 2) * dpr)
      ctx.lineWidth = lw
      ctx.strokeStyle = c.color ?? '#ef4444'
      ctx.fillStyle = c.color ?? '#ef4444'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      if (c.kind === 'rect' || c.kind === 'ellipse' || c.kind === 'blur') {
        const x = c.x!
        const y = c.y!
        const w = c.w!
        const h = c.h!
        if (c.kind === 'rect') {
          ctx.strokeRect(x, y, w, h)
        } else if (c.kind === 'ellipse') {
          ctx.beginPath()
          ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
          ctx.stroke()
        } else if (w > 0 && h > 0) {
          // 有 patch 用 patch（已提交的）；拖拽/缩放中实时计算预览
          const patch = c.patch ?? makePatch(x, y, w, h)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(patch, x, y, w, h)
          ctx.imageSmoothingEnabled = true
        }
      } else if (c.kind === 'arrow') {
        const { x1, y1, x2, y2 } = c
        ctx.beginPath()
        ctx.moveTo(x1!, y1!)
        ctx.lineTo(x2!, y2!)
        ctx.stroke()
        const ang = Math.atan2(y2! - y1!, x2! - x1!)
        const head = Math.max(10 * dpr, lw * 3.2)
        ctx.beginPath()
        ctx.moveTo(x2!, y2!)
        ctx.lineTo(x2! - head * Math.cos(ang - Math.PI / 7), y2! - head * Math.sin(ang - Math.PI / 7))
        ctx.lineTo(x2! - head * Math.cos(ang + Math.PI / 7), y2! - head * Math.sin(ang + Math.PI / 7))
        ctx.closePath()
        ctx.fill()
      } else if (c.kind === 'pen' || c.kind === 'marker') {
        if (c.kind === 'marker') {
          ctx.globalAlpha = 0.38
          ctx.lineWidth = lw * 5
        }
        ctx.beginPath()
        c.pts!.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.stroke()
        ctx.globalAlpha = 1
      } else if (c.kind === 'text') {
        ctx.font = fontFor(c)
        ctx.textBaseline = 'top'
        const lh = lineHeightOf(c)
        wrapLines(c).forEach((line, i) => ctx.fillText(line, c.x!, c.y! + i * lh))
      }
    }

    // ---- 选中框与手柄 ----
    const selPad = 4 * dpr
    const bboxOf = (a: Ann): { x: number; y: number; w: number; h: number } => {
      if (a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'blur') {
        return { x: a.x!, y: a.y!, w: a.w!, h: a.h! }
      }
      if (a.kind === 'arrow') {
        return {
          x: Math.min(a.x1!, a.x2!),
          y: Math.min(a.y1!, a.y2!),
          w: Math.abs(a.x2! - a.x1!),
          h: Math.abs(a.y2! - a.y1!),
        }
      }
      if (a.kind === 'pen' || a.kind === 'marker') {
        const xs = a.pts!.map((p) => p.x)
        const ys = a.pts!.map((p) => p.y)
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
      }
      // text
      ctx.font = fontFor(a)
      const lines = wrapLines(a)
      const tw = Math.max(20 * dpr, ...lines.map((l) => ctx.measureText(l).width))
      return { x: a.x!, y: a.y!, w: tw, h: Math.max(1, lines.length) * lineHeightOf(a) }
    }

    const handlePos = (a: Ann): { mode: HandleMode; x: number; y: number }[] => {
      if (a.kind === 'arrow') {
        return [
          { mode: 'p1', x: a.x1!, y: a.y1! },
          { mode: 'p2', x: a.x2!, y: a.y2! },
        ]
      }
      const b = bboxOf(a)
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      const all: { mode: HandleMode; x: number; y: number }[] = [
        { mode: 'nw', x: b.x, y: b.y },
        { mode: 'n', x: cx, y: b.y },
        { mode: 'ne', x: b.x + b.w, y: b.y },
        { mode: 'e', x: b.x + b.w, y: cy },
        { mode: 'se', x: b.x + b.w, y: b.y + b.h },
        { mode: 's', x: cx, y: b.y + b.h },
        { mode: 'sw', x: b.x, y: b.y + b.h },
        { mode: 'w', x: b.x, y: cy },
      ]
      // 文字只保留四角（等比缩放字号）
      return a.kind === 'text' ? all.filter((h) => h.mode.length === 2) : all
    }

    const drawSelection = () => {
      if (!selected) return
      const b = bboxOf(selected)
      ctx.save()
      ctx.strokeStyle = '#0ea5e9'
      ctx.lineWidth = 1.5 * dpr
      ctx.setLineDash([5 * dpr, 4 * dpr])
      ctx.strokeRect(b.x - selPad, b.y - selPad, b.w + selPad * 2, b.h + selPad * 2)
      ctx.setLineDash([])
      const hs = 5 * dpr // 手柄半边长
      handlePos(selected).forEach((h) => {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#0ea5e9'
        if (h.mode === 'p1' || h.mode === 'p2') {
          ctx.beginPath()
          ctx.arc(h.x, h.y, hs, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        } else {
          ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2)
          ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2)
        }
      })
      ctx.restore()
    }

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(base, 0, 0)
      anns.forEach(drawShape)
      if (current) drawShape(current)
      drawSelection()
      updateEraserCursor()
    }

    const scheduleRender = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        render()
      })
    }

    // ---- 模糊（马赛克）补丁：基图取样 → 缩小 → 像素化放大 ----
    const makePatch = (x: number, y: number, w: number, h: number): HTMLCanvasElement => {
      // 像素块大小随区域自适应：小区域用细块，避免一大块全糊
      const factor = Math.max(6, Math.min(16, Math.round(Math.min(w, h) / 6)))
      const sw = Math.max(1, Math.round(w / factor))
      const sh = Math.max(1, Math.round(h / factor))
      const small = document.createElement('canvas')
      small.width = sw
      small.height = sh
      const sctx = small.getContext('2d')!
      sctx.imageSmoothingEnabled = true
      sctx.drawImage(base, x, y, w, h, 0, 0, sw, sh)
      const patch = document.createElement('canvas')
      patch.width = Math.max(1, Math.round(w))
      patch.height = Math.max(1, Math.round(h))
      const pctx = patch.getContext('2d')!
      pctx.imageSmoothingEnabled = false
      pctx.drawImage(small, 0, 0, patch.width, patch.height)
      return patch
    }

    // ---- 命中检测（橡皮擦/选中用）：从最上层往下找 ----
    const distToSeg = (
      p: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number }
    ) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
      const px = a.x + t * dx
      const py = a.y + t * dy
      return Math.hypot(p.x - px, p.y - py)
    }

    const hitTest = (p: { x: number; y: number }): Ann | null => {
      const pad = 6 * dpr
      for (let i = anns.length - 1; i >= 0; i--) {
        const c = anns[i]
        if (c.kind === 'rect' || c.kind === 'blur') {
          if (
            p.x >= c.x! - pad &&
            p.x <= c.x! + c.w! + pad &&
            p.y >= c.y! - pad &&
            p.y <= c.y! + c.h! + pad
          )
            return c
        } else if (c.kind === 'ellipse') {
          const cx = c.x! + c.w! / 2
          const cy = c.y! + c.h! / 2
          const rx = Math.abs(c.w! / 2) + pad
          const ry = Math.abs(c.h! / 2) + pad
          const v = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2
          if (v <= 1.15) return c
        } else if (c.kind === 'arrow') {
          const r = Math.max((c.width ?? 2) * dpr, 8 * dpr)
          if (distToSeg(p, { x: c.x1!, y: c.y1! }, { x: c.x2!, y: c.y2! }) <= r) return c
        } else if (c.kind === 'pen' || c.kind === 'marker') {
          const r = ((c.width ?? 2) * dpr) / 2 + 6 * dpr
          const pts = c.pts!
          for (let j = 0; j < pts.length - 1; j++) {
            if (distToSeg(p, pts[j], pts[j + 1]) <= r) return c
          }
        } else if (c.kind === 'text') {
          // 与渲染同一套多行排版求包围盒，保证橡皮擦/选中能准确命中文字
          const b = bboxOf(c)
          if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad)
            return c
        }
      }
      return null
    }

    /** 命中选中标注的手柄（需在 hitTest 之前调用） */
    const hitHandle = (p: { x: number; y: number }): HandleMode | null => {
      if (!selected) return null
      const r = 10 * dpr
      for (const h of handlePos(selected)) {
        if (Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r) return h.mode
      }
      return null
    }

    // ---- 撤销 / 重做 ----
    const applyUndo = () => {
      const op = undoStack.pop()
      if (!op) return
      if (op.type === 'add') {
        const i = anns.indexOf(op.ann)
        if (i >= 0) anns.splice(i, 1)
        if (selected === op.ann) selected = null
      } else if (op.type === 'remove') {
        anns.splice(Math.min(op.index, anns.length), 0, op.ann)
      } else if (op.type === 'move') {
        shiftAnn(op.ann, -op.dx, -op.dy)
        regenBlurPatch(op.ann)
      } else {
        setGeom(op.ann, op.before)
        regenBlurPatch(op.ann)
      }
      redoStack.push(op)
      render()
    }

    const applyRedo = () => {
      const op = redoStack.pop()
      if (!op) return
      if (op.type === 'add') {
        anns.push(op.ann)
      } else if (op.type === 'remove') {
        const i = anns.indexOf(op.ann)
        if (i >= 0) anns.splice(i, 1)
        if (selected === op.ann) selected = null
      } else if (op.type === 'move') {
        shiftAnn(op.ann, op.dx, op.dy)
        regenBlurPatch(op.ann)
      } else {
        setGeom(op.ann, op.after)
        regenBlurPatch(op.ann)
      }
      undoStack.push(op)
      render()
    }

    const commitAdd = (ann: Ann) => {
      anns.push(ann)
      undoStack.push({ type: 'add', ann })
      redoStack.length = 0
      render()
    }

    // ---- 拖动已有标注 ----
    // 平移标注坐标；blur 的 patch 是按旧位置从底图取样的，移动后需重新生成
    const shiftAnn = (a: Ann, dx: number, dy: number) => {
      if (a.kind === 'arrow') {
        a.x1! += dx
        a.y1! += dy
        a.x2! += dx
        a.y2! += dy
      } else if (a.kind === 'pen' || a.kind === 'marker') {
        a.pts!.forEach((pt) => {
          pt.x += dx
          pt.y += dy
        })
      } else {
        a.x! += dx
        a.y! += dy
      }
      if (a.kind === 'blur') a.patch = undefined // 置空后由渲染层/提交时重新取样
    }

    const regenBlurPatch = (a: Ann) => {
      if (a.kind === 'blur') a.patch = makePatch(a.x!, a.y!, a.w!, a.h!)
    }

    // ---- 选中 / 拖动 / 缩放状态 ----
    let selected: Ann | null = null
    let drag: { ann: Ann; start: { x: number; y: number }; last: { x: number; y: number }; moved: boolean } | null =
      null
    let resizing: {
      ann: Ann
      mode: HandleMode
      start: Geom
      startPt: { x: number; y: number }
    } | null = null

    // ---- 整体平移：只移动编辑器容器，标注在图片坐标系中的数据不变，导出不受影响 ----
    let spaceHeld = false
    let panX = 0
    let panY = 0
    let pan: { sx: number; sy: number; ox: number; oy: number } | null = null
    const applyPan = () => {
      wrap.style.transform = `translate(${panX}px, ${panY}px)`
    }
    const clampPan = () => {
      const vis = 60 // 至少保留 60px 可见，避免截图被完全拖出视口
      panX = Math.max(vis - sel.w - sel.x, Math.min(panX, window.innerWidth - vis - sel.x))
      panY = Math.max(vis - sel.h - sel.y, Math.min(panY, window.innerHeight - vis - sel.y))
      applyPan()
    }

    /** 手柄模式 → 鼠标光标 */
    const modeCursor = (m: HandleMode): string => {
      switch (m) {
        case 'n':
        case 's':
          return 'ns-resize'
        case 'e':
        case 'w':
          return 'ew-resize'
        case 'ne':
        case 'sw':
          return 'nesw-resize'
        case 'nw':
        case 'se':
          return 'nwse-resize'
        default:
          return 'move'
      }
    }

    /** 盒类缩放：根据模式与位移计算新几何（proportional = 等比） */
    const applyBoxResize = (
      g0: Geom,
      mode: HandleMode,
      dx: number,
      dy: number,
      proportional: boolean
    ): Geom => {
      const min = 6 * dpr
      let x = g0.x!
      let y = g0.y!
      let w = g0.w!
      let h = g0.h!
      const corner = mode.length === 2

      if (mode.includes('e')) w = g0.w! + dx
      if (mode.includes('w')) {
        x = g0.x! + dx
        w = g0.w! - dx
      }
      if (mode.includes('s')) h = g0.h! + dy
      if (mode.includes('n')) {
        y = g0.y! + dy
        h = g0.h! - dy
      }

      // 最小尺寸钳制（拖过对边时钉住固定边）
      if (w < min) {
        if (mode.includes('w')) x = g0.x! + g0.w! - min
        w = min
      }
      if (h < min) {
        if (mode.includes('n')) y = g0.y! + g0.h! - min
        h = min
      }

      // 角柄 + Shift：等比例（以宽度为准）
      if (proportional && corner && g0.w! > 0 && g0.h! > 0) {
        const ratio = g0.h! / g0.w!
        const nh = w * ratio
        if (mode.includes('n')) y = y + (h - nh)
        h = nh
      }
      return { x, y, w, h }
    }

    /** 删除单个标注并写入撤销栈（橡皮擦 / Delete 键 / 清空文字内容共用） */
    const deleteAnn = (a: Ann) => {
      const index = anns.indexOf(a)
      if (index < 0) return
      anns.splice(index, 1)
      if (selected === a) selected = null
      undoStack.push({ type: 'remove', ann: a, index })
      redoStack.length = 0
    }

    const eraseAt = (p: { x: number; y: number }) => {
      const hit = hitTest(p)
      if (!hit) return
      deleteAnn(hit) // 数据模型与画面同步删除，重绘/导出后不会复活
      scheduleRender()
    }

    // ---- 指针事件 ----
    let startPt: { x: number; y: number } | null = null

    const toCanvasPt = (e: MouseEvent | PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const p = toCanvasPt(e)
      const w = SIZES[widthIdx]

      // 0) 按住空格：任意工具下临时整体平移
      if (spaceHeld) {
        selected = null
        pan = { sx: e.clientX, sy: e.clientY, ox: panX, oy: panY }
        canvas.style.cursor = 'grabbing'
        canvas.setPointerCapture(e.pointerId)
        scheduleRender()
        return
      }

      // 1) 选择/编辑模式下优先命中选中标注的缩放手柄
      const hm = tool === null ? hitHandle(p) : null
      if (hm && !e.ctrlKey && !e.metaKey) {
        resizing = { ann: selected!, mode: hm, start: geomOf(selected!), startPt: p }
        canvas.setPointerCapture(e.pointerId)
        return
      }

      // 2) 选择/编辑模式：点标注 → 选中并拖动；点空白 → 取消选中并平移整个截图
      if (tool === null) {
        const hit = hitTest(p)
        if (hit) {
          selected = hit
          drag = { ann: hit, start: p, last: p, moved: false }
        } else {
          selected = null
          pan = { sx: e.clientX, sy: e.clientY, ox: panX, oy: panY }
          canvas.style.cursor = 'grabbing'
        }
        canvas.setPointerCapture(e.pointerId)
        scheduleRender()
        return
      }

      if (tool === 'text') {
        const hit = hitTest(p)
        if (hit) {
          // 点击已有文字 → 拖动 + 选中；空白处 → 输入新文字
          selected = hit
          drag = { ann: hit, start: p, last: p, moved: false }
          canvas.setPointerCapture(e.pointerId)
        } else {
          selected = null
          openTextEditor(null, p)
        }
        scheduleRender()
        return
      }
      if (tool === 'eraser') {
        startPt = p
        eraseAt(p)
        canvas.setPointerCapture(e.pointerId)
        return
      }
      // 绘制类工具：命中已有标注 → 选中并拖动；按住 Ctrl/Mac ⌘ 则跳过强制绘制
      const hit = e.ctrlKey || e.metaKey ? null : hitTest(p)
      if (hit) {
        selected = hit
        drag = { ann: hit, start: p, last: p, moved: false }
        canvas.setPointerCapture(e.pointerId)
        scheduleRender()
        return
      }
      // 空白处：取消选中并开始绘制新图形
      selected = null
      startPt = p
      if (tool === 'blur') {
        current = { kind: 'blur', x: p.x, y: p.y, w: 0, h: 0 }
      } else if (tool === 'rect' || tool === 'ellipse') {
        current = { kind: tool, x: p.x, y: p.y, w: 0, h: 0, color, width: w }
      } else if (tool === 'arrow') {
        current = { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: w }
      } else {
        current = { kind: tool, pts: [p], color, width: w }
      }
      // 关键：捕获到 canvas 自身，保证拖出画布后 move/up 仍派发到这里
      canvas.setPointerCapture(e.pointerId)
      scheduleRender()
    }

    const onPointerMove = (e: PointerEvent) => {
      const p = toCanvasPt(e)
      // 整体平移视口：只改容器 transform，标注数据与底图不受影响
      if (pan) {
        panX = pan.ox + (e.clientX - pan.sx)
        panY = pan.oy + (e.clientY - pan.sy)
        clampPan()
        return
      }
      // 缩放手柄拖拽
      if (resizing) {
        const dx = p.x - resizing.startPt.x
        const dy = p.y - resizing.startPt.y
        const a = resizing.ann
        const g0 = resizing.start
        if (a.kind === 'arrow') {
          if (resizing.mode === 'p1') {
            setGeom(a, { x1: g0.x1! + dx, y1: g0.y1! + dy })
          } else {
            setGeom(a, { x2: g0.x2! + dx, y2: g0.y2! + dy })
          }
        } else {
          const ng = applyBoxResize(g0, resizing.mode, dx, dy, e.shiftKey)
          if (a.kind === 'pen' || a.kind === 'marker') {
            // 笔迹按盒缩放映射所有点
            const bw0 = Math.max(1, g0.w!)
            const bh0 = Math.max(1, g0.h!)
            const sx = ng.w! / bw0
            const sy = ng.h! / bh0
            setGeom(a, {
              pts: g0.pts!.map((pt) => ({
                x: ng.x! + (pt.x - g0.x!) * sx,
                y: ng.y! + (pt.y - g0.y!) * sy,
              })),
            })
          } else {
            setGeom(a, ng)
            if (a.kind === 'text') {
              // 文字随高度等比缩放字号
              const s = ng.h! / Math.max(1, g0.h!)
              a.size = Math.max(10 * dpr, (g0.size ?? 16 * dpr) * s)
            }
          }
        }
        scheduleRender()
        return
      }
      // 拖动已有标注：增量平移，blur 实时重新取样预览
      if (drag) {
        const dx = p.x - drag.last.x
        const dy = p.y - drag.last.y
        if (dx || dy) {
          shiftAnn(drag.ann, dx, dy)
          drag.last = p
          drag.moved = true
          scheduleRender()
        }
        return
      }
      // 橡皮擦：按住拖动持续擦除
      if (tool === 'eraser' && startPt) {
        eraseAt(p)
        return
      }
      if (!startPt || !current) return
      if (current.kind === 'rect' || current.kind === 'ellipse' || current.kind === 'blur') {
        current.x = Math.min(startPt.x, p.x)
        current.y = Math.min(startPt.y, p.y)
        current.w = Math.abs(p.x - startPt.x)
        current.h = Math.abs(p.y - startPt.y)
      } else if (current.kind === 'arrow') {
        current.x2 = p.x
        current.y2 = p.y
      } else {
        current.pts!.push(p)
      }
      scheduleRender()
    }

    const onPointerUp = (e: PointerEvent) => {
      const pUp = toCanvasPt(e)
      // 整体平移收尾：不产生撤销步（不影响标注数据）
      if (pan) {
        pan = null
        canvas.style.cursor = spaceHeld ? 'grab' : tool === null ? 'default' : 'crosshair'
        return
      }
      // 缩放手柄收尾：提交 geom 撤销步
      if (resizing) {
        const a = resizing.ann
        const before = resizing.start
        if (a.kind === 'blur') regenBlurPatch(a)
        undoStack.push({ type: 'geom', ann: a, before, after: geomOf(a) })
        redoStack.length = 0
        resizing = null
        render()
        return
      }
      if (drag) {
        if (drag.moved) {
          const dx = pUp.x - drag.start.x
          const dy = pUp.y - drag.start.y
          if (dx || dy) {
            // 兜底：补上最后一次 move 之后指针可能又移动的距离
            shiftAnn(drag.ann, pUp.x - drag.last.x, pUp.y - drag.last.y)
            if (drag.ann.kind === 'blur') regenBlurPatch(drag.ann) // 从干净底图重新取样
            undoStack.push({ type: 'move', ann: drag.ann, dx, dy })
            redoStack.length = 0
          }
        }
        drag = null
        startPt = null
        render()
        return
      }
      if (tool === 'eraser') {
        startPt = null
        return
      }
      if (!current || !startPt) return
      const p = pUp
      // 太小的图形忽略（误触 / 仅点击取消选中的情形）
      if (
        (current.kind === 'rect' || current.kind === 'ellipse') &&
        (current.w! < 4 || current.h! < 4)
      ) {
        current = null
        startPt = null
        render()
        return
      }
      if (current.kind === 'arrow' && Math.hypot(current.x2! - current.x1!, current.y2! - current.y1!) < 6 * dpr) {
        current = null
        startPt = null
        render()
        return
      }
      if ((current.kind === 'pen' || current.kind === 'marker') && current.pts!.length < 3) {
        current = null
        startPt = null
        render()
        return
      }
      if (current.kind === 'blur') {
        if (current.w! < 4 || current.h! < 4) {
          // 单击直接打码：以点击处为中心糊一个随线宽变化的方块，免去拖拽
          const side = (28 + SIZES[widthIdx] * 10) * dpr
          current.x = p.x - side / 2
          current.y = p.y - side / 2
          current.w = side
          current.h = side
        }
        current.patch = makePatch(current.x!, current.y!, current.w!, current.h!)
      }
      commitAdd(current)
      current = null
      startPt = null
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    // 指针中断（如触控被系统打断）时丢弃未完成的图形，保持状态一致
    canvas.addEventListener(
      'pointercancel',
      () => {
        resizing = null
        drag = null
        pan = null
        current = null
        startPt = null
        canvas.style.cursor = tool === null ? 'default' : 'crosshair'
        render()
      }
    )

    // ---- 双击编辑已有文字（多行）----
    canvas.addEventListener('dblclick', (e) => {
      const p = toCanvasPt(e)
      const hit = hitTest(p)
      if (hit && hit.kind === 'text') {
        selected = hit
        render()
        openTextEditor(hit)
      }
    })

    // 滚轮调节线宽：向上滚更粗、向下滚更细
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const next = Math.min(SIZES.length - 1, Math.max(0, widthIdx + (e.deltaY < 0 ? 1 : -1)))
      if (next === widthIdx) return
      widthIdx = next
      sizeBtns.forEach((x, i) => x.classList.toggle('os-active', i === widthIdx))
      flashSize()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // 线宽变化反馈：线宽按钮旁短暂显示提示
    let sizeFlash: HTMLDivElement | null = null
    const flashSize = () => {
      const labels = ['细', '中', '粗']
      if (sizeFlash) sizeFlash.remove()
      sizeFlash = document.createElement('div')
      sizeFlash.className = 'os-size-flash'
      sizeFlash.textContent = `线宽：${labels[widthIdx]}`
      wrap.appendChild(sizeFlash)
      setTimeout(() => {
        sizeFlash?.remove()
        sizeFlash = null
      }, 700)
    }

    // 橡皮擦光标：圆形描边跟随
    const eraserCursor = document.createElement('div')
    eraserCursor.className = 'os-eraser-cursor'
    eraserCursor.style.display = 'none'
    wrap.appendChild(eraserCursor)
    const updateEraserCursor = () => {
      if (tool !== 'eraser') {
        eraserCursor.style.display = 'none'
        return
      }
      eraserCursor.style.display = 'block'
    }
    canvas.addEventListener('pointermove', (e) => {
      if (drag || resizing) return
      if (tool === 'eraser') {
        const r = canvas.getBoundingClientRect()
        const size = 22
        eraserCursor.style.width = size + 'px'
        eraserCursor.style.height = size + 'px'
        eraserCursor.style.left = e.clientX - r.left - size / 2 + 'px'
        eraserCursor.style.top = e.clientY - r.top - size / 2 + 'px'
        return
      }
      // 悬停反馈：选择模式下手柄 → 缩放光标、标注 → 移动光标、空白 → 默认；绘制工具 → 十字
      if (tool === null) {
        const hoverHandle = hitHandle(toCanvasPt(e))
        if (hoverHandle) {
          canvas.style.cursor = modeCursor(hoverHandle)
          return
        }
        const hover = hitTest(toCanvasPt(e))
        canvas.style.cursor = hover ? 'move' : 'default'
        return
      }
      const hover = hitTest(toCanvasPt(e))
      canvas.style.cursor = hover ? 'move' : 'crosshair'
    })
    canvas.addEventListener('pointerleave', () => {
      eraserCursor.style.display = 'none'
    })

    // ---- 文字编辑（新建 / 双击编辑共用）：textarea 多行 ----
    // Enter 换行（textarea 默认行为）；Ctrl/Cmd+Enter 完成；Esc 取消；点击其他区域保存
    const openTextEditor = (existing: Ann | null, p?: { x: number; y: number }) => {
      if (wrap.querySelector('.os-text-input')) return
      const x = existing?.x ?? p!.x
      const y = existing?.y ?? p!.y
      const colorUsed = existing?.color ?? color
      const sizeUsed = existing?.size ?? Math.max(14, 12 + SIZES[widthIdx] * 3) * dpr
      const ta = document.createElement('textarea')
      ta.className = 'os-text-input os-text-area'
      ta.rows = 1
      ta.spellcheck = false
      ta.style.left = x / dpr - 3 + 'px'
      ta.style.top = y / dpr - 5 + 'px'
      ta.style.fontSize = sizeUsed / dpr + 'px'
      ta.style.lineHeight = '1.35' // 与渲染 lineHeightOf 保持一致
      ta.style.color = colorUsed
      // 编辑框宽度与渲染时的自然换行宽度一致，编辑所见即导出所得
      const maxWCss = Math.max(80, Math.min(320, (canvas.width - x) / dpr - 10, sel.w - x / dpr - 8))
      ta.style.width = maxWCss + 'px'
      ta.value = existing?.text ?? ''
      ta.placeholder = '输入文字：Enter 换行，Ctrl+Enter 完成'
      const autoHeight = () => {
        ta.style.height = 'auto'
        ta.style.height = ta.scrollHeight + 'px'
      }
      wrap.appendChild(ta)
      autoHeight()
      setTimeout(() => {
        ta.focus()
        if (existing) ta.select()
      }, 0)

      const before = existing ? geomOf(existing) : null
      let done = false
      const commit = () => {
        if (done) return
        done = true
        const v = ta.value.replace(/\s+$/, '')
        ta.remove()
        if (!v.trim()) {
          if (existing) deleteAnn(existing) // 清空等同删除（可撤销）
        } else if (existing) {
          if (v !== existing.text) {
            existing.text = v
            undoStack.push({ type: 'geom', ann: existing, before: before!, after: geomOf(existing) })
            redoStack.length = 0
          }
        } else {
          commitAdd({ kind: 'text', x, y, text: v, color: colorUsed, size: sizeUsed })
        }
        render()
      }
      const cancel = () => {
        if (done) return
        done = true
        ta.remove()
        render()
      }
      ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation() // 文字编辑中不触发编辑器的全局快捷键（Delete/撤销/E 等）
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault()
          commit()
        } else if (ev.key === 'Escape') {
          cancel()
        } else if (ev.key === 'Enter') {
          setTimeout(autoHeight, 0) // 默认行为 = 插入换行
        }
      })
      ta.addEventListener('input', autoHeight)
      ta.addEventListener('blur', commit)
    }

    // ---- 工具栏 ----
    const btn = (html: string, title: string, onClick: () => void, cls = 'os-tbtn') => {
      const b = document.createElement('button')
      b.className = cls
      b.innerHTML = html
      b.title = title
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick()
      })
      return b
    }

    const toolBtns: HTMLButtonElement[] = []
    const syncToolBtns = () => {
      toolBtns.forEach((b) => {
        const id = b.dataset.tool as Tool | 'select'
        b.classList.toggle('os-active', id === 'select' ? tool === null : id === tool)
      })
    }
    /** 工具状态机：null = 选择/编辑。切换工具不清除已有标注，也不清除当前选中对象 */
    const setTool = (t: Tool | null) => {
      tool = t
      syncToolBtns()
      canvas.style.cursor = t === null ? 'default' : 'crosshair'
      updateEraserCursor()
      scheduleRender()
    }
    TOOL_LIST.forEach((t) => {
      const b = btn(t.icon, t.title, () => {
        if (t.id === 'select') setTool(null)
        else setTool(tool === t.id ? null : t.id) // 再次点击已激活工具 → 回到选择/编辑模式
      })
      b.dataset.tool = t.id
      toolBtns.push(b)
    })
    syncToolBtns()

    const colorBtns: HTMLButtonElement[] = []
    COLORS.forEach((c) => {
      const b = document.createElement('button')
      b.className = 'os-tcolor' + (c === color ? ' os-active' : '')
      b.style.background = c
      b.title = '颜色'
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        color = c
        // 选中状态下改色 → 直接改选中标注颜色（可撤销）
        if (selected) {
          const before = geomOf(selected)
          selected.color = c
          undoStack.push({ type: 'geom', ann: selected, before, after: geomOf(selected) })
          redoStack.length = 0
          render()
        }
        colorBtns.forEach((x) => x.classList.remove('os-active'))
        b.classList.add('os-active')
      })
      colorBtns.push(b)
    })

    const sizeBtns: HTMLButtonElement[] = []
    const sizeLabels = ['细', '中', '粗']
    SIZES.forEach((_, i) => {
      const b = btn(sizeLabels[i], `线宽：${sizeLabels[i]}（画布上滚动滚轮可调）`, () => {
        widthIdx = i
        sizeBtns.forEach((x) => x.classList.remove('os-active'))
        b.classList.add('os-active')
      })
      if (i === widthIdx) b.classList.add('os-active')
      sizeBtns.push(b)
    })

    const undoBtn = btn('↩', '撤销（Ctrl+Z）', applyUndo)
    const redoBtn = btn('↪', '重做（Ctrl+Shift+Z）', applyRedo)
    const doneBtn = btn('✓', '完成，打开环形菜单', () => finish(false), 'os-tbtn os-tbtn-done')
    const cancelBtn = btn('✕', '取消截图', () => finish(true), 'os-tbtn os-tbtn-cancel')

    toolbar.append(
      ...toolBtns,
      sep(),
      ...colorBtns,
      sep(),
      ...sizeBtns,
      sep(),
      undoBtn,
      redoBtn,
      sep(),
      doneBtn,
      cancelBtn
    )

    function sep() {
      const s = document.createElement('div')
      s.className = 'os-tsep'
      return s
    }

    // 工具栏定位：选区上方优先，靠顶则放下方
    const placeToolbar = () => {
      const tw = toolbar.offsetWidth || 480
      const left = Math.max(8, Math.min(sel.x + sel.w / 2 - tw / 2, window.innerWidth - tw - 8))
      const top = sel.y > 64 ? sel.y - 54 : sel.y + sel.h + 12
      toolbar.style.left = left + 'px'
      toolbar.style.top = Math.min(top, window.innerHeight - 60) + 'px'
    }

    // ---- 结束 ----
    const onKey = (e: KeyboardEvent) => {
      // 文字编辑中不拦截（textarea 的 keydown 已自行 stopPropagation，这里再兜底）
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space') {
        // 按住空格 → 临时整体平移模式，松开恢复
        if (!spaceHeld) {
          spaceHeld = true
          if (!pan) canvas.style.cursor = 'grab'
        }
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        if (selected) {
          selected = null
          render()
        } else if (tool !== null) {
          setTool(null) // 回到选择/编辑模式
        } else {
          finish(true)
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) applyRedo()
        else applyUndo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete/Backspace 删除选中的标注（可撤销）
        if (!selected) return
        e.preventDefault()
        deleteAnn(selected)
        selected = null
        render()
      } else if (e.key.toLowerCase() === 'e') {
        // 快捷键 E 切换橡皮擦
        setTool('eraser')
      } else if (e.key.toLowerCase() === 'v') {
        // 快捷键 V 回到选择/编辑模式
        setTool(null)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceHeld = false
      if (!pan) canvas.style.cursor = tool === null ? 'default' : 'crosshair'
    }

    let finished = false
    function finish(canceled: boolean) {
      if (finished) return
      finished = true
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      toolbar.remove()
      wrap.remove()
      if (canceled) {
        resolve({ canceled: true })
      } else {
        resolve({
          canceled: false,
          canvas,
          anns: [...anns],
          // 环形菜单跟随平移后的视口中心（导出画布仍按原始图片坐标，不受平移影响）
          center: { x: sel.x + sel.w / 2 + panX, y: sel.y + sel.h / 2 + panY },
          sel,
        })
      }
    }

    shadow.append(wrap, toolbar)
    placeToolbar()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    render()
  })
}
