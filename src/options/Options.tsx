import { useEffect, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import {
  DEFAULT_AI_LIST,
  loadSettings,
  saveSettings,
  iconForSite,
  faviconCandidates,
  comboFromEvent,
  isValidCombo,
  MIN_ENABLED_AI,
  MAX_ENABLED_AI,
} from '../shared/settings'
import type { AiSite } from '../shared/settings'
import { t, useLang, LANG_ITEMS } from '../shared/i18n'
import type { Lang } from '../shared/settings'

/** 界面字号档位 */
const FONT_OPTIONS: { value: number; key: string }[] = [
  { value: 0.9, key: 'font.small' },
  { value: 1, key: 'font.default' },
  { value: 1.15, key: 'font.large' },
  { value: 1.3, key: 'font.xlarge' },
]

/* ---------- 站点图标：内置 logo → favicon 端到端回退链 → 首字母 ---------- */
function SiteIcon(props: { site: AiSite }) {
  const { site } = props
  const builtin = iconForSite(site.id)
  const candidates = faviconCandidates(site.url)
  const [idx, setIdx] = useState(0)
  useEffect(() => setIdx(0), [site.url])
  if (builtin) {
    return <img src={builtin} alt="" className="h-7 w-7 shrink-0 rounded-lg" draggable={false} />
  }
  if (candidates.length > 0 && idx < candidates.length) {
    return (
      <img
        src={candidates[idx]}
        onError={() => setIdx((i) => i + 1)}
        alt=""
        referrerPolicy="no-referrer"
        className="h-7 w-7 shrink-0 rounded-lg object-contain"
        draggable={false}
      />
    )
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-500">
      {site.name.charAt(0).toUpperCase()}
    </div>
  )
}

/* ---------- 小图标 ---------- */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const GripIcon = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" className="shrink-0 text-slate-300">
    <circle cx="3.5" cy="3" r="1.3" />
    <circle cx="8.5" cy="3" r="1.3" />
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8.5" cy="8" r="1.3" />
    <circle cx="3.5" cy="13" r="1.3" />
    <circle cx="8.5" cy="13" r="1.3" />
  </svg>
)

const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9.5" />
    <circle cx="8" cy="10" r="0.6" fill="currentColor" />
    <circle cx="16" cy="10" r="0.6" fill="currentColor" />
    <path d="M9 15.5c.9.8 2 1.2 3 1.2s2.1-.4 3-1.2" />
    <circle cx="7" cy="17" r="3" className="fill-white" stroke="none" opacity="0" />
  </svg>
)

const KeyboardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
  </svg>
)

const SlidersIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </svg>
)

const InfoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
)

const GithubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
    <path d="M9 18c-4.51 2-5-2-7-2" />
  </svg>
)

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
)

const ChevronsLeftIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
  </svg>
)

const ChevronsRightIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
  </svg>
)

const GlobeSmallIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M2.5 12h19M12 2.5c2.5 2.6 3.8 5.9 3.8 9.5s-1.3 6.9-3.8 9.5c-2.5-2.6-3.8-5.9-3.8-9.5S9.5 5.1 12 2.5z" />
  </svg>
)

/* ---------- iOS 风格开关 ---------- */
function Toggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className="h-5 w-9 rounded-full bg-slate-200 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-4" />
    </label>
  )
}

/* ---------- 单行 AI 条目 ---------- */
function AiRow(props: {
  site: AiSite
  lang: Lang
  onUpdate: (patch: Partial<AiSite>) => void
  onToggle: (v: boolean) => void
  onDelete: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  isDragging: boolean
}) {
  const { site, lang } = props
  const [grabbing, setGrabbing] = useState(false)
  return (
    <div
      draggable={grabbing}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragEnd={props.onDragEnd}
      onDrop={(e) => e.preventDefault()}
      className={`flex items-center gap-3 rounded-xl border bg-white px-4 py-3 transition-colors hover:border-slate-300 ${
        props.isDragging ? 'border-blue-300 opacity-50' : 'border-slate-200/80'
      }`}
    >
      <span
        onMouseDown={() => setGrabbing(true)}
        onMouseUp={() => setGrabbing(false)}
        className="shrink-0 cursor-grab active:cursor-grabbing"
        title={t(lang, 'ai.drag')}
      >
        <GripIcon />
      </span>
      <SiteIcon site={site} />
      <input
        value={site.name}
        onChange={(e) => props.onUpdate({ name: e.target.value })}
        placeholder={t(lang, 'ai.name.ph')}
        className="w-28 shrink-0 border-0 bg-transparent p-0 text-sm font-medium text-slate-700 outline-none placeholder:text-slate-300"
      />
      <input
        value={site.url}
        onChange={(e) => props.onUpdate({ url: e.target.value })}
        placeholder="https://…"
        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3.5 py-2 text-[13px] text-slate-500 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
      <Toggle checked={site.enabled} onChange={props.onToggle} />
      <button
        onClick={props.onDelete}
        title={t(lang, 'ai.delete')}
        className="shrink-0 text-red-300 transition hover:text-red-500"
      >
        <TrashIcon />
      </button>
    </div>
  )
}

