/**
 * 公式识别 offscreen 推理文档（有 DOM，可解码图片 / 跑 WASM 推理）。
 *
 * 职责（PRD §4.3.1）：
 * - ModelStore：模型下载（带进度/取消）/ IndexedDB 缓存 / 读取 / 删除
 * - Preprocess：解码 → 灰度 → 裁紧致边界 → pad32 → 尺寸对齐(672/192/32) → 归一化
 * - Inference：onnxruntime-web（encoder 单次前向 + decoder 自回归，argmax 采样）
 * - Postprocess：tokenizer 解码 → 剥定界符 → completeLatexSource 结构校验（警告不拦截）
 *
 * 消息（SW → 本文档）：ORC_DOWNLOAD / ORC_CANCEL / ORC_INIT / ORC_RECOGNIZE / ORC_DELETE
 * 回传（本文档 → SW）：ORC_PROGRESS / ORC_READY / ORC_RESULT / ORC_STATE
 */
import type {
  FormulaOffscreenMsg,
  FormulaProgress,
  FormulaModelState,
} from '../shared/formula-models'
import { FORMULA_MODEL_FILES, FORMULA_INFER_CONFIG } from '../shared/formula-models'
import { getModelFile, hasAllModelFiles, putModelFile, clearModelFiles } from './formula-model-store'

// ---- 模型状态（内存）+ IndexedDB 存在性为事实来源 ----

let state: FormulaModelState = 'not-downloaded'
let downloadAbort: AbortController | null = null
let ortReady = false
let encoderSession: any = null
let decoderSession: any = null
let vocabById: string[] = []

function setState(next: FormulaModelState): void {
  state = next
  chrome.runtime.sendMessage({ type: 'ORC_STATE', state: next }).catch(() => {})
}

function sendProgress(progress: FormulaProgress): void {
  chrome.runtime.sendMessage({ type: 'ORC_PROGRESS', progress }).catch(() => {})
}

// ---- 下载（fetch → IndexedDB；可取消；失败可重试） ----

async function downloadModels(): Promise<void> {
  if (state === 'downloading' || state === 'ready') return
  downloadAbort = new AbortController()
  setState('downloading')

  try {
    const totalBytes = FORMULA_MODEL_FILES.reduce((n, f) => n + f.sizeMB * 1024 * 1024, 0)
    let receivedTotal = 0
    for (const file of FORMULA_MODEL_FILES) {
      const resp = await fetch(file.url, { signal: downloadAbort.signal })
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
      const total = Number(resp.headers.get('content-length') || 0)
      const reader = resp.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        receivedTotal += value.length
        sendProgress({
          state: 'downloading',
          percent: Math.min(99, Math.round((receivedTotal / totalBytes) * 100)),
          file: file.name,
          receivedBytes: received,
          totalBytes: total,
        })
      }
      const buf = new Uint8Array(received)
      let pos = 0
      for (const c of chunks) {
        buf.set(c, pos)
        pos += c.length
      }
      await putModelFile(file.name, buf.buffer as ArrayBuffer)
    }
    sendProgress({ state: 'downloading', percent: 100 })
  } catch (e) {
    downloadAbort = null
    setState('not-downloaded') // R4/R5：取消或失败回到可重试态（部分字节作废）
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      chrome.runtime.sendMessage({
        type: 'ORC_PROGRESS',
        progress: { state: 'not-downloaded', percent: 0 },
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
    }
    return
  }
  downloadAbort = null
  await initSessions()
}

// ---- 模型加载（onnxruntime-web + tokenizer） ----

