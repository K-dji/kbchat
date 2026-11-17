/* ===========================================================
 * net.js —— 与聊天服务端的通信（REST + SSE 实时推送）
 * =========================================================== */

/* 本地静态预览（file:// 打开、localhost / 127.0.0.1）没有同源后端，
 * 回退到这个线上地址，保证预览卡片也能登录聊天。
 * 注意：这里必须是「真实可访问」的后端地址，指向尚未部署的域名会导致
 * 本地预览全部请求失败（表现为「网络连接失败」） */
const APP_ORIGIN = 'https://wechat-chat-74197.app.workbuddy.host'
/* 本地起 server.js 调试时（如 127.0.0.1:3000）走同源，才能用到本地后端；
 * 其余预览场景（file:// 或 WorkBuddy 预览代理端口）仍回退到线上后端 */
const LOCAL_DEV_PORTS = ['3000', '3100', '3200']
const IS_LOCAL_PREVIEW =
  location.protocol === 'file:' ||
  ['localhost', '127.0.0.1', '0.0.0.0', ''].includes(location.hostname)
const API_BASE_DEFAULT = IS_LOCAL_PREVIEW
  ? (LOCAL_DEV_PORTS.includes(location.port) ? '' : APP_ORIGIN)
  : ''
/* file:// 直接打开时没有同源后端：先探一下本机 3000 端口，能连上就用本地服务
 * （否则新增功能在线上旧版后端里不存在），连不上再退回线上地址 */
let API_BASE = API_BASE_DEFAULT
let apiBaseReady = null
if (location.protocol === 'file:') {
  apiBaseReady = (async () => {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/health', { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j && j.ok) { API_BASE = 'http://127.0.0.1:3000'; return }
    } catch (e) {}
    API_BASE = APP_ORIGIN
  })()
}

