/**
 * 公式识别模型的本地存储（IndexedDB `orbitshot` 库 `models` store）。
 *
 * - 与截图暂存区同库不同 store（shots.ts 已随 v2 升级创建该 store）；
 * - 不占 chrome.storage 配额；删除 = 清空 store；
 * - 「已用空间」= 各记录 size 求和。
 *
 * 本模块在 SW / offscreen / options 等同源扩展页面均可直接使用。
 */

const DB_NAME = 'orbitshot'
const DB_VERSION = 2
export const MODELS_STORE = 'models'

export interface ModelRecord {
  data: ArrayBuffer
  size: number
  downloadedAt: number
}

/** 打开库并确保 stores 存在（与 shots.ts 共用同一数据库版本） */
export function openFormulaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('shots')) {
        const st = db.createObjectStore('shots', { keyPath: 'id' })
        st.createIndex('order', 'order')
      }
      if (!db.objectStoreNames.contains(MODELS_STORE)) {
        db.createObjectStore(MODELS_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

async function withModelsStore<T>(
  mode: IDBTransactionMode,
  fn: (st: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  const db = await openFormulaDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(MODELS_STORE, mode)
    const st = tx.objectStore(MODELS_STORE)
    let req: IDBRequest | undefined
    try {
      req = fn(st) as IDBRequest | undefined
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    tx.oncomplete = () => resolve(req?.result as T)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

export async function putModelFile(name: string, data: ArrayBuffer): Promise<void> {
  await withModelsStore<void>('readwrite', (st) => {
    st.put({ data, size: data.byteLength, downloadedAt: Date.now() } satisfies ModelRecord, name)
  })
}

export async function getModelFile(name: string): Promise<ArrayBuffer | undefined> {
  const rec = await withModelsStore<ModelRecord | undefined>('readonly', (st) => st.get(name))
  return rec?.data
}

export async function hasAllModelFiles(names: string[]): Promise<boolean> {
  const keys = new Set(await withModelsStore<IDBValidKey[]>('readonly', (st) => st.getAllKeys()))
  return names.every((n) => keys.has(n))
}

/** 已用空间（字节） */
export async function modelsUsageBytes(): Promise<number> {
  const all = await withModelsStore<ModelRecord[]>('readonly', (st) => st.getAll())
  return all.reduce((n, rec) => n + (rec.size || 0), 0)
}

/** 删除全部模型文件 */
export async function clearModelFiles(): Promise<void> {
  await withModelsStore<void>('readwrite', (st) => st.clear())
}
