/**
 * 截图暂存区数据层（Tendedero 式「晾衣绳」工作台）。
 *
 * 存储：IndexedDB（扩展 origin），Service Worker / popup / options / staging 等
 * 扩展页面同源共享同一数据库，可直接读写；chrome.storage 仅存设置，绝不存图片。
 *
 * 数据模型 ShotRecord：
 * - id          稳定唯一 ID（crypto.randomUUID），不依赖数组下标
 * - blob        最终合成图（含标注）PNG
 * - baseBlob    干净底图（重标注时使用，blur patch 由渲染层按需重采样）
 * - width/height 图片原始尺寸
 * - createdAt   创建时间
 * - anns        序列化标注（HTMLCanvasElement 等不可克隆字段已在入队前剔除）
 * - order       排序位置（重排时按展示顺序重写 0..n-1）
 *
 * 生命周期：入队（不覆盖已有记录）→ 编辑（更新对应记录）→ 删除（同步清理 blob）
 * → 清空（确认后全删）。容量上限 MAX_SHOTS，超出/配额不足时抛错由调用方提示。
 */

export interface ShotRecord {
  id: string
  blob: Blob
  baseBlob: Blob
  width: number
  height: number
  createdAt: number
  anns: unknown[]
  order: number
}

const DB_NAME = 'orbitshot'
const STORE = 'shots'
export const MAX_SHOTS = 50

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const st = db.createObjectStore(STORE, { keyPath: 'id' })
          st.createIndex('order', 'order')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    })
  }
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (st: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const st = tx.objectStore(STORE)
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

/** 新截图入队：不覆盖已有记录；超出容量或配额不足时抛错 */
export async function addShot(input: {
  blob: Blob
  baseBlob: Blob
  width: number
  height: number
  anns: unknown[]
}): Promise<string> {
  const count = await countShots()
  if (count >= MAX_SHOTS) {
    throw new Error(`FULL:${MAX_SHOTS}`)
  }
  const id = crypto.randomUUID()
  try {
    await withStore<void>('readwrite', (st) => {
      st.add({
        id,
        blob: input.blob,
        baseBlob: input.baseBlob,
        width: input.width,
        height: input.height,
        createdAt: Date.now(),
        anns: input.anns,
        order: count,
      } satisfies ShotRecord)
    })
  } catch (e) {
    // 配额不足等存储错误：明确抛给 UI 层提示
    throw new Error('QUOTA:' + (e instanceof Error ? e.message : String(e)))
  }
  return id
}

/** 按展示顺序（order）列出全部暂存 */
export async function listShots(): Promise<ShotRecord[]> {
  const all = await withStore<ShotRecord[]>('readonly', (st) => st.getAll())
  return all.sort((a, b) => a.order - b.order)
}

export async function getShot(id: string): Promise<ShotRecord | undefined> {
  return withStore<ShotRecord | undefined>('readonly', (st) => st.get(id))
}

export async function countShots(): Promise<number> {
  return withStore<number>('readonly', (st) => st.count())
}

/** 删除单张（同步清理 blob 等关联数据——整条记录删除） */
export async function deleteShot(id: string): Promise<void> {
  await withStore<void>('readwrite', (st) => st.delete(id))
  await normalizeOrder()
}

export async function deleteShots(ids: string[]): Promise<void> {
  await withStore<void>('readwrite', (st) => {
    ids.forEach((id) => st.delete(id))
  })
  await normalizeOrder()
}

/** 清空（UI 层需先确认） */
export async function clearShots(): Promise<void> {
  await withStore<void>('readwrite', (st) => st.clear())
}

/** 按传入的 id 顺序重写 order 0..n-1（拖拽排序后调用） */
export async function reorderShots(orderedIds: string[]): Promise<void> {
  const all = await listShots()
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  const reordered = all
    .filter((s) => rank.has(s.id))
    .concat(all.filter((s) => !rank.has(s.id)))
    .map((s, i) => ({ ...s, order: i }))
  await withStore<void>('readwrite', (st) => {
    reordered.forEach((s) => st.put(s))
  })
}

/** 重编辑后更新对应记录（不新建，不产生重复） */
export async function updateShot(
  id: string,
  patch: { blob?: Blob; baseBlob?: Blob; anns?: unknown[]; width?: number; height?: number }
): Promise<void> {
  const rec = await getShot(id)
  if (!rec) throw new Error('记录不存在:' + id)
  const next: ShotRecord = { ...rec, ...patch }
  await withStore<void>('readwrite', (st) => st.put(next))
}

/** 删除后收紧 order，保持 0..n-1 连续 */
async function normalizeOrder(): Promise<void> {
  const all = await listShots()
  const need = all.some((s, i) => s.order !== i)
  if (!need) return
  await withStore<void>('readwrite', (st) => {
    all.forEach((s, i) => st.put({ ...s, order: i }))
  })
}

/** Blob → data URL（Service Worker 中无 FileReader，用 arrayBuffer + btoa 分块转换） */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return 'data:image/png;base64,' + btoa(binary)
}
