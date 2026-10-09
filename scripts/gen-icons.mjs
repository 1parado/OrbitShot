// Generate OrbitShot icons: gradient circle + white ring dots + center dot
import zlib from 'zlib'
import fs from 'fs'

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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const R = size / 2 - Math.max(0.5, size * 0.02) // outer radius with tiny padding
  const ringR = size * 0.34
  const dotR = Math.max(1.2, size * 0.075)
  const coreR = size * 0.1

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const d = Math.hypot(px - cx, py - cy)
      // coverage of the big circle
      const cov = 1 - smoothstep(R - 1, R + 1, d)
      if (cov <= 0) continue
      // diagonal gradient #0ea5e9 -> #6366f1
      const t = (px + py) / (2 * size)
      const r = Math.round(14 + (99 - 14) * t)
      const g = Math.round(165 + (102 - 165) * t)
      const b = Math.round(233 + (241 - 233) * t)
      let cr = r, cg = g, cb = b
      // white dots: 6 around ring + center
      let white = 0
      const dCore = d
      white = Math.max(white, 1 - smoothstep(coreR - 1, coreR + 1, dCore))
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI * 2 * i) / 6 - Math.PI / 2
        const dxp = px - (cx + ringR * Math.cos(ang))
        const dyp = py - (cy + ringR * Math.sin(ang))
        white = Math.max(white, 1 - smoothstep(dotR - 1, dotR + 1, Math.hypot(dxp, dyp)))
      }
      cr = Math.round(cr + (255 - cr) * white)
      cg = Math.round(cg + (255 - cg) * white)
      cb = Math.round(cb + (255 - cb) * white)
      const idx = (y * size + x) * 4
      rgba[idx] = cr
      rgba[idx + 1] = cg
      rgba[idx + 2] = cb
      rgba[idx + 3] = Math.round(255 * cov)
    }
  }
  return encodePng(size, size, rgba)
}

fs.mkdirSync('public/icons', { recursive: true })
for (const s of [16, 48, 128]) {
  fs.writeFileSync(`public/icons/icon-${s}.png`, drawIcon(s))
  console.log(`icon-${s}.png written (${fs.statSync(`public/icons/icon-${s}.png`).size} bytes)`)
}
