// 共享类型与默认 AI 列表
import { AI_ICONS } from './ai-icons'

export interface AiSite {
  id: string
  name: string
  url: string
  enabled: boolean
  custom?: boolean
}

// 精选国内外最常见、有官方网页版的 AI 助手（无内置 logo 的国内大厂产品走 favicon 自动获取）
export const DEFAULT_AI_LIST: AiSite[] = [
  // 国际（默认启用）
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', enabled: true },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', enabled: true },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', enabled: true },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', enabled: true },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', enabled: true },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', enabled: true },
  // 国内（默认启用；元宝/文心/智谱无本地 logo，自动抓取站点图标）
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', enabled: true },
  { id: 'kimi', name: 'Kimi', url: 'https://kimi.moonshot.cn/', enabled: true },
  { id: 'qwen', name: '通义千问', url: 'https://www.tongyi.com/', enabled: true },
  { id: 'yuanbao', name: '腾讯元宝', url: 'https://yuanbao.tencent.com/chat/', enabled: true },
  { id: 'yiyan', name: '文心一言', url: 'https://yiyan.baidu.com/', enabled: true },
  { id: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/', enabled: true },
  // 常见但默认不启用，按需在设置页打开
  { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/', enabled: false },
  { id: 'poe', name: 'Poe', url: 'https://poe.com/', enabled: false },
  { id: 'character', name: 'Character.AI', url: 'https://character.ai/', enabled: false },
  { id: 'mistral', name: 'Le Chat', url: 'https://chat.mistral.ai/chat', enabled: false },
  { id: 'xinghuo', name: '讯飞星火', url: 'https://xinghuo.xfyun.cn/desk', enabled: false },
  { id: 'metaso', name: '秘塔AI搜索', url: 'https://metaso.cn/', enabled: false },
]

export const STORAGE_KEY = 'orbitshot.settings'

/** 环形菜单 AI 平台启用数量的硬性限制（二级菜单的返回/设置入口不计入） */
export const MIN_ENABLED_AI = 5
export const MAX_ENABLED_AI = 12

/**
 * 历史配置迁移：把启用数量归一到 5~12。
 * 超上限时按列表顺序关闭多余项；低于下限时按列表顺序补足。
 * 仅修改内存副本，调用方决定是否回写。
 */
export function normalizeAiEnabled(list: AiSite[]): { list: AiSite[]; changed: boolean } {
  const next = list.map((s) => ({ ...s }))
  let changed = false
  let on = 0
  for (const s of next) {
    if (s.enabled) {
      on++
      if (on > MAX_ENABLED_AI) {
        s.enabled = false
        changed = true
      }
    }
  }
  let need = MIN_ENABLED_AI - next.filter((s) => s.enabled).length
  for (const s of next) {
    if (need <= 0) break
    if (!s.enabled) {
      s.enabled = true
      need--
      changed = true
    }
  }
  return { list: next, changed }
}

/** 界面语言 */
export type Lang = 'zh-CN' | 'zh-TW' | 'en'

/** 根据浏览器语言猜测默认语言 */
export function detectLang(): Lang {
  const l = (navigator.language || 'zh-CN').toLowerCase()
  if (l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.startsWith('zh-hant')) return 'zh-TW'
  if (l.startsWith('en')) return 'en'
  return 'zh-CN'
}

export interface Settings {
  aiList: AiSite[]
  lang?: Lang
  /** 自定义区域截图快捷键（规范形如 "Alt+Shift+S"），空字符串表示未启用 */
  hotkey?: string
  /** 打开截图暂存区的快捷键（映射到 Chrome 原生 commands 的 open-staging），空字符串 = 恢复默认 Alt+Shift+O */
  stashHotkey?: string
  /** 界面整体字号缩放（0.9 = 小 / 1 = 默认 / 1.15 = 大 / 1.3 = 特大） */
  fontScale?: number
  /** 设置页侧边栏是否折叠 */
  sidebarCollapsed?: boolean
  /**
   * 多模型对比模式：批量发送到 ≥2 个平台时，是否在侧边栏并排展示
   * 各平台的文字回答。关闭 = 完全保持原有行为（仅注入截图）。
   */
  compareMode?: boolean
  /** 公式识别：用户删除过模型（再次引导时文案改为「重新下载」） */
  formulaModelDeletedOnce?: boolean
}

export async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const s = res?.[STORAGE_KEY] as Settings | undefined
      if (s && Array.isArray(s.aiList)) {
        // 历史配置不符合 5~12 限制时归一化，并异步回写一次（下次读取即一致，不会循环）
        const norm = normalizeAiEnabled(s.aiList)
        if (norm.changed) saveSettings({ ...s, aiList: norm.list }).catch(() => {})
        resolve({
          ...s,
          aiList: norm.list,
          lang: s.lang ?? detectLang(),
          hotkey: s.hotkey ?? '',
          stashHotkey: s.stashHotkey ?? '',
          fontScale: typeof s.fontScale === 'number' && s.fontScale > 0 ? s.fontScale : 1,
          sidebarCollapsed: s.sidebarCollapsed === true,
          compareMode: s.compareMode === true,
        })
      } else {
        resolve({ aiList: DEFAULT_AI_LIST, lang: detectLang(), hotkey: '', stashHotkey: '', fontScale: 1, sidebarCollapsed: false, compareMode: false })
      }
    })
  })
}

export async function saveSettings(s: Settings): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: s }, resolve))
}

/** 内置 logo 图标（data URL），自定义 AI 无图标则回退首字母 */
export function iconForSite(id: string): string | undefined {
  return AI_ICONS[id]
}

/** 从 URL 提取主机名 */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * 自定义 AI 的 favicon 端到端获取链（无内置图标时使用，逐个回退）：
 * 1. 站点根路径 /favicon.ico
 * 2. favicon.im 公共服务
 * 全部失败则由 UI 层显示首字母
 */
export function faviconCandidates(url: string): string[] {
  const host = hostOf(url)
  if (!host) return []
  return [`https://${host}/favicon.ico`, `https://favicon.im/${host}?larger=true`]
}

/**
 * 从 KeyboardEvent 生成规范组合键字符串（如 "Alt+Shift+S"）。
 * 仅按修饰键本身按下时返回 null；组合顺序固定为 Ctrl > Alt > Shift > Cmd > 主键。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const ignoreKeys = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu', 'Dead']
  if (ignoreKeys.includes(e.key)) return null
  let key: string
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase()
  else key = e.key
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Cmd')
  parts.push(key)
  return parts.join('+')
}

/** 组合键是否可用作全局快捷键：需含 Ctrl/Alt/Cmd 修饰，或为 F1-F12 功能键 */
export function isValidCombo(combo: string | null): boolean {
  if (!combo) return false
  const parts = combo.split('+')
  const main = parts[parts.length - 1]
  if (/^F([1-9]|1[0-2])$/.test(main)) return true
  return parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Cmd')
}
