// 框选截图：冻结页面快照为背景，拖拽选出区域

export interface SelRect {
  x: number
  y: number
  w: number
  h: number
}

export function startSelection(shadow: ShadowRoot, img: HTMLImageElement): Promise<SelRect | null> {
  return new Promise((resolve) => {
    const layer = document.createElement('div')
    layer.className = 'os-layer os-cursor-cross'

    const freeze = img.cloneNode() as HTMLImageElement
    freeze.className = 'os-freeze-img'
    freeze.style.width = window.innerWidth + 'px'
    freeze.style.height = window.innerHeight + 'px'

    const hint = document.createElement('div')
    hint.className = 'os-hint'
    hint.textContent = '拖拽框选截图区域 · Esc 取消'

    const sel = document.createElement('div')
    sel.className = 'os-selection'
    sel.style.display = 'none'

    const badge = document.createElement('div')
    badge.className = 'os-size-badge'
    badge.style.display = 'none'

    layer.append(freeze, sel, badge, hint)
    shadow.appendChild(layer)

    let startX = 0
    let startY = 0
    let dragging = false

    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
      layer.remove()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cleanup()
        resolve(null)
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging = true
      startX = e.clientX
      startY = e.clientY
      sel.style.display = 'block'
      badge.style.display = 'block'
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const x = Math.min(startX, e.clientX)
      const y = Math.min(startY, e.clientY)
      const w = Math.abs(e.clientX - startX)
      const h = Math.abs(e.clientY - startY)
      sel.style.left = x + 'px'
      sel.style.top = y + 'px'
      sel.style.width = w + 'px'
      sel.style.height = h + 'px'
      badge.style.left = x + 'px'
      badge.style.top = Math.max(2, y - 26) + 'px'
      badge.textContent = `${Math.round(w)} × ${Math.round(h)}`
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return
      dragging = false
      const x = Math.min(startX, e.clientX)
      const y = Math.min(startY, e.clientY)
      const w = Math.abs(e.clientX - startX)
      const h = Math.abs(e.clientY - startY)
      if (w < 8 && h < 8) {
        cleanup()
        resolve(null)
        return
      }
      cleanup()
      resolve({
        x: Math.max(0, x),
        y: Math.max(0, y),
        w: Math.min(window.innerWidth - Math.max(0, x), w),
        h: Math.min(window.innerHeight - Math.max(0, y), h),
      })
    }

    layer.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKey, true)
  })
}

// 从整屏快照裁剪出选区画布（device px 精度）
export function cropCanvas(img: HTMLImageElement, s: SelRect, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(s.w * dpr))
  canvas.height = Math.max(1, Math.round(s.h * dpr))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(
    img,
    s.x * dpr,
    s.y * dpr,
    s.w * dpr,
    s.h * dpr,
    0,
    0,
    canvas.width,
    canvas.height
  )
  return canvas
}
