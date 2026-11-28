/* ===========================================================
 * app.js —— 主流程（服务端实时版）
 * =========================================================== */
window.__kbBooted = true   /* 启动哨兵：index.html 的兜底脚本据此判断 JS 是否解析成功 */

const S = {
  uid: null,
  profile: null,
  friends: [],
  groups: [],
  conversations: [],
  messages: [],
  activeRoom: null,
  activeKind: 'dm',
  view: 'chats',
  stickBottom: true,
  sending: false,
  netStatus: 'open',
  reqCount: 0,
  reqs: [],
}

/* ---------- 启动 ---------- */
async function boot() {
  /* 隐藏入口 /kkk/（公用中转站）：把路径改写回首页继续正常启动，
   * 并记住「待解锁」，登录后调解锁接口给账号永久开启 */
  try {
    if (location.pathname.indexOf('/kkk') === 0) {
      sessionStorage.setItem('kb_kkk_pending', '1')
      history.replaceState(null, '', '/')
    }
  } catch (e) {}
  /* 登录态存 sessionStorage：关闭浏览器即退出登录。
   * 老版本 token 在 localStorage——一次性迁入 sessionStorage 并清除（本次会话不掉线，下次关闭浏览器后生效） */
  try {
    const legacy = localStorage.getItem('wxchat_token')
    if (legacy && !sessionStorage.getItem('wxchat_token')) {
      sessionStorage.setItem('wxchat_token', legacy)
      const legacyAccounts = localStorage.getItem('kbchat_accounts')
      if (legacyAccounts && !sessionStorage.getItem('kbchat_accounts')) sessionStorage.setItem('kbchat_accounts', legacyAccounts)
      localStorage.removeItem('wxchat_token')
      localStorage.removeItem('kbchat_accounts')
    }
  } catch (e) {}
  try { Net.token = sessionStorage.getItem('wxchat_token') || '' } catch (e) { Net.token = '' }
  /* 本地偏好：主题、语言、聊天背景、提示音（每步独立兜底，任何一步失败都不能挡住登录页） */
  try { applyTheme() } catch (e) { __kbErr('applyTheme', e) }
  try { applyLang() } catch (e) { __kbErr('applyLang', e) }
  try { applyFontSize() } catch (e) { __kbErr('applyFontSize', e) }
  try {
    const mm = window.matchMedia('(prefers-color-scheme: dark)')
    if (mm.addEventListener) mm.addEventListener('change', applyTheme)
    else if (mm.addListener) mm.addListener(applyTheme)   /* 老版 WebView */
  } catch (e) {}
  if (!Net.token) { showLogin(); return }
  try {
    const data = await Net.bootstrap()
    enterApp(data)
  } catch (e) {
    showLogin(String(e.message || ''))
  }
}

/* 启动期错误收集（index.html 的哨兵重试页会展示，方便用户截图反馈） */
function __kbErr(where, e) {
  try {
    (window.__kbErrors = window.__kbErrors || []).push(where + ': ' + String(e && e.message || e).slice(0, 120))
  } catch (e2) {}
}

function showLogin(msg) {
  el('loginView').hidden = false
  el('mainView').hidden = true
  if (msg) el('loginMsg').textContent = msg
  renderRecentAccounts()
  setTimeout(fitLoginCard, 0)
  /* 游客（登录页）：弹出「所有人可见」的重要 Chat 公告（已读记 localStorage） */
  try {
    const read = new Set(JSON.parse(localStorage.getItem('kbchat_guest_ann_read') || '[]'))
    Net.publicAnns().then(r => {
      const pend = (r.list || []).filter(a => !read.has(a.id))
      if (pend.length) queueImportantAnn(pend)
    }).catch(() => {})
  } catch (e) {}
}

function enterApp(data, opts) {
  /* fresh=true 表示用户刚主动登录/注册/切换账号；
   * 页面刷新等自动恢复会话不弹公告栏，避免每次打开都打扰 */
  S.uid = data.me.uid
  S.profile = data.me
  S.friends = data.friends || []
  S.groups = data.groups || []
  S.conversations = data.conversations || []
  S.reqCount = data.reqCount || 0
  S.myBlocks = data.myBlocks || []
  /* 拉一次收藏列表：公告 / 朋友圈 / 靠北帖的星标要靠它判断亮灭 */
  Net.favorites().then(r => {
    S.favorites = r.list || []
    /* 已在公告栏 / 朋友圈 / 靠北帖的话重绘一次，让星标立刻对上 */
    if (S.view === 'ann') renderAnnListFull()
    if (S.view === 'moments') loadMoments()
    if (S.view === 'forum') loadForum()
  }).catch(() => {})
  el('loginView').hidden = true
  el('mainView').hidden = false
  showView('chats')
  renderAll()
  connectStream()
  /* 高频轮询保证消息秒达：活跃会话 1.2s 拉一次，会话列表 4 次一同步 */
  if (!S.syncTimer) S.syncTimer = setInterval(pollFallback, 1200)
  const isAdmin = !!(data.me && data.me.isAdmin)
  el('btnAdmin').hidden = !isAdmin
  /* 管理员可见全部 GLM 模型选项 */
  const adminModels = document.getElementById('adminModels')
  if (adminModels) adminModels.hidden = !isAdmin
  if (isAdmin) toast(`已以管理员身份登录（${data.me.role || 'CMO'} · KB靠北科技）`, 2200)
  /* CMO 初始密码修改提示已按需求移除（不再弹窗提醒） */
  /* 封禁用户可登录浏览，仅不能发言 */
  if (S.loginBannedUntil) {
    toast('账号已被封禁至 ' + fmtFull(S.loginBannedUntil) + '，期间可浏览消息但无法发言', 5200)
    S.loginBannedUntil = null
  }
  /* 被管理员断绝的关系：主页提示 */
  const blockedList = data.blocked || []
  if (blockedList.length) {
    toast('您已被管理员断绝「' + blockedList.map(b => b.name).join('、') + '」的关系', 4800)
  }
  /* 隐藏房间「公用中转站」解锁：/kkk/ 入口访问过（本次或之前留的标记）→ 调解锁接口永久开启 */
  try {
    if (sessionStorage.getItem('kb_kkk_pending') === '1') {
      sessionStorage.removeItem('kb_kkk_pending')
      Net.relayUnlock().then(() => {
        toast('🔓 已解锁隐藏房间「公用中转站」（仅 CMO 可发言，所有人可查看）', 3600)
        syncConversations()
      }).catch(() => {})
    }
  } catch (e) {}
  /* 应用本地聊天背景偏好 */
  setTimeout(applyChatBg, 50)
  /* 移动端（竖屏）显示 4 图标底部导航 */
  if (typeof isMobile === 'function' && isMobile()) el('mtabNav').hidden = false
  /* 登录动作后：若还有未同意的协议先弹协议；同意后直接落在聊天页。
   * 公告栏不再自动弹出，改为左侧栏的未读红点提示。 */
  setTimeout(() => {
    const needAgree = data.agreement && !data.agreement.agreed
    const fresh = !!(opts && opts.fresh)
    showView('chats')
    if (needAgree) openAgreement(() => showView('chats'))
    /* 离线期间收到的反馈请求：登录后补弹（刚注册的用户本次不弹） */
    if (!needAgree) {
      const justReg = !!(fresh && S.justRegistered)
      S.justRegistered = false
      checkPendingFb(justReg)
    }
  }, 600)
  /* 首次使用：自动进入新手指引（设置里可重看） */
  /* 新手指引只在注册后首次进入时弹出；刷新/重登不再打扰 */
  setTimeout(() => {
    if (typeof maybeAutoGuide === 'function' && opts && opts.fresh && S.justRegistered) maybeAutoGuide()
  }, 3200)
  /* 登录/切换账号/注册后：未设置「忘记密码机制（密保问答）」时必须设置（不可跳过）。
   * 以弹层 id 防重：注册流程与登录共用这一个统一触发点，绝不弹两次。 */
  setTimeout(() => {
    if (document.getElementById('secQuizLayer')) return
    if (!S.profile || S.profile.hasSec3) return
    if (!data.agreement || data.agreement.agreed) openSecQuizSetup()
  }, 2600)
}

/* 保证消息秒达：SSE 之外的高频轮询，跨实例也不漏消息 */
/* ---------- 移动端好友消息提醒（顶部下滑通知条） ---------- */
function showMsgNotify(m) {
  if (!m || m.ownerId === S.uid || m.kind === 'system') return
  if (!isMobile()) return   /* 仅移动端显示；桌面端已有提示音 */
  const quiet = !!(convPref(m.roomId) || {}).quiet
  if (quiet) return
  const c = (S.conversations || []).find(x => x.roomId === m.roomId)
  const fr = (S.friends || []).find(x => x.uid === (c && c.peerUid))
  const name = (fr && fr.name) || (c && c.name) || m.senderName || '新消息'
  const av = (fr && fr.avatar) || (c && c.avatar) || m.senderAvatar || '💬'
  let box = document.getElementById('msgNotify')
  if (!box) {
    box = document.createElement('div')
    box.id = 'msgNotify'
    ;(document.body || document.documentElement).appendChild(box)
  }
  box.innerHTML = '<div class="mn-av">' + avatarHtml(av) + '</div>'
    + '<div class="mn-body"><div class="mn-name">' + esc(name) + '</div>'
    + '<div class="mn-text">' + esc(previewText(m)) + '</div></div>'
  box.onclick = () => {
    box.classList.remove('is-on')
    box.hidden = true
    openRoom(m.roomId, c ? c.kind : undefined)
  }
  box.hidden = false
  requestAnimationFrame(() => box.classList.add('is-on'))
  if (navigator.vibrate) { try { navigator.vibrate(120) } catch (e) {} }
  clearTimeout(showMsgNotify._t)
  showMsgNotify._t = setTimeout(() => {
    box.classList.remove('is-on')
    setTimeout(() => { box.hidden = true }, 300)
  }, 3600)
}

async function pollFallback() {
  if (!S.uid) return
  S.pollTick = (S.pollTick || 0) + 1
  /* 后台标签页：只发低频心跳维持在线状态（约 10 秒一次），不再拉取消息 */
  if (document.hidden) {
    if (S.pollTick % 8 === 0) { try { await Net.ping() } catch (e) {} }
    return
  }
  /* SSE 正常时轮询降频（仅作兜底），SSE 断开立刻恢复高频，兼顾延时与请求量。
   * Cloudflare 部署（pages.dev）无 SSE：2.4s 一轮消息 + 12s 一轮会话，
   * 在保证实时性的同时把请求数控制在免费配额内 */
  const isCF = Net.IS_CF === true
  const sseOk = !isCF && S.netStatus === 'open'
  const msgTick = sseOk ? 3 : (isCF ? 2 : 1)
  const convTick = sseOk ? 12 : (isCF ? 10 : 4)
  try {
    if (S.activeRoom && S.pollTick % msgTick === 0) {
      const r = await Net.messages(S.activeRoom)
      let changed = false
      ;(r.messages || []).forEach(m => { if (absorbIncoming(m)) changed = true })
      if (changed) {
        renderMessages()
        if (S.stickBottom) scrollToBottom()
        const c = S.conversations.find(x => x.roomId === S.activeRoom)
        if (c) { c.unread = 0; renderChatList(); renderRail() }
      }
    }
    if (S.pollTick % convTick === 0) await syncConversations()
  } catch (e) { /* 网络/服务抖动，下一轮继续 */ }
}

function renderAll() {
  renderRail()
  renderChatList()
  renderContacts()
  if (S.activeRoom) { renderChatHeader(); renderMessages() }
}

/* ---------- 实时通道 ---------- */
function connectStream() {
  Net.connect({
    status: s => {
      S.netStatus = s
      if (s === 'reconnecting') toast('连接中断，正在重连…', 1500)
    },
    hello: () => { S.netStatus = 'open' },
    msg: payload => onIncomingMessage(payload.message),
    fbnotice: payload => {
      if (S.profile && S.profile.isAdmin) return
      if (payload.req) openFbReq(payload.req)
    },
    importantAnn: payload => {
      /* 重要 Chat 公告：在线用户立即弹窗（浏览 5 秒确认） */
      if (payload && payload.ann) queueImportantAnn([payload.ann])
    },
    msgdel: payload => {
      /* 撤回（recalled）或管理员删除（removed）：本地同步该消息状态 */
      const m = (S.messages || []).find(x => x.id === payload.msgId)
      if (payload.removed) {
        S.messages = (S.messages || []).filter(x => x.id !== payload.msgId)
      } else if (m) {
        m.kind = 'recalled'
        m.content = ''
      }
      if (S.activeRoom === payload.roomId) renderMessages()
    },
    friends: payload => {
      S.friends = payload.friends || []
      renderContacts()
      /* 好友头像/昵称可能变了：会话列表同步刷新（列表用实时资料渲染） */
      renderChatList()
    },
    groups: payload => {
      const g = payload.group
      if (!g) return
      if (!S.groups.some(x => x.roomId === g.roomId)) S.groups.push(g)
      if (!S.conversations.some(c => c.roomId === g.roomId)) {
        S.conversations.push({
          roomId: g.roomId, kind: 'group', name: g.name, avatar: '\ud83d\udc65',
          members: g.members, memberNames: g.memberNames, lastMsg: null,
          ts: g.createdAt, unread: 0,
        })
      }
      renderContacts()
      renderChatList()
      toast('你被拉入了群聊：' + g.name)
    },
    friendreq: payload => {
      if (typeof payload.count === 'number') S.reqCount = payload.count
      renderContacts()
      if (payload.count > 0) toast('收到新的好友申请，去通讯录处理', 2600)
    },
    friendres: payload => {
      toast((payload.name || '对方') + ' 同意了你的好友申请')
      syncConversations()
    },
    presence: payload => {
      applyPresence(payload.uid, payload.online)
    },
    /* 管理员操作：封禁 / 禁言 / 删除账号 */
    account: payload => {
      if (payload.deleted) {
        toast('你的账号已被管理员删除', 4000)
        logout()
        return
      }
      if (payload.bannedUntil) {
        toast('你已被封禁至 ' + fmtShort(payload.bannedUntil) +
          (payload.reason ? '，原因：' + payload.reason : ''), 5000)
        logout()
        return
      }
      if (payload.mutedUntil) {
        toast('你已被禁言至 ' + fmtShort(payload.mutedUntil), 4000)
        return
      }
      toast('管理员已解除你的账号限制')
    },
    /* 违禁词警告：第 3 次自动封号 */
    warn: payload => {
      toast('⚠ 违禁词警告' + (payload.word ? '：「' + payload.word + '」' : '') +
        ' 第 ' + payload.count + '/3 次' + (payload.banned ? '，账号已被封禁' : ''), 5200)
      if (payload.banned) setTimeout(() => logout(), 1800)
    },
    moment: () => { if (S.view === 'moments') loadMoments() },
    momentreport: () => {
      if (S.profile && S.profile.isAdmin && S.view === 'admin') loadAdminMoments()
    },
    forum: () => { if (S.view === 'forum') loadForum() },
    /* 举报处理结果等系统通知 */
    notice: payload => {
      toast((payload.title ? payload.title + '：' : '') + (payload.text || ''), 6000)
    },
    /* 登录页有新提问（仅管理员会收到） */
    guestask: payload => {
      if (!(S.profile && S.profile.isAdmin)) return
      toast('登录页有新提问：' + String((payload && payload.text) || '').slice(0, 30), 5000)
      if (S.view === 'feedback') loadFbGuest()
    },
    /* 管理员改了你的昵称：本地资料与被引用到的地方一起刷新 */
    profile: payload => {
      if (!payload || !payload.nickname) return
      if (S.profile) S.profile.nickname = payload.nickname
      renderRail()
      renderChatHeader()
      renderChatList()
      toast('管理员已将您的昵称改为「' + payload.nickname + '」', 6000)
    },
  })
}

/* ---------- 会话右键菜单：置顶 / 复制KB号 / 免打扰 ---------- */
function closeConvMenus() {
  document.querySelectorAll('.ctx-menu, .wxs-layer').forEach(m => m.remove())
}
function openConvContextMenu(x, y, c) {
  closeConvMenus()
  const pref = convPref(c.roomId)
  const peer = c.kind === 'dm' ? S.friends.find(f => f.uid === c.peerUid) : null
  const items = [{ t: pref.pinned ? '📌 取消置顶' : '📌 置顶', fn: () => { setConvPref(c.roomId, { pinned: !pref.pinned }); renderChatList() } }]
  let kbVal = '', kbLabel = ''
  if (c.kind === 'group') { kbVal = c.roomId; kbLabel = '复制群聊 ID' }
  else if (c.kind === 'dm') { kbVal = (peer && peer.wxid) || ''; kbLabel = '复制对方 KB号' }
  if (kbVal) items.push({ t: '📋 ' + kbLabel, fn: () => {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(kbVal).then(() => toast('已复制：' + kbVal, 2000)).catch(() => toast('复制失败'))
    else toast('当前浏览器不支持一键复制', 2200)
  } })
  items.push({ t: pref.quiet ? '🔔 关闭免打扰' : '🔕 消息免打扰', fn: () => { setConvPref(c.roomId, { quiet: !pref.quiet }); renderChatList() } })
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  menu.innerHTML = items.map((it, i) => `<div class="ctx-item" data-i="${i}">${it.t}</div>`).join('')
  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px'
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px'
  menu.addEventListener('click', ev => {
    const it = ev.target.closest('.ctx-item')
    if (!it) return
    const fn = items[Number(it.dataset.i)] && items[Number(it.dataset.i)].fn
    closeConvMenus()
    if (fn) fn()
  })
  setTimeout(() => document.addEventListener('click', closeConvMenus, { once: true }), 0)
}

/* ---------- 聊天设置面板（⋯ 微信风格：置顶 / 免打扰 / 屏蔽 / 删除聊天记录 / 删除好友） ---------- */
function openConvSettings(c) {
  closeConvMenus()
  const pref = convPref(c.roomId)
  const peer = c.kind === 'dm' ? S.friends.find(f => f.uid === c.peerUid) : null
  const isDm = c.kind === 'dm'
  const isCmo = !!(peer && peer.isAdmin)
  const blocked = isDm && peer ? (S.myBlocks || []).includes(peer.uid) : false
  const layer = document.createElement('div')
  layer.className = 'wxs-layer'
  const tg = (id, label, on, dis, tip) =>
    `<div class="wxs-row"${dis ? ' title="' + (tip || '') + '"' : ''}><span>${label}</span>` +
    `<label class="wx-toggle${dis ? ' is-dis' : ''}"><input type="checkbox" id="${id}"${on ? ' checked' : ''}${dis ? ' disabled' : ''}><i></i></label></div>`
  layer.innerHTML = `<div class="wxs-panel">
    <div class="wxs-title">${esc(c.name)} · 聊天设置</div>
    ${tg('wxsPin', '设为置顶', !!pref.pinned)}
    ${tg('wxsQuiet', '消息免打扰', !!pref.quiet)}
    ${isDm ? tg('wxsBlock', '屏蔽此人', blocked, isCmo, isCmo ? 'CMO 是系统账号，不可被屏蔽' : '') : ''}
    ${(S.profile && S.profile.isAdmin && c.kind !== 'ai') ? tg('wxsAdminPin', '全员置顶（管理员）', !!c.pinned) : ''}
    <div class="wxs-row wxs-act" id="wxsClear"><span>删除聊天记录</span><span class="wxs-go">›</span></div>
    ${isDm && !isCmo ? '<div class="wxs-row wxs-act wxs-danger" id="wxsDelFriend"><span>删除好友</span></div>' : ''}
    ${isDm && isCmo ? '<div class="wxs-note">CMO 是系统账号，不可被屏蔽或删除</div>' : ''}
  </div>`
  document.body.appendChild(layer)
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  const q = sel => layer.querySelector(sel)
  q('#wxsPin').onchange = e => { setConvPref(c.roomId, { pinned: e.target.checked }); renderChatList() }
  q('#wxsQuiet').onchange = e => { setConvPref(c.roomId, { quiet: e.target.checked }); renderChatList() }
  const blk = q('#wxsBlock')
  if (blk) blk.onchange = async e => {
    const on = e.target.checked
    if (on && !confirm('屏蔽后你和对方都将无法再发送消息，确定屏蔽「' + (peer.nickname || '') + '」？')) { e.target.checked = false; return }
    try {
      await Net.blockUser(peer.uid, on)
      S.myBlocks = on ? (S.myBlocks || []).concat([peer.uid]) : (S.myBlocks || []).filter(u => u !== peer.uid)
      toast(on ? '已屏蔽，双方都无法再发消息' : '已取消屏蔽', 2200)
    } catch (err) { toast(err.message || '操作失败'); e.target.checked = !on }
  }
  const apin = q('#wxsAdminPin')
  if (apin) apin.onchange = async e => {
    try {
      await Net.adminAction('', c.pinned ? 'unpin' : 'pin', { roomId: c.roomId })
      toast(c.pinned ? '已取消全员置顶' : '已全员置顶，所有人可见', 2200)
      await syncConversations()
    } catch (err) { toast(err.message || '操作失败'); e.target.checked = !e.target.checked }
  }
  q('#wxsClear').onclick = async () => {
    if (!confirm('删除该会话的全部聊天记录？不可恢复（只影响你自己这边，对方仍可见）。')) return
    try {
      if (c.roomId === 'ai_chat') {
        S.messages = S.messages.filter(m => m.roomId !== 'ai_chat')
        try { localStorage.removeItem(aiHistKey()) } catch (e) {}
        renderMessages()
      } else {
        const r = await Net.convClear(c.roomId)
        S.messages = S.messages.filter(m => m.roomId !== c.roomId)
        renderMessages()
        toast('已删除 ' + ((r && r.count) || 0) + ' 条聊天记录', 2200)
      }
      layer.remove()
    } catch (e) { toast(e.message || '操作失败') }
  }
  const del = q('#wxsDelFriend')
  if (del) del.onclick = async () => {
    if (!confirm('删除好友「' + (peer.nickname || '') + '」？双方好友关系将被移除。')) return
    try {
      await Net.deleteFriend(peer.uid)
      layer.remove()
      S.friends = S.friends.filter(f => f.uid !== peer.uid)
      S.conversations = S.conversations.filter(x => x.roomId !== c.roomId)
      if (S.activeRoom === c.roomId) leaveChat()
      renderChatList()
      toast('已删除好友', 2200)
    } catch (e) { toast(e.message || '操作失败') }
  }
}

/* ---------- 好友/自己资料卡（微信式：点头像弹出） ---------- */
function profileCardData(uid) {
  const self = !!(S.profile && uid === S.profile.uid)
  if (self) {
    return { self: true, uid, name: S.profile.nickname || S.profile.name || '我', wxid: S.profile.wxid || '', avatar: S.profile.avatar || '', level: S.profile.level || 1, isAdmin: !!S.profile.isAdmin, online: true, isFriend: false }
  }
  const f = (S.friends || []).find(x => x.uid === uid)
  if (f) return { self: false, uid, name: f.name || f.nickname || '未命名', wxid: f.wxid || '', avatar: f.avatar || '', level: f.level || 1, isAdmin: !!f.isAdmin, online: !!f.online, isFriend: true }
  /* 非好友（群成员等）：从群成员名映射里找 */
  let name = ''
  let avatar = ''
  for (const g of (S.groups || [])) {
    if ((g.members || []).includes(uid)) {
      const idx = g.members.indexOf(uid)
      name = (g.memberNames || [])[idx] || ''
      break
    }
  }
  if (!name) {
    const conv = (S.conversations || []).find(c => (c.members || []).includes(uid))
    if (conv && conv.memberNames && !Array.isArray(conv.memberNames)) name = conv.memberNames[uid] || ''
  }
  return { self: false, uid, name: name || '用户', wxid: '', avatar, level: 1, isAdmin: false, online: false, isFriend: false }
}

function openProfileCard(uid) {
  if (!uid) return
  const p = profileCardData(uid)
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  const onlineHtml = p.self ? '<span class="online-dot"></span> 在线'
    : (p.isFriend ? (p.online ? '<span class="online-dot"></span> 在线' : '<span style="color:#bbb">离线</span>') : '')
  const lvHtml = p.isAdmin ? '<span class="tag tag-cmo">CMO</span>' : ''
  const rows = []
  if (!p.self) rows.push('<button class="pc-row" id="pcMsg">💬 发消息</button>')
  rows.push('<button class="pc-row" id="pcMoments">🌄 朋友圈</button>')
  if (p.isFriend) rows.push('<button class="pc-row pc-danger" id="pcDelFriend">🗑 删除好友</button>')
  if (p.self) rows.push('<button class="pc-row pc-danger" id="pcLogout">⎋ 退出登录</button>')
  layer.innerHTML = `<div class="qr-box pc-box">
    <div class="pc-head">
      <div class="pc-av">${avatarHtml(p.avatar)}</div>
      <div class="pc-id">
        <div class="pc-name">${esc(p.name)}${lvHtml}</div>
        ${p.wxid ? `<div class="pc-kb">KB号：<b>${esc(p.wxid)}</b></div>` : ''}
        ${onlineHtml ? `<div class="pc-online">${onlineHtml}</div>` : ''}
      </div>
    </div>
    <div class="pc-actions">${rows.join('')}</div>
    <div class="modal-btns"><button class="btn-ghost" id="pcClose">关闭</button></div>
  </div>`
  document.body.appendChild(layer)
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  layer.querySelector('#pcClose').onclick = () => layer.remove()
  const mv = layer.querySelector('#pcMoments')
  if (mv) mv.onclick = () => { layer.remove(); showView('moments') }
  const pm = layer.querySelector('#pcMsg')
  if (pm) pm.onclick = () => { layer.remove(); openDirect(p.uid, p.name, p.avatar) }
  const pd = layer.querySelector('#pcDelFriend')
  if (pd) pd.onclick = async () => {
    if (!confirm('删除好友「' + p.name + '」？双方好友关系将被移除。')) return
    try {
      await Net.deleteFriend(p.uid)
      layer.remove()
      const roomId = typeof dmRoomId === 'function' ? dmRoomId(S.uid, p.uid) : null
      S.friends = S.friends.filter(f => f.uid !== p.uid)
      S.conversations = S.conversations.filter(x => x.roomId !== roomId)
      if (S.activeRoom === roomId) leaveChat()
      renderChatList(); renderContacts(); renderRail()
      toast('已删除好友', 2200)
    } catch (e) { toast(e.message || '操作失败') }
  }
  const pl = layer.querySelector('#pcLogout')
  if (pl) pl.onclick = async () => {
    if (!confirm('确定退出登录吗？')) return
    layer.remove()
    await logout()
  }
}

/* ---------- 设置页「检查更新」 ---------- */
function openCheckUpdate() {
  const latest = (window.KB_LATEST_APK || '1.2.0')
  const em = /KBChatExe\/([\d.]+)/.exec(navigator.userAgent)
  const m = /KBChatApp\/([\d.]+)/.exec(navigator.userAgent)
  /* 桌面版（exe）：功能与网页版同步更新，不提供任何 APK 下载入口 */
  if (em) {
    const layer = document.createElement('div')
    layer.className = 'qr-layer'
    layer.innerHTML = '<div class="qr-box"><h3 style="text-align:center">💻 桌面版</h3>'
      + '<p class="muted" style="text-align:center">当前版本 v' + esc(em[1]) + '<br>桌面版功能与网页版实时同步，无需手动更新<br>重新打开即加载最新功能</p>'
      + '<div class="modal-btns"><button class="btn-ghost" id="cuCancel">好的</button></div></div>'
    document.body.appendChild(layer)
    layer.onclick = e => { if (e.target === layer) layer.remove() }
    layer.querySelector('#cuCancel').onclick = () => layer.remove()
    return
  }
  const cur = m ? m[1] : null
  const v2n = v => v.split('.').map(x => parseInt(x, 10) || 0)
  let outdated = false
  if (cur) {
    const a = v2n(cur), b = v2n(latest)
    outdated = a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
  }
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  let inner
  if (cur && !outdated) {
    inner = '<h3 style="text-align:center">✅ 已是最新版本</h3>'
      + '<p class="muted" style="text-align:center">当前版本 v' + esc(cur) + '，暂无新版本</p>'
      + '<div class="modal-btns"><button class="btn-ghost" id="cuCancel">取消</button></div>'
  } else if (cur) {
    inner = '<h3 style="text-align:center">🔄 发现新版本 v' + esc(latest) + '</h3>'
      + '<p class="muted" style="text-align:center">当前版本 v' + esc(cur) + '<br>更新后即可体验最新功能</p>'
      + '<div class="modal-btns"><button class="btn-ghost" id="cuCancel">取消</button>'
      + '<a class="btn-primary" href="/kbchat.apk?v=2.0.0" download="KBChat.apk" style="display:flex;align-items:center;justify-content:center;text-decoration:none;color:#fff">立即更新</a></div>'
  } else {
    inner = '<h3 style="text-align:center">📱 手机版 App</h3>'
      + '<p class="muted" style="text-align:center">当前为网页端 · App 最新版本 v' + esc(latest) + '<br>下载安装后可在 App 内一键更新</p>'
      + '<div class="modal-btns"><button class="btn-ghost" id="cuCancel">取消</button>'
      + '<a class="btn-primary" href="/kbchat.apk?v=2.0.0" download="KBChat.apk" style="display:flex;align-items:center;justify-content:center;text-decoration:none;color:#fff">下载 App</a></div>'
  }
  layer.innerHTML = '<div class="qr-box">' + inner + '</div>'
  document.body.appendChild(layer)
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  layer.querySelector('#cuCancel').onclick = () => layer.remove()
}

/* 消息合并（SSE 与轮询共用）：自己的消息若与乐观渲染占位（pending/failed）同内容，
 * 先移除占位再合并，避免「正式消息 + 占位消息」重复显示 */
function absorbIncoming(m) {
  if (!m) return false
  if (m.ownerId === S.uid && m.kind !== 'system' && (m.id || '').indexOf('tmp_') !== 0) {
    const dupe = (S.messages || []).find(x =>
      (x.pending || x.failed) && (x.id || '').indexOf('tmp_') === 0 &&
      x.roomId === m.roomId && x.kind === m.kind && x.content === m.content)
    if (dupe) S.messages = S.messages.filter(x => x.id !== dupe.id)
  }
  if (!S.messages.some(x => x.id === m.id)) {
    S.messages.push(m)
    return true
  }
  return false
}

function onIncomingMessage(m) {
  if (!m) return
  const quietConv = !!(convPref(m.roomId) || {}).quiet
  /* 他人发来的消息：按设置播放提示音（免打扰会话不响） */
  if (m.ownerId !== S.uid && m.kind !== 'system' && !quietConv) playMsgSound()
  /* 对方刚发消息 = 一定在线：立即点亮在线标志，不等下一轮会话刷新 */
  if (m.ownerId !== S.uid && m.kind !== 'system' && !m.roomId.startsWith('grp_')) {
    const oc = S.conversations.find(x => x.roomId === m.roomId)
    if (oc && !oc.online) {
      oc.online = true
      if (oc.roomId === S.activeRoom) renderChatHeader()
    }
  }
  if (m.roomId === S.activeRoom) {
    if (absorbIncoming(m)) {
      renderMessages()
      if (S.stickBottom) scrollToBottom()
      else if (m.ownerId !== S.uid) { S.jumpNew = (S.jumpNew || 0) + 1; if (typeof updateJumpPill === 'function') updateJumpPill() }
    }
    Net.read(m.roomId).catch(() => {})
  } else {
    const c = S.conversations.find(x => x.roomId === m.roomId)
    if (c) {
      /* 免打扰：不累计红点数字，但仍更新预览与时间 */
      c.unread = (c.unread || 0) + (m.ownerId === S.uid || quietConv ? 0 : 1)
      c.lastMsg = m
      c.ts = m.createdAt
    } else {
      // 首次收到该会话消息，拉一次完整会话列表
      syncConversations()
    }
    showMsgNotify(m)
    renderChatList()
    renderRail()
    /* 正在向上翻看时收到新消息：悬浮球计数 +1 */
    if (m.roomId === S.activeRoom && !S.stickBottom && m.ownerId !== S.uid) {
      S.jumpNew = (S.jumpNew || 0) + 1
      if (typeof updateJumpPill === 'function') updateJumpPill()
    }
  }
}

async function syncConversations() {
  if (!S.uid) return
  try {
    const data = await Net.bootstrap()
    const active = S.activeRoom
    S.friends = data.friends || []
    S.groups = data.groups || []
    S.conversations = data.conversations || []
    S.profile = data.me || S.profile
    if (typeof data.reqCount === 'number' && data.reqCount !== S.reqCount) {
      S.reqCount = data.reqCount
      renderContacts()
      if (S.reqCount > 0) toast('收到 ' + S.reqCount + ' 条好友申请', 1800)
    }
    renderRail()
    renderChatList()
    renderContacts()
    if (active) renderChatHeader()
  } catch (e) { /* 静默，下一轮再试 */ }
}

/* ---------- 打开会话 ---------- */
async function openRoom(roomId, kind) {
  /* 小靠AI：本地虚拟会话（历史存本地，AI 回复不落服务端） */
  if (roomId === 'ai_chat') {
    S.activeRoom = 'ai_chat'
    S.activeKind = 'ai'
    /* 重新打开即新对话（旧对话在「🕘 历史对话」里查看） */
    S.messages = []
    S.aiSessionId = null
    S.stickBottom = true
    clearReply()
    document.body.classList.add('ai-open')
    renderAiSidebar()
    el('emptyChat').hidden = true
    el('composer').hidden = false
    el('aiBar').hidden = false
    el('composer').classList.add('ai-mode')
    const mb = document.querySelector('#aiMode button.is-on')
    const mbBtn = el('aiModeBtn')
    if (mb && mbBtn) mbBtn.innerHTML = mb.childNodes[0].textContent.trim() + ' <span class="ai-caret">▾</span>'
    renderChatHeader()
    renderMessages()
    renderChatList()
    enterChat('ai_chat')
    scrollToBottom()
    return
  }
  el('aiBar').hidden = true
  el('composer').classList.remove('ai-mode')
  document.body.classList.remove('ai-open')
  const oldGrid = document.getElementById('aiPlusGrid')
  if (oldGrid) oldGrid.remove()
  S.activeRoom = roomId
  S.activeKind = kind || (roomId.startsWith('grp_') ? 'group' : 'dm')
  S.messages = []
  S.stickBottom = true
  clearReply()
  /* 打开会话立即清零本地未读（不等网络返回），红点马上消失 */
  const oc0 = S.conversations.find(x => x.roomId === roomId)
  if (oc0 && oc0.unread) { oc0.unread = 0; renderChatList(); renderRail() }
  el('emptyChat').hidden = true
  el('composer').hidden = false
  /* 公用中转站：非 CMO 输入框只读（提示仅 CMO 可发言），CMO 正常 */
  try {
    const mi = el('msgInput')
    if (roomId === 'kkk' && !(S.profile && S.profile.isAdmin)) {
      mi.disabled = true
      mi.placeholder = '🚉 公用中转站 · 仅 CMO 可发言，所有人可查看'
    } else {
      mi.disabled = false
    }
  } catch (e) {}
  renderChatHeader()
  renderMessages()
  renderChatList()
  enterChat(roomId)

  try {
    const r = await Net.messages(roomId)
    /* 房间守卫：异步响应期间用户可能已切换会话，过期响应直接丢弃（防串会话） */
    if (S.activeRoom !== roomId) return
    S.messages = r.messages || []
    renderMessages()
    scrollToBottom()
    await Net.read(roomId)
    if (S.activeRoom !== roomId) return
    const c = S.conversations.find(x => x.roomId === roomId)
    if (c) c.unread = 0
    renderChatList()
    renderRail()
  } catch (e) {
    toast(e.message || '消息加载失败')
  }
}

async function openDirect(peerUid, name, avatar) {
  const room = dmRoomId(S.uid, peerUid)
  if (!S.conversations.some(c => c.roomId === room)) {
    S.conversations.push({
      roomId: room, kind: 'dm', name: name || '陌生人', avatar: avatar || '',
      members: dmMembers(S.uid, peerUid), lastMsg: null,
      ts: new Date().toISOString(), unread: 0, peerUid,
    })
  }
  await openRoom(room, 'dm')
}

/* ---------- 发送 ---------- */
async function sendText() {
  if (!S.activeRoom) return
  const input = el('msgInput')
  const text = input.value.replace(/\s+$/, '')
  if (S.activeRoom === 'ai_chat') {
    if (!text && !aiPendingImages.length) return
    input.value = ''; updateSendBtn()
    const imgs = aiPendingImages.splice(0)
    renderAiPending()
    await aiSend(text, imgs)
    return
  }
  if (!text) return
  input.value = ''   /* 先清空输入框再发送：发送期间即可继续打字 */
  const ref = replyTo
  updateSendBtn()
  await doSend('text', text, null, { ref })
  clearReply()
}

/* ---------- 小靠AI：聊天内 AI 助手（快速/深度/专家 + 识图） ---------- */
function aiHistKey() { return 'kbchat_ai_hist_' + (S.uid || 'guest') }
/* 会话历史函数在下方「AI 会话历史」区块（saveAiHistory / loadAiSessions 等） */
/* ---------- 小靠AI：会话历史（新对话 / 历史对话） ---------- */
function aiSessionsKey() { return 'kbchat_ai_sessions_' + (S.uid || 'guest') }
function loadAiSessions() {
  try { const a = JSON.parse(localStorage.getItem(aiSessionsKey()) || '[]'); return Array.isArray(a) ? a : [] } catch (e) { return [] }
}
function saveAiSessions(list) {
  try { localStorage.setItem(aiSessionsKey(), JSON.stringify(list.slice(-30))) } catch (e) {}
}
function saveAiHistory() {
  /* 当前 AI 会话 upsert 进历史列表（首次发言时创建），旧对话随时可回看 */
  const msgs = (S.messages || []).filter(m => m.roomId === 'ai_chat' && !m.typing)
  if (!msgs.length) return
  if (!S.aiSessionId) S.aiSessionId = 's' + Date.now().toString(36)
  const list = loadAiSessions()
  const firstUser = msgs.find(m => m.ownerId === S.uid && m.kind === 'text')
  const title = ((firstUser && firstUser.content) || '新对话').slice(0, 24)
  const entry = { id: S.aiSessionId, title, at: new Date().toISOString(), count: msgs.length, messages: msgs.slice(-60) }
  const idx = list.findIndex(x => x.id === S.aiSessionId)
  if (idx > -1) list[idx] = entry; else list.push(entry)
  saveAiSessions(list)
}
function aiNewChat() {
  saveAiHistory()
  S.aiSessionId = null
  S.messages = S.messages.filter(m => m.roomId !== 'ai_chat')
  renderMessages(); scrollToBottom()
  renderAiSidebar()
  toast('已开始新对话', 1600)
}
function aiOpenHistory() {
  let list = loadAiSessions()
  if (!list.length) {
    /* 旧版单历史迁移 */
    try {
      const old = JSON.parse(localStorage.getItem(aiHistKey()) || '[]')
      if (Array.isArray(old) && old.length) {
        list = [{ id: 'legacy', title: '旧对话', at: new Date().toISOString(), count: old.length, messages: old.slice(-60) }]
        saveAiSessions(list)
      }
    } catch (e) {}
  }
  if (!list.length) { toast('还没有历史对话'); return }
  list.sort((a, b) => new Date(b.at) - new Date(a.at))
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.style.zIndex = 420
  layer.innerHTML = `<div class="qr-box" style="max-width:420px">
    <h3>🕘 AI 对话历史</h3>
    <div class="ai-hist-list">${list.map(s =>
      `<div class="ai-hist-item" data-id="${esc(s.id)}"><div class="ai-hist-title">${esc(s.title)}</div><div class="ai-hist-meta">${s.count} 条 · ${esc(fmtFull(s.at))}</div></div>`
    ).join('')}</div>
    <div class="modal-btns"><button class="btn-primary" id="aiHistClose">关闭</button></div>
  </div>`
  document.body.appendChild(layer)
  layer.onclick = e => {
    if (e.target === layer) return layer.remove()
    const item = e.target.closest('.ai-hist-item')
    if (!item) return
    const s = list.find(x => x.id === item.dataset.id)
    if (!s) return
    layer.remove()
    if (S.activeRoom !== 'ai_chat') openRoom('ai_chat')
    S.aiSessionId = s.id
    S.messages = (s.messages || []).slice()
    renderMessages(); scrollToBottom()
    toast('已打开历史对话', 1800)
  }
  layer.querySelector('#aiHistClose').onclick = () => layer.remove()
}
/* 小靠AI 头像：绿色渐变 + 可爱小机器人（data URI SVG，会话列表 / 消息气泡通用） */
const AI_AVATAR = "/assets/kb-avatar.png"   /* K 品牌头像（已去水印） */