/* ---------- 通用设置行：左标题+描述，右控件 ---------- */
function SettingRow(props: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-8 border-b border-slate-100 py-5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium text-slate-800">{props.title}</div>
        {props.desc && <div className="mt-1 text-[13px] leading-6 text-slate-400">{props.desc}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  )
}

/* ---------- 快捷键录制器 ---------- */
function HotkeyRecorder(props: {
  lang: Lang
  value: string
  onChange: (v: string) => void
}) {
  const { lang, value } = props
  const [recording, setRecording] = useState(false)
  const [err, setErr] = useState('')

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const combo = comboFromEvent(e as unknown as KeyboardEvent)
    if (!combo) return // 修饰键单独按下，等待主键
    if (!isValidCombo(combo)) {
      setErr(t(lang, 'hk.err.needMod'))
      return
    }
    setErr('')
    setRecording(false)
    props.onChange(combo)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={recording ? '' : value || t(lang, 'hk.recorder.empty')}
          placeholder={t(lang, 'hk.recorder.ph')}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setRecording(false)
            setErr('')
          }}
          className={`w-48 rounded-lg border px-3.5 py-2 text-center text-[13px] font-medium outline-none transition ${
            recording
              ? 'animate-pulse border-blue-400 bg-blue-50 text-blue-600 ring-2 ring-blue-100'
              : value
                ? 'border-slate-200 bg-slate-50 text-slate-700'
                : 'border-slate-200 bg-white text-slate-400'
          }`}
        />
        {value && !recording && (
          <button
            onClick={() => props.onChange('')}
            className="rounded-lg px-2 py-1.5 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            {t(lang, 'hk.clear')}
          </button>
        )}
      </div>
      {(recording || err) && (
        <span className={`text-[11px] ${err ? 'text-red-500' : 'text-blue-500'}`}>
          {err || t(lang, 'hk.recorder.ph')}
        </span>
      )}
    </div>
  )
}

/* ---------- 侧边栏导航项 ---------- */
type NavKey = 'ai' | 'hotkeys' | 'prefs' | 'about'

