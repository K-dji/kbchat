/* ===========================================================
 * social.js —— 朋友圈 / 靠北帖 / 违禁词管理 / 新手指引
 * 依赖 app.js 里的全局：S、Net、el、esc、toast、openModal、closeModal、
 * avatarHtml、fmtFull、fmtTime、showView、isAdmin 状态
 * =========================================================== */

/* ---------------- 公共小工具 ---------------- */
function kbAdminUid() {
  const f = (S.friends || []).find(x => x.wxid === 'kaobei')
  return (f && f.uid) || S.__adminUid || ''
}
function relTime(iso) {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const d = Date.now() - t
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前'
  return fmtFull(iso)
}
function mediaHtml(kind, media) {
  return (media || []).map(u => {
    if (kind === 'video') return `<video class="mm-media" src="${esc(u)}" controls preload="metadata"></video>`
    if (kind === 'voice') return `<audio class="mm-audio" src="${esc(u)}" controls preload="metadata"></audio>`
    return `<img class="mm-media" src="${esc(u)}" alt="">`
  }).join('')
}
function visLabel(m) {
  if (m.visibility === 'all') return '所有人可见'
  if (m.visibility === 'custom') return '指定用户可见（' + ((m.targets || []).length) + ' 人）'
  return '好友可见'
}

/* ===========================================================
 * 朋友圈
 * =========================================================== */
async function showMomentsView() {
  showView('moments')
  if (el('momentDot')) el('momentDot').hidden = true
  await loadMoments()
  loadWeather()
  document.querySelectorAll('#momentTabs .atab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#momentTabs .atab').forEach(x => x.classList.remove('is-on'))
      b.classList.add('is-on')
      S.momentTab = b.dataset.t
      renderMoments()
    }
  })
  el('btnMomentCreate').onclick = () => openMomentForm(null)
}

async function loadMoments() {
  const box = el('momentList')
  try {
    const r = await Net.moments()
    S.moments = r.list || []
    S.__adminUid = r.adminUid || S.__adminUid
    if (r.pendingReports && S.profile && S.profile.isAdmin) {
      toast('有 ' + r.pendingReports + ' 条朋友圈举报待审核', 3200)
    }
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  renderMoments()
}

/* ---------- 天气卡片（Open-Meteo，服务端代理，无需 Key）
 * 支持多个容器：朋友圈（weatherCard）+ 更多页（weatherCardMore） ---------- */
let wxActiveContainer = 'weatherCard'
function weatherAskHtml(err) {
  return '<div class="wx-now wx-ask">' +
      '<span class="wx-icon">🌤️</span>' +
      '<span class="wx-temp">天气</span>' +
      '<button type="button" class="btn-code" id="wxSetCity">📍 选择城市</button>' +
    '</div>' +
    (err ? '<div class="muted wx-err">' + esc(err) + '</div>' : '')
}
function bindWeatherAsk() {
  const b = document.getElementById('wxSetCity')
  if (b) b.onclick = changeWeatherCity
}
async function loadWeather(targetId) {
  const cid = targetId || 'weatherCard'
  wxActiveContainer = cid
  const card = el(cid)
  if (!card) return
  card.hidden = false
  const savedCity = localStorage.getItem('kb_wx_city')
  if (savedCity) {
    try { renderWeather(await Net.weather({ city: savedCity }), cid); return } catch (e) { /* 落到定位/手选 */ }
  }
  /* 没有保存城市：静默试一次浏览器定位（拒绝或超时则让用户手选） */
  let pos = null
  try {
    pos = await new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geo'))
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3500, maximumAge: 600000 })
    })
  } catch (e) { pos = null }
  if (pos) {
    try {
      renderWeather(await Net.weather({ lat: pos.coords.latitude, lon: pos.coords.longitude }), cid)
      return
    } catch (e) { /* 落到手选 */ }
  }
  /* 容器 race 防护：异步期间用户可能切走，只有当前激活容器才渲染 */
  if (wxActiveContainer !== cid) return
  card.innerHTML = weatherAskHtml()
  bindWeatherAsk()
}
function renderWeather(r, targetId) {
  try { localStorage.setItem('kb_wx_city', r.city) } catch (e) {}
  const c = r.current || {}
  const card = el(targetId || wxActiveContainer)
  if (!card) return
  card.innerHTML =
    '<div class="wx-now">' +
      '<span class="wx-icon">' + (c.icon || '🌤️') + '</span>' +
      '<span class="wx-temp">' + (c.temp != null ? c.temp + '°' : '—') + '</span>' +
      '<span class="wx-main">' + esc(c.text || '—') + '</span>' +
      '<button type="button" class="wx-city" id="wxCityBtn" title="切换城市">📍 ' + esc(r.city || '未知') + ' ▾</button>' +
    '</div>' +
    '<div class="wx-sub">湿度 ' + (c.humidity != null ? c.humidity + '%' : '—') + ' · 风速 ' + (c.wind != null ? c.wind + 'km/h' : '—') + '</div>' +
    '<div class="wx-days">' + (r.daily || []).map(d =>
      '<span class="wx-day"><b>' + esc(d.label) + '</b>' + (d.icon || '') + ' ' + esc(d.text) + ' ' + d.min + '~' + d.max + '°</span>'
    ).join('') + '</div>'
  const btn = document.getElementById('wxCityBtn')
  if (btn) btn.onclick = changeWeatherCity
}
async function changeWeatherCity() {
  const cur = localStorage.getItem('kb_wx_city') || ''
  const raw = prompt('输入城市名（支持国内及全球主要城市），如：广州', cur)
  if (raw == null) return
  const city = raw.trim()
  if (!city) return
  const card = el(wxActiveContainer)
  card.innerHTML = '<p class="muted wx-loading">🌤️ 正在查询「' + esc(city) + '」…</p>'
  try { renderWeather(await Net.weather({ city }), wxActiveContainer) }
  catch (e) { card.innerHTML = weatherAskHtml('查询失败：' + (e.message || '')); bindWeatherAsk() }
}

function momentCardHtml(m) {
  const canManage = m.mine || (S.profile && S.profile.isAdmin)
  const comments = (m.comments || []).map(c => `
    <div class="mm-comment" data-cid="${esc(c.id)}">
      <b>${esc(c.name)}</b>：<span>${esc(c.text)}</span>
      <button class="mm-mini" data-mact="reportComment" data-id="${esc(m.id)}" data-cid="${esc(c.id)}" data-name="${esc(c.name)}">举报</button>
    </div>`).join('')
  return `<article class="mm-card" data-id="${esc(m.id)}">
    <header class="mm-head">
      <div class="mm-av">${avatarHtml(m.avatar)}</div>
      <div class="mm-meta">
        <div class="mm-name">${esc(m.nickname)} <span class="mm-wxid">@${esc(m.wxid || '')}</span></div>
        <div class="mm-sub">${esc(relTime(m.at))} · ${esc(visLabel(m))}${m.editedAt ? ' · 已编辑' : ''}</div>
      </div>
      ${canManage ? `<button class="mm-more" data-mact="menu" data-id="${esc(m.id)}" title="管理">⋯</button>` : ''}
    </header>
    ${m.text ? `<div class="mm-text">${esc(m.text)}</div>` : ''}
    ${mediaHtml(m.kind, m.media)}
    ${m.loc ? `<button type="button" class="mm-loc" data-mact="viewLoc" data-id="${esc(m.id)}" title="查看地图">📍 ${esc(m.loc.name || '位置')}${m.loc.addr ? ' · ' + esc(m.loc.addr) : ''}</button>` : ''}
    <div class="mm-actions">
      <button class="mm-act${m.liked ? ' is-on' : ''}" data-mact="like" data-id="${esc(m.id)}">👍 ${m.likes || ''}</button>
      <button class="mm-act" data-mact="comment" data-id="${esc(m.id)}">💬 评论</button>
      <button class="mm-act${isFav('moment', m.id) ? ' is-on' : ''}" data-mact="fav" data-id="${esc(m.id)}"
        data-favstar="moment:${esc(m.id)}" data-favtext-off="☆ 收藏" data-favtext-on="⭐ 已收藏">${isFav('moment', m.id) ? '⭐ 已收藏' : '☆ 收藏'}</button>
      <button class="mm-act" data-mact="report" data-id="${esc(m.id)}" data-name="${esc(m.nickname)}">举报</button>
    </div>
    ${comments ? `<div class="mm-comments">${comments}</div>` : ''}
    <div class="mm-comment-form" hidden>
      <input maxlength="200" placeholder="写下你的评论…">
      <button class="btn-code" data-mact="sendComment" data-id="${esc(m.id)}">发送</button>
    </div>
  </article>`
}