function ensureAiConversation() {
  if (!S.uid) return
  if (!S.conversations.some(c => c.roomId === 'ai_chat')) {
    S.conversations.unshift({
      roomId: 'ai_chat', kind: 'ai', name: '小靠AI', avatar: AI_AVATAR,
      members: [S.uid], lastMsg: null, ts: Date.now(), unread: 0,
    })
  }
}
let aiPendingImages = []
async function aiSend(text, images) {
  /* 排队机制：上一条还在回答时，新提问进入队列，回答结束后自动发送。
   * 此前是 if (S.sending) return 直接丢弃——用户连续提问时消息凭空消失，看似"发送无效"。 */
  if (S.aiBusy) {
    (S.aiQueue = S.aiQueue || []).push({ text, images })
    toast('AI 正在回答上一条，这条已排队自动发送')
    return
  }
  S.aiBusy = true
  const now = Date.now()
  ;(images || []).forEach(url => S.messages.push({
    id: 'ai_u' + now + Math.random().toString(36).slice(2, 6), roomId: 'ai_chat', ownerId: S.uid,
    kind: 'image', content: url, senderName: '我', createdAt: new Date(now).toISOString(),
  }))
  if (text) S.messages.push({
    id: 'ai_u' + now, roomId: 'ai_chat', ownerId: S.uid,
    kind: 'text', content: text, senderName: '我', createdAt: new Date(now).toISOString(),
  })
  /* AI 正在输入占位 */
  const typing = {
    id: 'ai_typing', roomId: 'ai_chat', ownerId: 'ai', kind: 'text',
    content: '小靠AI 正在思考…', senderName: '小靠AI', senderAvatar: AI_AVATAR,
    createdAt: new Date(now + 1).toISOString(), typing: true,
  }
  S.messages.push(typing)
  renderMessages(); scrollToBottom(); saveAiHistory()
  /* AI 思考动态：短语轮换（气泡被正式回答替换后自动停止） */
  const thinkPhrases = ['正在理解问题', '正在检索记忆', '正在组织语言', '正在斟酌措辞', '马上就好']
  let thinkIdx = 0
  const thinkTimer = setInterval(() => {
    const lb = document.querySelector('#msgStack .ai-think-label')
    if (!lb) { clearInterval(thinkTimer); return }
    thinkIdx = (thinkIdx + 1) % thinkPhrases.length
    lb.textContent = (m0name()) + ' ' + thinkPhrases[thinkIdx]
  }, 1800)
  function m0name() { return typing.senderName || '小靠AI' }
  const mode = (document.querySelector('#aiMode button.is-on') || {}).dataset ? document.querySelector('#aiMode button.is-on').dataset.am : 'quick'
  const model = el('aiModel').value
  const history = (S.messages || [])
    .filter(m => m.id !== 'ai_typing' && (m.kind === 'text' || m.kind === 'image'))
    .slice(-10)
    .map(m => ({
      role: m.ownerId === S.uid ? 'user' : 'assistant',
      content: m.kind === 'image' ? '[用户发送了一张图片]' : String(m.content || ''),
    }))
  try {
    let streamed = false
    /* 流式输出：文本和图片提问都走流式（打字机效果）；失败时回退整段返回 */
    {
      try {
        const resp = await fetch((Net.API_BASE || '') + '/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Token': Net.token || '' },
          body: JSON.stringify({ mode, model, messages: history, question: text || '请理解我发送的图片', images: images || [], stream: true, lang: aiLang() }),
        })
        if (!resp.ok) {
          /* 业务错误（限流/服务异常）：直接把后端原因报给用户，不再发起第二次请求 */
          let em = 'AI 服务暂时不可用（' + resp.status + '）'
          try { const j = await resp.json(); if (j && j.error) em = j.error } catch (e2) {}
          const err = new Error(em); err.fatal = true; throw err
        }
        if (resp.body && (resp.headers.get('content-type') || '').indexOf('text/plain') > -1) {
          const reader = resp.body.getReader()
          const dec = new TextDecoder()
          let buf = '', meta = null, full = '', lastRender = 0
          while (true) {
            const rd = await reader.read()
            if (rd.done) break
            buf += dec.decode(rd.value, { stream: true })
            if (!meta) {
              const nl = buf.indexOf('\n')
              if (nl < 0) continue
              try { meta = JSON.parse(buf.slice(0, nl)) } catch (e) { meta = {} }
              buf = buf.slice(nl + 1)
              if (meta && meta.searchNote) full = (meta.searchNote.indexOf('⚠️') === 0 ? '' : '🔎 ') + meta.searchNote + '\n\n'
            }
            if (buf) { full += buf; buf = '' }
            const now = Date.now()
            if (now - lastRender > 90) {
              lastRender = now
              typing.content = full + ' ▌'
              renderMessages()
              if (S.stickBottom) scrollToBottom()
            }
          }
          if (full.trim()) {
            Object.assign(typing, { id: 'ai_a' + Date.now(), content: full, typing: false })
            streamed = true
          }
        }
      } catch (e) {
        /* 业务错误（fatal）直接向上抛给最外层展示；真正的传输异常才回退整段请求 */
        if (e && e.fatal) throw e
      }
    }
    if (!streamed) {
      const r = await Net.aiChat({ mode, model, messages: history, question: text || '请理解我发送的图片', images, lang: aiLang() })
      Object.assign(typing, {
        id: 'ai_a' + Date.now(), content: (r.searchNote ? (r.searchNote.indexOf('⚠️') === 0 ? '' : '🔎 ') + r.searchNote + '\n\n' : '') + (r.reply || '（空回复）'),
        typing: false,
      })
    }
  } catch (e) {
    Object.assign(typing, {
      id: 'ai_err' + Date.now(), content: '⚠️ ' + (e.message || 'AI 服务暂时不可用'), typing: false,
    })
  } finally {
    S.aiBusy = false
    /* 队列里有排队提问：接续发送 */
    const q = (S.aiQueue || []).shift()
    if (q) setTimeout(() => { aiSend(q.text, q.images).catch(() => {}) }, 400)
  }
  renderMessages(); scrollToBottom(); saveAiHistory()
}

/* ---------- 语音消息：MediaRecorder 录音 → 上传 → kind:voice（最长 60 秒） ---------- */
let mediaRec = null, mediaChunks = [], mediaStream = null, recTimer = null, recStart = 0
async function toggleVoiceRecord() {
  if (mediaRec && mediaRec.state === 'recording') { mediaRec.stop(); return }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('当前浏览器不支持录音'); return }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) { toast('无法访问麦克风，请检查权限设置'); return }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
  mediaChunks = []
  try { mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined) }
  catch (e) { mediaStream.getTracks().forEach(t => t.stop()); toast('录音初始化失败'); return }
  mediaRec.ondataavailable = e => { if (e.data && e.data.size) mediaChunks.push(e.data) }
  mediaRec.onstop = async () => {
    clearInterval(recTimer)
    mediaStream.getTracks().forEach(t => t.stop())
    const ms = Date.now() - recStart
    const dur = Math.max(1, Math.round(ms / 1000))
    el('btnVoice').classList.remove('recording')
    el('btnVoice').textContent = el('composer') && el('composer').classList.contains('voice-mode') ? '⌨️' : '🎙️'
    const blob = new Blob(mediaChunks, { type: mediaRec.mimeType || 'audio/webm' })
    mediaRec = null
    /* 微信逻辑：短于 1 秒视为误触，丢弃不发送 */
    if (ms < 900 || blob.size < 800) { toast('说话时间太短'); return }
    if (blob.size > 12 * 1024 * 1024) { toast('语音太长，请控制在 60 秒内'); return }
    if (!S.activeRoom) { toast('请先选择一个会话'); return }
    try {
      toast('正在发送语音…', 1600)
      const file = new File([blob], 'voice.' + (blob.type.indexOf('mp4') > -1 ? 'm4a' : 'webm'), { type: blob.type })
      const url = await Net.uploadFile(file)
      await doSend('voice', url, '', { dur })
    } catch (e) { toast(e.message || '语音发送失败') }
  }
  recStart = Date.now()
  mediaRec.start()
  el('btnVoice').classList.add('recording')
  el('btnVoice').textContent = '⏹'
  const holdOn = el('composer') && el('composer').classList.contains('voice-mode')
  toast(holdOn ? '正在录音，松开手指发送（最长 60 秒）' : '正在录音，再次点击发送（最长 60 秒）', 2600)
  recTimer = setInterval(() => {
    if (Date.now() - recStart >= 60000 && mediaRec && mediaRec.state === 'recording') mediaRec.stop()
  }, 500)
}
/* 气泡内播放/暂停（renderMessages 内联 onclick 调用） */
window.playVoice = function (elx) {
  if (elx._audio) {
    if (elx._audio.paused) elx._audio.play().catch(() => toast('语音播放失败'))
    else { elx._audio.pause(); elx._audio.currentTime = 0 }
    return
  }
  const a = new Audio(elx.dataset.src)
  elx._audio = a
  elx.classList.add('playing')
  const p = elx.querySelector('.voice-play')
  if (p) p.textContent = '⏸'
  const stop = () => { elx.classList.remove('playing'); const pp = elx.querySelector('.voice-play'); if (pp) pp.textContent = '▶' }
  a.onended = stop
  a.onpause = stop
  a.onerror = () => { stop(); toast('语音播放失败') }
  a.play().catch(() => { stop(); toast('语音播放失败') })
}

/* 发送锁：按会话各自加锁（不再全局单条锁），等待期间同会话防连点、其他会话照常发 */
S.sendingMap = S.sendingMap || {}

async function doSend(kind, content, fileName, extra) {
  const rid = S.activeRoom
  if (!rid) return
  /* 公用中转站（隐藏房间）：仅 CMO 可发言（前端守卫，服务端同样校验 403） */
  if (rid === 'kkk' && !(S.profile && S.profile.isAdmin)) {
    toast('公用中转站仅 CMO 可以发言，所有人可查看')
    return
  }
  if (S.sendingMap[rid]) { toast('上一条还在发送中，请稍候'); return }
  /* 乐观渲染：先插一条 pending 临时消息，马上显示马上滚到底（服务器返回后原地替换） */
  const tmp = {
    id: 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    roomId: rid, ownerId: S.uid, kind, content,
    senderName: (S.profile && S.profile.nickname) || '我',
    senderAvatar: (S.profile && S.profile.avatar) || '',
    createdAt: new Date().toISOString(),
    fileName: kind === 'file' ? (fileName || '') : '',
    dur: kind === 'voice' ? Math.min(300, Math.max(1, Math.round(Number(extra && extra.dur) || 1))) : 0,
    ref: (extra && extra.ref) || null,
    pending: true,
    _resend: { kind, content, fileName, extra },
  }
  S.messages.push(tmp)
  if (S.activeRoom === rid) renderMessages()
  scrollToBottom()
  const c0 = S.conversations.find(x => x.roomId === rid)
  if (c0) { c0.lastMsg = tmp; c0.ts = tmp.createdAt; c0.unread = 0; renderChatList() }

  const p = (async () => {
    try {
      const m = await Net.send(rid, kind, content, fileName, extra && extra.dur, extra && extra.ref)
      /* 成功：按 tmp.id 找到占位消息原地替换为服务端正式消息。
       * 若轮询已提前把同一条正式消息拉进列表，则移除占位（避免同 id 两条） */
      const t = S.messages.find(x => x.id === tmp.id)
      if (t) {
        const at = S.messages.indexOf(t)
        if (S.messages.some(x => x.id === m.id && x !== t)) S.messages.splice(at, 1)
        else S.messages[at] = m
      } else if (!S.messages.some(x => x.id === m.id)) {
        S.messages.push(m)
      }
      if (S.activeRoom === rid) renderMessages()
      scrollToBottom()
      const c = S.conversations.find(x => x.roomId === rid)
      if (c) { c.lastMsg = m; c.ts = m.createdAt; c.unread = 0; renderChatList() }
    } catch (e) {
      /* 失败：占位消息标红 + 重发按钮，输入框内容早已清空不再回填（消息内容保留在气泡里可复制） */
      const t = S.messages.find(x => x.id === tmp.id)
      if (t) { t.pending = false; t.failed = true; t.errText = (e && e.message) || '发送失败' }
      if (S.activeRoom === rid) renderMessages()
      renderChatList()
      toast(t ? (t.errText + '，点击气泡旁的 ↻ 可重发') : (e && e.message) || '发送失败', 3200)
    }
  })()
  S.sendingMap[rid] = p
  const clear = () => { if (S.sendingMap[rid] === p) delete S.sendingMap[rid] }
  p.then(clear, clear)
  await p
}

/* 重发失败的占位消息：移除旧占位 → 按原参数重新走一次乐观发送（重发按钮只出现在当前会话） */
async function resendFailed(tmpId) {
  const t = S.messages.find(x => x.id === tmpId)
  if (!t || !t.failed || !t._resend) return
  const r = t._resend
  S.messages = S.messages.filter(x => x.id !== tmpId)
  renderMessages()
  await doSend(r.kind, r.content, r.fileName, r.extra)
}

async function sendImage(file) {
  if (!file) return
  if (file.size > 20 * 1024 * 1024) { toast('图片不能超过 20MB'); return }
  toast('正在上传图片…', 1500)
  try {
    const url = await Net.uploadImage(file)   /* >1.4MB 自动压缩到 D1 安全体积 */
    await doSend('image', url)
  } catch (e) {
    toast(e.message || '图片上传失败')
  }
}

/* ---------- 添加好友 ---------- */
async function doSearchUser() {
  const kw = el('searchUid').value.trim()
  const box = el('searchResult')
  if (!kw) { box.innerHTML = '<p class="muted">请输入KB号或昵称</p>'; return }
  box.innerHTML = '<p class="muted">搜索中…</p>'
  try {
    const r = await Net.search(kw)
    const list = r.users || []
    if (!list.length) { box.innerHTML = '<p class="muted">没有找到该用户</p>'; return }
    box.innerHTML = list.map(u => `
      <div class="user-row">
        <div class="u-av">${avatarHtml(u.avatar)}</div>
        <div class="u-info">
          <div class="u-name">${esc(u.nickname)}${u.online ? ' <span class="online-dot"></span>' : ''}</div>
          <div class="u-wx">KB号：${esc(u.wxid)}</div>
        </div>
        <button class="mini-btn ${u.isFriend ? 'gray' : ''}" data-add="${esc(u.uid)}"
          data-name="${esc(u.nickname)}" data-av="${esc(u.avatar)}">${u.isFriend ? '已是好友' : '申请添加'}</button>
      </div>`).join('')
    box.querySelectorAll('button[data-add]').forEach(b => {
      b.onclick = async () => {
        if (b.classList.contains('gray')) return
        try {
          openFriendReqModal(b.dataset.add, b.dataset.name, async (msg) => {
            const r = await Net.addFriend(b.dataset.add, msg)
          b.classList.add('gray')
          b.classList.add('gray')
          if (r.auto) { b.textContent = '已是好友'; toast('已添加 ' + b.dataset.name + ' 为好友') }
          else { b.textContent = '已申请'; toast('申请已发送，等待 ' + b.dataset.name + ' 同意') }
          syncConversations()
          }, b)
        } catch (e) { toast(e.message || '发送失败') }
      }
    })
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '搜索失败')}</p>`
  }
}

/* ---------- 好友申请语弹窗 ---------- */
function openFriendReqModal(uid, name, onSend) {
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  const def = '您好，我是“' + (S.profile ? S.profile.nickname : '') + '”，向您发起好友申请'
  layer.innerHTML = `
    <div class="qr-box">
      <h3>申请添加 ${esc(name)}</h3>
      <div class="field">
        <label>申请语</label>
        <textarea id="frMsg" maxlength="60" rows="2">${esc(def)}</textarea>
      </div>
      <div class="modal-btns">
        <button class="btn-ghost" id="frCancel">取消</button>
        <button class="btn-primary" id="frSend">发送申请</button>
      </div>
    </div>`
  document.body.appendChild(layer)
  layer.querySelector('#frCancel').onclick = () => layer.remove()
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  layer.querySelector('#frSend').onclick = async () => {
    const msg = layer.querySelector('#frMsg').value.trim() || def
    try { await onSend(msg); layer.remove() } catch (e) { toast(e.message || '发送失败') }
  }
}

/* ---------- 我的二维码 ---------- */
function openMyQr() {
  const wxid = S.profile ? S.profile.wxid : ''
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.innerHTML = `
    <div class="qr-box">
      <h3>我的二维码</h3>
      <canvas id="myQrCanvas" style="width:220px;height:220px;background:#fff;border-radius:8px"></canvas>
      <div class="qr-kb">KB号：<b>${esc(wxid)}</b></div>
      <p class="muted" style="font-size:12px">让好友扫一扫或识别这张图，即可向你发起好友申请</p>
      <div class="modal-btns">
        <button class="btn-ghost" id="qrDownload">下载图片</button>
        <button class="btn-primary" id="qrClose">关闭</button>
      </div>
    </div>`
  document.body.appendChild(layer)
  QRCode.render('KB:' + wxid, layer.querySelector('#myQrCanvas'), 220)
  layer.querySelector('#qrClose').onclick = () => layer.remove()
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  layer.querySelector('#qrDownload').onclick = () => {
    const a = document.createElement('a')
    a.href = layer.querySelector('#myQrCanvas').toDataURL('image/png')
    a.download = 'KB号二维码-' + wxid + '.png'
    a.click()
  }
}

/* ---------- 扫一扫 / 相册识别二维码 ---------- */
function openScanModal(mode) {
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.innerHTML = `
    <div class="qr-box">
      <h3>${mode === 'camera' ? '扫一扫' : '从相册识别'}</h3>
      <div id="scanArea" style="min-height:200px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px">
        <p class="muted">${mode === 'camera' ? '正在打开摄像头…' : '选择一张二维码图片'}</p>
      </div>
      <div class="modal-btns"><button class="btn-ghost" id="scanClose">关闭</button></div>
    </div>`
  document.body.appendChild(layer)
  const closeScan = () => { try { if (scanState.stream) scanState.stream.getTracks().forEach(t => t.stop()) } catch (e) {} ; layer.remove() }
  layer.querySelector('#scanClose').onclick = closeScan
  const scanState = { stream: null }

  const showUser = async (kb) => {
    closeScan()
    try {
      const r = await Net.search(kb)
      const u = (r.users || []).find(x => x.wxid === kb) || (r.users || [])[0]
      if (!u) { toast('没有找到该用户：' + kb); return }
      const card = document.createElement('div')
      card.className = 'qr-layer'
      card.innerHTML = `
        <div class="qr-box">
          <div class="u-av" style="margin:0 auto">${avatarHtml(u.avatar)}</div>
          <h3 style="margin:8px 0 2px">${esc(u.nickname)}</h3>
          <div class="muted" style="font-size:12px">KB号：${esc(u.wxid)}</div>
          <div class="modal-btns">
            <button class="btn-ghost" id="ucClose">关闭</button>
            <button class="btn-primary" id="ucAdd">${u.isFriend ? '已是好友' : '申请添加'}</button>
          </div>
        </div>`
      document.body.appendChild(card)
      card.querySelector('#ucClose').onclick = () => card.remove()
      card.querySelector('#ucAdd').onclick = () => {
        if (u.isFriend) { card.remove(); return }
        card.remove()
        openFriendReqModal(u.uid, u.nickname, async (msg) => {
          const r2 = await Net.addFriend(u.uid, msg)
          if (r2.auto) toast('已添加 ' + u.nickname + ' 为好友')
          else { toast('申请已发送，等待 ' + u.nickname + ' 同意'); renderContacts() }
        })
      }
    } catch (e) { toast(e.message || '识别失败') }
  }

  const decode = (canvas) => {
    const c = canvas.getContext('2d')
    const img = c.getImageData(0, 0, canvas.width, canvas.height)
    /* attemptBoth：同时尝试正色/反色（深色模式二维码也能识别） */
    const r = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' })
    if (r && r.data) {
      const kb = String(r.data).replace(/^KB:/, '').trim()
      showUser(kb)
      return true
    }
    return false
  }

  if (mode === 'camera') {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(stream => {
      scanState.stream = stream
      const video = document.createElement('video')
      video.autoplay = true; video.playsInline = true
      video.srcObject = stream
      video.style.maxWidth = '100%'; video.style.borderRadius = '8px'
      const area = layer.querySelector('#scanArea'); area.innerHTML = ''; area.appendChild(video)
      const cv = document.createElement('canvas')
      const tick = () => {
        if (!layer.isConnected) return
        if (video.readyState >= 2) {
          cv.width = video.videoWidth; cv.height = video.videoHeight
          cv.getContext('2d').drawImage(video, 0, 0)
          try { if (decode(cv)) return } catch (e) {}
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }).catch(() => {
      layer.querySelector('#scanArea').innerHTML = '<p class="muted">无法打开摄像头，请改用「🖼 从相册识别」</p>'
    })
  } else {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files && input.files[0]
      if (!f) return
      const img = new Image()
      const rd = new FileReader()
      /* 相册识别：多尺度尝试（原图 → 缩小 → 放大），提高大图/小码的识别率 */
      const tryAlbumDecode = (iw, ih) => {
        const scales = [1]
        const maxSide = Math.max(iw, ih) || 1
        if (maxSide > 1200) scales.push(1200 / maxSide, 800 / maxSide)
        if (maxSide < 400) scales.push(2, 3)
        for (const s of scales) {
          const cv = document.createElement('canvas')
          cv.width = Math.max(1, Math.round(iw * s))
          cv.height = Math.max(1, Math.round(ih * s))
          const c = cv.getContext('2d')
          c.drawImage(img, 0, 0, cv.width, cv.height)
          try {
            const d = c.getImageData(0, 0, cv.width, cv.height)
            const r = jsQR(d.data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' })
            if (r && r.data) return r.data
          } catch (e) {}
        }
        return null
      }
      rd.onload = () => {
        img.onerror = () => {
          closeScan()
          toast('图片读取失败：可能是 HEIC 等特殊格式，请先截图或转成 JPG/PNG 再试', 3600)
        }
        img.onload = () => {
          const data = tryAlbumDecode(img.naturalWidth || img.width, img.naturalHeight || img.height)
          if (data) {
            const kb = String(data).replace(/^KB:/, '').trim()
            showUser(kb)
          } else {
            toast('未识别到二维码：请确认二维码完整清晰（可截图只保留二维码部分再试）', 3600)
          }
        }
        img.src = rd.result
      }
      rd.readAsDataURL(f)
    }
    input.click()
  }
}

/* ---------- 创建群聊 ---------- */
function openGroupModal() {
  if (!S.friends.length) { toast('还没有好友，先去添加朋友吧'); return }
  el('groupName').value = ''
  el('pickList').innerHTML = S.friends.map(f =>
    `<div class="pick-item" data-uid="${esc(f.uid)}" data-name="${esc(f.name)}">
      <div class="box">✓</div>
      <div class="contact-av">${avatarHtml(f.avatar)}</div>
      <div class="pick-name">${esc(f.name)}</div>
    </div>`).join('')
  el('pickList').onclick = e => {
    const it = e.target.closest('.pick-item')
    if (it) it.classList.toggle('is-on')
  }
  openModal('modalGroup')
}

async function doCreateGroup() {
  const picked = Array.from(el('pickList').querySelectorAll('.pick-item.is-on'))
  if (!picked.length) { toast('请至少选择 1 位好友'); return }
  const uids = picked.map(p => p.dataset.uid)
  const name = el('groupName').value.trim()
  try {
    const r = await Net.createGroup(name, uids)
    closeModal()
    if (!S.groups.some(g => g.roomId === r.group.roomId)) S.groups.push(r.group)
    if (!S.conversations.some(c => c.roomId === r.group.roomId)) {
      S.conversations.push({
        roomId: r.group.roomId, kind: 'group', name: r.group.name, avatar: '\ud83d\udc65',
        members: r.group.members, memberNames: r.group.memberNames,
        lastMsg: null, ts: r.group.createdAt, unread: 0,
      })
    }
    renderContacts()
    await openRoom(r.group.roomId, 'group')
    toast('群聊已创建')
  } catch (e) {
    toast(e.message || '创建群聊失败')
  }
}

/* ---------- 登录页：登录 / 注册分离 ---------- */
function setLoginMsg(text, ok) {
  const m = el('loginMsg')
  m.textContent = text || ''
  m.className = 'login-msg' + (ok ? ' ok' : '')
}

function bindLogin() {
  /* 注册页里的语言选择器：选中即生效（之前没有绑定，选了也不切换） */
  el('regLang').value = localStorage.getItem('kbchat_lang') || 'zh-CN'
  el('regLang').onchange = () => {
    localStorage.setItem('kbchat_lang', el('regLang').value)
    applyLang()
    el('regLang').value = localStorage.getItem('kbchat_lang')
    toast('界面语言已切换', 1800)
  }
  /* tab 切换 */
  document.querySelectorAll('#loginTabs .ltab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('#loginTabs .ltab').forEach(x => x.classList.remove('is-on'))
      t.classList.add('is-on')
      const isLogin = t.dataset.tab === 'login'
      el('panelLogin').classList.toggle('is-on', isLogin)
      el('panelReg').classList.toggle('is-on', !isLogin)
      el('panelRecover').classList.remove('is-on')
      fitLoginCard()
      setLoginMsg('')
      el('loginFoot').textContent = isLogin
        ? '把这个KB号告诉朋友，双方就能互相添加并实时聊天'
        : '注册后自动登录；KB号是好友搜索你的凭证'
    }
  })

  /* 注册表单的头像选择 */
  bindRegAvatar()
  /* 性别选择（注册 + 资料弹窗）：三选一胶囊 */
  document.querySelectorAll('#regGender button').forEach(b => {
    b.onclick = () => {
      regGender = b.dataset.g
      document.querySelectorAll('#regGender button').forEach(x => x.classList.toggle('is-on', x === b))
    }
  })
  document.querySelectorAll('#profGender button').forEach(b => {
    b.onclick = () => document.querySelectorAll('#profGender button').forEach(x => x.classList.toggle('is-on', x === b))
  })

  /* 登录 */
  el('panelLogin').addEventListener('submit', async e => {
    e.preventDefault()
    const wxid = el('wxidLogin').value.trim()
    const pwd = el('pwdLogin').value
    el('wxidLoginErr').textContent = ''
    el('pwdLoginErr').textContent = ''
    if (!wxid) { el('wxidLoginErr').textContent = '请输入KB号'; return }
    if (!pwd) { el('pwdLoginErr').textContent = '请输入密码'; return }
    const btn = el('loginBtn')
    btn.disabled = true
    btn.textContent = '登录中…'
    setLoginMsg('')
    try {
      const r = await Net.login(wxid, pwd)
      if (r.needProfile) {
        setLoginMsg('该KB号尚未注册，请切换到「注册」页创建账号')
        return
      }
      if (r.bannedUntil) S.loginBannedUntil = r.bannedUntil
      const data = await Net.bootstrap()
      enterApp(data, { fresh: true })
    } catch (err) {
      /* 被删除的账号：提示并可打开「用户删除公告」证书 */
      if (err.payload && err.payload.deleted) {
        setLoginMsg('此用户已被删除，请查看删除信息。')
        const msg = el('loginMsg')
        const link = document.createElement('a')
        link.href = 'javascript:;'
        link.textContent = '删除信息'
        link.style.marginLeft = '6px'
        link.onclick = () => showDeleteCert(err.payload)
        msg.appendChild(link)
        return
      }
      setLoginMsg(err.message || '登录失败')
    } finally {
      btn.disabled = false
      btn.textContent = '登 录'
    }
  })

  /* 注册 */
  el('panelReg').addEventListener('submit', async e => {
    e.preventDefault()
    const wxid = el('regWxid').value.trim()
    const nickname = el('regNick').value.trim()
    const password = el('regPwd').value
    const signature = el('regSign').value.trim()
    const realName = el('regRealName').value.trim()
    /* 每个字段的错误显示在对应位置（KB号/昵称/密码/真实姓名各自独立错误位），同时 toast 提醒 */
    const regErr = (id, msg) => { const n = el(id); if (n) n.textContent = msg; toast(msg, 2200) }
    ;['regWxidErr', 'regNickErr', 'regPwdErr', 'regNameErr'].forEach(id => { const n = el(id); if (n) n.textContent = '' })
    if (!wxid) { regErr('regWxidErr', '请输入KB号'); return }
    if (!nickname) { regErr('regNickErr', '请输入昵称'); return }
    if (!realName) { regErr('regNameErr', '请输入真实姓名'); return }
    if (!password) { regErr('regPwdErr', '请设置登录密码'); return }
    if (password.length < 8) { regErr('regPwdErr', '密码至少 8 位，勿用常见弱口令'); return }
    const btn = el('regBtn')
    btn.disabled = true
    btn.textContent = '注册中…'
    setLoginMsg('')
    try {
      await Net.register({ wxid, nickname, avatar: regPickedAvatar, signature, password, realName, gender: regGender, language: el('regLang').value })
      S.justRegistered = true
      /* 注册后必须先签署用户协议：点「不同意」视为注册失败，账号随即从数据库删除 */
      openAgreement(async () => {
        /* 同意 Chat 公约后：确认《管理员承诺书》 */
        openPledgeConfirm(async () => {
          const data = await Net.bootstrap()
          enterApp(data, { fresh: true })
          toast('注册成功，你的KB号是 ' + wxid + '，告诉好友即可被搜索到', 3600)
          /* 密保问答弹窗由 enterApp 的统一触发点负责（2600ms），此处不再重复弹 */
          setTimeout(() => startGuide(false), 5200)
        }, async () => {
          try { await Net.abandonAccount() } catch (e) {}
          Net.token = ''
          localStorage.removeItem('wxchat_token')
          location.reload()
        })
      }, async () => {
        try { await Net.abandonAccount() } catch (e) {}
        Net.token = ''
        localStorage.removeItem('wxchat_token')
        location.reload()
      })
    } catch (err) {
      /* 服务端注册错误（如 KB号已被采用）显示在 KB号的错误位上 */
      const wErr = el('regWxidErr')
      const m = err.message || '注册失败'
      if (wErr) wErr.textContent = m
      setLoginMsg(m)
    } finally {
      btn.disabled = false
      btn.textContent = '注 册 并 进 入'
    }
  })

  /* ---------- 忘记密码 / 找回账号 ---------- */
  let rcStage = 'name'      // name → pick → reset
  let rcUid = ''
  let rcNameVal = ''

  function showRecover() {
    document.querySelectorAll('#loginTabs .ltab').forEach(x => x.classList.remove('is-on'))
    el('panelLogin').classList.remove('is-on')
    el('panelReg').classList.remove('is-on')
    el('panelRecover').classList.add('is-on')
    setLoginMsg('')
    el('loginFoot').textContent = '找回需在注册时所用的同一网络环境下操作'
    el('btnRcByIp').onclick = async () => {
      const box = el('rcIpResult')
      box.innerHTML = '<p class="muted">查找中…</p>'
      try {
        const r = await Net.recoverByIp()
        const list = r.list || []
        if (!list.length) {
          box.innerHTML = '<p class="muted">当前网络环境（' + esc(r.ip || '') + '）下没有找到账号</p>'
          return
        }
        box.innerHTML = list.map(u => `<div class="rc-ip-item">
          <span>${avatarHtml(u.avatar)}</span>
          <span class="rc-ip-name">${esc(u.nickname)}（${esc(u.wxid)}）</span>
        </div>`).join('')
      } catch (e) {
        box.innerHTML = '<p class="muted">查找失败，请稍后再试</p>'
      }
    }
    fitLoginCard()
  }
  function backToLogin() {
    rcStage = 'name'; rcUid = ''; rcNameVal = ''
    el('rcAccountBox').hidden = true
    el('rcNewBox').hidden = true
    el('rcPwdBox').hidden = true
    el('rcName').value = ''
    el('rcNewWxid').value = ''
    el('rcNewPwd').value = ''
    el('rcList').innerHTML = ''
    el('rcBtn').textContent = '验 证 真 实 姓 名'
    el('panelRecover').classList.remove('is-on')
    el('panelLogin').classList.add('is-on')
    fitLoginCard()
    const t = document.querySelector('#loginTabs .ltab[data-tab="login"]')
    if (t) { document.querySelectorAll('#loginTabs .ltab').forEach(x => x.classList.remove('is-on')); t.classList.add('is-on') }
    setLoginMsg('')
  }

  /* 防御式绑定：元素不存在时跳过，绝不让单个缺失元素崩掉整个应用（2026-11-01 白屏修复） */
  const lnkForgotEl = el('lnkForgot')
  if (lnkForgotEl) lnkForgotEl.onclick = showRecover
  ;['lnkBackLogin', 'lnkBackLogin2', 'lnkBackLogin3'].forEach(id => {
    const n = el(id)
    if (n) n.onclick = backToLogin
  })
  /* 找回方式切换：密保问答（推荐）/ 姓名+同网络（老用户兜底） */
  document.querySelectorAll('#rcModeTabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#rcModeTabs button').forEach(x => x.classList.toggle('is-on', x === b))
      const quiz = b.dataset.rm === 'quiz'
      el('rcQuizBox').hidden = !quiz
      el('rcNameBox').hidden = quiz
      fitLoginCard()
    }
  })
  /* 密保问答找回：第一步取问题 → 第二步答题重置 */
  let quizWxid = ''
  let rcQuizStage = 'wxid'
  el('btnRcQuizNext').onclick = async () => {
    const err = el('rcQuizErr')
    err.textContent = ''
    const realName = el('rcQuizRealName').value.trim()
    const wxid = el('rcQuizWxid').value.trim()
    if (!realName) { err.textContent = '请输入真实姓名'; return }
    if (!wxid) { err.textContent = '请输入 KB号'; return }
    const btn = el('btnRcQuizNext')
    btn.disabled = true; btn.textContent = '获取中…'
    try {
      if (rcQuizStage === 'reset') {
        const answers = Array.from(document.querySelectorAll('#rcQuizList input')).map(i => i.value.trim())
        if (answers.some(a => !a)) { err.textContent = '请回答全部 3 个问题'; return }
        const pwd = el('rcQuizPwd').value
        if (!pwd || pwd.length < 8) { err.textContent = '请输入至少 8 位的新密码'; return }
        btn.textContent = '提交中…'
        const r = await Net.recoverQuizReset({ wxid: quizWxid, realName, answers, password: pwd })
        toast('重置成功，请用新密码登录', 3200)
        el('wxidLogin').value = r.wxid || quizWxid
        rcQuizStage = 'wxid'
        backToLogin()
        return
      }
      const r = await Net.recoverQuiz(wxid, realName)
      quizWxid = wxid
      const qs = r.questions || []
      el('rcQuizList').innerHTML = qs.map((q, i) =>
        `<div style="margin-bottom:8px"><div class="muted" style="font-size:12.5px;margin-bottom:3px">Q${i + 1}. ${esc(q)}</div>` +
        `<input id="rcQuizA${i}" maxlength="40" placeholder="你的答案" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px"></div>`).join('')
      el('rcQuizQBox').hidden = false
      el('rcQuizPwdBox').hidden = false
      rcQuizStage = 'reset'
      btn.textContent = '答 对 了，重 设 密 码'
      fitLoginCard()
    } catch (e) {
      err.textContent = e.message || '操作失败'
    } finally {
      btn.disabled = false
      if (rcQuizStage !== 'reset') btn.textContent = '获取我的密保问题'
    }
  }
  el('lnkDelList').onclick = openDelListModal
  el('lnkAsk').onclick = openGuestAsk
  el('lnkProduct').onclick = () => openModal('modalProduct')
  el('btnProductClose').onclick = closeModal
  el('btnProductDl').onclick = () => { location.href = '/kbchat.apk?v=2.0.0' }
  el('btnDelListClose').onclick = closeModal
  el('btnCertClose').onclick = closeModal

  el('panelRecover').addEventListener('submit', async e => {
    e.preventDefault()
    const btn = el('rcBtn')
    el('rcNameErr').textContent = ''
    setLoginMsg('')

    /* 第一步：验证真实姓名（服务端同时校验当前 IP 是否与注册时一致） */
    if (rcStage === 'name') {
      const name = el('rcName').value.trim()
      if (!name) { el('rcNameErr').textContent = '请输入真实姓名'; return }
      btn.disabled = true; btn.textContent = '验证中…'
      try {
        const r = await Net.recoverLookup(name)
        rcNameVal = name
        el('rcList').innerHTML = (r.users || []).map((u, i) => `
          <div class="rc-item ${i === 0 ? 'is-on' : ''}" data-uid="${esc(u.uid)}">
            <div class="rc-av">${avatarHtml(u.avatar)}</div>
            <div class="rc-tx"><b>${esc(u.wxid)}</b><span>${esc(u.nickname || '')}</span></div>
          </div>`).join('')
        el('rcList').onclick = ev => {
          const it = ev.target.closest('.rc-item')
          if (!it) return
          el('rcList').querySelectorAll('.rc-item').forEach(x => x.classList.remove('is-on'))
          it.classList.add('is-on')
          rcUid = it.dataset.uid
        }
        rcUid = (r.users && r.users[0] && r.users[0].uid) || ''
        el('rcAccountBox').hidden = false
        el('rcNewBox').hidden = false
        el('rcPwdBox').hidden = false
        rcStage = 'reset'
        btn.textContent = '重 设 密 码'
        setLoginMsg('验证通过，可修改KB号并重设密码（聊天记录保留）', true)
        fitLoginCard()
      } catch (err) {
        el('rcNameErr').textContent = err.message || '验证失败'
      } finally { btn.disabled = false }
      return
    }

    /* 第二步：提交新KB号与新密码 */
    if (rcStage === 'reset') {
      if (!rcUid) { setLoginMsg('请选择要找回的账号'); return }
      const wxid = el('rcNewWxid').value.trim()
      const pwd = el('rcNewPwd').value
      if (!pwd) { setLoginMsg('请输入新密码'); return }
      if (pwd.length < 8) { setLoginMsg('密码至少 8 位'); return }
      btn.disabled = true; btn.textContent = '提交中…'
      try {
        const r = await Net.recoverReset({ uid: rcUid, realName: rcNameVal, wxid, password: pwd })
        toast('重置成功，请用新密码登录', 3200)
        if (wxid) el('wxidLogin').value = r.wxid || wxid
        backToLogin()
      } catch (err) {
        setLoginMsg(err.message || '重置失败')
      } finally { btn.disabled = false }
    }
  })
}

/* ---------- 头像：表情或相册图片 ---------- */
const AVATARS = ['😊', '🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🌸', '⭐', '🍀', '🌙', '🔥', '🎧', '🚀', '🍎']

