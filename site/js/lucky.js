/* ---------- 抽奖：转盘 / 刮刮卡 / 抽签 ---------- */
const LUCKY_THEMES = [
  { key: 'eat', name: '今天吃什么', items: ['火锅', '烧烤', '螺蛳粉', '盖饭', '拉面', '麻辣烫', '日料', '汉堡', '家常菜', '随便'] },
  { key: 'drink', name: '今天喝什么', items: ['奶茶', '咖啡', '柠檬水', '可乐', '白开水', '果茶', '气泡水', '豆浆'] },
  { key: 'play', name: '周末去哪玩', items: ['公园', '看电影', '逛街', '打球', '爬山', '博物馆', '宅家', '周边游'] },
  { key: 'pay', name: '谁请客', items: ['你请', '我请', 'AA', '石头剪刀布', '下次再定'] },
  { key: 'sport', name: '做什么运动', items: ['跑步', '游泳', '健身', '瑜伽', '骑行', '跳绳', '散步', '羽毛球'] },
  { key: 'movie', name: '看什么电影', items: ['喜剧', '动作', '科幻', '爱情', '悬疑', '动画', '纪录片', '恐怖'] },
  { key: 'song', name: '听什么歌', items: ['流行', '民谣', '摇滚', '说唱', '古典', '电子', '爵士', '老歌'] },
  { key: 'sleep', name: '今晚几点睡', items: ['十点', '十一点', '十二点', '一点', '两点', '通宵'] },
  { key: 'work', name: '抽谁干活', items: ['你来', '我来', '大家一起', '老板来', '明天再说'] },
  { key: 'fortune', name: '今日运势', items: ['吉', '平', '凶'] },
]

const LUCKY = { theme: 'eat', mode: 'wheel', items: [], result: '' }

function luckyTheme(key) {
  return LUCKY_THEMES.find(t => t.key === key) || LUCKY_THEMES[0]
}
function luckyItems(themeKey) {
  try {
    const custom = JSON.parse(localStorage.getItem('kbchat_lucky_' + themeKey) || 'null')
    if (custom && custom.length >= 2) return custom
  } catch (e) {}
  return luckyTheme(themeKey).items.slice()
}

function renderLuckyPanel() {
  clearLuckyTimers()
  const theme = luckyTheme(LUCKY.theme)
  LUCKY.items = luckyItems(theme.key)
  /* 主题选择：抽签为固定三项，主题条没有意义，隐藏 */
  const themeBox = el('luckyThemes')
  themeBox.hidden = LUCKY.mode === 'draw'
  themeBox.innerHTML = LUCKY_THEMES.map(t =>
    `<button type="button" class="lt${t.key === LUCKY.theme ? ' is-on' : ''}" data-t="${t.key}">${t.name}</button>`).join('')
  el('luckyThemes').querySelectorAll('.lt').forEach(b => {
    b.onclick = () => { LUCKY.theme = b.dataset.t; renderLuckyPanel() }
  })
  /* 模式 */
  el('luckyModes').querySelectorAll('.lm').forEach(b => {
    b.classList.toggle('is-on', b.dataset.m === LUCKY.mode)
  })
  /* 自定义条目（抽签模式固定吉/平/凶） */
  const box = el('luckyItems')
  if (LUCKY.mode === 'draw') {
    box.innerHTML = '<p class="muted">抽签为固定三项：吉 / 平 / 凶，结果完全随机，内容仅供参考。</p>'
  } else {
    box.innerHTML = `<div class="li-row">
      <input id="luckyNew" maxlength="12" placeholder="添加自定义选项">
      <button class="btn-code" id="luckyAdd">添加</button>
      <button class="btn-code" id="luckyReset">恢复默认</button>
    </div><div class="li-list">${LUCKY.items.map((x, i) =>
      `<span class="li-item">${esc(x)}<b data-i="${i}">×</b></span>`).join('')}</div>`
    el('luckyAdd').onclick = () => {
      const v = el('luckyNew').value.trim()
      if (!v) return
      LUCKY.items.push(v)
      localStorage.setItem('kbchat_lucky_' + LUCKY.theme, JSON.stringify(LUCKY.items))
      renderLuckyPanel()
    }
    el('luckyReset').onclick = () => {
      localStorage.removeItem('kbchat_lucky_' + LUCKY.theme)
      renderLuckyPanel()
    }
    box.querySelectorAll('.li-item b').forEach(b => {
      b.onclick = () => {
        LUCKY.items.splice(+b.dataset.i, 1)
        localStorage.setItem('kbchat_lucky_' + LUCKY.theme, JSON.stringify(LUCKY.items))
        renderLuckyPanel()
      }
    })
  }
  el('luckyResult').innerHTML = '<p class="muted">选择主题与模式后开始</p>'
}

