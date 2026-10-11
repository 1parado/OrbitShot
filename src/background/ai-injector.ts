/**
 * AI 网页附件注入器（图片 / PDF / 文档等任意类型）。
 * 该文件导出的函数会被 chrome.scripting.executeScript 序列化后注入目标 AI 页面执行，
 * 因此 injectFiles 必须完全自包含：不引用任何外部标识符、不依赖扩展 API。
 *
 * 传递原理：把 dataUrl 转成 File（保留真实文件名与 MIME）放进 DataTransfer，
 * 在输入区派发合成 paste 事件——ChatGPT(ProseMirror)/Claude(Lexical)/Gemini(Quill)/
 * DeepSeek(textarea)/Grok 等编辑器都会监听 paste 事件并读取 clipboardData.files，
 * 这是各站通用的受支持交互路径（对应官方上传通道的任意 MIME 能力）。
 *
 * 探测策略：站点适配表给出候选选择器（稳定属性优先），与通用回退合并去重后
 * 逐个尝试——用第一个附件粘贴并观察附件信号是否增长（图片数 blob: 预览；
 * 非图片看编辑器容器 DOM 增长），命中即锁定该编辑器粘剩余文件，
 * 未命中换下一个候选（最多 3 个）。未收录站点（用户自定义 AI）走通用探测。
 * 验证：图片按预览计数；非图片无通用预览选择器，粘贴后确认容器有变化即报
 * pasted-unverified（不做虚假成功提示，用户在页面可见附件 chip）。
 */

export interface InjectResult {
  status: 'inserted' | 'pasted-unverified' | 'no-editor' | 'error'
  detail?: string
}

export interface InjectFile {
  name: string
  mime: string
  dataUrl: string
}