/* 表情库：分组，可横向滚动挑选 */
const EMOJI_GROUPS = [
  ['smile', '笑脸', ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','😳','🥲','😈','👿','💀','👻','👽','🤖','💩','😺','😸','😹']],
  ['gesture', '手势', ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤳','💪','🦾','✍️','💅','🦶','👀','👁️','🧠','🫀','👄','👅','🦷','🦴']],
  ['animal', '动物', ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🕷️','🦂','🐢','🐍','🦎','🐙','🦑','🦐','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🦭','🐊','🐘','🦒','🦓','🐪','🐫','🦔','🐇']],
  ['food', '食物', ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧇','🥞','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥙','🧆','🍱','🍚','🍜','🍝','🍣','🍤','🍥','🥟','🍦','🍰','🎂','🍪','🍩','🍫','🍬','🍭','☕','🍺','🥂','🍷','🥤','🧋']],
  ['life', '生活', ['🎉','🎊','🎁','🎈','🎂','🎄','🎃','🎗️','🏆','🥇','🥈','🥉','⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🏸','🥊','🎯','🎮','🕹️','🎲','🎳','🎰','🧩','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎸','🎺','🎻','🚗','🚕','🚌','🏎️','🚓','🚑','🚚','🚲','🛵','✈️','🚀','🛸','🚁','⛵','🚢','🗺️','🏠','🏡','🏢','🏥','🏦','🏫','⛺','🌋','🏔️','🏖️','🏝️','🌅','🌄','🌙','⭐','🌟','✨','⚡','🔥','💧','🌈','☀️','⛅','❄️','⛄','🌊','🌍','🌱','🌸','🌺','🌻','🌹','🌷','🌲','🍀','🍁','🍂']],
  ['symbol', '符号', ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💯','💢','💥','💫','💦','💨','🕳️','💬','💭','🗯️','♻️','✅','☑️','✔️','❌','❎','➕','➖','➗','✖️','♾️','‼️','⁉️','❓','❔','❗','〰️','⚠️','🚫','⛔','📌','📍','🔒','🔓','🔑','🔨','⚙️','🧲','🔍','🔎','💡','🔔','🔕','📢','📣','⏰','⏳','📅','📆','✉️','📦','📚','📖','📝','✏️','📌','🎯','🏁','🚩','🎌']],
]
function renderEmojiTabs(key) {
  const tabs = el('emojiTabs')
  if (tabs) {
    /* 页签只构建一次 + 事件委托；切换分类只改选中态、不重建节点 ——
     * 否则被点击的按钮被移除后，冒泡到 document 的「点外关闭」判定
     * 会把面板误认为点击了外部而关闭 */
    if (!tabs.children.length) {
      tabs.innerHTML = EMOJI_GROUPS.map(g =>
        `<button type="button" class="et" data-g="${g[0]}">${g[1]}</button>`).join('')
      tabs.addEventListener('click', e => {
        const b = e.target.closest('.et')
        if (b) renderEmojiTabs(b.dataset.g)
      })
    }
    tabs.querySelectorAll('.et').forEach(b => b.classList.toggle('is-on', b.dataset.g === key))
  }
  const g = EMOJI_GROUPS.find(x => x[0] === key) || EMOJI_GROUPS[0]
  el('emojiGrid').innerHTML = g[2].map(x => `<button data-e="${x}">${x}</button>`).join('')
}

let pickedAvatar = '😊'
let regPickedAvatar = '😊'
/* 注册性别：male / female / secret（默认隐私） */
let regGender = 'secret'

function setPreview(nodeId, value) {
  const node = el(nodeId)
  if (isImg(value)) node.innerHTML = `<img src="${esc(value)}" alt="" onerror="this.onerror=null;this.replaceWith(document.createTextNode('😊'))">`
  else node.textContent = value || '😊'
}

let regAvatarInited = false
function bindRegAvatar() {
  /* 同一会话内保留用户已选的头像（切走再切回不丢）；仅首次打开随机一个 */
  if (!regAvatarInited) {
    regPickedAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)]
    regAvatarInited = true
  }
  /* 重置过期的图库提示（避免「已使用图库图片」但预览对不上的矛盾状态） */
  const tip0 = el('regAlbumTip')
  if (tip0) tip0.textContent = '支持相册里的任意图片，也可选上方表情'
  el('regAvatarList').innerHTML = AVATARS.map(a =>
    `<button type="button" data-av="${a}" class="${a === regPickedAvatar ? 'is-on' : ''}">${a}</button>`).join('')
  setPreview('regAvatarPreview', regPickedAvatar)
  el('regAvatarList').onclick = e => {
    const b = e.target.closest('button[data-av]')
    if (!b) return
    regPickedAvatar = b.dataset.av
    setPreview('regAvatarPreview', regPickedAvatar)
    el('regAvatarList').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b))
  }
  el('btnRegAlbum').onclick = () => el('regAvatarPicker').click()
  el('regAvatarPicker').onchange = async e => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    const url = await uploadAvatar(file)
    if (url) {
      regPickedAvatar = url
      setPreview('regAvatarPreview', url)
      el('regAvatarList').querySelectorAll('button').forEach(x => x.classList.remove('is-on'))
      el('regAlbumTip').textContent = '已使用图库图片'
    }
  }
}

async function uploadAvatar(file) {
  /* 头像最多显示 320px：强制压缩（照片 8MB 也能压到几十 KB，不再撞 D1 单值限制） */
  if (!/^image\//.test(file.type || '')) { toast('请选择图片文件'); return null }
  toast('正在上传头像…', 1200)
  try {
    return await Net.uploadImage(file, { maxEdge: 320, quality: 0.85, raw: false })
  } catch (e) {
    toast(e.message || '头像上传失败，请换一张试试')
    return null
  }
}

/* ---------- 资料弹窗 ---------- */
function bindAvatarPicker(current) {
  pickedAvatar = current || AVATARS[0]
  el('avatarList').innerHTML = AVATARS.map(a =>
    `<button type="button" data-av="${a}" class="${a === pickedAvatar ? 'is-on' : ''}">${a}</button>`).join('')
  setPreview('avatarPreview', pickedAvatar)
  el('avatarAlbumTip').textContent = '支持相册里的任意图片，也可选上方表情'
  el('avatarList').onclick = e => {
    const b = e.target.closest('button[data-av]')
    if (!b) return
    pickedAvatar = b.dataset.av
    setPreview('avatarPreview', pickedAvatar)
    el('avatarList').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b))
  }
  el('btnAvatarAlbum').onclick = () => el('avatarPicker').click()
  el('avatarPicker').onchange = async e => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    const url = await uploadAvatar(file)
    if (url) {
      pickedAvatar = url
      setPreview('avatarPreview', url)
      el('avatarList').querySelectorAll('button').forEach(x => x.classList.remove('is-on'))
      el('avatarAlbumTip').textContent = '已使用图库图片'
    }
  }
}

/** 修改资料 */
function openProfileSetup() {
  /* 等级徽标：CMO 恒为 Lv.80，普通用户随聊天经验增长（开方曲线，满级 80） */
  const lv = S.profile.isAdmin ? 80 : Math.max(1, Math.min(80, Math.floor(Math.sqrt(S.profile.exp || 0))))
  el('profileTitle').textContent = '我的资料 · Lv.' + lv
  bindAvatarPicker(S.profile.avatar)
  el('nickInput').value = S.profile.nickname || ''
  el('wxidInput').value = S.profile.wxid || ''
  el('signInput').value = S.profile.signature || ''
  /* 性别回填（男生/女生/隐私，可随时改） */
  const curG = S.profile.gender || 'secret'
  document.querySelectorAll('#profGender button').forEach(x => x.classList.toggle('is-on', x.dataset.g === curG))
  el('wxidErr').textContent = ''
  el('btnSaveProfile').textContent = '保存'
  /* 密码只读展示：资料保存不会改动密码，改密必须走「修改密码」弹窗 */
  const btnPwd = el('btnChangePwd')
  btnPwd.disabled = false
  el('pwdTip').textContent = '密码以加密方式存储，任何人（含 CMO）都无法查看；如需更换请点「修改密码」'
  btnPwd.onclick = () => openChangePwd()
  openModal('modalProfile')

  el('btnSaveProfile').onclick = async () => {
    const nickname = el('nickInput').value.trim()
    if (!nickname) { el('wxidErr').textContent = '请填写昵称'; return }
    el('wxidErr').textContent = ''
    try {
      /* KB号不可更改，提交时不携带 wxid；密保问答已移到独立弹窗（btnProfileSecQuiz），旧输入框已删 */
      const sq = '', sa = ''
      const gBtn = document.querySelector('#profGender button.is-on')
      await Net.updateProfile({
        nickname, avatar: pickedAvatar, signature: el('signInput').value.trim(),
        gender: (gBtn && gBtn.dataset.g) || 'secret',
        secQ: sq, secA: sa,
      })
      const data = await Net.bootstrap()
      closeModal()
      enterApp(data)
      toast('资料已更新')
    } catch (e) {
      el('wxidErr').textContent = e.message || '保存失败'
    }
  }
}

/* ---------- 登录页：我有疑问（游客问 CMO） ---------- */
let gaGid = ''
let gaTimer = null

function guestGid() {
  let v = ''
  try { v = localStorage.getItem('kbchat_guest_gid') || '' } catch (e) {}
  if (!v || v.length < 8) {
    v = 'g' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    try { localStorage.setItem('kbchat_guest_gid', v) } catch (e) {}
  }
  return v
}

function renderGuestMsgs(list) {
  const box = el('gaChat')
  if (!list || !list.length) {
    box.innerHTML = '<p class="muted">有什么想问的，直接写下来发给 CMO 吧。</p>'
    return
  }
  box.innerHTML = list.map(m => `<div class="ga-msg ${m.from === 'admin' ? 'is-cmo' : 'is-me'}">
      <div class="ga-bubble">${linkify(m.text)}</div>
      <div class="ga-time">${esc(fmtFull(m.at))}</div>
    </div>`).join('')
  box.scrollTop = box.scrollHeight
}

async function loadGuestThread() {
  if (!gaGid) return
  try {
    const r = await Net.guestThread(gaGid)
    const st = el('gaStatus')
    st.textContent = r.adminOnline
      ? '🟢 ' + (r.adminName || 'CMO') + ' 在线，通常能较快回复'
      : '⚪ ' + (r.adminName || 'CMO') + ' 当前离线，留言后他上线就能看到'
    st.className = 'ga-status' + (r.adminOnline ? ' is-on' : '')
    renderGuestMsgs(r.messages)
  } catch (e) {}
}

function openGuestAsk() {
  gaGid = guestGid()
  el('gaText').value = ''
  el('gaErr').textContent = ''
  el('gaChat').innerHTML = '<p class="muted">正在加载…</p>'
  el('btnGaSend').onclick = sendGuestAsk
  el('btnGaClose').onclick = closeGuestAsk
  el('gaText').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendGuestAsk() } }
  openModal('modalGuestAsk')
  loadGuestThread()
  clearInterval(gaTimer)
  gaTimer = setInterval(loadGuestThread, 3000)
}

async function sendGuestAsk() {
  const text = el('gaText').value.trim()
  if (!text) { el('gaErr').textContent = '请写下你的疑问'; return }
  const btn = el('btnGaSend')
  btn.disabled = true
  try {
    const r = await Net.guestAsk({ gid: gaGid, text, name: el('gaName').value.trim() })
    el('gaText').value = ''
    el('gaErr').textContent = ''
    renderGuestMsgs(r.messages)
  } catch (e) {
    el('gaErr').textContent = e.message || '发送失败'
  } finally { btn.disabled = false }
}

/* 退出：整条提问记录从服务器删除 */
async function closeGuestAsk() {
  clearInterval(gaTimer)
  gaTimer = null
  closeModal()
  const gid = gaGid
  gaGid = ''
  if (!gid) return
  try { await Net.guestLeave(gid) } catch (e) {}
  toast('本次对话已从服务器清除', 2400)
}

/* 直接关掉页面也要清掉，别把游客的提问留在库里 */
window.addEventListener('pagehide', () => {
  if (!gaGid) return
  try {
    fetch(API_BASE + '/api/guest/leave', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gid: gaGid }),
    })
  } catch (e) {}
})

/* ---------- 注销账号 ---------- */
/* 规则：校验真实姓名 + 密码；注销后账号彻底删除、好友关系解除，
 * 且不写入删除名单，所以不占用「同一网络 2 个账号」的名额。 */
function openCloseAccount() {
  /* CMO 是系统账号，不提供注销入口（避免误操作导致系统失去管理员） */
  if (S.profile && S.profile.isAdmin) { toast('CMO 是系统账号，不能注销'); return }
  el('caName').value = ''
  el('caPwd').value = ''
  el('caConfirm').checked = false
  el('caErr').textContent = ''
  el('btnCaCancel').onclick = closeModal
  el('btnCaOk').onclick = async () => {
    const name = el('caName').value.trim()
    const pwd = el('caPwd').value
    if (!name) { el('caErr').textContent = '请输入真实姓名'; return }
    if (!pwd) { el('caErr').textContent = '请输入登录密码'; return }
    if (!el('caConfirm').checked) { el('caErr').textContent = '请先勾选「我已知晓，注销后无法恢复」'; return }
    const btn = el('btnCaOk')
    btn.disabled = true
    btn.textContent = '注销中…'
    try {
      await Net.accountClose(name, pwd)
      closeModal()
      toast('账号已注销，感谢使用靠北 Chat', 3000)
      Net.logout()
      setTimeout(() => location.reload(), 900)
    } catch (e) {
      el('caErr').textContent = e.message || '注销失败'
    } finally {
      btn.disabled = false
      btn.textContent = '确认注销'
    }
  }
  openModal('modalCloseAccount')
}

/* ---------- 修改密码（需原密码 + 新密码两次） ---------- */function openChangePwd() {
  el('pwdOld').value = ''
  el('pwdNew').value = ''
  el('pwdNew2').value = ''
  el('pwdErr').textContent = ''
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  el('pwdNew').placeholder = '至少 8 位，建议字母+数字组合'
  el('btnPwdCancel').onclick = () => closeModal()
  el('btnPwdSubmit').onclick = submitChangePwd
  openModal('modalPwd')
  setTimeout(() => el('pwdOld').focus(), 30)
}

async function submitChangePwd() {
  const oldPwd = el('pwdOld').value
  const newPwd = el('pwdNew').value
  const cPwd = el('pwdNew2').value
  const err = el('pwdErr')
  err.textContent = ''
  const minLen = (S.profile && S.profile.isAdmin) ? 8 : 4
  if (!oldPwd) { err.textContent = '请输入原密码'; return }
  if (!newPwd) { err.textContent = '请输入新密码'; return }
  if (newPwd.length < minLen) { err.textContent = '新密码至少 ' + minLen + ' 位'; return }
  if (newPwd !== cPwd) { err.textContent = '两次输入的新密码不一致'; return }
  if (newPwd === oldPwd) { err.textContent = '新密码不能与原密码相同'; return }
  const btn = el('btnPwdSubmit')
  btn.disabled = true
  btn.textContent = '提交中…'
  try {
    await Net.changePassword(oldPwd, newPwd, cPwd)
    closeModal()
    toast('密码修改成功，下次登录请使用新密码', 3200)
  } catch (e) {
    err.textContent = e.message || '修改失败'
  } finally {
    btn.disabled = false
    btn.textContent = '确认修改'
  }
}

async function logout() {
  await Net.logout()
  try { sessionStorage.removeItem('kbchat_admin_unlock') } catch (e) {}
  S.uid = null; S.profile = null; S.friends = []; S.groups = []
  S.conversations = []; S.messages = []; S.activeRoom = null
  closeModal()
  el('mainView').hidden = true
  el('loginView').hidden = false
  el('loginMsg').textContent = '已退出登录'
  el('loginMsg').className = 'login-msg'
}

/* ---------- 好友申请 ---------- */
async function openReqsModal() {
  openModal('modalReqs')
  const box = el('reqList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.friendRequests()
    S.reqs = r.requests || []
    S.reqCount = S.reqs.length
    renderReqs()
    renderContacts()
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

function renderReqs() {
  const box = el('reqList')
  if (!S.reqs.length) { box.innerHTML = '<p class="muted">暂无好友申请</p>'; return }
  box.innerHTML = S.reqs.map(r => `
    <div class="req-item">
      <div class="u-av">${avatarHtml(r.avatar)}</div>
      <div class="u-info">
        <div class="u-name">${esc(r.name || '未命名')}</div>
        <div class="u-wx">KB号：${esc(r.wxid || '')}${r.msg ? ' · ' + esc(r.msg) : ''}</div>
      </div>
      <button class="mini-btn" data-accept="${esc(r.uid)}">同意</button>
      <button class="mini-btn gray" data-reject="${esc(r.uid)}">拒绝</button>
    </div>`).join('')
  box.querySelectorAll('button[data-accept]').forEach(b => {
    b.onclick = () => handleReq(b.dataset.accept, 'accept')
  })
  box.querySelectorAll('button[data-reject]').forEach(b => {
    b.onclick = () => handleReq(b.dataset.reject, 'reject')
  })
}

async function handleReq(uid, act) {
  try {
    await Net.handleRequest(uid, act)
    S.reqs = S.reqs.filter(r => r.uid !== uid)
    S.reqCount = S.reqs.length
    renderReqs()
    await syncConversations()
    renderContacts()
    toast(act === 'accept' ? '已添加为好友' : '已拒绝申请')
  } catch (e) { toast(e.message || '操作失败') }
}

async function refreshReqCount() {
  try {
    const r = await Net.friendRequests()
    const n = (r.requests || []).length
    if (n !== S.reqCount) { S.reqCount = n; S.reqs = r.requests || []; renderContacts() }
  } catch (e) {}
}

/* ---------- 管理员面板 ---------- */
let adminCache = []
let adminRoomsCache = []
let adminView = 'users'

/* 进管理面板：需再次输入登录密码验证（通过后 15 分钟内免重复验证） */
function adminUnlockOk() {
  try {
    const t = Number(sessionStorage.getItem('kbchat_admin_unlock') || 0)
    return !!t && Date.now() - t < 15 * 60 * 1000
  } catch (e) { return false }
}
async function openAdminPanel() {
  if (!(S.profile && S.profile.isAdmin)) return
  /* 每次打开管理面板都必须重新输密码（刷新/重开面板一视同仁，防滥用） */
  sessionStorage.removeItem('kbchat_admin_unlock')
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.innerHTML = `<div class="qr-box" style="max-width:340px">
    <h3>🔒 管理面板验证</h3>
    <p class="muted" style="font-size:12.5px;margin:6px 0 12px">管理面板含敏感操作，请再次输入你的登录密码</p>
    <input id="adminVerifyPwd" type="password" maxlength="72" placeholder="登录密码"
      autocomplete="new-password" readonly
      onfocus="this.removeAttribute('readonly')"
      style="width:100%;padding:9px 12px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:14px">
    <p id="adminVerifyErr" style="color:#e74c3c;font-size:12px;min-height:16px;margin:6px 0"></p>
    <div class="modal-btns">
      <button class="btn-ghost" id="adminVerifyCancel">取消</button>
      <button class="btn-primary" id="adminVerifyOk">验证并进入</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  const pwdInput = layer.querySelector('#adminVerifyPwd')
  setTimeout(() => pwdInput.focus(), 50)
  const close = () => layer.remove()
  layer.querySelector('#adminVerifyCancel').onclick = close
  layer.onclick = e => { if (e.target === layer) close() }
  const submit = async () => {
    const pwd = pwdInput.value
    if (!pwd) { layer.querySelector('#adminVerifyErr').textContent = '请输入密码'; return }
    const btn = layer.querySelector('#adminVerifyOk')
    btn.disabled = true
    try {
      await Net.adminVerify(pwd)
      try { sessionStorage.setItem('kbchat_admin_unlock', String(Date.now())) } catch (e) {}
      close()
      toast('验证通过', 1200)
      doOpenAdminPanel()
    } catch (e) {
      btn.disabled = false
      layer.querySelector('#adminVerifyErr').textContent = e.message || '验证失败'
      pwdInput.select()
    }
  }
  layer.querySelector('#adminVerifyOk').onclick = submit
  pwdInput.onkeydown = e => { if (e.key === 'Enter') submit() }
}
function doOpenAdminPanel() {
  showView('admin')
  el('adminSearch').value = ''
  el('adminChat').hidden = true
  switchAdminView(adminView)
}

/* ---------- CMO 代注册用户 ----------
 * 只帮用户开户，不受「同网络 2 个账号」限制，也不替用户登录；
 * 用户自己登录后照常有新手指引。 */
let adminRegLast = null
function openAdminRegister() {
  const showForm = () => {
    el('adminRegForm').hidden = false
    el('adminRegDone').hidden = true
    el('arWxid').value = ''
    el('arNick').value = ''
    el('arRealName').value = ''
    el('arPwd').value = ''
    el('arAvatar').value = '😊'
    el('arErr').textContent = ''
    setTimeout(() => el('arWxid').focus(), 30)
  }
  showForm()
  el('btnArCancel').onclick = closeModal
  el('btnArAgain').onclick = showForm
  el('btnArClose').onclick = () => { closeModal(); refreshAdmin() }
  el('btnArCopy').onclick = () => {
    if (!adminRegLast) return
    const t = 'KB号：' + adminRegLast.wxid + '\n昵称：' + adminRegLast.nickname +
      '\n密码：' + adminRegLast.password + '\n真实姓名：' + adminRegLast.realName
    navigator.clipboard.writeText(t).then(() => toast('账号信息已复制')).catch(() => toast('复制失败，请手动记录'))
  }
  el('btnArOk').onclick = async () => {
    const payload = {
      wxid: el('arWxid').value.trim(),
      nickname: el('arNick').value.trim(),
      realName: el('arRealName').value.trim(),
      password: el('arPwd').value,
      avatar: el('arAvatar').value.trim() || '😊',
    }
    if (!payload.wxid) { el('arErr').textContent = '请输入KB号'; return }
    if (!payload.nickname) { el('arErr').textContent = '请输入昵称'; return }
    if (!payload.realName) { el('arErr').textContent = '请输入真实姓名'; return }
    if (!payload.password) { el('arErr').textContent = '请设置登录密码'; return }
    const btn = el('btnArOk')
    btn.disabled = true
    btn.textContent = '创建中…'
    try {
      const r = await Net.adminRegister(payload)
      const a = (r && r.account) || {}
      adminRegLast = Object.assign({}, a, { password: payload.password })
      el('arDoneBox').innerHTML = `
        <div class="rd-row"><span>KB号</span><b>${esc(a.wxid)}</b></div>
        <div class="rd-row"><span>昵称</span><b>${esc(a.nickname)}</b></div>
        <div class="rd-row"><span>密码</span><b>${esc(payload.password)}</b></div>
        <div class="rd-row"><span>真实姓名</span><b>${esc(a.realName || payload.realName)}</b></div>`
      el('adminRegForm').hidden = true
      el('adminRegDone').hidden = false
      el('arErr').textContent = ''
    } catch (e) {
      el('arErr').textContent = e.message || '创建失败'
    } finally {
      btn.disabled = false
      btn.textContent = '创建账号'
    }
  }
  openModal('modalAdminReg')
}

function switchAdminView(v) {
  adminView = v
  document.querySelectorAll('#adminTabs .atab').forEach(b => {
    b.classList.toggle('is-on', b.dataset.v === v)
  })
  el('adminChat').hidden = true
  const searchOn = v === 'users' || v === 'rooms' || v === 'msgs' || v === 'dms' || v === 'groups'
  el('adminSearch').placeholder =
    v === 'users' ? '搜索KB号 / 昵称'
    : v === 'rooms' ? '搜索会话成员 / 内容'
    : v === 'msgs' ? '输入成员 KB号/昵称 或 关键词，回车查找'
    : v === 'dms' ? '搜索双方昵称 / KB号 / 对话内容，回车查找'
    : v === 'groups' ? '搜索群名称 / 成员，回车查找'
    : ''
  el('adminSearch').parentNode.style.display = searchOn ? '' : 'none'
  if (v === 'users') loadAdminUsers()
  else if (v === 'freqs') loadAdminFriendReqs()
  else if (v === 'rooms') loadAdminRooms()
  else if (v === 'ann') loadAdminAnn()
  else if (v === 'feedback') loadAdminFeedback()
  else if (v === 'bans') loadAdminBans()
  else if (v === 'admins') loadAdminAdmins()
  else if (v === 'fbreq') loadAdminFbReq()
  else if (v === 'dms') loadAdminDms()
  else if (v === 'groups') loadAdminGroups()
  else if (v === 'msgs') loadAdminMsgs()
  else if (v === 'deleted') loadAdminDeleted()
  else if (v === 'moments') loadAdminMoments()
  else if (v === 'words') loadAdminWords()
  else if (v === 'storage') loadAdminStorage()
  else if (v === 'ipmgr') loadAdminIpMgr()
  else if (v === 'aihelp') loadAdminAiHelp()
  else loadAdminData()
}

/* ---------- IP 管理：每 IP 注册上限（默认 2，可按网段覆盖） ---------- */
async function loadAdminIpMgr() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  let r
  try { r = await Net.adminIpRules() } catch (e) { box.innerHTML = '<p class="muted">' + esc(e.message || '加载失败') + '</p>'; return }
  const rows = (r.overrides || []).map(o =>
    '<div class="admin-item"><div class="admin-info">' +
    '<div class="admin-name">🌐 ' + esc(o.prefix) + '</div>' +
    '<div class="admin-meta"><span class="tag">限额 ' + o.limit + '</span> <span class="admin-stat">已注册 ' + o.used + '</span></div>' +
    '</div><div class="admin-ops"><button class="mini-op danger" data-prefix="' + esc(o.prefix) + '" data-act="ipdel">删除覆盖</button></div></div>'
  ).join('')
  box.innerHTML =
    '<h3 style="margin:4px 0 8px">🌍 全局默认限额</h3>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
    '<span>每 IP 最多</span>' +
    '<input id="ipDefault" type="number" min="1" max="100" value="' + r.default + '" style="width:70px;padding:6px 8px;border:1px solid var(--line,#ddd);border-radius:8px">' +
    '<span>个账号</span>' +
    '<button class="btn-code" id="ipDefaultSave">保存</button></div>' +
    '<p class="muted" style="font-size:12px;margin-bottom:14px">未做网段覆盖的 IP 都使用此默认值（未管理时默认 1IP2账号）。</p>' +
    '<h3 style="margin:4px 0 8px">📌 按网段覆盖（如给学校/机房放宽）</h3>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">' +
    '<input id="ipPrefix" placeholder="网段前缀，如 1.2.3.0" style="width:150px;padding:6px 8px;border:1px solid var(--line,#ddd);border-radius:8px">' +
    '<span>限额</span>' +
    '<input id="ipLimit" type="number" min="1" max="100" value="5" style="width:64px;padding:6px 8px;border:1px solid var(--line,#ddd);border-radius:8px">' +
    '<button class="btn-code" id="ipAdd">添加覆盖</button></div>' +
    '<div id="ipOverrideList">' + (rows || '<p class="muted">暂无网段覆盖，全部使用全局默认</p>') + '</div>' +
    '<h3 style="margin:14px 0 8px">📋 从注册记录一键选择（不用自己写）</h3>' +
    '<div id="ipUsedSegs">' +
      ((r.usedSegments || []).length
        ? (r.usedSegments || []).map(s =>
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">' +
          '<span style="min-width:120px;font-size:13px">' + esc(s.prefix) + '</span>' +
          '<span class="muted" style="font-size:12px">' + s.count + ' 个账号</span>' +
          '<input type="number" min="1" max="100" value="5" data-seglimit="' + esc(s.prefix) + '" style="width:60px;padding:5px 8px;border:1px solid var(--line,#ddd);border-radius:8px">' +
          '<button class="btn-code" data-segadd="' + esc(s.prefix) + '">覆盖</button></div>'
        ).join('')
        : '<p class="muted">还没有注册记录</p>') +
    '</div>' +
    '<p class="muted" style="font-size:11.5px;margin-top:10px">说明：IPv4 按 /24 网段（前 3 段）识别；被删除的账号同样占用名额。</p>'
  document.getElementById('ipDefaultSave').onclick = async () => {
    try {
      const d = Number(document.getElementById('ipDefault').value)
      const res = await Net.adminIpRuleSet({ setDefault: d })
      toast('全局默认限额已设为 ' + res.default)
      loadAdminIpMgr()
    } catch (e) { toast(e.message || '保存失败') }
  }
  document.getElementById('ipAdd').onclick = async () => {
    try {
      await Net.adminIpRuleSet({ prefix: document.getElementById('ipPrefix').value.trim(), limit: Number(document.getElementById('ipLimit').value) })
      toast('网段覆盖已添加')
      loadAdminIpMgr()
    } catch (e) { toast(e.message || '添加失败') }
  }
  /* 一键覆盖：从注册记录里选网段，免手写 */
  box.querySelectorAll('[data-segadd]').forEach(b => {
    b.onclick = async () => {
      const prefix = b.dataset.segadd
      const lim = box.querySelector('[data-seglimit="' + prefix + '"]')
      const limit = Number(lim ? lim.value : 5) || 5
      try {
        await Net.adminIpRuleSet({ prefix, limit })
        toast('已覆盖：' + prefix + ' 限额 ' + limit)
        loadAdminIpMgr()
      } catch (e) { toast(e.message || '添加失败') }
    }
  })
  box.querySelectorAll('[data-act="ipdel"]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除网段 ' + b.dataset.prefix + ' 的覆盖？该网段恢复使用全局默认。')) return
      try { await Net.adminIpRuleSet({ prefix: b.dataset.prefix, delete: true }); toast('已删除'); loadAdminIpMgr() }
      catch (e) { toast(e.message || '删除失败') }
    }
  })
}

/* ---------- CMO「AI帮手」：自然语言查库（密码除外） ---------- */
let adminAiHistory = []
let aihBusy = false
const AIH_CHIPS = ['当前整体统计', '最近谁被警告过', '最近的举报', '用户意见反馈', '群聊列表', '最近的违规拦截']
function loadAdminAiHelp() {
  const box = el('adminList')
  box.innerHTML =
    '<div class="aih-wrap">' +
      '<div class="aih-head">🤖 小靠 · 管理版<span class="aih-sub">可查询数据库全部内容（用户密码除外）</span></div>' +
      '<div class="aih-msgs" id="aihMsgs">' +
        '<div class="aih-msg bot">你好 CMO！我是小靠·管理版 🫡<br>直接向我表达诉求即可，例如：<br>·「现在有多少注册用户？」<br>·「查一下 KB号 aaa001」<br>·「搜昵称带『北』的用户」<br>·「最近群里都在聊什么？」<br>·「被封禁的用户有哪些？」</div>' +
      '</div>' +
      '<div class="aih-chips">' + AIH_CHIPS.map(c => '<button type="button" class="aih-chip">' + esc(c) + '</button>').join('') + '</div>' +
      '<div class="aih-input">' +
        '<input id="aihInput" maxlength="500" placeholder="向 AI 表达你的诉求…" autocomplete="off">' +
        '<button class="btn-code" id="aihSend">发送</button>' +
      '</div>' +
    '</div>'
  document.getElementById('aihSend').onclick = adminAiSend
  document.getElementById('aihInput').onkeydown = e => { if (e.key === 'Enter') adminAiSend() }
  /* 恢复本轮管理会话的历史（切 tab 不再丢失对话记录） */
  const msgs = document.getElementById('aihMsgs')
  if (msgs && adminAiHistory.length) {
    adminAiHistory.forEach(h => {
      if (h.role === 'user') msgs.insertAdjacentHTML('beforeend', '<div class="aih-msg me">' + esc(h.content) + '</div>')
      else msgs.insertAdjacentHTML('beforeend', '<div class="aih-msg bot">' + esc(h.content).replace(/\n/g, '<br>') + '</div>')
    })
    msgs.scrollTop = msgs.scrollHeight
  }
  box.querySelectorAll('.aih-chip').forEach(b => {
    b.onclick = () => {
      const input = document.getElementById('aihInput')
      input.value = b.textContent
      adminAiSend()
    }
  })
  setTimeout(() => { const i = document.getElementById('aihInput'); if (i) i.focus() }, 50)
}
async function adminAiSend() {
  if (aihBusy) return
  const input = document.getElementById('aihInput')
  if (!input) return
  const q = input.value.trim()
  if (!q) return
  aihBusy = true
  input.value = ''
  const msgs = document.getElementById('aihMsgs')
  msgs.insertAdjacentHTML('beforeend', '<div class="aih-msg me">' + esc(q) + '</div>')
  const think = document.createElement('div')
  think.className = 'aih-msg bot aih-thinking'
  think.textContent = '小靠正在查询数据库…'
  msgs.appendChild(think)
  msgs.scrollTop = msgs.scrollHeight
  try {
    const r = await Net.adminAiHelp({ question: q, history: adminAiHistory })
    think.remove()
    adminAiHistory.push({ role: 'user', content: q }, { role: 'assistant', content: r.reply })
    if (adminAiHistory.length > 12) adminAiHistory = adminAiHistory.slice(-12)
    const tag = r.action && r.action !== 'none'
      ? '<span class="aih-tag">🔍 已查询：' + esc(r.action) + (r.kw ? '（' + esc(r.kw) + '）' : '') + '</span>'
      : ''
    msgs.insertAdjacentHTML('beforeend',
      '<div class="aih-msg bot">' + tag + esc(r.reply).replace(/\n/g, '<br>') + '</div>')
  } catch (e) {
    think.remove()
    msgs.insertAdjacentHTML('beforeend', '<div class="aih-msg bot aih-err">⚠️ ' + esc(e.message || '查询失败') + '</div>')
  }
  msgs.scrollTop = msgs.scrollHeight
  aihBusy = false
  const i = document.getElementById('aihInput')
  if (i) i.focus()
}

/* ---------- 存储管理：统计 + 深度清理 ---------- */
async function loadAdminStorage() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">统计中…</p>'
  let s
  try { s = await Net.adminStorageGet() } catch (e) { box.innerHTML = '<p class="muted">' + esc(e.message || '加载失败') + '</p>'; return }
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
  const row = (k, v) => `<div class="set-row" style="justify-content:space-between;padding:7px 2px;border-bottom:1px solid var(--line,#eee)"><span>${k}</span><span class="muted">${v}</span></div>`
  box.innerHTML = `
    <h3 style="margin:4px 0 10px">📊 存储概况</h3>
    ${row('注册账号', s.users)}
    ${row('聊天消息（含撤回占位）', s.messages)}
    ${row('已撤回占位消息', s.recalled)}
    ${row('「对我隐藏」记录', s.hiddenCount)}
    ${row('上传文件/分块（D1）', s.uploads.count + ' 项 · ' + fmtSize(s.uploads.size))}
    ${row('朋友圈', s.moments)}
    ${row('公告', s.anns)}
    ${row('举报记录', s.reports)}
    ${row('意见反馈', s.feedback)}
    ${row('在线令牌', s.tokens)}
    ${row('整库快照大小（D1 state）', fmtSize(s.stateBytes))}
    <h3 style="margin:18px 0 10px">🧹 深度清理</h3>
    <p class="muted" style="font-size:12.5px;margin-bottom:10px">清理不可恢复，请确认后再操作。D1 免费额度 500MB，整库快照超过约 450MB 时建议清理。</p>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:420px">
      <button class="btn-code" id="stCleanUploads">清理过期上传文件（10 天规则）</button>
      <button class="btn-code" id="stPurgeRecalled">物理删除已撤回消息占位（当前 ${s.recalled} 条）</button>
      <button class="btn-code" id="stPurgeOld">删除 90 天前的聊天消息</button>
      <button class="btn-code" id="stClearHidden">清空「对我隐藏」记录（当前 ${s.hiddenCount} 条）</button>
    </div>
    <p id="stResult" class="muted" style="margin-top:10px"></p>`
  const fmtFree = n => n > 1048576 ? fmtSize(n) : n + ' 条'
  const act = (id, action, days, confirmText) => {
    const btn = document.getElementById(id)
    if (!btn) return
    btn.onclick = async () => {
      if (!confirm(confirmText)) return
      btn.disabled = true
      try {
        const r = await Net.adminStorageAct(action, days)
        document.getElementById('stResult').textContent = '✓ 完成，释放 ' + fmtFree(r.freed || 0)
        toast('清理完成')
        loadAdminStorage()
      } catch (e) {
        btn.disabled = false
        toast(e.message || '清理失败')
      }
    }
  }
  act('stCleanUploads', 'cleanup-uploads', null, '清理 10 天内到期的上传文件与分块？')
  act('stPurgeRecalled', 'purge-recalled', null, '物理删除全部已撤回消息占位？不可恢复。')
  act('stPurgeOld', 'purge-old', 90, '删除 90 天前的所有聊天消息？不可恢复。')
  act('stClearHidden', 'clear-hidden', null, '清空所有用户的「对我隐藏」记录？之后被隐藏的消息会重新显示。')
}

/* ---------- 数据备份 / 恢复 ---------- */
async function loadAdminData() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  let st
  try { st = await Net.adminStorage() } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`; return
  }
  const dirs = (st.dirs || []).map(d => `
    <div class="admin-item">
      <div class="admin-av">💾</div>
      <div class="admin-info">
        <div class="admin-name">${esc(d.dir)}</div>
        <div class="admin-meta">
          <span class="tag ${d.writable ? 'tag-on' : ''}">${d.writable ? '可写' : '只读'}</span>
          <span class="tag ${d.hasData ? 'tag-on' : ''}">${d.hasData ? '已有数据' : '空'}</span>
        </div>
      </div>
    </div>`).join('')
  box.innerHTML = `
    <div class="admin-item">
      <div class="admin-av">🗂️</div>
      <div class="admin-info">
        <div class="admin-name">当前数据量</div>
        <div class="admin-meta"><span class="admin-stat">
          账号 ${st.users} · 消息 ${st.messages} · 群 ${st.groups}
        </span></div>
      </div>
    </div>
    <div class="admin-item">
      <div class="admin-av">📤</div>
      <div class="admin-info">
        <div class="admin-name">导出备份</div>
        <div class="admin-meta"><span class="admin-stat">把全部账号、好友、消息下载为 JSON 文件（密码仅存加密哈希，不可还原），请妥善保管</span></div>
      </div>
      <div class="admin-ops"><button class="mini-op ok" id="btnBackupDownload">下载备份</button></div>
    </div>
    <div class="admin-item">
      <div class="admin-av">📥</div>
      <div class="admin-info">
        <div class="admin-name">恢复备份</div>
        <div class="admin-meta"><span class="admin-stat">选择之前导出的 JSON 文件，账号与聊天记录即可全部回来</span></div>
      </div>
      <div class="admin-ops">
        <button class="mini-op" id="btnRestorePick">选择文件并覆盖恢复</button>
        <button class="mini-op" id="btnRestoreMerge">选择文件并合并</button>
        <input type="file" id="restoreFile" accept="application/json,.json" hidden>
      </div>
    </div>
    <div class="admin-item">
      <div class="admin-av">🗑️</div>
      <div class="admin-info">
        <div class="admin-name">清空用户数据</div>
        <div class="admin-meta"><span class="admin-stat">删除 CMO 以外的全部账号及消息、朋友圈、群聊、靠北帖内容、上传文件等（公告/游戏/违禁词设置保留），不可恢复！</span></div>
      </div>
      <div class="admin-ops"><button class="mini-op danger" id="btnWipeUsers">清空用户数据</button></div>
    </div>
    <div class="admin-chat-head">存储位置（多路径镜像，重新发布后自动取最新一份）</div>
    ${dirs}
    <p class="muted" style="padding:8px 0">提示：站点重新发布会覆盖应用目录，但镜像目录的数据会被自动沿用；
    若全部丢失，用上面导出的备份文件恢复即可。</p>`

  el('btnBackupDownload').onclick = () => {
    const a = document.createElement('a')
    a.href = Net.adminBackupUrl()
    a.download = 'kb-chat-backup.json'
    document.body.appendChild(a); a.click(); a.remove()
  }
  const wipeBtn = document.getElementById('btnWipeUsers')
  if (wipeBtn) wipeBtn.onclick = async () => {
    if (!confirm('⚠️ 危险操作！将删除 CMO 以外的全部账号及其消息、朋友圈、群聊、靠北帖内容、上传文件，不可恢复。确定继续？')) return
    const txt = prompt('此操作不可恢复！请输入「清空用户数据」四个字确认：')
    if (txt === null) return
    if (txt.trim() !== '清空用户数据') { toast('确认文字不正确，未执行'); return }
    try {
      const r = await Net.adminWipeUsers()
      toast('已清空 ' + ((r.counts && r.counts.users) || 0) + ' 个账号，保留：' + (r.kept || []).join('、'), 4600)
      loadAdminData()
    } catch (e) { toast(e.message || '操作失败') }
  }
  const pick = merge => {
    const input = el('restoreFile')
    input.value = ''
    input.onchange = async () => {
      const f = input.files && input.files[0]
      if (!f) return
      if (!confirm(merge ? '确定把备份中的数据合并进当前数据库？' : '确定用备份覆盖当前全部数据？当前数据将被替换。')) return
      try {
        const text = await f.text()
        const data = JSON.parse(text)
        const r = await Net.adminRestore(data, merge)
        toast(`恢复完成：账号 ${r.users} · 消息 ${r.messages} · 群 ${r.groups}`)
        await loadAdminData()
        await syncConversations()
      } catch (err) { toast(err.message || '恢复失败') }
    }
    input.click()
  }
  el('btnRestorePick').onclick = () => pick(false)
  el('btnRestoreMerge').onclick = () => pick(true)
}

async function loadAdminRooms() {
  el('adminList').innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminRooms()
    adminRoomsCache = r.rooms || []
    renderAdminRooms()
  } catch (e) {
    el('adminList').innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

function renderAdminRooms() {
  const box = el('adminList')
  const kw = (el('adminSearch').value || '').trim().toLowerCase()
  const list = adminRoomsCache.filter(r =>
    !kw || r.name.toLowerCase().includes(kw) ||
    (r.memberNames || []).join(' ').toLowerCase().includes(kw) ||
    (r.lastContent || '').toLowerCase().includes(kw))
  if (!list.length) { box.innerHTML = '<p class="muted">暂无会话</p>'; return }
  box.innerHTML = list.map(r => `
    <div class="admin-item is-clickable" data-room="${esc(r.roomId)}">
      <div class="admin-av">${r.kind === 'group' ? '👥' : '💬'}</div>
      <div class="admin-info">
        <div class="admin-name">${esc(r.name)}
          <span class="tag">${r.kind === 'group' ? '群聊' : '私聊'}</span></div>
        <div class="admin-meta">
          <span class="admin-stat">${esc((r.memberNames || []).join('、'))}</span>
        </div>
        <div class="admin-meta">
          <span class="admin-stat">${r.count} 条消息 · 最近 ${esc(fmtShort(r.lastAt))} · ${esc(r.lastContent || '')}</span>
        </div>
      </div>
    </div>`).join('')
}

async function onAdminRoomClick(e) {
  const item = e.target.closest('.admin-item[data-room]')
  if (!item) return
  const roomId = item.dataset.room
  const chat = el('adminChat')
  chat.hidden = false
  chat.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminRoomMessages(roomId)
    const msgs = r.messages || []
    if (!msgs.length) { chat.innerHTML = '<p class="muted">该会话暂无消息</p>'; return }
    chat.innerHTML = `<div class="admin-chat-head">会话记录（最近 ${msgs.length} 条）</div>` +
      msgs.map(m => `
        <div class="admin-msg">
          <span class="am-time">${esc(fmtShort(m.createdAt))}</span>
          <span class="am-who">${esc(m.senderName || '已注销')}（${esc(m.senderWxid)}）</span>
          <span class="am-body">${m.kind === 'image'
            ? `<img src="${esc(m.content)}" alt="图片">`
            : esc(m.content)}</span>
          <button class="mini-op danger" data-adminmsgdel="${esc(m.id)}"
            title="删除这条消息（双方都会看到「消息已被删除」）">删除</button>
        </div>`).join('')
    chat.querySelectorAll('[data-adminmsgdel]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('删除这条消息？删除后双方都看不到它。')) return
        try {
          await Net.adminMsgDel(b.dataset.adminmsgdel)
          toast('消息已删除')
          b.closest('.admin-msg').remove()
        } catch (e) { toast(e.message || '删除失败') }
      }
    })
    chat.scrollTop = 0
  } catch (err) {
    chat.innerHTML = `<p class="muted">${esc(err.message || '加载失败')}</p>`
  }
}

