import { useEffect, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import { t, useLang, LANG_ITEMS } from '../shared/i18n'
import type { Lang } from '../shared/settings'
import { countShots } from '../background/shots'

type RunType = 'RUN_FLOW' | 'RUN_FULLPAGE'

/* ---------- 内联 SVG 图标（lucide 风格） ---------- */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const CameraIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" {...stroke}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
)

const ImageIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" {...stroke}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
)

const LayersIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" {...stroke}>
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
    <path d="M2 12.5l9.17 4.16a2 2 0 0 0 1.66 0L22 12.5" />
    <path d="M2 17.5l9.17 4.16a2 2 0 0 0 1.66 0L22 17.5" />
  </svg>
)

const GearIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const ChevronRight = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    {...stroke}
    strokeWidth={2.2}
    className="shrink-0 text-slate-300 transition-colors group-hover:text-sky-400"
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
)

const KebabIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)

const GlobeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M2.5 12h19M12 2.5c2.7 2.6 4 5.9 4 9.5s-1.3 6.9-4 9.5c-2.7-2.6-4-5.9-4-9.5s1.3-6.9 4-9.5z" />
  </svg>
)

/* ---------- 操作行卡片 ---------- */
function ActionRow(props: {
  icon: React.ReactNode
  iconCls: string
  title: string
  desc: string
  right?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={props.onClick}
      className="group flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-left shadow-[0_1px_3px_rgba(15,23,42,.05)] transition-all hover:border-sky-300 hover:shadow-[0_6px_20px_rgba(14,165,233,.14)] active:scale-[.985]"
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${props.iconCls}`}>
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800">{props.title}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-400">{props.desc}</span>
      </span>
      {props.right}
      <ChevronRight />
    </button>
  )
}

const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} strokeWidth={2.4}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} strokeWidth={2.6} className="text-sky-500">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

const LANG_SHORT: Record<Lang, string> = { 'zh-CN': '简体', 'zh-TW': '繁體', en: 'EN' }

/* ---------- 语言选择器（自定义下拉） ---------- */
function LangSelect(props: { lang: Lang; onChange: (l: Lang) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        title={t(props.lang, 'lang.label')}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 ${
          open ? 'bg-slate-100 text-slate-600' : ''
        }`}
      >
        <GlobeIcon />
        <span className="text-[12px] font-medium">{LANG_SHORT[props.lang]}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1.5 w-32 overflow-hidden rounded-xl border border-slate-100 bg-white py-1 shadow-[0_8px_28px_rgba(15,23,42,.14)]">
          {LANG_ITEMS.map((l) => (
            <button
              key={l.value}
              onClick={() => {
                props.onChange(l.value)
                setOpen(false)
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors ${
                l.value === props.lang
                  ? 'bg-sky-50 font-semibold text-sky-600'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {l.label}
              {l.value === props.lang && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- App ---------- */
export default function App() {
  const [error, setError] = useState<string | null>(null)
  const [lang, setLang] = useLang()
  const [stashCount, setStashCount] = useState(0)

  useEffect(() => {
    countShots()
      .then(setStashCount)
      .catch(() => {})
  }, [])

  const openStash = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/staging/index.html') })
    window.close()
  }

  const run = async (type: RunType) => {
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({ type })) as {
        ok: boolean
        error?: string
      }
      if (res && res.ok === false) {
        setError(res.error || t(lang, 'popup.run.failed'))
        return
      }
      window.close()
    } catch {
      setError(t(lang, 'popup.comm.failed'))
    }
  }

  return (
    <div className="w-[360px] bg-white pb-1">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 pb-4 pt-5">
        <img
          src={logoUrl}
          alt="OrbitShot"
          className="h-11 w-11 shrink-0 rounded-2xl shadow-md shadow-blue-600/20 ring-1 ring-slate-200/60"
          draggable={false}
        />
        <div className="min-w-0 flex-1">
          <span className="text-[17px] font-bold tracking-tight text-slate-900">OrbitShot</span>
          <span className="ml-2 rounded-full bg-blue-50 px-2 py-px text-[10px] font-semibold text-blue-600">
            v0.2.0
          </span>
        </div>
        <div className="flex shrink-0 items-center rounded-xl border border-slate-100 bg-white p-0.5 shadow-sm">
          <LangSelect lang={lang} onChange={setLang} />
          <button
            title={t(lang, 'shortcut.settings')}
            onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
            className="rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
          >
            <KebabIcon />
          </button>
        </div>
      </header>

      {/* Actions */}
      <main className="space-y-2.5 px-4 pb-4">
        <ActionRow
          icon={<CameraIcon />}
          iconCls="border-sky-100 bg-sky-50 text-sky-600"
          title={t(lang, 'action.region')}
          desc={t(lang, 'action.region.desc')}
          right={
            <kbd className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-500">
              Alt + Shift + S
            </kbd>
          }
          onClick={() => run('RUN_FLOW')}
        />
        <ActionRow
          icon={<ImageIcon />}
          iconCls="border-indigo-100 bg-indigo-50 text-indigo-600"
          title={t(lang, 'action.fullpage')}
          desc={t(lang, 'action.fullpage.desc')}
          onClick={() => run('RUN_FULLPAGE')}
        />
        <ActionRow
          icon={<LayersIcon />}
          iconCls="border-emerald-100 bg-emerald-50 text-emerald-600"
          title={t(lang, 'stash.title')}
          desc={t(lang, 'stash.count', { n: stashCount })}
          right={
            stashCount > 0 ? (
              <span className="shrink-0 rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-bold text-white">
                {stashCount}
              </span>
            ) : undefined
          }
          onClick={openStash}
        />
        <ActionRow
          icon={<GearIcon />}
          iconCls="border-slate-100 bg-slate-50 text-slate-500"
          title={t(lang, 'action.settings')}
          desc={t(lang, 'action.settings.desc')}
          onClick={() => chrome.runtime.openOptionsPage()}
        />

        {error && (
          <div className="rounded-xl bg-red-50/90 px-3.5 py-2.5 text-[11px] leading-5 text-red-600 ring-1 ring-red-100">
            {error}
          </div>
        )}
      </main>
    </div>
  )
}
