/**
 * 公式识别结果浮层（PRD §4.4/§4.5）：五态
 *   引导（模型未下载）→ 下载（进度/取消）→ 初始化 → 结果（预览+源码+复制）→ 失败（重试）
 *
 * - 锚定在框选区域下方（空间不足翻转到上方），Shadow DOM 内渲染；
 * - KaTeX 预览：katex.min.css 内联进浮层（字体经 web_accessible_resources
 *   的 chrome-extension:// 绝对地址加载）；源码编辑防抖 150ms 重渲染，
 *   语法错误时灰显原样源码不崩；
 * - 复制：navigator.clipboard；成功按钮 1.5s 反馈后恢复；
 * - 关闭：✕ / 点浮层外 / Esc（textarea 聚焦时先失焦）；关闭后由 annotator
 *   的 formula 工具状态机继续接受下一次框选（连续识别）。
 */
import katex from 'katex'
// eslint-disable-next-line
import katexCss from 'katex/dist/katex.min.css?inline'
import { t } from '../shared/dicts'
import type { Lang } from '../shared/settings'
import { loadSettings } from '../shared/settings'
import type { FormulaBroadcast } from '../shared/formula-models'

const FORMULA_MODEL_TOTAL_MB = 134 // decoder 48.6 + encoder 84.9 + tokenizer ≈ 1

interface PanelPos {
  /** 锚点（页面坐标，CSS px）：x=区域左缘，y=区域下缘 */
  x: number
  y: number
}

let panelEl: HTMLDivElement | null = null
let broadcastListener: ((m: FormulaBroadcast) => void) | null = null
let currentRequest: { requestId: string; dataUrl: string } | null = null
let cleanupFns: (() => void)[] = []

function cleanup(): void {
  cleanupFns.forEach((fn) => fn())
  cleanupFns = []
  currentRequest = null
}

export function closeFormulaPanel(): void {
  cleanup()
  panelEl?.remove()
  panelEl = null
  if (broadcastListener) {
    chrome.runtime.onMessage.removeListener(broadcastListener)
    broadcastListener = null
  }
}

/** KaTeX css 内联（字体路径重写为扩展内绝对地址） */
function katexStyleEl(): HTMLStyleElement {
  const st = document.createElement('style')
  // 构建后 crxjs 将 KaTeX 字体暴露为 assets/KaTeX_*（web_accessible_resources 已声明）
  const fontBase = chrome.runtime.getURL('assets/')
  st.textContent = (katexCss as string).replace(/url\(fonts\/([^)]+)\)/g, (_m, p) => `url(${fontBase}${p})`)
  return st
}

function renderPreviewTo(el: HTMLElement, tex: string): boolean {
  try {
    el.innerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: true })
    return true
  } catch {
    el.textContent = tex
    el.classList.add('os-formula-preview-err')
    return false
  }
}

/** 由 annotator 在框选完成后调用：打开浮层并按模型状态进入对应态 */
export function openFormulaPanel(shadow: ShadowRoot, dataUrl: string, pos: PanelPos): void {
  closeFormulaPanel()
  void loadSettings().then((s) => {
    void buildPanel(shadow, dataUrl, pos, s.formulaModelDeletedOnce === true, s.lang ?? 'zh-CN')
  })
}

