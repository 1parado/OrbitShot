/**
 * Compare 平台适配器基类：定义统一的平台交互接口与通用工具。
 *
 * 子类只声明「候选选择器 + 页面特征」，通用逻辑（等待元素、填充验证、
 * 生成状态判定、流式观察）都在这里实现，避免三个平台各写一套。
 *
 * 约束：
 * - 本文件会被序列化后注入目标 AI 页面执行？不——适配器通过 manifest 的
 *   content script 常驻注入（与截图模块同文件入口），可直接使用 chrome.runtime。
 * - 选择器按命中概率排序，稳定属性 / 语义属性优先。
 * - 所有「成功」都必须有 DOM 证据，不允许假设。
 */

export interface DomProbe {
  /** 输入区候选选择器（按优先级） */
  composer: string[]
  /** 发送按钮候选选择器（可选；多数站点可直接回车/按钮） */
  submit?: string[]
  /** 回答容器候选（可选；缺失时 compare-entry 走通用启发式） */
  answer?: string[]
  /** 生成中标志：停止按钮 / 生成中指示器（存在 = 生成中） */
  generating?: string[]
  /** 生成结束标志（可选，如「重新生成」按钮出现） */
  finished?: string[]
}

export interface PromptSubmitResult {
  ok: boolean
  error?: string
}

/** 轮询等待选择器出现 */
export function waitForSelector(
  selectors: string[],
  timeoutMs: number,
  root: ParentNode = document
): Promise<HTMLElement | null> {
  const find = (): HTMLElement | null => {
    for (const s of selectors) {
      const el = root.querySelector<HTMLElement>(s)
      if (el && isVisible(el)) return el
    }
    return null
  }
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      const el = find()
      if (el) return resolve(el)
      if (Date.now() - t0 > timeoutMs) return resolve(null)
      setTimeout(tick, 250)
    }
    tick()
  })
}

export function isVisible(el: Element): boolean {
  return !!(el.clientWidth || el.clientHeight || el.getClientRects().length)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 往输入区填文本并验证真实生效。
 * - contenteditable：聚焦 → execCommand('insertText')（走浏览器原生输入路径，
 *   React 受控编辑器一般会收到 input 事件）；失败回退 paste 事件合成。
 * - textarea/input：设 value + 派发 input 事件（React 需要原生 setter）。
 * 填充后读取真实内容比对，不匹配即报错。
 */
export async function fillComposer(el: HTMLElement, text: string): Promise<boolean> {
  const isContentEditable =
    el instanceof HTMLElement && el.isContentEditable
  el.focus()
  await sleep(120)
  if (isContentEditable) {
    const sel = window.getSelection()
    // 光标移到末尾
    if (sel && el.contains(sel.anchorNode)) {
      sel.selectAllChildren(el)
      sel.collapseToEnd()
    }
    const ok = document.execCommand('insertText', false, text)
    if (!ok) {
      // 回退：合成 paste 事件
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      )
    }
  } else {
    const setter = Object.getOwnPropertyDescriptor(
      (el as HTMLTextAreaElement).constructor.prototype,
      'value'
    )?.set
    if (setter) setter.call(el, text)
    else (el as HTMLTextAreaElement).value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await sleep(200)
  // 验证：编辑器真实内容包含目标文本（允许站点做 markdown 规范化差异）
  const cur = readComposerText(el)
  return cur.replace(/\s+/g, '').includes(text.replace(/\s+/g, '').slice(0, 120))
}

export function readComposerText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return el.textContent ?? ''
}

/**
 * 提交：优先点发送按钮（可见且未禁用），否则对输入区发 Enter。
 * 返回是否找到可用的提交途径；提交是否真正生效由调用方验证。
 */
export async function clickSubmit(el: HTMLElement, submitSelectors?: string[]): Promise<boolean> {
  if (submitSelectors?.length) {
    for (const s of submitSelectors) {
      for (const btn of document.querySelectorAll<HTMLElement>(s)) {
        if (isVisible(btn) && !(btn as HTMLButtonElement).disabled) {
          btn.click()
          return true
        }
      }
    }
  }
  // 回退：Enter 提交（无 Shift；多数站点支持）
  el.focus()
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  })
  el.dispatchEvent(ev)
  return true
}

/** 文本稳定性检测：连续 stableMs 无变化视为渲染完成 */
export class TextStability {
  private last = ''
  private lastChange = Date.now()

  feed(text: string): boolean {
    if (text !== this.last) {
      this.last = text
      this.lastChange = Date.now()
      return false
    }
    return Date.now() - this.lastChange >= 800
  }
}