function renderMoments() {
  const box = el('momentList')
  const tab = S.momentTab || 'all'
  let list = S.moments || []
  if (tab === 'mine') list = list.filter(m => m.mine)
  if (!list.length) {
    box.innerHTML = `<p class="muted">${tab === 'mine' ? '你还没有发布动态' : '还没有人发朋友圈，点右上角 ＋ 发一条'}</p>`
    return
  }
  box.innerHTML = list.map(momentCardHtml).join('')
}

function bindMomentList() {
  const box = el('momentList')
  box.onclick = async e => {
    const btn = e.target.closest('[data-mact]')
    if (!btn) return
    const act = btn.dataset.mact
    const id = btn.dataset.id
    const m = (S.moments || []).find(x => x.id === id)
    if (act === 'like') {
      try {
        const r = await Net.momentLike(id)
        if (m) { m.liked = r.liked; m.likes = r.likes }
        renderMoments()
      } catch (err) { toast(err.message || '操作失败') }
      return
    }
    if (act === 'comment') {
      const form = btn.closest('.mm-card').querySelector('.mm-comment-form')
      form.hidden = !form.hidden
      if (!form.hidden) form.querySelector('input').focus()
      return
    }
    if (act === 'sendComment') {
      const form = btn.closest('.mm-comment-form')
      const input = form.querySelector('input')
      const text = input.value.trim()
      if (!text) return
      try {
        await Net.momentComment(id, text)
        input.value = ''
        await loadMoments()
      } catch (err) { toast(err.message || '评论失败') }
      return
    }
    if (act === 'del') {
      if (!confirm('删除这条帖子？删除后无法恢复。')) return
      try { await Net.forumPostDel((S.forum || {}).activeId || '', id); toast('帖子已删除'); await loadForum() }
      catch (err) { toast(err.message || '删除失败') }
      return
    }
    if (act === 'fav') {
      if (!m) return
      await collectFavorite({
        kind: 'moment', ref: id,
        title: (m.text || '').slice(0, 40) || '朋友圈动态',
        text: m.text || '', media: m.media || [],
        from: m.uid, fromName: m.nickname,
      })
      return
    }
    if (act === 'viewLoc') {
      if (m && m.loc) openLocationView(m.loc, (m.nickname || '') + ' 的位置')
      return
    }
    if (act === 'report' || act === 'reportComment') {
      openMomentReport(id, act === 'reportComment' ? btn.dataset.cid : '', btn.dataset.name || (m && m.nickname) || '')
      return
    }
    if (act === 'menu') {
      if (!m) return
      const isMine = m.mine
      const tip = isMine ? '输入数字：1=编辑 2=删除 3=取消' : '输入数字：1=删除该动态 2=取消'
      const pick = window.prompt(tip, '3')
      if (isMine && pick === '1') return openMomentForm(m)
      if ((isMine && pick === '2') || (!isMine && pick === '1')) {
        if (!confirm('确定删除这条动态？')) return
        try { await Net.momentDel(id); toast('已删除'); await loadMoments() } catch (err) { toast(err.message || '删除失败') }
      }
    }
  }
  /* 图片点击放大 */
  box.onclick = (function (prev) {
    return function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('mm-media')) {
        window.open(e.target.src, '_blank')
        return
      }
      return prev.call(this, e)
    }
  })(box.onclick)
}

/* ---------- 发布 / 编辑 ---------- */
let momentEditing = null
let momentMediaList = []
let momentKind = 'text'
let momentLoc = null

function renderMomentLoc() {
  const box = el('momentLocBox')
  if (!box) return
  if (!momentLoc) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.innerHTML = `<span class="mm-loc-chip">📍 ${esc(momentLoc.name || '已选位置')}
    <button type="button" class="loc-clear" id="btnMomentLocClear" title="去掉位置">×</button></span>`
  el('btnMomentLocClear').onclick = () => { momentLoc = null; renderMomentLoc() }
}

async function openMomentForm(m) {
  momentEditing = m || null
  momentMediaList = m ? (m.media || []).slice() : []
  momentKind = m ? (m.kind || 'text') : 'text'
  momentLoc = m ? (m.loc || null) : null
  el('momentFormTitle').textContent = m ? '编辑动态' : '发布动态'
  el('momentText').value = m ? (m.text || '') : ''
  el('momentVis').value = m ? (m.visibility || 'friends') : 'friends'
  el('momentErr').textContent = ''
  el('btnMomentSubmit').textContent = m ? '保存修改' : '发布'
  el('momentEmojiBox').hidden = true
  renderMomentMedia()
  renderMomentLoc()
  renderMomentTargets()
  el('momentTargetBox').hidden = el('momentVis').value !== 'custom'

  el('momentVis').onchange = () => {
    el('momentTargetBox').hidden = el('momentVis').value !== 'custom'
  }
  el('btnMomentLoc').onclick = () => {
    /* 选完或取消都要回到发布框，别把写了一半的动态弄丢 */
    openLocationPicker(loc => { momentLoc = loc; renderMomentLoc() }, 'modalMomentForm')
  }
  el('btnMomentCancel').onclick = closeModal
  el('btnMomentImg').onclick = () => el('momentFilePicker').click()
  el('btnMomentVideo').onclick = () => el('momentVideoPicker').click()
  el('btnMomentVoice').onclick = () => el('momentVoicePicker').click()
  el('btnMomentEmoji').onclick = () => {
    const box = el('momentEmojiBox')
    box.hidden = !box.hidden
    if (!box.hidden) renderEmojiPick(box)
  }
  el('momentFilePicker').onchange = () => pickMomentFile(el('momentFilePicker'), 'image')
  el('momentVideoPicker').onchange = () => pickMomentFile(el('momentVideoPicker'), 'video')
  el('momentVoicePicker').onchange = () => pickMomentFile(el('momentVoicePicker'), 'voice')
  el('btnMomentSubmit').onclick = submitMoment
  el('momentTargetList').onclick = e => {
    const row = e.target.closest('.target-row')
    if (!row || row.dataset.locked === '1') return
    const cb = row.querySelector('input')
    cb.checked = !cb.checked
    row.classList.toggle('is-on', cb.checked)
  }
  openModal('modalMomentForm')
}