function buildPanel(
  shadow: ShadowRoot,
  dataUrl: string,
  pos: PanelPos,
  deletedOnce: boolean,
  lang: Lang
): void {
  const panel = document.createElement('div')
  panel.className = 'os-formula-panel'
  panel.innerHTML = `
    <div class="os-formula-head">
      <span class="os-formula-title">${t(lang, 'formula.title')}</span>
      <button class="os-formula-close" title="${t(lang, 'formula.close')}">✕</button>
    </div>
    <div class="os-formula-body"></div>
    <div class="os-formula-foot"><span class="os-formula-privacy">🔒 ${t(lang, 'formula.privacy')}</span></div>
  `
  shadow.appendChild(panelEl = panel)
  panel.prepend(katexStyleEl())

  const body = panel.querySelector('.os-formula-body') as HTMLDivElement
  panel.querySelector('.os-formula-close')?.addEventListener('click', () => closeFormulaPanel())

  // 点浮层外关闭（捕获阶段，textarea 聚焦时也生效）
  const dismiss = (e: MouseEvent) => {
    if (panelEl && !panelEl.contains(e.target as Node)) closeFormulaPanel()
  }
  window.addEventListener('mousedown', dismiss, true)
  cleanupFns.push(() => window.removeEventListener('mousedown', dismiss, true))
  // Esc：textarea 聚焦时先失焦，否则关闭
  const esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    const ta = panel.querySelector('.os-formula-src')
    if (ta && document.activeElement === ta) (ta as HTMLTextAreaElement).blur()
    else closeFormulaPanel()
  }
  window.addEventListener('keydown', esc, true)
  cleanupFns.push(() => window.removeEventListener('keydown', esc, true))

  // 位置：锚点下方，空间不足翻转到上方
  requestAnimationFrame(() => {
    const h = panel.offsetHeight || 220
    const below = window.innerHeight - pos.y > h + 16
    panel.style.left = Math.max(8, Math.min(pos.x - 20, window.innerWidth - 450)) + 'px'
    panel.style.top = (below ? pos.y + 10 : Math.max(8, pos.y - h - 10)) + 'px'
  })

  // ---- 广播监听：进度 → 下载态刷新；结果 → 结果/失败态 ----
  let startFn: (() => void) | null = null
  broadcastListener = (m: FormulaBroadcast) => {
    if (!panelEl) return
    if (m.type === 'FORMULA_PROGRESS') {
      if (m.progress.state === 'ready') {
        startFn?.()
        return
      }
      if (m.progress.state === 'downloading') {
        const fill = body.querySelector('.os-formula-bar-fill') as HTMLDivElement | null
        const lead = body.querySelector('.os-formula-lead')
        const file = body.querySelector('.os-formula-file')
        if (fill) fill.style.width = m.progress.percent + '%'
        if (lead) lead.textContent = t(lang, 'formula.model.downloading', { n: String(m.progress.percent) })
        if (file && m.progress.file) {
          file.textContent = `${m.progress.file} · ${((m.progress.receivedBytes ?? 0) / 1048576).toFixed(1)}MB`
        }
      }
      return
    }
    if (m.type === 'FORMULA_RESULT' && m.requestId === currentRequest?.requestId) {
      currentRequest = null
      if (m.ok && m.latex !== undefined) renderResult(lang, body, m.latex, m.warning === true)
      else renderFailed(lang, body, m.error || 'unknown')
    }
  }
  chrome.runtime.onMessage.addListener(broadcastListener)
  cleanupFns.push(() => {
    if (broadcastListener) chrome.runtime.onMessage.removeListener(broadcastListener)
  })

  // ---- 各态 ----

  startFn = () => startRecognition(lang, body, dataUrl)

  const renderGuide = () => {
    body.innerHTML = `
      <div class="os-formula-guide">
        <p class="os-formula-lead">${t(lang, 'formula.model.needed')}</p>
        <p class="os-formula-sub">${t(lang, 'formula.model.size', { n: String(FORMULA_MODEL_TOTAL_MB) })}</p>
        <p class="os-formula-privacy">🔒 ${t(lang, 'formula.privacy')}</p>
        <div class="os-formula-actions">
          <button class="os-formula-btn os-formula-primary">${t(lang, deletedOnce ? 'formula.model.retry' : 'formula.model.download')}</button>
          <button class="os-formula-btn os-formula-ghost">${t(lang, 'formula.close')}</button>
        </div>
      </div>
    `
    body.querySelector('.os-formula-primary')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'FORMULA_MODEL_DOWNLOAD' })
      renderDownloading(lang, body)
    })
    body.querySelector('.os-formula-ghost')?.addEventListener('click', () => closeFormulaPanel())
  }

  function renderDownloading(lang2: Lang, target: HTMLDivElement): void {
    target.innerHTML = `
      <div class="os-formula-guide">
        <p class="os-formula-lead">${t(lang2, 'formula.model.downloading', { n: '0' })}</p>
        <div class="os-formula-bar"><div class="os-formula-bar-fill" style="width:0%"></div></div>
        <p class="os-formula-sub os-formula-file"></p>
        <p class="os-formula-privacy">🔒 ${t(lang2, 'formula.privacy')}</p>
        <div class="os-formula-actions"><button class="os-formula-btn os-formula-ghost">${t(lang2, 'formula.close')}</button></div>
      </div>
    `
    target.querySelector('.os-formula-ghost')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'FORMULA_MODEL_CANCEL' })
    })
  }

  const renderResult = (lang2: Lang, target: HTMLDivElement, latex: string, warning: boolean): void => {
    target.innerHTML = `
      <div class="os-formula-sec">${t(lang2, 'formula.preview')}</div>
      <div class="os-formula-previewbox"></div>
      <div class="os-formula-sec">${t(lang2, 'formula.source')}</div>
      <textarea class="os-formula-src" rows="3"></textarea>
      ${warning ? `<div class="os-formula-warn">${t(lang2, 'formula.suspect')}</div>` : ''}
    `
    const ta = target.querySelector('.os-formula-src') as HTMLTextAreaElement
    const preview = target.querySelector('.os-formula-previewbox') as HTMLDivElement
    ta.value = latex
    const refresh = () => renderPreviewTo(preview, ta.value)
    refresh()
    let timer: ReturnType<typeof setTimeout> | null = null
    ta.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    })
    const copyBtn = document.createElement('button')
    copyBtn.className = 'os-formula-btn os-formula-primary'
    copyBtn.textContent = t(lang2, 'formula.copy')
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(ta.value).then(
        () => {
          copyBtn.textContent = t(lang2, 'formula.copied')
          setTimeout(() => (copyBtn.textContent = t(lang2, 'formula.copy')), 1500)
        },
        () => (copyBtn.textContent = t(lang2, 'formula.copy.failed'))
      )
    })
    ;(panel.querySelector('.os-formula-foot') as HTMLElement).prepend(copyBtn)
  }

  const renderFailed = (lang2: Lang, target: HTMLDivElement, msg: string): void => {
    target.innerHTML = `
      <div class="os-formula-guide">
        <p class="os-formula-warn">${t(lang2, 'formula.failed', { msg })}</p>
        <div class="os-formula-actions"><button class="os-formula-btn os-formula-primary">${t(lang2, 'formula.model.retry')}</button></div>
      </div>
    `
    target.querySelector('.os-formula-primary')?.addEventListener('click', () => startFn?.())
  }

  // ---- 初始态：按模型状态机进入 ----
  void chrome.runtime
    .sendMessage({ type: 'FORMULA_MODEL_STATE' })
    .then((resp: { ok: boolean; state?: string }) => {
      if (!panelEl || panelEl !== panel) return
      if (resp?.state === 'ready') {
        startFn?.()
      } else if (resp?.state === 'downloading') {
        renderDownloading(lang, body)
      } else if (resp?.state === 'initializing') {
        body.innerHTML = `<div class="os-formula-loading"><span class="os-formula-spin"></span><span>${t(lang, 'formula.model.verifying')}</span></div>`
      } else {
        renderGuide()
      }
    })
}

/** 识别请求状态（startRecognition 内部使用） */
function startRecognition(lang: Lang, body: HTMLDivElement, dataUrl: string): void {
  const requestId = crypto.randomUUID()
  currentRequest = { requestId, dataUrl }
  body.innerHTML = `
    <div class="os-formula-loading">
      <span class="os-formula-spin"></span>
      <span>${t(lang, 'formula.recognizing')}</span>
    </div>
  `
  void chrome.runtime.sendMessage({ type: 'FORMULA_OCR', requestId, dataUrl })
}
