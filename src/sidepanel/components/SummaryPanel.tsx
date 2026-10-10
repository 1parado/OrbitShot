/**
 * 汇总（Summary）弹层：展示总结结果 + OpenAI 兼容接口配置表单。
 * 未配置时显示配置入口并明确提示，不做任何隐式调用。
 */
import { useEffect, useState } from 'react'
import { t } from '../../shared/dicts'
import type { Lang } from '../../shared/settings'
import { renderMarkdown } from '../services/markdown'
import { loadSummaryConfig, saveSummaryConfig, requestSummary, SummaryError } from '../services/summary'
import type { SummaryConfig } from '../services/summary'

export default function SummaryPanel(props: {
  lang: Lang
  question: string
  answers: { name: string; text: string }[]
  onClose: () => void
}) {
  const { lang } = props
  const [cfg, setCfg] = useState<SummaryConfig | null>(null)
  const [cfgLoading, setCfgLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 表单草稿
  const [fBaseUrl, setFBaseUrl] = useState('https://api.openai.com/v1')
  const [fKey, setFKey] = useState('')
  const [fModel, setFModel] = useState('gpt-4o-mini')

  useEffect(() => {
    loadSummaryConfig()
      .then((c) => {
        setCfg(c)
        if (!c) setShowForm(true)
        else {
          setFBaseUrl(c.baseUrl)
          setFModel(c.model)
        }
      })
      .finally(() => setCfgLoading(false))
  }, [])

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult('')
    try {
      const text = await requestSummary(lang, props.question, props.answers)
      setResult(text)
    } catch (e) {
      if (e instanceof SummaryError && e.needsConfig) {
        setShowForm(true)
        setError(t(lang, 'cmp.sum.needcfg'))
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRunning(false)
    }
  }

  const saveCfg = async () => {
    const next: SummaryConfig = { baseUrl: fBaseUrl.trim(), apiKey: fKey.trim(), model: fModel.trim() }
    if (!next.baseUrl || !next.apiKey || !next.model) {
      setError(t(lang, 'cmp.sum.incomplete'))
      return
    }
    await saveSummaryConfig(next)
    setCfg(next)
    setShowForm(false)
    setError(null)
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-slate-900/25 backdrop-blur-sm">
      <div className="glass m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-slate-100/80 px-3 py-2.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sky-500">
            <path d="M9.9 15.5 8.5 14.1 2.4 12.5a.5.5 0 0 1 0-1L8.5 9.9 9.9 3.9a.5.5 0 0 1 1 0L12.5 9.9l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.5-1.4 1.5z" />
          </svg>
          <span className="text-[13px] font-bold text-slate-800">{t(lang, 'cmp.sum.title')}</span>
          <button onClick={props.onClose} className="ml-auto rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18 M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="sp-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {cfgLoading ? null : showForm ? (
            <div className="space-y-2.5">
              <p className="text-[11.5px] leading-5 text-slate-500">{t(lang, 'cmp.sum.cfgdesc')}</p>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-600">{t(lang, 'cmp.sum.baseurl')}</span>
                <input value={fBaseUrl} onChange={(e) => setFBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1"
                  className="w-full rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-[12px] outline-none focus:border-sky-400" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-600">{t(lang, 'cmp.sum.apikey')}</span>
                <input value={fKey} onChange={(e) => setFKey(e.target.value)} type="password" placeholder="sk-..."
                  className="w-full rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-[12px] outline-none focus:border-sky-400" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-600">{t(lang, 'cmp.sum.model')}</span>
                <input value={fModel} onChange={(e) => setFModel(e.target.value)} placeholder="gpt-4o-mini"
                  className="w-full rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-[12px] outline-none focus:border-sky-400" />
              </label>
              <p className="text-[10.5px] leading-4 text-slate-400">{t(lang, 'cmp.sum.privacy')}</p>
              <div className="flex gap-2 pt-1">
                <button onClick={saveCfg} className="rounded-lg bg-sky-500 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-sky-600">
                  {t(lang, 'cmp.sum.save')}
                </button>
                {cfg && (
                  <button onClick={() => setShowForm(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-slate-500 transition hover:bg-slate-100">
                    {t(lang, 'cmp.sum.cancelcfg')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {running && (
                <div className="flex items-center gap-2 py-6 text-[12px] text-slate-400">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
                  {t(lang, 'cmp.sum.running')}
                </div>
              )}
              {error && (
                <div className="mb-2 rounded-lg bg-red-50/90 px-2.5 py-2 text-[11.5px] leading-5 text-red-600 ring-1 ring-red-100">
                  {error}
                  {error === t(lang, 'cmp.sum.needcfg') && (
                    <button onClick={() => setShowForm(true)} className="ml-1.5 font-semibold text-sky-600 underline">
                      {t(lang, 'cmp.sum.gocfg')}
                    </button>
                  )}
                </div>
              )}
              {result && <div className="sp-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />}
              {!running && !result && !error && (
                <button
                  onClick={run}
                  disabled={!props.answers.length}
                  className="w-full rounded-xl bg-sky-500 px-3 py-2 text-[12.5px] font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t(lang, 'cmp.sum.start', { n: props.answers.length })}
                </button>
              )}
              {!running && result && (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => navigator.clipboard.writeText(result)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 transition hover:bg-slate-100"
                  >
                    {t(lang, 'cmp.copy')}
                  </button>
                  <button onClick={run} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 transition hover:bg-slate-100">
                    {t(lang, 'cmp.sum.again')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