function renderEmojiPick(box) {
  const emojis = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😜', '🤪', '😎', '🤔', '😴',
    '😭', '😡', '🥳', '😇', '🙃', '😱', '🤗', '🤫', '👍', '👎', '👏', '🙏', '💪', '✌️',
    '🎉', '❤️', '💔', '🔥', '🌹', '🍀', '⭐', '🌙', '☀️', '🍜', '🍺', '☕', '🧋', '🎂']
  box.innerHTML = emojis.map(x => `<button type="button" class="emo-cell">${x}</button>`).join('')
  box.onclick = e => {
    if (!e.target.classList.contains('emo-cell')) return
    const ta = el('momentText')
    ta.value += e.target.textContent
    ta.focus()
    momentKind = momentKind === 'text' ? 'emoji' : momentKind
  }
}

function renderMomentMedia() {
  const box = el('momentMediaBox')
  if (!momentMediaList.length) { box.innerHTML = ''; return }
  box.innerHTML = momentMediaList.map((u, i) => `
    <div class="mm-thumb">
      ${momentKind === 'video' ? `<video src="${esc(u)}" muted></video>`
        : momentKind === 'voice' ? `<span class="mm-voice">🎙️ 语音 ${i + 1}</span>`
        : `<img src="${esc(u)}" alt="">`}
      <button type="button" class="mm-del" data-i="${i}">×</button>
    </div>`).join('')
  box.onclick = e => {
    const b = e.target.closest('.mm-del')
    if (!b) return
    momentMediaList.splice(Number(b.dataset.i), 1)
    renderMomentMedia()
  }
}

async function pickMomentFile(input, kind) {
  const f = input.files && input.files[0]
  input.value = ''
  if (!f) return
  const maxMb = kind === 'image' ? 6 : kind === 'voice' ? 12 : 30
  if (f.size > maxMb * 1024 * 1024) { el('momentErr').textContent = '文件不能超过 ' + maxMb + 'MB'; return }
  el('momentErr').textContent = '上传中…'
  try {
    const url = await Net.uploadFile(f)
    if (kind !== 'image' || momentKind === 'text' || momentKind === 'emoji') momentKind = kind
    momentMediaList.push(url)
    if (momentMediaList.length > 9) momentMediaList = momentMediaList.slice(-9)
    el('momentErr').textContent = ''
    renderMomentMedia()
  } catch (e) {
    el('momentErr').textContent = e.message || '上传失败'
  }
}

function renderMomentTargets() {
  const box = el('momentTargetList')
  const auid = kbAdminUid()
  const adminRow = `<div class="target-row is-on" data-uid="${esc(auid)}" data-locked="1">
      <input type="checkbox" checked disabled>
      <span>👑 至高账号（CMO）</span><i class="muted">用于违禁词审核，不可取消</i>
    </div>`
  const rows = (S.friends || []).filter(f => f.uid !== auid).map(f => `
    <div class="target-row" data-uid="${esc(f.uid)}">
      <input type="checkbox"><span>${esc(f.name || f.nickname || f.wxid)}</span>
    </div>`).join('')
  box.innerHTML = adminRow + (rows || '<p class="muted">还没有好友可选</p>')
}

async function submitMoment() {
  const text = el('momentText').value.trim()
  const vis = el('momentVis').value
  const err = el('momentErr')
  err.textContent = ''
  if (!text && !momentMediaList.length) { err.textContent = '请输入内容或选择媒体'; return }
  const targets = [...el('momentTargetList').querySelectorAll('.target-row:not([data-locked]) input')]
    .filter(cb => cb.checked)
    .map(cb => cb.closest('.target-row').dataset.uid)
  if (vis === 'custom' && targets.length < 1) { err.textContent = '「指定用户可见」至少勾选 1 名好友'; return }
  const payload = {
    kind: momentKind, text, media: momentMediaList, visibility: vis, targets,
    loc: momentLoc,
  }
  const btn = el('btnMomentSubmit')
  btn.disabled = true
  try {
    if (momentEditing) {
      await Net.momentUpdate(Object.assign({ id: momentEditing.id }, payload))
      toast('修改已保存')
    } else {
      await Net.momentPublish(payload)
      toast('发布成功')
    }
    closeModal()
    await loadMoments()
  } catch (e) {
    err.textContent = e.message || '发布失败'
  } finally { btn.disabled = false }
}

/* ---------- 举报 ---------- */
let momentReportCtx = null
function openMomentReport(id, commentId, name) {
  momentReportCtx = { id, commentId: commentId || '', name: name || '' }
  el('momentRepTarget').textContent = '举报对象：' + (name || '该条动态的作者')
  el('momentRepText').value = ''
  el('momentRepErr').textContent = ''
  el('btnMomentRepCancel').onclick = closeModal
  el('btnMomentRepOk').onclick = async () => {
    const quick = el('momentRepQuick').value
    const extra = el('momentRepText').value.trim()
    const reason = extra ? quick + '：' + extra : quick
    try {
      await Net.momentReport(momentReportCtx.id, reason, momentReportCtx.commentId)
      closeModal()
      toast('举报已提交，CMO 会在「朋友圈管理 · 用户举报」中处理', 3600)
    } catch (e) { el('momentRepErr').textContent = e.message || '提交失败' }
  }
  openModal('modalMomentReport')
}

/* ===========================================================
 * 靠北帖（论坛）：CMO 可创建多个帖，每个帖各自维护成员
 * =========================================================== */
async function showForumView() {
  showView('forum')
  if (el('forumDot')) el('forumDot').hidden = true
  await loadForum(S.forumBoardId)
  document.querySelectorAll('#forumTabs .atab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#forumTabs .atab').forEach(x => x.classList.remove('is-on'))
      b.classList.add('is-on')
      S.forumTab = b.dataset.t
      renderForum()
    }
  })
  el('btnForumCreate').onclick = onForumCreateClick
}

