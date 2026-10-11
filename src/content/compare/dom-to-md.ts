/**
 * DOM → Markdown 序列化器（Compare 回答抓取核心）。
 *
 * 设计对齐 grok2api ChatStreamSnapshot 的三字段模型：
 *   { content, thinking, images }
 * AI 站点把 markdown 渲染成 DOM 后，原始结构信息（表格/代码/列表/公式）
 * 仍完整保留在 DOM 里；innerText 抓取会把这些全部压扁。本模块对回答容器
 * 做块级遍历，按白名单规则逆序列化回 Markdown。
 *
 * 数学公式：渲染后的公式节点内嵌原始 TeX——
 *   - KaTeX：<annotation encoding="application/x-tex">…</annotation>
 *   - MathJax v3：<mjx-container>（assistive MathML / data-latex 属性）
 * 提取后按上下文包成 $...$ / $$...$$，与渲染层 markdown.ts 的公式管线闭环。
 *
 * 安全：输出是「转义后的 markdown 文本」，渲染侧（markdown.ts）再做一次
 * 全量转义 + 白名单生成，序列化本身不产生可执行 HTML。
 */

export interface SerializedAnswer {
  /** 正式回答（markdown 源码） */
  content: string
  /** 思考/推理过程（markdown 源码；与正文分离） */
  thinking: string
  /** 回答中出现的图片 URL（http/https） */
  images: string[]
}

// ---- 行内序列化 ----

/** 行内元素 → markdown。块级结构由调用方处理 */
function inlineToMd(node: Node, images: string[]): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()

  // 公式节点（先于一般行内处理）
  const tex = extractTeX(el)
  if (tex !== null) return tex

  switch (tag) {
    case 'br':
      return '\n'
    case 'strong':
    case 'b': {
      const inner = childrenInline(el, images).trim()
      return inner ? `**${inner}**` : ''
    }
    case 'em':
    case 'i': {
      const inner = childrenInline(el, images).trim()
      return inner ? `*${inner}*` : ''
    }
    case 'del':
    case 's':
    case 'strike': {
      const inner = childrenInline(el, images).trim()
      return inner ? `~~${inner}~~` : ''
    }
    case 'code': {
      // 行内代码（块级 pre 在块层处理）；内部原样，反引号包裹
      const text = el.textContent ?? ''
      if (!text) return ''
      // 内容含反引号时用双反引号包裹
      return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
    }
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      const label = childrenInline(el, images).trim() || href
      if (/^https?:\/\//i.test(href)) return `[${label}](${href})`
      return label // 非 http(s) 链接降级为文本
    }
    case 'img': {
      const src = el.getAttribute('src') ?? ''
      const alt = el.getAttribute('alt') ?? ''
      if (!/^https?:\/\//i.test(src)) return alt || ''
      if (!images.includes(src)) images.push(src)
      return `![${alt}](${src})`
    }
    default: {
      // 未识别行内标签（span/mark/u/kbd/sup/sub…）：解包子节点
      // 已知被站点用于折叠交互的按钮不输出
      if (tag === 'button' || tag === 'input' || tag === 'select') return ''
      return childrenInline(el, images)
    }
  }
}

function childrenInline(el: Element, images: string[]): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) out += inlineToMd(child, images)
  return out
}

/**
 * 提取公式节点的原始 TeX。返回 `$…$` / `$$…$$` 形式；非公式节点返回 null。
 * 防重复：嵌套结构（外层容器与内层 annotation 都命中）只在外层提取一次。
 */
const TEX_SEEN = new WeakSet<Element>()

