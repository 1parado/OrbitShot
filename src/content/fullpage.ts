// 整页截图：分段滚动 + 垂直拼接（beta：固定导航栏等元素可能重复出现）

interface CaptureResp {
  ok: boolean
  dataUrl?: string
  error?: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function captureFullPage(
  shadow: ShadowRoot,
  requestCapture: () => Promise<string>
): Promise<HTMLCanvasElement | null> {
  const dpr = window.devicePixelRatio || 1
  const viewportH = window.innerHeight
  const doc = document.documentElement
  const scrollHeight = doc.scrollHeight
  const maxScroll = Math.max(0, scrollHeight - viewportH)

  // canvas 高度上限保护
  const CAP_H = 32000
  const fullCssH = Math.min(scrollHeight, CAP_H / dpr)

  const badge = document.createElement('div')
  badge.className = 'os-fp-badge'
  badge.textContent = '正在截取整页…'
  shadow.appendChild(badge)

  const origY = window.scrollY
  const shots: { img: HTMLImageElement; y: number }[] = []

  try {
    if (maxScroll < 4) {
      // 单屏即是整页
      const dataUrl = await requestCapture()
      const img = await loadImg(dataUrl)
      shots.push({ img, y: 0 })
    } else {
      const step = viewportH
      for (let y = 0; y <= maxScroll; y += step) {
        const targetY = Math.min(y, maxScroll)
        window.scrollTo(0, targetY)
        await sleep(420) // 等待滚动/懒加载稳定

        // 捕获瞬间隐藏进度角标
        badge.style.display = 'none'
        await sleep(140)
        let dataUrl: string | null = null
        try {
          dataUrl = await requestCapture()
        } catch {
          badge.style.display = ''
          badge.textContent = `整页截图失败（y=${targetY}），已中止`
          await sleep(2200)
          return null
        }
        badge.style.display = ''
        const img = await loadImg(dataUrl)
        shots.push({ img, y: targetY })

        const pct = Math.round((Math.min(targetY + step, scrollHeight) / scrollHeight) * 100)
        badge.textContent = `正在截取整页… ${pct}%`
        if (targetY >= maxScroll) break
      }
    }
  } finally {
    window.scrollTo(0, origY)
    badge.remove()
  }

  // ---- 拼接 ----
  const scale = shots[0].img.naturalWidth / window.innerWidth
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(window.innerWidth * scale)
  canvas.height = Math.min(Math.round(fullCssH * scale), 32000)
  const ctx = canvas.getContext('2d')!

  for (const s of shots) {
    const dy = Math.min(Math.round(s.y * scale), canvas.height)
    ctx.drawImage(s.img, 0, dy)
  }

  return canvas
}

function loadImg(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('截图数据解析失败'))
    img.src = dataUrl
  })
}