async function openLucky() {
  showView('lucky')
  el('luckyModes').querySelectorAll('.lm').forEach(b => {
    b.onclick = () => { LUCKY.mode = b.dataset.m; renderLuckyPanel() }
  })
  el('btnLuckyGo').onclick = runLucky
  el('btnLuckySend').onclick = sendLuckyResult
  renderLuckyPanel()
  /* CMO 限时抽奖 */
  const admin = !!(S.profile && S.profile.isAdmin)
  el('btnLuckyAdmin').hidden = !admin
  if (admin) el('btnLuckyAdmin').onclick = openLuckyAdmin
  await loadLuckyLimited()
}

async function loadLuckyLimited() {
  const box = el('luckyLimited')
  try {
    const r = await Net.lotteryList()
    const l = r.lottery
    if (!l) { box.innerHTML = '<p class="muted">当前没有限时抽奖活动</p>'; return }
    box.innerHTML = `<div class="lk-limited">
      <div><b>🎉 ${esc(l.title)}</b>｜奖品：${esc(l.prize)}</div>
      <div class="muted">截止：${esc(fmtFull(l.until))}</div>
      <button class="btn-code" id="btnLuckyDraw"${l.drawn ? ' disabled' : ''}>${l.drawn ? '已参与' : '立即参与'}</button>
    </div>`
    const btn = el('btnLuckyDraw')
    if (btn && !l.drawn) {
      btn.onclick = async () => {
        try {
          const d = await Net.lotteryDraw(l.id)
          if (d.win) luckyConfetti()
          toast(d.win ? '🎉 恭喜中奖：' + d.prize : '很遗憾，这次没中', 3200)
          await loadLuckyLimited()
        } catch (e) { toast(e.message || '参与失败') }
      }
    }
  } catch (e) { box.innerHTML = '<p class="muted">限时抽奖加载失败</p>' }
}

function runLucky() {
  if (LUCKY.mode === 'draw') return runDraw()
  if (LUCKY.mode === 'scratch') return runScratch()
  return runWheel()
}

function finishLucky(text) {
  LUCKY.result = text
  clearLuckyTimers()
  /* 抽签没有主题，结果标签里不显示主题名 */
  const isDraw = LUCKY.mode === 'draw'
  el('luckyResult').innerHTML = `<div class="lk-result">
    <div class="lk-value">${esc(text)}</div>
    <div class="lk-label">${isDraw ? '' : esc(luckyTheme(LUCKY.theme).name) + ' · '}点击「开始」再抽一次</div></div>`
  el('btnLuckySend').hidden = false
}

/* 动画定时器统一管理：换主题 / 换模式 / 重新开始时全部作废，
 * 避免转盘的延迟回调把已经切走的刮刮卡覆盖成旧结果 */
const LUCKY_TIMERS = []
function luckyLater(fn, ms) { LUCKY_TIMERS.push(setTimeout(fn, ms)) }
function clearLuckyTimers() { LUCKY_TIMERS.forEach(clearTimeout); LUCKY_TIMERS.length = 0 }

/* 转盘：旋转动画 + 礼炮 */
function runWheel() {
  clearLuckyTimers()
  const items = LUCKY.items.slice()
  if (items.length < 2) return toast('至少要有 2 个选项')
  const pick = Math.floor(Math.random() * items.length)
  const seg = 360 / items.length
  /* 项 i 的初始角度是 i*seg（0 = 正顶部，顺时针排布），指针固定在顶部；
   * 让 pick 停到指针下：旋转 -pick*seg（加整圈增强滚动感）。之前的 -seg/2 会让指针落在扇区边缘 */
  const target = 360 * 5 + (360 - pick * seg)
  el('luckyResult').innerHTML = `<div class="lk-stage">
    <div class="lk-wheel" id="lkWheel">${items.map((x, i) =>
      `<span class="lk-seg" style="transform:rotate(${i * seg}deg) translate(0,-46px)">${esc(x)}</span>`).join('')}</div>
    <div class="lk-pointer">▼</div></div><p class="muted">转动中…</p>`
  const w = el('lkWheel')
  requestAnimationFrame(() => { w.style.transform = 'rotate(' + target + 'deg)' })
  luckyLater(() => {
    luckyConfetti()
    finishLucky(items[pick])
  }, 3200)
}

