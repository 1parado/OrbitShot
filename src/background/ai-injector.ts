/**
 * AI 网页图片注入器。
 * 该文件导出的函数会被 chrome.scripting.executeScript 序列化后注入目标 AI 页面执行，
 * 因此 injectAiImages 必须完全自包含：不引用任何外部标识符、不依赖扩展 API。
 *
 * 传递原理：把 PNG 转成 File 放进 DataTransfer，在输入区派发合成 paste 事件——
 * ChatGPT(ProseMirror)/Claude(Lexical)/Gemini(Quill)/DeepSeek(textarea) 等
 * 编辑器都会监听 paste 事件并读取 clipboardData.files，这是各站通用的受支持交互路径。
 *
 * 探测策略：站点适配表给出候选选择器（稳定属性优先），与通用回退合并去重后
 * 逐个尝试——用第一张图粘贴并观察附件预览是否增长，命中即锁定该编辑器粘剩余图，
 * 未命中换下一个候选（最多 3 个）。未收录站点（用户自定义 AI）走通用探测，原理相同。
 * 验证：轮询 DOM 中新增的 blob:/data: 图片（含内联 background-image 形式，覆盖
 * Grok 等用背景图渲染附件缩略图的站点），不做虚假成功提示。
 */

export interface InjectResult {
  status: 'inserted' | 'pasted-unverified' | 'no-editor' | 'error'
  detail?: string
}