async function initSessions(): Promise<void> {
  if (ortReady) return
  setState('initializing')
  sendProgress({ state: 'initializing', percent: 100 })
  try {
    const [enc, dec, tok] = await Promise.all([
      getModelFile('encoder.onnx'),
      getModelFile('decoder.onnx'),
      getModelFile('tokenizer.json'),
    ])
    if (!enc || !dec || !tok) throw new Error('model files missing')

    const ort = await import('onnxruntime-web')
    // wasm 运行时随 onnxruntime-web 包分发（CDN 路径），仅首次推理需联网校验
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.version}/dist/`
    encoderSession = await ort.InferenceSession.create(new Uint8Array(enc))
    decoderSession = await ort.InferenceSession.create(new Uint8Array(dec))

    // tokenizer.json（HF BPE 格式）：model.vocab {token -> id} 反转出 id -> token
    const tokJson = JSON.parse(new TextDecoder().decode(new Uint8Array(tok)))
    const vocab: Record<string, number> = tokJson.model?.vocab ?? {}
    vocabById = []
    for (const [token, id] of Object.entries(vocab)) vocabById[id] = token

    ortReady = true
    setState('ready')
    chrome.runtime.sendMessage({ type: 'ORC_READY' }).catch(() => {})
  } catch (e) {
    setState('not-downloaded')
    chrome.runtime.sendMessage({
      type: 'ORC_PROGRESS',
      progress: { state: 'not-downloaded', percent: 0 },
      error: e instanceof Error ? e.message : String(e),
    }).catch(() => {})
  }
}

async function ensureReady(): Promise<boolean> {
  if (ortReady) return true
  const files = FORMULA_MODEL_FILES.map((f) => f.name)
  if (await hasAllModelFiles(files)) {
    await initSessions()
    return ortReady
  }
  return false
}

// ---- 预处理（对齐上游 PreProcess：灰度→裁紧致边界→pad32→minmax 尺寸→归一化） ----

async function preprocess(dataUrl: string): Promise<{ tensor: Float32Array; h: number; w: number }> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
  const cv = document.createElement('canvas')
  cv.width = img.naturalWidth
  cv.height = img.naturalHeight
  const ctx = cv.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const raw = ctx.getImageData(0, 0, cv.width, cv.height)

  // 1) 灰度（LA 语义：无透明通道时直接取亮度）
  const w0 = cv.width
  const h0 = cv.height
  let gray = new Float32Array(w0 * h0)
  for (let i = 0; i < w0 * h0; i++) {
    gray[i] = 0.299 * raw.data[i * 4] + 0.587 * raw.data[i * 4 + 1] + 0.114 * raw.data[i * 4 + 2]
  }
  // 2) min-max 拉伸到 0..255
  let min = 255
  let max = 0
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < min) min = gray[i]
    if (gray[i] > max) max = gray[i]
  }
  const range = max - min || 1
  for (let i = 0; i < gray.length; i++) gray[i] = ((gray[i] - min) / range) * 255
  // 3) 深色背景反转为浅色（上游：mean>128 时保留白底，否则反转）
  let mean = 0
  for (let i = 0; i < gray.length; i++) mean += gray[i]
  mean /= gray.length
  if (mean <= 128) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i]
  }
  // 4) 裁剪到内容紧致边界（文本像素 = 明显偏离白底）
  let minX = w0
  let minY = h0
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h0; y++) {
    for (let x = 0; x < w0; x++) {
      if (gray[y * w0 + x] < 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) {
    minX = 0
    minY = 0
    maxX = w0 - 1
    maxY = h0 - 1
  }
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  // 5) pad 到 32 倍数（内容左上对齐，白底）
  const round32 = (n: number) => Math.ceil(n / 32) * 32
  const pw = Math.min(round32(cw), FORMULA_INFER_CONFIG.maxWidth)
  const ph = Math.min(round32(ch), FORMULA_INFER_CONFIG.maxHeight)
  // 6) 尺寸对齐：超 max 等比缩小；不足 min 用白底 pad
  const scale = Math.min(1, FORMULA_INFER_CONFIG.maxWidth / cw, FORMULA_INFER_CONFIG.maxHeight / ch)
  const rw = Math.max(FORMULA_INFER_CONFIG.minWidth, Math.min(FORMULA_INFER_CONFIG.maxWidth, Math.round(cw * scale)))
  const rh = Math.max(FORMULA_INFER_CONFIG.minHeight, Math.min(FORMULA_INFER_CONFIG.maxHeight, Math.round(ch * scale)))
  const rc = document.createElement('canvas')
  rc.width = Math.max(rw, pw > rw ? pw : 0) || rw
  // 最终画布：内容按 rw/rh 缩放绘制，再白底 pad 到 ≥32 倍数且 ≤max
  const fw = Math.max(rw, FORMULA_INFER_CONFIG.minWidth)
  const fh = Math.max(rh, FORMULA_INFER_CONFIG.minHeight)
  rc.width = fw
  rc.height = fh
  const rctx = rc.getContext('2d')!
  rctx.fillStyle = '#ffffff'
  rctx.fillRect(0, 0, fw, fh)
  rctx.drawImage(cv, minX, minY, cw, ch, 0, 0, rw, rh)
  const data = rctx.getImageData(0, 0, fw, fh)
  // 7) 归一化：(pixel - mean*255) / (std*255)，单通道
  const tensor = new Float32Array(fw * fh)
  for (let i = 0; i < fw * fh; i++) {
    const lum = 0.299 * data.data[i * 4] + 0.587 * data.data[i * 4 + 1] + 0.114 * data.data[i * 4 + 2]
    tensor[i] = (lum - 0.7931 * 255) / (0.1738 * 255)
  }
  void pw
  void ph
  return { tensor, h: fh, w: fw }
}

// ---- 自回归解码（无 KV cache：每步重算，最大 512 token） ----

async function decode(context: any /* encoder output Tensor */): Promise<number[]> {
  const ort = await import('onnxruntime-web')
  const { bosToken, eosToken, maxSeqLen } = FORMULA_INFER_CONFIG
  const inputNames = decoderSession.inputNames
  // 输入按模型签名：tokens / mask / context（RapidLaTeXOCR decoder 导出顺序）
  const makeFeeds = (ids: number[], maskLen: number) => {
    const tokens = new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length])
    const mask = new ort.Tensor('bool', new Array(maskLen).fill(true), [1, maskLen])
    const feeds: Record<string, any> = {}
    feeds[inputNames[0]] = tokens
    if (inputNames[1]) feeds[inputNames[1]] = mask
    if (inputNames[2]) feeds[inputNames[2]] = context
    // 其余输入名（如有）由模型图内部初始化
    return feeds
  }

  const ids: number[] = [bosToken]
  for (let step = 0; step < Math.min(maxSeqLen, 256); step++) {
    const clipped = ids.slice(-maxSeqLen)
    const feeds = makeFeeds(clipped, clipped.length)
    const results = await decoderSession.run(feeds)
    const logits = results[decoderSession.outputNames[0]]
    const data = logits.data as Float32Array
    const vocabSize = logits.dims[logits.dims.length - 1]
    // argmax（config temperature=1e-5 → 采样退化为确定值）
    let best = 0
    for (let i = 1; i < vocabSize; i++) {
      if (data[(clipped.length - 1) * vocabSize + i] > data[(clipped.length - 1) * vocabSize + best]) best = i
    }
    if (best === eosToken) break
    ids.push(best)
  }
  return ids.slice(1) // 去掉 BOS
}

// ---- tokenizer 解码 + LaTeX 结构校验（Snow Shot completeLatexSource 思路） ----

function tokenIdsToLatex(ids: number[]): string {
  const detok = ids.map((id) => vocabById[id] ?? '').join(' ')
  return detok
    .split(' ')
    .join('')
    .replace(/Ġ/g, ' ')
    .replace(/\[EOS\]/g, '')
    .replace(/\[BOS\]/g, '')
    .replace(/\[PAD\]/g, '')
    .trim()
}

/** 结构校验：{}/环境/$ 配平 + 拒收包装器。失败 → 警告（不拦截展示） */
function latexHasStructureIssues(latex: string): boolean {
  const withoutComment = latex.split('\n').filter((l) => !l.trim().startsWith('%')).join('\n')
  let braces = 0
  const envStack: string[] = []
  const envRe = /\\(begin|end)\{([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = envRe.exec(withoutComment))) {
    if (m[1] === 'begin') envStack.push(m[2])
    else if (envStack.pop() !== m[2]) return true
  }
  let inMath = false
  for (let i = 0; i < withoutComment.length; i++) {
    const c = withoutComment[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') braces++
    else if (c === '}') braces--
    else if (c === '$') inMath = !inMath
  }
  if (braces !== 0 || envStack.length || inMath) return true
  // 拒收自然语言/HTML 包装（识别跑飞的特征）
  if (/<html|<!doctype|\{\{"|^\s*here\s+is/i.test(withoutComment)) return true
  return false
}

// ---- 识别入口 ----

async function recognize(requestId: string, dataUrl: string): Promise<void> {
  try {
    if (!(await ensureReady())) throw new Error('MODEL_NOT_READY')
    const { tensor, h, w } = await preprocess(dataUrl)
    const ort = await import('onnxruntime-web')
    const inputNames = encoderSession.inputNames
    const feeds: Record<string, any> = {}
    feeds[inputNames[0]] = new ort.Tensor('float32', tensor, [1, 1, h, w])
    const encResults = await encoderSession.run(feeds)
    const context = encResults[encoderSession.outputNames[0]]
    const ids = await decode(context)
    let latex = tokenIdsToLatex(ids)
    latex = latex.replace(/^\$\$?/, '').replace(/\$\$?$/, '').replace(/^\\\(|\\\)$/g, '').trim()
    const warning = !latex || latexHasStructureIssues(latex)
    chrome.runtime.sendMessage({ type: 'ORC_RESULT', requestId, ok: true, latex, warning }).catch(() => {})
  } catch (e) {
    chrome.runtime
      .sendMessage({
        type: 'ORC_RESULT',
        requestId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
      .catch(() => {})
  }
}

// ---- 消息入口 ----

chrome.runtime.onMessage.addListener((msg: FormulaOffscreenMsg & { error?: string }) => {
  switch (msg?.type) {
    case 'ORC_DOWNLOAD':
      void downloadModels()
      break
    case 'ORC_CANCEL':
      downloadAbort?.abort()
      break
    case 'ORC_INIT':
      void (async () => {
        if (await ensureReady()) chrome.runtime.sendMessage({ type: 'ORC_READY' }).catch(() => {})
      })()
      break
    case 'ORC_RECOGNIZE':
      void recognize(msg.requestId, msg.dataUrl)
      break
    case 'ORC_DELETE':
      void (async () => {
        await clearModelFiles()
        ortReady = false
        encoderSession = null
        decoderSession = null
        vocabById = []
        setState('not-downloaded')
      })()
      break
  }
})