async function loadAdminUsers() {
  el('adminList').innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminUsers()
    adminCache = r.users || []
    renderAdminUsers()
  } catch (e) {
    el('adminList').innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

function renderAdminUsers() {
  const box = el('adminList')
  const kw = (el('adminSearch').value || '').trim().toLowerCase()
  const list = adminCache.filter(u =>
    !kw || u.wxid.toLowerCase().includes(kw) || (u.nickname || '').toLowerCase().includes(kw))
  if (!list.length) { box.innerHTML = '<p class="muted">没有匹配的用户</p>'; return }
  box.innerHTML = list.map(u => {
    const tags = []
    if (u.isAdmin) tags.push(`<span class="tag tag-cmo">${esc(u.role || 'CMO')}</span>`)
    else if (u.online) tags.push('<span class="tag tag-on">在线</span>')
    if (u.realName) tags.push(`<span class="tag tag-real">实名 ${esc(u.realName)}</span>`)
    if (u.bannedUntil) tags.push(`<span class="tag tag-ban">封禁至 ${esc(fmtShort(u.bannedUntil))}</span>`)
    if (u.mutedUntil) tags.push(`<span class="tag tag-mute">禁言至 ${esc(fmtShort(u.mutedUntil))}</span>`)
    const note = (u.adminNote || '').trim()
    if (note) tags.push(`<span class="tag tag-note">📝 ${esc(note)}</span>`)
    const ops = u.isAdmin ? '<span class="muted">—</span>' : `
      <button class="mini-op ok" data-uid="${esc(u.uid)}" data-act="detail">查看详情</button>
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="note">📝 备注</button>
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="mute" data-hours="1">禁言1小时</button>
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="mute" data-hours="24">禁言1天</button>
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="mute" data-hours="forever">永久禁言</button>
      ${u.mutedUntil ? `<button class="mini-op ok" data-uid="${esc(u.uid)}" data-act="unmute">解除禁言</button>` : ''}
      ${u.bannedUntil
        ? `<button class="mini-op ok" data-uid="${esc(u.uid)}" data-act="unban">解除封禁</button>`
        : `<button class="mini-op warn" data-uid="${esc(u.uid)}" data-act="ban">封禁</button>`}
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="resetpwd">重置密码</button>
      <button class="mini-op" data-uid="${esc(u.uid)}" data-act="setlevel" title="设置用户等级（1-80）">🎚️ 等级</button>
      <button class="mini-op danger" data-uid="${esc(u.uid)}" data-act="delete">注销账号</button>
      <button class="mini-op danger" data-uid="${esc(u.uid)}" data-act="purge" title="清空全部数据且不占 IP 名额，可立即重新注册">彻底注销</button>`
    return `<div class="admin-item">
      <div class="admin-av">${avatarHtml(u.avatar)}</div>
      <div class="admin-info">
        <div class="admin-name">${esc(u.nickname)} <span class="admin-wx">${esc(u.wxid)}</span></div>
        <div class="admin-meta">${tags.join(' ')} <span class="admin-stat">消息 ${u.messageCount} · 好友 ${u.friendCount}</span></div>
      </div>
      <div class="admin-ops">${ops}</div>
    </div>`
  }).join('')
}

async function refreshAdmin() {
  if (adminView === 'users') await loadAdminUsers()
  else if (adminView === 'rooms') await loadAdminRooms()
  else if (adminView === 'ann') await loadAdminAnn()
  else if (adminView === 'feedback') await loadAdminFeedback()
  else if (adminView === 'bans') await loadAdminBans()
  else if (adminView === 'admins') await loadAdminAdmins()
  else if (adminView === 'fbreq') await loadAdminFbReq()
  else if (adminView === 'dms') await loadAdminDms()
  else if (adminView === 'groups') await loadAdminGroups()
  else if (adminView === 'msgs') await loadAdminMsgs()
  else if (adminView === 'deleted') await loadAdminDeleted()
  else await loadAdminData()
}

async function onAdminAction(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const uid = b.dataset.uid
  const act = b.dataset.act
  const u = adminCache.find(x => x.uid === uid)
  if (act === 'detail') return openUserDetail(uid)
  if (act === 'note') {
    const cur = (u && u.adminNote) || ''
    const note = prompt(`为「${u ? u.nickname : uid}」写备注（仅 CMO 可见，用户看不到，最多 200 字）：`, cur)
    if (note === null) return
    try {
      await Net.adminNote(uid, note)
      if (u) u.adminNote = note.trim().slice(0, 200)
      toast('备注已保存（用户不可见）')
      renderAdminUsers()
    } catch (e) { toast(e.message || '保存失败') }
    return
  }
  if (act === 'delete') return openDelModal(uid)
  if (act === 'setlevel') {
    const cur = u ? (u.level || 1) : 1
    const v = prompt('设置「' + (u ? u.nickname : uid) + '」的等级（1-80）\n经验值会同步设为 等级²，后续聊天自然增长', cur)
    if (v === null) return
    const n = Math.floor(Number(v))
    if (!(n >= 1 && n <= 80)) { toast('等级需在 1-80 之间'); return }
    b.dataset.level = n
  }
  if (act === 'purge') {
    const n = u ? u.nickname : uid
    if (!confirm('彻底注销「' + n + '」？\n\n· 该用户全部数据将被清空（消息/朋友圈/抽奖/意见等）\n· 不占用 IP 注册名额，该网络可立即重新注册\n· 此操作不可恢复！')) return
    b.dataset.confirmed = '1'
  }
  if (act === 'ban') return openBanModal(uid)
  /* 解封前二次确认，防误触 */
  if (act === 'unban') {
    if (!confirm('确定解除「' + (u ? u.nickname : uid) + '」的封禁吗？解封后对方立即恢复发言。')) return
  }
  if (act === 'resetpwd') {
    const pwd = prompt(`为「${u ? u.nickname : uid}」设置新密码（至少 8 位）：`)
    if (!pwd) return
    if (pwd.length < 4) { toast('密码至少 4 位'); return }
    const wx = prompt('如需同时修改KB号请填写，不改请留空：', u ? u.wxid : '') || ''
    b.dataset.pwd = pwd
    b.dataset.wx = wx.trim()
  }
  b.disabled = true
  try {
    await Net.adminAction(uid, act, {
      hours: b.dataset.hours,
      password: b.dataset.pwd,
      wxid: b.dataset.wx,
      level: b.dataset.level,
      reason: '违反社区规范',
    })
    refreshAdmin()
    await syncConversations()
    toast(act === 'unban' ? '已解除封禁'
      : act === 'mute' ? '已执行禁言'
      : act === 'resetpwd' ? '密码已重置'
      : '已解除禁言')
  } catch (err) {
    toast(err.message || '操作失败')
    b.disabled = false
  }
}

/* ---------- 账号详情 ---------- */
let detailUid = ''
async function openUserDetail(uid) {
  detailUid = uid
  el('udNewPwd').value = ''
  if (el('udNewNick')) el('udNewNick').value = ''
  openModal('modalUser')
  el('userDetail').innerHTML = '<p class="muted">加载中…</p>'
  let d
  try { d = await Net.adminUser(uid) } catch (e) {
    el('userDetail').innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  if (el('udNewNick')) el('udNewNick').value = d.nickname || ''
  if (el('udLoc')) el('udLoc').value = d.regLoc || ''
  const row = (k, v, mono) => `<div class="ud-row"><span class="ud-key">${k}</span><span class="ud-val${mono ? ' mono' : ''}">${esc(v)}</span></div>`
  el('userDetail').innerHTML = [
    row('KB号', d.wxid, true),
    row('昵称', d.nickname),
    row('真实姓名', d.realName || '（未填写）'),
    row('密码', d.hasPassword ? '已设置（加密存储，不可查看）' : '（未设置）'),
    row('在线状态', d.online ? '在线' : '离线'),
    row('注册时间', fmtFull(d.createdAt)),
    row('注册 IP 归属地', (d.regLoc || '未知') + (d.regLocManual ? '（已人工更正）' : '（按出口 IP 推断）') +
      '　' + (d.regIp || ''), true),
    row('个性签名', d.signature || '（无）'),
    row('消息数', String(d.messageCount)),
    row('好友数', String(d.friendCount)),
    d.bannedUntil ? row('封禁至', fmtFull(d.bannedUntil) + (d.banReason ? '（' + d.banReason + '）' : '')) : '',
    d.mutedUntil ? row('禁言至', fmtFull(d.mutedUntil)) : '',
  ].join('')
  el('btnUdLocSave').onclick = async () => {
    const loc = el('udLoc').value.trim()
    try {
      await Net.adminAction(uid, 'setloc', { loc })
      toast(loc ? '归属地已更正为「' + loc + '」' : '已清空归属地')
      await openUserDetail(uid)
    } catch (e) { toast(e.message || '保存失败') }
  }
  el('btnUdRename').onclick = async () => {
    const next = el('udNewNick').value.trim()
    if (!next) { toast('请输入新昵称'); return }
    if (next === d.nickname) { toast('新昵称与原来相同'); return }
    if (next.length > 16) { toast('昵称不能超过 16 个字'); return }
    const btn = el('btnUdRename')
    btn.disabled = true
    try {
      const r = await Net.adminAction(uid, 'rename', { nickname: next })
      toast('您已将用户 ' + r.wxid + ' 原来的昵称「' + r.old + '」改为了「' + r.nickname + '」。', 6500)
      await openUserDetail(uid)
      refreshAdmin()
      syncConversations()
    } catch (e) {
      toast(e.message || '修改失败')
    } finally { btn.disabled = false }
  }
  el('btnUdResetPwd').onclick = async () => {
    const pwd = el('udNewPwd').value.trim()
    if (pwd.length < 4) { toast('新密码至少 4 位'); return }
    try {
      await Net.adminAction(uid, 'resetpwd', { password: pwd })
      toast('新密码已设置成功，请自行告知用户（密码不会被保存显示）', 3200)
      openUserDetail(uid)
    } catch (e) { toast(e.message || '重置失败') }
  }
  el('btnUdDelete').onclick = () => openDelModal(uid)
  el('btnUdBan').onclick = () => openBanModal(uid)
  el('btnUdClose').onclick = closeModal
}

/* ---------- 删除用户（理由 + 可选清空聊天数据） ---------- */
function openDelModal(uid) {
  const u = adminCache.find(x => x.uid === uid)
  el('delWho').textContent = `将删除用户：${u ? u.nickname + '（' + u.wxid + '）' : uid}`
  el('delReason').value = ''
  el('delWipe').checked = false
  el('delErr').textContent = ''
  el('btnDelCancel').onclick = closeModal
  el('btnDelOk').onclick = async () => {
    const reason = el('delReason').value.trim()
    if (!reason) { el('delErr').textContent = '请填写删除理由'; return }
    const btn = el('btnDelOk')
    btn.disabled = true
    btn.textContent = '删除中…'
    try {
      await Net.adminAction(uid, 'delete', { reason, wipe: el('delWipe').checked })
      closeModal()
      refreshAdmin()
      await syncConversations()
      toast('账号已删除，相关会话已收到公告', 3000)
    } catch (e) {
      el('delErr').textContent = e.message || '删除失败'
    } finally {
      btn.disabled = false
      btn.textContent = '确认删除'
    }
  }
  openModal('modalDel')
}

/* ---------- 封禁用户（按时间 / 按日期切换 + 理由） ---------- */
let banMode = 'hours'
function openBanModal(uid) {
  const u = adminCache.find(x => x.uid === uid)
  el('banWho').textContent = `将封禁用户：${u ? u.nickname + '（' + u.wxid + '）' : uid}`
  el('banReason').value = ''
  el('banHours').value = 24
  el('banDate').value = ''
  el('banErr').textContent = ''
  setBanMode('hours')
  el('banMode').querySelectorAll('button').forEach(b => {
    b.onclick = () => setBanMode(b.dataset.m)
  })
  el('btnBanCancel').onclick = closeModal
  el('btnBanOk').onclick = async () => {
    const reason = el('banReason').value.trim()
    if (!reason) { el('banErr').textContent = '请填写封禁理由'; return }
    const body = { reason, mode: banMode }
    if (banMode === 'hours') {
      const h = Number(el('banHours').value)
      if (!(h > 0)) { el('banErr').textContent = '请填写正确的封禁小时数'; return }
      body.hours = h
    } else {
      const v = el('banDate').value
      if (!v) { el('banErr').textContent = '请选择解封日期'; return }
      body.value = v
    }
    const btn = el('btnBanOk')
    btn.disabled = true
    btn.textContent = '封禁中…'
    try {
      const r = await Net.adminAction(uid, 'ban', body)
      closeModal()
      refreshAdmin()
      await syncConversations()
      toast('已封禁，解封时间：' + fmtFull(r.until), 3200)
    } catch (e) {
      el('banErr').textContent = e.message || '封禁失败'
    } finally {
      btn.disabled = false
      btn.textContent = '确认封禁'
    }
  }
  openModal('modalBan')
}

function setBanMode(m) {
  banMode = m
  el('banMode').querySelectorAll('button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.m === m))
  el('banHoursBox').hidden = m !== 'hours'
  el('banDateBox').hidden = m !== 'date'
}

/* ---------- 公告栏 ---------- */
/* KB靠北科技审核处 公章（来自 stamp.html） */
const OFFICIAL_STAMP = `<svg class="stamp-svg" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-label="KB靠北科技审核处公章">
  <defs>
    <path id="topArc" d="M 36,200 A 164,164 0 0,1 364,200" fill="none"/>
    <path id="bottomArc" d="M 36,200 A 164,164 0 0,0 364,200" fill="none"/>
    <filter id="ink" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="11" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.3"/>
    </filter>
  </defs>
  <g filter="url(#ink)">
    <circle cx="200" cy="200" r="192" fill="none" stroke="#c8102e" stroke-width="12"/>
    <text fill="#c8102e" font-size="27" font-family="SimHei, STHeiti, 'Microsoft YaHei', sans-serif" font-weight="900" letter-spacing="1">
      <textPath href="#topArc" startOffset="50%" text-anchor="middle">KB靠北科技审核处</textPath>
    </text>
    <text fill="#c8102e" font-size="22" font-family="'Arial Black', 'Helvetica Neue', Helvetica, sans-serif" font-weight="900" letter-spacing="1">
      <textPath href="#bottomArc" startOffset="50%" text-anchor="middle">2026.kaobei</textPath>
    </text>
    <g transform="translate(200,200)">
      <path fill="#c8102e" d="M 0,-115 L 25.81,-35.54 L 109.36,-35.54 L 41.78,13.57 L 67.59,93.04 L 0,43.93 L -67.59,93.04 L -41.78,13.57 L -109.36,-35.54 L -25.81,-35.54 Z"/>
    </g>
  </g>
</svg>`
const ANN_TITLE = { group: '群公告', direct: '指定公告', normal: '普通 Chat 公告', important: '重要 Chat 公告' }
S.ann = { list: [], unread: [], tab: 'group' }
S._importantShown = new Set()
S._importantQueue = []
S._importantShowing = false

async function loadAnn() {
  try {
    const r = await Net.annList()
    S.ann.list = r.list || []
    S.ann.unread = r.unread || []
  } catch (e) { S.ann.list = []; S.ann.unread = [] }
  syncChatAnnBanner()
  /* 未读重要 Chat 公告：登录时补弹（在线的已由 SSE 立即弹过，弹窗队列会去重） */
  const pend = (S.ann.list || []).filter(a =>
    a.type === 'important' && (S.ann.unread || []).includes(a.id) && !S._importantShown.has(a.id))
  if (pend.length) queueImportantAnn(pend)
}

/* ---------- 重要 Chat 公告弹窗：每条需浏览 5 秒才能确认，确认前无法回到主页 ---------- */
function queueImportantAnn(anns) {
  const list = (anns || []).filter(a => a && !S._importantShown.has(a.id))
  if (!list.length) return
  list.forEach(a => S._importantShown.add(a.id))
  S._importantQueue = (S._importantQueue || []).concat(list)
  if (!S._importantShowing) nextImportantAnn()
}
function nextImportantAnn() {
  const ann = (S._importantQueue || []).shift()
  if (!ann) { S._importantShowing = false; return }
  S._importantShowing = true
  const guest = !S.uid   /* 登录页游客模式：已读记 localStorage */
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.style.zIndex = 500
  layer.innerHTML = `<div class="qr-box" style="max-width:420px;text-align:left">
    <p style="text-align:center;font-size:12px;color:#c0392b;font-weight:600;margin:0 0 4px">📢 重要 Chat 公告${guest ? '' : ' · 全员必读'}</p>
    <h3 style="text-align:center;margin:0 0 6px">${esc(ann.title || '重要公告')}</h3>
    <p class="muted" style="text-align:center;font-size:11px;margin:0 0 10px">发布：${esc(ann.fromName || 'KB靠北科技')} · ${esc(String(ann.reviewedBy || '').slice(0, 30))}</p>
    <div style="max-height:44vh;overflow-y:auto;border:1px solid var(--line,#e3e3e3);border-radius:10px;padding:12px;font-size:13.5px;line-height:1.7;white-space:pre-wrap">${esc(ann.body || '')}</div>
    <div class="modal-btns" style="margin-top:12px">
      <button class="btn-primary" id="impAnnOk" disabled style="width:100%">我已仔细阅读（5s）</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  const btn = layer.querySelector('#impAnnOk')
  let left = 5
  const timer = setInterval(() => {
    left--
    if (left > 0) { btn.textContent = `我已仔细阅读（${left}s）`; return }
    clearInterval(timer)
    btn.disabled = false
    btn.textContent = '我已仔细阅读，返回'
  }, 1000)
  btn.onclick = async () => {
    if (btn.disabled) return
    clearInterval(timer)
    if (guest) {
      try {
        const read = new Set(JSON.parse(localStorage.getItem('kbchat_guest_ann_read') || '[]'))
        read.add(ann.id)
        localStorage.setItem('kbchat_guest_ann_read', JSON.stringify([...read].slice(-50)))
      } catch (e) {}
    } else {
      try { await Net.annRead([ann.id]) } catch (e) {}
    }
    layer.remove()
    nextImportantAnn()
  }
}

function renderAnnDot() {
  const n = (S.ann.unread || []).length
  const dot = el('annDot')
  if (dot) dot.hidden = n === 0
}

function syncChatAnnBanner() {
  const n = (S.ann.unread || []).length
  const dot = el('annDot')
  if (dot) dot.hidden = n === 0
  if (typeof updateChatAnnBanner === 'function') updateChatAnnBanner()
}

/* 登录动作后进入公告栏视图（占满主区域），代替原先的小弹窗 */
async function showAnnView() {
  showView('ann')
  el('annListFull').innerHTML = '<p class="muted">加载中…</p>'
  await loadAnn()
  document.querySelectorAll('#annTabsView .atab').forEach(b => {
    b.classList.toggle('is-on', b.dataset.t === S.ann.tab)
    b.onclick = () => {
      S.ann.tab = b.dataset.t
      document.querySelectorAll('#annTabsView .atab').forEach(x =>
        x.classList.toggle('is-on', x.dataset.t === S.ann.tab))
      renderAnnListFull()
    }
  })
  renderAnnListFull()
  /* 公告栏里的 ＋：直接新增公告，类型默认为当前所在的分类页签 */
  el('btnAnnCreate').onclick = () => openAnnForm(S.ann.tab)
  el('btnAnnFormView').onclick = () => openAnnForm('group')
  el('btnAnnReadView').onclick = doAnnReadAll
}

/* 分类页签上的未读红点 */
function renderAnnTabDots() {
  const byType = {}
  ;(S.ann.unread || []).forEach(id => {
    const a = (S.ann.list || []).find(x => x.id === id)
    if (a) byType[a.type] = (byType[a.type] || 0) + 1
  })
  document.querySelectorAll('#annTabsView .atab').forEach(b => {
    const n = byType[b.dataset.t] || 0
    b.textContent = ANN_TITLE[b.dataset.t] + (n ? ' (' + n + ')' : '')
    b.classList.toggle('has-unread', n > 0)
  })
}

function toggleAnnCard(card) {
  const d = card.querySelector('.ann-detail')
  if (!d) return
  d.hidden = !d.hidden
  card.classList.toggle('is-open', !d.hidden)
  const tip = card.querySelector('.ann-open-tip')
  if (tip) tip.textContent = d.hidden ? '展开正文 ▼' : '收起正文 ▲'
  /* 展开正文即视为已读：只更新这张卡片的状态，不整表重绘（否则会立刻收起） */
  if (!d.hidden) markAnnRead(card.dataset.id)
}

async function markAnnRead(id) {
  if (!id) return
  if (!(S.ann.unread || []).includes(id)) return
  try {
    await Net.annRead([id])
    S.ann.unread = (S.ann.unread || []).filter(x => x !== id)
    const card = document.querySelector('.ann-card[data-id="' + id + '"]')
    if (card) {
      card.classList.remove('is-new')
      const tag = card.querySelector('.ann-head > .tag')
      if (tag) { tag.textContent = '已读'; tag.className = 'tag' }
    }
    renderAnnTabDots()
    const tip = el('annUnreadTip')
    if (tip) tip.textContent = (S.ann.unread || []).length
      ? `还有 ${S.ann.unread.length} 条公告未读` : '公告全部已读'
    renderAnnDot()
  } catch (e) {}
}

function renderAnnListFull() {
  const box = el('annListFull')
  const list = (S.ann.list || []).filter(a => a.type === S.ann.tab)
  renderAnnTabDots()
  if (!list.length) {
    box.innerHTML = `<p class="muted">暂无${ANN_TITLE[S.ann.tab]}</p>`
    return
  }
  /* 列表只显示标题与落款摘要，点击卡片展开正文，避免长公告占满屏 */
  const favReady = Array.isArray(S.favorites)
  const isAdminUser = !!(S.profile && S.profile.isAdmin)
  box.innerHTML = list.slice().reverse().map(a => {
    const isNew = (S.ann.unread || []).includes(a.id)
    const faved = favReady && isFav('ann', a.id)
    const stamp = a.status === 'approved'
      ? `<div class="ann-stamp">${OFFICIAL_STAMP}</div>` : ''
    return `<div class="ann-card${isNew ? ' is-new' : ''}" data-id="${esc(a.id)}">
      <div class="ann-head">
        <b>${esc(a.title)}</b>
        ${isNew ? '<span class="tag tag-ban">未读</span>' : '<span class="tag">已读</span>'}
        ${a.status === 'pending' ? '<span class="tag tag-mute">待审批</span>' : ''}
        <span class="ann-fav${faved ? ' is-on' : ''}" data-favann="${esc(a.id)}"
          data-favstar="ann:${esc(a.id)}" data-favtitle="收藏这条公告"
          title="${faved ? '取消收藏' : '收藏这条公告'}">${faved ? '⭐' : '☆'}</span>
        ${isAdminUser ? `<span class="ann-del" data-delann="${esc(a.id)}" title="删除这条公告（不可恢复）">🗑️</span>` : ''}
        <span class="ann-open-tip">展开正文 ▼</span>
      </div>
      <div class="ann-sign">落款：${esc(a.fromName)} · ${esc(fmtFull(a.publishedAt))}</div>
      <div class="ann-detail" hidden>
        <div class="ann-body">${esc(a.body)}</div>
        ${stamp}
      </div>
    </div>`
  }).join('')
  box.querySelectorAll('.ann-card').forEach(card => {
    card.onclick = e => {
      /* 正文区域内点击（含选择复制、滚动）不触发收起 */
      if (e.target.closest('.ann-detail')) return
      toggleAnnCard(card)
    }
  })
  /* 公告星标：点击即切换收藏 / 取消收藏 */
  box.querySelectorAll('[data-favann]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation()
      const a = (S.ann.list || []).find(x => x.id === btn.dataset.favann)
      if (!a) return
      await collectFavorite({
        kind: 'ann', ref: a.id, title: a.title, text: a.body || '',
        from: a.from, fromName: a.fromName,
      })
    }
  })
  /* 公告删除（仅管理员可见）：公告栏里直接删，无需进管理面板 */
  box.querySelectorAll('[data-delann]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation()
      if (!confirm('删除这条公告？此操作不可恢复。')) return
      try {
        await Net.annDelete(btn.dataset.delann)
        toast('公告已删除', 1800)
        await loadAnn()
        renderAnnListFull()
      } catch (err) { toast(err.message || '删除失败') }
    }
  })
  const tip = el('annUnreadTip')
  if (tip) tip.textContent = (S.ann.unread || []).length
    ? `还有 ${S.ann.unread.length} 条公告未读` : '公告全部已读'
}

async function doAnnReadAll() {
  if (!confirm('是否一键已读？您可能错过许多信息。')) return
  await Net.annRead([])
  S.ann.unread = []
  renderAnnDot()
  renderAnnListFull()
  /* 一键已读同时清掉会话列表的红点（公告本身保留，只是标记为已读） */
  S.conversations.forEach(c => { c.unread = 0 })
  renderChatList()
  renderRail()
  toast('所有公告已标记为已读')
}

/* 离开公告栏：有未读时确认；返回 true 表示允许离开 */
function closeAnnView() {
  const n = (S.ann.unread || []).length
  if (n && !confirm('您有公告未查看，是否关闭？')) return false
  return true
}

/* ---------- 发布公告 ---------- */
let annFormType = 'group'
async function openAnnForm(type) {
  annFormType = type || 'group'
  el('annTitle').value = ''
  el('annBody').value = ''
  el('annErr').textContent = ''
  /* 重要公告可见范围三选（默认仅登录用户） */
  el('annAudienceBox').hidden = annFormType !== 'important'
  document.querySelectorAll('#annAudience button').forEach(b => {
    b.classList.toggle('is-on', b.dataset.a === 'login')
    b.onclick = () => {
      document.querySelectorAll('#annAudience button').forEach(x => x.classList.toggle('is-on', x === b))
      el('annAudienceTip').textContent =
        b.dataset.a === 'all' ? '所有人可见：登录页游客也会弹出（每条需浏览 5 秒确认）'
        : b.dataset.a === 'registered' ? '仅注册用户可见：有账号的用户弹出（在线立即弹、离线登录补弹）'
        : '登录用户在线立即弹出，离线的登录时补弹；每条需浏览 5 秒确认'
    }
  })
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  el('annFormWho').textContent = isAdmin
    ? '管理员（CMO）无需申请，可直接发布所有类型公告'
    : '群公告只能发到自己所在的群；指定公告只能发给好友且需 3 人以上'
  openModal('modalAnnForm')
  document.querySelectorAll('#annType button').forEach(b => {
    b.classList.toggle('is-on', b.dataset.t === annFormType)
    b.onclick = () => {
      annFormType = b.dataset.t
      document.querySelectorAll('#annType button').forEach(x =>
        x.classList.toggle('is-on', x.dataset.t === annFormType))
      renderAnnTargets()
      syncAnnFormBtn()
    }
  })
  await renderAnnTargets()
  syncAnnFormBtn()
  el('btnAnnFormCancel').onclick = closeModal
  el('btnAnnFormOk').onclick = submitAnn
}

function syncAnnFormBtn() {
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  el('btnAnnFormOk').textContent =
    (['normal', 'important'].includes(annFormType) && !isAdmin) ? '向管理员请求发送公告' : '提交并发布'
  el('annTargetLabel').textContent =
    annFormType === 'group' ? '选择群（可多选）'
    : annFormType === 'direct' ? '选择接收人（至少 3 人）'
    : '面向全体用户，无需选择'
  el('annTargetBox').hidden = ['normal', 'important'].includes(annFormType)
}

async function renderAnnTargets() {
  const box = el('annTargets')
  if (['normal', 'important'].includes(annFormType)) { box.innerHTML = ''; return }
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  if (annFormType === 'group') {
    const groups = isAdmin
      ? await (async () => { try { return (await Net.adminGroups('')).groups || [] } catch (e) { return [] } })()
      : S.groups.map(g => ({ roomId: g.roomId, name: g.name }))
    if (!groups.length) { box.innerHTML = '<p class="muted">暂无可发布的群</p>'; return }
    box.innerHTML = groups.map(g =>
      `<label class="ann-pick"><input type="checkbox" value="${esc(g.roomId)}"> ${esc(g.name)}</label>`).join('')
  } else {
    const users = isAdmin
      ? await (async () => { try { return (await Net.adminUsers()).users || [] } catch (e) { return [] } })()
      : S.friends.map(f => ({ uid: f.uid, nickname: f.name, wxid: f.wxid }))
    if (!users.length) { box.innerHTML = '<p class="muted">暂无可选择的接收人</p>'; return }
    box.innerHTML = users.filter(u => !(isAdmin && u.isAdmin)).map(u =>
      `<label class="ann-pick"><input type="checkbox" value="${esc(u.uid)}"> ${esc(u.nickname || u.wxid)}（${esc(u.wxid)}）</label>`).join('')
  }
}

async function submitAnn() {
  const title = el('annTitle').value.trim()
  const body = el('annBody').value.trim()
  const err = el('annErr')
  err.textContent = ''
  if (!title) { err.textContent = '请填写主题'; return }
  if (!body) { err.textContent = '请填写正文'; return }
  const targets = [...el('annTargets').querySelectorAll('input:checked')].map(i => i.value)
  if (annFormType === 'group' && !targets.length) { err.textContent = '请至少选择一个群'; return }
  if (annFormType === 'direct' && targets.length < 3) { err.textContent = '指定公告必须选择 3 人以上'; return }
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  if (!isAdmin && ['group', 'direct'].includes(annFormType)) {
    if (!confirm('不良语言立马封禁，严重者立马删除。是否继续提交？')) return
  }
  const btn = el('btnAnnFormOk')
  btn.disabled = true
  const audienceBtn = document.querySelector('#annAudience button.is-on')
  const audience = annFormType === 'important' ? (audienceBtn ? audienceBtn.dataset.a : 'login') : 'login'
  try {
    const r = await Net.annSubmit({ type: annFormType, title, body, targets, audience })
    closeModal()
    await loadAnn()
    renderAnnListFull()
    if (S.view === 'ann') renderAnnListFull()
    toast(r.status === 'pending'
      ? '已提交，等待管理员审批'
      : '公告已发布', 3000)
    if (adminView === 'ann' && S.view === 'admin') loadAdminAnn()
  } catch (e) {
    err.textContent = e.message || '提交失败'
  } finally { btn.disabled = false }
}

/* ---------- 管理端：Chat公告 ---------- */
async function loadAdminAnn() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.annMine()
    const list = r.list || []
    const pending = list.filter(a => a.status === 'pending')
    const head = `<div class="ann-admin-bar">
      <button class="mini-op ok" id="btnAnnNew">发布新公告</button>
      <span class="muted">共 ${list.length} 条公告，待审批 ${pending.length} 条</span></div>`
    if (!list.length) { box.innerHTML = head + '<p class="muted">还没有公告</p>' }
    else {
      box.innerHTML = head + list.map(a => `<div class="admin-item">
        <div class="admin-av">📢</div>
        <div class="admin-info">
          <div class="admin-name">${esc(a.title)}
            <span class="admin-wx">${esc(ANN_TITLE[a.type] || a.type)}</span></div>
          <div class="admin-meta">
            <span class="tag">${a.status === 'pending' ? '待审批' : a.status === 'rejected' ? '已驳回' : '已发布'}</span>
            <span class="admin-stat">${esc(a.fromName)} · ${esc(fmtFull(a.publishedAt))}</span></div>
          <div class="admin-stat">${esc(a.body.slice(0, 80))}</div>
        </div>
        <div class="admin-ops">${a.status === 'pending'
          ? `<button class="mini-op ok" data-id="${esc(a.id)}" data-act="annok">批准发布</button>
             <button class="mini-op danger" data-id="${esc(a.id)}" data-act="annno">驳回</button>`
          : '<span class="muted">—</span>'}</div></div>`).join('')
    }
    const nb = el('btnAnnNew')
    if (nb) nb.onclick = () => openAnnForm('normal')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

function onAdminAnnClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const approve = b.dataset.act === 'annok'
  Net.annReview(b.dataset.id, approve)
    .then(() => { toast(approve ? '已批准发布' : '已驳回'); loadAdminAnn(); loadAnn() })
    .catch(err => toast(err.message || '操作失败'))
}

/* ---------- 管理端：管理员管理 ---------- */
const ADMIN_PERMS = [
  ['users', '账号管理'], ['dms', '单聊管理'], ['groups', '群聊管理'], ['rooms', '消息审查'],
  ['ann', 'Chat公告'], ['msgs', '聊天记录'], ['deleted', '账号删除'], ['bans', '封号管理'],
  ['sever', '断绝关系'], ['pin', '置顶'], ['lucky', '抽奖管理'], ['admins', '管理员管理'],
]
function permHtml(perms) {
  return ADMIN_PERMS.map(p =>
    `<label class="perm-item"><input type="checkbox" value="${p[0]}"${perms && perms[p[0]] ? ' checked' : ''}> ${p[1]}</label>`).join('')
}
function readPerms(boxId) {
  const out = {}
  el(boxId).querySelectorAll('input:checked').forEach(i => { out[i.value] = 1 })
  return out
}
function renderPermsInto(boxId, perms) {
  el(boxId).innerHTML = permHtml(perms)
}

async function loadAdminAdmins() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminAdmins()
    const list = r.list || []
    const head = `<div class="ann-admin-bar">
      <button class="mini-op ok" id="btnInviteAdmin">＋ 邀请管理员</button>
      <span class="muted">当前 ${list.length} 位管理员</span></div>`
    if (!list.length) { box.innerHTML = head + '<p class="muted">暂无管理员</p>' }
    else {
      box.innerHTML = head + list.map(a => `<div class="admin-item">
        <div class="admin-av">${a.isSuper ? '👑' : avatarHtml(a.avatar)}</div>
        <div class="admin-info">
          <div class="admin-name">${esc(a.nickname)} <span class="admin-wx">${esc(a.wxid)}</span></div>
          <div class="admin-meta">
            <span class="tag tag-cmo">${esc(a.role || 'CMO')}</span>
            ${a.isSuper ? '<span class="tag">全部权限</span>'
              : '<span class="admin-stat">' +
                (ADMIN_PERMS.filter(p => a.perms && a.perms[p[0]]).map(p => p[1]).join('、') || '未分配权限') +
                '</span>'}
          </div>
        </div>
        <div class="admin-ops">${a.isSuper ? '<span class="muted">—</span>' : `
          <button class="mini-op" data-uid="${esc(a.uid)}" data-act="perm">更改权限</button>
          <button class="mini-op danger" data-uid="${esc(a.uid)}" data-act="dismiss">删除管理员</button>`}</div>
      </div>`).join('')
    }
    el('btnInviteAdmin').onclick = openInviteAdmin
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

function openInviteAdmin() {
  el('aiWxid').value = ''
  /* 选人：把非管理员用户灌进 datalist，点输入框直接挑（也可继续手输 KB号） */
  const aiList = el('aiWxidList')
  const fillAiList = () => {
    if (!aiList) return
    aiList.innerHTML = (adminCache || [])
      .filter(u => !u.isAdmin && !u.deleted)
      .map(u => `<option value="${esc(u.wxid)}">${esc(u.nickname || u.wxid)}${u.realName ? ' · ' + esc(u.realName) : ''}</option>`)
      .join('')
  }
  fillAiList()
  /* 缓存为空（未先加载过用户列表）时兜底拉一次 */
  if (!(adminCache || []).length) {
    Net.adminUsers().then(r => { adminCache = r.users || []; fillAiList() }).catch(() => {})
  }
  el('aiErr').textContent = ''
  renderPermsInto('aiPerms', { users: 1, rooms: 1 })
  el('btnAiOk').onclick = async () => {
    const wxid = el('aiWxid').value.trim()
    if (!wxid) { el('aiErr').textContent = '请输入对方KB号'; return }
    try {
      await Net.adminInvite(wxid, readPerms('aiPerms'))
      closeModal()
      toast('已发出邀请，对方现在拥有所选权限')
      loadAdminAdmins()
      await loadAdminUsers()
    } catch (e) { el('aiErr').textContent = e.message || '邀请失败' }
  }
  el('btnAiCancel').onclick = closeModal
  openModal('modalAdminInvite')
}

async function onAdminAdminsClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const uid = b.dataset.uid
  if (b.dataset.act === 'dismiss') {
    if (!confirm('删除该管理员？仅取消其管理员身份，不会封号或删除账号。')) return
    try { await Net.adminDismiss(uid); toast('已解除管理员身份'); loadAdminAdmins() }
    catch (err) { toast(err.message || '操作失败') }
    return
  }
  if (b.dataset.act === 'perm') {
    const cur = (adminCache && adminCache.length) ? null : null
    const list = (await Net.adminAdmins()).list || []
    const a = list.find(x => x.uid === uid)
    openPermEditor(uid, a && a.perms)
  }
}

function openPermEditor(uid, perms) {
  const box = el('adminList')
  box.innerHTML = `<h4 style="margin:0 0 8px">更改权限</h4>
    <div class="perm-box" id="pePerms">${permHtml(perms)}</div>
    <div class="modal-btns" style="margin-top:10px">
      <button class="btn-ghost" id="btnPeCancel">返回</button>
      <button class="btn-primary" id="btnPeOk">保存权限</button>
    </div>`
  el('btnPeCancel').onclick = loadAdminAdmins
  el('btnPeOk').onclick = async () => {
    try {
      await Net.adminPerm(uid, readPerms('pePerms'))
      toast('权限已更新')
      loadAdminAdmins()
    } catch (e) { toast(e.message || '保存失败') }
  }
}

/* ---------- 管理端：封号管理 ---------- */
async function loadAdminBans() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminBans()
    const list = r.list || []
    if (!list.length) { box.innerHTML = '<p class="muted">当前没有被封禁的用户</p>'; return }
    box.innerHTML = `<p class="muted">共 ${list.length} 人被封禁</p>` + list.map(u => `<div class="admin-item">
      <div class="admin-av">${avatarHtml(u.avatar)}</div>
      <div class="admin-info">
        <div class="admin-name">${esc(u.nickname)} <span class="admin-wx">${esc(u.wxid)}</span></div>
        <div class="admin-meta"><span class="tag tag-ban">封禁至 ${esc(fmtFull(u.until))}</span>
          <span class="admin-stat">剩余约 ${u.leftHours} 小时</span></div>
        <div class="admin-stat">理由：${esc(u.reason || '未填写')}</div>
      </div>
      <div class="admin-ops">
        <button class="mini-op" data-uid="${esc(u.uid)}" data-act="rb1">减 1 小时</button>
        <button class="mini-op" data-uid="${esc(u.uid)}" data-act="rb24">减 24 小时</button>
        <button class="mini-op ok" data-uid="${esc(u.uid)}" data-act="unban">一键解封</button>
      </div></div>`).join('')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

async function onAdminBanClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const uid = b.dataset.uid
  /* 解封前二次确认，防误触 */
  if (b.dataset.act === 'unban') {
    /* 兼容老版 WebView：不用 ?. 可选链（2020 年前的 WebView 解析整个文件会失败 → 白屏） */
    const _it = b.closest('.admin-item')
    const _nm = _it ? _it.querySelector('.admin-name') : null
    const name = ((_nm && _nm.childNodes[0] && _nm.childNodes[0].textContent) ? _nm.childNodes[0].textContent.trim() : '') || '该用户'
    if (!confirm('确定解除「' + name + '」的封禁吗？解封后对方立即恢复发言。')) return
  }
  try {
    if (b.dataset.act === 'unban') await Net.adminAction(uid, 'unban', {})
    else await Net.adminAction(uid, 'reduceban', { hours: b.dataset.act === 'rb1' ? 1 : 24 })
    toast(b.dataset.act === 'unban' ? '已一键解封' : '已减少封禁时间')
    loadAdminBans()
    await loadAdminUsers()
  } catch (err) { toast(err.message || '操作失败') }
}

/* ---------- 管理端：意见箱 ---------- */
async function loadAdminFeedback() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminFeedback()
    const list = (r && r.list) || []
    if (!list.length) { box.innerHTML = '<p class="muted">还没有用户意见</p>'; return }
    box.innerHTML = `<p class="muted">共 ${list.length} 条用户意见</p>` + list.map(f => `<div class="admin-item">
      <div class="admin-av">💬</div>
      <div class="admin-info">
        <div class="admin-name">${esc(f.fromName)} <span class="admin-wx">${esc(f.wxid)}</span></div>
        <div class="admin-stat">${esc(fmtFull(f.at))}</div>
        <div class="admin-stat">${esc(f.text)}</div>
      </div></div>`).join('')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

/* ---------- 管理端：单聊管理 ---------- */
let dmFilter = 'all'
async function loadAdminDms(kw) {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminDms({ filter: dmFilter, kw: kw || '' })
    const head = `<div class="seg mf-mode" id="dmFilterSeg">
      <button type="button" data-f="all"${dmFilter === 'all' ? ' class="is-on"' : ''}>全部对话</button>
      <button type="button" data-f="alive"${dmFilter === 'alive' ? ' class="is-on"' : ''}>仅正常用户</button>
      <button type="button" data-f="deleted"${dmFilter === 'deleted' ? ' class="is-on"' : ''}>含已删除用户</button>
    </div><p class="muted mf-tip">上方搜索框可输入昵称 / KB号 / 对话内容后回车查找（共 ${r.total} 条对话）</p>`
    if (!r.dms.length) { box.innerHTML = head + '<p class="muted">没有符合条件的单聊</p>' }
    else {
      box.innerHTML = head + r.dms.map(d => {
        const delTag = (d.a.deleted || d.b.deleted)
          ? '<span class="tag tag-ban">含已删除用户</span>' : '<span class="tag tag-on">正常</span>'
        return `<div class="admin-item">
          <div class="admin-av">💬</div>
          <div class="admin-info">
            <div class="admin-name">${esc(d.title)}</div>
            <div class="admin-meta">${delTag}
              <span class="admin-stat">${d.msgCount} 条 · ${esc(fmtFull(d.lastAt))}</span></div>
            <div class="admin-stat">${esc(d.lastText || '')}</div>
          </div>
          <div class="admin-ops">
            <button class="mini-op ok" data-room="${esc(d.roomId)}" data-act="dmdetail">查看对话</button>
            <button class="mini-op" data-room="${esc(d.roomId)}" data-act="pin">置顶</button>
            <button class="mini-op" data-room="${esc(d.roomId)}" data-act="unpin">取消置顶</button>
            ${d.aAdmin || d.bAdmin ? '<span class="tag" title="CMO 与用户的好友关系由系统保障，不能断绝">含 CMO</span>'
              : `<button class="mini-op danger" data-room="${esc(d.roomId)}"
                  data-uid="${esc(d.a.uid)}" data-peer="${esc(d.b.uid)}"
                  data-aname="${esc(d.a.name)}" data-bname="${esc(d.b.name)}" data-act="sever">断绝关系</button>`}
          </div></div>`
      }).join('')
    }
    const seg = el('dmFilterSeg')
    if (seg) seg.querySelectorAll('button').forEach(b => {
      b.onclick = () => { dmFilter = b.dataset.f; loadAdminDms() }
    })
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

async function openDmDetail(roomId, title) {
  showView('admin')
  el('adminChat').hidden = false
  el('adminChat').innerHTML = `
      <div class="dm-search">
        <input id="dmKw" placeholder="在此对话中搜索关键词">
        <button class="mini-op" id="btnDmKw">搜索</button>
        <button class="mini-op ok" id="btnDmBack">收起</button>
      </div>
      <div class="admin-chat-head">${esc(title || '会话记录')}</div>
      <div id="dmBody"><p class="muted">加载中…</p></div>`
  const load = async kw => {
    el('dmBody').innerHTML = '<p class="muted">加载中…</p>'
    try {
      const r = await Net.adminDmMessages(roomId, kw)
      el('dmBody').innerHTML = r.messages.length
        ? `<p class="muted">共 ${r.total} 条</p>` + r.messages.map(m => `
            <div class="admin-msg">
              <span class="am-time">${esc(fmtShort(m.createdAt))}</span>
              <span class="am-who">${esc(m.sender || '系统')}</span>
              <span class="am-body">${m.kind === 'image' ? '[图片]' : m.kind === 'file' ? '[文件]' : esc(m.content)}</span>
            </div>`).join('')
        : '<p class="muted">没有匹配的消息</p>'
    } catch (e) { el('dmBody').innerHTML = `<p class="muted">${esc(e.message)}</p>` }
  }
  el('btnDmKw').onclick = () => load(el('dmKw').value.trim())
  el('dmKw').addEventListener('keydown', e => { if (e.key === 'Enter') load(el('dmKw').value.trim()) })
  el('btnDmBack').onclick = () => { el('adminChat').hidden = true }
  load('')
}

/* ---------- 管理端：群聊管理 ---------- */
async function loadAdminGroups(kw) {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminGroups(kw || '')
    if (!r.groups.length) { box.innerHTML = '<p class="muted">还没有群聊</p>'; return }
    box.innerHTML = r.groups.map(g => `<div class="admin-item">
      <div class="admin-av">${esc(g.avatar || '👥')}</div>
      <div class="admin-info">
        <div class="admin-name">${esc(g.name)} <span class="admin-wx">${(g.members || []).length} 人</span></div>
        <div class="admin-meta"><span class="admin-stat">${esc((g.memberNames || []).slice(0, 6).join('、'))}${(g.memberNames || []).length > 6 ? ' 等' : ''}</span></div>
        <div class="admin-stat">${g.msgCount} 条 · ${esc(fmtFull(g.lastAt))} ${esc(g.lastText || '')}</div>
      </div>
      <div class="admin-ops">
        <button class="mini-op ok" data-room="${esc(g.roomId)}" data-act="grpdm">查看群聊</button>
        <button class="mini-op" data-room="${esc(g.roomId)}" data-act="pin">置顶</button>
        <button class="mini-op" data-room="${esc(g.roomId)}" data-act="unpin">取消置顶</button>
      </div></div>`).join('')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

/* ---------- 管理端：断绝关系 ---------- */
async function onPinClick(b) {
  try {
    await Net.adminAction('', b.dataset.act, { roomId: b.dataset.room })
    toast(b.dataset.act === 'pin' ? '已置顶该会话' : '已取消置顶')
    refreshAdmin()
    await syncConversations()
  } catch (e) { toast(e.message || '操作失败') }
}

function onAdminDmClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  if (b.dataset.act === 'pin' || b.dataset.act === 'unpin') return onPinClick(b)
  if (b.dataset.act === 'dmdetail') {
    const item = b.closest('.admin-item')
    const title = item ? (item.querySelector('.admin-name') || {}).textContent : ''
    return openDmDetail(b.dataset.room, title)
  }
  if (b.dataset.act === 'sever') {
    return openSeverModal({
      uid: b.dataset.uid, peer: b.dataset.peer,
      aName: b.dataset.aname, bName: b.dataset.bname,
    })
  }
}

function onAdminGroupClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  if (b.dataset.act === 'pin' || b.dataset.act === 'unpin') return onPinClick(b)
  if (b.dataset.act === 'grpdm') {
    const item = b.closest('.admin-item')
    const title = item ? (item.querySelector('.admin-name') || {}).textContent : '群聊'
    return openDmDetail(b.dataset.room, title)
  }
}

function openSeverModal(o) {
  el('sevWho').textContent = `将断绝「${o.aName}」与「${o.bName}」的好友关系，断绝后双方无法重新加回。`
  el('sevWipe').checked = false
  el('sevErr').textContent = ''
  el('btnSevCancel').onclick = closeModal
  el('btnSevOk').onclick = async () => {
    const btn = el('btnSevOk')
    btn.disabled = true; btn.textContent = '处理中…'
    try {
      await Net.adminAction(o.uid, 'sever', { peerUid: o.peer, wipe: el('sevWipe').checked })
      closeModal()
      refreshAdmin()
      await syncConversations()
      toast('已断绝双方关系' + (el('sevWipe').checked ? '，聊天记录已删除' : '，聊天记录保留'), 3200)
    } catch (e) {
      el('sevErr').textContent = e.message || '操作失败'
    } finally {
      btn.disabled = false; btn.textContent = '确认断绝'
    }
  }
  openModal('modalSever')
}

/* ---------- 管理端：聊天记录查找与清空（与消息审查同款布局） ---------- */
let mfMode = 'member'
async function loadAdminMsgs() {
  const box = el('adminList')
  box.innerHTML = `
    <div class="seg mf-mode" id="mfMode">
      <button type="button" class="is-on" data-m="member">按成员查找</button>
      <button type="button" data-m="kw">按关键词搜全部</button>
    </div>
    <p class="muted mf-tip">在上方搜索框输入后按回车查找${mfMode === 'member' ? '（成员 KB号 / 昵称）' : '（消息内容关键词）'}</p>
    <div id="mfResult"><p class="muted">尚未查找</p></div>
    <div class="mf-wipe"><button class="mini-op danger" id="btnMfWipeAll">清空所有聊天记录</button></div>`
  el('mfMode').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      mfMode = b.dataset.m
      el('mfMode').querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b))
      el('adminSearch').placeholder = mfMode === 'member'
        ? '输入成员 KB号 / 昵称，回车查找'
        : '输入消息关键词，回车搜索全部'
      el('adminSearch').focus()
    }
  })
  el('btnMfWipeAll').onclick = async () => {
    if (!confirm('确定清空【所有】聊天记录？全部会话消息将被删除且不可恢复。')) return
    try {
      const r = await Net.adminMsgWipe({ all: true })
      toast(`已清空 ${r.removed} 条消息`)
      el('mfResult').innerHTML = '<p class="muted">聊天记录已全部清空</p>'
    } catch (e) { toast(e.message || '清空失败') }
  }
  setTimeout(() => el('adminSearch').focus(), 30)
}

function runMsgSearch() {
  const v = (el('adminSearch').value || '').trim()
  if (!v) { toast(mfMode === 'member' ? '请输入成员 KB号或昵称' : '请输入关键词'); return }
  if (mfMode === 'member') findMsgs({ member: v })
  else findMsgs({ kw: v })
}

async function findMsgs({ member, kw }) {
  const box = el('mfResult')
  box.innerHTML = '<p class="muted">查找中…</p>'
  let uid = ''
  if (member !== undefined) {
    await ensureAdminUsers()
    const m = adminCache.find(u =>
      u.wxid.toLowerCase() === member.toLowerCase() ||
      (u.nickname || '').toLowerCase() === member.toLowerCase() ||
      u.wxid.toLowerCase().includes(member.toLowerCase()) ||
      (u.nickname || '').toLowerCase().includes(member.toLowerCase()))
    if (!m) { box.innerHTML = '<p class="muted">未找到该成员，请确认KB号或昵称</p>'; return }
    uid = m.uid
  }
  try {
    const r = await Net.adminMsgFind({ uid, kw })
    if (!r.messages.length) { box.innerHTML = '<p class="muted">没有匹配的聊天记录</p>'; return }
    box.innerHTML = `<p class="muted">共 ${r.total} 条，显示最近 ${r.messages.length} 条</p>` +
      r.messages.map(m => `<div class="admin-item">
        <div class="admin-info">
          <div class="admin-name">${esc(m.sender)} <span class="admin-wx">${esc(m.senderWxid)}</span></div>
          <div class="admin-meta"><span class="admin-stat">[${esc(m.room)}] ${esc(fmtFull(m.createdAt))}</span></div>
          <div class="admin-stat">${m.kind === 'image' ? '[图片]' : m.kind === 'file' ? '[文件]' : esc(m.content)}</div>
        </div></div>`).join('')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '查找失败')}</p>`
  }
}

async function ensureAdminUsers() {
  if (adminCache.length) return
  try { adminCache = (await Net.adminUsers()).users || [] } catch (e) {}
}

/* ---------- 管理端：账号删除名单 ---------- */
async function loadAdminDeleted() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminDeleted()
    if (!r.deleted.length) { box.innerHTML = '<p class="muted">还没有删除记录</p>'; return }
    box.innerHTML = r.deleted.map(d => `<div class="admin-item">
      <div class="admin-av">🗑️</div>
      <div class="admin-info">
        <div class="admin-name">${esc(d.nickname)} <span class="admin-wx">${esc(d.wxid)}</span></div>
        <div class="admin-meta">
          <span class="tag tag-real">真名 ${esc(d.realName || '未知')}</span>
          <span class="tag">密码 ${d.hadPassword ? '已设置' : '未设置'}</span>
          <span class="tag">${d.wiped ? '聊天数据已清空' : '聊天数据保留'}</span>
        </div>
        <div class="admin-stat">理由：${esc(d.reason || '未填写')} · ${esc(fmtFull(d.at))} · 审批：${esc(d.operator || '管理员')}</div>
      </div></div>`).join('')
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}
/* ---------- 找朋友泡泡 ---------- */
/* 爱好只能是预设项多选，避免用户乱打字（也可以防止刷广告） */
const HOBBY_GROUPS = [
  { name: '运动', items: ['打篮球', '踢足球', '打羽毛球', '打乒乓球', '打网球', '跑步', '健身', '游泳', '骑行', '爬山', '瑜伽', '滑板', '台球', '滑雪'] },
  { name: '娱乐', items: ['看电影', '追剧', '听歌', '唱歌', '打游戏', '桌游', '看动漫', '看小说', '刷短视频', '剧本杀', '密室逃脱', '看演出'] },
  { name: '生活', items: ['做饭', '烘焙', '喝咖啡', '喝茶', '养猫', '养狗', '撸猫', '种花', '逛街', '旅行', '露营', '钓鱼'] },
  { name: '文艺', items: ['摄影', '画画', '书法', '写作', '弹吉他', '弹钢琴', '跳舞', '手工', '收藏', '剪视频', '设计'] },
  { name: '学习', items: ['编程', '读历史', '学外语', '看纪录片', '研究数码', '理财', '看新闻', '学心理学'] },
  { name: '社交', items: ['聊天', '交朋友', '组织活动', '志愿服务', '桌游局', '美食探店'] },
]
const HOBBY_MAX = 6
let pickedHobbies = []

function renderHobbyPicker() {
  const box = el('hobbyPicker')
  if (!box) return
  /* 自定义爱好单独成组（放在最前），与预设标签同样可选 */
  const customHtml = customHobbies.length
    ? `<div class="hobby-group"><div class="hobby-group-name">✏️ 自定义</div><div class="hobby-chips">` +
      customHobbies.map(h => `<button type="button" class="hobby-chip${pickedHobbies.includes(h) ? ' is-on' : ''}" data-h="${esc(h)}">${esc(h)}</button>`).join('') +
      `</div></div>`
    : ''
  box.innerHTML = customHtml + HOBBY_GROUPS.map(g => `
    <div class="hobby-group">
      <div class="hobby-group-name">${esc(g.name)}</div>
      <div class="hobby-chips">
        ${g.items.map(h => `<button type="button" class="hobby-chip${pickedHobbies.includes(h) ? ' is-on' : ''}" data-h="${esc(h)}">${esc(h)}</button>`).join('')}
      </div>
    </div>`).join('')
  box.onclick = e => {
    const chip = e.target.closest('.hobby-chip')
    if (!chip) return
    const h = chip.dataset.h
    const i = pickedHobbies.indexOf(h)
    if (i >= 0) pickedHobbies.splice(i, 1)
    else {
      if (pickedHobbies.length >= HOBBY_MAX) return toast('最多选 ' + HOBBY_MAX + ' 个爱好')
      pickedHobbies.push(h)
    }
    chip.classList.toggle('is-on', pickedHobbies.includes(h))
    updateHobbyCount()
  }
  updateHobbyCount()
}

/* ---------- 自定义爱好：AI 审查通过后加入标签（存本机，下次可复用） ---------- */
function customHobbiesKey() { return 'kbchat_custom_hobbies_' + (S.uid || 'guest') }
function loadCustomHobbies() {
  try { const a = JSON.parse(localStorage.getItem(customHobbiesKey()) || '[]'); return Array.isArray(a) ? a.slice(0, 20) : [] } catch (e) { return [] }
}
let customHobbies = []
async function addCustomHobby() {
  const input = el('hobbyCustom')
  if (!input) return
  const text = input.value.trim()
  if (!text || text.length < 2) { el('hobbyCustomTip').textContent = '请输入 2-8 个字的爱好名称'; return }
  if (pickedHobbies.length >= HOBBY_MAX) { el('hobbyCustomTip').textContent = '最多选 ' + HOBBY_MAX + ' 个，先取消一个再添加'; return }
  if (pickedHobbies.includes(text) || customHobbies.includes(text)) { el('hobbyCustomTip').textContent = '这个爱好已经在列表里了'; return }
  const tip = el('hobbyCustomTip')
  tip.textContent = 'AI 审查中…'
  const btn = el('btnHobbyCustom')
  btn.disabled = true
  try {
    const r = await Net.aiCheck(text)
    if (!r.ok) {
      tip.textContent = '未通过 AI 审查（' + (r.reason || '内容不合规') + '），请换个词'
      return
    }
    if (!customHobbies.includes(text)) customHobbies.push(text)
    try { localStorage.setItem(customHobbiesKey(), JSON.stringify(customHobbies)) } catch (e) {}
    if (pickedHobbies.length < HOBBY_MAX) pickedHobbies.push(text)
    input.value = ''
    tip.textContent = '✓ 已通过 AI 审查并添加'
    renderHobbyPicker()
  } catch (e) {
    tip.textContent = e.message || '审查失败，请稍后再试'
  } finally {
    btn.disabled = false
  }
}

function updateHobbyCount() {
  const n = el('hobbyCount')
  if (n) n.textContent = '已选 ' + pickedHobbies.length + ' / ' + HOBBY_MAX
}

async function openBubbles() {
  showView('find')
  /* 页面本身只放泡泡海；发泡泡 / 删泡泡两个入口在顶部 */
  el('btnBubbleSend').onclick = openBubbleForm
  el('btnBubbleDel').onclick = async () => {
    if (!confirm('删除我的泡泡？')) return
    try {
      await Net.bubbleDel()
      toast('已删除你的泡泡')
      pickedHobbies = []; bubbleLoc = null
      await loadBubbles()
    } catch (e) { toast(e.message || '操作失败') }
  }
  await loadBubbles()
}

/* 点「发出泡泡」才弹出爱好勾选 + 位置 */
function openBubbleForm() {
  /* 用自己已有的泡泡回填勾选状态 */
  customHobbies = loadCustomHobbies()
  const mine = (S.bubbles || []).find(b => b.uid === S.uid)
  pickedHobbies = mine ? String(mine.hobby || '').split('、').filter(h => h && hobbyExists(h)) : []
  bubbleLoc = mine ? (mine.loc || null) : null
  renderHobbyPicker()
  renderBubbleLoc()
  const ci = el('hobbyCustom')
  if (ci) ci.value = ''
  const ct = el('hobbyCustomTip')
  if (ct) ct.textContent = '自定义内容会先经 AI 审查，通过后才能添加'
  el('bubbleErr').textContent = ''
  el('btnBubbleCancel').onclick = closeModal
  el('btnBubbleLoc').onclick = () => {
    /* 选完 / 取消都回到泡泡表单 */
    openLocationPicker(loc => { bubbleLoc = loc; renderBubbleLoc() }, 'modalBubbleForm')
  }
  el('btnBubbleConfirm').onclick = async () => {
    if (!pickedHobbies.length) { el('bubbleErr').textContent = '请至少选择 1 个爱好'; return }
    try {
      await Net.bubblePost(pickedHobbies.join('、'), bubbleLoc)
      closeModal()
      toast('泡泡已发出，慢慢飘吧～')
      await loadBubbles()
    } catch (e) { el('bubbleErr').textContent = e.message || '发送失败' }
  }
  openModal('modalBubbleForm')
  const hbtn = el('btnHobbyCustom')
  if (hbtn) hbtn.onclick = addCustomHobby
  const hinput = el('hobbyCustom')
  if (hinput) hinput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustomHobby() } })
}

