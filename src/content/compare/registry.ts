/**
 * Compare 平台注册表：aiId → probe。
 * 三个适配器只声明选择器特征；交互逻辑统一在 compare-entry.ts。
 */
import type { DomProbe } from './base-adapter'
import { chatgptProbe } from './chatgpt-adapter'
import { claudeProbe } from './claude-adapter'
import { geminiProbe } from './gemini-adapter'
import type { CompareAiId } from '../../shared/compare-types'

export const PROBES: Record<CompareAiId, DomProbe> = {
  chatgpt: chatgptProbe,
  claude: claudeProbe,
  gemini: geminiProbe,
}

/** 按当前页面 host 判断本页属于哪个平台 */
export function platformForHost(host: string): CompareAiId | null {
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'chatgpt'
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude'
  if (host === 'gemini.google.com') return 'gemini'
  return null
}
