/* ============================================================
 * qrcode.js —— 精简 QR 码生成器（零依赖）
 * byte 模式 / L 纠错 / 版本 1-4 自动 / 固定掩码 0
 * 用法：QRCode.render(text, canvas, { size: 220 })
 *      QRCode.toDataURL(text, { size: 480 }) → PNG dataURL
 * ============================================================ */
;(function () {
  /* GF(256) 运算 */
  const EXP = new Uint8Array(512)
  const LOG = new Uint8Array(256)
  ;(function () {
    let x = 1
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  })()
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0

  function rsGenPoly(n) {
    let poly = [1]
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0)
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j]
        next[j + 1] ^= mul(poly[j], EXP[i])
      }
      poly = next
    }
    return poly
  }
  function rsEncode(data, ecLen) {
    const gen = rsGenPoly(ecLen)
    const rem = new Array(ecLen).fill(0)
    for (const b of data) {
      const factor = b ^ rem[0]
      rem.shift(); rem.push(0)
      for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor)
    }
    return rem
  }

  /* L 纠错容量：[版本, 数据字节数, 纠错字节数] */
  const CAPS = [
    [1, 19, 7], [2, 34, 10], [3, 55, 15], [4, 65, 20],
  ]
  const ALIGN = { 1: 0, 2: 18, 3: 22, 4: 26 }   /* 对齐图案中心坐标 */

  function buildBits(text) {
    const bytes = []
    for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0))
    let ver = null
    for (const c of CAPS) { if (bytes.length <= c[1]) { ver = c[0]; break } }
    if (!ver) throw new Error('内容过长')
    const cap = CAPS[ver - 1]
    const bits = []
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
    push(0x4, 4)                     /* byte 模式 */
    push(bytes.length, 8)            /* 长度（v1-9 为 8 位） */
    for (const b of bytes) push(b, 8)
    const totalBits = cap[1] * 8
    push(0, Math.min(4, totalBits - bits.length))          /* 终止符 */
    while (bits.length % 8) bits.push(0)                   /* 字节对齐 */
    while (bits.length < totalBits) { push(0xec, 8); if (bits.length < totalBits) push(0x11, 8) }
    /* 打包成字节 */
    const dataBytes = []
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
      dataBytes.push(b)
    }
    return { ver, data: dataBytes.concat(rsEncode(dataBytes, cap[2])), size: ver * 4 + 17 }
  }

  function buildMatrix(text) {
    const { ver, data, size } = buildBits(text)
    /* 值语义：-1=功能区占用  0=可用白  1=功能黑  2/3=数据黑/白 */
    const m = []
    for (let y = 0; y < size; y++) { m.push(new Array(size).fill(0)) }
    const setFinder = (ox, oy) => {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const x = ox + dx, y = oy + dy
          if (x < 0 || x >= size || y < 0 || y >= size) continue
          const black = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
                        (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
                        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
          m[y][x] = black ? 1 : -1
        }
      }
    }
    setFinder(0, 0); setFinder(size - 7, 0); setFinder(0, size - 7)
    /* timing */
    for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0 ? 1 : -1; m[i][6] = i % 2 === 0 ? 1 : -1 }
    /* alignment */
    const ac = ALIGN[ver]
    if (ac) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        m[ac + dy][ac + dx] = (Math.abs(dx) === 2 || Math.abs(dy) === 2 || (dx === 0 && dy === 0)) ? 1 : -1
      }
    }
    /* format 区预留（稍后填） */
    for (let i = 0; i < 9; i++) { if (i !== 6) { m[8][i] = -1; m[i][8] = -1 } }
    for (let i = 0; i < 8; i++) { m[8][size - 1 - i] = -1; m[size - 1 - i][8] = -1 }
    m[size - 8][8] = 1   /* dark module */
    /* 数据位流 → zigzag 放置 */
    const bits = []
    for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
    let bi = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let c = 0; c < 2; c++) {
          const x = right - c
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (m[y][x] === 0 && bi < bits.length) { m[y][x] = bits[bi++] ? 2 : 3 }
        }
      }
    }
    /* 掩码 0：(x+y)%2==0 处翻转数据位 */
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (m[y][x] === 2 || m[y][x] === 3) {
        if ((x + y) % 2 === 0) m[y][x] = m[y][x] === 2 ? 3 : 2
      }
    }
    /* format info：L 纠错(01) + 掩码 0(000)，BCH(15,5) 逐位移位归约 */
    let d = 0b01000
    for (let i = 0; i < 10; i++) { d <<= 1; if (d & 0x400) d ^= 0x537 }
    const fmt = ((0b01000 << 10) | (d & 0x3ff)) ^ 0x5412
    for (let i = 0; i < 15; i++) {
      const mod = (fmt >> i) & 1
      if (i < 6) m[i][8] = mod
      else if (i < 8) m[i + 1][8] = mod
      else m[size - 15 + i][8] = mod
    }
    for (let i = 0; i < 15; i++) {
      const mod = (fmt >> i) & 1
      if (i < 8) m[8][size - 1 - i] = mod
      else if (i < 9) m[8][15 - i] = mod
      else m[8][14 - i] = mod
    }
    m[size - 8][8] = 1
    /* 输出前把 -1 还原为白 */
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x] === -1) m[y][x] = 0
    return { matrix: m, size }
  }

  function drawTo(text, canvas, size) {
    const { matrix, size: n } = buildMatrix(text)
    const quiet = 4
    const scale = Math.floor(size / (n + quiet * 2)) || 1
    const dim = (n + quiet * 2) * scale
    canvas.width = dim; canvas.height = dim
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim)
    ctx.fillStyle = '#000000'
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (matrix[y][x] === 1 || matrix[y][x] === 2) {
        ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
      }
    }
    return dim
  }

  window.QRCode = {
    matrix(text) { return buildMatrix(text) },
    render(text, canvas, size) { return drawTo(text, canvas, size || 220) },
    toDataURL(text, size) {
      const cv = document.createElement('canvas')
      drawTo(text, cv, size || 480)
      return cv.toDataURL('image/png')
    },
  }
})()
