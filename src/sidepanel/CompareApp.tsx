/**
 * 多模型对比工作台主界面。
 * 布局：顶栏（标题/状态/操作）→ 输入区（可折叠）→ 响应网格（宽度自适应列数，
 * 每卡片独立滚动）。SW 推送快照驱动渲染，本地零业务状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import { t, useLang } from '../shared/i18n'
import type { CompareBatch, CompareAiId } from '../shared/compare-types'
import { COMPARE_PLATFORMS, COMPARE_PENDING_KEY, isActiveStatus } from '../shared/compare-types'
import type { ComparePendingContext } from '../shared/compare-types'
import { dispatchBatch, cancelBatch, connectPort } from './services/api'
import ModelResponseCard from './components/ModelResponseCard'
import SummaryPanel from './components/SummaryPanel'

const SVG = {
  send: 'm22 2-7 20-4-9-9-4z M22 2 11 13',
  stop: 'M6 6h12v12H6z',
  copy: 'M8 8h12v12H8z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  spark: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1',
  chev: 'M6 9l6 6 6-6',
}

export default function CompareApp() {
  const [lang] = useLang()
  const [batch, setBatch] = useState<CompareBatch | undefined>()
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<Set<CompareAiId>>(new Set(['chatgpt', 'claude', 'gemini']))
  const [composerOpen, setComposerOpen] = useState(true)
  const [showSummary, setShowSummary] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const busyRef = useRef(false)

  // Port 订阅：SW 快照驱动
  useEffect(() => connectPort(setBatch), [])

  // 批量发送截图后打开面板：读取 pending 上下文 → 预选本次发送的平台 + 提示输入问题
  useEffect(() => {
    chrome.storage.local
      .get(COMPARE_PENDING_KEY)
      .then(async (res) => {
        const ctx = res?.[COMPARE_PENDING_KEY] as ComparePendingContext | undefined
        if (!ctx?.aiIds?.length) return
        await chrome.storage.local.remove(COMPARE_PENDING_KEY) // 读后即删
        setPicked(new Set(ctx.aiIds))
        setComposerOpen(true)
        flash(t('zh-CN', 'cmp.pending.hint'))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const anyActive = useMemo(
    () => !!batch?.tasks.some((tk) => isActiveStatus(tk.status)),
    [batch]
  )

  const flash = useCallback((msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(null), 2200)
  }, [])

  const toggle = (id: CompareAiId) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const send = async () => {
    if (busyRef.current || anyActive) return
    if (!prompt.trim()) return
    if (!picked.size) {
      flash(t(lang, 'cmp.err.nopick'))
      return
    }
    busyRef.current = true
    try {
      const res = await dispatchBatch({ prompt, aiIds: [...picked] })
      if (res.ok) {
        setComposerOpen(false)
      } else {
        flash(res.error === 'NO_PLATFORM' ? t(lang, 'cmp.err.nopick') : t(lang, 'cmp.err.dispatch'))
      }
    } catch {
      flash(t(lang, 'cmp.err.dispatch'))
    } finally {
      busyRef.current = false
    }
  }

  const copyAll = () => {
    if (!batch) return
    const parts = batch.tasks
      .filter((tk) => tk.response)
      .map((tk) => {
        const name = COMPARE_PLATFORMS.find((p) => p.id === tk.aiId)?.name ?? tk.aiId
        return `## ${name}\n\n${tk.response}`
      })
    if (!parts.length) return
    const text = `${t(lang, 'cmp.copyall.header')}\n\n${t(lang, 'cmp.copyall.q')} ${batch.prompt}\n\n${parts.join('\n\n---\n\n')}`
    navigator.clipboard.writeText(text).then(() => flash(t(lang, 'toast.copied')))
  }

  const completed = batch?.tasks.filter((tk) => tk.status === 'completed' && tk.response) ?? []

  return (
    <div className="relative flex h-full flex-col">
      {/* 顶栏 */}
      <header className="glass z-10 flex shrink-0 items-center gap-2 border-b border-slate-100/70 px-3 py-2">
        <img src={logoUrl} alt="" className="h-7 w-7 rounded-lg shadow-sm ring-1 ring-slate-200/60" draggable={false} />
        <div className="min-w-0">
          <div className="text-[13px] font-bold leading-4 text-slate-900">{t(lang, 'cmp.title')}</div>
          <div className="text-[10px] leading-3 text-slate-400">
            {batch
              ? anyActive
                ? t(lang, 'cmp.sub.running')
                : t(lang, 'cmp.sub.idle')
              : t(lang, 'cmp.sub.empty')}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {anyActive && (
            <button
              onClick={() => cancelBatch()}
              title={t(lang, 'cmp.cancelall')}
              className="rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-red-500 transition hover:bg-red-50"
            >
              {t(lang, 'cmp.cancelall')}
            </button>
          )}
          {!!batch?.tasks.length && (
            <>
              <button
                onClick={copyAll}
                title={t(lang, 'cmp.copyall')}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 8h12v12H8z" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                {t(lang, 'cmp.copyall')}
              </button>
              <button
                onClick={() => setShowSummary(true)}
                disabled={!completed.length}
                title={t(lang, 'cmp.sum.open')}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-sky-600 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.9 15.5 8.5 14.1 2.4 12.5a.5.5 0 0 1 0-1L8.5 9.9 9.9 3.9a.5.5 0 0 1 1 0L12.5 9.9l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.5-1.4 1.5z" /></svg>
                {t(lang, 'cmp.sum.open')}
              </button>
            </>
          )}
        </div>
      </header>

      {/* 输入区（新批次可展开；进行中自动收起） */}
      <div className="glass mx-3 mt-2.5 shrink-0 overflow-hidden rounded-2xl">
        <button
          onClick={() => setComposerOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <span className="text-[12px] font-semibold text-slate-700">{t(lang, 'cmp.compose')}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {[...picked].map((id) => {
              const p = COMPARE_PLATFORMS.find((x) => x.id === id)!
              return (
                <span key={id} className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-600 ring-1 ring-sky-100">
                  {p.name}
                </span>
              )
            })}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-slate-300 transition-transform ${composerOpen ? 'rotate-180' : ''}`}>
              <path d={SVG.chev} />
            </svg>
          </span>
        </button>
        {composerOpen && (
          <div className="px-3 pb-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={3}
              placeholder={t(lang, 'cmp.ph')}
              className="sp-scroll w-full resize-none rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-[13px] leading-6 text-slate-800 outline-none transition placeholder:text-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />
            <div className="mt-2 flex items-center gap-1.5">
              {COMPARE_PLATFORMS.map((p) => {
                const on = picked.has(p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ring-1 ${
                      on
                        ? 'bg-sky-500 text-white ring-sky-500 shadow-sm shadow-sky-200'
                        : 'bg-white/80 text-slate-500 ring-slate-200 hover:ring-slate-300'
                    }`}
                  >
                    {p.name}
                  </button>
                )
              })}
              <button
                onClick={send}
                disabled={anyActive || !prompt.trim()}
                className="ml-auto flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-sm shadow-sky-200 transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SVG.send} /></svg>
                {t(lang, 'cmp.go')}
              </button>
            </div>
          </div>
        )}
      </div>

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-xl bg-slate-800/90 px-3 py-2 text-[11.5px] text-white">
          {note}
        </div>
      )}

      {/* 响应网格：宽度自适应；每卡片独立滚动 */}
      <main className="sp-scroll mt-2.5 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!batch ? (
          <EmptyState lang={lang} />
        ) : (
          <div
            className="grid gap-2.5"
            style={{
              gridTemplateColumns: batch.tasks.length === 1 ? '1fr' : undefined,
              gridTemplateRows: 'minmax(220px, 1fr)',
              height: '100%',
              display: batch.tasks.length === 1 ? 'grid' : 'grid',
              gridAutoFlow: 'column',
              gridAutoColumns: 'minmax(240px, 1fr)',
            }}
          >
            {batch.tasks.map((tk) => {
              const p = COMPARE_PLATFORMS.find((x) => x.id === tk.aiId)!
              return (
                <ModelResponseCard key={tk.requestId} task={tk} name={p.name} lang={lang} onCopied={() => flash(t(lang, 'toast.copied'))} />
              )
            })}
          </div>
        )}
      </main>

      {showSummary && batch && (
        <SummaryPanel
          lang={lang}
          question={batch.prompt}
          answers={completed.map((tk) => ({
            name: COMPARE_PLATFORMS.find((x) => x.id === tk.aiId)?.name ?? tk.aiId,
            text: tk.response,
          }))}
          onClose={() => setShowSummary(false)}
        />
      )}
    </div>
  )
}

function EmptyState(props: { lang: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 pb-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/80 shadow-sm ring-1 ring-slate-200/70">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SVG.spark} /></svg>
      </div>
      <p className="max-w-[220px] text-[12px] leading-5 text-slate-400">
        {props.lang === 'en'
          ? 'Type a question, pick AI sites, and compare their answers side by side.'
          : props.lang === 'zh-TW'
            ? '輸入問題、選擇 AI 平台，即可並排比較多個模型的回答。'
            : '输入问题、选择 AI 平台，即可并排比较多个模型的回答。'}
      </p>
    </div>
  )
}