/* 刮刮卡：canvas 刮层，按「刮开的面积」判定，刮够 55% 才揭晓 */
let lkScratch = null
let lkDocUp = null   /* document 级 mouseup 监听：重开/揭晓时必须移除，否则越积越多 */
function runScratch() {
  clearLuckyTimers()
  if (lkDocUp) { document.removeEventListener('mouseup', lkDocUp); lkDocUp = null }
  const items = LUCKY.items.slice()
  if (items.length < 2) return toast('至少要有 2 个选项')
  const pick = items[Math.floor(Math.random() * items.length)]
  el('luckyResult').innerHTML = `<div class="lk-stage">
    <div class="lk-card"><div class="lk-value">${esc(pick)}</div>
    <canvas id="lkCanvas" width="260" height="120"></canvas></div></div>
    <p class="muted">按住鼠标刮开涂层，刮开大半即可揭晓</p>`
  const cv = el('lkCanvas')
  const ctx = cv.getContext && cv.getContext('2d')
  if (!ctx) {
    /* 极少数环境没有 canvas 2d：退回直接揭晓，避免卡死 */
    luckyConfetti()
    return finishLucky(pick)
  }
  ctx.fillStyle = '#b9b9b9'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.font = '15px sans-serif'
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.fillText('刮开看看', cv.width / 2, cv.height / 2 + 5)
  ctx.textAlign = 'start'
  ctx.globalCompositeOperation = 'destination-out'
  lkScratch = { cv, ctx, pick, down: false, done: false, dirty: false }
  const st = lkScratch
  const move = e => {
    if (!st.down || st.done) return
    const r = st.cv.getBoundingClientRect()
    const x = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - r.left
    const y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) - r.top
    st.ctx.beginPath(); st.ctx.arc(x, y, 20, 0, Math.PI * 2); st.ctx.fill()
    st.dirty = true
  }
  /* 每松手检查一次刮开面积，够 55% 才揭晓；轻轻碰一下不会误触发 */
  const check = () => {
    if (!st.dirty || st.done) return
    st.dirty = false
    const img = st.ctx.getImageData(0, 0, st.cv.width, st.cv.height).data
    let clear = 0, total = 0
    for (let i = 3; i < img.length; i += 4 * 16) { total++; if (img[i] === 0) clear++ }
    if (total && clear / total >= 0.55) {
      st.done = true
      st.cv.style.transition = 'opacity .5s'
      st.cv.style.opacity = '0'
      luckyConfetti()
      finishLucky(st.pick)
    }
  }
  const up = () => { st.down = false; check() }
  lkDocUp = up
  document.addEventListener('mouseup', up)
  cv.onmousedown = () => { st.down = true }
  cv.onmousemove = move
  cv.onmouseleave = up
  cv.ontouchstart = () => { st.down = true }
  cv.ontouchmove = e => { move(e); check() }
  cv.ontouchend = up
}

/* 抽签：吉 / 平 / 凶 */
function runDraw() {
  clearLuckyTimers()
  const items = ['吉', '平', '凶']
  const tip = { 吉: '大吉大利，诸事顺遂', 平: '平平淡淡，安稳是福', 凶: '小心谨慎，宜静不宜动' }
  el('luckyResult').innerHTML = `<div class="lk-stage">
    <div class="lk-tube" id="lkTube">🎋</div></div><p class="muted">抽签中…</p>`
  const tube = el('lkTube')
  tube.classList.add('is-shake')
  luckyLater(() => {
    const pick = items[Math.floor(Math.random() * items.length)]
    el('luckyResult').innerHTML = `<div class="lk-stage">
      <div class="lk-slip lk-${pick === '吉' ? 'good' : pick === '凶' ? 'bad' : 'mid'}">${pick}</div></div>
      <p class="muted">${tip[pick]}</p>`
    luckyConfetti()
    finishLucky(pick)
  }, 1500)
}

/* 礼炮彩带 */
function luckyConfetti() {
  const box = document.createElement('div')
  box.className = 'lk-confetti'
  document.body.appendChild(box)
  const colors = ['#e53935', '#43a047', '#1e88e5', '#fdd835', '#8e24aa', '#fb8c00']
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('i')
    p.style.left = Math.random() * 100 + '%'
    p.style.background = colors[i % colors.length]
    p.style.animationDelay = (Math.random() * 0.5) + 's'
    p.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)'
    box.appendChild(p)
  }
  setTimeout(() => box.remove(), 2600)
}

/* 发到群里 */
async function sendLuckyResult() {
  if (!LUCKY.result) return toast('先抽一次吧')
  const groups = S.groups || []
  if (!groups.length) return toast('你还没有群聊，无法发送')
  const pick = prompt('输入要发送到的群序号：\n' + groups.map((g, i) => (i + 1) + '. ' + g.name).join('\n'), '1')
  if (!pick) return
  const g = groups[Number(pick) - 1]
  if (!g) return toast('序号无效')
  try {
    await Net.send(g.roomId, 'text',
      '🎲【' + luckyTheme(LUCKY.theme).name + '】我抽中了：' + LUCKY.result + '（结果仅供参考）')
    toast('已发送到群聊：' + g.name)
  } catch (e) { toast(e.message || '发送失败') }
}

/* CMO：发布限时抽奖 */
function openLuckyAdmin() {
  el('laTitle').value = ''
  el('laPrize').value = ''
  el('laRate').value = '30'
  el('laHours').value = '24'
  el('btnLaOk').onclick = async () => {
    try {
      await Net.lotteryCreate({
        title: el('laTitle').value.trim(),
        prize: el('laPrize').value.trim(),
        rate: Number(el('laRate').value),
        hours: Number(el('laHours').value),
      })
      closeModal()
      toast('限时抽奖已发布')
      openLucky()
    } catch (e) { el('laErr').textContent = e.message || '发布失败' }
  }
  el('btnLaCancel').onclick = closeModal
  openModal('modalLuckyAdmin')
}