let bubbleLoc = null
function renderBubbleLoc() {
  const n = el('hobbyLoc')
  if (!n) return
  n.innerHTML = bubbleLoc
    ? `📍 ${esc(bubbleLoc.name || '已选位置')}<button type="button" class="loc-clear" id="btnBubbleLocClear" title="去掉位置">×</button>`
    : ''
  const c = el('btnBubbleLocClear')
  if (c) c.onclick = () => { bubbleLoc = null; renderBubbleLoc() }
}

function hobbyExists(h) {
  return HOBBY_GROUPS.some(g => g.items.includes(h)) || customHobbies.includes(h)
}

async function loadBubbles() {
  const sea = el('bubbleSea')
  try {
    const r = await Net.bubbleList()
    const list = r.list || []
    S.bubbles = list
    if (!list.length) { sea.innerHTML = '<p class="muted">还没有泡泡，发第一个吧！</p>'; return }
    sea.innerHTML = list.map((b, i) => {
      const mine = b.uid === S.uid
      return `<div class="bubble-float" data-uid="${esc(b.uid)}" data-nick="${esc(b.nickname)}" data-hobby="${esc(b.hobby)}"
        style="left:${(i * 17 + 8) % 80 + 4}%;top:${(i * 29 + 10) % 65 + 8}%;
        animation-delay:${-(i % 5) * 2}s;animation-duration:${8 + i % 5}s">
        <div class="bf-av">${avatarHtml(b.avatar)}</div>
        <div class="bf-name">${esc(b.nickname)}${mine ? '（我的）' : ''}</div>
        <div class="bf-hobby">${esc(b.hobby)}</div>
        ${b.loc ? `<button type="button" class="bf-loc" data-loc='${esc(JSON.stringify(b.loc))}' title="查看位置">📍 ${esc(b.loc.name || '位置')}</button>` : ''}
      </div>`
    }).join('')
    sea.querySelectorAll('.bf-loc').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation()
        let loc = null
        try { loc = JSON.parse(btn.dataset.loc) } catch (err) {}
        if (loc) openLocationView(loc, '泡泡位置')
      }
    })
    sea.querySelectorAll('.bubble-float').forEach(bub => {
      bub.onclick = () => {
        const uid = bub.dataset.uid
        if (uid === S.uid) return toast('这是你自己的泡泡')
        if ((S.friends || []).some(f => f.uid === uid)) return toast('你们已经是好友了')
        Net.api('/api/friends', { method: 'POST', body: { uid } })
          .then(r => toast(r.pending ? '好友申请已发送，等待对方同意' : '已添加为好友', 2600))
          .catch(err => toast(err.message || '申请失败'))
      }
    })
  } catch (e) {
    sea.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}

/* ---------- 用户反馈（星级） ---------- */
let fbqCurrent = null
function openFbReq(req) {
  fbqCurrent = req
  el('fbqSub').textContent = (req.by ? req.by + '：' : '') + req.title +
    (req.desc ? '\n' + req.desc : '')
  el('fbqText').value = ''
  el('fbqErr').textContent = ''
  const box = el('fbqStars')
  box.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
    `<button type="button" class="fb-star" data-half="${n}">${n % 2 ? '⯨' : '★'}</button>`).join('')
  let picked = 0
  const hint = el('fbqHint')
  const update = () => {
    box.querySelectorAll('.fb-star').forEach(b =>
      b.classList.toggle('is-on', +b.dataset.half <= picked))
    const stars = picked / 2
    hint.textContent = picked
      ? (stars <= 2.5 ? '需填写反馈意见'
        : stars === 3 ? '表示未使用过此功能（可不填）'
        : '无需填写，想说也可以') + `（${stars} 星）`
      : '请点击星星评分'
  }
  box.querySelectorAll('.fb-star').forEach(b => {
    b.onclick = () => { picked = +b.dataset.half; update() }
  })
  update()
  el('btnFbqOk').onclick = async () => {
    if (!picked) { el('fbqErr').textContent = '请先评分'; return }
    try {
      await Net.fbAnswer(req.id, picked / 2, el('fbqText').value.trim())
      closeModal()
      toast('感谢你的反馈！', 2200)
    } catch (e) { el('fbqErr').textContent = e.message || '提交失败' }
  }
  el('btnFbqLater').onclick = closeModal
  openModal('modalFbReq')
}

/* 登录后检查待回答反馈：刚注册的用户本次不弹 */
async function checkPendingFb(justRegistered) {
  if (S.profile && S.profile.isAdmin) return
  if (justRegistered) return
  try {
    const r = await Net.fbPending()
    if (r.list && r.list.length) openFbReq(r.list[0])
  } catch (e) {}
}

/* ---------- 管理端：反馈箱（新建 + 查看回答） ---------- */
async function loadAdminFbReq() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminFbReqList()
    const list = r.list || []
    const head = `<div class="ann-admin-bar">
      <button class="mini-op ok" id="btnFbNew">＋ 新建反馈</button>
      <span class="muted">共 ${list.length} 条反馈请求</span></div>`
    if (!list.length) { box.innerHTML = head + '<p class="muted">还没有反馈请求</p>' }
    else {
      box.innerHTML = head + list.map(f => `<div class="admin-item">
        <div class="admin-av">📝</div>
        <div class="admin-info">
          <div class="admin-name">${esc(f.title)} <span class="admin-wx">平均 ${f.avg} 星</span></div>
          <div class="admin-meta"><span class="admin-stat">${f.answers.length} 人已反馈 · ${esc(fmtFull(f.at))}</span></div>
          <div class="admin-stat">${esc(f.desc || '')}</div>
          ${f.answers.length ? '<div class="admin-stat">' + f.answers.slice(0, 6).map(a =>
            `${esc(a.name)} ${a.stars}★${a.text ? '：' + esc(a.text.slice(0, 30)) : ''}`).join('<br>') + '</div>' : ''}
        </div>
        <div class="admin-ops">
          <button class="mini-op danger" data-id="${esc(f.id)}" data-act="fbdel">删除</button>
        </div></div>`).join('')
    }
    el('btnFbNew').onclick = openFbNew
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
  }
}
async function onAdminFbReqClick(e) {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  if (b.dataset.act === 'fbdel') {
    if (!confirm('删除这条反馈请求及其回答？')) return
    try { await Net.adminFbReqDel(b.dataset.id); toast('已删除'); loadAdminFbReq() }
    catch (err) { toast(err.message || '删除失败') }
  }
}
function openFbNew() {
  el('fbnTitle').value = ''
  el('fbnDesc').value = ''
  el('fbnErr').textContent = ''
  el('btnFbnOk').onclick = async () => {
    const title = el('fbnTitle').value.trim()
    if (!title) { el('fbnErr').textContent = '请填写反馈主题'; return }
    try {
      await Net.adminFbReqCreate(title, el('fbnDesc').value.trim())
      closeModal()
      toast('已发送，在线用户会立刻收到')
      loadAdminFbReq()
    } catch (e) { el('fbnErr').textContent = e.message || '发送失败' }
  }
  el('btnFbnCancel').onclick = closeModal
  openModal('modalFbNew')
}

/* ---------- 用户删除公告（证书）与登录页删除名单 ---------- */
function showDeleteCert(p) {
  const d = p.at ? new Date(p.at) : new Date()
  const dateStr = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
  el('certBody').innerHTML = `
    <h2>用户删除公告</h2>
    <p class="c-salute">尊敬的用户 ${esc(p.nickname || p.wxid || '')}，你好：</p>
    <p class="c-reason">${esc(p.reason || '（管理员未填写删除理由）')}</p>
    <p class="c-tail">因您危害情节严重，经过多次审核，我方将按规矩合理删除，此用户将不可用，感谢您的配合。</p>
    <div class="c-sign">管理员<br>${dateStr}</div>
    <div class="c-stamp">${OFFICIAL_STAMP}</div>`
  openModal('modalCert')
}

/* 登录页：本机已登录过的账号，点击即可切换（一台设备支持多个账号） */
function renderRecentAccounts() {
  const box = el('recentAcc')
  const list = (Net.accounts() || []).filter(x => x.uid !== (S.profile && S.profile.uid))
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.innerHTML = `<div class="ra-title">切换账号</div>` + list.map(a => `
    <div class="ra-item" data-uid="${esc(a.uid)}">
      <span class="ra-av">${avatarHtml(a.avatar)}</span>
      <span class="ra-name">${esc(a.nickname || a.wxid)}</span>
      <span class="ra-wx">${esc(a.wxid)}</span>
    </div>`).join('')
  box.querySelectorAll('.ra-item').forEach(item => {
    item.onclick = async () => {
      const a = list.find(x => x.uid === item.dataset.uid)
      if (!a) return
      try {
        Net.useAccount(a)
        const data = await Net.bootstrap()
        enterApp(data, { fresh: true })
        toast('已切换到 ' + (a.nickname || a.wxid), 1800)
      } catch (e) {
        /* 该账号已在别处登录或令牌过期，从本机列表移除 */
        Net.forgetAccount(a.uid)
        toast('该账号登录已失效，请重新输入密码登录', 2600)
        renderRecentAccounts()
      }
    }
  })
}

async function openDelListModal() {
  openModal('modalDelList')
  el('delTable').innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.deletedPublic()
    if (!r.list.length) { el('delTable').innerHTML = '<p class="empty">暂无删除记录</p>'; return }
    el('delTable').innerHTML = `<table>
      <thead><tr><th>KB号</th><th>昵称</th><th>删除理由</th><th>日期及时间</th><th>审批员</th></tr></thead>
      <tbody>${r.list.map(d => `<tr>
        <td>${esc(d.wxid)}</td><td>${esc(d.nickname)}</td>
        <td>${esc(d.reason || '—')}</td><td>${esc(fmtFull(d.at))}</td>
        <td>${esc(d.operator || '管理员')}</td></tr>`).join('')}</tbody></table>`
  } catch (e) {
    el('delTable').innerHTML = `<p class="empty">${esc(e.message || '加载失败')}</p>`
  }
}

/* ---------- 应用内文件剪贴板（复制文件/图片 → 任意会话粘贴落库） ---------- */
const KB_CLIP_MARK = /KBChat-Clip-\d+/
function pasteClipMark(at) {
  /* 同步写系统剪贴板标记：Windows 剪贴板常有残留文本，
   * 粘贴事件必须靠这个标记才能区分「应用内复制的文件」与「普通文字」 */
  const mark = 'KBChat-Clip-' + at
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mark).catch(() => {})
      return
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea')
    ta.value = mark
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch (e) {}
}
async function sendClipboardFile() {
  let clip = null
  try { clip = JSON.parse(localStorage.getItem('kbchat_clip') || 'null') } catch (e) {}
  if (!clip || !['file', 'image'].includes(clip.kind) || !clip.content) {
    toast('还没有复制文件：先右键文件消息 →「复制文件」', 3000)
    return false
  }
  if (!S.activeRoom) { toast('请先选择一个会话'); return false }
  await doSend(clip.kind, clip.content, clip.fileName || '')
  toast('已粘贴发送')
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('').catch(() => {}) } catch (e) {}
  return true
}

/* ---------- 消息右键菜单（复制/查找/翻译/删除/转发/多选/举报） ---------- */
let msgMenuEl = null
function closeMsgMenu() { if (msgMenuEl) { msgMenuEl.remove(); msgMenuEl = null } }
function showMsgMenu(e, m) {
  e.preventDefault()
  closeMsgMenu()
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  const mine = m.ownerId === S.uid
  const text = m.kind === 'text'
  const items = []
  if (text) items.push(['📋 复制', () => {
    navigator.clipboard.writeText(m.content).then(() => toast('已复制')).catch(() => toast('复制失败'))
  }])
  if (text) items.push(['🔍 查找', () => window.open('https://www.bing.com/search?q=' + encodeURIComponent(m.content.slice(0, 100)), '_blank')])
  if (text) items.push(['🌐 翻译', () => doTranslate(m)])
  /* 文件/图片消息：复制到应用内剪贴板（本地持久），到其他会话 Ctrl+V 粘贴即作为新消息发出（服务端落库） */
  if (m.kind === 'file' || m.kind === 'image') items.push([
    m.kind === 'file' ? '📋 复制文件' : '📋 复制图片',
    () => {
      try {
        const at = Date.now()
        localStorage.setItem('kbchat_clip', JSON.stringify({
          kind: m.kind, content: m.content, fileName: m.fileName || '', at,
        }))
        /* 同时写系统剪贴板标记：Windows 剪贴板常有残留文本，
         * 粘贴事件靠这个标记识别「这是应用内复制的文件」而不是误粘旧文字 */
        pasteClipMark(at)
        toast('已复制，去其他会话按 Ctrl+V 或点「＋ → 粘贴文件」发送', 3600)
      } catch (e) { toast('复制失败') }
    },
  ])
  if (mine) {
    items.push(['🗑️ 删除（撤回）', async () => {
      if (!confirm('撤回这条消息？所有人都会看到「你撤回了一条消息」。')) return
      try { await Net.recall(m.id); m.kind = 'recalled'; m.content = ''; renderMessages() }
      catch (err) { toast(err.message || '撤回失败') }
    }])
  } else {
    items.push(['🗑️ 删除（对我隐藏）', async () => {
      hideMsgLocal(m.id); renderMessages()
      try { await Net.hideMsg(m.id); toast('已删除（所有设备同步隐藏）') }
      catch (err) { toast(err.message || '删除失败，仅本次隐藏') }
    }])
    if (isAdmin) items.push(['🗑️ 删除（所有人不可见）', async () => {
      if (!confirm('以管理员身份删除这条消息？所有人将不再看到它。')) return
      try { await Net.adminMsgDel(m.id) } catch (err) { toast(err.message || '删除失败') }
    }])
  }
  if (['text', 'image', 'file', 'location'].includes(m.kind)) items.push(['↪️ 转发', () => openForward([m], 'each')])
  items.push(['⭐ 收藏', () => {
    const t = m.kind === 'image' ? '[图片]' : m.kind === 'file' ? '[文件]' : m.kind === 'voice' ? '[语音]' : String(m.content || '')
    collectFavorite({
      kind: 'chat', ref: m.id,
      title: t.slice(0, 40) || '聊天消息',
      text: m.kind === 'text' ? m.content : '',
      media: m.kind === 'image' ? [m.content] : [],
      from: m.ownerId, fromName: m.senderName || '',
    })
  }])
  items.push(['☑️ 多选', () => startMultiSelect(m)])
  items.push(['↩️ 引用', () => startReply(m)])
  if (!mine) items.push(['🚩 举报', () => openReport(m)])
  const div = document.createElement('div')
  div.className = 'msg-menu'
  div.innerHTML = items.map((it, i) => `<div class="mm-item" data-i="${i}">${esc(it[0])}</div>`).join('')
  document.body.appendChild(div)
  div.style.left = Math.min(e.clientX, innerWidth - 180) + 'px'
  div.style.top = Math.min(e.clientY, innerHeight - div.offsetHeight - 10) + 'px'
  div.querySelectorAll('.mm-item').forEach(el => {
    el.onclick = () => { closeMsgMenu(); items[+el.dataset.i][1]() }
  })
  msgMenuEl = div
  setTimeout(() => document.addEventListener('click', closeMsgMenu, { once: true }), 0)
}

