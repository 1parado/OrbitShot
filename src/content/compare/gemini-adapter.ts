/**
 * Gemini 适配器。
 *
 * 编辑器：Quill（div.ql-editor[contenteditable="true"]，rich-textarea 内）。
 * 发送按钮：button.send-button / mat-icon 内含 send 图标的按钮。
 * 回答区：model-response 容器内的 markdown-web 组件（自定义元素）。
 * 生成中：输入区出现停止按钮 button[aria-label*="Stop"]。
 */
import type { DomProbe } from './base-adapter'

export const geminiProbe: DomProbe = {
  composer: ['div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
  submit: [
    'button.send-button',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送" i]',
    'button[mattooltip*="Send" i]',
  ],
  // 自定义元素：model-response / model-chat-message 均出现过，按最后一个匹配
  answer: [
    'model-response:last-of-type message-content',
    'model-response:last-of-type',
    'model-chat-message:last-of-type message-content',
  ],
  generating: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止" i]', '.stop-icon'],
}