async function loadForum(boardId) {
  const box = el('forumList')
  try {
    const r = await Net.forum(boardId || '')
    S.forum = r
    S.forumBoardId = r.activeId || ''
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  renderForum()
}

function renderForumBoards() {
  const box = el('forumBoards')
  if (!box) return
  const f = S.forum || {}
  const boards = f.boards || []
  if (!boards.length) {
    box.innerHTML = ''
    return
  }
  box.innerHTML = boards.map(b => `
    <button type="button" class="forum-board-chip${b.id === f.activeId ? ' is-on' : ''}" data-bid="${esc(b.id)}">
      <span># ${esc(b.name)}</span>
      <span class="fb-count">${b.memberCount}人 · ${b.postCount}帖</span>
    </button>`).join('') +
    (f.canCreate ? `<button type="button" class="forum-board-chip forum-board-new" data-new="1">＋ 新建帖</button>` : '')
  box.onclick = e => {
    const chip = e.target.closest('.forum-board-chip')
    if (!chip) return
    if (chip.dataset.new) return openForumBoardForm()
    if (chip.dataset.bid && chip.dataset.bid !== (S.forum || {}).activeId) loadForum(chip.dataset.bid)
  }
}

function forumPostHtml(p) {
  const comments = (p.comments || []).map(c => `
    <div class="fm-comment"><b>${esc(c.name)}</b>：<span>${esc(c.text)}</span>
      <i class="muted">${esc(relTime(c.at))}</i></div>`).join('')
  return `<article class="fm-card" data-id="${esc(p.id)}">
    <header class="fm-head">
      <div class="mm-av">${avatarHtml(p.avatar)}</div>
      <div class="mm-meta">
        <div class="mm-name">${esc(p.nickname)} <span class="fm-tag">@${esc(p.wxid || '成员')}</span></div>
        <div class="mm-sub">${esc(relTime(p.at))}</div>
      </div>
    </header>
    ${p.title ? `<h4 class="fm-title">${esc(p.title)}</h4>` : ''}
    <div class="mm-text">${esc(p.text)}</div>
    ${mediaHtml('image', p.media)}
    <div class="mm-actions">
      <button class="mm-act${p.liked ? ' is-on' : ''}" data-fact="like" data-id="${esc(p.id)}">👍 ${p.likes || ''}</button>
      <button class="mm-act" data-fact="comment" data-id="${esc(p.id)}">💬 评论${p.comments.length ? ' ' + p.comments.length : ''}</button>
      <button class="mm-act${isFav('forum', p.id) ? ' is-on' : ''}" data-fact="fav" data-id="${esc(p.id)}"
        data-favstar="forum:${esc(p.id)}" data-favtext-off="☆ 收藏" data-favtext-on="⭐ 已收藏">${isFav('forum', p.id) ? '⭐ 已收藏' : '☆ 收藏'}</button>
      ${(p.uid === S.uid || (S.profile && S.profile.isAdmin)) ? `<button class="mm-act danger" data-fact="del" data-id="${esc(p.id)}">🗑 删除</button>` : ''}
    </div>
    ${comments ? `<div class="mm-comments">${comments}</div>` : ''}
    <div class="mm-comment-form" hidden>
      <input maxlength="200" placeholder="回复这条帖子…">
      <button class="btn-code" data-fact="sendComment" data-id="${esc(p.id)}">发送</button>
    </div>
  </article>`
}

function renderForum() {
  const box = el('forumList')
  const f = S.forum || { boards: [] }
  const boards = f.boards || []
  renderForumBoards()
  if (!boards.length) {
    box.innerHTML = `<div class="fm-gate">
      <p>「靠北帖」由 CMO 管理，目前还没有可以进入的帖。</p>
      <p class="muted">${f.canCreate ? '点右上角 ＋ 新建一个帖，再勾选成员加入。' : '需要加入请联系 CMO（KB号 kaobei）。'}</p>
    </div>`
    return
  }
  const tab = S.forumTab || 'posts'
  if (tab === 'members') {
    const rows = (f.members || []).map(m => `
      <div class="fm-member">
        <div class="mm-av">${avatarHtml(m.avatar)}</div>
        <div class="mm-meta"><div class="mm-name">${esc(m.nickname)}</div>
          <div class="mm-sub">@${esc(m.wxid)}${m.isAdmin ? ' · CMO' : ''}</div></div>
      </div>`).join('')
    box.innerHTML = (f.canManage ? `<p class="muted fm-tip">CMO 可勾选成员加入当前帖</p>
      <div class="admin-btns">
        <button class="btn-code" id="btnForumPick">✏️ 管理成员</button>
        <button class="btn-code" id="btnForumDelBoard">🗑️ 删除此帖</button>
      </div>` : '') + rows
    if (f.canManage) {
      el('btnForumPick').onclick = () => openForumMembersPick()
      el('btnForumDelBoard').onclick = onForumDeleteBoard
    }
    return
  }
  const posts = f.posts || []
  if (!posts.length) { box.innerHTML = '<p class="muted">这个帖还没有内容，点右上角 ＋ 发第一帖</p>'; return }
  box.innerHTML = posts.map(forumPostHtml).join('')
}

function bindForumList() {
  el('forumList').onclick = async e => {
    const btn = e.target.closest('[data-fact]')
    if (!btn) return
    const act = btn.dataset.fact, id = btn.dataset.id
    if (act === 'like') {
      try { await Net.forumLike(id); await loadForum() } catch (err) { toast(err.message || '操作失败') }
      return
    }
    if (act === 'fav') {
      const p = (S.forum.posts || []).find(x => x.id === id)
      if (!p) return
      await collectFavorite({
        kind: 'forum', ref: id,
        title: p.title || (p.text || '').slice(0, 40),
        text: p.text || '', media: p.media || [],
        from: p.uid, fromName: p.nickname,
      })
      return
    }
    if (act === 'comment') {
      const form = btn.closest('.fm-card').querySelector('.mm-comment-form')
      form.hidden = !form.hidden
      if (!form.hidden) form.querySelector('input').focus()
      return
    }
    if (act === 'sendComment') {
      const form = btn.closest('.mm-comment-form')
      const input = form.querySelector('input')
      const text = input.value.trim()
      if (!text) return
      try { await Net.forumComment(id, text); input.value = ''; await loadForum() }
      catch (err) { toast(err.message || '评论失败') }
    }
  }
}

/* 右上角 ＋：没有帖时先建帖，已有帖时发新帖 */
function onForumCreateClick() {
  const f = S.forum || {}
  if (f.canCreate && !(f.boards || []).length) return openForumBoardForm()
  if (!f.activeId) { toast('请先让 CMO 新建一个靠北帖'); return }
  openForumForm()
}

/* ---------- CMO 新建 / 删除帖 ---------- */
function openForumBoardForm() {
  el('forumBoardName').value = ''
  el('forumBoardErr').textContent = ''
  el('btnForumBoardCancel').onclick = closeModal
  el('btnForumBoardOk').onclick = async () => {
    const name = el('forumBoardName').value.trim()
    if (!name) { el('forumBoardErr').textContent = '请输入帖的名称'; return }
    const btn = el('btnForumBoardOk')
    btn.disabled = true
    try {
      const r = await Net.forumBoardAdd(name)
      closeModal()
      toast('已创建「' + name + '」，接下来勾选成员')
      await loadForum(r.board && r.board.id)
      S.forumTab = 'members'
      document.querySelectorAll('#forumTabs .atab').forEach(x => x.classList.toggle('is-on', x.dataset.t === 'members'))
      renderForum()
    } catch (e) {
      el('forumBoardErr').textContent = e.message || '创建失败'
    } finally { btn.disabled = false }
  }
  openModal('modalForumBoard')
}

async function onForumDeleteBoard() {
  const f = S.forum || {}
  const b = (f.boards || []).find(x => x.id === f.activeId)
  if (!b) return
  if (!confirm('删除「' + b.name + '」这个帖？里面的 ' + b.postCount + ' 条内容会一并删除，无法恢复。')) return
  try {
    await Net.forumBoardDel(b.id)
    toast('已删除')
    await loadForum('')
  } catch (e) { toast(e.message || '删除失败') }
}

function openForumForm() {
  el('forumText').value = ''
  el('forumErr').textContent = ''
  el('btnForumCancel').onclick = closeModal
  el('btnForumSubmit').onclick = async () => {
    const text = el('forumText').value.trim()
    if (!text) { el('forumErr').textContent = '请输入帖子内容'; return }
    try {
      await Net.forumPost({ boardId: (S.forum || {}).activeId || '', title: '', text })
      closeModal()
      toast('已发布，系统已自动标注你的昵称')
      await loadForum()
    } catch (e) { el('forumErr').textContent = e.message || '发布失败' }
  }
  openModal('modalForumForm')
}

async function openForumMembersPick() {
  const f = S.forum || {}
  const picked = new Set((f.members || []).map(m => m.uid))
  /* 候选来自服务端：全部普通用户，不只是好友，否则「加不了人」 */
  const all = (f.candidates || []).slice()
  const box = el('forumList')
  box.innerHTML = `<div class="fm-pick">
    <p class="muted">勾选要加入「${esc((f.boards || []).find(b => b.id === f.activeId) || {}).name || '靠北帖'}」的用户（至高账号固定在内，不可取消）</p>
    <div class="fm-pick-search">
      <input id="forumPickSearch" placeholder="搜索昵称 / KB号 / 真实姓名">
    </div>
    <div class="target-list" id="forumPickList">
      <div class="target-row is-on" data-locked="1"><input type="checkbox" checked disabled><span>👑 至高账号（CMO）</span></div>
      ${all.map(x => `<div class="target-row${picked.has(x.uid) ? ' is-on' : ''}" data-uid="${esc(x.uid)}" data-key="${esc((x.nickname + ' ' + x.wxid + ' ' + (x.realName || '')).toLowerCase())}">
        <input type="checkbox"${picked.has(x.uid) ? ' checked' : ''}><span>${esc(x.nickname)} <i class="muted">@${esc(x.wxid)}</i></span>
      </div>`).join('')}
    </div>
    <div class="modal-btns">
      <button class="btn-ghost" id="btnPickCancel">取消</button>
      <button class="btn-primary" id="btnPickSave">保存成员</button>
    </div>
  </div>`
  const list = el('forumPickList')
  list.onclick = e => {
    const row = e.target.closest('.target-row')
    if (!row || row.dataset.locked === '1') return
    const cb = row.querySelector('input')
    cb.checked = !cb.checked
    row.classList.toggle('is-on', cb.checked)
  }
  el('forumPickSearch').oninput = () => {
    const q = el('forumPickSearch').value.trim().toLowerCase()
    list.querySelectorAll('.target-row[data-uid]').forEach(r => {
      r.hidden = !!q && !r.dataset.key.includes(q)
    })
  }
  el('btnPickCancel').onclick = () => renderForum()
  el('btnPickSave').onclick = async () => {
    const uids = [...list.querySelectorAll('.target-row:not([data-locked]) input')]
      .filter(cb => cb.checked).map(cb => cb.closest('.target-row').dataset.uid)
    try {
      await Net.forumMembers(f.activeId, uids)
      toast('成员已更新')
      await loadForum(f.activeId)
    } catch (e) { toast(e.message || '保存失败') }
  }
}

/* ===========================================================
 * 管理端：朋友圈管理 / 违禁词
 * =========================================================== */
let adminMomentTab = 'reports'
let adminMomentCache = { reports: [], moments: [] }

async function loadAdminMoments() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    adminMomentCache = await Net.adminMoments()
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  renderAdminMoments()
}

