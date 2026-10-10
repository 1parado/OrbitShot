/**
 * 多模型对比结果视图（Cherry Studio 式并排展示）。
 * 输入发生在截图发送流程中（content 弹出的输入框，问题与截图一起提交）；
 * 本面板只负责实时展示各平台回答：问题条 + 自适应卡片网格。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import { t, useLang } from '../shared/i18n'
import type { CompareBatch, CompareAiId, ComparePlatform } from '../shared/compare-types'
import { isActiveStatus, platformsFromAiList } from '../shared/compare-types'
import { loadSettings } from '../shared/settings'
import { cancelBatch, connectPort } from './services/api'
import ModelResponseCard from './components/ModelResponseCard'
import SummaryPanel from './components/SummaryPanel'

const SVG = {
  copy: 'M8 8h12v12H8z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  spark: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1',
}

export default function CompareApp() {
  const [lang] = useLang()
  const [batch, setBatch] = useState<CompareBatch | undefined>()
  const [platforms, setPlatforms] = useState<ComparePlatform[]>([])
  const [showSummary, setShowSummary] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Port 订阅：SW 快照驱动
  useEffect(() => connectPort(setBatch), [])

  // 平台表：名称/图标/URL 元数据（卡片展示用），设置变化时跟随刷新
  useEffect(() => {
    const refresh = () =>
      loadSettings()
        .then((s) => setPlatforms(platformsFromAiList(s.aiList).concat(
          // 已停用但出现在历史批次里的平台也要能显示名称
          s.aiList.filter((a) => !a.enabled).map((a) => ({ id: a.id, name: a.name, url: a.url }))
        )))
        .catch(() => {})
    refresh()
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['orbitshot.settings']) refresh()
    })
  }, [])

  const platformOf = useCallback(
    (id: CompareAiId) => platforms.find((p) => p.id === id),
    [platforms]
  )

  const anyActive = useMemo(
    () => !!batch?.tasks.some((tk) => isActiveStatus(tk.status)),
    [batch]
  )

  const flash = useCallback((msg: string) => {
    setNote(msg)
    setTimeout(() => setNote(null), 2200)
  }, [])

  const copyAll = () => {
    if (!batch) return
    const parts = batch.tasks
      .filter((tk) => tk.response)
      .map((tk) => {
        const name = platformOf(tk.aiId)?.name ?? tk.aiId
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
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SVG.copy} /></svg>
                {t(lang, 'cmp.copyall')}
              </button>
              <button
                onClick={() => setShowSummary(true)}
                disabled={!completed.length}
                title={t(lang, 'cmp.sum.open')}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-sky-600 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SVG.spark} /></svg>
                {t(lang, 'cmp.sum.open')}
              </button>
            </>
          )}
        </div>
      </header>

      {/* 问题条：本次对比的问题（在截图发送时输入） */}
      {batch?.prompt && (
        <div className="glass mx-3 mt-2.5 shrink-0 rounded-xl px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t(lang, 'cmp.copyall.q')}</div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-slate-700">{batch.prompt}</div>
        </div>
      )}

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-xl bg-slate-800/90 px-3 py-2 text-[11.5px] text-white">
          {note}
        </div>
      )}

      {/* 响应网格：宽度自适应；每卡片独立滚动 */}
      <main className="sp-scroll mt-2.5 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!batch || !batch.tasks.length ? (
          <EmptyState lang={lang} />
        ) : (
          <div
            className="grid h-full gap-2.5"
            style={{
              gridTemplateRows: 'minmax(240px, 1fr)',
              gridAutoFlow: 'column',
              gridAutoColumns: 'minmax(250px, 1fr)',
            }}
          >
            {batch.tasks.map((tk) => {
              const p = platformOf(tk.aiId)
              return (
                <ModelResponseCard key={tk.requestId} task={tk} name={p?.name ?? tk.aiId} url={p?.url} lang={lang} onCopied={() => flash(t(lang, 'toast.copied'))} />
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
            name: platformOf(tk.aiId)?.name ?? tk.aiId,
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
      <p className="max-w-[240px] text-[12px] leading-5 text-slate-400">
        {props.lang === 'en'
          ? 'Capture → Ctrl+click 2+ AIs → type your question → answers stream here side by side.'
          : props.lang === 'zh-TW'
            ? '截圖 → Ctrl+點選 2 個以上 AI → 輸入問題 → 各平台回答即時並排顯示。'
            : '截图 → Ctrl+点选 2 个以上 AI → 输入问题 → 各平台回答实时并排显示。'}
      </p>
    </div>
  )
}
