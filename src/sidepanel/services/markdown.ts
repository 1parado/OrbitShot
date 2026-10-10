/**
 * 轻量 Markdown → 安全 HTML 渲染。
 *
 * 不引入第三方 markdown 依赖（保持零新增依赖），采用「先转义、后生成受控
 * 标签」的白名单渲染：所有原始文本先经 HTML 转义，再由解析器输出固定结构的
 * 标签，AI 输出中的 <script>、onclick 等注入面全部失效。
 * 链接一律 rel="noopener noreferrer" target="_blank"，仅允许 http(s)。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内元素：代码 / 粗体 / 斜体 / 删除线 / 链接（均先转义再包装） */
function inline(s: string): string {
  let out = esc(s)
  // 行内代码（先处理，避免内部被加粗等二次解析）
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + c + '</code>')
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt) => '<span title="image">' + alt + '</span>')
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

/** 块级解析：代码块 / 标题 / 列表 / 表格 / 引用 / 分隔线 / 段落 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0

  const flushList = (tag: 'ul' | 'ol', items: string[]) => {
    if (items.length) html.push(`<${tag}>${items.map((it) => '<li>' + it + '</li>').join('')}</${tag}>`)
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块 ```lang
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
          esc(body.join('\n')) +
          '</code></pre>'
      )
      continue
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      html.push(`<h${level}>${inline(h[2])}</h${level}>`)
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
          head.map((c) => '<th>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
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
      html.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>')
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
        items.push(inline(m[2]))
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
    if (para.length) html.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br/>') + '</p>')
  }

  return html.join('')
}
