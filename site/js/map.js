/* ===========================================================
 * map.js —— 定位与地图（腾讯位置服务 GL JS）
 *
 * 合规说明：
 *  · 只使用白名单地图源「腾讯地图」，不使用 Google / OSM / Mapbox 等境外或未备案源；
 *  · 代码里不内置任何 Key，用户在「设置 → 地图」里填自己的 Key（本地 localStorage）；
 *  · 定位坐标来自浏览器 Geolocation（WGS84），入图前统一用标准算法转成 GCJ-02。
 * =========================================================== */

const TMAP_KEY = 'kbchat_tmap_key'
const TMAP_SDK = 'https://map.qq.com/api/gljs?v=1.exp&libraries=service'

function tmapKey() {
  try { return (localStorage.getItem(TMAP_KEY) || '').trim() } catch (e) { return '' }
}
function setTmapKey(k) {
  try { localStorage.setItem(TMAP_KEY, String(k || '').trim()) } catch (e) {}
}

/* ---------- 坐标系转换：WGS84 → GCJ-02（火星坐标） ---------- */
const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}
function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0
  return r
}
function transformLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0
  return r
}
function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = lat / 180.0 * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

/* 两点直线距离（米），haversine */
function distanceMeters(a, b) {
  if (!a || !b) return 0
  const R = 6371008.8
  const rad = d => d * Math.PI / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
function fmtDistance(m) {
  if (!m) return ''
  return m < 1000 ? Math.round(m) + ' 米' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' 公里'
}

/* ---------- SDK 懒加载 ---------- */
let tmapLoading = null
function loadTMap() {
  const key = tmapKey()
  if (!key) return Promise.reject(new Error('还没有填写腾讯地图 Key，请到「设置 → 地图」里填写'))
  if (window.TMap) return Promise.resolve(window.TMap)
  if (tmapLoading) return tmapLoading
  tmapLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = TMAP_SDK + '&key=' + encodeURIComponent(key)
    s.onload = () => window.TMap ? resolve(window.TMap) : reject(new Error('地图 SDK 加载失败'))
    s.onerror = () => reject(new Error('地图 SDK 加载失败，请检查网络或 Key 是否正确'))
    document.head.appendChild(s)
  })
  return tmapLoading
}

/* ---------- 发送定位 ---------- */
let locPick = null
let locPickCb = null
let locPickParent = ''   /* 从弹窗里唤起时记住父弹窗，选完/取消后要回到它 */

/* onDone 为空 = 发到当前会话；传入回调 = 只取坐标给调用方（朋友圈 / 找朋友用）
 * parentModal 传入父弹窗 id（例如 modalMomentForm），确认或取消后自动回到父弹窗 */
function openLocationPicker(onDone, parentModal) {
  if (!onDone && !S.activeRoom) { toast('请先打开一个会话'); return }
  locPickCb = typeof onDone === 'function' ? onDone : null
  locPickParent = locPickCb ? String(parentModal || '') : ''
  locPick = { lat: 0, lng: 0, acc: 0, name: '', addr: '', ready: false }
  el('locName').value = ''
  if (el('locAddr')) el('locAddr').value = ''
  el('locErr').textContent = ''
  el('locInfo').textContent = '正在获取定位…'
  el('btnLocSend').disabled = true
  el('btnLocSend').textContent = locPickCb ? '使用这个位置' : '发送'
  el('btnLocCancel').onclick = () => { backFromLocPicker(); }
  el('btnLocSend').onclick = doSendLocation
  el('btnLocRetry').onclick = locateMe
  el('btnLocPrivacy').onclick = () => toast('定位只在你点确认后才会上传，且只会发到你选中的这个会话里', 4200)
  if (el('btnLocMap')) el('btnLocMap').onclick = showLocMap
  const mw = el('locMapWrap')
  if (mw) mw.hidden = true
  openModal('modalLocation')
  locateMe()
}

/* 关闭定位弹窗：回到发起它的地方（朋友圈表单 / 找朋友 / 聊天） */
function backFromLocPicker() {
  const parent = locPickParent
  locPickCb = null
  locPickParent = ''
  if (parent) openModal(parent)
  else closeModal()
}

