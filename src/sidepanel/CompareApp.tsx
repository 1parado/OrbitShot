/**
 * 多模型对比结果视图（Cherry Studio 式并排展示）。
 * 输入支持两种方式：截图发送流程（content 弹出的输入框），以及结果页底部
 * 的追问框——同一批平台在各自 AI 站点的活会话上继续提问（turn+1 新任务，
 * 旧轮任务保留，卡片按平台分列、纵向堆叠多轮回答）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../assets/logo.png'
import { t, useLang } from '../shared/i18n'
import type { CompareBatch, CompareAiId, ComparePlatform, CompareTask, CompareAttachment } from '../shared/compare-types'
import { isActiveStatus, platformsFromAiList } from '../shared/compare-types'
import { loadSettings } from '../shared/settings'
import { cancelBatch, connectPort, followUpBatch } from './services/api'
import ModelResponseCard from './components/ModelResponseCard'
import SummaryPanel from './components/SummaryPanel'
import AnchorNav from './components/AnchorNav'
import type { AnchorItem } from './components/AnchorNav'

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
  const mainRef = useRef<HTMLElement | null>(null)
  const [mainWidth, setMainWidth] = useState(0)

  // Port 订阅：SW 快照驱动
  useEffect(() => connectPort(setBatch), [])

  // 容器宽度测量：窄面板自动减少列数（ResizeObserver 跟随侧边栏拖拽/窗口缩放）
  useEffect(() => {
    const el = mainRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setMainWidth(e.contentRect.width)
    })
    ro.observe(el)
    setMainWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  /**
   * 列数 = min(平台数, 宽度允许的列数)：
   * 每列至少 ~300px 才可读，两栏 ≥620px，三栏 ≥930px；窄侧边栏自动降列。
   */
  const cols = useMemo(() => {
    const n = batch?.currentTurn && batch.currentTurn >= 2
      ? new Set(batch.tasks.map((tk) => tk.aiId)).size
      : batch?.tasks.length ?? 0
    if (n <= 1) return 1
    if (!mainWidth) return Math.min(n, 3)
    const fit = Math.max(1, Math.min(3, Math.floor((mainWidth + 10) / 310)))
    return Math.max(1, Math.min(n, fit))
  }, [batch?.tasks.length, batch?.currentTurn, mainWidth])

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

  // ---- 多轮追问 ----
  const [draft, setDraft] = useState('')
  const [followErr, setFollowErr] = useState<string | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [attachments, setAttachments] = useState<CompareAttachment[]>([])
  const draftRef = useRef('')
  draftRef.current = draft
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imgInputRef = useRef<HTMLInputElement | null>(null)

  // canFollowUp：有批次、无活跃任务、有已完成回答即可追问。
  // currentTurn 只是展示字段——旧批次（截图路径历史数据）可能缺省，不能因此锁死输入。
  const canFollowUp = !!batch && !anyActive && completed.length > 0

  const MAX_ATTACHMENTS = 5
  const MAX_FILE_BYTES = 8 * 1024 * 1024

  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error)
      r.readAsDataURL(f)
    })

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setFollowErr(null)
    const next: CompareAttachment[] = [...attachments]
    for (const f of list) {
      if (next.length >= MAX_ATTACHMENTS) {
        setFollowErr(t(lang, 'cmp.attach.tooMany', { n: MAX_ATTACHMENTS }))
        break
      }
      if (f.size > MAX_FILE_BYTES) {
        setFollowErr(t(lang, 'cmp.attach.tooBig'))
        continue
      }
      try {
        next.push({ name: f.name, mime: f.type || 'application/octet-stream', dataUrl: await readAsDataUrl(f) })
      } catch {
        setFollowErr(f.name)
      }
    }
    setAttachments(next)
  }

  const sendFollowUp = useCallback(async () => {
    const prompt = draftRef.current.trim()
    if (!batch || !prompt || !canFollowUp) return
    setFollowBusy(true)
    setFollowErr(null)
    try {
      const r = await followUpBatch({
        batchId: batch.batchId,
        prompt,
        attachments: attachments.length ? attachments : undefined,
      })
      if (r?.ok) {
        setDraft('')
        setAttachments([])
      } else {
        setFollowErr(r?.error === 'STILL_RUNNING' ? t(lang, 'cmp.follow.running') : r?.error || 'error')
      }
    } catch (e) {
      setFollowErr(e instanceof Error ? e.message : String(e))
    } finally {
      setFollowBusy(false)
    }
  }, [batch, canFollowUp, lang, attachments])

  // ---- 会话锚点导航数据：每轮提问 + 该轮最大回答文本量 + 附件数 ----
  const anchorItems = useMemo<AnchorItem[]>(() => {
    if (!batch?.tasks.length) return []
    const promptOf = (turn: number) => {
      const fromTurns = batch.turns?.find((x) => x.turn === turn)
      if (fromTurns) return fromTurns.prompt
      return batch.tasks.find((tk) => (tk.turn ?? 1) === turn)?.turnPrompt ?? batch.prompt
    }
    const turns = new Set(batch.tasks.map((tk) => tk.turn ?? 1))
    return [...turns].sort((a, b) => a - b).map((turn) => ({
      turn,
      prompt: promptOf(turn),
      maxLength: Math.max(
        0,
        ...batch.tasks.filter((tk) => (tk.turn ?? 1) === turn).map((tk) => tk.response.length + tk.thinking.length)
      ),
      attachmentCount: batch.turns?.find((x) => x.turn === turn)?.attachments?.length ?? 0,
    }))
  }, [batch])

  const [activeTurn, setActiveTurn] = useState(1)

  const scrollToTurn = (turn: number) => {
    setActiveTurn(turn)
    const el = mainRef.current?.querySelector(`[data-turn="${turn}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /**
   * 按平台分列：每列纵向堆叠该平台的多轮回答（turn 1..N）。
   * 列顺序 = 最新轮任务的顺序。
   */
  const columns = useMemo(() => {
    if (!batch) return [] as { aiId: CompareAiId; tasks: CompareTask[] }[]
    const turn = batch.currentTurn ?? 1
    const latest = batch.tasks.filter((tk) => (tk.turn ?? 1) === turn)
    const byAi = new Map<CompareAiId, CompareTask[]>()
    // 旧轮在前、新轮在后
    const ordered = [...batch.tasks].sort((a, b) => (a.turn ?? 1) - (b.turn ?? 1))
    for (const tk of ordered) {
      if (!byAi.has(tk.aiId)) byAi.set(tk.aiId, [])
      byAi.get(tk.aiId)!.push(tk)
    }
    // 列顺序按最新轮任务顺序（新增平台也在列）
    const order: CompareAiId[] = []
    for (const tk of latest) if (!order.includes(tk.aiId)) order.push(tk.aiId)
    for (const key of byAi.keys()) if (!order.includes(key)) order.push(key)
    return order.map((aiId) => ({ aiId, tasks: byAi.get(aiId) ?? [] }))
  }, [batch])

  // 最新轮的追问问题条（turn >= 2 时显示在网格上方）
  const latestTurn = useMemo(() => {
    if (!batch?.turns?.length) return null
    return batch.turns[batch.turns.length - 1]
  }, [batch])

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

      {/* 响应网格：按平台分列（1/2/3 列），每列纵向堆叠多轮回答；窄面板自动降列 */}
      <main ref={mainRef} className="sp-scroll relative mt-2.5 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!batch || !batch.tasks.length ? (
          <EmptyState lang={lang} />
        ) : (
          <>
            {/* 追问轮的问题提示 */}
            {latestTurn && (batch.currentTurn ?? 1) >= 2 && (
              <div className="glass mb-2 rounded-xl px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">
                    {t(lang, 'cmp.follow.turn', { n: latestTurn.turn })}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {t(lang, 'cmp.follow.turn.q')}
                  </span>
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-slate-700">
                  {latestTurn.prompt}
                </div>
              </div>
            )}
            <div
              className="grid items-stretch gap-2.5"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {columns.map((col) => {
                const p = platformOf(col.aiId)
                return (
                  <div key={col.aiId} className="flex min-h-0 flex-col gap-2.5">
                    {col.tasks.map((tk) => (
                      <ModelResponseCard
                        key={tk.requestId}
                        task={tk}
                        name={p?.name ?? tk.aiId}
                        url={p?.url}
                        lang={lang}
                        showTurn={(col.tasks.length > 1) && (tk.turn ?? 1) >= 2}
                        onCopied={() => flash(t(lang, 'toast.copied'))}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>

      {/* 会话锚点导航：右缘竖排短线，hover 预览该轮提问，点击滚动定位（根容器固定，不随内容滚动） */}
      {!!batch?.tasks.length && (
        <AnchorNav items={anchorItems} activeTurn={activeTurn} onSelect={scrollToTurn} />
      )}

      {/* 追问输入条（参考 grok 风格）：一体圆角容器 + 左下图标行 + 右下圆形发送键 */}
      {batch?.tasks.length ? (
        <footer className="shrink-0 px-3 pb-3 pt-1.5">
          {followErr && (
            <div className="mb-1.5 rounded-lg bg-red-50/90 px-2.5 py-1.5 text-[11px] leading-4 text-red-600 ring-1 ring-red-100">
              {followErr}
            </div>
          )}
          <div className="rounded-2xl border border-slate-200 bg-white/95 px-3.5 pt-2.5 pb-1.5 shadow-sm transition focus-within:border-sky-300">
            {/* 已选附件 chips：容器内上方 */}
            {!!attachments.length && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {attachments.map((a, i) => (
                  <span
                    key={`${a.name}-${i}`}
                    className="flex max-w-[180px] items-center gap-1 rounded-lg bg-slate-100 px-1.5 py-0.5 text-[10.5px] text-slate-600 ring-1 ring-slate-200"
                    title={a.name}
                  >
                    <span className="truncate">{a.name}</span>
                    <button
                      type="button"
                      className="shrink-0 text-slate-400 transition hover:text-red-500"
                      onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void sendFollowUp()
                }
              }}
              placeholder={t(lang, 'cmp.follow.ph')}
              rows={2}
              disabled={!canFollowUp || followBusy}
              className="sp-scroll block max-h-28 w-full resize-none border-none bg-transparent text-[12.5px] leading-5 text-slate-700 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-300"
            />
            {/* 图标行：附件 / 图片 / 设置 + 右侧圆形发送 */}
            <div className="mt-0.5 flex items-center gap-0.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addFiles(e.target.files)
                  e.target.value = '' // 允许重复选择同一文件
                }}
              />
              <input
                ref={imgInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <IconMini
                title={t(lang, 'cmp.follow.attach')}
                disabled={!canFollowUp || followBusy}
                onClick={() => fileInputRef.current?.click()}
                d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
              />
              <IconMini
                title={t(lang, 'cmp.follow.image')}
                disabled={!canFollowUp || followBusy}
                onClick={() => imgInputRef.current?.click()}
                d="M21 15V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z M9 10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z m12 9-5.5-5.5L5 21"
              />
              <IconMini
                title={t(lang, 'nav.prefs')}
                disabled={false}
                onClick={() => chrome.runtime.openOptionsPage()}
                d="M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6"
              />
              <button
                type="button"
                onClick={() => void sendFollowUp()}
                disabled={!canFollowUp || followBusy || !draft.trim()}
                title={t(lang, 'cmp.follow.send')}
                className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5 M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
          {!canFollowUp && anyActive && (
            <p className="mt-1 text-[10.5px] text-slate-400">{t(lang, 'cmp.follow.running')}</p>
          )}
        </footer>
      ) : null}

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

/** 输入框图标行的小图标按钮（多段 path，参考 grok 输入框工具条样式） */
function IconMini(props: { title: string; d: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {props.d.split(' M').map((seg, i) => (
          <path key={i} d={i === 0 ? seg : 'M' + seg} />
        ))}
      </svg>
    </button>
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
