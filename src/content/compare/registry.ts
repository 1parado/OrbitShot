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
  },
  claude: {
    composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    submit: ['button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[data-testid="send-button"]'],
    answer: ['div[data-testid="assistant-message"]:last-of-type', 'div.font-claude-message:last-of-type'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
  },
  gemini: {
    composer: ['div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    submit: ['button.send-button', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]'],
    answer: ['model-response:last-of-type message-content', 'model-response:last-of-type', 'model-chat-message:last-of-type message-content'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]', '.stop-icon'],
  },
  deepseek: {
    composer: ['textarea#chat-input', 'textarea'],
    answer: ['div.ds-markdown--block:last-of-type', 'div.ds-markdown:last-of-type'],
    generating: ['div.ds-markdown[data-state="streaming"]'],
  },
  kimi: {
    composer: ['div#editor', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[role="assistant"]:last-of-type', '.answer-item:last-of-type'],
  },
  doubao: {
    composer: ['div[contenteditable="true"][data-testid="chat_input_input"]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[data-testid="receive_message"]:last-of-type', 'div[data-testid="message_text_content"]:last-of-type'],
  },
  yuanbao: {
    composer: ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div.agent-chat__bubble__last:last-of-type', 'div.hyc-content:last-of-type'],
  },
  yiyan: {
    composer: ['textarea#chat-input', '#chat-input', 'textarea'],
  },
  qwen: {
    composer: ['textarea', 'div[contenteditable="true"]'],
    answer: ['div[class*="answerItem"]:last-of-type', 'div[id*="answer"]:last-of-type'],
  },
  chatglm: {
    composer: ['textarea', 'div[contenteditable="true"]'],
  },
  grok: {
    composer: ['[aria-label="Ask Grok anything"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[aria-label]', 'div[contenteditable="true"]', 'textarea'],
    answer: ['div[class*="message-bubble"]:last-of-type'],
    generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
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