/* AI 待发图片预览条：附上的图片显示在输入框上方，可逐张移除 */
function renderAiPending() {
  let bar = document.getElementById('aiPendingBar')
  if (!aiPendingImages.length) { if (bar) bar.remove(); return }
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'aiPendingBar'
    bar.className = 'ai-pend-bar'
    el('msgInput').before(bar)
  }
  bar.innerHTML = aiPendingImages.map((u, i) =>
    `<span class="ai-pend-thumb"><img src="${esc(u)}" alt=""><button type="button" class="ai-pend-x" data-i="${i}" title="移除">✕</button></span>`
  ).join('')
  bar.querySelectorAll('.ai-pend-x').forEach(b => {
    b.onclick = () => { aiPendingImages.splice(+b.dataset.i, 1); renderAiPending() }
  })
}

/* AI 回答语言：跟随提问（选择器已移除，保留扩展点） */
function aiLang() { const n = el('aiLang'); return (n && n.value) || 'auto' }

/* ---------- 元宝式 AI 左侧栏：新对话 + 历史会话列表 ---------- */
function renderAiSidebar() {
  const sb = el('aiSidebar')
  if (!sb) return
  const listEl = el('aiSideList')
  const list = loadAiSessions().sort((a, b) => new Date(b.at) - new Date(a.at))
  listEl.innerHTML = list.length
    ? list.map(s =>
      `<div class="ai-side-item${s.id === S.aiSessionId ? ' is-on' : ''}" data-id="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}<span class="ai-side-count">${s.count}</span></div>`
    ).join('')
    : '<p class="muted" style="padding:8px 4px;font-size:12px">暂无历史对话</p>'
  listEl.querySelectorAll('.ai-side-item').forEach(item => {
    item.onclick = () => {
      const s = list.find(x => x.id === item.dataset.id)
      if (!s) return
      S.aiSessionId = s.id
      S.messages = (s.messages || []).slice()
      renderMessages(); scrollToBottom(); renderAiSidebar()
      toast('已打开历史对话', 1500)
    }
  })
}

/* ---------- 引用回复：右键「引用」→ 输入框上方出现引用条 → 发送携带引用 ---------- */
let replyTo = null
function startReply(m) {
  replyTo = {
    id: m.id,
    name: m.senderName || '消息',
    text: m.kind === 'image' ? '[图片]' : m.kind === 'voice' ? '[语音]' : m.kind === 'file' ? '[文件]'
      : m.kind === 'location' ? '[位置]' : String(m.content || '').replace(/\s+/g, ' ').slice(0, 120),
  }
  renderReplyBar()
  const mi = el('msgInput')
  if (mi) mi.focus()
}
function renderReplyBar() {
  let bar = document.getElementById('replyBar')
  if (!replyTo) { if (bar) bar.remove(); return }
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'replyBar'
    bar.className = 'reply-bar'
    el('msgInput').before(bar)
  }
  bar.innerHTML = '<span class="reply-line"></span>' +
    '<span class="reply-body"><b>' + esc(replyTo.name) + '</b>：' + esc(replyTo.text) + '</span>' +
    '<button type="button" class="reply-x" title="取消引用">✕</button>'
  bar.querySelector('.reply-x').onclick = () => { replyTo = null; renderReplyBar() }
}
function clearReply() { replyTo = null; renderReplyBar() }
/* 点击引用块 → 跳到原消息并高亮 */
function jumpToMessage(id) {
  const target = document.querySelector('#msgStack .msg[data-mid="' + id + '"]')
  if (!target) { toast('原消息不在当前记录中'); return }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add('ref-flash')
  setTimeout(() => target.classList.remove('ref-flash'), 1600)
}

/* ---------- 密码确认弹窗：危险操作（清除密保等）需验证登录密码 ---------- */
function openPwdConfirm(tipText, onOk) {
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.style.zIndex = 460
  layer.innerHTML = `<div class="qr-box" style="max-width:340px">
    <h3 style="text-align:center">🔒 验证登录密码</h3>
    <p class="muted" style="font-size:12px;text-align:center;margin:6px 0 10px">${esc(tipText)}</p>
    <input id="pwdConfirmInput" type="password" maxlength="72" placeholder="输入登录密码" autocomplete="new-password"
      style="width:100%;padding:9px 12px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:14px">
    <p class="field-err" id="pwdConfirmErr" style="color:#e74c3c;font-size:12px;min-height:16px;margin:6px 0"></p>
    <div class="modal-btns">
      <button class="btn-ghost" id="pwdConfirmCancel">取消</button>
      <button class="btn-primary" id="pwdConfirmOk">确认</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  const input = layer.querySelector('#pwdConfirmInput')
  setTimeout(() => input.focus(), 60)
  const close = () => layer.remove()
  layer.querySelector('#pwdConfirmCancel').onclick = close
  layer.onclick = e => { if (e.target === layer) close() }
  const submit = async () => {
    const pwd = input.value
    if (!pwd) { layer.querySelector('#pwdConfirmErr').textContent = '请输入密码'; return }
    close()
    await onOk(pwd)
  }
  layer.querySelector('#pwdConfirmOk').onclick = submit
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } })
}

/* ---------- 在线状态：以 presence 事件为准 + 70 秒无续报自动判离线 ----------
 * 心跳恢复在线/每 30 秒服务端会重播 presence；若对方关闭页面（无离线广播），
 * 70 秒收不到续报就自动转为离线，双向都不会再出现「明明在线却显示离线」。 */
const presenceTimers = {}
function applyPresence(uid, online) {
  clearTimeout(presenceTimers[uid])
  if (online) presenceTimers[uid] = setTimeout(() => applyPresence(uid, false), 70000)
  S.friends.forEach(f => { if (f.uid === uid) f.online = online })
  const c = S.conversations.find(x => x.kind === 'dm' && x.peerUid === uid)
  if (c) {
    c.online = online
    if (c.roomId === S.activeRoom) renderChatHeader()
    renderChatList()
  }
  renderContacts()
}

/* 翻译：优先免费接口，失败则打开 Bing 翻译 */
async function translateText(text, targetLang) {
  const target = targetLang || localStorage.getItem('kbchat_trans') || 'auto'
  const hasCJK = /[\u4e00-\u9fff]/.test(text)
  let pair
  /* 指定了目标语言（如对方界面语言 ru/ja/en）则直接翻成该语言 */
  if (/^(ru|ja|ko|en|zh-TW|fr|de|es|pt|it|ar)$/.test(target)) pair = (hasCJK ? 'zh-CN' : 'en') + '|' + target
  else if (target === 'zh-CN' || target === 'zh') pair = 'en|zh-CN'
  else if (target === 'zh-TW') pair = 'en|zh-TW'
  else pair = hasCJK ? 'zh-CN|en' : 'en|zh-CN'
  const url = 'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text.slice(0, 480)) + '&langpair=' + pair
  const r = await fetch(url).then(x => x.json())
  const t = r && r.responseData && r.responseData.translatedText
  if (!t || /MYMEMORY WARNING/.test(t)) throw new Error('翻译服务不可用')
  return t
}
async function doTranslate(m) {
  S.translations = S.translations || {}
  if (S.translations[m.id]) { delete S.translations[m.id]; renderMessages(); return }
  /* 目标语言 = 消息发送者的界面语言（如对方用俄语，就翻成俄语）；
   * 历史消息没有 lang 字段时回退到本机设置 */
  const senderLang = m.lang || ''
  const target = senderLang || undefined
  toast('翻译中…', 1200)
  try {
    S.translations[m.id] = await translateText(m.content, target)
    renderMessages()
  } catch (e) {
    window.open('https://www.bing.com/translator', '_blank')
    toast('在线翻译不可用，已打开 Bing 翻译', 2600)
  }
}

/* 转发 */
let fwdPayload = null
function openForward(msgs, mode) {
  fwdPayload = { msgs, mode: mode || 'each' }
  el('fwdSub').textContent = '将转发 ' + msgs.length + ' 条消息'
  const friends = (S.friends || []).map(f => ({
    roomId: 'dm_' + [S.uid, f.uid].sort().join('__'), name: f.name, avatar: f.avatar, kind: '好友',
  }))
  const groups = (S.groups || []).map(g => ({
    roomId: g.roomId, name: g.name, avatar: g.avatar || '\ud83d\udc65', kind: '群聊',
  }))
  const all = friends.concat(groups)
  const box = el('fwdList')
  if (!all.length) { box.innerHTML = '<p class="muted">暂无可转发的好友或群聊</p>' }
  else {
    box.innerHTML = all.map(t => `<div class="fwd-item" data-room="${esc(t.roomId)}">
      <span class="ra-av">${avatarHtml(t.avatar)}</span>
      <span class="ra-name">${esc(t.name)}</span>
      <span class="ra-wx">${t.kind}</span></div>`).join('')
    box.querySelectorAll('.fwd-item').forEach(item => { item.onclick = () => doForward(item.dataset.room) })
  }
  el('btnFwdCancel').onclick = closeModal
  openModal('modalForward')
}
async function doForward(roomId) {
  if (!fwdPayload) return
  const { msgs, mode } = fwdPayload
  try {
    if (mode === 'merge') {
      const text = msgs.map(m =>
        (m.senderName || '') + '：' +
        (m.kind === 'image' ? '[图片]' : m.kind === 'file' ? '[文件]' : m.content)).join('\n')
      await Net.send(roomId, 'text', '【合并转发】\n' + text)
    } else {
      for (const m of msgs) {
        const kind = ['image', 'file'].includes(m.kind) ? m.kind : 'text'
        await Net.send(roomId, kind, m.content)
      }
    }
    closeModal()
    toast('转发成功')
  } catch (e) { toast(e.message || '转发失败') }
}

/* 多选 */
function startMultiSelect(first) {
  S.multiSelect = { on: true, ids: [first.id] }
  renderMessages()
  el('multiBar').hidden = false
  updateMultiCount()
}
function exitMultiSelect() {
  S.multiSelect = { on: false, ids: [] }
  el('multiBar').hidden = true
  renderMessages()
}
function updateMultiCount() {
  el('multiCount').textContent = '已选 ' + S.multiSelect.ids.length + ' 条'
}
async function multiDelete(msgs) {
  for (const m of msgs) {
    if (m.ownerId === S.uid) { try { await Net.recall(m.id) } catch (e) {} }
    else { hideMsgLocal(m.id); try { await Net.hideMsg(m.id) } catch (e) {} }
  }
  toast('已删除所选消息')
  exitMultiSelect()
  if (S.activeRoom) await openRoom(S.activeRoom, S.activeKind)
}

/* 举报 */
function openReport(m) {
  el('repSub').textContent = '举报对象：' + (m.senderName || '对方') +
    '｜内容已自动固定：' + String(m.content || '[图片/文件]').slice(0, 40)
  el('repErr').textContent = ''
  el('btnRepOk').onclick = async () => {
    try {
      await Net.report(m.id, el('repReason').value)
      closeModal()
      toast('举报已提交，管理员将尽快核实处理')
    } catch (e) { el('repErr').textContent = e.message || '提交失败' }
  }
  el('btnRepCancel').onclick = closeModal
  openModal('modalReport')
}

/* ---------- 设置中心 ---------- */
function applyTheme() {
  const t = localStorage.getItem('kbchat_theme') || 'light'
  const dark = t === 'dark' ||
    (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.classList.toggle('dark', dark)
  /* 深浅模式切换后，图片背景的遮罩色需要重算 */
  if (typeof applyChatBg === 'function' && document.getElementById('msgScroll')) applyChatBg()
}
/* 自定义聊天背景：纯色 / 渐变 / 图片（本地存储，不占服务器配额）
 * 存储格式 kbchat_bg2 = JSON {type:'color'|'gradient'|'image', v1, v2, dir, opacity}
 * 兼容旧格式 kbchat_bg（服务器图片 URL） */
const BG_SWATCHES = ['#e8f5e9','#e3f2fd','#fff8e1','#fce4ec','#f3e5f5','#ede7f6','#e0f7fa','#fff3e0','#eceff1','#2c3e50','#1a237e','#4a148c']
const BG_GRAD_PRESETS = [['#a8edea','#fed6e3'],['#d4fc79','#96e6a1'],['#84fab0','#8fd3f4'],['#fbc2eb','#a6c1ee'],['#fddb92','#d1fdff'],['#cfd9df','#e2ebf0'],['#2b5876','#4e4376'],['#355c7d','#c06c84']]
function bgOpacityNum() { return Math.max(15, Math.min(100, Number(localStorage.getItem('kbchat_bg_op') || 100))) }
function readBg2() {
  try { return JSON.parse(localStorage.getItem('kbchat_bg2') || 'null') } catch (e) { return null }
}
function applyChatBg() {
  /* 背景作用于整个应用窗口（.main）：列表 / 聊天 / 大区域视图透出背景 */
  const mainEl = document.querySelector('.main')
  const sc = el('msgScroll')
  if (!mainEl) return
  const dark = document.body.classList.contains('dark')
  const bg2 = readBg2()
  const legacy = localStorage.getItem('kbchat_bg')
  /* 防篡改：颜色/渐变值必须是合法十六进制色（localStorage 被篡改时杜绝任意字符串进 CSS） */
  const HEX = /^#[0-9a-f]{3,8}$/i
  if (bg2) {
    if ((bg2.type === 'color' || bg2.type === 'gradient') && (!HEX.test(bg2.v1 || '') || (bg2.type === 'gradient' && !HEX.test(bg2.v2 || '')))) {
      reset(); return
    }
  }
  const reset = () => {
    mainEl.style.backgroundImage = ''
    mainEl.style.backgroundColor = ''
    document.body.classList.remove('has-user-bg')
    sc.style.backgroundImage = ''
    sc.style.backgroundColor = ''
  }
  const applyTo = (bgImage, bgColor, isDarkBg) => {
    document.body.classList.add('has-user-bg')
    /* 文字/面板随背景明暗自适应：深背景用浅色文字，亮背景用深色文字 */
    document.body.classList.toggle('bg-dark-bg', !!isDarkBg)
    document.body.classList.toggle('bg-light-bg', !isDarkBg)
    mainEl.style.backgroundImage = bgImage || ''
    mainEl.style.backgroundColor = bgColor || ''
    /* 聊天滚动区自身恢复透明，让 .main 背景透出 */
    sc.style.backgroundImage = ''
    sc.style.backgroundColor = ''
  }
  /* 计算颜色亮度（0-1） */
  const lumOf = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim())
    if (!m) return 0.5
    const v = parseInt(m[1], 16)
    return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255
  }
  if (!bg2 && !legacy) { reset(); return }
  let applied = false
  if (bg2 && bg2.type === 'color') {
    applyTo('', bg2.v1, lumOf(bg2.v1) < 0.5)
    applied = true
  } else if (bg2 && bg2.type === 'gradient') {
    const avg = lumOf(bg2.v1) * 0.5 + lumOf(bg2.v2) * 0.5
    applyTo('linear-gradient(' + (bg2.dir || 'to bottom') + ', ' + bg2.v1 + ', ' + bg2.v2 + ')', '', avg < 0.5)
    applied = true
  } else if (bg2 && bg2.type === 'image') {
    const op = bg2.opacity == null ? 100 : bg2.opacity
    const mask = dark ? 'rgba(18,18,18,' + ((100 - op) / 100).toFixed(2) + ')' : 'rgba(245,245,245,' + ((100 - op) / 100).toFixed(2) + ')'
    applyTo('linear-gradient(' + mask + ', ' + mask + '), url(' + bg2.v1 + ')', '', dark)
    applied = true
  } else if (legacy) {
    const op = bgOpacityNum()
    const mask = dark ? 'rgba(18,18,18,' + ((100 - op) / 100).toFixed(2) + ')' : 'rgba(245,245,245,' + ((100 - op) / 100).toFixed(2) + ')'
    applyTo('linear-gradient(' + mask + ', ' + mask + '), url(' + legacy + ')', '', dark)
    applied = true
  }
  if (!applied) reset()
}
/* 背景图压缩：最长边 1600px、JPEG 0.85，控制在 localStorage 配额内 */
function compressBgImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const rd = new FileReader()
    rd.onerror = () => reject(new Error('图片读取失败'))
    rd.onload = () => {
      img.onload = () => {
        try {
          const max = 1600
          let w = img.width, h = img.height
          if (Math.max(w, h) > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k) }
          const cv = document.createElement('canvas')
          cv.width = w; cv.height = h
          cv.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(cv.toDataURL('image/jpeg', 0.85))
        } catch (e) { reject(new Error('图片处理失败')) }
      }
      img.onerror = () => reject(new Error('不是有效的图片'))
      img.src = rd.result
    }
    rd.readAsDataURL(file)
  })
}

/* 消息提示音：内置多种音色，可在设置里试听与切换 */
const SOUND_STYLES = {
  ding: { name: '叮咚', notes: [[880, 0, .12], [1245, .11, .18]] },
  chime: { name: '清脆', notes: [[1047, 0, .1], [1319, .09, .1], [1568, .18, .22]] },
  drop: { name: '水滴', notes: [[1200, 0, .07, 420], [640, .06, .22, 320]] },
  pop: { name: '气泡', notes: [[520, 0, .05], [760, .05, .09]] },
  coin: { name: '金币', notes: [[988, 0, .06], [1319, .06, .24]] },
  soft: { name: '轻提示', notes: [[560, 0, .26]] },
}
function playMsgSound(force) {
  if (!force && localStorage.getItem('kbchat_sound') !== '1') return
  const vol = Math.max(0, Math.min(100, Number(localStorage.getItem('kbchat_sound_vol') || 70))) / 100
  if (vol <= 0) return
  const style = SOUND_STYLES[localStorage.getItem('kbchat_sound_style') || 'ding'] || SOUND_STYLES.ding
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    const ctx = new AC()
    style.notes.forEach(n => {
      const freq = n[0], delay = n[1], dur = n[2], slide = n[3]
      const t0 = ctx.currentTime + delay
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(freq, t0)
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur)
      const peak = 0.55 * vol   /* 原 0.09：用户反馈提示音太小；0.55 在正弦波下响亮但不削波 */
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      o.connect(g)
      g.connect(ctx.destination)
      o.start(t0)
      o.stop(t0 + dur + 0.02)
    })
    setTimeout(() => { try { ctx.close() } catch (e) {} }, 1500)
  } catch (e) {}
}

/* 聊天字号：给 html 打标记，样式在 app.css 里按 data-fs 调 */
function applyFontSize() {
  const v = localStorage.getItem('kbchat_fs') || 'normal'
  document.documentElement.dataset.fs = v
}
function openSettings() {
  el('setTheme').value = localStorage.getItem('kbchat_theme') || 'light'
  el('setSound').checked = localStorage.getItem('kbchat_sound') === '1'
  el('setSoundStyle').value = localStorage.getItem('kbchat_sound_style') || 'ding'
  el('setTrans').value = localStorage.getItem('kbchat_trans') || 'auto'
  el('setLang').value = localStorage.getItem('kbchat_lang') || 'zh-CN'
  /* 音量 */
  const volNow = Math.max(0, Math.min(100, Number(localStorage.getItem('kbchat_sound_vol') || 70)))
  el('setSoundVol').value = String(volNow)
  el('setSoundVolVal').textContent = volNow + '%'
  el('setSoundVol').oninput = () => {
    const v = Math.max(0, Math.min(100, Number(el('setSoundVol').value) || 0))
    localStorage.setItem('kbchat_sound_vol', String(v))
    el('setSoundVolVal').textContent = v + '%'
  }
  el('setSoundVol').onchange = () => playMsgSound(true)
  el('btnSoundTest2').onclick = () => playMsgSound(true)
  /* 字号 / 发送方式 / 会话预览 */
  el('setFontSize').value = localStorage.getItem('kbchat_fs') || 'normal'
  el('setFontSize').onchange = () => {
    localStorage.setItem('kbchat_fs', el('setFontSize').value)
    applyFontSize()
    toast('聊天字号已调整')
  }
  el('setEnterMode').value = localStorage.getItem('kbchat_enter') || 'enter'
  el('setEnterMode').onchange = () => {
    localStorage.setItem('kbchat_enter', el('setEnterMode').value)
    el('msgInput').placeholder = el('setEnterMode').value === 'ctrl'
      ? '输入消息，Ctrl+Enter 发送，Enter 换行'
      : '输入消息，Enter 发送，Shift+Enter 换行'
    toast('发送方式已切换')
  }
  el('setPreview').checked = localStorage.getItem('kbchat_nopreview') !== '1'
  el('setPreview').onchange = () => {
    localStorage.setItem('kbchat_nopreview', el('setPreview').checked ? '0' : '1')
    renderChatList()
  }
  el('setTheme').onchange = () => {
    localStorage.setItem('kbchat_theme', el('setTheme').value)
    applyTheme()
  }
  el('setSound').onchange = () => {
    localStorage.setItem('kbchat_sound', el('setSound').checked ? '1' : '0')
    if (el('setSound').checked) playMsgSound(true)
  }
  el('setSoundStyle').onchange = () => {
    localStorage.setItem('kbchat_sound_style', el('setSoundStyle').value)
    playMsgSound(true)
  }
  el('btnSoundTest').onclick = () => playMsgSound(true)
  el('setTrans').onchange = () => localStorage.setItem('kbchat_trans', el('setTrans').value)
  el('setLang').onchange = () => {
    localStorage.setItem('kbchat_lang', el('setLang').value)
    applyLang()
    toast('界面语言已切换（部分动态内容仍为简体中文）', 3000)
  }
  /* 背景面板开关 */
  const hideBgPanel = () => { el('bgPanel').hidden = true; el('bgPanel').innerHTML = '' }
  const setBg2 = (obj) => {
    localStorage.setItem('kbchat_bg2', JSON.stringify(obj))
    localStorage.removeItem('kbchat_bg')
    if (obj.type === 'image' && obj.opacity != null) localStorage.setItem('kbchat_bg_op', String(obj.opacity))
    applyChatBg()
    el('bgOpacityRow').hidden = obj.type !== 'image'
    if (obj.type === 'image') { el('bgOpacity').value = obj.opacity == null ? 100 : obj.opacity; el('bgOpacityVal').textContent = (obj.opacity == null ? 100 : obj.opacity) + '%' }
    hideBgPanel()
    toast('聊天背景已更新')
  }
  window.setBg2 = setBg2
  el('btnSetBgColor').onclick = () => {
    const p = el('bgPanel')
    if (!p.hidden) { hideBgPanel(); return }
    p.hidden = false
    p.innerHTML = '<div class="bg-swatches">' + BG_SWATCHES.map(c => '<button class="bg-swatch" data-c="' + c + '" style="background:' + c + '"></button>').join('') + '</div>' +
      '<div class="bg-custom"><input type="color" id="bgColorPick" value="#a8edea"><button class="btn-code ok" id="bgColorOk">确认</button></div>'
    p.querySelectorAll('.bg-swatch').forEach(b => { b.onclick = () => setBg2({ type: 'color', v1: b.dataset.c }) })
    p.querySelector('#bgColorOk').onclick = () => setBg2({ type: 'color', v1: p.querySelector('#bgColorPick').value })
  }
  el('btnSetBgGrad').onclick = () => {
    const p = el('bgPanel')
    if (!p.hidden) { hideBgPanel(); return }
    p.hidden = false
    const pre = BG_GRAD_PRESETS.map((g, i) => '<button class="bg-swatch bg-swatch-g" data-i="' + i + '" style="background:linear-gradient(135deg,' + g[0] + ',' + g[1] + ')"></button>').join('')
    p.innerHTML = '<div class="bg-swatches">' + pre + '</div>' +
      '<div class="bg-custom"><input type="color" id="bgG1" value="#a8edea"><span>→</span><input type="color" id="bgG2" value="#fed6e3">' +
      '<select id="bgGDir"><option value="to bottom">↓ 上下</option><option value="to right">→ 左右</option><option value="135deg">↘ 斜向</option></select>' +
      '<button class="btn-code ok" id="bgGradOk">确认</button></div>'
    p.querySelectorAll('.bg-swatch-g').forEach(b => { b.onclick = () => { const g = BG_GRAD_PRESETS[Number(b.dataset.i)]; setBg2({ type: 'gradient', v1: g[0], v2: g[1], dir: 'to bottom' }) } })
    p.querySelector('#bgGradOk').onclick = () => setBg2({ type: 'gradient', v1: p.querySelector('#bgG1').value, v2: p.querySelector('#bgG2').value, dir: p.querySelector('#bgGDir').value })
  }
  el('btnSetBg').onclick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const f = input.files && input.files[0]
      if (!f) return
      try {
        /* 本地压缩存储：不占服务器配额，换设备需重设 */
        const url = await compressBgImage(f)
        const op = bgOpacityNum()
        localStorage.removeItem('kbchat_bg')
        localStorage.setItem('kbchat_bg2', JSON.stringify({ type: 'image', v1: url, opacity: op }))
        el('bgOpacityRow').hidden = false
        el('bgOpacity').value = op; el('bgOpacityVal').textContent = op + '%'
        applyChatBg()
        toast('背景图片已设置，可用「背景浓度」调节')
      } catch (e) { toast(e.message || '设置失败') }
    }
    input.click()
  }
  el('btnSetBgReset').onclick = () => {
    localStorage.removeItem('kbchat_bg2')
    localStorage.removeItem('kbchat_bg')
    localStorage.removeItem('kbchat_bg_op')
    el('bgOpacityRow').hidden = true
    hideBgPanel()
    applyChatBg()
    toast('已恢复默认背景')
  }
  el('bgOpacity').oninput = () => {
    const v = Number(el('bgOpacity').value)
    el('bgOpacityVal').textContent = v + '%'
    localStorage.setItem('kbchat_bg_op', String(v))
    const bg2 = readBg2()
    if (bg2 && bg2.type === 'image') { bg2.opacity = v; localStorage.setItem('kbchat_bg2', JSON.stringify(bg2)); applyChatBg() }
    else applyChatBg()
  }
  /* 设置页打开时按当前背景类型显示浓度条 */
  const bgNow = readBg2()
  el('bgOpacityRow').hidden = !(bgNow && bgNow.type === 'image')
  if (bgNow && bgNow.type === 'image') { el('bgOpacity').value = bgNow.opacity == null ? 100 : bgNow.opacity; el('bgOpacityVal').textContent = (bgNow.opacity == null ? 100 : bgNow.opacity) + '%' }
  el('btnOpenFeedback').onclick = openFeedbackBox
  el('btnReplayGuide').onclick = () => { startGuide(true) }
  el('btnCloseAccount').onclick = openCloseAccount
  showView('settings')
}

/* ---------- 管理面板：好友申请管理 ---------- */
async function loadAdminFriendReqs() {
  const box = el('adminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    const r = await Net.adminFriendReqs()
    const list = r.list || []
    if (!list.length) { box.innerHTML = '<p class="muted">暂无待处理的好友申请</p>'; return }
    box.innerHTML = list.map(x => `
      <div class="admin-item">
        <div class="admin-info">
          <div class="admin-name">${esc(x.fromName)}（KB号：${esc(x.fromWxid)}）
            <span class="tag">申请加</span> ${esc(x.ownerName)}</div>
          <div class="admin-meta"><span class="admin-stat">申请语：${esc(x.msg || '（无）')}</span></div>
          <div class="admin-meta"><span class="admin-stat">${esc(fmtShort(x.createdAt))}</span></div>
        </div>
        <button class="mini-op danger" data-freqdel data-owner="${esc(x.ownerUid)}" data-from="${esc(x.fromUid)}">删除</button>
      </div>`).join('')
    box.querySelectorAll('[data-freqdel]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('删除这条好友申请？')) return
        try {
          await Net.adminFriendReqDel(b.dataset.owner, b.dataset.from)
          b.closest('.admin-item').remove()
          toast('申请已删除')
        } catch (e) { toast(e.message || '删除失败') }
      }
    })
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>` }
}

/* ---------- 管理员承诺书确认弹层（注册后弹出，同意留痕） ---------- */
function openPledgeConfirm(onAgree, onReject) {
  const pledgeSecs = PROTOCOL_TEXT.filter(sec => {
    const head = sec[1] || sec[0] || ''
    return /管理员承诺书|一、我们坦诚|二、我们的具体承诺|三、你的权利|四、违约后果|信任不靠/.test(head) || /管理员承诺书/.test(sec[0] || '')
  })
  const body = pledgeSecs.map(sec => {
    const [title, ...lines] = sec
    const head = title
      ? `<div class="ag-title">${esc(title)}</div>`
      : `<div class="ag-chapter">${esc(lines[0])}</div>`
    const body = title ? lines : lines.slice(1)
    return head + body.map(t => `<p class="ag-p">${esc(t)}</p>`).join('')
  }).join('')
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  layer.innerHTML = `<div class="qr-box" style="text-align:left;max-height:86vh">
    <h3 style="text-align:center">管理员承诺书</h3>
    <p class="muted" style="font-size:12px;text-align:center;margin:0 0 8px">同意 Chat 公约后，请阅读并确认管理员承诺书</p>
    <div style="max-height:44vh;overflow-y:auto;border:1px solid var(--line,#e3e3e3);border-radius:8px;padding:10px;font-size:13px">${body}</div>
    <label class="check-row" style="display:flex;align-items:center;gap:6px;margin-top:10px">
      <input type="checkbox" id="pledgeCheck">
      <span style="font-size:12.5px">我已阅读并认可《管理员承诺书》，同意接受其约束与监督</span>
    </label>
    <p class="field-err" id="pledgeErr" style="color:#e74c3c;font-size:12px;min-height:14px"></p>
    <div class="modal-btns">
      <button class="btn-ghost" id="pledgeReject">不同意</button>
      <button class="btn-primary" id="pledgeOk">确认并进入</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  layer.querySelector('#pledgeReject').onclick = () => { layer.remove(); if (onReject) onReject() }
  layer.querySelector('#pledgeOk').onclick = async () => {
    if (!layer.querySelector('#pledgeCheck').checked) {
      layer.querySelector('#pledgeErr').textContent = '请先勾选「我已阅读并认可」'
      return
    }
    const btn = layer.querySelector('#pledgeOk')
    btn.disabled = true
    try {
      await Net.agreePledge()
      layer.remove()
      if (onAgree) onAgree()
    } catch (e) {
      btn.disabled = false
      layer.querySelector('#pledgeErr').textContent = e.message || '提交失败，请重试'
    }
  }
}

/* 游戏中心：靠北游戏（内置）+ 第三方游戏 */
function showGamesView() {
  closeMtabDrawer()
  openMoreSection()
  if (typeof syncMtab === 'function') syncMtab('games')
}

/* ---------- 忘记密码机制：设置 3 个密保问答（登录未设置时建议弹出，可暂跳过） ----------
 * 曾经"必须设置不可跳过"：全屏层挡住「更多」等一切按钮，多端用户都被卡死（用户实测反馈）。
 * 现改为可跳过：点「暂不设置」/ 遮罩 / ESC 都能关闭，设置页里随时可以补设。 */
function closeSecQuizLayer() {
  const l = document.getElementById('secQuizLayer')
  if (l) l.remove()
}
function openSecQuizSetup() {
  if (!(S.profile && S.profile.uid)) return
  if (document.getElementById('secQuizLayer')) return
  const layer = document.createElement('div')
  layer.id = 'secQuizLayer'
  layer.className = 'qr-layer'
  layer.style.zIndex = 400
  const inputs = () => [0, 1, 2].map(i =>
    `<div style="margin-bottom:10px">
      <div class="muted" style="font-size:12px;margin-bottom:3px">问题 ${i + 1}</div>
      <input id="sqQ${i}" maxlength="60" placeholder="例如：我的第一所学校" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px;margin-bottom:4px">
      <input id="sqA${i}" maxlength="40" placeholder="答案（只有你知道，不区分大小写）" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px">
    </div>`).join('')
  layer.innerHTML = `<div class="qr-box" style="max-width:420px;text-align:left">
    <h3 style="text-align:center">🔐 忘记密码机制</h3>
    <p class="muted" style="font-size:12.5px;text-align:center;margin:6px 0 10px">建议设置 3 个密保问题：忘记密码时填 KB号 回答这 3 题，答对即可重设密码（无需同网络）<br>暂时不设置也能正常使用全部功能</p>
    <div style="max-height:52vh;overflow-y:auto">${inputs()}</div>
    <p class="field-err" id="sqErr" style="color:#e74c3c;font-size:12px;min-height:16px;margin:4px 0"></p>
    <div class="modal-btns">
      <button class="btn-ghost" id="sqSkip">暂不设置</button>
      <button class="btn-primary" id="sqSave">保存并启用</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  /* 点遮罩空白处 / ESC 也能关闭，不再堵死整个界面 */
  layer.onclick = e => { if (e.target === layer) closeSecQuizLayer() }
  const escHandler = e => { if (e.key === 'Escape') { closeSecQuizLayer(); document.removeEventListener('keydown', escHandler) } }
  document.addEventListener('keydown', escHandler)
  const skipBtn = layer.querySelector('#sqSkip')
  if (skipBtn) skipBtn.onclick = () => { closeSecQuizLayer(); toast('已跳过，可随时在「设置 → 密保问答」中补设', 3200) }
  layer.querySelector('#sqSave').onclick = async () => {
    const sec3 = [0, 1, 2].map(i => ({ q: layer.querySelector('#sqQ' + i).value.trim(), a: layer.querySelector('#sqA' + i).value.trim() }))
    if (sec3.some(x => !x.q || !x.a)) { layer.querySelector('#sqErr').textContent = '请完整填写 3 个问题和答案'; return }
    if (new Set(sec3.map(x => x.q)).size < 3) { layer.querySelector('#sqErr').textContent = '3 个问题不能重复'; return }
    try {
      await Net.sec3Set({ sec3 })
      if (S.profile) S.profile.hasSec3 = true
      layer.remove()
      toast('密保问答已启用，忘记密码时答 3 题即可找回', 3600)
    } catch (e) {
      layer.querySelector('#sqErr').textContent = e.message || '保存失败'
    }
  }
}
/* 资料弹窗里的密保问答编辑（预填已有问题，答案需重新填写）
 * 已启用密保时：修改前必须先验证身份——输入账号密码 或 答对任意一道原密保问题（后端同样强制校验） */
async function openSecQuizEdit() {
  let qs = ['', '', '']
  let has = false
  try {
    const r = await Net.sec3Get()
    has = !!r.hasSec3
    if (r.questions && r.questions.length === 3) qs = r.questions
  } catch (e) {}
  const layer = document.createElement('div')
  layer.className = 'qr-layer'
  const inputs = () => [0, 1, 2].map(i =>
    `<div style="margin-bottom:10px">
      <div class="muted" style="font-size:12px;margin-bottom:3px">问题 ${i + 1}</div>
      <input id="sqQ${i}" maxlength="60" value="${esc(qs[i] || '')}" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px;margin-bottom:4px">
      <input id="sqA${i}" maxlength="40" placeholder="${has ? '重新填写答案（不回显）' : '答案（只有你知道，不区分大小写）'}" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px">
    </div>`).join('')
  /* 已启用时的身份验证区：密码 或 原密保答案（任意答对一道即可） */
  const verifyBlock = has ? `
    <div style="background:rgba(230,162,60,.08);border:1px solid rgba(230,162,60,.35);border-radius:10px;padding:10px 12px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">🛡️ 先验证身份（二选一）</div>
      <input id="sqPwd" type="password" maxlength="64" placeholder="方式一：输入当前账号密码" style="width:100%;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13.5px;margin-bottom:8px">
      <div class="muted" style="font-size:12px;margin:2px 0 4px">方式二：回答任意一道原密保问题（答对一道即可）</div>
      ${[0, 1, 2].map(i => `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span class="muted" style="font-size:12px;flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(qs[i] || '')}">${esc(i + 1 + '. ' + (qs[i] || ''))}</span>
          <input id="sqOld${i}" maxlength="40" placeholder="原答案" style="flex:1;min-width:0;padding:7px 9px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:13px">
        </div>`).join('')}
    </div>` : ''
  layer.innerHTML = `<div class="qr-box" style="max-width:420px;text-align:left">
    <h3 style="text-align:center">🔐 密保问答${has ? '（已启用）' : ''}</h3>
    <p class="muted" style="font-size:12px;text-align:center;margin:6px 0 10px">忘记密码时填 KB号 回答这 3 题，答对即可重设密码${has ? '；保存后立即生效' : ''}<br><b style="color:#e6a23c">密保启用后不可清除，只能修改</b></p>
    ${verifyBlock}
    <div style="max-height:${has ? '38vh' : '52vh'};overflow-y:auto">${inputs()}</div>
    <p class="field-err" id="sqErr" style="color:#e74c3c;font-size:12px;min-height:16px;margin:4px 0"></p>
    <div class="modal-btns">
      <button class="btn-ghost" id="sqSkip">取消</button>
      <button class="btn-primary" id="sqSave">保存</button>
    </div>
  </div>`
  document.body.appendChild(layer)
  layer.onclick = e => { if (e.target === layer) layer.remove() }
  const skipBtn = layer.querySelector('#sqSkip')
  if (skipBtn) skipBtn.onclick = () => layer.remove()
  layer.querySelector('#sqSave').onclick = async () => {
    const sec3 = [0, 1, 2].map(i => ({ q: layer.querySelector('#sqQ' + i).value.trim(), a: layer.querySelector('#sqA' + i).value.trim() }))
    if (sec3.some(x => !x.q || !x.a)) { layer.querySelector('#sqErr').textContent = '请完整填写 3 个问题和答案'; return }
    /* 已启用：先在前端做一次软校验，给出即时提示（后端仍会硬校验） */
    const payload = { sec3 }
    if (has) {
      const pwd = layer.querySelector('#sqPwd') ? layer.querySelector('#sqPwd').value : ''
      const olds = [0, 1, 2].map(i => layer.querySelector('#sqOld' + i) ? layer.querySelector('#sqOld' + i).value.trim() : '')
      if (!pwd && !olds.some(x => x)) {
        layer.querySelector('#sqErr').textContent = '请先验证身份：输入账号密码，或回答至少一道原密保问题'
        return
      }
      if (pwd) payload.password = pwd
      if (olds.some(x => x)) payload.answers = olds
    }
    try {
      await Net.sec3Set(payload)
      if (S.profile) S.profile.hasSec3 = true
      layer.remove()
      toast('密保问答已保存', 2400)
    } catch (e) {
      layer.querySelector('#sqErr').textContent = e.message || '保存失败'
    }
  }
}