function renderAdminMoments() {
  const box = el('adminList')
  const tabs = `<div class="admin-subtabs">
    <button class="atab${adminMomentTab === 'reports' ? ' is-on' : ''}" data-mt="reports">用户举报</button>
    <button class="atab${adminMomentTab === 'all' ? ' is-on' : ''}" data-mt="all">全部动态</button>
  </div>`
  let body = ''
  if (adminMomentTab === 'reports') {
    const list = (adminMomentCache.reports || [])
    body = list.length ? list.map(r => `
      <div class="admin-item mm-report">
        <div class="mm-report-head">
          <b>${esc(r.targetName)}</b>
          <span class="tag ${r.status === 'pending' ? 'tag-ban' : r.status === 'approved' ? 'tag-mute' : ''}">
            ${r.status === 'pending' ? '待审核' : r.status === 'approved' ? '已通过·' + (r.action === 'ban' ? '封禁' : '删除') : '未通过'}
          </span>
        </div>
        <div class="mm-quote">${esc(r.snapshot || '（内容已删除）')}</div>
        <div class="muted">举报人：${esc(r.reporterName)}（${esc(r.reporterWxid || '')}） · ${esc(fmtFull(r.at))}</div>
        <div class="muted">理由：${esc(r.reason)}</div>
        ${r.reply ? `<div class="muted">回复：${esc(r.reply)}</div>` : ''}
        ${r.status === 'pending' ? `<div class="admin-btns">
          <button class="btn-code" data-mact2="approve" data-punish="delete" data-id="${esc(r.id)}">通过 · 删除内容</button>
          <button class="btn-code" data-mact2="approve" data-punish="ban" data-id="${esc(r.id)}">通过 · 封禁账号</button>
          <button class="btn-code" data-mact2="reject" data-id="${esc(r.id)}">不通过并回复理由</button>
        </div>` : ''}
      </div>`).join('') : '<p class="muted">暂无举报</p>'
  } else {
    const list = adminMomentCache.moments || []
    body = list.length ? list.map(m => `
      <div class="admin-item">
        <b>${esc(m.nickname)}</b> <span class="muted">@${esc(m.wxid)} · ${esc(fmtFull(m.at))}</span>
        <div class="mm-quote">${esc(m.text || '（媒体内容）')}</div>
        <div class="muted">👍 ${m.likes} · 💬 ${m.comments.length} · ${esc(visLabel(m))}</div>
        <div class="admin-btns">
          <button class="btn-code" data-mact2="delmoment" data-id="${esc(m.id)}">删除该动态</button>
          <button class="btn-code" data-mact2="banuser" data-uid="${esc(m.uid)}" data-name="${esc(m.nickname)}">封禁作者</button>
        </div>
      </div>`).join('') : '<p class="muted">暂无动态</p>'
  }
  box.innerHTML = tabs + body
  box.querySelectorAll('[data-mt]').forEach(b => {
    b.onclick = () => { adminMomentTab = b.dataset.mt; renderAdminMoments() }
  })
  box.querySelectorAll('[data-mact2]').forEach(b => {
    b.onclick = () => onAdminMomentAction(b)
  })
}

async function onAdminMomentAction(btn) {
  const act = btn.dataset.mact2
  const id = btn.dataset.id
  try {
    if (act === 'approve') {
      const punish = btn.dataset.punish
      const ok = confirm(punish === 'ban' ? '通过举报并封禁被举报账号 30 天？' : '通过举报并删除该内容？')
      if (!ok) return
      await Net.adminMomentAction({ id, mode: 'approve', punish, days: 30 })
      toast('已处理，并已回复举报人')
    } else if (act === 'reject') {
      const reason = window.prompt('填写不通过的理由（会发送给举报人）', '')
      if (!reason) return
      await Net.adminMomentAction({ id, mode: 'reject', reason })
      toast('已驳回，理由已发给举报人')
    } else if (act === 'delmoment') {
      if (!confirm('确定删除这条动态？')) return
      await Net.momentDel(id)
      toast('已删除')
    } else if (act === 'banuser') {
      if (!confirm('封禁「' + btn.dataset.name + '」30 天？')) return
      await Net.adminAction(btn.dataset.uid, 'ban', { hours: 24 * 30, reason: '朋友圈内容违规' })
      toast('已封禁 30 天')
    }
    await loadAdminMoments()
  } catch (e) { toast(e.message || '操作失败') }
}