function NavItem(props: {
  active: boolean
  icon: React.ReactNode
  label: string
  collapsed?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.collapsed ? props.label : undefined}
      className={`flex items-center gap-3 rounded-lg text-sm transition-colors ${
        props.collapsed ? 'w-full justify-center px-0 py-2.5' : 'w-full px-3 py-2.5'
      } ${
        props.active
          ? 'bg-slate-100 font-semibold text-slate-900'
          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      <span className={props.active ? 'text-blue-600' : 'text-slate-400'}>{props.icon}</span>
      {!props.collapsed && props.label}
    </button>
  )
}

/* ---------- 设置页 ---------- */
export default function Options() {
  const [lang, setLang] = useLang()
  const [aiList, setAiList] = useState<AiSite[]>(DEFAULT_AI_LIST)
  const [hotkey, setHotkey] = useState('')
  const [stashHotkey, setStashHotkey] = useState('')
  const [fontScale, setFontScale] = useState(1)
  const [compareMode, setCompareMode] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState('')
  const [statusErr, setStatusErr] = useState(false)
  const [section, setSection] = useState<NavKey>('ai')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadSettings().then((s) => {
      setAiList(s.aiList)
      setHotkey(s.hotkey ?? '')
      setStashHotkey(s.stashHotkey ?? '')
      setFontScale(s.fontScale ?? 1)
      setCompareMode(s.compareMode === true)
      setCollapsed(s.sidebarCollapsed === true)
    })
  }, [])

  // Ctrl+K 聚焦搜索框（侧边栏折叠时先展开）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (collapsed) {
          setCollapsed(false)
          persist({ sidebarCollapsed: false })
          setTimeout(() => searchRef.current?.focus(), 60)
        } else {
          searchRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapsed])

  const flash = (text: string, err = false) => {
    setStatus(text)
    setStatusErr(err)
    setTimeout(() => setStatus(''), 1800)
  }

  const persist = (patch: Partial<{ aiList: AiSite[]; hotkey: string; stashHotkey: string; fontScale: number; sidebarCollapsed: boolean; compareMode: boolean }>) => {
    loadSettings().then((s) => saveSettings({ ...s, ...patch }))
  }

  const toggleSidebar = () => {
    setCollapsed((v) => {
      persist({ sidebarCollapsed: !v })
      return !v
    })
  }

  const update = (i: number, patch: Partial<AiSite>) => {
    setAiList((list) => list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  /** 启用/停用：受 5~12 数量限制；通过后即时落盘，环形菜单无需任何刷新即同步 */
  const toggleSite = (site: AiSite, v: boolean) => {
    const count = aiList.filter((s) => s.enabled).length
    if (!v && count <= MIN_ENABLED_AI) {
      flash(t(lang, 'ai.limit.min', { n: MIN_ENABLED_AI }), true)
      return
    }
    if (v && count >= MAX_ENABLED_AI) {
      flash(t(lang, 'ai.limit.max', { n: MAX_ENABLED_AI }), true)
      return
    }
    const next = aiList.map((s) => (s.id === site.id ? { ...s, enabled: v } : s))
    setAiList(next)
    persist({ aiList: next })
  }

  /** 删除：不允许把启用数量删到 5 以下；改动即时落盘 */
  const removeSite = (site: AiSite) => {
    if (site.enabled && aiList.filter((s) => s.enabled).length <= MIN_ENABLED_AI) {
      flash(t(lang, 'ai.limit.min', { n: MIN_ENABLED_AI }), true)
      return
    }
    const next = aiList.filter((s) => s.id !== site.id)
    setAiList(next)
    persist({ aiList: next })
  }

  const save = async (list: AiSite[]) => {
    await saveSettings({ aiList: list, hotkey, lang })
    flash(t(lang, 'ai.saved'))
  }

  const addAi = () => {
    setAiList((list) => [
      ...list,
      { id: crypto.randomUUID(), name: t(lang, 'ai.newName'), url: 'https://', enabled: false, custom: true },
    ])
  }

  /* ---- 拖拽排序（仅同组内，实时换位） ---- */
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const handleDragStart = (site: AiSite) => (e: React.DragEvent) => {
    setDraggingId(site.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', site.id)
  }

  const handleDragOver = (site: AiSite) => (e: React.DragEvent) => {
    const dragId = draggingId
    if (!dragId || dragId === site.id) return
    const from = aiList.find((s) => s.id === dragId)
    if (!from || from.enabled !== site.enabled) return
    e.preventDefault()
    setAiList((list) => {
      const idxFrom = list.findIndex((s) => s.id === dragId)
      const idxTo = list.findIndex((s) => s.id === site.id)
      if (idxFrom < 0 || idxTo < 0 || idxFrom === idxTo) return list
      const next = [...list]
      const [moved] = next.splice(idxFrom, 1)
      next.splice(idxTo, 0, moved)
      return next
    })
  }

  const handleDragEnd = () => setDraggingId(null)

  /* ---- 导航（带搜索过滤） ---- */
  const navGroups: { label: string; items: { key: string; label: string; icon: React.ReactNode; href?: string }[] }[] = [
    {
      label: t(lang, 'nav.group.settings'),
      items: [
        { key: 'ai', label: t(lang, 'nav.ai'), icon: <GridIcon /> },
        { key: 'hotkeys', label: t(lang, 'nav.hotkeys'), icon: <KeyboardIcon /> },
        { key: 'prefs', label: t(lang, 'nav.prefs'), icon: <SlidersIcon /> },
      ],
    },
    {
      label: t(lang, 'nav.group.about'),
      items: [
        { key: 'github', label: t(lang, 'nav.github'), icon: <GithubIcon />, href: 'https://github.com/1parado/OrbitShot' },
        { key: 'about', label: t(lang, 'nav.about'), icon: <InfoIcon /> },
      ],
    },
  ]
  const q = query.trim().toLowerCase()
  const visibleGroups = navGroups
    .map((g) => ({ ...g, items: q ? g.items.filter((i) => i.label.toLowerCase().includes(q)) : g.items }))
    .filter((g) => g.items.length > 0)

  const sectionMeta: Record<NavKey, { title: string; desc: string }> = {
    ai: { title: t(lang, 'nav.ai'), desc: t(lang, 'sec.ai.desc') },
    hotkeys: { title: t(lang, 'hk.title'), desc: t(lang, 'hk.desc') },
    prefs: { title: t(lang, 'pref.title'), desc: t(lang, 'pref.desc') },
    about: { title: t(lang, 'nav.about'), desc: '' },
  }

  const enabled = aiList.filter((s) => s.enabled)
  const disabled = aiList.filter((s) => !s.enabled)

  return (
    <div className="flex h-screen bg-white text-slate-800" style={{ zoom: fontScale }}>
      {/* ---------- 左侧边栏 ---------- */}
      <aside
        className={`flex shrink-0 flex-col border-r border-slate-100 bg-slate-50/50 transition-[width] duration-200 ${
          collapsed ? 'w-[68px]' : 'w-64'
        }`}
      >
        {/* Logo 行 */}
        <div className={`flex items-center pb-4 pt-6 ${collapsed ? 'justify-center px-2' : 'gap-3 px-5'}`}>
          <img src={logoUrl} alt="OrbitShot" className="h-9 w-9 shrink-0 rounded-xl ring-1 ring-slate-200/60" draggable={false} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-tight text-slate-900">OrbitShot</span>
              <button
                onClick={toggleSidebar}
                title={t(lang, 'options.collapse')}
                className="shrink-0 rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <ChevronsLeftIcon />
              </button>
            </>
          )}
        </div>

        {/* 折叠态：展开按钮 */}
        {collapsed && (
          <div className="flex justify-center px-2 pb-4">
            <button
              onClick={toggleSidebar}
              title={t(lang, 'options.expand')}
              className="rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
            >
              <ChevronsRightIcon />
            </button>
          </div>
        )}

        {/* 搜索（折叠时隐藏） */}
        {!collapsed && (
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 transition focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-50">
              <span className="text-slate-300">
                <SearchIcon />
              </span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t(lang, 'options.search')}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-slate-600 outline-none placeholder:text-slate-300"
              />
              <kbd className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[10px] font-medium text-slate-400">
                Ctrl K
              </kbd>
            </div>
          </div>
        )}

        {/* 导航组 */}
        <nav className={`flex-1 space-y-6 overflow-y-auto ${collapsed ? 'px-2' : 'px-3'}`}>
          {visibleGroups.map((g) => (
            <div key={g.label}>
              {!collapsed && <div className="px-3 pb-2 text-xs font-medium text-slate-400">{g.label}</div>}
              <div className="space-y-0.5">
                {g.items.map((item) => (
                  <NavItem
                    key={item.key}
                    active={!item.href && section === item.key}
                    icon={item.icon}
                    label={item.label}
                    collapsed={collapsed}
                    onClick={() =>
                      item.href ? chrome.tabs.create({ url: item.href }) : setSection(item.key as NavKey)
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* 侧边栏底部：语言快速切换 + 版本 */}
        <div className={`border-t border-slate-100 ${collapsed ? 'flex flex-col items-center gap-2 px-2 py-4' : 'px-4 py-4'}`}>
          {collapsed ? (
            <>
              <button
                onClick={toggleSidebar}
                title={`${t(lang, 'lang.label')}: ${LANG_ITEMS.find((l) => l.value === lang)?.label ?? ''}`}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <GlobeSmallIcon />
              </button>
              <div className="text-[10px] text-slate-300">v0.2</div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">{t(lang, 'lang.label')}</span>
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as Lang)}
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-600 outline-none transition focus:border-blue-300"
                >
                  {LANG_ITEMS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2 text-xs text-slate-300">v0.2.0</div>
            </>
          )}
        </div>
      </aside>

      {/* ---------- 右侧内容 ---------- */}
      <main className="flex-1 overflow-y-auto bg-white">
        <div className="mx-auto max-w-3xl px-14 py-12">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{sectionMeta[section].title}</h1>
          {sectionMeta[section].desc && (
            <p className="mt-1.5 text-[15px] text-slate-400">{sectionMeta[section].desc}</p>
          )}

          {/* ===== AI 服务 ===== */}
          {section === 'ai' && (
            <div className="mt-7">
              <div className="flex items-center justify-between pb-3.5">
                <div className="text-[15px] font-bold text-slate-800">
                  {t(lang, 'group.enabled')}
                  <span className="ml-2 text-[13px] font-normal text-slate-400">
                    · {t(lang, 'ai.count', { n: enabled.length })}
                  </span>
                </div>
                <button
                  onClick={addAi}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-700"
                >
                  {t(lang, 'ai.add')}
                </button>
              </div>
              <div className="space-y-2.5">
                {enabled.map((site) => (
                  <AiRow
                    key={site.id}
                    lang={lang}
                    site={site}
                    onUpdate={(patch) => update(aiList.indexOf(site), patch)}
                    onToggle={(v) => toggleSite(site, v)}
                    onDelete={() => removeSite(site)}
                    onDragStart={handleDragStart(site)}
                    onDragOver={handleDragOver(site)}
                    onDragEnd={handleDragEnd}
                    isDragging={draggingId === site.id}
                  />
                ))}
              </div>

              {disabled.length > 0 && (
                <>
                  <div className="pb-3.5 pt-8 text-[15px] font-bold text-slate-800">
                    {t(lang, 'group.disabled')}
                    <span className="ml-2 text-[13px] font-normal text-slate-400">
                      · {t(lang, 'ai.countPlain', { n: disabled.length })}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {disabled.map((site) => (
                      <AiRow
                        key={site.id}
                        lang={lang}
                        site={site}
                        onUpdate={(patch) => update(aiList.indexOf(site), patch)}
                        onToggle={(v) => toggleSite(site, v)}
                        onDelete={() => removeSite(site)}
                        onDragStart={handleDragStart(site)}
                        onDragOver={handleDragOver(site)}
                        onDragEnd={handleDragEnd}
                        isDragging={draggingId === site.id}
                      />
                    ))}
                  </div>
                </>
              )}

              <div className="mt-9 flex items-center justify-between border-t border-slate-100 pt-6">
                <button
                  onClick={() => {
                    if (confirm(t(lang, 'ai.confirmRestore'))) {
                      setAiList(DEFAULT_AI_LIST)
                      save(DEFAULT_AI_LIST)
                    }
                  }}
                  className="text-[15px] font-medium text-blue-600 transition hover:text-blue-700 hover:underline"
                >
                  {t(lang, 'ai.restore')}
                </button>
                <div className="flex items-center gap-3">
                  {status && (
                    <span className={`text-[13px] font-medium ${statusErr ? 'text-red-500' : 'text-emerald-600'}`}>
                      {status}
                    </span>
                  )}
                  <button
                    onClick={() => save(aiList)}
                    className="rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-600/25 transition hover:bg-blue-700"
                  >
                    {t(lang, 'ai.save')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ===== 快捷键 ===== */}
          {section === 'hotkeys' && (
            <div className="mt-7">
              <SettingRow title={t(lang, 'hk.region')} desc={t(lang, 'hk.region.desc')}>
                <HotkeyRecorder
                  lang={lang}
                  value={hotkey}
                  onChange={(v) => {
                    setHotkey(v)
                    persist({ hotkey: v })
                  }}
                />
              </SettingRow>
              <SettingRow title={t(lang, 'hk.stash')} desc={t(lang, 'hk.stash.desc')}>
                <HotkeyRecorder
                  lang={lang}
                  value={stashHotkey}
                  onChange={(v) => {
                    setStashHotkey(v)
                    persist({ stashHotkey: v })
                  }}
                />
              </SettingRow>
              <SettingRow title={t(lang, 'hk.chrome.row')} desc={t(lang, 'hk.chrome.row.desc')}>
                <button
                  onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  {t(lang, 'hk.chrome')}
                </button>
              </SettingRow>
            </div>
          )}

          {/* ===== 偏好设置 ===== */}
          {section === 'prefs' && (
            <div className="mt-7">
              <SettingRow title={t(lang, 'pref.lang')} desc={t(lang, 'pref.lang.desc')}>
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as Lang)}
                  className="w-48 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] text-slate-600 outline-none transition focus:border-blue-300"
                >
                  {LANG_ITEMS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow title={t(lang, 'pref.font')} desc={t(lang, 'pref.font.desc')}>
                <select
                  value={String(fontScale)}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setFontScale(v)
                    persist({ fontScale: v })
                  }}
                  className="w-48 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] text-slate-600 outline-none transition focus:border-blue-300"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={String(f.value)}>
                      {t(lang, f.key)} · {Math.round(f.value * 100)}%
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow title={t(lang, 'pref.compare')} desc={t(lang, 'pref.compare.desc')}>
                <button
                  role="switch"
                  aria-checked={compareMode}
                  onClick={() => {
                    const v = !compareMode
                    setCompareMode(v)
                    persist({ compareMode: v })
                  }}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    compareMode ? 'bg-blue-500' : 'bg-slate-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      compareMode ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </SettingRow>
            </div>
          )}

          {/* ===== 关于 ===== */}
          {section === 'about' && (
            <div className="mt-7">
              <SettingRow title="OrbitShot">
                <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">v0.3.0</span>
              </SettingRow>
              <SettingRow title={t(lang, 'about.version')} desc="Chrome Extension · Manifest V3">
                <span className="text-xs text-slate-400">0.3.0</span>
              </SettingRow>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
