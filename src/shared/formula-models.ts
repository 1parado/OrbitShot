/**
 * 公式识别（Formula → LaTeX）共享常量与消息协议。
 *
 * 模型：RapidLaTeXOCR（pix2tex/LaTeX-OCR 的 ONNX 移植）。
 * 下载源为 GitHub Release 直链（实测可达，2026-10）；PRD 预算的 int8 版本
 * 无公开直链，当前为 fp32（decoder 48.6MB + encoder 84.9MB + tokenizer）。
 * URL 集中在此，换源（如未来发布 int8）只改本文件。
 *
 * 预处理/解码参数与上游 config.yaml 对齐：
 * max_width 672 / max_height 192 / min 32 / bos 1 / eos 2 / seq ≤ 512。
 */

export const FORMULA_MODEL_BASE = 'https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0'

export interface FormulaModelFile {
  name: string
  url: string
  /** 近似大小（MB），仅用于 UI 展示与进度加权 */
  sizeMB: number
}

/** 需下载的模型文件（image_resizer.onnx 不需要：resize 由 canvas 实现） */
export const FORMULA_MODEL_FILES: FormulaModelFile[] = [
  { name: 'tokenizer.json', url: `${FORMULA_MODEL_BASE}/tokenizer.json`, sizeMB: 1 },
  { name: 'decoder.onnx', url: `${FORMULA_MODEL_BASE}/decoder.onnx`, sizeMB: 48.6 },
  { name: 'encoder.onnx', url: `${FORMULA_MODEL_BASE}/encoder.onnx`, sizeMB: 84.9 },
]

export const FORMULA_MODEL_TOTAL_MB = FORMULA_MODEL_FILES.reduce((n, f) => n + f.sizeMB, 0)

/** 推理超参（与上游 config.yaml 对齐） */
export const FORMULA_INFER_CONFIG = {
  maxWidth: 672,
  maxHeight: 192,
  minWidth: 32,
  minHeight: 32,
  bosToken: 1,
  eosToken: 2,
  maxSeqLen: 512,
} as const

/** 模型状态机：not-downloaded（默认）→ downloading → ready */
export type FormulaModelState = 'not-downloaded' | 'downloading' | 'initializing' | 'ready'

/** 下载/初始化进度（SW 广播到所有 UI） */
export interface FormulaProgress {
  state: FormulaModelState
  /** 按字节加权的整体百分比（0-100） */
  percent: number
  file?: string
  receivedBytes?: number
  totalBytes?: number
}

// ---- 消息协议（content ↔ SW ↔ offscreen） ----

/** content → SW */
export type FormulaContentMsg =
  | { type: 'FORMULA_OCR'; requestId: string; dataUrl: string }
  | { type: 'FORMULA_MODEL_STATE' }
  | { type: 'FORMULA_MODEL_DOWNLOAD' }
  | { type: 'FORMULA_MODEL_CANCEL' }
  | { type: 'FORMULA_MODEL_DELETE' }

/** SW → content 广播 */
export type FormulaBroadcast =
  | { type: 'FORMULA_PROGRESS'; progress: FormulaProgress }
  | { type: 'FORMULA_STATE'; state: FormulaModelState }
  | {
      type: 'FORMULA_RESULT'
      requestId: string
      ok: boolean
      latex?: string
      warning?: boolean
      error?: string
    }

/** SW → offscreen */
export type FormulaOffscreenMsg =
  | { type: 'ORC_DOWNLOAD' }
  | { type: 'ORC_CANCEL' }
  | { type: 'ORC_INIT' }
  | { type: 'ORC_RECOGNIZE'; requestId: string; dataUrl: string }
  | { type: 'ORC_DELETE' }

/** offscreen → SW（结果/进度回传） */
export type FormulaOffscreenReply =
  | { type: 'ORC_PROGRESS'; progress: FormulaProgress }
  | { type: 'ORC_READY' }
  | { type: 'ORC_RESULT'; requestId: string; ok: boolean; latex?: string; warning?: boolean; error?: string }
  | { type: 'ORC_STATE'; state: FormulaModelState }
