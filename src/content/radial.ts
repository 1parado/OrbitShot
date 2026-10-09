// 环形菜单：围绕中心点展开的两级径向菜单
// 中心把手可拖动，整体菜单跟随；悬停条目时下方显示本地化文字标签

export interface RadialItem {
  id: string
  label: string
  /** 回退字符（无 svg / iconUrl 时显示） */
  icon: string
  /** 内联 SVG 图标（stroke: currentColor），优先于 icon 字符 */
  svg?: string
  iconUrl?: string // logo 图标（data URL 或远程 URL），优先于 svg
  iconFallbacks?: string[] // iconUrl 加载失败时依次回退的候选 URL
  /** 是否可被 Ctrl+点击多选（如 AI 条目） */
  selectable?: boolean
}

// ---- 统一风格的线性图标（24 viewBox，stroke currentColor） ----

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const RADIAL_ICON = {
  /** 发送到 AI：星光 */
  ai: wrap(
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>'
  ),
  /** 继续标注：铅笔 */
  annotate: wrap(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'
  ),
  /** 复制 */
  copy: wrap(
    '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
  ),
  /** 下载 */
  download: wrap(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
  ),
  /** 重新截图 */
  recapture: wrap(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
  ),
  /** 关闭 */
  close: wrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  /** 返回 */
  back: wrap('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  /** 存入暂存区：托盘/晾晒 */
  stash: wrap(
    '<path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/><path d="M3 13h5l2 3h4l2-3h5"/><path d="M12 3v9"/><path d="m8 8 4 4 4-4"/>'
  ),
  /** 设置 */
  settings: wrap(
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
  ),
} as const

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

export function showRadial(
  shadow: ShadowRoot,
  center: { x: number; y: number },
  items: RadialItem[],
  onPick: (id: string) => void,
  opts?: {
    hubTitle?: string
    /** 多选模式：Ctrl+点击切换选中，点中心把手批量确认 */
    multi?: { hint: string; onConfirm: (selected: string[]) => void }
  }
): void {
  // 统一动态布局：半径随条目数线性增长（非逐数量硬编码），保证 5~14 个条目
  // 沿同一圆周均匀分布、互不重叠；中心把手始终固定在圆心 (cx, cy)
  const dist = Math.min(116, Math.max(78, 64 + items.length * 4.4))

  // 中心点（夹取到视口内）
  let cx = clamp(center.x, 40, window.innerWidth - 40)
  let cy = clamp(center.y, 40, window.innerHeight - 40)

  const backdrop = document.createElement('div')
  backdrop.className = 'os-radial-backdrop'

  const hub = document.createElement('div')
  hub.className = 'os-radial-hub'
  hub.textContent = '✦'
  if (opts?.hubTitle) hub.title = opts.hubTitle

  // 悬停标签（本地化文字，i18n 可见化）
  const label = document.createElement('div')
  label.className = 'os-radial-label'

  // ---- 多选（Ctrl+点击）----
  const selected = new Set<string>()
  const badge = document.createElement('span')
  badge.className = 'os-radial-badge'
  badge.style.display = 'none'
  if (opts?.multi) hub.appendChild(badge)

  let hintTimer: ReturnType<typeof setTimeout> | null = null
  const updateBadge = () => {
    if (!opts?.multi) return
    if (selected.size > 0) {
      badge.textContent = String(selected.size)
      badge.style.display = 'flex'
    } else {
      badge.style.display = 'none'
    }
  }

  const btns: HTMLButtonElement[] = items.map((item, i) => {
    const angle = (-90 + (360 / items.length) * i) * (Math.PI / 180)
    const b = document.createElement('button')
    if (item.iconUrl) {
      b.className = 'os-radial-item os-has-icon'
      const img = document.createElement('img')
      img.src = item.iconUrl
      img.alt = item.label
      img.draggable = false
      img.referrerPolicy = 'no-referrer'
      // favicon 回退链：主源失败后依次尝试候选
      const fallbacks = item.iconFallbacks ?? []
      let fi = 0
      img.onerror = () => {
        if (fi < fallbacks.length) img.src = fallbacks[fi++]
        else img.onerror = null
      }
      b.appendChild(img)
    } else if (item.svg) {
      b.className = 'os-radial-item'
      b.innerHTML = item.svg
    } else {
      b.className = 'os-radial-item'
      b.textContent = item.icon
    }
    b.title = item.label
    b.style.setProperty('--dx', Math.cos(angle) * dist + 'px')
    b.style.setProperty('--dy', Math.sin(angle) * dist + 'px')
    b.addEventListener('mouseenter', () => {
      label.textContent = item.label
      label.classList.add('os-show')
    })
    b.addEventListener('mouseleave', () => label.classList.remove('os-show'))
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      // Ctrl/Cmd+点击：切换多选状态，菜单保持打开
      if (opts?.multi && item.selectable && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (selected.has(item.id)) {
          selected.delete(item.id)
          b.classList.remove('os-selected')
        } else {
          selected.add(item.id)
          b.classList.add('os-selected')
        }
        updateBadge()
        return
      }
      cleanup()
      onPick(item.id)
    })
    return b
  })

  // ---- 拖动：按住中心把手移动整个菜单 ----
  let dragStart: { px: number; py: number; cx: number; cy: number; moved: boolean } | null = null

  const applyPosition = () => {
    hub.style.left = cx + 'px'
    hub.style.top = cy + 'px'
    btns.forEach((b) => {
      b.style.left = cx + 'px'
      b.style.top = cy + 'px'
    })
    label.style.left = cx + 'px'
    label.style.top = cy + 42 + 'px'
  }

  const onHubDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragStart = { px: e.clientX, py: e.clientY, cx, cy, moved: false }
    hub.setPointerCapture(e.pointerId)
    hub.classList.add('os-dragging')
    btns.forEach((b) => b.classList.add('os-dragging'))
  }

  const onHubMove = (e: PointerEvent) => {
    if (!dragStart) return
    const dx = e.clientX - dragStart.px
    const dy = e.clientY - dragStart.py
    if (Math.abs(dx) + Math.abs(dy) > 3) dragStart.moved = true
    cx = clamp(dragStart.cx + dx, 40, window.innerWidth - 40)
    cy = clamp(dragStart.cy + dy, 40, window.innerHeight - 40)
    applyPosition()
  }

  const onHubUp = (e: PointerEvent) => {
    if (!dragStart) return
    const wasClick = !dragStart.moved
    dragStart = null
    hub.classList.remove('os-dragging')
    btns.forEach((b) => b.classList.remove('os-dragging'))
    try {
      hub.releasePointerCapture(e.pointerId)
    } catch {
      /* 已释放 */
    }
    // 点中心把手（未拖动）：批量发送已选中的 AI
    if (wasClick && opts?.multi && selected.size > 0) {
      const ids = [...selected]
      cleanup()
      opts.multi.onConfirm(ids)
    }
  }

  hub.addEventListener('pointerdown', onHubDown)
  hub.addEventListener('pointermove', onHubMove)
  hub.addEventListener('pointerup', onHubUp)
  hub.addEventListener('pointercancel', onHubUp)

  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true)
    if (hintTimer) clearTimeout(hintTimer)
    backdrop.remove()
    btns.forEach((b) => b.remove())
    hub.remove()
    label.remove()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cleanup()
      onPick('dismiss')
    }
  }

  backdrop.addEventListener('mousedown', () => {
    cleanup()
    onPick('dismiss')
  })

  shadow.append(backdrop, ...btns, hub, label)
  applyPosition()

  // 多选模式：开场提示「Ctrl+点击多选」，2.5s 后自动淡出
  if (opts?.multi) {
    label.textContent = opts.multi.hint
    label.classList.add('os-show')
    hintTimer = setTimeout(() => label.classList.remove('os-show'), 2500)
  }

  // 入场动画：下一帧再加 class 触发 transition
  requestAnimationFrame(() =>
    requestAnimationFrame(() => btns.forEach((b) => b.classList.add('os-in')))
  )

  window.addEventListener('keydown', onKey, true)
}
