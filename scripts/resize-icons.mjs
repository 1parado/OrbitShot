// 从 icon-src.png 生成 16/48/128 三档扩展图标（纯 Node PNG 编解码 + 盒式滤波缩放）
// 用法：node scripts/resize-icons.mjs
import zlib from 'zlib'
import fs from 'fs'

// ---- 最小 PNG 解码（8-bit RGB/RGBA） ----
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png')
  let pos = 8
  let w = 0
  let h = 0
  let bitDepth
  let colorType
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.slice(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error('unsupported png: depth=' + bitDepth + ' color=' + colorType)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = w * bpp
  const out = Buffer.alloc(w * h * 4)
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = (a + b - c) | 0
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      cur[x] = v
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp]
      out[(y * w + x) * 4 + 1] = cur[x * bpp + 1]
      out[(y * w + x) * 4 + 2] = cur[x * bpp + 2]
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    prev.set(cur)
  }
  return { w, h, data: out }
}

// ---- PNG 编码（与 gen-icons.mjs 相同实现） ----
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- 盒式滤波缩放（缩小时按源区域平均，质量优于最近邻） ----
function resize(img, size) {
  const { w, h, data } = img
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx0 = (x * w) / size
      const sx1 = ((x + 1) * w) / size
      const sy0 = (y * h) / size
      const sy1 = ((y + 1) * h) / size
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = Math.floor(sy0); sy < Math.min(h, Math.ceil(sy1)); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.min(w, Math.ceil(sx1)); sx++) {
          const i = (sy * w + sx) * 4
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          a += data[i + 3]
          n++
        }
      }
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

const SRC = 'public/icons/icon-src.png'
const src = decodePNG(fs.readFileSync(SRC))
console.log(`source: ${src.w}x${src.h}`)
for (const s of [16, 48, 128]) {
  const px = resize(src, s)
  fs.writeFileSync(`public/icons/icon-${s}.png`, encodePng(s, s, px))
  console.log(`icon-${s}.png written (${fs.statSync(`public/icons/icon-${s}.png`).size} bytes)`)
}
