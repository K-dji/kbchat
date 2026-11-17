/* ===========================================================
 * ui.js —— 界面渲染
 * =========================================================== */

function el(id) { return document.getElementById(id) }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
function isImg(avatar) { return !!avatar && /^(https?:|data:|\/)/.test(avatar) }

function avatarHtml(avatar) {
  if (isImg(avatar)) return `<img src="${esc(avatar)}" alt="" onerror="this.onerror=null;this.replaceWith(document.createTextNode('😊'))">`
  return esc(avatar || '😊')
}

function pad(n) { return n < 10 ? '0' + n : '' + n }

function fmtTime(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (now - d < 7 * 864e5) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function fmtShort(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtFull(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const now = new Date()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  if (now - d < 2 * 864e5) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

let toastTimer = null
function toast(msg, ms) {
  const t = el('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, ms || 2200)
}

/* ---------- 弹窗 ---------- */
/* 不依赖写死名单：按 .modal 类统一控制显示隐藏，新增弹窗自动生效 */
function openModal(id) {
  el('modalMask').hidden = false
  document.querySelectorAll('.modal').forEach(m => { m.hidden = m.id !== id })
}
function closeModal() {
  el('modalMask').hidden = true
  document.querySelectorAll('.modal').forEach(m => { m.hidden = true })
}

/* ---------- 左栏 ---------- */
function renderRail() {
  const p = S.profile
  const av = el('railAvatar')
  if (isImg(p && p.avatar)) {
    av.innerHTML = `<img src="${esc(p.avatar)}" style="width:36px;height:36px;border-radius:5px;object-fit:cover">`
  } else {
    av.textContent = (p && p.avatar) || '😊'
  }
  el('railDot').hidden = totalUnread() === 0
  /* 移动端底部「聊天」tab 未读红泡 */
  const mb = document.getElementById('mtabBadge')
  if (mb) {
    const n = totalUnread()
    mb.hidden = n === 0
    mb.textContent = n > 99 ? '99+' : n
  }
}

/* ---------- 个人会话偏好（个人置顶 / 免打扰，存本机 localStorage） ---------- */
function convPrefs() {
  try { return JSON.parse(localStorage.getItem('kbchat_convprefs_' + (S.uid || 'guest')) || '{}') } catch (e) { return {} }
}
function convPref(roomId) { return convPrefs()[roomId] || {} }
function setConvPref(roomId, patch) {
  try {
    const all = convPrefs()
    all[roomId] = Object.assign({}, all[roomId] || {}, patch)
    localStorage.setItem('kbchat_convprefs_' + (S.uid || 'guest'), JSON.stringify(all))
  } catch (e) {}
}

function totalUnread() {
  return (S.conversations || []).reduce((a, c) => a + (c.unread || 0), 0)
}

/* ---------- 会话列表 ---------- */
function convItemHtml(c) {
  const unread = c.unread || 0
  const pref = convPref(c.roomId)
  const quiet = !!pref.quiet
  const myPin = !!pref.pinned
  let preview = ''
  if (c.lastMsg) {
    preview = localStorage.getItem('kbchat_nopreview') === '1'
      ? (unread ? '有新消息' : '')
      : previewText(c.lastMsg)
    if (c.kind === 'group' && c.lastMsg.senderName && preview) preview = c.lastMsg.senderName + '：' + preview
  }
  /* 单聊在名字旁显示在线状态点（绿=在线 红=离线）+ 等级徽标
   * 头像/名字优先取好友实时资料：对方换头像后列表立即同步（与聊天区消息头像同源） */
  const fr = c.kind === 'dm' ? (S.friends || []).find(x => x.uid === c.peerUid) : null
  const av = (fr && fr.avatar) || c.avatar
  const nm = (fr && fr.name) || c.name
  const dot = c.kind === 'dm'
    ? (c.online ? '<span class="dot g"></span>' : '<span class="dot r"></span>')
    : ''
  const lv = fr ? `<span class="lv-badge">Lv.${fr.level || 1}</span>` : ''
  return `<div class="conv ${S.activeRoom === c.roomId ? 'is-on' : ''}" data-room="${esc(c.roomId)}">
    <div class="conv-av">${avatarHtml(av)}</div>
    ${unread ? `<span class="badge${quiet ? ' is-quiet' : ''}">${unread > 99 ? '99+' : unread}</span>` : ''}
    <div class="conv-body">
      <div class="conv-row">
        <span class="conv-name">${(c.pinned || myPin) ? '<span class="pin-mark">置顶</span>' : ''}${quiet ? '<span class="quiet-mark" title="消息免打扰">🔕</span>' : ''}${esc(nm)}${dot}${lv}</span>
        <span class="conv-time">${esc(fmtTime(c.ts))}</span>
      </div>
      <div class="conv-msg">${esc(preview)}</div>
    </div>
  </div>`
}

function renderChatList() {
  if (typeof ensureAiConversation === 'function') { try { ensureAiConversation() } catch (e) {} }
  const box = el('chatList')
  /* 排序：个人置顶 > 管理员全员置顶 > 最近时间 */
  const list = S.conversations.slice().sort((a, b) =>
    ((convPref(b.roomId).pinned ? 1 : 0) - (convPref(a.roomId).pinned ? 1 : 0)) ||
    ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) ||
    (new Date(b.ts) - new Date(a.ts)))
  if (!list.length) {
    box.innerHTML = `<div style="padding:40px 20px;text-align:center;color:#b2b2b2;font-size:13px;line-height:1.8">
      暂无会话<br>点击右上角 ＋ 添加好友或发起群聊</div>`
    updateChatAnnBanner()
    return
  }
  box.innerHTML = list.map(convItemHtml).join('')
  updateChatAnnBanner()
}

/* 把纯文本里的链接变成可点击的蓝色链接（先转义再加标签，天然防注入） */
const LINK_TLDS = 'com|cn|net|org|io|me|app|dev|xyz|top|cc|tv|info|co|edu|gov|hk|tw|mo|jp|kr|uk|us|ru|de|fr|ai|so|site|online|shop|vip|ltd|link|cloud|work|live|fun|pro|biz'
const LINK_RE = new RegExp(
  '(https?:\\/\\/[^\\s<>"\']+)' +                       /* 带协议的链接 */
  '|(www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,})' + /* www. 开头 */
  '|((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:' + LINK_TLDS + ')(?::\\d+)?(?:\\/[^\\s<>"\']*)?)', /* 裸域名 */
  'gi'
)
function trimLink(u) {
  /* 句尾的中文标点和括号不算链接的一部分 */
  let s = u
  while (s.length && /[，。！？、；：）】」》"'.,!?;:)\]]$/.test(s)) s = s.slice(0, -1)
  return s
}
function linkify(text) {
  const src = String(text == null ? '' : text)
  if (!src) return ''
  let out = ''
  let last = 0
  LINK_RE.lastIndex = 0
  let m
  while ((m = LINK_RE.exec(src)) !== null) {
    const raw = m[0]
    const url = trimLink(raw)
    if (!url) continue
    const start = m.index
    out += esc(src.slice(last, start))
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url.replace(/^\/+/, '')
    out += `<a class="msg-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`
    /* 被裁掉的标点原样接回去 */
    out += esc(raw.slice(url.length))
    last = start + raw.length
  }
  out += esc(src.slice(last))
  return out
}

function previewText(m) {
  if (!m) return ''
  if (m.kind === 'image') return '[图片]'
  if (m.kind === 'file') return '[文件]'
  if (m.kind === 'voice') return '[语音]'
  if (m.kind === 'location') {
    const l = typeof parseLoc === 'function' ? parseLoc(m) : null
    return '[位置] ' + (l && (l.name || l.addr) ? (l.name || l.addr) : '')
  }
  return String(m.content || '').replace(/\s+/g, ' ')
}

/* ---------- 通讯录（微信风格：彩色功能行 + 拼音字母分组 + 右侧索引条） ---------- */
/* 拼音首字母：边界字二分（覆盖 GB2312 常用字），非汉字取首字符 */
const PINYIN_BOUNDS = '阿八嚓搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
function pinyinInitial(ch) {
  const c = String(ch || '').trim().charAt(0)
  if (!c) return '#'
  if (/[a-zA-Z]/.test(c)) return c.toUpperCase()
  if (/[0-9]/.test(c)) return '#'
  let letter = '#'
  for (let i = 0; i < PINYIN_BOUNDS.length; i++) {
    if (c.localeCompare(PINYIN_BOUNDS[i], 'zh') >= 0) letter = PINYIN_LETTERS[i]
  }
  return letter
}
function renderContacts() {
  const box = el('contactList')
  const friends = S.friends.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'))
  const groups = S.groups.slice()
  const parts = []
  const reqBadge = S.reqCount > 0 ? `<span class="req-badge">${S.reqCount}</span>` : ''
  /* 微信风格彩色功能行 */
  const fn = (act, ico, bg, label, badge) =>
    `<div class="contact ct-fn" data-act="${act}"><div class="ct-fn-ico" style="background:${bg}">${ico}</div>
     <div class="contact-name">${label}${badge || ''}</div></div>`
  parts.push(fn('reqs', '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="10" cy="8" r="4" fill="#fff"/><path d="M3 19c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5v1H3z" fill="#fff"/><path d="M18.5 7.5v5M16 10h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>', '#fa9d3b', '新的朋友', reqBadge))
  parts.push(fn('add', '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="#fff" stroke-width="2.2"/><path d="M15 15l5.5 5.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>', '#1989fa', '添加朋友'))
  parts.push(fn('newgroup', '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="5" width="15" height="11" rx="2.5" fill="#fff"/><path d="M8 19l3-3 3 3z" fill="#fff"/><circle cx="8" cy="10.5" r="1.4" fill="#07c160"/><circle cx="13" cy="10.5" r="1.4" fill="#07c160"/></svg>', '#07c160', '发起群聊'))
  parts.push('<div class="ct-gap"></div>')
  /* 群聊（灰底小节头 + 群行） */
  parts.push(`<div class="ct-sec-head">群聊 (${groups.length})</div>`)
  if (!groups.length) parts.push(`<div class="contact ct-empty">还没有群聊</div>`)
  groups.forEach(g => {
    parts.push(`<div class="contact" data-group="${esc(g.roomId)}">
      <div class="contact-av ct-sq">👥</div><div class="contact-name">${esc(g.name)}</div>
      <span class="contact-tag">${(g.members || []).length}人</span></div>`)
  })
  parts.push('<div class="ct-gap"></div>')
  /* 好友按拼音首字母分组 */
  const byLetter = {}
  friends.forEach(f => {
    const L = pinyinInitial(f.name)
    ;(byLetter[L] = byLetter[L] || []).push(f)
  })
  const letters = Object.keys(byLetter).sort((a, b) => {
    if (a === '#') return 1
    if (b === '#') return -1
    return a.localeCompare(b)
  })
  letters.forEach(L => {
    parts.push(`<div class="ct-sec-head" id="ctL_${L}">${L}</div>`)
    byLetter[L].forEach(f => {
      const dot = f.online ? '<span class="online-dot"></span>' : ''
      const cmo = f.isAdmin ? `<span class="tag tag-cmo">${esc(f.role || 'CMO')}</span>` : ''
      parts.push(`<div class="contact" data-uid="${esc(f.uid)}">
        <div class="contact-av ct-sq">${avatarHtml(f.avatar)}</div>
        <div class="contact-name">${esc(f.name || '未命名')}${dot}${cmo}</div>
        <span class="contact-tag">${esc(f.wxid || '')}</span></div>`)
    })
  })
  if (!friends.length) parts.push(`<div class="contact ct-empty">还没有好友，去「添加朋友」吧</div>`)
  box.innerHTML = parts.join('')
  /* 右侧字母索引条（微信风，sticky 垂直居中，放首位避免随内容滚走） */
  if (letters.length >= 2) {
    const idx = document.createElement('div')
    idx.className = 'ct-index'
    idx.innerHTML = letters.map(L => `<span data-letter="${L}">${L}</span>`).join('')
    idx.onclick = e => {
      const s = e.target.closest('[data-letter]')
      if (!s) return
      e.stopPropagation()
      const head = box.querySelector('#ctL_' + s.dataset.letter)
      if (head) { try { head.scrollIntoView({ block: 'start' }) } catch (e) {} }
    }
    box.insertBefore(idx, box.firstChild)
  }
}

/* ---------- 收藏 / 文件 ---------- */
function renderMisc(kind) {
  const box = el('miscList')
  if (kind === 'favorites') {
    const favs = S.messages.filter(m => m.roomId === S.activeRoom && m.kind !== 'text')
    box.innerHTML = `<div class="contact-sec">收藏 (${favs.length})</div>` +
      (favs.length ? favs.map(m => `<div class="contact"><div class="contact-av">${m.kind === 'image' ? '🖼️' : '📎'}</div>
        <div class="contact-name">${m.kind === 'image' ? '图片' : esc(String(m.content || '').slice(0, 30))}</div></div>`).join('')
        : `<div class="contact" style="color:#b2b2b2;font-size:12px">聊天中的图片会出现在这里</div>`)
  } else {
    const files = S.messages.filter(m => m.kind === 'image' || m.kind === 'file')
    box.innerHTML = `<div class="contact-sec">文件 (${files.length})</div>` +
      (files.length ? files.slice().reverse().slice(0, 30).map(m =>
        `<div class="contact"><div class="contact-av">${m.kind === 'image' ? '🖼️' : '📎'}</div>
        <div class="contact-name">${esc(fmtFull(m.createdAt))}</div></div>`).join('')
        : `<div class="contact" style="color:#b2b2b2;font-size:12px">还没有图片或文件</div>`)
  }
}

/* ---------- 聊天区 ---------- */
function renderChatHeader() {
  const c = S.conversations.find(x => x.roomId === S.activeRoom)
  const st = el('chatStatus')
  if (!c) { el('chatTitle').textContent = '靠北 Chat'; st.textContent = ''; return }
  el('chatTitle').textContent = c.name + (c.kind === 'group' ? ` (${(c.members || []).length})` : '')
  /* 单聊显示在线/离线（presence 已改为心跳纠偏，状态准确）；群聊显示成员数 */
  if (c.kind === 'ai') { st.textContent = ''; st.className = 'chat-status'; return }
  if (c.kind === 'group') {
    const names = (c.memberNames || []).join('、')
    st.textContent = names ? names.slice(0, 24) : ''
    st.className = 'chat-status'
  } else {
    st.innerHTML = c.online
      ? '<span class="dot g"></span>在线'
      : '<span class="dot r"></span>离线'
    st.className = 'chat-status' + (c.online ? ' is-online' : '')
  }
}

/* ---------- 用户协议 ---------- */
function renderAgreement() {
  const box = el('agreementBody')
  if (!box) return
  box.innerHTML = PROTOCOL_TEXT.map(sec => {
    const [title, ...lines] = sec
    const head = title
      ? `<div class="ag-title">${esc(title)}</div>`
      : `<div class="ag-chapter">${esc(lines[0])}</div>`
    const body = title ? lines : lines.slice(1)
    return head + body.map(t => `<p class="ag-p">${esc(t)}</p>`).join('')
  }).join('')
}

function openAgreement(onAgree, onReject) {
  renderAgreement()
  el('agreeCheck').checked = false
  el('agreeErr').textContent = ''
  el('btnAgreeYes').onclick = async () => {
    if (!el('agreeCheck').checked) {
      el('agreeErr').textContent = '请先勾选「我已阅读并同意」'
      return
    }
    const btn = el('btnAgreeYes')
    btn.disabled = true
    try {
      await Net.agreeProtocol(PROTOCOL_VERSION)
      closeModal()
      if (onAgree) onAgree()
    } catch (e) {
      el('agreeErr').textContent = e.message || '提交失败，请重试'
    } finally { btn.disabled = false }
  }
  el('btnAgreeNo').onclick = () => {
    closeModal()
    /* 注册流程里「不同意」= 注册失败，账号作废；老用户只是放弃本次登录 */
    if (onReject) { onReject(); return }
    Net.logout()
    location.reload()
  }
  openModal('modalAgreement')
}

/* 仅自己不可见：本地隐藏的消息 id（按账号分键；服务端 /api/messages/hide 为跨设备权威） */
function hiddenKey() {
  return 'kbchat_hidden_' + ((window.S && S.uid) || 'anon')
}
function hiddenMsgIds() {
  try { return new Set(JSON.parse(localStorage.getItem(hiddenKey()) || '[]')) } catch (e) { return new Set() }
}
function hideMsgLocal(id) {
  try {
    const set = hiddenMsgIds()
    set.add(id)
    localStorage.setItem(hiddenKey(), JSON.stringify([...set].slice(-2000)))
  } catch (e) {}
}

/* 用户等级徽标：实时查好友/自己的 level（CMO 恒 Lv.80），找不到不显示 */
function lvBadgeOf(uid) {
  if (!uid) return ''
  let lv = null
  if (uid === (S.profile && S.profile.uid)) lv = S.profile.isAdmin ? 80 : (S.profile.level || 1)
  else {
    const f = (S.friends || []).find(x => x.uid === uid)
    if (f) lv = f.level || 1
  }
  return lv ? ` <span class="lv-badge">Lv.${lv}</span>` : ''
}

function renderMessages() {
  const stack = el('msgStack')
  const sc0 = el('msgScroll')
  /* 重建前记录滚动状态：贴底=到底，翻看中=保持原视口位置 */
  const prevTop = sc0.scrollTop
  const prevH = sc0.scrollHeight
  const hidden = hiddenMsgIds()
  /* 双保险：只渲染属于当前会话的消息（防异步竞态串会话） */
  const msgs = S.messages.filter(m => !hidden.has(m.id) && m.roomId === S.activeRoom)
  if (!msgs.length) {
    /* 空会话文案：文件传输助手用引导语，其他会话保持原样 */
    const emptyTip = S.activeRoom === 'file_' + S.uid ? '暂无消息，发送第一条消息开始聊天吧 ✨' : '还没有消息，打个招呼吧 👋'
    stack.innerHTML = `<div class="msg-sys">${emptyTip}</div>`
    return
  }
  const multi = S.multiSelect && S.multiSelect.on
  let html = ''
  let lastTs = 0
  msgs.forEach(m => {
    const ts = new Date(m.createdAt).getTime()
    if (!lastTs || ts - lastTs > 5 * 60 * 1000) {
      html += `<div class="msg-time">${esc(fmtFull(m.createdAt))}</div>`
    }
    lastTs = ts
    /* 系统公告：居中灰色提示，不占气泡 */
    if (m.kind === 'system') {
      html += `<div class="msg-sys">${esc(m.content || '')}</div>`
      return
    }
    /* 撤回的消息：灰色系统提示 */
    if (m.kind === 'recalled') {
      const who = m.ownerId === S.uid ? '你' : esc(m.senderName || '对方')
      html += `<div class="msg-sys">${who}撤回了一条消息</div>`
      return
    }
    const checked = multi && S.multiSelect.ids.includes(m.id)
    const pick = multi ? `<label class="msg-pick"><input type="checkbox" data-mid="${esc(m.id)}"${checked ? ' checked' : ''}></label>` : ''
    const self = m.ownerId === S.uid
    /* 头像取「当前头像」：优先实时查好友/资料，历史消息存的旧头像仅兜底
     * （避免对方换了头像后，历史消息还显示旧图标） */
    let av
    if (self) {
      av = S.profile && S.profile.avatar
    } else if (m.ownerId === 'ai') {
      av = typeof AI_AVATAR !== 'undefined' ? AI_AVATAR : '🤖'
    } else {
      const fr = (S.friends || []).find(x => x.uid === m.ownerId)
      const me2 = (S.profile && m.ownerId === S.profile.uid) ? S.profile : null
      av = (fr && fr.avatar) || (me2 && me2.avatar) || m.senderAvatar || '😊'
    }
    const showSender = !self && S.activeKind === 'group'
    let body = ''
    if (m.typing) {
      /* AI 思考中：流光文字 + 跳动三点（元宝/DeepSeek 风格） */
      body = '<div class="ai-think"><span class="ai-think-label">' + esc(m.senderName || '小靠AI') + ' 思考中</span><span class="ai-dots"><i></i><i></i><i></i></span></div>'
    } else if (m.kind === 'voice') {
      /* 语音气泡：点击播放/暂停，显示时长 */
      const d = Number(m.dur) || 1
      body = '<div class="voice-msg" data-src="' + esc(m.content) + '" onclick="playVoice(this)">' +
        '<span class="voice-play">▶</span>' +
        '<span class="voice-wave"><i></i><i></i><i></i><i></i><i></i><i></i></span>' +
        '<span class="voice-dur">' + d + '″</span></div>'
    } else if (m.kind === 'image') {
      body = `<img class="media" src="${esc(m.content)}" alt="图片" onerror="this.outerHTML='&lt;span style=&quot;color:#999&quot;&gt;[图片已失效]&lt;/span&gt;'">`
    } else if (m.kind === 'file') {
      const fname = m.fileName || '文件'
      body = `<a class="file-link" href="${esc(m.content)}" download="${esc(fname)}" target="_blank" rel="noopener">📎 <span class="file-name">${esc(fname)}</span>（点击下载）</a>`
    } else if (m.kind === 'location') {
      const loc = typeof parseLoc === 'function' ? parseLoc(m) : null
      body = loc
        ? `<div class="msg-loc" data-locid="${esc(m.id)}">
             <div class="loc-top"><span class="loc-pin">📍</span>
               <div><div class="loc-name">${esc(loc.name || '位置')}</div>
                 <div class="loc-addr">${esc(loc.addr || (loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5)))}</div></div>
             </div>
             <div class="loc-open">查看地图 / 导航 ›</div>
           </div>`
        : `<span class="muted">[位置信息已失效]</span>`
    } else {
      /* 文本消息里的链接自动变蓝并可点击 */
      body = linkify(m.content)
    }
    const trans = S.translations && S.translations[m.id]
      ? `<div class="msg-trans">译：${esc(S.translations[m.id])}</div>` : ''
    /* 引用块：显示被引用的消息摘要，点击跳到原消息 */
    const refHtml = m.ref
      ? `<div class="msg-ref" data-rid="${esc(m.ref.id)}"><b>${esc(m.ref.name || '消息')}</b>：${esc(m.ref.text || '')}</div>`
      : ''
    const avUid = self ? ((S.profile && S.profile.uid) || '') : (m.ownerId || '')
    html += `<div class="msg ${self ? 'is-self' : ''}${multi ? ' is-multi' : ''}" data-mid="${esc(m.id)}">${pick}
      <div class="msg-av${avUid ? ' av-link' : ''}"${avUid ? ` data-uid="${esc(avUid)}"` : ''}>${avatarHtml(av)}</div>
      <div class="msg-main">
        ${showSender ? `<div class="msg-sender">${esc(m.senderName || '成员')}${lvBadgeOf(m.ownerId)}</div>` : ''}
        <div class="bubble">${refHtml}${body}</div>
        ${trans}
      </div>
    </div>`
  })
  stack.innerHTML = html
  const sc = el('msgScroll')
  /* 滚动稳定：贴底时到底；向上翻看时保持原视口位置（抵消重建导致的高度差），消除上下跳动 */
  if (S.stickBottom) sc.scrollTop = sc.scrollHeight
  else sc.scrollTop = sc.scrollHeight - prevH + prevTop
}

function scrollToBottom() {
  const sc = el('msgScroll')
  sc.scrollTop = sc.scrollHeight
  S.stickBottom = true
}

/* ---------- 视图切换 ---------- */
/* 移动端判定：手机/平板竖屏走移动布局；平板横屏与电脑走桌面布局 */
function isMobile() {
  return window.matchMedia('(max-width: 820px), (max-width: 1024px) and (orientation: portrait)').matches
}

/* 聊天列表顶部公告横幅（移动端）：显示最新公告标题，点击进入公告栏 */
function updateChatAnnBanner() {
  const banner = document.getElementById('chatAnnBanner')
  if (!banner) return
  if (!isMobile()) { banner.hidden = true; return }
  const list = (window.S && S.ann && S.ann.list) || []
  const unread = (window.S && S.ann && S.ann.unread) || []
  if (!list.length) { banner.hidden = true; return }
  const latest = list.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
  const title = (latest.title || latest.text || '查看公告').trim()
  banner.hidden = false
  banner.innerHTML = '<span>📢</span><span class="ca-text">' + esc(String(title).slice(0, 40)) + '</span>' +
    (unread.length ? '<span class="ca-badge">未读 ' + unread.length + '</span>' : '')
}

/* 每个功能独占主区域：view 名 → 对应的 pane id */
const FULL_PANES = {
  ann: 'annView', forum: 'forumView', moments: 'momentsView',
  find: 'findView', lucky: 'luckyView', favorites: 'favoritesView',
  files: 'filesView', feedback: 'feedbackView',
  settings: 'settingsView', admin: 'adminView', more: 'moreView',
  discover: 'discoverView',
}

function showView(view) {
  S.view = view
  /* 离开管理面板即清除验密解锁：下次打开必须重新输密码（防滥用） */
  try {
    if (S.view === 'admin' && view !== 'admin') sessionStorage.removeItem('kbchat_admin_unlock')
  } catch (e) {}
  document.querySelectorAll('.rail-btn[data-nav]').forEach(b => {
    b.classList.toggle('is-on', b.dataset.nav === view)
  })
  /* 所有独占主区域的大视图先统一隐藏，再只显示当前这个 */
  Object.keys(FULL_PANES).forEach(k => {
    const n = el(FULL_PANES[k])
    if (n) n.hidden = k !== view
  })
  el('chatList').hidden = view !== 'chats'
  el('contactList').hidden = view !== 'contacts'
  el('miscList').hidden = true
  const fullView = !!FULL_PANES[view]
  if (fullView) {
    document.querySelector('.pane-list').style.display = 'none'
    document.querySelector('.pane-chat').style.display = 'none'
  } else if (isMobile()) {
    document.querySelector('.pane-chat').style.display = (view === 'chats' && S.activeRoom) ? 'flex' : 'none'
    document.querySelector('.pane-list').style.display = (view === 'chats' && S.activeRoom) ? 'none' : 'flex'
  } else {
    document.querySelector('.pane-list').style.display = 'flex'
    document.querySelector('.pane-chat').style.display = 'flex'
  }
  /* 移动端底部导航选中态同步（聊天/靠北帖/朋友圈高亮，其余高亮「更多」） */
  if (typeof syncMtab === 'function') { try { syncMtab(view) } catch (e) {} }
  /* 微信行为：进入聊天会话隐藏底部导航，其它视图恢复 */
  if (isMobile()) {
    const m = el('mtabNav')
    if (m) m.hidden = (view === 'chats' && S.activeRoom)
  }
}

function enterChat(roomId) {
  S.activeRoom = roomId
  showView('chats')   /* 从通讯录等视图点好友时，切回聊天视图 */
  el('emptyChat').hidden = true
  el('composer').hidden = false
  const bb = el('btnBack')
  if (bb) bb.hidden = false   /* 微信/QQ 式：进入会话显示左上角返回键 */
  renderChatHeader()
  renderChatList()
  if (isMobile()) {
    document.querySelector('.pane-chat').style.display = 'flex'
    document.querySelector('.pane-list').style.display = 'none'
    const m = el('mtabNav')
    if (m) m.hidden = true
  }
}

function leaveChat() {
  S.activeRoom = null
  el('emptyChat').hidden = false
  el('composer').hidden = true
  document.body.classList.remove('ai-side-collapsed')
  const bb = el('btnBack')
  if (bb) bb.hidden = true
  if (isMobile()) {
    document.querySelector('.pane-chat').style.display = 'none'
    document.querySelector('.pane-list').style.display = 'flex'
    const m = el('mtabNav')
    if (m) m.hidden = false
  }
}