/* ---------- 移动端「发现」页：全部功能入口 ---------- */
function renderDiscover() {
  const grid = el('discoverGrid')
  if (!grid) return
  const items = [
    { ico: '📢', label: '公告栏', nav: 'ann' },
    { ico: '🎮', label: '游戏中心', nav: 'more' },
    { ico: '🎲', label: '抽奖', nav: 'lucky' },
    { ico: '🤝', label: '找朋友', nav: 'find' },
    { ico: '🌐', label: '朋友圈', nav: 'moments' },
    { ico: '📋', label: '靠北帖', nav: 'forum' },
    { ico: '⭐', label: '收藏', nav: 'favorites' },
    { ico: '📁', label: '文件', nav: 'files' },
    { ico: '📮', label: '意见箱', nav: 'feedback' },
  ]
  /* 管理员：发现页提供管理面板入口（移动端管理） */
  if (S.profile && S.profile.isAdmin) items.push({ ico: '🛡️', label: '管理面板', nav: 'admin' })
  grid.innerHTML = items.map(i =>
    `<button type="button" class="discover-item" data-nav="${i.nav}"><span class="dc-ico">${i.ico}</span><span class="dc-label">${i.label}</span></button>`
  ).join('')
  grid.querySelectorAll('.discover-item').forEach(b => {
    b.onclick = () => {
      const nav = b.dataset.nav
      showView(nav)
      if (nav === 'forum') showForumView()
      else if (nav === 'moments') showMomentsView()
      else if (nav === 'admin') openAdminPanel()
    }
  })
}

/* ---------- 移动端底部导航选中态同步 ---------- */
function syncMtab(v) {
  const tabs = document.querySelectorAll('.mtab-btn[data-mv]')
  tabs.forEach(t => {
    /* 游戏 tab 在游戏中心视图时点亮；其它大区域视图（设置/公告等）不点亮 */
    t.classList.toggle('is-on', t.dataset.mv === v)
  })
}

/* ---------- 移动端「更多」抽屉（全部入口，不含游戏） ---------- */
function closeMtabDrawer() {
  const d = el('mtabDrawer')
  if (d) d.hidden = true
}
function toggleMtabDrawer() {
  const d = el('mtabDrawer')
  if (!d.hidden) { d.hidden = true; return }
  const items = [
    ['👤', '我的资料', 'profile'],
    ['👥', '通讯录', 'contacts'],
    ['📢', '公告栏', 'ann'],
    ['⭐', '收藏', 'favorites'],
    ['📁', '文件', 'files'],
    ['🤝', '找朋友', 'find'],
    ['🎲', '抽奖', 'lucky'],
    ['📖', '使用引导', 'guide'],
    ['📮', '意见箱', 'feedback'],
    ['⚙️', '设置', 'settings'],
  ]
  if (S.profile && S.profile.isAdmin) items.push(['🛡️', '管理面板', 'admin'])
  d.innerHTML = '<div class="mtab-drawer-panel"><p class="mtab-drawer-title">全部功能</p>' +
    '<div class="drawer-grid">' + items.map(it =>
      `<button class="drawer-item" data-act="${it[2]}"><span class="di-ico">${it[0]}</span><span>${it[1]}</span></button>`
    ).join('') + '</div></div>'
  d.hidden = false
  d.onclick = e => { if (e.target === d) d.hidden = true }
  d.querySelectorAll('.drawer-item').forEach(b => {
    b.onclick = () => {
      closeMtabDrawer()
      const act = b.dataset.act
      if (act === 'profile') return openProfileSetup()
      if (act === 'contacts') { showView('contacts'); return renderContacts() }
      if (act === 'ann') return showAnnView()
      if (act === 'favorites') return showView('favorites')
      if (act === 'files') return showView('files')
      if (act === 'find') return openBubbles()
      if (act === 'lucky') return openLucky()
      if (act === 'guide') { setTimeout(() => startGuide(true), 200); return }
      if (act === 'feedback') return openFeedbackBox()
      if (act === 'settings') return openSettings()
      if (act === 'admin') return openAdminPanel()
    }
  })
}

/* ---------- Chat 条约只读查看（资料弹窗 / 设置页入口） ---------- */
function openAgreementReadonly() {
  renderAgreement()
  el('agreeCheck').checked = true
  el('agreeCheck').parentElement.hidden = true
  el('agreeErr').textContent = ''
  el('btnAgreeNo').hidden = true
  const yes = el('btnAgreeYes')
  yes.textContent = '关闭'
  yes.disabled = false
  yes.onclick = () => {
    el('agreeCheck').parentElement.hidden = false
    el('btnAgreeNo').hidden = false
    yes.textContent = '同意并进入'
    closeModal()
  }
  openModal('modalAgreement')
}

/* ---------- 意见箱 ---------- */
function openFeedbackBox() {
  showView('feedback')
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  /* CMO 打开的是「查看意见」，不是「写意见」 */
  el('fbCompose').hidden = isAdmin
  el('fbAdmin').hidden = !isAdmin
  if (isAdmin) {
    fbAdminCache = []   /* 每次打开都重新拉，避免看到旧列表 */
    document.querySelectorAll('#fbAdminTabs .atab').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#fbAdminTabs .atab').forEach(x => x.classList.remove('is-on'))
        b.classList.add('is-on')
        loadFbAdmin(b.dataset.f)
      }
    })
    loadFbAdmin('all')
    return
  }
  el('fbText').value = ''
  el('fbErr').textContent = ''
  el('btnFbOk').onclick = async () => {
    const text = el('fbText').value.trim()
    if (!text) { el('fbErr').textContent = '请填写意见内容'; return }
    const btn = el('btnFbOk')
    btn.disabled = true
    try {
      await Net.feedback(text)
      el('fbText').value = ''
      toast('意见已发送给管理员，感谢反馈！', 2800)
    } catch (e) { el('fbErr').textContent = e.message || '发送失败' }
    finally { btn.disabled = false }
  }
}

/* CMO 视角：登录页游客提问 */
async function loadFbGuest() {
  const box = el('fbAdminList')
  box.innerHTML = '<p class="muted">加载中…</p>'
  let list = []
  try {
    const r = await Net.adminGuest()
    list = (r && r.list) || []
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  if (!list.length) {
    box.innerHTML = '<p class="muted">还没有登录页提问。游客在登录页点「我有疑问」写的内容会出现在这里。</p>'
    return
  }
  box.innerHTML = `<p class="muted">共 ${list.length} 条（最近的在上面）· 游客关闭窗口后会自动清除</p>` + list.map(t => {
    const msgs = (t.messages || []).map(m => `<div class="ga-msg ${m.from === 'admin' ? 'is-cmo' : 'is-me'}">
        <div class="ga-bubble">${linkify(m.text)}</div>
        <div class="ga-time">${esc(fmtFull(m.at))}</div>
      </div>`).join('')
    return `<div class="fb-card" data-gid="${esc(t.gid)}">
      <div class="fb-card-head">
        <div class="fb-card-av">❓</div>
        <div class="fb-card-meta">
          <div class="fb-card-name">${esc(t.name || '未留名的访客')}</div>
          <div class="fb-card-time">${esc(fmtFull(t.updatedAt))}</div>
        </div>
        <button class="btn-code" data-gdel="${esc(t.gid)}">清空</button>
      </div>
      <div class="ga-chat ga-chat-mini">${msgs}</div>
      <div class="ga-input">
        <input class="ga-reply" data-greply="${esc(t.gid)}" maxlength="500" placeholder="回复这位访客…">
        <button class="btn-code" data-gsend="${esc(t.gid)}">回复</button>
      </div>
    </div>`
  }).join('')
  box.querySelectorAll('[data-gsend]').forEach(b => {
    b.onclick = async () => {
      const gid = b.dataset.gsend
      const inp = box.querySelector('[data-greply="' + gid + '"]')
      const text = (inp.value || '').trim()
      if (!text) return toast('请输入回复内容')
      try {
        await Net.adminGuestReply(gid, text)
        inp.value = ''
        toast('已回复')
        loadFbGuest()
      } catch (e) { toast(e.message || '回复失败') }
    }
  })
  box.querySelectorAll('[data-gdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('清空这条提问？访客那边也会看不到。')) return
      try { await Net.adminGuestDel(b.dataset.gdel); toast('已清空'); loadFbGuest() }
      catch (e) { toast(e.message || '操作失败') }
    }
  })
}

/* CMO 视角：列出用户提交的意见 */
let fbAdminCache = []
async function loadFbAdmin(filter) {
  const box = el('fbAdminList')
  if (filter === 'guest') return loadFbGuest()
  box.innerHTML = '<p class="muted">加载中…</p>'
  try {
    if (!fbAdminCache.length) {
      const r = await Net.adminFeedback()
      fbAdminCache = (r && r.list) || []
    }
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  const now = Date.now()
  let list = fbAdminCache
  if (filter === 'today') {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0)
    list = list.filter(f => new Date(f.at).getTime() >= d0.getTime())
  } else if (filter === 'week') {
    list = list.filter(f => now - new Date(f.at).getTime() <= 7 * 864e5)
  }
  if (!list.length) {
    box.innerHTML = filter === 'all'
      ? '<p class="muted">还没有用户提交意见。用户在「意见箱」里写的内容会实时出现在这里。</p>'
      : '<p class="muted">这个时间段还没有用户意见</p>'
    return
  }
  box.innerHTML = `<p class="muted">共 ${list.length} 条意见（最新的在上面）</p>` + list.map(f => `
    <div class="fb-card" data-fid="${esc(f.id)}">
      <div class="fb-card-head">
        <div class="fb-card-av">💬</div>
        <div class="fb-card-meta">
          <div class="fb-card-name">${esc(f.fromName || '匿名')}
            <span class="fb-card-wxid">@${esc(f.wxid || '')}</span></div>
          <div class="fb-card-time">${esc(fmtFull(f.at))}</div>
        </div>
        <button class="btn-code" data-fbdel="${esc(f.id)}">删除</button>
      </div>
      <div class="fb-card-text">${esc(f.text || '')}</div>
    </div>`).join('')
  box.querySelectorAll('[data-fbdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除这条意见？删除后无法恢复。')) return
      try {
        await Net.adminFeedbackDel(b.dataset.fbdel)
        fbAdminCache = fbAdminCache.filter(x => x.id !== b.dataset.fbdel)
        loadFbAdmin(document.querySelector('#fbAdminTabs .atab.is-on').dataset.f)
        toast('已删除')
      } catch (e) { toast(e.message || '删除失败') }
    }
  })
}

/* ---------- 界面语言 ----------
 * 键是简体中文原文，值是译文。切换时把这些固定文案原地替换；
 * 聊天记录、动态等用户内容不翻译。 */
const I18N = {
  'zh-TW': {
    '聊天': '聊天', '通讯录': '通訊錄', '靠北帖': '靠北帖', '朋友圈': '朋友圈', '抽奖': '抽獎',
    '公告栏': '公告欄', '收藏': '收藏', '文件': '檔案', '设置': '設定', '搜索': '搜尋',
    'KB号': 'KB號', '密码': '密碼', '昵称': '暱稱', '真实姓名': '真實姓名', '意见箱': '意見箱',
    '发表意见': '發表意見', '新手指引': '新手指引', '消息提示音': '訊息提示音', '界面语言': '介面語言',
    '主题模式': '主題模式', '聊天背景': '聊天背景', '消息翻译': '訊息翻譯', '用户中心': '使用者中心',
    '管理面板': '管理面板', '关闭': '關閉', '取消': '取消', '确定': '確定', '发送': '傳送',
    '登录': '登入', '注册': '註冊', '登 录': '登 入', '注 册 并 进 入': '註 冊 並 進 入',
    '更多': '更多',
    '删除': '刪除',
    '保存': '儲存',
    '确认': '確認',
    '在线': '線上',
    '离線': '離線',
    '上传中…': '上傳中…',
    '已发送': '已傳送',
    '下载': '下載',
    '文件传输助手': '檔案傳輸助手',
    '图片': '圖片',
    '翻译': '翻譯',
    '举报': '舉報',
    '置顶': '置頂',
    '加载中…': '載入中…',
    '暂无': '暫無',
    '账号': '帳號',
    '退出登录': '登出',
    '我的二维码': '我的二維碼',
    '管理员承诺书': '管理員承諾書',
    'Chat 条约': 'Chat 條約',
    '申请添加': '申請添加',
    '同意': '同意',
    '拒绝': '拒絕',
    '成员': '成員',
    '管理员': '管理員',
    '公告': '公告',
    '背景浓度': '背景濃度',
    '恢复默认': '恢復預設',
    '纯色': '純色',
    '渐变': '漸變',
    '查看': '查看',
  },
  en: {
    '更多': 'More',
    '发送': 'Send',
    '取消': 'Cancel',
    '关闭': 'Close',
    '离线': 'Offline',
    '文件': 'File',
    '聊天': 'Chats', '通讯录': 'Contacts', '靠北帖': 'Forum', '朋友圈': 'Moments', '抽奖': 'Lucky Draw',
    '公告栏': 'Board', '收藏': 'Favorites', '文件': 'Files', '设置': 'Settings', '搜索': 'Search',
    'KB号': 'KB ID', '密码': 'Password', '昵称': 'Nickname', '真实姓名': 'Real name',
    '意见箱': 'Feedback', '发表意见': 'Give feedback', '新手指引': 'Guide',
    '消息提示音': 'Notification sound', '界面语言': 'Language', '主题模式': 'Theme',
    '聊天背景': 'Chat background', '消息翻译': 'Translation', '用户中心': 'User center',
    '更多': 'もっと見る',
    '发送': '送信',
    '删除': '削除',
    '保存': '保存',
    '取消': 'キャンセル',
    '确认': '確認',
    '关闭': '閉じる',
    '在线': 'オンライン',
    '离线': 'オフライン',
    '上传中…': 'アップロード中…',
    '已发送': '送信済み',
    '下载': 'ダウンロード',
    '文件传输助手': 'ファイル転送',
    '图片': '画像',
    '翻译': '翻訳',
    '举报': '通報',
    '置顶': '固定',
    '加载中…': '読み込み中…',
    '暂无': 'まだありません',
    '账号': 'アカウント',
    '退出登录': 'ログアウト',
    '我的二维码': 'マイQRコード',
    '管理员承诺书': '管理者誓約書',
    'Chat 条约': 'Chat 利用規約',
    '申请添加': '友達申請',
    '同意': '同意する',
    '拒绝': '拒否',
    '成员': 'メンバー',
    '管理员': '管理者',
    '公告': 'お知らせ',
    '背景浓度': '背景の濃さ',
    '恢复默认': 'リセット',
    '纯色': '単色',
    '渐变': 'グラデーション',
    '查看': '表示',
    '聊天': 'Чаты',
    '靠北帖': 'Посты',
    '朋友圈': 'Моменты',
    '更多': 'Ещё',
    '通讯录': 'Контакты',
    '发送': 'Отправить',
    '文件': 'Файл',
    '管理面板': 'Admin panel', '关闭': 'Close', '取消': 'Cancel', '确定': 'OK',
    '发送': 'Send', '登录': 'Sign in', '注册': 'Sign up',
    '聊天': '채팅',
    '删除': '삭제',
    '保存': '저장',
    '确认': '확인',
    '在线': '온라인',
    '离线': '오프라인',
    '上传中…': '업로드 중…',
    '已发送': '전송됨',
    '下载': '다운로드',
    '文件传输助手': '파일 전송',
    '图片': '이미지',
    '翻译': '번역',
    '举报': '신고',
    '置顶': '고정',
    '加载中…': '불러오는 중…',
    '暂无': '없음',
    '账号': '계정',
    '退出登录': '로그아웃',
    '我的二维码': '내 QR코드',
    '管理员承诺书': '관리자 서약',
    'Chat 条约': 'Chat 약관',
    '申请添加': '친구 신청',
    '同意': '수락',
    '拒绝': '거절',
    '成员': '멤버',
    '管理员': '관리자',
    '公告': '공지',
    '背景浓度': '배경 농도',
    '恢复默认': '기본값',
    '纯色': '단색',
    '渐变': '그라데이션',
    '查看': '보기',
    '登 录': 'Sign in', '注 册 并 进 入': 'Sign up & Enter',
  },
  ja: {
    '聊天': 'チャット', '通讯录': '連絡先', '靠北帖': 'フォーラム', '朋友圈': 'モーメンツ', '抽奖': '抽選',
    '公告栏': 'お知らせ', '收藏': 'お気に入り', '文件': 'ファイル', '设置': '設定', '搜索': '検索',
    'KB号': 'KB ID', '密码': 'パスワード', '昵称': 'ニックネーム', '真实姓名': '本名',
    '意见箱': '意見箱', '发表意见': '意見を送る', '新手指引': 'チュートリアル',
    '消息提示音': '通知音', '界面语言': '言語', '主题模式': 'テーマ',
    '聊天背景': 'チャット背景', '消息翻译': '翻訳', '用户中心': 'ユーザーセンター',
    '管理面板': '管理パネル', '关闭': '閉じる', '取消': 'キャンセル', '确定': '決定',
    '发送': '送信', '登录': 'ログイン', '注册': '登録',
    '登 录': 'ログイン', '注 册 并 进 入': '登録して開始',
  },
  ru: {
    '聊天': 'Чаты', '通讯录': 'Контакты', '靠北帖': 'Форум', '朋友圈': 'Моменты', '抽奖': 'Розыгрыш',
    '公告栏': 'Объявления', '收藏': 'Избранное', '文件': 'Файлы', '设置': 'Настройки', '搜索': 'Поиск',
    'KB号': 'KB ID', '密码': 'Пароль', '昵称': 'Ник', '真实姓名': 'Имя',
    '意见箱': 'Обратная связь', '发表意见': 'Оставить отзыв', '新手指引': 'Обучение',
    '消息提示音': 'Звук уведомлений', '界面语言': 'Язык', '主题模式': 'Тема',
    '聊天背景': 'Фон чата', '消息翻译': 'Перевод', '用户中心': 'Центр пользователя',
    '管理面板': 'Панель управления', '关闭': 'Закрыть', '取消': 'Отмена', '确定': 'ОК',
    '发送': 'Отправить', '登录': 'Войти', '注册': 'Регистрация',
    '登 录': 'Войти', '注 册 并 进 入': 'Регистрация',
  },
  ko: {
    '聊天': '채팅', '通讯录': '연락처', '靠北帖': '포럼', '朋友圈': '모멘트', '抽奖': '추첨',
    '公告栏': '공지', '收藏': '즐겨찾기', '文件': '파일', '设置': '설정', '搜索': '검색',
    'KB号': 'KB ID', '密码': '비밀번호', '昵称': '닉네임', '真实姓名': '실명',
    '意见箱': '의견함', '发表意见': '의견 보내기', '新手指引': '가이드',
    '消息提示音': '알림음', '界面语言': '언어', '主题模式': '테마',
    '聊天背景': '채팅 배경', '消息翻译': '번역', '用户中心': '사용자 센터',
    '管理面板': '관리자 패널', '关闭': '닫기', '取消': '취소', '确定': '확인',
    '发送': '보내기', '登录': '로그인', '注册': '가입',
    '登 录': '로그인', '注 册 并 进 入': '가입하고 입장',
  },
  th: {
    '聊天': 'แชท', '通讯录': 'รายชื่อ', '靠北帖': 'ฟอรัม', '朋友圈': 'โมเมนต์', '抽奖': 'จับรางวัล',
    '公告栏': 'ประกาศ', '收藏': 'รายการโปรด', '文件': 'ไฟล์', '设置': 'ตั้งค่า', '搜索': 'ค้นหา',
    'KB号': 'KB ID', '密码': 'รหัสผ่าน', '昵称': 'ชื่อเล่น', '真实姓名': 'ชื่อจริง',
    '意见箱': 'กล่องความคิดเห็น', '发表意见': 'แสดงความคิดเห็น', '新手指引': 'คำแนะนำ',
    '消息提示音': 'เสียงแจ้งเตือน', '界面语言': 'ภาษา', '主题模式': 'ธีม',
    '聊天背景': 'พื้นหลังแชท', '消息翻译': 'แปล', '用户中心': 'ศูนย์ผู้ใช้',
    '管理面板': 'แผงผู้ดูแล', '关闭': 'ปิด', '取消': 'ยกเลิก', '确定': 'ตกลง',
    '发送': 'ส่ง', '登录': 'เข้าสู่ระบบ', '注册': 'สมัคร',
    '登 录': 'เข้าสู่ระบบ', '注 册 并 进 入': 'ลงทะเบียน',
  },
  es: {
    '聊天': 'Chats', '通讯录': 'Contactos', '靠北帖': 'Foro', '朋友圈': 'Momentos', '抽奖': 'Sorteo',
    '公告栏': 'Anuncios', '收藏': 'Favoritos', '文件': 'Archivos', '设置': 'Ajustes', '搜索': 'Buscar',
    'KB号': 'ID KB', '密码': 'Contraseña', '昵称': 'Apodo', '真实姓名': 'Nombre real',
    '意见箱': 'Buzón', '发表意见': 'Enviar opinión', '新手指引': 'Guía',
    '消息提示音': 'Sonido', '界面语言': 'Idioma', '主题模式': 'Tema',
    '聊天背景': 'Fondo del chat', '消息翻译': 'Traducción', '用户中心': 'Centro de usuario',
    '管理面板': 'Panel de admin', '关闭': 'Cerrar', '取消': 'Cancelar', '确定': 'Aceptar',
    '发送': 'Enviar', '登录': 'Entrar', '注册': 'Registrarse',
    '登 录': 'Entrar', '注 册 并 进 入': 'Registrarse',
  },
}

