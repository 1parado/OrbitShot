/**
 * 内容脚本就绪探测与按需注入（SW 各流程共用）。
 * 截图注入（executeScript func）与对比提交都必须先确认常驻 CS 已就绪，
 * 否则 sendMessage 会以 "Receiving end does not exist" 失败。
 */

/** 带 PING 的等待：content script（模块）注册消息监听器是异步的，需要稍作轮询 */
export async function pingTab(tabId: number, tries: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' })
      return true
    } catch {
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return false
}

/** 确保目标标签页已注入 content script（插件安装/更新前已打开的页面没有注入） */
export async function ensureContentScript(tabId: number): Promise<{ ok: boolean; error?: string }> {
  // 已注入：直接通过
  if (await pingTab(tabId, 1, 0)) return { ok: true }

  const js = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
  if (!js) return { ok: false, error: '插件配置异常：未找到内容脚本' }

  // 未注入 → 动态注入
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [js] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 常见：页面正在导航 / 是错误页 / 沙箱页 / 标签页已被丢弃
    return { ok: false, error: '此页面暂时无法注入脚本（' + msg.slice(0, 80) + '），请刷新页面后重试' }
  }

  // 注入成功后等待监听器就绪（最多 ~750ms）
  if (await pingTab(tabId, 5, 150)) return { ok: true }
  return { ok: false, error: '内容脚本已注入但未响应，请刷新页面后重试' }
}
