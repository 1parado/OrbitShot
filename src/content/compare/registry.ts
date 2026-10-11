/**
 * Compare 平台注册表：aiId → probe。
 *
 * - composer 候选来自 background/ai-injector.ts 在真实站点验证过的选择器表
 *   （该表支撑着截图注入功能，随站点改版持续维护）。
 * - answer / generating 选择器按公开 DOM 结构维护，未收录或失效时由
 *   compare-entry 的通用启发式兜底。
 * - ChatGPT 2025+ 新版在桌面宽度也使用 textarea（#mobile-composer-prompt），
 *   已在真实页面验证：React setter + input 事件 + 发送按钮可用。
 */
import type { DomProbe } from './base-adapter'
import type { CompareAiId } from '../../shared/compare-types'

/** 已知平台的针对性探针；未收录 id 返回 null → compare-entry 走通用启发式 */
const PROBES: Partial<Record<string, DomProbe>> = {
  chatgpt: {
    composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', '#mobile-composer-prompt', 'textarea[data-id="root"]', 'textarea'],
    submit: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]'],
    // 新版回答容器：data-message-author-role="assistant"（登录版）；未登录为 LI 列表
    answer: ['[data-message-author-role="assistant"]', 'article[data-testid^="conversation-turn"]:last-of-type .markdown'],
    generating: ['#stop-button', 'button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
    // 推理摘要（o 系列 / gpt-5 思考）：details 折叠容器
    thinking: ['[data-message-author-role="assistant"] details', 'article[data-testid^="conversation-turn"] details'],
  },
  claude: {
    composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    submit: ['button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[data-testid="send-button"]'],
    answer: ['div[data-testid="assistant-message"]:last-of-type', 'div.font-claude-message:last-of-type'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
    // extended thinking 折叠块
    thinking: ['details[data-testid="ai-thinking-block"]', 'div[data-testid="ai-thinking-block"]', 'font-claude-response details'],
  },
  gemini: {
    composer: ['div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    submit: ['button.send-button', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]'],
    answer: ['model-response:last-of-type message-content', 'model-response:last-of-type', 'model-chat-message:last-of-type message-content'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]', '.stop-icon'],
    // 思考过程 chips / 折叠区
    thinking: ['model-response thoughts-collapsible', 'thought-chips', '[data-thoughts-collapse]'],
  },
  deepseek: {
    // 2026 版实测（Tabbit 登录态）：textarea 无 id（name="search"，
    // placeholder「给 DeepSeek 发送消息」）；旧 #chat-input 保留兼容
    composer: ['textarea#chat-input', 'textarea[name="search"]', 'textarea'],
    // 2026 版正文块 = ds-assistant-message-main-content（每条回答一个，
    // 思考块是独立的 ds-think-content 容器不会命中）；旧 --block 保留兼容
    answer: [
      'div.ds-assistant-message-main-content:last-of-type',
      'div.ds-markdown--block:last-of-type',
      'div.ds-markdown:last-of-type',
    ],
    generating: ['div.ds-markdown[data-state="streaming"]'],
    // R1 思考区：ds-think-content（2026 版实测）；旧 hash/_thinking 保留兼容
    thinking: ['div[class*="ds-think-content"]', 'div[class*="_thinking"]', 'div.e1675d8b'],
  },
  kimi: {
    // 2026 版实测（Tabbit 登录态）：编辑器是 div.chat-input-editor（contenteditable），
    // 旧 div#editor 已失效；Enter 合成键不触发发送（探针无 submit → clickSubmit
    // 的按钮匹配依赖 aria/通用选择器，实测待补充）
    composer: ['div.chat-input-editor', 'div#editor', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[role="assistant"]:last-of-type', '.answer-item:last-of-type'],
    // 思考容器（K1/k2 推理模型）
    thinking: ['div.thinking-container', 'div[class*="segment-Think"]', 'div[class*="thinking"]'],
  },
  doubao: {
    // 2026 版实测（Tabbit 未登录页）：输入框改为 textarea[data-testid=chat_input_input]
    // （旧 div 选择器失效）；placeholder「发消息或按住空格说话...」
    composer: ['[data-testid="chat_input_input"]', 'div[contenteditable="true"][data-testid="chat_input_input"]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[data-testid="receive_message"]:last-of-type', 'div[data-testid="message_text_content"]:last-of-type'],
    thinking: ['div[data-testid="think_content"]', 'div[data-testid*="think"]'],
  },
  yuanbao: {
    composer: ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div.agent-chat__bubble__last:last-of-type', 'div.hyc-content:last-of-type'],
    thinking: ['div.agent-chat__conv__think', 'div[class*="think"]'],
  },
  yiyan: {
    // 2026 版实测：域名跳转 wenxin.baidu.com（「百度文心助手」），输入框 id 改为
    // chat-textarea；旧 chat-input 保留兼容
    composer: ['textarea#chat-textarea', 'textarea#chat-input', '#chat-input', 'textarea'],
  },
  qwen: {
    // 2026 版实测：tongyi.com 302 到 qianwen.com（「千问」），输入框是
    // contenteditable（placeholder「向千问提问」，无稳定锚点 → contenteditable 优先）
    composer: ['div[contenteditable="true"]', 'textarea'],
    answer: ['div[class*="answerItem"]:last-of-type', 'div[id*="answer"]:last-of-type'],
    thinking: ['div[class*="thinkContent"]', 'div[class*="reasoning"]'],
  },
  chatglm: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
  grok: {
    composer: ['[aria-label="Ask Grok anything"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[aria-label]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[class*="message-bubble"]:last-of-type'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
    thinking: ['div[class*="reasoning"]', 'details[class*="think"]'],
  },
  perplexity: {
    composer: ['div[contenteditable="true"]', 'textarea'],
    answer: ['div[class*="prose"]:last-of-type'],
  },
  copilot: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
  mistral: {
    composer: ['div[contenteditable="true"]', 'textarea'],
  },
  poe: {
    composer: ['textarea[class*=" GrowingTextArea_textArea"]', 'textarea'],
    answer: ['div[class*="ChatMessage_botContainer"]:last-of-type', 'div[class*="ChatMessagesView_messagePair"]:last-of-type'],
  },
  tongyi: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
  xinghuo: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
  metaso: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
}

/** 兜底探针（未收录平台）：通用编辑器候选，回答区走通用启发式 */
const GENERIC_PROBE: DomProbe = {
  composer: ['div[contenteditable="true"]', 'textarea'],
  submit: ['button[type="submit"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]'],
}

export function probeFor(aiId: CompareAiId): DomProbe {
  return PROBES[aiId] ?? GENERIC_PROBE
}
