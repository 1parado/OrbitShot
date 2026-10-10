/**
 * Claude 适配器。
 *
 * 编辑器：ProseMirror（div[contenteditable="true"]，aria-label 随语言变化
 * 但 data-placeholder 存在）。发送按钮：button[aria-label="Send message"]（英文）
 * 或 aria-label 含 Send / 发送。
 * 回答区：div[data-testid="assistant-message"]（每个 assistant 消息一个）。
 * 生成中：停止按钮 button[aria-label*="Stop"] 存在。
 */
import type { DomProbe } from './base-adapter'

export const claudeProbe: DomProbe = {
  composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
  submit: ['button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[data-testid="send-button"]'],
  answer: ['div[data-testid="assistant-message"]:last-of-type', 'div.font-claude-message:last-of-type'],
  generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]'],
}