export function extractTeX(el: Element): string | null {
  // KaTeX：.katex 容器（display 模式为 .katex-display 的子节点）
  if (el.classList.contains('katex')) {
    if (TEX_SEEN.has(el)) return null
    TEX_SEEN.add(el)
    // 跳过位于 display 容器内的内层 katex（display 外层已处理）
    if (el.parentElement?.classList.contains('katex-display')) return null
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
    const tex = annotation?.textContent ?? ''
    if (!tex.trim()) return null
    const display = !!el.closest('.katex-display')
    return display ? `\n\n$$${tex.trim()}$$\n\n` : `$${tex.trim()}$`
  }
  // KaTeX display 外层容器：直接取内部 katex 的 annotation
  if (el.classList.contains('katex-display')) {
    if (TEX_SEEN.has(el)) return null
    TEX_SEEN.add(el)
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
    const tex = annotation?.textContent ?? ''
    return tex.trim() ? `\n\n$$${tex.trim()}$$\n\n` : null
  }
  // MathJax v3
  if (el.tagName.toLowerCase() === 'mjx-container') {
    if (TEX_SEEN.has(el)) return null
    TEX_SEEN.add(el)
    const latex = el.getAttribute('data-latex') ?? ''
    if (latex.trim()) {
      const display = el.getAttribute('display') === 'block'
      return display ? `\n\n$$${latex.trim()}$$\n\n` : `$${latex.trim()}$`
    }
    // 兜底：assistive MathML 里的 <annotation encoding="application/x-tex">
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
    const tex = annotation?.textContent ?? ''
    return tex.trim() ? `\n\n$$${tex.trim()}$$\n\n` : null
  }
  return null
}

// ---- 块级序列化 ----

/** 判断元素是否为「公式容器」（整块都是公式，走公式分支） */
function isMathBlock(el: Element): boolean {
  return (
    el.classList.contains('katex-display') ||
    el.classList.contains('katex') ||
    el.tagName.toLowerCase() === 'mjx-container'
  )
}

/** 块级序列化主循环：返回 markdown 块序列（以 \n\n 连接） */
function blockToMd(el: Element, images: string[], depth = 0): string {
  const tag = el.tagName.toLowerCase()

  // 整块公式
  if (isMathBlock(el)) {
    const tex = extractTeX(el)
    return tex ?? ''
  }

  switch (tag) {
    case 'p':
      return inlineToMd(el, images).trim()

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1])
      return `${'#'.repeat(level)} ${inlineToMd(el, images).trim()}`
    }

    case 'hr':
      return '---'

    case 'pre': {
      // 代码块：语言从 code 的 class（language-*）或 data-lang 提取
      const code = el.querySelector('code')
      const cls = code?.getAttribute('class') ?? ''
      const langMatch = /(?:language|lang)-([\w+-]+)/.exec(cls)
      const lang = langMatch?.[1] ?? code?.getAttribute('data-lang') ?? ''
      const text = (code ?? el).textContent ?? ''
      if (!text.trim()) return ''
      // 围栏长于内容中的反引号串
      let fence = '```'
      while (text.includes(fence)) fence += '`'
      return `${fence}${lang}\n${text.replace(/\n$/, '')}\n${fence}`
    }

    case 'blockquote': {
      const inner = childrenBlockMd(el, images, depth + 1)
      if (!inner.trim()) return ''
      return inner
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    }

    case 'ul':
    case 'ol':
      return listToMd(el as HTMLUListElement | HTMLOListElement, images, depth, tag === 'ol')

    case 'table':
      return tableToMd(el, images)

    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'body':
    default: {
      // 通用容器：递归处理块级子节点；内联内容收集为段落
      return childrenBlockMd(el, images, depth)
    }
  }
}

/** 遍历子节点：块级子元素各自成块，内联内容聚合为段落 */
function childrenBlockMd(el: Element, images: string[], depth: number): string {
  const blocks: string[] = []
  let inlineBuf = ''
  const flushInline = () => {
    const text = inlineBuf
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim()
    if (text) blocks.push(text)
    inlineBuf = ''
  }
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      inlineBuf += child.textContent ?? ''
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const childEl = child as HTMLElement
    // 跳过纯交互/装饰节点
    const t = childEl.tagName.toLowerCase()
    if (t === 'button' || t === 'input' || t === 'select' || t === 'textarea' || t === 'style' || t === 'script' || t === 'noscript') continue
    // 探测该子树是否含块级结构：有 → 块处理；无 → 内联聚合
    if (isBlockish(childEl)) {
      flushInline()
      const md = blockToMd(childEl, images, depth)
      if (md.trim()) blocks.push(md.trim())
    } else {
      inlineBuf += inlineToMd(childEl, images)
    }
  }
  flushInline()
  return blocks.join('\n\n')
}