/* ---------- 两级定位：先高精度（GPS），超时/失败自动降级为快速网络定位 ----------
 * 室内/弱信号下 GPS 冷启动经常超过 12 秒 → 之前直接报「定位超时」；
 * 现在降级兜底后基本都能拿到位置（精度略差但可用），并允许使用 1 分钟内的缓存位置。 */
let _geoErrCode = 0
function geoErrText(code) {
  if (code === 1) return '定位权限被拒绝：请点浏览器地址栏左侧的「📍」图标 → 允许定位 → 再点「重新定位」'
  if (code === 3) return '定位超时：信号较弱，建议到窗边或室外再点「重新定位」，或用「地图选点」手动指定'
  if (code === 2) return '无法获取位置：请检查系统定位服务与浏览器权限，或直接用「地图选点」手动指定'
  return '定位失败：请检查定位权限，或用「地图选点」手动指定位置'
}
function geoPromise() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null)
    const done = p => {
      const g = wgs84ToGcj02(p.coords.latitude, p.coords.longitude)
      g.acc = Math.round(p.coords.accuracy || 0)
      resolve(g)
    }
    navigator.geolocation.getCurrentPosition(
      done,
      err => { _geoErrCode = err && err.code || 0; navigator.geolocation.getCurrentPosition(
        done,
        e2 => { _geoErrCode = e2 && e2.code || _geoErrCode; resolve(null) },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
      ) },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    )
  })
}

/* ---------- 定位失败兜底：在地图上手动选点（无需 GPS） ---------- */
let locMapObj = null
let locMapMarker = null
function showLocMap() {
  const wrap = el('locMapWrap')
  if (!wrap) return
  wrap.hidden = false
  loadTMap().then(TMap => {
    const center = locPick && locPick.ready
      ? new TMap.LatLng(locPick.lat, locPick.lng)
      : new TMap.LatLng(39.908823, 116.397470)
    if (!locMapObj) {
      locMapObj = new TMap.Map(el('locPickMap'), { center, zoom: 13 })
      locMapObj.on('click', e => {
        if (!locPick) return
        const lat = +e.latLng.getLat().toFixed(6)
        const lng = +e.latLng.getLng().toFixed(6)
        locPick.lat = lat; locPick.lng = lng; locPick.acc = 0; locPick.ready = true
        el('btnLocSend').disabled = false
        el('locErr').textContent = ''
        el('locInfo').innerHTML = '已选地图位置：<b>' + lat.toFixed(5) + ', ' + lng.toFixed(5) + '</b>'
        placeLocMarker(locMapObj, e.latLng)
      })
    } else {
      locMapObj.setCenter(center)
    }
  }).catch(err => { el('locErr').textContent = err.message || '地图加载失败' })
}
function placeLocMarker(map, latLng) {
  const TMap = window.TMap
  if (!TMap || !map) return
  if (locMapMarker) { locMapMarker.setMap(null); locMapMarker = null }
  locMapMarker = new TMap.MultiMarker({
    map,
    styles: { p: new TMap.MarkerStyle({ width: 24, height: 34, anchor: { x: 12, y: 34 } }) },
    geometries: [{ id: 'p', styleId: 'p', position: latLng }],
  })
}

/* 定位流程：发送位置弹窗内获取当前位置（「重新定位」按钮同一入口） */
function locateMe() {
  if (!navigator.geolocation) {
    el('locErr').textContent = '当前浏览器不支持定位'
    return
  }
  el('locErr').textContent = ''
  el('locInfo').textContent = '正在获取定位…'
  el('btnLocSend').disabled = true
  geoPromise().then(g => {
    if (!g) {
      el('locErr').textContent = geoErrText(_geoErrCode)
      el('locInfo').textContent = ''
      return
    }
    locPick.lat = +g.lat.toFixed(6)
    locPick.lng = +g.lng.toFixed(6)
    locPick.acc = g.acc || 0
    locPick.ready = true
    el('locInfo').innerHTML = '已定位：<b>' + locPick.lat.toFixed(5) + ', ' + locPick.lng.toFixed(5) + '</b>' +
      (locPick.acc ? '　精度约 ±' + locPick.acc + ' 米' : '') +
      (locPick.acc > 500 ? '<br><span class="loc-warn">精度较差，建议到窗边或室外重新定位</span>' : '')
    el('btnLocSend').disabled = false
  })
}