export async function injectFiles(
  items: InjectFile[],
  editorTimeoutMs: number,
  lang: string
): Promise<InjectResult> {
  // ---- 站点适配表：host → 编辑器候选选择器（按命中概率排序）；未收录 host 走通用回退 ----
  const SITES: Record<string, string[]> = {
    // ChatGPT 2026 登录版：ProseMirror 无 id（#prompt-textarea 旧版兼容）
    'chatgpt.com': ['div.ProseMirror[contenteditable="true"]', '#prompt-textarea'],
    'claude.ai': ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    'gemini.google.com': ['div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    // DeepSeek 2026 版：textarea 无 id（name="search"）
    'chat.deepseek.com': ['textarea[name="search"]', 'textarea'],
    // 豆包 2026 版：textarea[data-testid=chat_input_input]（旧 div 选择器失效）
    'www.doubao.com': ['[data-testid="chat_input_input"]', 'div[contenteditable="true"]'],
    // Kimi 2026 版：div.chat-input-editor（旧 #editor 失效）；旧域名 moonshot 兼容
    'kimi.moonshot.cn': ['div.chat-input-editor', 'div[contenteditable="true"]'],
    'www.kimi.com': ['div.chat-input-editor', 'div[contenteditable="true"]', 'textarea'],
    'kimi.com': ['div.chat-input-editor', 'div[contenteditable="true"]', 'textarea'],
    // 通义 2026 版：tongyi.com 302 到 qianwen.com，输入框是 contenteditable
    'tongyi.aliyun.com': ['div[contenteditable="true"]', 'textarea'],
    'www.tongyi.com': ['div[contenteditable="true"]', 'textarea'],
    'www.qianwen.com': ['div[contenteditable="true"]', 'textarea'],
    'qianwen.com': ['div[contenteditable="true"]', 'textarea'],
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
    // 文心 2026 版：yiyan.baidu.com 302 到 wenxin.baidu.com，输入框 id=chat-textarea
    'yiyan.baidu.com': ['textarea#chat-textarea', 'textarea#chat-input', '#chat-input', 'textarea'],
    'wenxin.baidu.com': ['textarea#chat-textarea', 'textarea', 'div[contenteditable="true"]'],
    'yi.baidu.com': ['textarea#chat-textarea', 'textarea#chat-input', '#chat-input', 'textarea'],
    // 智谱清言
    'chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
    'www.chatglm.cn': ['textarea', 'div[contenteditable="true"]'],
  }

  // ---- 页内提示 pill 文案：跟随扩展设置语言（由 SW 传入），未知语言回退简体 ----
  const MSG: Record<string, { ok1: string; okN: string; fail: string }> = {
    'zh-CN': {
      ok1: 'OrbitShot：附件已添加到输入框，可继续输入后发送',
      okN: 'OrbitShot：{n} 个附件已添加到输入框，可继续输入后发送',
      fail: 'OrbitShot：未能自动添加附件 — 请在输入框按 Ctrl+V 粘贴',
    },
    'zh-TW': {
      ok1: 'OrbitShot：附件已加入輸入框，可繼續輸入後傳送',
      okN: 'OrbitShot：{n} 個附件已加入輸入框，可繼續輸入後傳送',
      fail: 'OrbitShot：無法自動加入附件 — 請在輸入框按 Ctrl+V 貼上',
    },
    en: {
      ok1: 'OrbitShot: Attachment added to the input box — type your question and send',
      okN: 'OrbitShot: {n} attachments added to the input box — type and send',
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
    // 附件信号：图片走 blob:/data: 预览计数；非图片（PDF/文档）无通用预览
    // 选择器，改用编辑器容器的 DOM 体量变化（附件 chip/图标挂载都会撑大它）
    const countPreviews = () =>
      document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [style*="blob:"], [style*="data:image"]'
      ).length
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const containerOf = (editor: HTMLElement): Element =>
      editor.closest('form') ?? editor.parentElement ?? editor
    const containerSize = (editor: HTMLElement): number =>
      (containerOf(editor).innerHTML ?? '').length

    // ---- 1. 等待任一候选编辑器出现（SPA 渲染慢 / 路由未就绪） ----
    let probeEl = findEditor()
    const t0 = Date.now()
    while (!probeEl) {
      if (Date.now() - t0 > editorTimeoutMs) {
        pill(false, items.length)
        return { status: 'no-editor' }
      }
      await sleep(300)
      probeEl = findEditor()
    }
    // 预览基线：旧会话页可能已有历史附件，最终验证只认「新增量」
    const previewBase = countPreviews()

    // ---- 2. 组装 File（保留真实文件名与 MIME，一次解码多轮复用） ----
    const files: File[] = []
    for (const it of items) {
      const blob = await (await fetch(it.dataUrl)).blob()
      files.push(new File([blob], it.name || 'attachment', { type: it.mime || 'application/octet-stream' }))
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
    /** 粘贴一个附件并观察信号是否增长（预览计数 或 容器 DOM 体量） */
    const pasteAndProbe = async (editor: HTMLElement, file: File): Promise<boolean> => {
      const beforePreviews = countPreviews()
      const beforeSize = containerSize(editor)
      await pasteOne(editor, file)
      const deadline = Date.now() + 2800
      while (Date.now() < deadline) {
        await sleep(300)
        if (countPreviews() > beforePreviews) return true
        // 非图片附件：容器出现新节点（chip/图标/上传条）即算命中
        if (containerSize(editor) > beforeSize + 24) return true
      }
      return false
    }

    // ---- 3. 用第一个附件探测真正接受粘贴的编辑器（最多 3 个候选，防重复粘贴） ----
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

    // ---- 4. 命中编辑器：粘剩余附件（保持顺序，间隔等站点渲染附件） ----
    if (editor) {
      for (let i = 1; i < files.length; i++) {
        await pasteOne(editor, files[i])
        await sleep(400)
      }
    }

    // ---- 5. 最终验证：图片按「新增预览数」计数（扣除历史附件基线）；
    //          含非图片时等发送按钮可用 ----
    const imageCount = items.filter((it) => (it.mime || '').startsWith('image/')).length
    const verifyMs = 12000
    const tv = Date.now()
    let verified = false
    for (;;) {
      const previewsOk = countPreviews() - previewBase >= imageCount
      const hasNonImage = items.length > imageCount
      let nonImageOk = !hasNonImage
      if (hasNonImage && editor) {
        // 发送按钮从禁用变为可用 = 站点已接受附件
        const btns = containerOf(editor).querySelectorAll(
          'button[type="submit"], button[aria-label*="发送" i], button[aria-label*="Send" i]'
        )
        for (const b of btns) {
          if (!b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true') {
            nonImageOk = true
            break
          }
        }
      }
      if (previewsOk && nonImageOk) {
        verified = true
        break
      }
      if (Date.now() - tv > verifyMs) break
      await sleep(400)
    }
    if (verified) {
      pill(true, items.length)
      return { status: 'inserted' }
    }
    // 未全部检测到：不做虚假成功提示，如实回报新增进度
    const got = Math.min(items.length, Math.max(0, countPreviews() - previewBase))
    pill(false, items.length)
    return { status: editor ? 'pasted-unverified' : 'no-editor', detail: got + '/' + items.length }
  } catch (e) {
    pill(false, items.length)
    return { status: 'error', detail: e instanceof Error ? e.message : String(e) }
  }
}
