/**
 * 单平台回答卡片：Logo / 名称 / 状态 / 耗时 / 流式 Markdown / 操作栏。
 * Markdown 渲染走白名单净化（services/markdown），内容不作为原始 HTML 插入。
 */
import { useMemo, useState } from 'react'
import { renderMarkdown } from '../services/markdown'
import { iconForSite, faviconCandidates } from '../../shared/settings'
import { t } from '../../shared/dicts'
import type { Lang } from '../../shared/settings'
import type { CompareTask, CompareTaskStatus } from '../../shared/compare-types'
import { retryRequest, cancelRequest } from '../services/api'

function statusMeta(s: CompareTaskStatus, lang: Lang): { label: string; cls: string; dot: string } {
  switch (s) {
    case 'queued':
      return { label: t(lang, 'cmp.st.queued'), cls: 'text-slate-400', dot: 'bg-slate-300' }
    case 'opening_tab':
    case 'waiting_cs':
      return { label: t(lang, 'cmp.st.opening'), cls: 'text-amber-600', dot: 'bg-amber-400' }
    case 'submitting':
      return { label: t(lang, 'cmp.st.submitting'), cls: 'text-amber-600', dot: 'bg-amber-400' }
    case 'generating':
      return { label: t(lang, 'cmp.st.generating'), cls: 'text-sky-600', dot: 'bg-sky-500' }
    case 'completed':
      return { label: t(lang, 'cmp.st.done'), cls: 'text-emerald-600', dot: 'bg-emerald-500' }
    case 'failed':
      return { label: t(lang, 'cmp.st.failed'), cls: 'text-red-600', dot: 'bg-red-500' }
    case 'timeout':
      return { label: t(lang, 'cmp.st.timeout'), cls: 'text-orange-600', dot: 'bg-orange-500' }
    case 'cancelled':
      return { label: t(lang, 'cmp.st.cancelled'), cls: 'text-slate-400', dot: 'bg-slate-300' }
  }
}

function fmtDur(ms?: number): string {
  if (!ms) return ''
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 平台图标：内置 logo → favicon 链 → 首字母（自定义 AI 回退） */
function PlatformIcon(props: { aiId: string; name: string; url?: string }) {
  const [idx, setIdx] = useState(0)
  const builtin = iconForSite(props.aiId)
  const candidates = builtin ? [] : faviconCandidates(props.url ?? '')
  const src = builtin ?? candidates[idx]
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="h-4 w-4 shrink-0 rounded object-contain"
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setIdx((i) => i + 1)}
      />
    )
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-slate-100 text-[9px] font-bold text-slate-500">
      {props.name.charAt(0).toUpperCase()}
    </span>
  )
}

const SVG = {
  copy: 'M8 8h12v12H8z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  retry: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5',
  x: 'M18 6 6 18 M6 6l12 12',
  ext: 'M15 3h6v6 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
}

function IconBtn(props: { title: string; d: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className={`rounded-md p-1.5 transition hover:bg-slate-100 ${
        props.danger ? 'text-slate-400 hover:text-red-600' : 'text-slate-400 hover:text-slate-700'
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {props.d.split(' M').map((seg, i) => (
          <path key={i} d={i === 0 ? seg : 'M' + seg} />
        ))}
      </svg>
    </button>
  )
}

export default function ModelResponseCard(props: {
  task: CompareTask
  name: string
  url?: string
  lang: Lang
  onCopied: () => void
}) {
  const { task, name, lang } = props
  const meta = statusMeta(task.status, lang)
  const active = task.status === 'generating' || task.status === 'submitting'
  const html = useMemo(() => renderMarkdown(task.response || ''), [task.response])

  const copy = () => {
    navigator.clipboard.writeText(task.response || '').then(
      () => props.onCopied(),
      () => {}
    )
  }

  return (
    <div className="glass sp-card flex min-h-0 flex-col overflow-hidden rounded-2xl">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-slate-100/80 px-3 py-2">
        <PlatformIcon aiId={task.aiId} name={name} url={props.url} />
        <span className="truncate text-[13px] font-semibold text-slate-800" title={name}>{name}</span>
        <span className={`flex shrink-0 items-center gap-1.5 text-[11px] ${meta.cls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${active ? 'sp-dot-active' : ''}`} />
          {meta.label}
          {task.durationMs ? <span className="text-slate-300">· {fmtDur(task.durationMs)}</span> : null}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {active ? (
            <IconBtn title={t(lang, 'cmp.cancel')} d={SVG.x} danger onClick={() => cancelRequest(task.requestId)} />
          ) : (
            <>
              {task.response && <IconBtn title={t(lang, 'cmp.copy')} d={SVG.copy} onClick={copy} />}
              <IconBtn title={t(lang, 'cmp.retry')} d={SVG.retry} onClick={() => retryRequest(task.requestId)} />
              {props.url && (
                <IconBtn title={t(lang, 'cmp.open')} d={SVG.ext} onClick={() => chrome.tabs.create({ url: props.url! })} />
              )}
            </>
          )}
        </span>
      </div>

      {/* 内容 */}
      <div className="sp-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {task.error ? (
          <div className="rounded-lg bg-red-50/90 px-2.5 py-2 text-[11.5px] leading-5 text-red-600 ring-1 ring-red-100">
            {t(lang, 'cmp.err.prefix')}
            {errText(task.error, lang)}
          </div>
        ) : task.response ? (
          <div className="sp-md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : active ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-slate-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
            {t(lang, 'cmp.waiting')}
          </div>
        ) : (
          <div className="py-6 text-center text-[12px] text-slate-300">{t(lang, 'cmp.empty')}</div>
        )}
        {active && task.response && <span className="sp-cursor" />}
      </div>
    </div>
  )
}

function errText(code: string, lang: Lang): string {
  const map: Record<string, string> = {
    TAB_CLOSED: t(lang, 'cmp.err.tabclosed'),
    CS_NOT_READY: t(lang, 'cmp.err.csnotready'),
    COMPOSER_NOT_FOUND: t(lang, 'cmp.err.composer'),
    FILL_VERIFY_FAILED: t(lang, 'cmp.err.fill'),
    SUBMIT_NOT_TAKEN: t(lang, 'cmp.err.submit'),
    TIMEOUT: t(lang, 'cmp.err.timeout'),
    SW_RESTARTED: t(lang, 'cmp.err.swrestart'),
    PAGE_UNLOAD: t(lang, 'cmp.err.pageunload'),
    GENERATION_FAILED: t(lang, 'cmp.err.genfail'),
    PLATFORM_REMOVED: t(lang, 'cmp.err.nopick'),
  }
  return map[code] ?? code
}