async function doSendLocation() {
  if (!locPick || !locPick.ready) { el('locErr').textContent = '还没有拿到定位'; return }
  const name = el('locName').value.trim().slice(0, 40)
  const addr = el('locAddr') ? el('locAddr').value.trim().slice(0, 80) : ''
  const loc = {
    lat: locPick.lat, lng: locPick.lng,
    name: name || '我的位置', addr, acc: locPick.acc,
  }
  /* 回调模式：只把坐标交给调用方（朋友圈 / 找朋友），不发消息 */
  if (locPickCb) {
    const cb = locPickCb
    const parent = locPickParent
    locPickCb = null
    locPickParent = ''
    /* 先回到父弹窗，再把坐标交给它，这样地点胶囊会显示在可见的界面上 */
    if (parent) openModal(parent)
    else closeModal()
    cb(loc)
    return
  }
  const roomId = S.activeRoom
  if (!roomId) { el('locErr').textContent = '会话已关闭，请重新打开'; return }
  const btn = el('btnLocSend')
  btn.disabled = true
  try {
    await Net.send(roomId, 'location', JSON.stringify(loc))
    closeModal()
    toast('位置已发送')
  } catch (e) {
    el('locErr').textContent = e.message || '发送失败'
  } finally { btn.disabled = false }
}

/* ---------- 查看定位 ---------- */
function parseLoc(m) {
  try {
    const o = JSON.parse(m.content || '{}')
    const lat = Number(o.lat), lng = Number(o.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng, name: o.name || '', addr: o.addr || '', acc: Number(o.acc) || 0 }
  } catch (e) { return null }
}

let mapState = { map: null, markers: null, route: null, target: null, tab: 'point' }

function openLocationView(loc, title) {
  mapState.target = loc
  mapState.tab = 'point'
  el('mapTitle').textContent = title || '位置'
  el('mapSub').textContent = loc
    ? (loc.name || '位置') + '　' + loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5) +
      (loc.acc ? '　±' + loc.acc + ' 米' : '')
    : ''
  document.querySelectorAll('#mapTabs .atab').forEach(b => {
    b.classList.toggle('is-on', b.dataset.mt === 'point')
    b.onclick = () => { mapState.tab = b.dataset.mt; renderMapTab() }
  })
  el('btnMapNav').onclick = startNavigation
  el('btnMapClose').onclick = closeMap
  openModal('modalMap')
  renderMapTab()
}

function closeMap() {
  if (mapState.map) { try { mapState.map.destroy() } catch (e) {} }
  mapState = { map: null, markers: null, route: null, target: null, tab: 'point' }
  closeModal()
}