/** 是否为块级语义元素（决定递归策略） */
function isBlockish(el: HTMLElement): boolean {
  if (isMathBlock(el)) return true
  const display = getComputedStyle(el).display
  if (display === 'none') return false
  const tag = el.tagName.toLowerCase()
  if (['p','div','section','article','pre','blockquote','ul','ol','table','h1','h2','h3','h4','h5','h6','hr','figure','figcaption','li','td','th'].includes(tag)) return true
  // 布局性 div：display 为 block/flex/grid 且含块级子元素
  return display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item'
}

/** 列表：支持两层嵌套 */
function listToMd(list: HTMLUListElement | HTMLOListElement, images: string[], depth: number, ordered: boolean): string {
  const indent = '  '.repeat(Math.min(depth, 2))
  const items: string[] = []
  let idx = 1
  for (const li of Array.from(list.children).filter((c) => c.tagName.toLowerCase() === 'li')) {
    const marker = ordered ? `${idx}.` : '-'
    idx++
    // li 内部：先取直接内联内容为条目首行，再处理嵌套列表/块
    const nestedLists: string[] = []
    let head = ''
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        head += child.textContent ?? ''
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const ce = child as HTMLElement
      const t = ce.tagName.toLowerCase()
      if (t === 'ul' || t === 'ol') {
        nestedLists.push(listToMd(ce as HTMLUListElement, images, depth + 1, t === 'ol'))
      } else if (t === 'p' || isBlockish(ce)) {
        head += ' ' + blockToMd(ce, images, depth)
      } else {
        head += inlineToMd(ce, images)
      }
    }
    const headText = head.replace(/\s+/g, ' ').trim()
    if (!headText && !nestedLists.length) continue
    items.push(
      `${indent}${marker} ${headText}${nestedLists.length ? '\n' + nestedLists.join('\n') : ''}`
    )
  }
  return items.join('\n')
}

/** GFM 表格：单元格内 | 转义，换行转 <br>（渲染层还原） */
function tableToMd(table: Element, images: string[]): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (!rows.length) return ''
  const cellText = (cell: Element): string =>
    inlineToMd(cell, images)
      .replace(/\|/g, '\\|')
      .replace(/\n+/g, '<br>')
      .trim()

  const header = rows[0]
  const headerCells = Array.from(header.querySelectorAll('th, td'))
  if (!headerCells.length) return ''
  const cols = headerCells.length
  const lines: string[] = []
  lines.push(`| ${headerCells.map(cellText).join(' | ')} |`)
  // 对齐行（默认左对齐；读取 style/text-align 尽力还原）
  const aligns = headerCells.map((c) => {
    const a = (c as HTMLElement).style?.textAlign
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return '---'
  })
  lines.push(`| ${aligns.join(' | ')} |`)
  for (const row of rows.slice(1)) {
    const cells = Array.from(row.querySelectorAll('th, td'))
    // 列数对齐（缺失补空，多余截断）
    const padded = Array.from({ length: cols }, (_, i) => (cells[i] ? cellText(cells[i]) : ''))
    lines.push(`| ${padded.join(' | ')} |`)
  }
  return lines.join('\n')
}

/**
 * 入口：序列化回答容器。
 * @param root 回答容器元素（最新一条 assistant 回答）
 * @param thinkingSel 平台思考块选择器（命中的子树剥离到 thinking 字段）
 */
export function serializeAnswer(root: HTMLElement, thinkingSel: string[] = []): SerializedAnswer {
  const images: string[] = []
  let thinking = ''

  // 深拷贝：剥离 thinking 子树后序列化正文，不影响页面
  const clone = root.cloneNode(true) as HTMLElement

  // 1) 思考块剥离（在拷贝上操作）
  if (thinkingSel.length) {
    const parts: string[] = []
    const thinkImages: string[] = []
    for (const sel of thinkingSel) {
      for (const node of Array.from(clone.querySelectorAll(sel))) {
        parts.push(childrenBlockMd(node, thinkImages, 0).trim())
        node.remove()
      }
    }
    thinking = parts.filter(Boolean).join('\n\n')
  }

  // 2) 正文序列化（剔除交互残留）
  for (const sel of ['button', 'style', 'script', 'noscript']) {
    clone.querySelectorAll(sel).forEach((n) => n.remove())
  }
  const content = childrenBlockMd(clone, images, 0).trim()

  return {
    content,
    thinking,
    images: [...new Set(images)],
  }
}
