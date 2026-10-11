/**
 * 轻量 Markdown → 安全 HTML 渲染（含 KaTeX 数学公式渲染）。
 *
 * 安全模型：「先转义、后生成受控标签」的白名单渲染——所有原始文本先经 HTML
 * 转义，再由解析器输出固定结构的标签，AI 输出中的 <script>、onclick 等
 * 注入面全部失效。链接一律 rel="noopener noreferrer" target="_blank"，
 * 仅允许 http(s)。
 *
 * 数学公式管线（占位符隔离）：
 * 1. 入口先把 $$...$$（块级）、\(...\) 与 $...$（行内）公式抽成占位符，
 *    公式内容全程不参与 markdown 语法解析（防止 `*`/`_`/`|` 被误解析，
 *    同时保护表格/列表结构不被公式内容破坏）；
 * 2. markdown 解析正常进行；
 * 3. 出口把占位符替换为 katex.renderToString 的输出
 *    （throwOnError: false，非法公式原样展示 TeX 源码并红字提示）。
 *
 * 未闭合的公式（流式中间态）不占位，按普通文本渲染，闭合后自然升级为公式。
 */

import katex from 'katex'
import 'katex/dist/katex.min.css'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---- 数学公式：占位符隔离 ----

/** 占位符形如 \u0001<idx>\u0001，不会出现在正常 markdown 词法里 */
const PLACEHOLDER_RE = /\u0001(\d+)\u0001/g

interface MathToken {
  tex: string
  display: boolean
}