/* ---------- 违禁词 ---------- */
async function loadAdminWords() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  let r
  try { r = await Net.adminWords() } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  const words = (r.words || []).map(w => `
    <span class="word-chip">${esc(w.word)}<button data-wdel="${esc(w.id)}" title="删除">×</button></span>`).join('')
  const warns = (r.warns || []).map(w => `
    <div class="admin-item">
      <b>${esc(w.nickname)}</b> <span class="muted">@${esc(w.wxid)}</span>
      <span class="tag ${w.warnCount >= 3 ? 'tag-ban' : 'tag-mute'}">警告 ${w.warnCount}/3</span>
      ${w.bannedUntil ? `<span class="tag tag-ban">封禁至 ${esc(fmtFull(w.bannedUntil))}</span>` : ''}
      <div class="muted">触发记录：${(w.history || []).slice(0, 5).map(h => '「' + esc(h.word) + '」').join(' ')}</div>
      <div class="admin-btns"><button class="btn-code" data-wclear="${esc(w.uid)}">解除警告</button></div>
    </div>`).join('')
  const log = (r.log || []).map(l => `
    <div class="admin-item">
      <b>${esc(l.nickname)}</b> <span class="muted">@${esc(l.wxid)} · ${esc(fmtFull(l.at))}</span>
      <span class="tag tag-ban">${esc(l.word)}</span>
      <div class="muted">原文：${esc(l.text)}</div>
      <div class="muted">位置：${l.where === 'chat' ? '聊天' : l.where === 'forum' ? '靠北帖' : '朋友圈'} · 第 ${l.warnCount} 次警告</div>
    </div>`).join('')
  box.innerHTML = `
    <div class="word-add">
      <input id="wordInput" maxlength="20" placeholder="输入违禁词，例如：sb">
      <button class="btn-primary" id="btnWordAdd">新增违禁词</button>
    </div>
    <p class="muted">判定规则：只匹配独立成词的违禁词；作为其他单词的一部分（如 somebody 里的 sb）不会触发。</p>
    <h4 class="admin-h4">当前违禁词</h4>
    <div class="word-list">${words || '<p class="muted">还没有违禁词</p>'}</div>
    <h4 class="admin-h4">警告名单（累计 3 次自动封号）</h4>
    ${warns || '<p class="muted">暂无被警告用户</p>'}
    <h4 class="admin-h4">违禁词历史记录</h4>
    ${log || '<p class="muted">暂无记录</p>'}`
  el('btnWordAdd').onclick = async () => {
    const w = el('wordInput').value.trim()
    if (!w) return
    try { await Net.adminWordAdd(w); toast('已新增违禁词'); await loadAdminWords() }
    catch (e) { toast(e.message || '新增失败') }
  }
  box.querySelectorAll('[data-wdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除该违禁词？')) return
      try { await Net.adminWordDel(b.dataset.wdel); await loadAdminWords() }
      catch (e) { toast(e.message || '删除失败') }
    }
  })
  box.querySelectorAll('[data-wclear]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('解除该用户的全部警告（因违禁词产生的封禁也会解除）？')) return
      try { await Net.adminWarnClear(b.dataset.wclear); toast('已解除'); await loadAdminWords() }
      catch (e) { toast(e.message || '操作失败') }
    }
  })
}

/* ===========================================================
 * 收藏（聊天 / 朋友圈 / 靠北帖 / 公告 都能收）
 * 星标是开关：未收藏灰色 ☆，已收藏金色 ⭐，再点一次取消收藏
 * =========================================================== */
const FAV_KIND_LABEL = { chat: '聊天', moment: '朋友圈', forum: '靠北帖', ann: '公告' }

/* 当前用户是否已收藏（kind + ref 唯一定位一条） */
function isFav(kind, ref) {
  return (S.favorites || []).some(x => x.kind === kind && x.ref === ref)
}

/* 收藏状态变化后，把页面上对应的星标就地刷新 */
function refreshFavStars(kind, ref) {
  const on = isFav(kind, ref)
  document.querySelectorAll(`[data-favstar="${kind}:${ref}"]`).forEach(n => {
    n.classList.toggle('is-on', on)
    n.textContent = on ? (n.dataset.favtextOn || '⭐') : (n.dataset.favtextOff || '☆')
    if (n.dataset.favtitle) n.title = on ? '取消收藏' : n.dataset.favtitle
  })
}

/* 收藏开关：返回 true 表示现在处于「已收藏」 */
async function collectFavorite(payload) {
  try {
    const r = await Net.favToggle(payload)
    S.favorites = r.list || S.favorites
    toast(r.fav ? '已收藏 ⭐' : '已取消收藏')
    if (payload && payload.kind && payload.ref) refreshFavStars(payload.kind, payload.ref)
    if (S.view === 'favorites') renderFavorites()
    return !!r.fav
  } catch (e) { toast(e.message || '操作失败'); return false }
}

async function showFavoritesView() {
  showView('favorites')
  document.querySelectorAll('#favTabs .atab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#favTabs .atab').forEach(x => x.classList.remove('is-on'))
      b.classList.add('is-on')
      S.favTab = b.dataset.t
      renderFavorites()
    }
  })
  await loadFavorites()
}

