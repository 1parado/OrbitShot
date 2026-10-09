// OrbitShot i18n：React Hook 层（词典与 t 在 ./dicts，供含 SW 在内的所有端共用）
import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, detectLang } from './settings'
import type { Lang } from './settings'

export { t, LANG_ITEMS } from './dicts'

/** React Hook：读取 / 切换语言（持久化到 settings） */
export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>('zh-CN')
  useEffect(() => {
    loadSettings().then((s) => setLang(s.lang ?? detectLang()))
  }, [])
  const change = (l: Lang) => {
    setLang(l)
    loadSettings().then((s) => saveSettings({ ...s, lang: l }))
  }
  return [lang, change]
}
