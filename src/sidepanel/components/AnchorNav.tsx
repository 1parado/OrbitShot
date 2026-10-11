/**
 * 会话锚点导航（Conversation Anchor Navigation）。
 *
 * 折叠态：右侧竖排的灰色短线——每条线对应一轮提问；线长按该轮回答
 * 文本量对数缩放（回答越长线越长），当前轮高亮。
 * Hover：浮层展示该轮的用户提问原文（解决"不知道跳到哪里"的问题）。
 * 点击：滚动定位到对应轮次的回答卡片（scrollIntoView）。
 */
import { useState } from 'react'

export interface AnchorItem {
  /** 轮次（1 起） */
  turn: number
  /** 该轮用户提问 */
  prompt: string
  /** 该轮回答的最大文本量（线长缩放用；0 = 还没有回答） */
  maxLength: number
  /** 该轮附件数（>0 时浮层展示附件徽标） */
  attachmentCount?: number
}

export default function AnchorNav(props: {
  items: AnchorItem[]
  activeTurn: number
  onSelect: (turn: number) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (props.items.length < 2) return null // 单轮对话无需导航

  return (
    <div className="pointer-events-none absolute right-1 top-1/2 z-20 flex -translate-y-1/2 flex-col items-end gap-2.5 pr-0.5">
      {props.items.map((it) => {
        const active = it.turn === props.activeTurn
        // 线长：0.3k 字 ≈ 14px，10k+ 封顶 40px；无回答给最小长度
        const len = 10 + Math.min(30, Math.log2(Math.max(2, it.maxLength)) * 3)
        return (
          <div
            key={it.turn}
            className="group relative flex items-center"
            onMouseEnter={() => setHover(it.turn)}
            onMouseLeave={() => setHover((v) => (v === it.turn ? null : v))}
          >
            {/* 浮层：该轮提问原文 */}
            {hover === it.turn && (
              <div className="glass pointer-events-none absolute right-full top-1/2 z-30 mr-1.5 w-56 -translate-y-1/2 rounded-xl px-2.5 py-2 shadow-lg ring-1 ring-slate-200/70">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[9.5px] font-bold text-slate-600">
                    Q{it.turn}
                  </span>
                  {!!it.attachmentCount && (
                    <span className="text-[9.5px] font-medium text-slate-400">
                      📎 {it.attachmentCount}
                    </span>
                  )}
                </div>
                <div className="sp-scroll line-clamp-6 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-[18px] text-slate-600">
                  {it.prompt || '—'}
                </div>
              </div>
            )}
            {/* 锚点线 */}
            <button
              type="button"
              aria-label={`Q${it.turn}`}
              onClick={() => props.onSelect(it.turn)}
              style={{ width: `${len}px` }}
              className={`pointer-events-auto h-[3px] rounded-full transition-all duration-150 ${
                active
                  ? 'bg-sky-500 group-hover:bg-sky-600'
                  : 'bg-slate-300 group-hover:bg-slate-400'
              }`}
            />
          </div>
        )
      })}
    </div>
  )
}