async function renderMapTab() {
  const box = el('mapCanvas')
  const tip = el('mapTip')
  const tab = mapState.tab
  el('btnMapNav').hidden = tab !== 'point' || !mapState.target

  if (!tmapKey()) {
    box.innerHTML = `<div class="map-empty">
      <div class="map-empty-ico">🗺️</div>
      <p><b>还没有配置腾讯地图 Key</b></p>
      <p class="muted">按国家测绘规定，这里只接入腾讯地图。请到
        <a href="https://lbs.qq.com/dev/console/key/manage" target="_blank" rel="noopener">腾讯位置服务控制台</a>
        免费申请一个 Key（Web 端 JS API），然后填入「设置 → 地图」。</p>
      ${mapState.target ? `<p class="muted">当前坐标：<b>${mapState.target.lat.toFixed(6)}, ${mapState.target.lng.toFixed(6)}</b></p>` : ''}
    </div>`
    tip.textContent = '没有 Key 时仍然可以发送和查看坐标，只是不显示底图。'
    return
  }

  let T
  try { T = await loadTMap() } catch (e) {
    box.innerHTML = `<div class="map-empty"><p class="merr">${esc(e.message)}</p></div>`
    tip.textContent = ''
    return
  }

  /* 三种视图的中心与缩放 */
  let center = new T.LatLng(35.0, 105.0)
  let zoom = 4
  if (tab === 'point' && mapState.target) {
    center = new T.LatLng(mapState.target.lat, mapState.target.lng)
    zoom = 15
  } else if (tab === 'china') {
    center = new T.LatLng(35.0, 105.0); zoom = 4
  } else if (tab === 'world') {
    center = new T.LatLng(20.0, 60.0); zoom = 3
  }

  if (mapState.map) { try { mapState.map.destroy() } catch (e) {} mapState.map = null }
  box.innerHTML = '<div id="mapInner"></div>'
  mapState.map = new T.Map('mapInner', { center, zoom, viewMode: '2D' })

  const pts = []
  if (mapState.target) {
    pts.push({
      id: 'target', styleId: 'default',
      position: new T.LatLng(mapState.target.lat, mapState.target.lng),
    })
  }
  mapState.markers = new T.MultiMarker({
    map: mapState.map,
    styles: {
      default: new T.MarkerStyle({
        width: 26, height: 34,
        anchor: { x: 13, y: 34 },
        src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">' +
          '<path d="M13 33C13 33 25 20.5 25 13A12 12 0 1 0 1 13c0 7.5 12 20 12 20z" fill="#e74c3c" stroke="#fff" stroke-width="2"/>' +
          '<circle cx="13" cy="12.5" r="4.6" fill="#fff"/></svg>'),
      }),
    },
    geometries: pts,
  })

  tip.textContent = tab === 'china'
    ? '全国概览：可用滚轮缩放；点位按 GCJ-02 坐标落在腾讯地图上。'
    : tab === 'world'
      ? '全球概览：境外坐标按 WGS84 原样展示，不做火星坐标偏移。'
      : (mapState.target && mapState.target.acc
        ? '精度约 ±' + mapState.target.acc + ' 米，仅供聊天里示意。'
        : '')
}

/* ---------- 导航：优先腾讯路线规划，失败则给出直线距离 ---------- */
async function startNavigation() {
  const target = mapState.target
  if (!target) return
  if (!tmapKey()) return toast('请先在「设置 → 地图」里填写腾讯地图 Key')
  const tip = el('mapTip')
  tip.textContent = '正在定位你所在的位置…'
  const me = await geoPromise()
  if (!me) { tip.textContent = '拿不到你的当前位置，无法规划路线'; return }
  const straight = distanceMeters(me, target)
  let T
  try { T = await loadTMap() } catch (e) { return toast(e.message) }
  try {
    const driving = new T.service.Driving({ map: mapState.map, policy: 'LEAST_TIME' })
    driving.search(
      new T.LatLng(me.lat, me.lng),
      new T.LatLng(target.lat, target.lng),
      (status, result) => {
        if (status === 'complete' && result && result.result) {
          const r = result.result.routes && result.result.routes[0]
          const km = r ? (r.distance / 1000).toFixed(1) + ' 公里' : fmtDistance(straight)
          const min = r ? Math.round(r.duration / 60) + ' 分钟' : ''
          tip.textContent = '驾车路线：约 ' + km + (min ? '，预计 ' + min : '') + '（腾讯地图实时路况）'
        } else {
          tip.textContent = '路线规划失败，直线距离约 ' + fmtDistance(straight) +
            '。可在腾讯地图 App 里搜索「' + target.lat.toFixed(5) + ',' + target.lng.toFixed(5) + '」。'
        }
      }
    )
  } catch (e) {
    tip.textContent = '路线规划出错：' + (e.message || '未知') + '；直线距离约 ' + fmtDistance(straight)
  }
}

/* ---------- 打开「我的位置」概览 ---------- */
function openMyLocationBoard() {
  if (!navigator.geolocation) return toast('当前浏览器不支持定位')
  toast('正在定位…', 1500)
  geoPromise().then(g => {
    if (!g) return toast('定位失败，请检查浏览器的定位权限')
    openLocationView({
      lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6),
      name: '我的位置', addr: '', acc: g.acc || 0,
    }, '我的位置')
  })
}