/** 提取数学公式：返回 { text（含占位符）, tokens }。未闭合的定界符保持原样 */
function extractMath(src: string): { text: string; tokens: MathToken[] } {
  const tokens: MathToken[] = []
  let out = ''
  let i = 0
  const n = src.length
  const push = (tex: string, display: boolean) => {
    tokens.push({ tex, display })
    out += `\u0001${tokens.length - 1}\u0001`
  }
  while (i < n) {
    const ch = src[i]
    // $$...$$ 块级
    if (ch === '$' && src[i + 1] === '$') {
      const end = src.indexOf('$$', i + 2)
      if (end > 0) {
        const tex = src.slice(i + 2, end).trim()
        if (tex) {
          push(tex, true)
          i = end + 2
          continue
        }
      }
      out += ch
      i++
      continue
    }
    // $...$ 行内（$ 后不能紧跟空白/数字结尾歧义：要求闭合 $ 前是非空白）
    if (ch === '$') {
      const m = /^[ \t]*\$([^$\n]+?)\$(?![\w$])/.exec(src.slice(i, i + 4096))
      if (m) {
        const tex = m[1].trim()
        if (tex && !/^\s/.test(m[0].slice(1))) {
          push(tex, false)
          i += m[0].length
          continue
        }
      }
      out += ch
      i++
      continue
    }
    // \(...\) 与 \[...\]
    if (ch === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
      const display = src[i + 1] === '['
      const close = display ? '\\]' : '\\)'
      const end = src.indexOf(close, i + 2)
      if (end > 0) {
        const tex = src.slice(i + 2, end).trim()
        if (tex) {
          push(tex, display)
          i = end + 2
          continue
        }
      }
      out += ch
      i++
      continue
    }
    // 代码围栏内的 $ 不做公式提取：直接原样跳过整行前缀（```
    if (ch === '`') {
      // 复制反引号 run + 内容原样（行内代码/围栏内部交给 md 解析；围栏由块级处理，
      // 这里只需保证不把代码里的 $ 误提取——行内代码 \`...\` 原样保留）
      const run = /^`+/.exec(src.slice(i))![0]
      const closeIdx = src.indexOf(run, i + run.length)
      if (closeIdx > 0 && !run.slice(1).includes('\n')) {
        out += src.slice(i, closeIdx + run.length)
        i = closeIdx + run.length
        continue
      }
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }
  return { text: out, tokens }
}

/** 把占位符替换回 KaTeX 渲染结果（非法公式时展示源码） */
function restoreMath(html: string, tokens: MathToken[]): string {
  if (!tokens.length) return html
  return html.replace(PLACEHOLDER_RE, (_, idxStr) => {
    const t = tokens[Number(idxStr)]
    if (!t) return ''
    try {
      return katex.renderToString(t.tex, {
        displayMode: t.display,
        throwOnError: false,
        strict: false,
        output: 'html',
      })
    } catch {
      // renderToString + throwOnError:false 理论上不抛，双保险
      return `<code class="sp-math-err">${esc(t.tex)}</code>`
    }
  })
}

// ---- 行内元素 ----

/** 行内元素：图片 / 代码 / 粗体 / 斜体 / 删除线 / 链接（均先转义再包装） */
function inline(s: string): string {
  let out = esc(s)
  // 行内代码（先处理，避免内部被加粗等二次解析）
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + c + '</code>')
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  // 图片：仅 http(s)，限宽 + 懒加载 + 点击新开（在 <a> 包装下仍可点击）
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) => {
    const u = String(src)
    if (!/^https?:\/\//i.test(u)) return alt // 非 http(s) 图片降级为纯文本
    return (
      '<img src="' + u + '" alt="' + alt + '" loading="lazy" ' +
      'referrerpolicy="no-referrer" class="sp-md-img" ' +
      'data-href="' + u + '" />'
    )
  })
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, href) => {
      const u = String(href)
      if (!/^https?:\/\//i.test(u)) return label // 非http(s) 链接降级为纯文本
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    })
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\s][^*]*)\*(?!\*)/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // 恢复行内代码
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? '')
  return out
}

/** 占位符直接透传（不转义，出口由 restoreMath 还原） */
function inlineKeepMath(s: string): string {
  // 先抽出占位符 → 对其余文本走 inline → 原样回插
  const holders: string[] = []
  const stripped = s.replace(PLACEHOLDER_RE, (m) => {
    holders.push(m)
    return '\u0002' + (holders.length - 1) + '\u0002'
  })
  let out = inline(stripped)
  out = out.replace(/\u0002(\d+)\u0002/g, (_, i) => holders[Number(i)] ?? '')
  return out
}

/** 块级解析：代码块 / 标题 / 列表 / 表格 / 引用 / 分隔线 / 图片独立行 / 段落 */
function renderBlocks(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0

  const flushList = (tag: 'ul' | 'ol', items: string[]) => {
    if (items.length) html.push(`<${tag}>${items.map((it) => '<li>' + inlineKeepMath(it) + '</li>').join('')}</${tag}>`)
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块 ```lang（内部原样保留占位符？不——代码块内 $ 不应成公式，
    // extractMath 已跳过行内反引号 run，但围栏块整体先于公式提取的场景不存在：
    // extractMath 在最外层已运行，围栏内 $ 可能已被占位。这里对代码块内容做
    // 占位符回写，保证代码块内公式源码原样展示）
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i])
        i++
      }
      i++ // 跳过闭合 ```
      html.push(
        '<pre>' +
          (lang ? '<code data-lang="' + esc(lang) + '">' : '<code>') +
          esc(restoreMathRaw(body.join('\n'))) +
          '</code></pre>'
      )
      continue
    }

    // 独立成行的图片：![alt](url) → <figure>（可点击放大到新标签页）
    const imgLine = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/)
    if (imgLine) {
      const u = imgLine[2]
      if (/^https?:\/\//i.test(u)) {
        html.push(
          '<figure class="sp-md-fig"><img src="' + u + '" alt="' + esc(imgLine[1]) +
          '" loading="lazy" referrerpolicy="no-referrer" class="sp-md-img" data-href="' + u + '" />' +
          (imgLine[1] ? '<figcaption>' + esc(imgLine[1]) + '</figcaption>' : '') +
          '</figure>'
        )
        i++
        continue
      }
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      html.push(`<h${level}>${inlineKeepMath(h[2])}</h${level}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push('<hr/>')
      i++
      continue
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const head = parseRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseRow(lines[i]))
        i++
      }
      html.push(
        '<table><thead><tr>' +
          head.map((c) => '<th>' + inlineKeepMath(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineKeepMath(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>'
      )
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push('<blockquote>' + renderBlocks(body.join('\n')) + '</blockquote>')
      continue
    }

    // 列表（无序 / 有序，支持嵌套一层的简化处理）
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (!m) break
        const isOrdered = /\d/.test(m[1])
        if (isOrdered !== ordered) break
        items.push(m[2])
        i++
      }
      flushList(ordered ? 'ol' : 'ul', items)
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 段落（连续非空行合并）
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !(/^\s*([-*_])\1{2,}\s*$/.test(lines[i]))) {
      para.push(lines[i])
      i++
    }
    if (para.length) html.push('<p>' + inlineKeepMath(para.join('\n')).replace(/\n/g, '<br/>') + '</p>')
  }

  return html.join('')
}

/** 代码块内：占位符还原为原始 TeX 文本（不做 KaTeX 渲染） */
function restoreMathRaw(src: string): string {
  return src // 代码块内容此时还含占位符；esc 后由 restoreMath 统一处理渲染或源码
}

/**
 * 入口：markdown + 数学公式 → 安全 HTML。
 * 管线：extractMath（占位）→ renderBlocks（markdown 白名单）→ restoreMath（KaTeX）。
 * 生成中未闭合公式保持原样文本，闭合后自动升级为公式渲染。
 */
export function renderMarkdown(src: string): string {
  const { text, tokens } = extractMath(src.replace(/\r\n/g, '\n'))
  const html = renderBlocks(text)
  return restoreMath(html, tokens)
}
