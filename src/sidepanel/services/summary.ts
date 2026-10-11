/**
 * 总结（Summary）API 配置与调用。
 *
 * 设计：用户自配 OpenAI 兼容接口（baseURL + apiKey + model），Key 只存
 * chrome.storage.local（绝不进 sync、绝不硬编码）。未配置时 UI 明确提示，
 * 不做任何假设。请求直接从侧边栏页面发起（扩展页面有跨域权限，凭据不出本地）。
 */
import type { Lang } from '../../shared/settings'

export interface SummaryConfig {
  baseUrl: string
  apiKey: string
  model: string
}

const KEY = 'orbitshot.summary.config'

export async function loadSummaryConfig(): Promise<SummaryConfig | null> {
  const res = await chrome.storage.local.get(KEY)
  const c = res?.[KEY] as SummaryConfig | undefined
  if (!c?.baseUrl || !c?.apiKey || !c?.model) return null
  return c
}

export async function saveSummaryConfig(c: SummaryConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: c })
}

function buildPrompt(lang: Lang, question: string, answers: { name: string; text: string }[]): string {
  if (lang === 'en') {
    return (
      'Compare the following answers from different AI models to the same question.\n' +
      'Summarize: (1) points of consensus, (2) key differences, (3) which answer is most accurate/complete and why. ' +
      'Be concise, answer in English.\n\n' +
      `Question:\n${question}\n\n` +
      answers.map((a) => `## ${a.name}\n${a.text}`).join('\n\n')
    )
  }
  if (lang === 'zh-TW') {
    return (
      '以下是多個 AI 模型對同一問題的回答，請進行比較總結：\n' +
      '（1）共識要點；（2）關鍵差異；（3）哪個回答最準確完整及理由。請簡明扼要，使用繁體中文回答。\n\n' +
      `問題：\n${question}\n\n` +
      answers.map((a) => `## ${a.name}\n${a.text}`).join('\n\n')
    )
  }
  return (
    '以下是多个 AI 模型对同一问题的回答，请进行比较总结：\n' +
    '（1）共识要点；（2）关键差异；（3）哪个回答最准确完整及理由。请简明扼要，使用简体中文回答。\n\n' +
    `问题：\n${question}\n\n` +
    answers.map((a) => `## ${a.name}\n${a.text}`).join('\n\n')
  )
}

export class SummaryError extends Error {
  /** 是否为「未配置」类错误（UI 据此引导用户去设置） */
  needsConfig: boolean
  constructor(message: string, needsConfig = false) {
    super(message)
    this.needsConfig = needsConfig
  }
}

/** 调用用户配置的 OpenAI 兼容接口生成总结（非流式，超时 60s） */
export async function requestSummary(
  lang: Lang,
  question: string,
  answers: { name: string; text: string }[]
): Promise<string> {
  const cfg = await loadSummaryConfig()
  if (!cfg) throw new SummaryError('NOT_CONFIGURED', true)
  if (!answers.length) throw new SummaryError('NO_ANSWERS')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: buildPrompt(lang, question, answers) }],
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new SummaryError(`HTTP ${resp.status}: ${body.slice(0, 180)}`)
    }
    const data = await resp.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new SummaryError('EMPTY_RESPONSE')
    return text
  } catch (e) {
    if (e instanceof SummaryError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') throw new SummaryError('SUMMARY_TIMEOUT')
    throw new SummaryError(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}