export async function injectAiImages(
  dataUrls: string[],
  editorTimeoutMs: number,
  lang: string
): Promise<InjectResult> {
  // ---- 站点适配表：host → 编辑器候选选择器（按命中概率排序）；未收录 host 走通用回退 ----
  const SITES: Record<string, string[]> = {
    'chatgpt.com': ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
    'claude.ai': ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    'gemini.google.com': ['div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    'chat.deepseek.com': ['textarea#chat-input', 'textarea'],
    'www.doubao.com': ['div[contenteditable="true"][data-testid="chat_input_input"]', 'div[contenteditable="true"]'],
    // Kimi：新版已迁移 kimi.com，旧域名 moonshot 兼容
    'kimi.moonshot.cn': ['div#editor', 'div[contenteditable="true"]'],
    'www.kimi.com': ['div#editor', 'div[contenteditable="true"]', 'textarea'],
    'kimi.com': ['div#editor', 'div[contenteditable="true"]', 'textarea'],
    'tongyi.aliyun.com': ['textarea', 'div[contenteditable="true"]'],
    'www.tongyi.com': ['textarea', 'div[contenteditable="true"]'],
    // Grok：编辑器是 contenteditable + role=textbox（aria-label 随语言变化，中英文各一条）
    'grok.com': [
      '[aria-label="Ask Grok anything"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[aria-label]',
      'div[contenteditable="true"]',
    ],
    'www.perplexity.ai': ['div[contenteditable="true"]', 'textarea'],
    'copilot.microsoft.com': ['textarea', 'div[contenteditable="true"]'],
    'chat.mistral.ai': ['div[contenteditable="true"]', 'textarea'],
    // 腾讯元宝：Quill 编辑器
    'yuanbao.tencent.com': ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    // 文心一言：textarea#chat-input（新版 yi.baidu.com 同构）
    'yiyan.baidu.com': ['textarea#chat-input', '#chat-input', 'textarea'],
    'yi.baidu.com': ['textarea#chat-input', '#chat-input', 'textarea'],
    // 智谱清言
    'chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
    'www.chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
  }

  // ---- 页内提示 pill 文案：跟随扩展设置语言（由 SW 传入），未知语言回退简体 ----
  const MSG: Record<string, { ok1: string; okN: string; fail: string }> = {
    'zh-CN': {
      ok1: 'OrbitShot：截图已添加到输入框，可继续输入后发送',
      okN: 'OrbitShot：{n} 张截图已添加到输入框，可继续输入后发送',
      fail: 'OrbitShot：未能自动添加截图 — 请在输入框按 Ctrl+V 粘贴',
    },
    'zh-TW': {
      ok1: 'OrbitShot：截圖已加入輸入框，可繼續輸入後傳送',
      okN: 'OrbitShot：{n} 張截圖已加入輸入框，可繼續輸入後傳送',
      fail: 'OrbitShot：無法自動加入截圖 — 請在輸入框按 Ctrl+V 貼上',
    },
    en: {
      ok1: 'OrbitShot: Screenshot added to the input box — type your question and send',
      okN: 'OrbitShot: {n} screenshots added to the input box — type and send',
      fail: 'OrbitShot: Auto-add failed — press Ctrl+V in the input box to paste',
    },
  }
  const m = MSG[lang] ?? MSG['zh-CN']
  const pill = (ok: boolean, n: number) => {
    const text = ok ? (n > 1 ? m.okN.replace('{n}', String(n)) : m.ok1) : m.fail
    const d = document.createElement('div')
    d.textContent = text
    d.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:2147483647;max-width:460px;' +
      'background:' + (ok ? 'rgba(15,23,42,0.92)' : 'rgba(190,30,45,0.94)') + ';color:#fff;' +
      'padding:10px 16px;border-radius:10px;font:13px/1.5 system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.3);'
    document.body.appendChild(d)
    setTimeout(() => d.remove(), ok ? 4200 : 7000)
  }

  try {
    // ---- 0. 候选列表：站点专属 + 通用回退，按序去重 ----
    const generic = ['div[contenteditable="true"]', 'textarea', '[role="textbox"]']
    const candidates = [...(SITES[location.host] ?? []), ...generic].filter(
      (s, i, a) => a.indexOf(s) === i
    )
    const visible = (el: Element): boolean =>
      !!(el.clientWidth || el.clientHeight || el.getClientRects().length)
    const findEditor = (): HTMLElement | null => {
      for (const s of candidates) {
        const el = document.querySelector<HTMLElement>(s)
        if (el && visible(el) && !(el as HTMLTextAreaElement).disabled) return el
      }
      return null
    }
    // 附件预览：img 形式 + 内联 background-image 形式（Grok/xAI 等用背景图渲染缩略图）
    const countPreviews = () =>
      document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [style*="blob:"], [style*="data:image"]'
      ).length
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // ---- 1. 等待任一候选编辑器出现（SPA 渲染慢 / 路由未就绪） ----
    let probeEl = findEditor()
    const t0 = Date.now()
    while (!probeEl) {
      if (Date.now() - t0 > editorTimeoutMs) {
        pill(false, dataUrls.length)
        return { status: 'no-editor' }
      }
      await sleep(300)
      probeEl = findEditor()
    }

    // ---- 2. 组装 File（一次解码，多轮复用） ----
    const files: File[] = []
    for (let i = 0; i < dataUrls.length; i++) {
      const blob = await (await fetch(dataUrls[i])).blob()
      files.push(new File([blob], 'orbitshot-' + (i + 1) + '.png', { type: 'image/png' }))
    }
    const pasteOne = async (editor: HTMLElement, file: File) => {
      const dt = new DataTransfer()
      dt.items.add(file)
      editor.focus()
      editor.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        } as ClipboardEventInit)
      )
    }
    /** 粘贴一张并观察 deltaMs 内附件预览是否增长（粘贴 → 渲染附件的探测窗口） */
    const pasteAndProbe = async (editor: HTMLElement, file: File): Promise<boolean> => {
      const before = countPreviews()
      await pasteOne(editor, file)
      const deadline = Date.now() + 2800
      while (Date.now() < deadline) {
        await sleep(300)
        if (countPreviews() > before) return true
      }
      return false
    }

    // ---- 3. 用第一张图探测真正接受粘贴的编辑器（最多 3 个候选，防重复粘贴） ----
    let editor: HTMLElement | null = null
    if (await pasteAndProbe(probeEl, files[0])) {
      editor = probeEl
    } else {
      let tried = 1
      for (const s of candidates) {
        if (tried >= 3) break
        const el = document.querySelector<HTMLElement>(s)
        if (!el || !visible(el) || (el as HTMLTextAreaElement).disabled || el === probeEl) continue
        tried++
        if (await pasteAndProbe(el, files[0])) {
          editor = el
          break
        }
      }
    }

    // ---- 4. 命中编辑器：粘剩余图片（保持顺序，间隔等站点渲染附件） ----
    if (editor) {
      for (let i = 1; i < files.length; i++) {
        await pasteOne(editor, files[i])
        await sleep(350)
      }
    }

    // ---- 5. 最终验证：等待附件预览 ≥ n 张 ----
    const target = dataUrls.length
    const verifyMs = 12000
    const tv = Date.now()
    for (;;) {
      if (countPreviews() >= target) {
        pill(true, dataUrls.length)
        return { status: 'inserted' }
      }
      if (Date.now() - tv > verifyMs) break
      await sleep(400)
    }
    // 未全部检测到预览：不做虚假成功提示，如实回报进度
    const got = Math.min(dataUrls.length, countPreviews())
    pill(false, dataUrls.length)
    return { status: editor ? 'pasted-unverified' : 'no-editor', detail: got + '/' + dataUrls.length }
  } catch (e) {
    pill(false, dataUrls.length)
    return { status: 'error', detail: e instanceof Error ? e.message : String(e) }
  }
}