async function loadFavorites() {
  const box = el('favList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.favorites()
    S.favorites = r.list || []
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  renderFavorites()
}

function favCardHtml(f) {
  const media = (f.media || []).filter(u => /^data:image|\.(png|jpe?g|gif|webp)$/i.test(u) || u.startsWith('data:image'))
    .map(u => `<img src="${esc(u)}" alt="">`).join('')
  return `<article class="fav-card" data-fid="${esc(f.id)}">
    <div class="fav-head">
      <span class="fav-kind k-${esc(f.kind)}">${esc(FAV_KIND_LABEL[f.kind] || '收藏')}</span>
      <b style="font-size:13.5px">${esc(f.title || '（无标题）')}</b>
    </div>
    ${f.text ? `<div class="fav-text">${esc(f.text)}</div>` : ''}
    ${media ? `<div class="fav-media">${media}</div>` : ''}
    <div class="fav-meta">
      ${f.fromName ? `<span>来自 ${esc(f.fromName)}</span>` : ''}
      <span>${esc(fmtFull(f.at))}</span>
    </div>
    <div class="fav-ops">
      <button class="btn-code" data-favdel="${esc(f.id)}">取消收藏</button>
    </div>
  </article>`
}

function renderFavorites() {
  const box = el('favList')
  const tab = S.favTab || 'all'
  let list = S.favorites || []
  if (tab !== 'all') list = list.filter(x => x.kind === tab)
  if (!list.length) {
    box.innerHTML = '<p class="muted">还没有收藏。在消息右键菜单、朋友圈、靠北帖、公告里点 ⭐ 就能收藏到这里。</p>'
    return
  }
  box.innerHTML = list.map(favCardHtml).join('')
  box.querySelectorAll('[data-favdel]').forEach(b => {
    b.onclick = async () => {
      try {
        const r = await Net.favDel(b.dataset.favdel)
        S.favorites = r.list || []
        renderFavorites()
        toast('已取消收藏')
      } catch (e) { toast(e.message || '操作失败') }
    }
  })
}

/* ===========================================================
 * 文件中心
 * =========================================================== */
async function showFilesView() {
  showView('files')
  const box = el('filesList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  let list = []
  try {
    const r = await Net.files()
    list = r.list || []
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  if (!list.length) {
    box.innerHTML = '<p class="muted">还没有图片或文件。聊天里发过的图片、文件都会汇总到这里。</p>'
    return
  }
  box.innerHTML = list.map(f => `
    <article class="file-card">
      <div class="file-head">
        <div class="f-thumb">${f.kind === 'image'
          ? `<img src="${esc(f.url)}" alt="">`
          : '<span>📎</span>'}</div>
        <div class="f-name">${f.kind === 'image' ? '图片' : esc(f.name || '文件')}
          <div class="f-sub">${esc(f.roomName)} · ${esc(f.fromName || '')} · ${esc(fmtFull(f.at))}</div>
        </div>
        <button class="btn-code${isFav('chat', f.id) ? ' is-on' : ''}" data-favfile="${esc(f.id)}"
          data-favstar="chat:${esc(f.id)}" data-favtext-off="☆ 收藏" data-favtext-on="⭐ 已收藏">${isFav('chat', f.id) ? '⭐ 已收藏' : '☆ 收藏'}</button>
        <a class="btn-code" href="${esc(f.url)}" target="_blank" rel="noopener">打开</a>
      </div>
    </article>`).join('')
  box.querySelectorAll('[data-favfile]').forEach(b => {
    b.onclick = () => {
      const f = list.find(x => x.id === b.dataset.favfile)
      if (!f) return
      collectFavorite({
        kind: 'chat', ref: f.id,
        title: f.kind === 'image' ? '图片' : (f.name || '文件'),
        text: f.url, media: f.kind === 'image' ? [f.url] : [],
        from: f.from, fromName: f.fromName,
      })
    }
  })
}

/* ===========================================================
 * 新手指引
 * =========================================================== */
/* 移动端点击式引导：逐步高亮底部导航与关键入口，用户亲手点一遍来熟悉 */
const MOBILE_GUIDE_STEPS = [
  { sel: '.mtab-btn[data-mv="chats"]', title: '聊天', desc: '所有单聊、群聊和文件传输助手都在这里。点一下「聊天」继续。', click: true, force: true },
  { sel: '.mtab-btn[data-mv="forum"]', title: '靠北帖', desc: '论坛式讨论区，发帖不用标题、可点赞收藏。点一下「靠北帖」继续。', click: true, force: true },
  { sel: '.mtab-btn[data-mv="moments"]', title: '朋友圈', desc: '发照片、视频、语音和心情。点一下「朋友圈」继续。', click: true, force: true },
  { sel: '.mtab-btn[data-mv="games"]', title: '游戏', desc: '游戏中心：靠北游戏（内置）+ 第三方游戏。点一下「游戏」继续。', click: true, force: true },
  { sel: '#btnMoreFloat2', title: '更多功能', desc: '通讯录、公告栏、收藏、设置、使用引导等都在「⋯」里（游戏中心右上角 / 聊天页右上角）。点一下打开它。', click: true, force: true },
  { sel: '.drawer-item[data-act="settings"]', title: '全部功能', desc: '抽屉里的全部入口。点一下「设置」完成教程（以后可随时从「⋯」→ 使用引导重看）。聊天列表顶部还有公告横幅，重要公告会自动弹窗哦。', click: true, force: true },
]

let _mobileGuideHandler = null
function renderMobileGuideStep() {
  const st = MOBILE_GUIDE_STEPS[guideIdx]
  if (!st) return endGuide()
  const node = document.querySelector(st.sel)
  /* force：底部导航等恒在元素（jsdom 不执行媒体查询，guideVisible 会误判隐藏） */
  if (!node || (!st.force && !guideVisible(node))) { guideIdx++; return renderMobileGuideStep() }
  el('guideStep').textContent = (guideIdx + 1) + ' / ' + MOBILE_GUIDE_STEPS.length
  el('guideTitle').textContent = st.title
  el('guideDesc').textContent = st.desc
  el('btnGuidePrev').hidden = true
  el('btnGuideNext').hidden = true
  el('btnGuideSkip').hidden = false
  const hole = el('guideHole')
  const card = el('guideCard')
  if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  const r = node.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  const pad = 8
  /* 高亮框：全程钳制在视口内（目标贴边时不再越界） */
  hole.hidden = false
  const hLeft = Math.max(4, Math.min(r.left - pad, vw - 12))
  const hTop = Math.max(4, Math.min(r.top - pad, vh - 12))
  hole.style.left = hLeft + 'px'
  hole.style.top = hTop + 'px'
  hole.style.width = Math.min(r.width + pad * 2, vw - hLeft - 4) + 'px'
  hole.style.height = Math.min(r.height + pad * 2, vh - hTop - 4) + 'px'
  /* 卡片：先按估算放置，渲染后用实测尺寸二次钳制，保证任何屏宽/文案长度都不出屏 */
  const cw = Math.min(300, vw - 24)
  card.style.width = cw + 'px'
  card.style.left = Math.max(12, (vw - cw) / 2) + 'px'
  let top = r.top - 190 - 18
  if (top < 10) top = r.bottom + 14
  card.style.top = Math.max(10, Math.min(top, vh - 170)) + 'px'
  /* 实测二次钳制（长文案卡片更高时自动下移/上移到视口内） */
  const aw = card.offsetWidth || cw
  const ah = card.offsetHeight || 170
  card.style.left = Math.max(12, Math.min(parseFloat(card.style.left), vw - aw - 12)) + 'px'
  card.style.top = Math.max(10, Math.min(parseFloat(card.style.top), vh - ah - 12)) + 'px'
  /* 用户亲手点击高亮目标：真实功能照常触发，同时进入下一步 */
  if (_mobileGuideHandler) {
    _mobileGuideHandler.el.removeEventListener('click', _mobileGuideHandler.fn, true)
    _mobileGuideHandler = null
  }
  _mobileGuideHandler = {
    el: node,
    fn: () => {
      guideIdx++
      setTimeout(renderGuideStep, 120)
    },
  }
  node.addEventListener('click', _mobileGuideHandler.fn, { capture: true, once: true })
}

const GUIDE_STEPS = [
  { sel: '#railAvatar', title: '我的资料', desc: '点头像可以修改昵称、头像和个性签名。' },
  { sel: '#btnAddMenu', title: '发起会话', desc: '按 KB号 加好友、发起单聊或群聊。' },
  { sel: '#searchInput', title: '搜索', desc: '可以搜索会话、群聊和聊天内容。' },
  { sel: '.rail-btn[data-nav="chats"]', title: '聊天', desc: '所有单聊与群聊都在这里，点开即可发消息。' },
  { sel: '.rail-btn[data-nav="contacts"]', title: '通讯录', desc: '按 KB号 加好友、处理好友申请、发起群聊。' },
  { sel: '.rail-btn[data-nav="forum"]', title: '靠北帖', desc: '论坛式讨论区：CMO 可以建多个帖，每帖独立成员，可发帖、评论、点赞、收藏。' },
  { sel: '.rail-btn[data-nav="moments"]', title: '朋友圈', desc: '发照片、视频、语音和表情包，可设置谁可以看。' },
  { sel: '.rail-btn[data-nav="ann"]', title: '公告栏', desc: '查看群公告与 Chat 公告，重要公告会自动盖官方印章。' },
  { sel: '.rail-btn[data-nav="find"]', title: '找朋友', desc: '把爱好写成泡泡，点别人的泡泡就能申请加好友。' },
  { sel: '.rail-btn[data-nav="lucky"]', title: '抽奖', desc: '转盘、刮刮卡、抽签，也可以把结果发到群里。' },
  { sel: '.rail-btn[data-nav="more"]', title: '游戏', desc: '游戏中心：内置跳一跳等靠北游戏，也有第三方小游戏合集。' },
  { sel: '#btnRailMore', title: '更多', desc: '文件、收藏、意见箱收在这个菜单里，指引会自动展开它。' },
  { sel: '.rail-btn[data-nav="files"]', title: '文件', desc: '聊天里发过的图片和文件都会汇总到这里。' },
  { sel: '.rail-btn[data-nav="favorites"]', title: '收藏', desc: '聊天消息、朋友圈、靠北帖、公告都能收藏，统一在这里查看。' },
  { sel: '.rail-btn[data-nav="feedback"]', title: '意见箱', desc: '普通用户在这里写意见，CMO 打开这里是查看用户提交的意见。' },
  { sel: '.rail-btn[data-nav="settings"]', title: '设置', desc: '主题、聊天背景、提示音、界面语言、新手指引都在这里。' },
  { sel: '.rail-btn[data-nav="admin"]', title: '管理面板', desc: 'CMO 专用：账号处置、公告审批、朋友圈举报、违禁词管理。' },
]
let guideIdx = 0
let guideActive = false

function guideDoneKey() { return 'kbchat_guide_done_' + (S.uid || 'guest') }
function guideDone() { try { return localStorage.getItem(guideDoneKey()) === '1' } catch (e) { return false } }
function markGuideDone() { try { localStorage.setItem(guideDoneKey(), '1') } catch (e) {} }

function maybeAutoGuide() {
  if (guideActive || guideDone()) return
  if (!S.uid) return
  if (el('modalMask') && !el('modalMask').hidden) { setTimeout(maybeAutoGuide, 2500); return }
  startGuide(false)
}

function startGuide(force) {
  if (!S.uid) { toast('请先登录'); return }
  if (guideActive) return
  guideActive = true
  guideIdx = 0
  el('guideLayer').hidden = false
  renderGuideStep()
}

/* 元素是否真的显示在屏幕上：
 * 只判断元素自身不够——父级 pane 被内联 display:none 隐藏时，
 * 子元素的 computed display 仍是自己的值，但实际尺寸为 0，指引框会跑到左上角。 */
function guideVisible(n) {
  if (!n) return false
  let p = n
  while (p && p.nodeType === 1) {
    if (p.hidden) return false
    try {
      const cs = window.getComputedStyle(p)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
    } catch (e) {}
    p = p.parentElement
  }
  return true
}

function renderGuideStep() {
  /* 移动端（竖屏）：点击式引导——亲手点一遍底部导航与关键入口 */
  if (typeof isMobile === 'function' && isMobile()) return renderMobileGuideStep()
  /* 指引期间保持 ☰ 子菜单展开：文件/收藏/意见箱的目标可见，高亮框不再指空 */
  const fly = el('railFlyout')
  if (fly) fly.classList.add('is-open')
  el('btnGuidePrev').hidden = false
  el('btnGuideNext').hidden = false
  el('btnGuideSkip').hidden = false
  const steps = GUIDE_STEPS.filter(s => guideVisible(document.querySelector(s.sel)))
  if (!steps.length) { endGuide(); return }
  if (guideIdx >= steps.length) return endGuide()
  const st = steps[guideIdx]
  const node = document.querySelector(st.sel)
  el('guideStep').textContent = (guideIdx + 1) + ' / ' + steps.length
  el('guideTitle').textContent = st.title
  el('guideDesc').textContent = st.desc
  el('btnGuidePrev').disabled = guideIdx === 0
  el('btnGuideNext').textContent = guideIdx === steps.length - 1 ? '完成' : '下一步'

  const hole = el('guideHole')
  const card = el('guideCard')
  if (!node) { hole.hidden = true; card.style.left = '50%'; card.style.top = '40%'; return }
  /* ☰ 子菜单内的目标（文件/收藏/意见箱）禁止 scrollIntoView：
   * 它会把 .rail-nav 横向滚走 54px，整个侧栏错位、高亮框指到别的图标上（用户录屏实锤）。
   * flyout 已经 .is-open 展开，目标本来就完整可见，无需滚动。 */
  const inFlyout = !!(node.closest && node.closest('#railFlyout'))
  const rn = document.querySelector('.rail-nav')
  if (rn && rn.scrollLeft) rn.scrollLeft = 0   /* 自愈：任何原因导致的侧栏横向位移都复位 */
  if (!inFlyout && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  const r = node.getBoundingClientRect()
  /* 尺寸为 0 说明目标此刻其实不可见（被隐藏/未布局），不要把卡片甩到左上角 */
  if (!r.width && !r.height) {
    hole.hidden = true
    card.style.left = Math.max(12, (window.innerWidth - 300) / 2) + 'px'
    card.style.top = Math.max(12, window.innerHeight / 2 - 90) + 'px'
    return
  }
  const pad = 6
  hole.hidden = false
  hole.style.left = (r.left - pad) + 'px'
  hole.style.top = (r.top - pad) + 'px'
  hole.style.width = (r.width + pad * 2) + 'px'
  hole.style.height = (r.height + pad * 2) + 'px'

  /* 指引卡片贴在按钮右侧，垂直方向以图标为中心对齐（避免卡片飘到别处，看着"对不上"）；
   * 越界时在视口内收紧，但保持与图标最近的可用位置 */
  const cw = 300
  card.style.left = '0px'; card.style.top = '0px'   /* 先归位再测实际高度，避免旧值影响 */
  const chReal = card.offsetHeight || 170
  let left = r.right + 14
  if (left + cw > window.innerWidth - 12) left = Math.max(12, r.left - cw - 14)
  let top = Math.round(r.top + r.height / 2 - chReal / 2)
  top = Math.min(Math.max(12, top), window.innerHeight - chReal - 12)
  card.style.left = left + 'px'
  card.style.top = top + 'px'
}

function endGuide() {
  guideActive = false
  if (_mobileGuideHandler) {
    try { _mobileGuideHandler.el.removeEventListener('click', _mobileGuideHandler.fn, true) } catch (e) {}
    _mobileGuideHandler = null
  }
  /* 收回指引期间展开的 ☰ 子菜单 */
  const fly = el('railFlyout')
  if (fly) fly.classList.remove('is-open')
  /* 复位可能被 scrollIntoView 拖偏的侧栏横向位移 */
  const rn = document.querySelector('.rail-nav')
  if (rn) rn.scrollLeft = 0
  el('guideLayer').hidden = true
  markGuideDone()
}

function bindGuide() {
  el('btnGuideNext').onclick = () => { guideIdx++; renderGuideStep() }
  el('btnGuidePrev').onclick = () => { guideIdx = Math.max(0, guideIdx - 1); renderGuideStep() }
  el('btnGuideSkip').onclick = () => {
    /* 指引层默认盖在弹窗之上，先把它压到弹窗下面，否则「取消/确定」点不到 */
    el('guideLayer').classList.add('is-below')
    const restore = () => { el('guideLayer').classList.remove('is-below') }
    el('btnGuideCancel').onclick = () => { closeModal(); restore() }
    el('btnGuideConfirm').onclick = () => {
      closeModal()
      restore()
      endGuide()
      toast('已跳过新手指引，可在「设置 → 新手指引」重看')
    }
    openModal('modalGuideSkip')
  }
  window.addEventListener('resize', () => { if (guideActive) renderGuideStep() })
}

/* ===========================================================
 * 初始化
 * =========================================================== */
function initSocial() {
  bindMomentList()
  bindForumList()
  bindGuide()
}
document.addEventListener('DOMContentLoaded', initSocial)