const Net = {
  token: '',
  es: null,

  /* Cloudflare Pages/Workers 部署检测：这些域名下无 SSE 长连接，前端自动改用轮询 */
  IS_CF: /(\.pages\.dev|\.workers\.dev)$/i.test(location.hostname),

  /* ---------- 基础请求 ---------- */
  absUrl(path) {
    /* 同源请求 Cookie 自动携带（HttpOnly），无需把 token 放 URL */
    return API_BASE + path
  },

  async api(path, { method = 'GET', body } = {}) {
    if (apiBaseReady) { try { await apiBaseReady } catch (e) {} }
    const headers = { 'Content-Type': 'application/json' }
    if (Net.token) headers['X-Token'] = Net.token
    /* token 只走 X-Token 头 + HttpOnly Cookie，不再进 URL（避免出现在代理/网关日志中）；
       EventSource 等无法自定义 header 的请求由 Cookie 自动携带 */
    const url = API_BASE + path
    let res = null
    let netErr = null
    /* 网络中断重试 1 次；平台偶发 502/503/504（Cloudflare 边缘抖动/部署间隙）
     * 对 GET/POST 一律自动重试 2 次（带退避），避免用户看到「请求失败（503）」 */
    const tries = 3
    for (let i = 0; i < tries; i++) {
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (i < tries - 1 && (res.status === 502 || res.status === 503 || res.status === 504)) {
          await new Promise(r => setTimeout(r, 450 * (i + 1)))
          continue
        }
        netErr = null
        break
      } catch (e) {
        netErr = e
        if (i < tries - 1) await new Promise(r => setTimeout(r, 400))
      }
    }
    if (netErr) throw new Error('网络连接失败，请检查网络后重试')
    let data = {}
    try { data = await res.json() } catch (e) { data = {} }
    if (res.status === 401) {
      Net.token = ''
      sessionStorage.removeItem('wxchat_token')
      const em = (data && data.error) || ''
      /* 登录/注册/找回接口的 401 是正常业务错误（密码错等），不触发踢出 */
      if (/^\/api\/(login|register|recover|suggest|weather|ai\/open)/.test(path)) return err401(em)
      /* 封禁用户：明确提示并回到登录页 */
      if (/封禁/.test(em) && !Net.__banKicked) {
        Net.__banKicked = true
        setTimeout(() => { try { alert(em) } catch (e) {} ; location.reload() }, 400)
        return err401(em)
      }
      /* 其它会话失效（换设备下线/重新部署等）：自动回到登录页，避免散落报错 */
      if (!Net.__kicked) {
        Net.__kicked = true
        try { sessionStorage.setItem('kbchat_kickmsg', em || '登录已失效，请重新登录') } catch (e) {}
        setTimeout(() => location.reload(), 600)
      }
      return err401(em)
    }
    if (!res.ok && res.status !== 200) {
      const fallback = (res.status >= 500 && res.status <= 599)
        ? '服务器繁忙（' + res.status + '），请稍后再试'
        : '请求失败（' + res.status + '）'
      const err = new Error(data.error || fallback)
      err.status = res.status
      err.payload = data   /* 保留完整响应，登录「已删除」等场景需要额外字段 */
      throw err
    }
    return data
  },

  /* ---------- 登录注册 ---------- */
  /* 本机固定标识：浏览器持久随机 ID（换网络不变），注册/登录/找回自动携带 */
  deviceId() {
    try {
      let id = localStorage.getItem('kbchat_device_id')
      if (!id) {
        const u = new Uint8Array(12)
        crypto.getRandomValues(u)
        id = Array.prototype.map.call(u, b => b.toString(16).padStart(2, '0')).join('')
        localStorage.setItem('kbchat_device_id', id)
      }
      return id
    } catch (e) { return '' }
  },

  async login(wxid, password) {
    const r = await Net.api('/api/login', { method: 'POST', body: { wxid, password, deviceId: Net.deviceId() } })
    if (r.token) {
      Net.token = r.token
      sessionStorage.setItem('wxchat_token', r.token)
      Net.remember(r.user)
    }
    return r
  },

  /* 一台设备可记住多个账号的令牌，便于快速切换（同一账号仍只允许一处在线） */
  remember(user) {
    if (!user || !user.uid) return
    try {
      const list = JSON.parse(sessionStorage.getItem('kbchat_accounts') || '[]')
      const item = {
        uid: user.uid, wxid: user.wxid, nickname: user.nickname,
        avatar: user.avatar, token: Net.token,
      }
      const i = list.findIndex(x => x.uid === user.uid)
      if (i >= 0) list[i] = item
      else list.push(item)
      sessionStorage.setItem('kbchat_accounts', JSON.stringify(list.slice(-8)))
    } catch (e) {}
  },
  accounts() {
    try { return JSON.parse(sessionStorage.getItem('kbchat_accounts') || '[]') } catch (e) { return [] }
  },
  useAccount(item) {
    Net.token = item.token
    sessionStorage.setItem('wxchat_token', item.token)
  },
  forgetAccount(uid) {
    try {
      const list = Net.accounts().filter(x => x.uid !== uid)
      sessionStorage.setItem('kbchat_accounts', JSON.stringify(list))
    } catch (e) {}
  },

  /* 注册：偶发的连接中断会让请求「发出去了但没收到回应」，
   * 自动重试一次；若第一次其实已成功，第二次会报「已被使用」，此时转去直接登录 */
  async register(payload) {
    /* 「已被采用」时用该账号尝试直接登录（首次请求可能已成功） */
    const tryLogin = async () => {
      try {
        const lg = await Net.login(payload.wxid, payload.password)
        if (lg && lg.token) return Object.assign({}, lg, { recovered: true })
      } catch (e) {}
      return null
    }
    let r = null
    try {
      r = await Net.api('/api/register', { method: 'POST', body: Object.assign({ deviceId: Net.deviceId() }, payload) })
    } catch (e) {
      const msg = (e && e.message) || ''
      /* 业务错误（4xx，如 KB号已被采用）不重试：直接显示后端原因 */
      if (e && e.status && e.status >= 400 && e.status < 500) {
        if (/已被采用/.test(msg)) {
          const lg = await tryLogin()
          if (lg) return lg
        }
        throw new Error(msg)
      }
      /* 真网络错误：重试一次；重试若报「已被采用」说明首次已成功 → 转登录 */
      try {
        await new Promise(res => setTimeout(res, 600))
        r = await Net.api('/api/register', { method: 'POST', body: Object.assign({ deviceId: Net.deviceId() }, payload) })
      } catch (e2) {
        const m2 = (e2 && e2.message) || ''
        if (/已被采用/.test(m2)) {
          const lg = await tryLogin()
          if (lg) return lg
          throw new Error(m2)
        }
        throw new Error('网络不稳定，注册未完成，请稍后重试')
      }
    }
    if (r && r.token) { Net.token = r.token; sessionStorage.setItem('wxchat_token', r.token) }
    return r
  },

  recoverLookup(realName, wxid) {
    return Net.api('/api/recover/lookup', { method: 'POST', body: { realName, wxid: wxid || '' } })
  },
  /* 密保问答找回：先验真实姓名取问题，再答 3 题重置（不依赖 IP/网络） */
  recoverQuiz(wxid, realName) { return Net.api('/api/recover/quiz', { method: 'POST', body: { wxid, realName: realName || '' } }) },
  recoverQuizReset(payload) { return Net.api('/api/recover/quiz-reset', { method: 'POST', body: payload }) },
  sec3Set(payload) { return Net.api('/api/sec3/set', { method: 'POST', body: payload }) },
  sec3Get() { return Net.api('/api/sec3/get') },
  adminIpRules() { return Net.api('/api/admin/iprules') },
  adminIpRuleSet(payload) { return Net.api('/api/admin/iprules', { method: 'POST', body: payload }) },
  /* 小靠AI：快速 / 深度 / 专家 */
  aiChat(payload) { return Net.api('/api/ai/chat', { method: 'POST', body: payload }) },
  /* CMO「AI帮手」：自然语言查库 */
  adminAiHelp(payload) { return Net.api('/api/admin/aihelp', { method: 'POST', body: payload }) },
  /* CMO「清空用户数据」：仅保留 CMO 账号 */
  adminWipeUsers() { return Net.api('/api/admin/wipe-users', { method: 'POST', body: { confirm: '清空用户数据' } }) },
  /* 屏蔽 / 取消屏蔽（CMO 不可屏蔽）；删除好友（CMO 不可删除）；清空某会话的全部聊天记录 */
  blockUser(uid, on) { return Net.api('/api/block', { method: 'POST', body: { uid, on: on !== false } }) },
  deleteFriend(uid) { return Net.api('/api/friends/delete', { method: 'POST', body: { uid } }) },
  convClear(roomId) { return Net.api('/api/conv/clear', { method: 'POST', body: { roomId } }) },
  /* 天气：lat/lon 或 city 二选一 */
  weather(params) {
    const q = params.lat != null
      ? 'lat=' + encodeURIComponent(params.lat) + '&lon=' + encodeURIComponent(params.lon)
      : 'city=' + encodeURIComponent(params.city || '')
    return Net.api('/api/weather?' + q)
  },
  recoverReset(payload) {
    return Net.api('/api/recover/reset', { method: 'POST', body: Object.assign({ deviceId: Net.deviceId() }, payload) })
  },
  async suggestWxid() {
    const r = await Net.api('/api/suggest-wxid')
    return r.wxid
  },

  async logout() {
    try { await Net.api('/api/logout', { method: 'POST' }) } catch (e) {}
    Net.token = ''
    sessionStorage.removeItem('wxchat_token')
    if (Net.es) { Net.es.close(); Net.es = null }
  },

  /* ---------- 数据 ---------- */
  /* 登录 / 注册后的全量初始化：我、好友、群、会话、好友申请数 */
  bootstrap() { return Net.api('/api/bootstrap') },
  ping() { return Net.api('/api/ping') },
  messages(roomId) { return Net.api('/api/messages?roomId=' + encodeURIComponent(roomId)) },
  read(roomId) { return Net.api('/api/read', { method: 'POST', body: { roomId } }) },
  search(kw) { return Net.api('/api/search?kw=' + encodeURIComponent(kw)) },
  addFriend(uid, msg) { return Net.api('/api/friends', { method: 'POST', body: { uid, msg: msg || '' } }) },
  friendRequests() { return Net.api('/api/friends/requests') },
  handleRequest(uid, act) { return Net.api('/api/friends/handle', { method: 'POST', body: { uid, act } }) },
  createGroup(name, uids) { return Net.api('/api/groups', { method: 'POST', body: { name, uids } }) },
  updateProfile(patch) { return Net.api('/api/profile', { method: 'POST', body: patch }) },
  changePassword(oldPassword, newPassword, confirmPassword) {
    return Net.api('/api/password/change', {
      method: 'POST',
      body: { oldPassword, newPassword, confirmPassword },
    })
  },

  /* ---------- 管理员 ---------- */
  adminUsers() { return Net.api('/api/admin/users') },
  adminUser(uid) { return Net.api('/api/admin/user?uid=' + encodeURIComponent(uid)) },
  lotteryList() { return Net.api('/api/lottery/list') },
  lotteryDraw(id) { return Net.api('/api/lottery/draw', { method: 'POST', body: { id } }) },
  lotteryCreate(payload) { return Net.api('/api/admin/lottery/create', { method: 'POST', body: payload }) },
  lotteryDel(id) { return Net.api('/api/admin/lottery/del', { method: 'POST', body: { id } }) },
  adminBans() { return Net.api('/api/admin/bans') },
  adminAdmins() { return Net.api('/api/admin/admins') },
  adminInvite(wxid, perms) {
    return Net.api('/api/admin/invite', { method: 'POST', body: { wxid, perms } })
  },
  adminPerm(uid, perms) {
    return Net.api('/api/admin/perm', { method: 'POST', body: { uid, perms } })
  },
  adminDismiss(uid) { return Net.api('/api/admin/dismiss', { method: 'POST', body: { uid } }) },
  fbPending() { return Net.api('/api/fbreq/pending') },
  fbAnswer(id, stars, text) {
    return Net.api('/api/fbreq/answer', { method: 'POST', body: { id, stars, text } })
  },
  adminFbReqList() { return Net.api('/api/admin/fbreq/list') },
  adminFbReqCreate(title, desc) {
    return Net.api('/api/admin/fbreq/create', { method: 'POST', body: { title, desc } })
  },
  adminFbReqDel(id) { return Net.api('/api/admin/fbreq/del', { method: 'POST', body: { id } }) },
  bubblePost(hobby, loc) { return Net.api('/api/bubble', { method: 'POST', body: { hobby, loc: loc || null } }) },
  bubbleList() { return Net.api('/api/bubble') },
  bubbleDel() { return Net.api('/api/bubble/del', { method: 'POST' }) },
  recoverByIp() { return Net.api('/api/recover/byip') },
  recall(msgId) { return Net.api('/api/recall', { method: 'POST', body: { msgId } }) },
  report(msgId, reason) { return Net.api('/api/report', { method: 'POST', body: { msgId, reason } }) },
  feedback(text) { return Net.api('/api/feedback', { method: 'POST', body: { text } }) },
  adminMsgDel(msgId) { return Net.api('/api/admin/msgdel', { method: 'POST', body: { msgId } }) },
  adminFriendReqs() { return Net.api('/api/admin/friendreqs') },
  adminFriendReqDel(ownerUid, fromUid) { return Net.api('/api/admin/friendreq/del', { method: 'POST', body: { ownerUid, fromUid } }) },
  adminFeedback() { return Net.api('/api/admin/feedback') },
  adminFeedbackDel(id) { return Net.api('/api/admin/feedback/del', { method: 'POST', body: { id } }) },
  adminReports() { return Net.api('/api/admin/reports') },
  adminReportAction(id, result) {
    return Net.api('/api/admin/report-action', { method: 'POST', body: { id, result } })
  },
  agreeProtocol(version) {
    return Net.api('/api/agreement', { method: 'POST', body: { version } })
  },
  annList() { return Net.api('/api/ann/list') },
  annSubmit(payload) { return Net.api('/api/ann/submit', { method: 'POST', body: payload }) },
  annRead(ids) { return Net.api('/api/ann/read', { method: 'POST', body: { ids: ids || [] } }) },
  annMine() { return Net.api('/api/ann/mine') },
  annDelete(id) { return Net.api('/api/ann/delete', { method: 'POST', body: { id } }) },
  annReview(id, approve) {
    return Net.api('/api/ann/review', { method: 'POST', body: { id, approve: !!approve } })
  },
  adminDms(opts) { return Net.api('/api/admin/dms', { method: 'POST', body: opts || {} }) },
  adminDmMessages(roomId, kw) {
    const q = new URLSearchParams({ roomId })
    if (kw) q.set('kw', kw)
    return Net.api('/api/admin/dm/messages?' + q.toString())
  },
  adminGroups(kw) {
    return Net.api('/api/admin/groups' + (kw ? '?kw=' + encodeURIComponent(kw) : ''))
  },
  adminDeleted() { return Net.api('/api/admin/deleted') },
  deletedPublic() { return Net.api('/api/deleted-public') },
  adminMsgFind(params) {
    const q = new URLSearchParams()
    if (params && params.uid) q.set('uid', params.uid)
    if (params && params.kw) q.set('kw', params.kw)
    return Net.api('/api/admin/msgfind?' + q.toString())
  },
  adminMsgWipe(opts) {
    return Net.api('/api/admin/msgwipe', { method: 'POST', body: opts || {} })
  },
  adminRooms() { return Net.api('/api/admin/rooms') },
  adminRoomMessages(roomId) {
    return Net.api('/api/admin/messages?roomId=' + encodeURIComponent(roomId))
  },
  adminAction(uid, act, extra) {
    return Net.api('/api/admin/action', { method: 'POST', body: Object.assign({ uid, act }, extra || {}) })
  },
  adminStorage() { return Net.api('/api/admin/storage') },
  adminBackupUrl() {
    const sep = '/api/admin/backup'.includes('?') ? '&' : '?'
    return API_BASE + '/api/admin/backup' + sep + 'token=' + encodeURIComponent(Net.token)
  },
  adminRestore(data, merge) {
    return Net.api('/api/admin/restore', { method: 'POST', body: { data, merge: !!merge } })
  },

  async send(roomId, kind, content, fileName, dur, ref) {
    const r = await Net.api('/api/send', { method: 'POST', body: { roomId, kind, content, fileName: fileName || '', dur: Number(dur) || 0, ref: ref || null } })
    return r.message
  },

  /* ---------- 图片 / 视频 / 语音上传（转 base64 后提交） ---------- */
  /* 图片压缩：最长边 maxEdge、JPEG 质量递减直到 ≤maxBytes（头像/聊天图片不再撞 D1 单值限制） */
  async compressImage(file, maxEdge, quality, maxBytes) {
    if (!/^image\//.test(file.type || '') || /svg/i.test(file.type || '')) return file
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(new Error('读取文件失败'))
        fr.readAsDataURL(file)
      })
      const img = await new Promise((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('图片解析失败'))
        i.src = dataUrl
      })
      const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1))
      const cv = document.createElement('canvas')
      cv.width = Math.max(1, Math.round((img.width || 1) * scale))
      cv.height = Math.max(1, Math.round((img.height || 1) * scale))
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
      let q = quality
      let out = cv.toDataURL('image/jpeg', q)
      while (out.length * 0.75 > maxBytes && q > 0.45) {
        q -= 0.1
        out = cv.toDataURL('image/jpeg', q)
      }
      const bin = atob(out.split(',')[1] || '')
      const u = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
      const blob = new Blob([u], { type: 'image/jpeg' })
      /* 压缩后反而更大（原图本就很小）则保留原图 */
      return blob.size < file.size ? blob : file
    } catch (e) { return file }
  },

  async uploadFile(file, opts) {
    opts = opts || {}
    let f = file
    /* 图片 >1.4MB 自动压缩（D1 单值约 2MB：base64 膨胀 1.33 倍后 1.4MB 已贴近上限） */
    if (/^image\//.test(f.type || '') && f.size > 1400 * 1024 && !opts.raw) {
      f = await Net.compressImage(f, opts.maxEdge || 1600, opts.quality || 0.82, 1400 * 1024)
      if (f.size > 6 * 1024 * 1024) throw new Error('图片过大且无法压缩，请换一张')
    }
    /* 视频 >1.5MB 走分块通道（D1 单值装不下整段视频） */
    if (/^video\//.test(f.type || '') && f.size > 1500 * 1024 && !opts.noChunk) {
      const r = await Net.uploadLarge(f)
      const url = r.url && r.url.charAt(0) === '/' ? API_BASE + r.url : r.url
      return url
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = () => reject(new Error('读取文件失败'))
      fr.readAsDataURL(f)
    })
    /* 小文件（≤48KB）直接内嵌 base64 data URI：不依赖 uploads 表，永不失效（聊天/图片/AI 通用） */
    if (f.size <= 48 * 1024) return dataUrl
    const r = await Net.api('/api/upload', { method: 'POST', body: { data: dataUrl } })
    /* 媒体地址必须是绝对地址，其他来源（预览 / 别的域名）打开才能显示 */
    return r.url && r.url.charAt(0) === '/' ? API_BASE + r.url : r.url
  },
  uploadImage(file, opts) { return Net.uploadFile(file, opts) },

  /* 大文件分块上传（文件传输助手等）：1.2MB/块，最大 500MB，服务端 10 天后自动清理。
     每块独立重试 3 次（移动网络单块抖动不应毁掉整个上传）；仍失败则给出明确进度提示 */
  async uploadLarge(file, onProgress) {
    if (file.size > 500 * 1024 * 1024) throw new Error('文件最大 500MB，请压缩后再试')
    const CHUNK = 1200 * 1024
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    const total = Math.ceil(file.size / CHUNK)
    for (let part = 0; part < total; part++) {
      const blob = file.slice(part * CHUNK, (part + 1) * CHUNK)
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1])
        r.onerror = () => rej(new Error('读取失败'))
        r.readAsDataURL(blob)
      })
      let ok = false, lastErr = null
      for (let t = 0; t < 3 && !ok; t++) {
        try {
          await Net.api('/api/upload/chunk', { method: 'POST', body: { id, part, data: b64 } })
          ok = true
        } catch (e) {
          lastErr = e
          await new Promise(r2 => setTimeout(r2, 1000 * (t + 1)))
        }
      }
      if (!ok) {
        throw new Error('第 ' + (part + 1) + '/' + total + ' 块上传失败（已重试 3 次）：' +
          (lastErr && lastErr.message ? lastErr.message : '网络不稳定') + '，请换个网络再试')
      }
      if (onProgress) onProgress(Math.round(((part + 1) / total) * 90))
    }
    const r = await Net.api('/api/upload/finish', { method: 'POST', body: { id, total, name: file.name, mime: file.type || 'application/octet-stream', size: file.size } })
    if (onProgress) onProgress(100)
    return { url: r.url && r.url.charAt(0) === '/' ? API_BASE + r.url : r.url, name: r.name, expiresAt: r.expiresAt }
  },

  forumPostDel(boardId, postId) { return Net.api('/api/forum/post/del', { method: 'POST', body: { boardId, postId } }) },
  logout() { return Net.api('/api/logout', { method: 'POST', body: {} }) },
  agreePledge() { return Net.api('/api/agreement/pledge', { method: 'POST', body: { version: 'PLEDGE_V1' } }) },
  adminVerify(password) { return Net.api('/api/admin/verify', { method: 'POST', body: { password } }) },
  hideMsg(msgId) { return Net.api('/api/messages/hide', { method: 'POST', body: { msgId } }) },
  adminStorageGet() { return Net.api('/api/admin/storage') },
  adminNote(uid, note) { return Net.api('/api/admin/note', { method: 'POST', body: { uid, note } }) },
  aiCheck(text) { return Net.api('/api/ai/check', { method: 'POST', body: { text } }) },
  publicAnns() { return Net.api('/api/public/anns') },
  adminStorageAct(action, days) { return Net.api('/api/admin/storage', { method: 'POST', body: { action, days } }) },

  /* ---------- 朋友圈 ---------- */
  moments() { return Net.api('/api/moments/list') },
  momentPublish(payload) { return Net.api('/api/moments/publish', { method: 'POST', body: payload }) },
  momentUpdate(payload) { return Net.api('/api/moments/update', { method: 'POST', body: payload }) },
  momentDel(id) { return Net.api('/api/moments/del', { method: 'POST', body: { id } }) },
  momentLike(id) { return Net.api('/api/moments/like', { method: 'POST', body: { id } }) },
  momentComment(id, text) { return Net.api('/api/moments/comment', { method: 'POST', body: { id, text } }) },
  momentReport(id, reason, commentId) {
    return Net.api('/api/moments/report', { method: 'POST', body: { id, reason, commentId: commentId || '' } })
  },
  adminMoments() { return Net.api('/api/admin/moments') },
  adminMomentAction(payload) {
    return Net.api('/api/admin/moment-action', { method: 'POST', body: payload })
  },

  /* ---------- 靠北帖（多帖） ---------- */
  forum(boardId) { return Net.api('/api/forum' + (boardId ? '?board=' + encodeURIComponent(boardId) : '')) },
  forumBoardAdd(name) { return Net.api('/api/forum/board', { method: 'POST', body: { name } }) },
  forumBoardDel(id) { return Net.api('/api/forum/board/del', { method: 'POST', body: { id } }) },
  forumPost(payload) { return Net.api('/api/forum/post', { method: 'POST', body: payload }) },
  forumComment(id, text) { return Net.api('/api/forum/comment', { method: 'POST', body: { id, text } }) },
  forumLike(id) { return Net.api('/api/forum/like', { method: 'POST', body: { id } }) },
  forumMembers(boardId, uids) { return Net.api('/api/forum/members', { method: 'POST', body: { boardId, uids } }) },

  /* ---------- 收藏 / 文件 ---------- */
  favorites() { return Net.api('/api/favorites') },
  favAdd(payload) { return Net.api('/api/favorites/add', { method: 'POST', body: payload }) },
  favDel(id) { return Net.api('/api/favorites/del', { method: 'POST', body: { id } }) },
  favToggle(payload) { return Net.api('/api/favorites/toggle', { method: 'POST', body: payload }) },
  files() { return Net.api('/api/files') },

  /* ---------- 违禁词 ---------- */
  adminWords() { return Net.api('/api/admin/words') },
  adminWordAdd(word) { return Net.api('/api/admin/word/add', { method: 'POST', body: { word } }) },
  adminWordDel(id) { return Net.api('/api/admin/word/del', { method: 'POST', body: { id } }) },
  adminWarnClear(uid) { return Net.api('/api/admin/warn/clear', { method: 'POST', body: { uid } }) },
  adminRepairFriends() { return Net.api('/api/admin/repair-friends', { method: 'POST' }) },
  adminRegister(payload) { return Net.api('/api/admin/register', { method: 'POST', body: payload }) },
  /* 更多 → 游戏 */
  games() { return Net.api('/api/games') },
  adminGameAdd(payload) { return Net.api('/api/admin/games', { method: 'POST', body: payload }) },
  adminGamePin(id) { return Net.api('/api/admin/games/pin', { method: 'POST', body: { id } }) },
  adminGameDel(id) { return Net.api('/api/admin/games/del', { method: 'POST', body: { id } }) },
  adminGameEdit(payload) { return Net.api('/api/admin/games/edit', { method: 'POST', body: payload }) },

  /* 登录页「我有疑问」（免登录） */
  guestThread(gid) { return Net.api('/api/guest/thread?gid=' + encodeURIComponent(gid)) },
  guestAsk(payload) { return Net.api('/api/guest/ask', { method: 'POST', body: payload }) },
  guestLeave(gid) { return Net.api('/api/guest/leave', { method: 'POST', body: { gid } }) },
  /* 管理员侧 */
  adminGuest() { return Net.api('/api/admin/guest') },
  adminGuestReply(gid, text) { return Net.api('/api/admin/guest/reply', { method: 'POST', body: { gid, text } }) },
  adminGuestDel(gid) { return Net.api('/api/admin/guest/del', { method: 'POST', body: { gid } }) },

  /* 主动注销账号：校验真实姓名 + 密码 */
  accountClose(realName, password) {
    return Net.api('/api/account/close', { method: 'POST', body: { realName, password } })
  },

  /* 注册后拒绝协议：注销刚注册的账号 */
  abandonAccount() { return Net.api('/api/account/abandon', { method: 'POST' }) },

  /* ---------- SSE 实时通道 ---------- */
  connect(handlers) {
    if (Net.es) { Net.es.close(); Net.es = null }
    /* Cloudflare 部署：无 SSE 长连接，直接走轮询 */
    if (Net.IS_CF) {
      if (handlers.status) handlers.status('polling')
      return null
    }
    const es = new EventSource(API_BASE + '/api/events?token=' + encodeURIComponent(Net.token))
    Net.es = es
    /* 事件名需与服务端 push() 全量对齐，漏掉就只能靠轮询兜底，实时性变差 */
    const names = ['hello', 'msg', 'msgdel', 'fbnotice', 'friends', 'groups', 'presence', 'account', 'friendreq', 'friendres', 'warn', 'moment', 'momentreport', 'forum', 'notice', 'profile', 'guestask', 'importantAnn']
    names.forEach(name => {
      es.addEventListener(name, e => {
        let payload = {}
        try { payload = JSON.parse(e.data) } catch (err) { payload = {} }
        if (handlers[name]) handlers[name](payload)
      })
    })
    es.onerror = () => {
      // EventSource 会自动重连；仅更新 UI 状态
      if (handlers.status) handlers.status('reconnecting')
    }
    es.onopen = () => { if (handlers.status) handlers.status('open') }
    return es
  },
}

/* 房间工具（前后端共用规则） */
function dmRoomId(a, b) { return 'dm_' + [a, b].sort().join('__') }
function dmMembers(a, b) { return [a, b].sort() }
