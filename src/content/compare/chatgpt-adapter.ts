/**
 * ChatGPT 适配器。
 *
 * 编辑器：ProseMirror（#prompt-textarea，contenteditable）。
 * 回答区：article 内的 div.Group（markdown 容器）；流式期间消息容器持续追加。
 * 生成中标志：发送按钮变为「停止」（#stop-button / aria-label="Stop streaming"）。
 * 发送完成标志：composer 内出现「语音/再次发送」且停止按钮消失 + 文本稳定。
 *
 * 选择器按稳定度排序，均需在真实页面验证（见任务报告「未验证项」）。
 */
import type { DomProbe } from './base-adapter'

export const chatgptProbe: DomProbe = {
  composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
  submit: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
  // 回答容器：取最后一个 article 的内容块（流式期间 markdown 容器会被重建）
  answer: [
    'article[data-testid^="conversation-turn"]:last-of-type div.Group',
    'article[data-testid^="conversation-turn"]:last-of-type .markdown',
    'main article:last-of-type',
  ],
  generating: [
    '#stop-button',
    'button[aria-label*="Stop"]',
    'button[data-testid="stop-button"]',
  ],
  finished: ['button[aria-label*="Regenerate"]', 'button[data-testid*="regenerate"]'],
}