/* 原文快照：只记录静态界面文案，动态渲染区（聊天/列表/管理面板/指引）不参与翻译 */
const __i18nOrig = new Map()
function i18nSkip(node) {
  const p = node.parentElement
  if (!p) return true
  if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(p.tagName)) return true
  return !!p.closest('#chatList,#msgStack,#annListFull,#momentList,#forumList,#adminList,#adminChat,#guideLayer')
}
function collectI18nNodes() {
  if (__i18nOrig.size) return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let n
  while ((n = walker.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue
    if (i18nSkip(n)) continue
    __i18nOrig.set(n, n.nodeValue)
  }
}
function applyLang() {
  const lang = localStorage.getItem('kbchat_lang') || 'zh-CN'
  document.documentElement.lang = lang
  collectI18nNodes()
  const dict = I18N[lang]
  __i18nOrig.forEach((orig, node) => {
    const key = orig.trim()
    if (!dict || !dict[key]) { node.nodeValue = orig; return }
    const lead = (orig.match(/^\s*/) || [''])[0]
    const trail = (orig.match(/\s*$/) || [''])[0]
    node.nodeValue = lead + dict[key] + trail
  })
  document.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(inp => {
    if (!inp.dataset.i18nPh) inp.dataset.i18nPh = inp.placeholder
    const base = inp.dataset.i18nPh
    const t = dict && dict[base.trim()]
    inp.placeholder = t || base
  })
  /* 图标按钮只有 title 提示，也一起翻译 */
  document.querySelectorAll('[title]').forEach(node => {
    if (!node.dataset.i18nTitle) node.dataset.i18nTitle = node.title
    const base = node.dataset.i18nTitle
    const t = dict && dict[base.trim()]
    node.title = t || base
  })
}

/* ---------- 更多：游戏 ---------- */
let moreInited = false

function openMoreSection() {
  showView('more')
  if (!moreInited) { initMore(); moreInited = true }
  loadGames()
  /* 天气卡片（与朋友圈共用逻辑，容器不同） */
  loadWeather('weatherCardMore')
}

/* ---------- 内置小游戏：iframe 全屏弹层（同源共享登录态） ---------- */
function openGameLayer(src, bg, key) {
  if (document.getElementById(key)) return
  const layer = document.createElement('div')
  layer.id = key
  layer.className = 'qr-layer'
  layer.style.zIndex = 500
  layer.style.background = bg
  layer.innerHTML = `<button type="button" class="game-layer-close" title="退出游戏">✕</button>
    <iframe src="${src}" style="position:absolute;inset:0;width:100%;height:100%;border:none" allow="autoplay"></iframe>`
  document.body.appendChild(layer)
  layer.querySelector('.game-layer-close').onclick = () => layer.remove()
}
function openJumpGame() { openGameLayer('jump.html', '#080b1a', 'jumpGameLayer') }
function openChengyuGame() { openGameLayer('chengyu.html', '#0b1020', 'chengyuGameLayer') }
function openMatch3Game() { openGameLayer('match3.html', '#1a1230', 'match3GameLayer') }

function initMore() {
  el('btnGameAdd').onclick = openGameAdd
  const jump = el('gameJump')
  if (jump) jump.onclick = openJumpGame
  const solitaire = el('gameSolitaire')
  if (solitaire) solitaire.onclick = openChengyuGame
  const match3 = el('gameMatch3')
  if (match3) match3.onclick = openMatch3Game
}

/* ---- 游戏列表 ---- */
async function loadGames() {
  const box = el('gamesGrid')
  const isAdmin = !!(S.profile && S.profile.isAdmin)
  el('btnGameAdd').hidden = !isAdmin
  box.innerHTML = '<p class="muted">加载中…</p>'
  let list = [], canManage = false
  try {
    const r = await Net.games()
    list = r.list || []
    canManage = !!r.canManage
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message || '加载失败')}</p>`
    return
  }
  if (!list.length) { box.innerHTML = '<p class="muted">还没有游戏，等 CMO 来添加</p>'; return }
  /* 封面：站点 favicon 加载失败时，用首字色块兜底，不再出现空白卡 */
  const HUES = [351, 25, 45, 90, 145, 172, 200, 225, 262, 290, 320]
  const hueOf = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 997; return HUES[h % HUES.length] }
  box.innerHTML = list.map(g => {
    const letter = (g.name || '?').trim().charAt(0).toUpperCase()
    const hue = hueOf(g.name)
    return `<div class="game-card${g.pinned ? ' is-pinned' : ''}" data-gid="${esc(g.id)}" data-gurl="${esc(g.url)}">
    <div class="gc-cover">
      <span class="gc-letter" style="background:hsl(${hue},72%,88%);color:hsl(${hue},62%,32%)">${esc(letter)}</span>
      <img src="${esc(g.img)}" alt="${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer"
        onerror="this.remove()">
      ${g.pinned ? '<span class="gc-pin">📌 置顶</span>' : ''}
    </div>
    <div class="gc-name">${esc(g.name)}</div>
    ${canManage ? `<div class="gc-ops">
      <button class="btn-code" data-gpin="${esc(g.id)}">${g.pinned ? '取消置顶' : '置顶'}</button>
      <button class="btn-code" data-gdel="${esc(g.id)}">删除</button>
    </div>` : ''}
  </div>`
  }).join('')
  box.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.gc-ops')) return
      window.open(card.dataset.gurl, '_blank', 'noopener')
    })
  })
  box.querySelectorAll('[data-gpin]').forEach(b => {
    b.onclick = async () => {
      try { await Net.adminGamePin(b.dataset.gpin); loadGames() }
      catch (e) { toast(e.message || '操作失败') }
    }
  })
  box.querySelectorAll('[data-gdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('删除这个游戏卡片？')) return
      try { await Net.adminGameDel(b.dataset.gdel); toast('已删除'); loadGames() }
      catch (e) { toast(e.message || '操作失败') }
    }
  })
  /* CMO 右键菜单：置顶 / 修改 / 删除 */
  if (canManage) {
    box.querySelectorAll('.game-card[data-gid]').forEach(card => {
      card.addEventListener('contextmenu', e => {
        e.preventDefault()
        const id = card.dataset.gid
        const g = (list || []).find(x => x.id === id)
        if (!g) return
        showGameCtxMenu(e.clientX, e.clientY, g)
      })
    })
  }
}

/* 游戏卡片右键菜单（CMO）：置顶/取消置顶、修改、删除 */
function showGameCtxMenu(x, y, g) {
  document.querySelectorAll('.game-ctx-menu').forEach(m => m.remove())
  const menu = document.createElement('div')
  menu.className = 'msg-menu game-ctx-menu'
  const item = (label, fn, cls) => {
    const b = document.createElement('button')
    b.className = 'mm-item' + (cls ? ' ' + cls : '')
    b.textContent = label
    b.onclick = () => { menu.remove(); fn() }
    return b
  }
  menu.appendChild(item(g.pinned ? '📌 取消置顶' : '📌 置顶', async () => {
    try { await Net.adminGamePin(g.id); toast(g.pinned ? '已取消置顶' : '已置顶'); loadGames() }
    catch (e) { toast(e.message || '操作失败') }
  }))
  menu.appendChild(item('✏️ 修改', () => openGameEdit(g)))
  menu.appendChild(item('🗑️ 删除', async () => {
    if (!confirm('删除「' + (g.name || '') + '」这个游戏卡片？')) return
    try { await Net.adminGameDel(g.id); toast('已删除'); loadGames() }
    catch (e) { toast(e.message || '操作失败') }
  }, 'danger'))
  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
  setTimeout(() => {
    const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close, true) } }
    document.addEventListener('click', close, true)
  }, 0)
}

/* CMO 修改游戏：复用添加弹窗，预填当前值 */
function openGameEdit(g) {
  el('gameName').value = g.name || ''
  el('gameUrl').value = g.url || ''
  el('gameImg').value = g.img || ''
  el('gameErr').textContent = ''
  el('btnGameOk').textContent = '保存修改'
  el('btnGameCancel').onclick = () => { el('btnGameOk').textContent = '添加'; closeModal() }
  el('btnGameOk').onclick = async () => {
    const name = el('gameName').value.trim()
    const url = el('gameUrl').value.trim()
    const img = el('gameImg').value.trim()
    if (!name) { el('gameErr').textContent = '请填写游戏名称'; return }
    if (!/^https?:\/\/.+/i.test(url)) { el('gameErr').textContent = '请填写以 http(s):// 开头的链接'; return }
    if (!/^https?:\/\/.+/i.test(img)) { el('gameErr').textContent = '必须带上图片（填写图片地址）'; return }
    try {
      await Net.adminGameEdit({ id: g.id, name, url, img })
      el('btnGameOk').textContent = '添加'
      closeModal()
      toast('已保存修改')
      loadGames()
    } catch (e) { el('gameErr').textContent = e.message || '保存失败' }
  }
  openModal('modalGameAdd')
}

function openGameAdd() {
  el('gameName').value = ''
  el('gameUrl').value = ''
  el('gameImg').value = ''
  el('gameErr').textContent = ''
  el('btnGameCancel').onclick = closeModal
  el('btnGameOk').onclick = async () => {
    const name = el('gameName').value.trim()
    const url = el('gameUrl').value.trim()
    const img = el('gameImg').value.trim()
    if (!name) { el('gameErr').textContent = '请填写游戏名称'; return }
    if (!/^https?:\/\/.+/i.test(url)) { el('gameErr').textContent = '请填写以 http(s):// 开头的链接'; return }
    if (!/^https?:\/\/.+/i.test(img)) { el('gameErr').textContent = '必须带上图片（填写图片地址）'; return }
    try {
      await Net.adminGameAdd({ name, url, img })
      closeModal()
      toast('已添加，可点「置顶」放到最前面')
      loadGames()
    } catch (e) { el('gameErr').textContent = e.message || '添加失败' }
  }
  openModal('modalGameAdd')
}

/* ---------- 主界面事件 ---------- */
function bindMain() {
  /* 移动端底部导航：聊天 / 靠北帖 / 朋友圈 / 发现（全部功能入口）/ 我的（个人信息） */
  document.querySelectorAll('.mtab-btn[data-mv]').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.mv
      if (v === 'chats') showView('chats')
      else if (v === 'forum') showForumView()
      else if (v === 'moments') showMomentsView()
      else if (v === 'discover') { showView('discover'); renderDiscover() }
      else if (v === 'me') { showView('chats'); openProfileSetup() }
    }
  })
  /* 「更多」入口：聊天列表头部 + 游戏中心头部（打开全部功能抽屉） */
  const mf = document.getElementById('btnMoreFloat')
  if (mf) mf.onclick = () => toggleMtabDrawer()
  const mf2 = document.getElementById('btnMoreFloat2')
  if (mf2) mf2.onclick = () => toggleMtabDrawer()
  /* 小靠AI 工具条 */
  /* AI 模式下拉：点击选项切换模式并更新主按钮文案（元宝风格） */
  const aiModeBtn = el('aiModeBtn')
  const aiModeMenu = el('aiMode')
  const syncAiModeBtn = () => {
    const on = document.querySelector('#aiMode button.is-on')
    if (on && aiModeBtn) aiModeBtn.innerHTML = on.childNodes[0].textContent.trim() + ' <span class="ai-caret">▾</span>'
  }
  if (aiModeBtn && aiModeMenu) {
    aiModeBtn.onclick = e => { e.stopPropagation(); aiModeMenu.hidden = !aiModeMenu.hidden }
    document.addEventListener('click', e => {
      if (!aiModeMenu.hidden && !e.target.closest('#aiMode') && !e.target.closest('#aiModeBtn')) aiModeMenu.hidden = true
    })
  }
  document.querySelectorAll('#aiMode button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#aiMode button').forEach(x => x.classList.toggle('is-on', x === b))
      syncAiModeBtn()
      if (aiModeMenu) aiModeMenu.hidden = true
    }
  })
  /* 移动端：AI 功能收进「＋」网格面板（微信风格，顶部 chips 行在手机上隐藏） */
  /* ＋ 键双职责：AI 模式弹出 AI 功能网格；普通聊天弹出微信式「更多」面板（toggleMoreGrid 绑定在下方 composer 事件区） */
  const aiPlus = el('btnPlus')
  if (aiPlus) {
    aiPlus.onclick = () => {
      if (!el('composer').classList.contains('ai-mode')) { toggleMoreGrid(); return }
      const old = document.getElementById('aiPlusGrid')
      if (old) { old.remove(); return }
      const mode = (document.querySelector('#aiMode button.is-on') || {}).dataset.am || 'quick'
      const grid = document.createElement('div')
      grid.id = 'aiPlusGrid'
      grid.className = 'ai-plus-grid'
      const item = (ico, label, on, fn) =>
        `<button type="button" class="ai-plus-item${on ? ' is-on' : ''}" data-fn="${fn}"><span class="api-ico">${ico}</span><span>${label}</span></button>`
      grid.innerHTML =
        item('⚡', '快速回答', mode === 'quick', 'quick') +
        item('🔍', '深度思考', mode === 'deep', 'deep') +
        item('🎓', '专家模式', mode === 'expert', 'expert') +
        item('🤖', '切换模型', false, 'model') +
        item('🖼️', '发图片', false, 'image') +
        item('🆕', '新对话', false, 'newchat') +
        item('🕘', '历史对话', false, 'history') +
        item('🧹', '清空记录', false, 'clear')
      el('composer').after(grid)
      grid.onclick = async e => {
        const b = e.target.closest('.ai-plus-item')
        if (!b) return
        const fn = b.dataset.fn
        if (['quick', 'deep', 'expert'].includes(fn)) {
          document.querySelectorAll('#aiMode button').forEach(x => x.classList.toggle('is-on', x.dataset.am === fn))
          syncAiModeBtn()
          toast('已切换：' + b.querySelector('span:last-child').textContent, 1600)
          grid.remove()
        } else if (fn === 'model') {
          const sel = el('aiModel')
          sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length
          toast('模型已切换：' + sel.options[sel.selectedIndex].text, 2200)
          grid.remove()
        } else if (fn === 'image') {
          el('btnAiImage').click()
          grid.remove()
        } else if (fn === 'newchat') {
          aiNewChat()
          grid.remove()
        } else if (fn === 'history') {
          aiOpenHistory()
          grid.remove()
        } else if (fn === 'clear') {
          if (!confirm('清空与小靠AI 的全部聊天记录？')) return
          S.messages = S.messages.filter(m => m.roomId !== 'ai_chat')
          try { localStorage.removeItem(aiHistKey()) } catch (e2) {}
          renderMessages()
          toast('已清空', 1600)
          grid.remove()
        }
      }
    }
  }
  el('btnAiImage').onclick = async () => {
    if (S.activeRoom !== 'ai_chat') return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const f = input.files && input.files[0]
      if (!f) return
      try {
        toast('正在上传图片…', 1500)
        const url = await Net.uploadImage(f, { maxEdge: 1024, quality: 0.82 })
        aiPendingImages.push(url)
        renderAiPending()
        toast('图片已附上，点发送让小靠AI理解（可附带文字）', 3200)
      } catch (e) { toast(e.message || '图片上传失败') }
    }
    input.click()
  }

  document.querySelectorAll('.rail-btn[data-nav]').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.nav
      if (v === 'ann') return showAnnView()
      if (v === 'forum') return showForumView()
      if (v === 'moments') return showMomentsView()
      if (v === 'lucky') return openLucky()
      if (v === 'settings') return openSettings()
      if (v === 'admin') return openAdminPanel()
      if (v === 'find') return openBubbles()
      if (v === 'feedback') return openFeedbackBox()
      if (v === 'favorites') return showFavoritesView()
      if (v === 'files') return showFilesView()
      if (v === 'more') return openMoreSection()
      /* 离开公告栏时：有未读则确认 */
      if (S.view === 'ann' && !closeAnnView()) return
      showView(v)
      if (v === 'contacts') renderContacts()
    }
  })
  el('railAvatar').onclick = () => openProfileSetup()
  /* 移动端：底部导航第一位加「我的资料」按钮（桌面端由 CSS 隐藏，点击左上角头像） */
  const mobAvatar = document.createElement('button')
  mobAvatar.className = 'rail-btn rail-btn-mob-avatar'
  mobAvatar.title = '我的资料'
  mobAvatar.innerHTML = '<span class="ico">👤</span>'
  mobAvatar.onclick = () => openProfileSetup()
  const railNavEl = document.querySelector('.rail-nav')
  if (railNavEl) railNavEl.prepend(mobAvatar)
  el('btnSettings2').onclick = () => openSettings()
  el('btnCloseReqs').onclick = closeModal

  /* 消息右键菜单 / 多选 */
  el('msgStack').addEventListener('contextmenu', e => {
    const card = e.target.closest('.msg[data-mid]')
    if (!card) return
    const m = (S.messages || []).find(x => x.id === card.dataset.mid)
    if (!m || m.kind === 'system' || m.kind === 'recalled') return
    showMsgMenu(e, m)
  })
  /* 点定位卡片打开地图 */
  el('msgStack').addEventListener('click', e => {
    /* 点头像 → 资料/信息卡（微信式） */
    const av = e.target.closest('.msg-av.av-link')
    if (av && av.dataset.uid) return openProfileCard(av.dataset.uid)
    const card = e.target.closest('.msg-loc')
    if (!card) return
    const m = (S.messages || []).find(x => x.id === card.dataset.locid)
    if (!m) return
    const loc = parseLoc(m)
    if (!loc) return toast('这条位置信息无效')
    openLocationView(loc, (m.senderName || '对方') + ' 的位置')
  })
  el('msgStack').addEventListener('change', e => {
    if (!S.multiSelect || !S.multiSelect.on) return
    if (!e.target.matches('input[data-mid]')) return
    const id = e.target.dataset.mid
    const set = new Set(S.multiSelect.ids)
    if (e.target.checked) set.add(id); else set.delete(id)
    S.multiSelect.ids = [...set]
    updateMultiCount()
  })
  el('mbCancel').onclick = exitMultiSelect
  el('mbMerge').onclick = () => {
    const msgs = (S.messages || []).filter(m => S.multiSelect.ids.includes(m.id))
    if (!msgs.length) return toast('请先选择消息')
    exitMultiSelect(); openForward(msgs, 'merge')
  }
  el('mbEach').onclick = () => {
    const msgs = (S.messages || []).filter(m => S.multiSelect.ids.includes(m.id))
    if (!msgs.length) return toast('请先选择消息')
    exitMultiSelect(); openForward(msgs, 'each')
  }
  el('mbDel').onclick = () => {
    const msgs = (S.messages || []).filter(m => S.multiSelect.ids.includes(m.id))
    if (!msgs.length) return toast('请先选择消息')
    if (!confirm('删除所选 ' + msgs.length + ' 条消息？自己的消息将撤回，他人的仅自己不可见。')) return
    multiDelete(msgs)
  }
  el('btnAdmin').onclick = () => openAdminPanel()
  el('btnAdminRefresh').onclick = refreshAdmin
  el('btnAdminRegister').onclick = () => openAdminRegister()
  el('btnAdminRepair').onclick = async () => {
    if (!confirm('修复好友关系？\n\n会做三件事：\n1. 删掉「自己加自己」和指向已删除账号的脏好友\n2. 刷新好友名片里的昵称/头像\n3. 保证每个用户都与 CMO 互为好友（不被断绝关系的除外）')) return
    const btn = el('btnAdminRepair')
    btn.disabled = true
    try {
      const r = await Net.adminRepairFriends()
      const s = r.stat || {}
      toast('已修复：清理自己加自己 ' + (s.self || 0) + ' 条、无效条目 ' + (s.dangling || 0) +
        ' 条、重复 ' + (s.dup || 0) + ' 条，补建好友关系 ' + (s.linked || 0) + ' 条', 5200)
      const data = await Net.bootstrap()
      S.friends = data.friends || []
      renderContacts()
    } catch (e) {
      toast(e.message || '修复失败')
    } finally { btn.disabled = false }
  }
  el('adminSearch').addEventListener('input', () => {
    if (adminView === 'users') renderAdminUsers()
    else if (adminView === 'rooms') renderAdminRooms()
  })
  el('adminSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const v = (el('adminSearch').value || '').trim()
    if (adminView === 'msgs') runMsgSearch()
    else if (adminView === 'dms') loadAdminDms(v)
    else if (adminView === 'groups') loadAdminGroups(v)
  })
  el('adminList').onclick = e => {
    if (adminView === 'users') onAdminAction(e)
    else if (adminView === 'rooms') onAdminRoomClick(e)
    else if (adminView === 'dms') onAdminDmClick(e)
    else if (adminView === 'groups') onAdminGroupClick(e)
    else if (adminView === 'ann') onAdminAnnClick(e)
    else if (adminView === 'bans') onAdminBanClick(e)
    else if (adminView === 'admins') onAdminAdminsClick(e)
    else if (adminView === 'fbreq') onAdminFbReqClick(e)
  }
  document.querySelectorAll('#adminTabs .atab').forEach(b => {
    b.onclick = () => switchAdminView(b.dataset.v)
  })
  el('btnCreate').onclick = () => { showView('contacts'); renderContacts(); openAddModal() }
  const annBanner = document.getElementById('chatAnnBanner')
  if (annBanner) annBanner.onclick = () => showAnnView()
  const pa = document.getElementById('btnProfileAgreement')
  if (pa) pa.onclick = () => openAgreementReadonly()
  const pe = document.getElementById('btnProfileSecQuiz')
  if (pe) pe.onclick = () => openSecQuizEdit()
  const sa = document.getElementById('btnSetAgreement')
  if (sa) sa.onclick = () => openAgreementReadonly()
  const sp = document.getElementById('btnSetPledge')
  if (sp) sp.onclick = () => openAgreementReadonly()   /* 条约查看含管理员承诺书章节 */
  const cu = document.getElementById('btnCheckUpdate')
  if (cu) cu.onclick = () => openCheckUpdate()
  el('btnMyQr').onclick = () => openMyQr()
  el('btnScanQr').onclick = () => openScanModal('camera')
  el('btnGalleryQr').onclick = () => openScanModal('gallery')
  el('btnAddMenu').onclick = () => { showView('contacts'); renderContacts(); openAddModal() }

  el('chatList').onclick = e => {
    const c = e.target.closest('.conv')
    if (!c) return
    const conv = S.conversations.find(x => x.roomId === c.dataset.room)
    openRoom(c.dataset.room, conv ? conv.kind : (c.dataset.room.startsWith('grp_') ? 'group' : 'dm'))
  }

  el('contactList').onclick = e => {
    const item = e.target.closest('.contact')
    if (!item) return
    if (item.dataset.act === 'add') return openAddModal()
    if (item.dataset.act === 'reqs') return openReqsModal()
    if (item.dataset.act === 'newgroup') return openGroupModal()
    if (item.dataset.group) {
      const g = S.groups.find(x => x.roomId === item.dataset.group)
      if (g && !S.conversations.some(c => c.roomId === g.roomId)) {
        S.conversations.push({
          roomId: g.roomId, kind: 'group', name: g.name, avatar: '\ud83d\udc65',
          members: g.members, memberNames: g.memberNames,
          lastMsg: null, ts: g.createdAt, unread: 0,
        })
      }
      return openRoom(item.dataset.group, 'group')
    }
    if (item.dataset.uid) {
      const f = S.friends.find(x => x.uid === item.dataset.uid)
      openDirect(item.dataset.uid, f && f.name, f && f.avatar)
    }
  }

  el('btnBack').onclick = () => {
    /* AI 视图（桌面端）：← 收起/展开 AI 会话侧栏（元宝式，再点一次展开） */
    if (document.body.classList.contains('ai-open') && !isMobile()) {
      document.body.classList.toggle('ai-side-collapsed')
      return
    }
    leaveChat(); renderChatList()
  }

  const input = el('msgInput')
  input.addEventListener('input', updateSendBtn)
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return
    const mode = localStorage.getItem('kbchat_enter') || 'enter'
    if (mode === 'ctrl') {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); sendText() }
      return
    }
    if (!e.shiftKey) { e.preventDefault(); sendText() }
  })
  el('btnSend').onclick = sendText

  el('btnEmoji').onclick = e => {
    e.stopPropagation()
    const pop = el('emojiPop')
    if (!pop.hidden) { pop.hidden = true; return }
    const r = el('btnEmoji').getBoundingClientRect()
    const popW = Math.min(320, innerWidth - 16)
    pop.style.width = popW + 'px'
    pop.style.left = Math.max(8, Math.min(r.left - 140, innerWidth - popW - 8)) + 'px'
    pop.style.top = Math.max(8, r.top - 210) + 'px'
    pop.hidden = false
  }
  renderEmojiTabs('smile')
  el('emojiGrid').onclick = e => {
    const b = e.target.closest('button[data-e]')
    if (!b) return
    input.value += b.dataset.e
    updateSendBtn()
    input.focus()
  }
  document.addEventListener('click', e => {
    const pop = el('emojiPop')
    if (!pop.hidden && !pop.contains(e.target) && e.target !== el('btnEmoji')) pop.hidden = true
  })

  el('btnImage').onclick = () => el('filePicker').click()
  /* 显式粘贴入口：不依赖系统剪贴板，直接把右键复制过的文件作为新消息发出 */
  if (el('btnPasteClip')) el('btnPasteClip').onclick = () => { sendClipboardFile() }

  /* 📋 输入框粘贴发送：
   * 1) 系统剪贴板里有文件（截图/复制的文件）→ 直接作为文件消息发送；
   * 2) 应用内右键「复制」过的文件/图片消息 → 粘贴即作为新消息发出（服务端落库，非临时链接） */
  el('msgInput').addEventListener('paste', async e => {
    if (!S.activeRoom) return
    const dt = e.clipboardData
    const items = dt ? Array.from(dt.items || []) : []
    const osFiles = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
    const hasText = items.some(i => i.kind === 'string')
    if (osFiles.length) {
      e.preventDefault()
      for (const f of osFiles.slice(0, 5)) {
        if (f.size > 500 * 1024 * 1024) { toast('「' + (f.name || '文件') + '」超过 500MB，已跳过'); continue }
        try {
          toast('正在上传 ' + (f.name || '剪贴板文件') + '…', 2600)
          const r2 = await Net.uploadLarge(f)
          await doSend('file', r2.url, f.name || '粘贴的文件')
        } catch (err) { toast('粘贴发送失败：' + (err.message || '未知错误'), 3000) }
      }
      return
    }
    let clip = null
    try { clip = JSON.parse(localStorage.getItem('kbchat_clip') || 'null') } catch (e2) {}
    /* 识别应用内「复制文件」写入的系统剪贴板标记。
     * 旧逻辑要求剪贴板完全无文本，Windows 下剪贴板几乎总有残留文字 → 永远走不到这里，
     * 表现为「复制文件后 Ctrl+V 只粘出旧文字/没反应」。现在优先认标记，普通文本粘贴不受影响。 */
    const pastedText = dt ? String(dt.getData('text/plain') || '').trim() : ''
    const markHit = KB_CLIP_MARK.test(pastedText)
    if (clip && (clip.kind === 'file' || clip.kind === 'image') && clip.content &&
        (markHit || (!hasText && !pastedText))) {
      e.preventDefault()
      await sendClipboardFile()
    }
  })

  el('filePicker').onchange = async e => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (file) await sendImage(file)
  }
  /* 📎 文件发送：任意大小（>1.5MB 自动分块），文件传输助手房间 10 天后自动清理 */
  el('btnFile').onclick = () => {
    /* 微信式：可选单个/多个文件，也可整个文件夹（自动打包 zip，保留目录结构） */
    const menu = document.createElement('div')
    menu.className = 'msg-menu'
    menu.style.position = 'fixed'
    menu.innerHTML = '<div class="mm-item" data-m="file">📄 发送文件（可多选）</div>' +
      '<div class="mm-item" data-m="folder">📁 发送文件夹（自动打包 zip）</div>'
    document.body.appendChild(menu)
    const r = el('btnFile').getBoundingClientRect()
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px'
    menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px'
    setTimeout(() => {
      const close = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close, true) } }
      document.addEventListener('click', close, true)
    }, 0)
    menu.onclick = async e => {
      const m = e.target.closest('.mm-item')
      if (!m) return
      const mode = m.dataset.m
      menu.remove()
      if (!S.activeRoom) { toast('请先选择一个会话'); return }
      const input = document.createElement('input')
      input.type = 'file'
      if (mode === 'file') {
        input.multiple = true   /* 一次可多选 */
      } else {
        input.webkitdirectory = true
        input.multiple = true
      }
      input.onchange = async () => {
        const fs = [...(input.files || [])]
        if (!fs.length) return
        try {
          if (mode === 'file') {
            for (const f of fs) {
              if (f.size > 500 * 1024 * 1024) { toast('「' + f.name + '」超过 500MB，已跳过'); continue }
              toast('正在上传 ' + f.name + '…', 3000)
              const r2 = await Net.uploadLarge(f)
              await doSend('file', r2.url, f.name)
            }
            if (fs.length > 1) toast('已发送 ' + fs.length + ' 个文件', 2600)
          } else {
            /* 文件夹：打包成一个 zip（保留相对路径），对方解压即得完整结构 */
            const root = (fs[0].webkitRelativePath || '').split('/')[0] || '文件夹'
            let total = 0
            for (const f of fs) total += f.size
            if (total > 200 * 1024 * 1024) { toast('文件夹总大小超过 200MB，请压缩后再发'); return }
            toast('正在打包 ' + root + '（' + fs.length + ' 个文件）…', 4000)
            const zip = await zipFolder(fs)
            const file = new File([zip], root + '.zip', { type: 'application/zip' })
            toast('正在上传 ' + file.name + '…', 3000)
            const r3 = await Net.uploadLarge(file)
            await doSend('file', r3.url, file.name)
            toast('文件夹已发送：' + root + '（' + fs.length + ' 个文件）', 3200)
          }
        } catch (e) { toast('发送失败：' + (e.message || '未知错误'), 3000) }
      }
      input.click()
    }
  }

  /* ---------- 纯 JS 打包 zip（STORE 不压缩，足够快；UTF-8 文件名） ---------- */
  async function zipFolder(files) {
    const enc = new TextEncoder()
    const CRC_TABLE = (() => {
      const t = new Uint32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        t[n] = c >>> 0
      }
      return t
    })()
    const crc32 = data => {
      let c = 0xFFFFFFFF
      for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8)
      return (c ^ 0xFFFFFFFF) >>> 0
    }
    const d = new Date()
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF
    const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
    const u16 = v => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF])
    const u32 = v => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF])
    const parts = [], central = []
    let offset = 0
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/')
      const nameB = enc.encode(rel)
      const data = new Uint8Array(await f.arrayBuffer())
      const crc = crc32(data)
      const local = [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0), nameB]
      const localLen = local.reduce((s, x) => s + x.length, 0)
      parts.push(...local, data)
      central.push([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB])
      offset += localLen + data.length
    }
    const cdStart = offset
    let cdSize = 0
    for (const c of central) { const len = c.reduce((s, x) => s + x.length, 0); parts.push(...c); cdSize += len; offset += len }
    parts.push(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(cdStart), u16(0))
    let total = 0
    for (const p of parts) total += p.length
    const out = new Uint8Array(total)
    let pos = 0
    for (const p of parts) { out.set(p, pos); pos += p.length }
    return out
  }

  /* 拖拽文件到聊天区发送：图片走图片通道，其它文件走分块上传 */
  const chatPane = document.querySelector('.pane-chat')
  if (chatPane) {
    chatPane.addEventListener('dragover', e => { e.preventDefault(); chatPane.classList.add('drag-over') })
    chatPane.addEventListener('dragleave', () => chatPane.classList.remove('drag-over'))
    chatPane.addEventListener('drop', async e => {
      e.preventDefault()
      chatPane.classList.remove('drag-over')
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (!f) return
      if (!S.activeRoom) { toast('请先选择一个会话'); return }
      if (/^image\//.test(f.type)) { sendImage(f); return }
      if (f.size > 500 * 1024 * 1024) { toast('文件最大 500MB，请压缩后再试'); return }
      try {
        toast('正在上传 ' + f.name + '…', 3000)
        const r = await Net.uploadLarge(f)
        await doSend('file', r.url, f.name)
        toast('已发送。' + (r.expiresAt ? '文件保存至 ' + new Date(r.expiresAt).toLocaleDateString() + '（10 天后自动清理）' : ''), 4200)
      } catch (e2) { toast(e2.message || '上传失败') }
    })
  }
  /* ---------- 语音消息：微信式交互 ----------
   * 点左侧 🎙 切换为「按住 说话」大按钮；长按开始录音、松开自动发送；最长 60 秒自动发送。
   * 再点 ⌨️ 切回键盘。AI 模式下保持原「点击开始/再次点击发送」。 */
  el('btnVoice').onclick = () => {
    const composer = el('composer')
    if (composer.classList.contains('ai-mode')) { toggleVoiceRecord(); return }
    const toVoice = composer.classList.toggle('voice-mode')
    el('holdTalk').hidden = !toVoice
    el('msgInput').hidden = toVoice
    el('btnVoice').textContent = toVoice ? '⌨️' : '🎙️'
    if (!toVoice && mediaRec && mediaRec.state === 'recording') mediaRec.stop()
    if (toVoice) toast('按住说话，松开发送（最长 60 秒）', 2200)
  }
  ;(() => {
    const hold = el('holdTalk')
    if (!hold) return
    let holding = false
    let starting = false   /* 麦克风授权/初始化进行中（异步窗口期） */
    const startHold = e => {
      if (e.cancelable) e.preventDefault()
      if (holding || starting || (mediaRec && mediaRec.state === 'recording')) return
      if (!S.activeRoom) { toast('请先选择一个会话'); return }
      holding = true
      hold.classList.add('is-rec')
      hold.textContent = '松开 手指 发送'
      starting = true
      Promise.resolve(toggleVoiceRecord()).then(() => {
        starting = false
        /* 麦克风就绪前就已松手：立即停止，避免录音失控 */
        if (!holding && mediaRec && mediaRec.state === 'recording') mediaRec.stop()
      })
    }
    const endHold = () => {
      if (!holding) return
      holding = false
      hold.classList.remove('is-rec')
      hold.textContent = '按 住 说 话'
      /* starting 期间的松手由 startHold 的 then 兜底，这里只处理正常路径 */
      if (!starting && mediaRec && mediaRec.state === 'recording') mediaRec.stop()
    }
    hold.addEventListener('touchstart', startHold, { passive: false })
    hold.addEventListener('touchend', endHold)
    hold.addEventListener('touchcancel', endHold)
    /* 手指滑出按钮区域也能正常结束（微信行为） */
    document.addEventListener('touchend', e => { if (holding && !hold.contains(e.target)) endHold() })
    hold.addEventListener('mousedown', startHold)
    hold.addEventListener('mouseup', endHold)
    hold.addEventListener('mouseleave', e => { if (holding && !e.buttons) endHold() })
    hold.addEventListener('contextmenu', e => e.preventDefault())
  })()

  /* ---------- 微信式「＋ 更多」面板：移动端从底部弹出（微信/QQ 式），桌面端原位显示 ---------- */
  window.toggleMoreGrid = toggleMoreGrid
  const MOBILE_SHEET_Q = '(max-width: 820px), (max-width: 1024px) and (orientation: portrait)'
  function onMobileSheet() { return !!(window.matchMedia && matchMedia(MOBILE_SHEET_Q).matches) }
  function toggleMoreGrid(force) {
    const g = el('moreGrid'), m = el('moreMask')
    if (!g) return
    const willShow = typeof force === 'boolean' ? force : !!g.hidden
    if (willShow) {
      g.hidden = false
      if (m && onMobileSheet()) m.hidden = false
      /* 双 rAF 确保先完成布局再过渡，滑出动画才生效 */
      requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add('is-open')))
    } else {
      g.classList.remove('is-open')
      if (m) m.hidden = true
      setTimeout(() => { g.hidden = true }, 240)
    }
  }
  {
    const g = el('moreGrid'), m = el('moreMask')
    if (m) m.addEventListener('click', () => toggleMoreGrid(false))
    if (g) {
      document.addEventListener('click', ev => {
        if (!g.hidden && !ev.target.closest('#moreGrid') && !ev.target.closest('#btnPlus')) toggleMoreGrid(false)
      })
      /* 点任意功能项后自动收起面板 */
      g.addEventListener('click', ev => { if (ev.target.closest('.more-item')) setTimeout(() => toggleMoreGrid(false), 150) })
    }
    const cam = el('camPicker')
    if (cam) {
      el('btnCamera').onclick = () => cam.click()
      cam.onchange = async e => {
        const f = e.target.files && e.target.files[0]
        e.target.value = ''
        if (f) await sendImage(f)
      }
    }
    const vid = el('videoPicker')
    if (vid) {
      el('btnVideo').onclick = () => vid.click()
      vid.onchange = async e => {
        const f = e.target.files && e.target.files[0]
        e.target.value = ''
        if (!f) return
        if (!S.activeRoom) { toast('请先选择一个会话'); return }
        if (f.size > 500 * 1024 * 1024) { toast('视频最大 500MB'); return }
        toast('正在上传视频…', 3000)
        try {
          const r = await Net.uploadLarge(f)
          await doSend('file', r.url, f.name)
        } catch (err) { toast(err.message || '视频上传失败') }
      }
    }
    const sc = el('btnScanChat')
    if (sc) sc.onclick = () => openScanModal('camera')
  }

  el('btnLocation').onclick = () => openLocationPicker()

  el('btnChatMore').onclick = () => {
    if (!S.activeRoom) return toast('请先选择一个会话')
    const c = S.conversations.find(x => x.roomId === S.activeRoom)
    if (!c) return
    openConvSettings(c)
  }

  /* 会话列表右键菜单：置顶 / 复制KB号 / 免打扰（手机长按同样触发） */
  el('chatList').addEventListener('contextmenu', e => {
    const item = e.target.closest('.conv')
    if (!item) return
    e.preventDefault()
    const c = S.conversations.find(x => x.roomId === item.dataset.room)
    if (c) openConvContextMenu(e.clientX, e.clientY, c)
  })
  let lpTimer = null
  el('chatList').addEventListener('touchstart', e => {
    const item = e.target.closest('.conv')
    if (!item) return
    lpTimer = setTimeout(() => {
      const c = S.conversations.find(x => x.roomId === item.dataset.room)
      const t = e.touches && e.touches[0]
      if (c && t) openConvContextMenu(t.clientX, t.clientY, c)
    }, 550)
  }, { passive: true })
  ;['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    el('chatList').addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null } }, { passive: true }))

  el('searchInput').addEventListener('input', e => {
    const kw = e.target.value.trim().toLowerCase()
    const list = S.conversations.filter(c =>
      !kw || (c.name || '').toLowerCase().includes(kw) ||
      (c.lastMsg && String(c.lastMsg.content || '').toLowerCase().includes(kw)))
    const box = el('chatList')
    if (!list.length) {
      box.innerHTML = '<div style="padding:30px;text-align:center;color:#b2b2b2;font-size:13px">没有匹配的会话</div>'
      return
    }
    box.innerHTML = list.map(convItemHtml).join('')
  })

  /* AI 新对话 / 历史对话 */
  const ncBtn = el('aiNewChat')
  if (ncBtn) ncBtn.onclick = aiNewChat
  const hBtn = el('aiHistory')
  if (hBtn) hBtn.onclick = aiOpenHistory

  /* ☰ 弹出组：悬停展开 + 点击切换，260ms 延迟关闭（鼠标在按钮与弹出层之间移动不掉） */
  ;(function () {
    const rm = el('railMore'), f = el('railFlyout'), btn = el('btnRailMore')
    if (!rm || !f || !btn) return
    /* 纯点击开关：悬停展开会和点击 toggle 打架（先 hover 弹出、再点击又收起），
     * 表现为「点了没反应」。现在只认点击：点 ☰ 切换，点别处收起 */
    btn.onclick = e => { e.stopPropagation(); f.classList.toggle('is-open') }
    document.addEventListener('click', e => { if (!rm.contains(e.target)) f.classList.remove('is-open') })
  })()

  el('msgScroll').addEventListener('scroll', () => {
    const sc = el('msgScroll')
    S.stickBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60
    updateJumpPill()
  })
  const jb = el('jumpBottom')
  if (jb) jb.onclick = () => { S.jumpNew = 0; scrollToBottom(); updateJumpPill() }

  /* 回到底部悬浮球：向上翻看历史时出现，显示新消息条数 */
  function updateJumpPill() {
    const jb = el('jumpBottom')
    if (!jb) return
    if (S.stickBottom) { jb.hidden = true; S.jumpNew = 0; jb.textContent = '回到底部 ↓ ' } else {
      jb.hidden = false
      const n = S.jumpNew || 0
      jb.innerHTML = n ? '<b>' + n + '</b> 条新消息 · 回到底部 ↓' : '回到底部 ↓'
    }
  }
  window.updateJumpPill = updateJumpPill

  /* ---------- 输入框右键菜单：剪切 / 复制 / 粘贴 / 另存为 / 全部选择（Chrome 风格，带禁用态） ---------- */
  const msgInputEl = el('msgInput')
  if (msgInputEl) {
    msgInputEl.addEventListener('contextmenu', e => {
      e.preventDefault()
      const old = document.getElementById('inputCtxMenu')
      if (old) old.remove()
      const hasSel = msgInputEl.selectionStart !== msgInputEl.selectionEnd
      const hasVal = msgInputEl.value.length > 0
      const item = (label, en, act) =>
        `<div class="ictx-item${en ? '' : ' is-dis'}" data-act="${act}" data-en="${en ? 1 : 0}">${label}</div>`
      const menu = document.createElement('div')
      menu.id = 'inputCtxMenu'
      menu.className = 'ictx-menu'
      menu.innerHTML =
        item('✂️ 剪切', hasSel, 'cut') +
        item('📄 复制', hasSel, 'copy') +
        item('📥 粘贴', true, 'paste') +
        item('💾 另存为…', hasSel || hasVal, 'save') +
        item('🔲 全部选择', hasVal, 'all')
      document.body.appendChild(menu)
      const r = menu.getBoundingClientRect()
      menu.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px'
      menu.style.top = Math.max(6, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px'
      /* 阻止菜单抢焦点：保留输入框里的选区 */
      menu.addEventListener('mousedown', ev => ev.preventDefault())
      menu.addEventListener('click', async ev => {
        const it = ev.target.closest('.ictx-item')
        if (!it || it.dataset.en !== '1') return
        const act = it.dataset.act
        menu.remove()
        msgInputEl.focus()
        if (act === 'cut' || act === 'copy') {
          try { document.execCommand(act) ; if (act === 'cut') updateSendBtn() } catch (err) { toast('操作失败') }
        } else if (act === 'paste') {
          try {
            const txt = await navigator.clipboard.readText()
            if (!txt) return
            const st = msgInputEl.selectionStart || 0, en2 = msgInputEl.selectionEnd || 0
            msgInputEl.value = msgInputEl.value.slice(0, st) + txt + msgInputEl.value.slice(en2)
            msgInputEl.selectionStart = msgInputEl.selectionEnd = st + txt.length
            updateSendBtn()
          } catch (err) { toast('浏览器未授权读取剪贴板，请按 Ctrl+V 粘贴', 2600) }
        } else if (act === 'save') {
          const st = msgInputEl.selectionStart || 0, en2 = msgInputEl.selectionEnd || 0
          const text = hasSel ? msgInputEl.value.slice(st, en2) : msgInputEl.value
          const a = document.createElement('a')
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
          a.download = '消息文本.txt'
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 3000)
        } else if (act === 'all') {
          msgInputEl.select()
        }
      })
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0)
      document.addEventListener('keydown', function esc(ev) {
        if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', esc) }
      })
    })
  }

  /* 图片消息点开大图（含下载 + 缩放） */
  el('msgStack').addEventListener('click', e => {
    const img = e.target.closest('img.media')
    if (!img || !img.src) return
    e.preventDefault()
    const old = document.getElementById('imgLightbox')
    if (old) old.remove()
    const layer = document.createElement('div')
    layer.id = 'imgLightbox'
    layer.className = 'lb-layer'
    layer.innerHTML = `<img src="${img.getAttribute('src')}" alt="">
      <div class="lb-bar">
        <button type="button" id="lbDownload">⬇️ 下载图片</button>
        <button type="button" id="lbClose">关闭</button>
      </div>`
    document.body.appendChild(layer)
    bindLbZoom(layer, layer.querySelector('img'))
    layer.onclick = ev => { if (ev.target === layer) layer.remove() }
    layer.querySelector('#lbClose').onclick = () => layer.remove()
    layer.querySelector('#lbDownload').onclick = () => {
      const src = img.getAttribute('src') || ''
      const nm = '图片_' + Date.now() + (src.includes('image/png') ? '.png' : '.jpg')
      if (/^data:/.test(src)) return downloadDataUri(src, nm)
      /* /uploads/ 图片也走 Blob 下载：失败时报明确原因（过期/网络/服务器），不再静默 */
      blobDownload(src, nm)
    }
  })

  /* 大图缩放：滚轮 / 双击 / 双指捏合缩放 + 拖动平移（兼容老 WebView，无新语法） */
  function bindLbZoom(layer, img) {
    let scale = 1, tx = 0, ty = 0
    const apply = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')' }
    const reset = () => { scale = 1; tx = 0; ty = 0; apply() }
    /* 平移钳制：放大后图片至少留 80px 在视口内，杜绝"甩出屏幕外" */
    function clampT() {
      if (scale <= 1) { tx = 0; ty = 0; return }
      const lr = layer.getBoundingClientRect()
      const cx = lr.left + lr.width / 2, cy = lr.top + lr.height / 2
      const w = img.offsetWidth * scale, h = img.offsetHeight * scale
      const m = 80
      tx = Math.min(Math.max(tx, lr.left + m - cx - w / 2), lr.right - m - cx + w / 2)
      ty = Math.min(Math.max(ty, lr.top + m - cy - h / 2), lr.bottom - m - cy + h / 2)
    }
    function zoomAt(dx, dy, factor) {
      const ns = Math.min(6, Math.max(1, scale * factor))
      const k = ns / scale
      tx = dx - (dx - tx) * k
      ty = dy - (dy - ty) * k
      scale = ns
      if (scale === 1) { tx = 0; ty = 0 }
      clampT()
      apply()
    }
    const centerOf = () => {
      const r = img.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const onImg = (x, y) => {
      const r = img.getBoundingClientRect()
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }
    /* 滚轮缩放：光标在图片上时以光标为锚点，否则以中心为锚点（防止图片被甩飞） */
    layer.addEventListener('wheel', ev => {
      ev.preventDefault()
      let dx = 0, dy = 0
      if (onImg(ev.clientX, ev.clientY)) {
        const c = centerOf()
        dx = ev.clientX - c.x; dy = ev.clientY - c.y
      }
      zoomAt(dx, dy, ev.deltaY < 0 ? 1.18 : 1 / 1.18)
    }, { passive: false })
    /* 双击：放大 ↔ 复原 */
    img.addEventListener('dblclick', ev => {
      ev.preventDefault()
      if (scale > 1.2) { reset(); return }
      const c = centerOf()
      zoomAt(ev.clientX - c.x, ev.clientY - c.y, 2.5 / scale)
    })
    /* 鼠标按住拖动平移 */
    let dragging = false, msx = 0, msy = 0, mtx = 0, mty = 0
    img.addEventListener('pointerdown', ev => {
      if (ev.pointerType !== 'mouse' || scale <= 1) return
      dragging = true; msx = ev.clientX; msy = ev.clientY; mtx = tx; mty = ty
      ev.preventDefault()
    })
    window.addEventListener('pointermove', ev => {
      if (!dragging) return
      tx = mtx + (ev.clientX - msx); ty = mty + (ev.clientY - msy)
      clampT(); apply()
    })
    window.addEventListener('pointerup', () => { dragging = false })
    /* 触屏：单指拖动 / 双指捏合 */
    let tMode = 0, baseD = 0, baseS = 1, baseX = 0, baseY = 0, midX = 0, midY = 0, dragX = 0, dragY = 0
    let moved = false
    layer.addEventListener('touchstart', ev => {
      if (ev.target.closest('.lb-bar')) return
      moved = false
      if (ev.touches.length === 1) {
        tMode = 1
        dragX = ev.touches[0].clientX; dragY = ev.touches[0].clientY
        baseX = tx; baseY = ty
      } else if (ev.touches.length >= 2) {
        tMode = 2
        const a = ev.touches[0], b = ev.touches[1]
        baseD = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
        midX = (a.clientX + b.clientX) / 2; midY = (a.clientY + b.clientY) / 2
        baseS = scale; baseX = tx; baseY = ty
      }
    }, { passive: true })
    layer.addEventListener('touchmove', ev => {
      if (!tMode || ev.target.closest('.lb-bar')) return
      moved = true
      ev.preventDefault()
      if (tMode === 1 && ev.touches.length === 1) {
        if (scale > 1) {
          tx = baseX + (ev.touches[0].clientX - dragX)
          ty = baseY + (ev.touches[0].clientY - dragY)
          apply()
        }
      } else if (ev.touches.length >= 2) {
        const a = ev.touches[0], b = ev.touches[1]
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2
        /* 先回到捏合起点，再应用「中点位移 + 距离比缩放」，双手动作一次到位 */
        scale = baseS; tx = baseX + (mx - midX); ty = baseY + (my - midY)
        const ns = Math.min(6, Math.max(1, baseS * d / baseD))
        const c = centerOf()
        zoomAt(mx - c.x, my - c.y, ns / scale)
      }
    }, { passive: false })
    layer.addEventListener('touchend', ev => {
      if (tMode === 2 && ev.touches.length === 1) {
        tMode = 1
        dragX = ev.touches[0].clientX; dragY = ev.touches[0].clientY
        baseX = tx; baseY = ty
      } else if (ev.touches.length === 0) {
        tMode = 0
        if (scale === 1) reset()
      }
    }, { passive: true })
    /* 捏合/拖动后抑制误触关闭（点背景才允许关） */
    layer.addEventListener('click', ev => {
      if (moved) { ev.stopImmediatePropagation(); ev.preventDefault(); moved = false }
    }, true)
  }

  /* data: URI → Blob → blob: URL 下载：Chrome 禁止从 data: URL 下载文件（HTML 必拦，
   * 报「无法下载」），先 fetch 成 Blob 再用 blob: URL 触发下载，全类型可靠 */
  async function downloadDataUri(dataUri, name) {
    try {
      const r = await fetch(dataUri)
      const b = await r.blob()
      const u = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = u
      a.download = name || '文件'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(u), 30000)
      toast('已开始下载', 1400)
    } catch (e) { toast('下载失败：' + (e && e.message || '未知错误')) }
  }

  /* 收起/展开会话列表（元宝式） */
  const stg = el('btnSideToggle')
  if (stg) stg.onclick = () => document.body.classList.add('side-collapsed')
  const sex = el('btnSideExpand')
  if (sex) sex.onclick = () => document.body.classList.remove('side-collapsed')

  /* AI 侧栏新对话 */
  const asn = el('aiSideNew')
  if (asn) asn.onclick = aiNewChat
  /* AI 侧栏左上角收起按钮（元宝式，收起后点聊天区 ← 展开） */
  const ast = el('aiSideToggle')
  if (ast) ast.onclick = () => document.body.classList.toggle('ai-side-collapsed')

  /* 引用块跳转：点引用 → 滚到原消息并高亮 */
  el('msgStack').addEventListener('click', e => {
    const rf = e.target.closest('.msg-ref')
    if (rf) { jumpToMessage(rf.dataset.rid); return }
    /* 发送失败的消息：点红色感叹号重发 */
    const st = e.target.closest('.msg-state.failed[data-resend]')
    if (st) { resendFailed(st.dataset.resend) }
  })
  /* 文件消息下载：一律走 fetch → Blob → blob: URL。
   * 直接点链接下载会被浏览器/网络层以各种理由拦（Chrome 报「无法下载-上网受阻」），
   * Blob 下载不经过那些拦截，最可靠；data: 与 /uploads/ 同源，fetch 无跨域问题 */
  el('msgStack').addEventListener('click', e => {
    const fl = e.target.closest('a.file-link')
    if (!fl) return
    e.preventDefault()
    const href = fl.getAttribute('href') || ''
    const name = fl.getAttribute('download') || '文件'
    if (/^data:/.test(href)) return downloadDataUri(href, name)
    blobDownload(href, name)
  })

  async function blobDownload(url, name) {
    /* 大文件给足 3 分钟；超时/网络断/过期都给出明确可读的原因 */
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null
    const to = ctrl ? setTimeout(() => { try { ctrl.abort() } catch (e) {} }, 180000) : null
    try {
      toast('正在下载 ' + (name || '文件') + ' …', 1600)
      const r = await fetch(url, Object.assign({ cache: 'no-store' }, ctrl ? { signal: ctrl.signal } : {}))
      if (!r.ok) {
        if (r.status === 404 || r.status === 410) throw new Error('文件已过期或已被清理（聊天文件保存 10 天）')
        if (r.status >= 500) throw new Error('服务器繁忙（' + r.status + '），请稍后再试')
        throw new Error('下载失败（HTTP ' + r.status + '）')
      }
      const b = await r.blob()
      if (!b.size) throw new Error('下载内容为空，请重试')
      const u = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = u
      a.download = name || '文件'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(u), 60000)
      toast('下载完成：' + (name || '文件'), 2200)
    } catch (err) {
      const msg = (err && err.name === 'AbortError')
        ? '下载超时（3 分钟），请检查网络后重试'
        : '下载失败：' + (err && err.message || '未知错误')
      toast(msg, 4000)
    } finally { if (to) clearTimeout(to) }
  }

  el('btnCloseAdd').onclick = closeModal
  el('btnDoSearch').onclick = doSearchUser
  el('searchUid').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSearchUser() }
  })
  el('btnCloseGroup').onclick = closeModal
  el('btnDoCreateGroup').onclick = doCreateGroup
  el('btnCloseCard').onclick = closeModal
  el('btnLogout2').onclick = logout
  /* 资料弹窗底部也放一个注销入口 */
  el('btnCloseAccount2').onclick = () => { closeModal(); openCloseAccount() }
  /* 密保问答已移到独立弹窗（openSecQuizSetup），资料弹窗不再有 secQ/secA 输入框 */
  /* 点遮罩：关闭当前弹窗（协议/资料等强制弹窗除外，保持原行为） */
  el('modalMask').addEventListener('click', e => {
    if (e.target !== el('modalMask')) return
    if (!el('modalProfile').hidden && S.uid) { closeModal(); return }
    const vis = Array.from(document.querySelectorAll('.modal')).some(m => !m.hidden)
    if (vis && el('modalAgreement').hidden) closeModal()
  })
  /* ESC 关闭弹窗（强制弹窗除外） */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    try {
      if (!el('modalAgreement').hidden || !el('modalProfile').hidden) return
      const vis = Array.from(document.querySelectorAll('.modal')).some(m => !m.hidden)
      if (vis) closeModal()
    } catch (err) {}
  })
  /* 遮罩自愈：遮罩显示却没有任何可见弹窗 = 看不见的全屏拦截层（曾导致
     侧栏「更多」等所有点击无反应），每秒体检一次自动收起 */
  setInterval(() => {
    try {
      const mask = el('modalMask')
      if (!mask || mask.hidden) return
      const anyModal = Array.from(document.querySelectorAll('.modal')).some(m => !m.hidden)
      if (!anyModal) mask.hidden = true
    } catch (err) {}
  }, 1000)

  window.addEventListener('resize', () => { if (S.activeRoom) enterChat(S.activeRoom) })
  window.addEventListener('focus', syncConversations)
}

function updateSendBtn() {
  el('btnSend').classList.toggle('can', el('msgInput').value.trim().length > 0)
}

function bindAddHub() {
  el('btnHubReqs').onclick = () => { closeModal(); openReqsModal() }
}

function openAddModal() {
  el('searchUid').value = ''
  bindAddHub()
  el('searchResult').innerHTML = '<p class="muted">输入对方的KB号或昵称后点击搜索</p>'
  openModal('modalAdd')
}

function openCard(f) {
  el('cardAvatar').innerHTML = avatarHtml(f.avatar)
  el('cardName').textContent = f.name || '未命名'
  const gTxt = f.gender === 'male' ? '👦 男生' : f.gender === 'female' ? '👧 女生' : '🔒 隐私'
  el('cardWxid').textContent = 'KB号：' + (f.wxid || '') + ' · ' + gTxt + ' · Lv.' + (f.level || 1)
  el('cardSign').textContent = f.signature || '这个人很懒，什么都没写'
  el('btnCardSend').onclick = () => {
    closeModal()
    openDirect(f.uid, f.name, f.avatar)
  }
  openModal('modalCard')
}

/* ---------- 登录卡片自适应（已废弃缩放方案）----------
   旧方案：窗口矮时 transform:scale + 宽度补偿 → 文字发虚、布局宽超盒宽产生横向滚动条
   新方案：.login-box 自身 max-height:100% + overflow-y:auto，矮屏直接滚动，无需缩放 */
function fitLoginCard() {
  try {
    const box = el('loginBox')
    if (!box) return
    const card = box.querySelector('.login-card')
    /* 清掉历史版本可能残留的缩放内联样式 */
    if (card) { card.style.transform = ''; card.style.width = '' }
    box.style.height = ''
  } catch (e) { /* 忽略 */ }
}
window.addEventListener('resize', fitLoginCard)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.uid) { Net.ping().catch(() => {}) }
})

/* ---------- 入口 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  /* 每步独立兜底：绑定失败不能挡住 boot()，boot 失败不能挡住登录页 */
  try { bindLogin() } catch (e) { __kbErr('bindLogin', e) }
  try { bindMain() } catch (e) { __kbErr('bindMain', e) }
  try { updateSendBtn() } catch (e) { __kbErr('updateSendBtn', e) }
  try { fitLoginCard() } catch (e) { __kbErr('fitLoginCard', e) }
  try { boot() } catch (e) { __kbErr('boot', e); try { showLogin() } catch (e2) {} }
  // 新用户引导：自动建议一个KB号（kbid_ 前缀，与历史 wxid_ 区分）
  try {
    Net.suggestWxid().then(w => { if (!el('wxidLogin').value) el('wxidLogin').placeholder = '例如：' + w }).catch(() => {})
  } catch (e) {}
})
