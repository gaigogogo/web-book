// 书签中心前端（EdgeOne Makers 同源版）
const API = "";
let TOKEN = localStorage.getItem("bm_token") || "";
let CATS = [];
let BMS = [];
let ICONS = {};
let GROUPS = [{ id: "personal", name: "个人区" }, { id: "work", name: "工作区" }];
let SITE = { name: "gai溜子导航站", author: "gai溜子到处跑", url: "www.090803.xyz" };
const VERSION = "202610241135";
const APP_VERSION = "v4.12-noteone";
const SNAPSHOT_VERSION = 4;
const REPO_URL = "https://github.com/gaigogogo/web-book";
let SEARCH_Q = "";
let GROUP = localStorage.getItem("bm_group") || "personal";
let ACTIVE_CAT = "all";
let DRAG_BM = null; // 当前被拖拽的书签
let DRAG_CAT = null; // 当前被拖拽的分类
let DRAG_GRP = null; // 当前被拖拽的分区
let EDIT_MODE = false;
function clearDropHints() {
  document.querySelectorAll(".drop-ok, .drop-before, .drop-after").forEach((n) => n.classList.remove("drop-ok", "drop-before", "drop-after"));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m])); }

function hl(text, q) {
  const s = String(text == null ? "" : text);
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length));
}

function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function renderSkeleton() {
  const c = el("content"); if (!c || c.children.length) return;
  let h = "";
  for (let sk = 0; sk < 3; sk++) {
    h += '<div class="sec skel-sec"><div class="skel-head"></div><div class="items">';
    for (let i = 0; i < 5; i++) h += '<div class="skel-item"></div>';
    h += "</div></div>";
  }
  c.innerHTML = h;
}

function letterIconSvg(host) {
  const ch = (host || "?").charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" rx="4" fill="#4b5563"/><text x="9" y="13" font-size="12" text-anchor="middle" fill="#fff" font-family="sans-serif">${ch}</text></svg>`;
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}
// 有整包图标时直接用内联 data URL；没有（本地快照首帧）才按需向服务端取
const ICON_BUST = {};
function iconSrc(host) {
  if (!host) return letterIconSvg("?");
  if (ICONS[host]) return ICONS[host];
  const b = ICON_BUST[host] ? "&t=" + ICON_BUST[host] : "";
  return "/api/icon?host=" + encodeURIComponent(host) + b;
}

function iconError(img, host) {
  img.onerror = null;
  img.src = letterIconSvg(host);
}

async function fetchWithRetry(url, opts = {}, retries = 1) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(timer);
      if (res.ok || res.status === 401 || attempt === retries) return res;
      last = new Error("HTTP " + res.status);
    } catch (e) {
      clearTimeout(timer); last = e;
      if (attempt === retries) throw e;
    }
  }
  throw last || new Error("网络请求失败");
}

async function callApi(path, opts = {}) {
  if(!navigator.onLine && opts.method && opts.method!=="GET")throw new Error("离线只读，请联网后修改");
  const headers = Object.assign({}, opts.headers || {});
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetchWithRetry(API + "/api" + path, Object.assign({}, opts, { headers }), opts.method && opts.method !== "GET" ? 0 : 1);
  if (res.status === 401) {
    TOKEN = ""; localStorage.removeItem("bm_token"); updateLoginBtn();
    openLogin(); throw new Error("unauthorized");
  }
  return res;
}

function updateLoginBtn() {
  el("btnLogin").textContent = TOKEN ? "退出" : "登录";
  el("btnLogin").className = TOKEN ? "ghost" : "primary";
}

function applyData(j) {
  GROUPS = j.groups || GROUPS;
  CATS = j.categories || CATS;
  BMS = j.bookmarks || BMS;
  if (j.site) SITE = j.site;
  if (!GROUPS.find((g) => g.id === GROUP)) { const sg = sortedGroups(); GROUP = sg[0] ? sg[0].id : "personal"; }
  render();
  renderSite();
}

let mutationEpoch = 0;
let pendingMove = false;
let pendingSave = false;
function persistCurrentData() {
  try { localStorage.setItem("bm_snapshot", JSON.stringify({version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS})); } catch {}
}
function commitBookmark(b) {
  const i = BMS.findIndex(x => x.id === b.id);
  if (i < 0) BMS.push(b); else BMS[i] = b;
  mutationEpoch++; persistCurrentData(); render();
}
async function saveMove(bm, patch, message) {
  if (pendingMove || pendingSave) return toast("正在保存，请稍候");
  await needAuth();
  if (pendingMove || pendingSave) return;
  pendingMove = true;
  const current = BMS.find(x => x.id === bm.id);
  if (!current) { pendingMove = false; return; }
  const previous = {...current};
  mutationEpoch++;
  Object.assign(current, patch); render(); toast("正在保存…");
  try {
    const r = await callApi("/bookmarks/" + bm.id, {method:"PUT", body:JSON.stringify(patch)});
    if (!r.ok) throw new Error("移动失败");
    commitBookmark(await r.json()); toast(message);
  } catch (e) {
    commitBookmark(previous); toast("移动未确认，已恢复原位置，请刷新核对");
  } finally { pendingMove = false; }
}
async function loadData(force = false) {
  if (pendingMove) return false;
  const epoch = mutationEpoch;
  let cachedData = "";
  // 1) 先用本地快照秒开（离线缓存），避免首屏白屏
  try {
    const snap = JSON.parse(localStorage.getItem("bm_snapshot") || "null");
    if (!force && snap && snap.version === SNAPSHOT_VERSION && Array.isArray(snap.categories)) { ICONS = snap.icons || {}; applyData(snap); cachedData = JSON.stringify({groups:GROUPS,categories:CATS,bookmarks:BMS,site:SITE,icons:ICONS}); }
  } catch {}
  if (!BMS.length) renderSkeleton();
  // 2) 再拉一次服务端全量（单请求，复用 HTML 里提前发出的那个请求，省一个 RTT）
  try {
    let r;
    if (window.__boot) { r = await window.__boot; window.__boot = null; }
    else r = await callApi("/bootstrap?icons=1", force ? {cache:"no-store"} : {});
    // 预加载失败时再走一次带超时/重试的请求，避免冷启动或瞬时网络错误导致白屏
    if (r.status === 599) r = await callApi("/bootstrap?icons=1");
    if (r.status === 401) {
      TOKEN = ""; localStorage.removeItem("bm_token"); updateLoginBtn();
      openLogin(); throw new Error("unauthorized");
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (epoch !== mutationEpoch || pendingMove) return false;
    if (j.icons) ICONS = j.icons;
    const incoming = JSON.stringify({groups:j.groups,categories:j.categories,bookmarks:j.bookmarks,site:j.site,icons:j.icons || ICONS});
    if (incoming !== cachedData) applyData(j);
    try {
      localStorage.setItem("bm_snapshot", JSON.stringify({ version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS }));
    } catch {}
    return true;
  } catch (e) { if (e.message !== "unauthorized") toast(cachedData ? "已显示本地缓存，暂时无法同步最新内容" : "加载失败：" + e.message); return false; }
}

el("btnRefreshData").onclick = async () => {
  const btn = el("btnRefreshData");
  btn.disabled = true; btn.textContent = "刷新中…";
  try { if (await loadData(true)) toast("已刷新为最新内容"); }
  finally { btn.disabled = false; btn.textContent = "刷新数据"; }
};

function groupName(id) { const g = GROUPS.find((x) => x.id === id); return g ? g.name : "个人区"; }
function sortedCats() { return [...CATS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }
function sortedGroups() { return [...GROUPS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }
function sortedBms() { return [...BMS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }
function bmsOfCat(cid) { return sortedBms().filter((b) => b.category_id === cid && b.group === GROUP); }
function bmCount(cid) { return BMS.filter((b) => b.category_id === cid && b.group === GROUP).length; }
function bmsOfUncat() { return groupBms().filter((b) => !b.category_id); }
function groupBms() { return sortedBms().filter((b) => b.group === GROUP); }
function groupCats() { return sortedCats().filter((c) => c.group === GROUP); }

function render() {
  renderTabs();
  renderCatNav();
  renderMain();
}

function renderSite() {
  const name = SITE.name || "我的导航站";
  el("siteName").textContent = name;
  document.title = name;
  el("siteAuthor").textContent = SITE.author || "";
  const u = (SITE.url || "").trim();
  el("siteUrl").textContent = u;
  el("siteUrl").href = /^https?:\/\//i.test(u) ? u : (u ? "https://" + u : "#");
  el("siteVer").textContent = APP_VERSION.replace(/-noteone$/, " · EdgeOne");
}

function renderTabs() {
  const tabs = el("groupTabs"); tabs.innerHTML = "";
  for (const g of sortedGroups()) {
    const b = document.createElement("button");
    b.dataset.g = g.id;
    b.textContent = g.name;
    if (g.id === GROUP) b.classList.add("active");
    tabs.appendChild(b);
  }
}

function navIcon(name) {
  let shape='<path d="M3 6h6l2 2h10v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>';
  if(name==="all")shape='<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>';
  else if(/nas|服务器|idc/i.test(name))shape='<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>';
  else if(/cf|云|腾讯/i.test(name))shape='<path d="M7 18a5 5 0 1 1 .5-10 6 6 0 0 1 11.4 2A4 4 0 0 1 18 18Z"/>';
  else if(/pc|win|mac|电脑/i.test(name))shape='<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>';
  else if(/导航|tools|工具/i.test(name))shape='<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/>';
  else if(/屏蔽|机场|翻墙/i.test(name))shape='<path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Z"/>';
  else if(/ai|模型|gpt/i.test(name))shape='<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z"/>';
  return '<span class="cat-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">'+shape+'</svg></span>';
}
function renderCatNav() {
  const list = el("catList"); list.innerHTML = "";
  el("sideCategoryCount").textContent=groupCats().length+" 组";
  const all = document.createElement("div");
  all.className = "cat" + (ACTIVE_CAT === "all" ? " active" : "");
  all.dataset.virtual = "1";
  all.innerHTML = navIcon("all")+`<span class="name">全部</span><span class="cnt">${groupBms().length}</span>`;
  all.onclick = () => { SEARCH_Q = ""; if (el("search")) el("search").value = ""; ACTIVE_CAT = "all"; render(); };
  list.appendChild(all);
  for (const c of groupCats()) {
    const d = document.createElement("div");
    d.className = "cat" + (ACTIVE_CAT === c.id ? " active" : "");
    d._cat = c;
    d.draggable = true;
    d.innerHTML = navIcon(c.name)+`<span class="name">${esc(c.name)}</span><span class="cnt">${bmCount(c.id)}</span><span class="add" role="button" tabindex="0" title="添加书签到「${esc(c.name)}」">＋</span>`;
    d.onclick = () => { SEARCH_Q = ""; if (el("search")) el("search").value = ""; ACTIVE_CAT = c.id; render(); };
    const addBtn = d.querySelector(".add");
    if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); addBmTo(c.id); };
    const tools=document.createElement("span");tools.className="cat-tools";
    for(const [text,action]of [["编辑",()=>editCat(c)],["删除",()=>delCat(c)]]){const button=document.createElement("button");button.className="small";button.textContent=text;button.onclick=e=>{e.stopPropagation();action();};tools.appendChild(button);}
    for(const direction of [-1,1]){const button=document.createElement("button");button.className="small";button.textContent=direction<0?"↑":"↓";button.onclick=async e=>{e.stopPropagation();if(pendingMove||pendingSave)return toast("请等待当前操作完成");const list=groupCats(),i=list.findIndex(x=>x.id===c.id),next=list[i+direction];if(!next)return;const filtered=list.filter(x=>x.id!==c.id),ni=filtered.findIndex(x=>x.id===next.id)+(direction>0?1:0);try{await needAuth();if(!TOKEN)return;const r=await callApi("/categories/"+c.id,{method:"PUT",body:JSON.stringify({sort:insertSort(filtered,ni)})});if(!r.ok)throw Error();Object.assign(c,await r.json());mutationEpoch++;persistCurrentData();render();}catch{toast("排序未确认，请刷新核对");}};tools.appendChild(button);}
    d.appendChild(tools);
    d.addEventListener("dragstart", (e) => {
      DRAG_CAT = c; e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", c.id); } catch {}
      d.classList.add("dragging");
    });
    d.addEventListener("dragend", () => { d.classList.remove("dragging"); clearDropHints(); DRAG_CAT = null; });
    list.appendChild(d);
  }
  const add = document.createElement("button");
  add.className = "ghost small"; add.style.cssText = "margin:10px 14px 0";
  add.textContent = "+ 新建分类";
  add.onclick = () => addCat();
  list.appendChild(add);
}

function renderMain() {
  updateSearchClear();
  if (SEARCH_Q) { renderSearch(SEARCH_Q); return; }
  const c = el("content"); c.innerHTML = "";
  el("curTitle").textContent = groupName(GROUP);
  const gbms = groupBms();
  el("curCount").textContent = `${gbms.length} 书签 / ${groupCats().length} 分类`;

  if (ACTIVE_CAT !== "all") {
    const cat = groupCats().find((x) => x.id === ACTIVE_CAT);
    if (!cat) { ACTIVE_CAT = "all"; return renderMain(); }
    const items = bmsOfCat(cat.id);
    c.appendChild(section(cat.name, items.length, items, cat));
    return;
  }

  if (!gbms.length && !groupCats().length) {
    c.innerHTML = `<div class="empty">当前分区还没有内容，点击「+ 书签」或「+ 新建分类」开始添加。</div>`;
    return;
  }

  for (const cat of groupCats()) {
    const items = bmsOfCat(cat.id);
    c.appendChild(section(cat.name, items.length, items, cat));
  }
  const uncat = gbms.filter((b) => !b.category_id);
  if (uncat.length) c.appendChild(section("未分类", uncat.length, uncat, null));
}

function renderSearch(q) {
  const c = el("content"); c.innerHTML = "";
  el("curTitle").textContent = "搜索";
  const ql = q.toLowerCase();
  // 全局搜索：跨所有分区 + 所有分类
  const hits = sortedBms().filter((b) => {
    const cat = sortedCats().find((x) => x.id === b.category_id);
    const catName = cat ? cat.name : "";
    return (b.title || "").toLowerCase().includes(ql) ||
           (b.url || "").toLowerCase().includes(ql) ||
           (b.note || "").toLowerCase().includes(ql) ||
           catName.toLowerCase().includes(ql);
  });
  el("curCount").textContent = hits.length + " 个结果（跨分区 / 分类）";
  if (!hits.length) { c.innerHTML = '<div class="empty">没有匹配「' + esc(q) + '」的书签</div>'; return; }
  const byKey = {};
  for (const b of hits) {
    const cat = sortedCats().find((x) => x.id === b.category_id);
    const gName = (GROUPS.find((g) => g.id === b.group) || {}).name || (b.group || "未分区");
    const cName = cat ? cat.name : "未分类";
    const key = gName + " / " + cName;
    (byKey[key] = byKey[key] || []).push(b);
  }
  const ordered = Object.keys(byKey).sort((a, b) => a.localeCompare(b));
  for (const key of ordered) {
    c.appendChild(section(key, byKey[key].length, byKey[key], null));
  }
}

function section(title, count, items, cat) {
  const sec = document.createElement("section"); sec.className = "sec"; sec._cat = cat || null;
  const head = document.createElement("div"); head.className = "sec-head";
  head.innerHTML = `<h4>${esc(title)}</h4><span class="count">${count}</span>`;
  sec.appendChild(head);
  const box = document.createElement("div"); box.className = "items";
  if (!items.length) {
    box.innerHTML = `<div class="empty" style="padding:10px 0">该分类下暂无书签</div>`;
  } else {
    for (const b of items) box.appendChild(bmItem(b));
  }
  sec.appendChild(box);
  return sec;
}

function bmItem(b) {
  const h = hostOf(b.url);
  const d = document.createElement("div"); d.className = "item"; d._bm = b; d.draggable = true;
  d.tabIndex=0;d.setAttribute("role","link");d.setAttribute("aria-label",b.title||b.url);
  d.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target===d&&!EDIT_MODE){e.preventDefault();window.open(b.url,"_blank");}});
  d.title = [b.title, b.url, b.note].filter(Boolean).join("\n");
  const note = String(b.note || b.notes || b.remark || b.description || "").trim();
  const noteMark = note ? `<span class="note-mark" data-note="${esc(note)}" role="img" tabindex="0" aria-label="备注：${esc(note)}">!</span>` : "";
  d.innerHTML = `<span class="icon-wrap"><img src="${iconSrc(h)}" alt="" width="22" height="22" loading="lazy" decoding="async" referrerpolicy="no-referrer"/>${noteMark}</span><span class="bm-copy"><span class="t">${hl(b.title || b.url, SEARCH_Q)}</span><span class="bm-host">${esc(h.replace(/^www\./,""))||"自定义链接"}</span></span><button class="add bm-add" type="button" title="添加到本分类" aria-label="添加到本分类">＋</button>`;
  const img = d.querySelector("img");
  const noteButton=d.querySelector(".note-mark");
  if(noteButton){noteButton.setAttribute("role","button");noteButton.onclick=e=>{e.stopPropagation();toast(note);};noteButton.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();toast(note);}};}
  img.addEventListener("error", () => iconError(img, h), { once: true });
  const state = document.createElement("span");
  state.className = "link-state " + (b.link_status || "");
  const label = b.link_checked_at && Date.now() - b.link_checked_at < 10 * 60 * 1000
    ? {ok:"正常",broken:"失效",unknown:"待确认"}[b.link_status] : "";
  state.hidden = !label;
  if(label)state.dataset.expires=String(b.link_checked_at+10*60*1000);
  state.textContent = label || "";
  state.title = b.link_checked_at ? "最后检查：" + new Date(b.link_checked_at).toLocaleString() + (b.link_http_status ? " HTTP " + b.link_http_status : "") : "";
  if(label){state.tabIndex=0;state.setAttribute("role","button");state.onclick=e=>{e.stopPropagation();toast(state.title);};state.onkeydown=e=>{if(e.key==="Enter"){e.stopPropagation();toast(state.title);}};}
  d.appendChild(state);
  const tools=document.createElement("div"); tools.className="edit-tools";
  for(const [label,action] of [["编辑",()=>editBm(b)],["删除",()=>delBm(b)]]) {
    const button=document.createElement("button");button.textContent=label;
    button.onclick=e=>{e.stopPropagation();action();};tools.appendChild(button);
  }
  for(const direction of [-1,1]) {
    const button=document.createElement("button");button.textContent=direction<0?"前移":"后移";
    button.onclick=e=>{e.stopPropagation();const list=sortedBms().filter(x=>x.group===b.group&&x.category_id===b.category_id);const i=list.findIndex(x=>x.id===b.id),next=list[i+direction];if(!next)return;const filtered=list.filter(x=>x.id!==b.id);const ni=filtered.findIndex(x=>x.id===next.id)+(direction>0?1:0);applyMove(b,{sort:insertSort(filtered,ni)});};tools.appendChild(button);
  }
  d.appendChild(tools);
  d.addEventListener("click",e=>{if(d._suppressClick>Date.now()){e.preventDefault();e.stopPropagation();}},true);
  let press=0,start;
  d.addEventListener("pointerdown",e=>{if(e.pointerType==="mouse"||e.target.closest("button"))return;start={x:e.clientX,y:e.clientY};press=setTimeout(()=>{d._suppressClick=Date.now()+1000;showBookmarkMenu(b,start.x,start.y);},550);});
  const cancel=()=>{clearTimeout(press);press=0;};
  d.addEventListener("pointermove",e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>10)cancel();});
  for(const name of ["pointerup","pointercancel","dragstart"])d.addEventListener(name,cancel);
  const addB = d.querySelector(".bm-add");
  if (addB) {
    addB.addEventListener("mousedown", (e) => e.stopPropagation());
    addB.onclick = (e) => { e.stopPropagation(); addBmTo(b.category_id); };
  }
  d.addEventListener("dragstart", (e) => {
    DRAG_BM = b;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", b.id); } catch {}
    d.classList.add("dragging");
  });
  d.addEventListener("dragend", () => { d.classList.remove("dragging"); clearDropHints(); DRAG_BM = null; });
  return d;
}

// ---------------- 右键菜单 ----------------
// items 支持：{label, onClick, danger} 普通项；{label, submenu:[...]} 子菜单；{sep:true} 分隔线
function showCtx(x, y, items) {
  const m = el("ctxMenu");
  m.innerHTML = "";
  fillCtx(m, items);
  m.classList.add("show");
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}
function fillCtx(m, items) {
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); continue; }
    const d = document.createElement("div");
    d.className = "ctx-item" + (it.danger ? " danger" : "") + (it.submenu ? " has-sub" : "");
    d.innerHTML = `<span>${esc(it.label)}</span>` + (it.submenu ? `<span class="ctx-arrow">▸</span>` : "");
    if (it.submenu) {
      d.addEventListener("mouseenter", () => {
        m.querySelectorAll(".ctx-sub").forEach((n) => n.remove());
        const sub = document.createElement("div");
        sub.className = "ctx ctx-sub";
        fillCtx(sub, it.submenu);
        m.appendChild(sub);
        const dr = d.getBoundingClientRect();
        sub.style.left = (dr.right - 4) + "px";
        sub.style.top = dr.top + "px";
        const sr = sub.getBoundingClientRect();
        if (sr.right > window.innerWidth - 8) sub.style.left = (dr.left - sr.width + 4) + "px";
        if (sr.bottom > window.innerHeight - 8) sub.style.top = (window.innerHeight - sr.height - 8) + "px";
      });
    } else {
      d.onclick = () => { hideCtx(); it.onClick && it.onClick(); };
    }
    m.appendChild(d);
  }
}
function hideCtx() { el("ctxMenu").classList.remove("show"); }

document.addEventListener("click", hideCtx);
document.addEventListener("scroll", hideCtx, true);

el("content").addEventListener("contextmenu", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  e.preventDefault();
  const b = item._bm;
  showBookmarkMenu(b,e.clientX,e.clientY);
});
function showBookmarkMenu(b,x,y) {
  showCtx(x, y, [
    { label: "打开链接", onClick: () => window.open(b.url, "_blank") },
    { label: "编辑", onClick: () => editBm(b) },
    { label: "刷新图标", onClick: () => refreshBmIcon(b) },
    { label: "删除", danger: true, onClick: () => delBm(b) },
  ]);
}
el("catList").addEventListener("contextmenu", (e) => {
  const cat = e.target.closest(".cat");
  if (!cat || cat.dataset.virtual) return;
  e.preventDefault();
  const c = cat._cat;
  const groupItems = GROUPS.map((g) => ({
    label: (g.id === c.group ? "✓ " : "") + g.name,
    onClick: () => moveCatToGroup(c, g.id),
  }));
  showCtx(e.clientX, e.clientY, [
    { label: "编辑", onClick: () => editCat(c) },
    { label: "移动到分区", submenu: groupItems },
    { label: "删除", danger: true, onClick: () => delCat(c) },
  ]);
});
// 左键点击书签仍打开链接
el("content").addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (item && item._bm && !EDIT_MODE && !(item._suppressClick>Date.now())) window.open(item._bm.url, "_blank");
});

// ---------------- 拖拽：书签 & 分类 ----------------
// 书签：
//   拖到分区标签   -> 改 group（归入该分区「未分类」）
//   拖到分类区/书签 -> 改 category_id + group，并按落点插入排序（移动位置）
//   拖到「未分类」区 -> 取消分类、留当前分区，并按落点排序
// 分类（左侧列表）：
//   拖到分区标签   -> 改 group（整组搬家，书签级联跟随）
//   在列表内拖动   -> 改 sort（调整分类显示顺序）
function insertSort(filtered, idx) {
  if (!filtered.length) return 0;
  if (idx <= 0) return filtered[0].sort - 1;
  if (idx >= filtered.length) return filtered[filtered.length - 1].sort + 1;
  return (filtered[idx - 1].sort + filtered[idx].sort) / 2;
}

el("groupTabs").addEventListener("dragover", (e) => {
  const b = e.target.closest("button[data-g]");
  if (b && (DRAG_BM || DRAG_CAT)) { e.preventDefault(); clearDropHints(); b.classList.add("drop-ok"); }
});
el("groupTabs").addEventListener("drop", async (e) => {
  const b = e.target.closest("button[data-g]");
  if (!b) return;
  if (DRAG_BM) {
    e.preventDefault(); b.classList.remove("drop-ok"); moveToGroup(DRAG_BM, b.dataset.g);
  } else if (DRAG_CAT) {
    e.preventDefault(); b.classList.remove("drop-ok");
    if (DRAG_CAT.group === b.dataset.g) { toast("已在该分区"); return; }
    await needAuth();
    const r = await callApi("/categories/" + DRAG_CAT.id, { method: "PUT", body: JSON.stringify({ group: b.dataset.g }) });
    if (r.ok) { toast("已移动到「" + groupName(b.dataset.g) + "」"); await loadData(); renderGroupManage(); } else toast("移动失败");
  }
});

el("content").addEventListener("dragover", (e) => {
  if (!DRAG_BM) return;
  const sec = e.target.closest(".sec");
  if (!sec) return;
  e.preventDefault(); clearDropHints(); sec.classList.add("drop-ok");
  const item = e.target.closest(".item");
  if (item && item._bm && item._bm.id !== DRAG_BM.id) {
    const r = item.getBoundingClientRect();
    item.classList.add((e.clientY - r.top) < r.height / 2 ? "drop-before" : "drop-after");
  }
});
el("content").addEventListener("drop", (e) => {
  if (!DRAG_BM) return;
  const sec = e.target.closest(".sec");
  if (!sec) return;
  e.preventDefault(); clearDropHints();
  const cat = sec._cat; // null = 未分类
  const list = sortedBms().filter((b) => cat ? (b.category_id === cat.id && b.group === cat.group) : (!b.category_id && b.group === GROUP));
  const filtered = list.filter((b) => b.id !== DRAG_BM.id);
  const item = e.target.closest(".item");
  let idx = filtered.length;
  if (item && item._bm && item._bm.id !== DRAG_BM.id) {
    const r = item.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    const i = filtered.findIndex((b) => b.id === item._bm.id);
    if (i >= 0) idx = before ? i : i + 1;
  }
  applyMove(DRAG_BM, { category_id: cat ? cat.id : null, group: cat ? cat.group : GROUP, sort: insertSort(filtered, idx) });
});

// 左侧分类列表：拖动分类改顺序 / 拖到分区标签搬家
el("catList").addEventListener("dragover", (e) => {
  if (!DRAG_CAT) return;
  const c = e.target.closest(".cat");
  if (!c || c.dataset.virtual) return;
  e.preventDefault(); clearDropHints();
  const r = c.getBoundingClientRect();
  c.classList.add((e.clientY - r.top) < r.height / 2 ? "drop-before" : "drop-after");
});
el("catList").addEventListener("drop", async (e) => {
  if (!DRAG_CAT) return;
  const c = e.target.closest(".cat");
  if (!c || c.dataset.virtual) return;
  e.preventDefault(); clearDropHints();
  const target = c._cat;
  if (!target || target.id === DRAG_CAT.id) return;
  const list = groupCats().filter((x) => x.id !== DRAG_CAT.id);
  const r = c.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  const i = list.findIndex((x) => x.id === target.id);
  const idx = i >= 0 ? (before ? i : i + 1) : list.length;
  await needAuth();
  const rr = await callApi("/categories/" + DRAG_CAT.id, { method: "PUT", body: JSON.stringify({ sort: insertSort(list, idx) }) });
  if (rr.ok) { toast("已调整顺序"); await loadData(); } else toast("排序失败");
});

async function moveToGroup(bm, groupId) {
  if (bm.group === groupId) { toast("已在「" + groupName(groupId) + "」"); return; }
  await saveMove(bm, {group:groupId, category_id:null}, "已移动到「" + groupName(groupId) + "」");
}
async function moveCatToGroup(c, groupId) {
  if (c.group === groupId) { toast("已在「" + groupName(groupId) + "」"); return; }
  await needAuth();
  const r = await callApi("/categories/" + c.id, { method: "PUT", body: JSON.stringify({ group: groupId }) });
  if (r.ok) { toast("已移动到「" + groupName(groupId) + "」"); await loadData(); renderGroupManage(); } else toast("移动失败");
}
async function applyMove(bm, patch) {
  await saveMove(bm, patch, "已保存");
}

// ---------------- 分类 ----------------
function addCat() {
  el("catTitle").textContent = "新建分类";
  el("catName").value = "";
  fillGroupSelect("catGroup", GROUP);
  el("catModal")._id = null;
  show("catModal"); el("catName").focus();
}
function editCat(c) {
  el("catTitle").textContent = "编辑分类";
  el("catName").value = c.name;
  fillGroupSelect("catGroup", c.group || "personal");
  el("catModal")._id = c.id;
  show("catModal"); el("catName").focus();
}
let CAT_DELETE_BUSY = false;
function confirmCatDelete(c) {
  el("catDeleteTitle").textContent = "删除分类";
  el("catDeleteMessage").textContent = "删除分类「" + c.name + "」及其下 " + BMS.filter((b) => b.category_id === c.id).length + " 个书签？";
  show("catDeleteModal");
  el("catDeleteCancel").focus();
  return new Promise((resolve) => { el("catDeleteModal")._resolve = resolve; });
}
function resolveCatDelete(ok) {
  const modal = el("catDeleteModal");
  const resolve = modal._resolve;
  modal._resolve = null;
  hide("catDeleteModal");
  if (resolve) resolve(ok);
}
el("catDeleteCancel").onclick = () => resolveCatDelete(false);
el("catDeleteOk").onclick = () => resolveCatDelete(true);
async function delCat(c) {
  if (CAT_DELETE_BUSY) return;
  CAT_DELETE_BUSY = true;
  try {
    if (!await confirmCatDelete(c)) return;
    await needAuth();
    if (!TOKEN) return;
    const r = await callApi("/categories/" + encodeURIComponent(c.id), { method: "DELETE" });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.error || "HTTP " + r.status);
    }
    // 使用成功响应更新本地列表，避免立即重读 KV 时旧数据让分类重新出现。
    CATS = CATS.filter((cat) => cat.id !== c.id);
    BMS = BMS.filter((b) => b.category_id !== c.id);
    if (ACTIVE_CAT === c.id) ACTIVE_CAT = "all";
    render();
    try {
      localStorage.setItem("bm_snapshot", JSON.stringify({ version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS }));
    } catch {}
    toast("已删除");
  } catch (e) {
    if (e.message !== "unauthorized") toast("删除失败：" + e.message);
  } finally {
    CAT_DELETE_BUSY = false;
  }
}

// ---------------- 书签 ----------------
function addBm() {
  el("bmTitle").textContent = "新建书签";
  el("bmTitle_in").value = ""; el("bmUrl").value = ""; el("bmNote").value = "";
  fillGroupSelect("bmGroup", GROUP); fillCatSelect("");
  el("bmModal")._id = null; el("bmModal")._toCat = null; show("bmModal"); el("bmUrl").focus();
}
// 从分类行的「＋」进来：新书签直接归入该分类，并排在该分类最前
function addBmTo(catId) {
  const cat = CATS.find((x) => x.id === catId);
  if (!cat) return addBm();
  el("bmTitle").textContent = "添加到「" + cat.name + "」";
  el("bmTitle_in").value = ""; el("bmUrl").value = ""; el("bmNote").value = "";
  fillGroupSelect("bmGroup", cat.group || GROUP); fillCatSelect(cat.id);
  el("bmModal")._id = null; el("bmModal")._toCat = cat.id;
  show("bmModal"); el("bmUrl").focus();
}
function editBm(b) {
  el("bmTitle").textContent = "编辑书签";
  el("bmTitle_in").value = b.title || ""; el("bmUrl").value = b.url || ""; el("bmNote").value = b.note || "";
  fillGroupSelect("bmGroup", b.group || GROUP); fillCatSelect(b.category_id || "");
  el("bmModal")._id = b.id; el("bmModal")._toCat = null; show("bmModal");
}
function fillCatSelect(sel) {
  const s = el("bmCat"); s.innerHTML = `<option value="">（未分类）</option>`;
  const group=el("bmGroup").value||GROUP;
  for (const c of sortedCats().filter(c=>c.group===group)) s.insertAdjacentHTML("beforeend", `<option value="${c.id}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`);
}
function fillGroupSelect(selId, val) {
  const s = el(selId); s.innerHTML = "";
  for (const g of sortedGroups()) s.insertAdjacentHTML("beforeend", `<option value="${g.id}"${g.id === val ? " selected" : ""}>${esc(g.name)}</option>`);
}
async function delBm(b) {
  if (CAT_DELETE_BUSY || pendingMove || pendingSave) return toast("正在处理，请稍候");
  CAT_DELETE_BUSY = true;
  pendingSave = true;
  try {
    el("catDeleteTitle").textContent = "删除书签";
    el("catDeleteMessage").textContent = "删除书签「" + (b.title || b.url) + "」？";
    show("catDeleteModal"); el("catDeleteCancel").focus();
    if (!await new Promise(resolve => { el("catDeleteModal")._resolve = resolve; })) return;
    await needAuth();
    if (!TOKEN) return;
    pendingSave = true;
    toast("正在删除…");
    const r = await callApi("/bookmarks/" + encodeURIComponent(b.id), {method:"DELETE"});
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.error || "HTTP " + r.status);
    }
    BMS = BMS.filter(x => x.id !== b.id);
    mutationEpoch++; persistCurrentData(); render(); toast("已删除");
  } catch (e) {
    if (e.message !== "unauthorized") toast("删除未确认，请刷新核对：" + e.message);
  } finally { CAT_DELETE_BUSY = false; pendingSave = false; }
}
async function refreshBmIcon(b) {
  const h = hostOf(b.url); if (!h) return;
  await needAuth();
  toast("正在刷新图标…");
  const r = await callApi("/icons/refresh", { method: "POST", body: JSON.stringify({ host: h }) });
  if (r.ok) {
    const x = await r.json();
    toast(x.hasIcon ? "图标已更新" : "未获取到，已用占位图");
    await loadData();
  } else toast("刷新失败");
}

// ---------------- 鉴权 ----------------
function show(id) { el(id).classList.add("show"); }
function hide(id) { el(id).classList.remove("show"); }
function openLogin() { el("pwd").value = ""; show("loginModal"); el("pwd").focus(); }
async function needAuth() {
  if (TOKEN) return;
  openLogin();
  return new Promise((resolve) => { el("loginModal")._resolve = resolve; });
}
el("btnLogin").onclick = async () => {
  if (TOKEN) {
    try { await callApi("/logout", { method: "POST" }); } catch {}
    TOKEN = ""; localStorage.removeItem("bm_token"); updateLoginBtn(); toast("已退出");
    localStorage.removeItem("bm_snapshot");localStorage.removeItem("bm_offline");
    if(navigator.serviceWorker) {const registration=await navigator.serviceWorker.getRegistration();registration?.active?.postMessage({type:"CLEAR_OFFLINE"});}
    setTimeout(() => location.reload(), 300);
  } else openLogin();
};
el("loginCancel").onclick = () => { hide("loginModal"); resolveLogin(false); };
el("loginOk").onclick = async () => {
  const r = await callApi("/login", { method: "POST", body: JSON.stringify({ password: el("pwd").value }) });
  if (r.ok) {
    const j = await r.json(); TOKEN = j.token; localStorage.setItem("bm_token", TOKEN); updateLoginBtn(); hide("loginModal"); toast("登录成功"); resolveLogin(true);
  } else { toast("密码错误"); resolveLogin(false); }
};
el("pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") el("loginOk").click(); });
function resolveLogin(ok) {
  const r = el("loginModal")._resolve;
  el("loginModal")._resolve = null;
  if (r) r(ok);
}

// ---------------- 分类 / 书签 保存 ----------------
el("catCancel").onclick = () => hide("catModal");
el("catSave").onclick = async () => {
  await needAuth();
  const name = el("catName").value.trim(); if (!name) return toast("请输入名称");
  const payload = { name, group: el("catGroup").value };
  const id = el("catModal")._id;
  const r = id ? await callApi("/categories/" + id, { method: "PUT", body: JSON.stringify(payload) })
               : await callApi("/categories", { method: "POST", body: JSON.stringify(payload) });
  if (r.ok) { hide("catModal"); await loadData(); } else toast("保存失败");
};

el("bmCancel").onclick = () => { el("bmModal")._toCat = null; hide("bmModal"); };
el("bmSave").onclick = async () => {
  const btn = el("bmSave");
  if (btn.disabled || pendingMove || pendingSave) return;
  pendingSave = true;
  btn.disabled = true;
  const label = btn.textContent; btn.textContent = "保存中…";
  try {
  await needAuth();
  const url = el("bmUrl").value.trim(); if (!url) return toast("请输入 URL");
  const payload = {
    title: el("bmTitle_in").value.trim() || url,
    url,
    category_id: el("bmCat").value || null,
    group: el("bmGroup").value,
    note: el("bmNote").value.trim() || null
  };
  const id = el("bmModal")._id;
  const toCat = el("bmModal")._toCat;
  if (!id && toCat) {
    const sorts = BMS.filter((b) => b.category_id === toCat).map((b) => b.sort || 0);
    payload.sort = sorts.length ? Math.min.apply(null, sorts) - 1 : 0;
  }
  const r = id ? await callApi("/bookmarks/" + id, { method: "PUT", body: JSON.stringify(payload) })
               : await callApi("/bookmarks", { method: "POST", body: JSON.stringify(payload) });
  if (r.ok) {
    const saved = await r.json();
    hide("bmModal");
    const h = hostOf(payload.url);
    if (h) { delete ICONS[h]; ICON_BUST[h] = Date.now(); } // 让该图标重新拉取
    if (toCat) {
      const nm = (CATS.find((x) => x.id === toCat) || {}).name || "";
      el("bmModal")._toCat = null;
      SEARCH_Q = ""; if (el("search")) el("search").value = "";
      ACTIVE_CAT = "all";
      commitBookmark(saved);
      if (nm) toast("已添加到「" + nm + "」");
    } else { commitBookmark(saved); toast("已保存"); }
  } else toast("保存失败");
  } catch (e) { toast("保存未确认，请刷新核对后再试"); }
  finally { pendingSave = false; btn.disabled = false; btn.textContent = label; }
};

// ---------------- 设置抽屉 ----------------
el("btnSettings").onclick = () => { renderGroupManage(); show("settingsDrawer"); };
el("btnCloseSettings").onclick = () => hide("settingsDrawer");
el("settingsDrawer").onclick = (e) => { if (e.target === el("settingsDrawer")) hide("settingsDrawer"); };
el("btnAddBm").onclick = addBm;

// ---------------- 站点信息（首页展示，可在设置里修改） ----------------
el("btnEditSite").onclick = () => {
  el("siteNameIn").value = SITE.name || "";
  el("siteAuthorIn").value = SITE.author || "";
  el("siteUrlIn").value = SITE.url || "";
  show("siteModal");
};
el("siteCancel").onclick = () => hide("siteModal");
el("siteSave").onclick = async () => {
  await needAuth();
  const payload = {
    name: el("siteNameIn").value.trim() || "我的导航站",
    author: el("siteAuthorIn").value.trim(),
    url: el("siteUrlIn").value.trim(),
  };
  const r = await callApi("/site", { method: "PUT", body: JSON.stringify(payload) });
  if (r.ok) { SITE = await r.json(); hide("siteModal"); renderSite(); toast("已保存站点信息"); }
  else toast("保存失败");
};

function clearGrpHints() { document.querySelectorAll(".grp-row.drop-before, .grp-row.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after")); }
function renderGroupManage() {
  const box = el("groupList"); box.innerHTML = "";
  for (const g of sortedGroups()) {
    const row = document.createElement("div"); row.className = "grp-row"; row.draggable = true; row._g = g;
    row.innerHTML = `<span class="grp-drag" title="按住拖动排序">⠿</span><span class="grp-name">${esc(g.name)}</span>`;
    const ren = document.createElement("button");
    ren.className = "small"; ren.textContent = "重命名";
    ren.onclick = () => renameGroup(g);
    const del = document.createElement("button");
    del.className = "danger small"; del.textContent = "删除";
    del.onclick = async () => {
      if (GROUPS.length <= 1) return toast("至少保留一个分区");
      if (!confirm(`删除分区「${g.name}」？其下分类和书签会移到「${groupName(GROUPS.find((x) => x.id !== g.id).id)}」`)) return;
      await needAuth();
      const r = await callApi("/groups/" + g.id, { method: "DELETE" });
      if (r.ok) { const j = await r.json(); if (GROUP === g.id) GROUP = j.fallback; localStorage.setItem("bm_group", GROUP); toast("已删除分区"); await loadData(); renderGroupManage(); }
      else toast("删除失败");
    };
    row.appendChild(ren);
    row.appendChild(del);
    row.addEventListener("dragstart", (e) => { DRAG_GRP = g; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", g.id); } catch {} row.classList.add("dragging"); });
    row.addEventListener("dragend", () => { row.classList.remove("dragging"); clearGrpHints(); DRAG_GRP = null; });
    box.appendChild(row);
  }
  box.ondragover = (e) => {
    if (!DRAG_GRP) return;
    const row = e.target.closest(".grp-row"); if (!row || row._g.id === DRAG_GRP.id) return;
    e.preventDefault(); clearGrpHints();
    const r = row.getBoundingClientRect();
    row.classList.add((e.clientY - r.top) < r.height / 2 ? "drop-before" : "drop-after");
  };
  box.ondrop = async (e) => {
    if (!DRAG_GRP) return;
    const row = e.target.closest(".grp-row"); if (!row || row._g.id === DRAG_GRP.id) return;
    e.preventDefault(); clearGrpHints();
    const target = row._g;
    const list = sortedGroups().filter((x) => x.id !== DRAG_GRP.id);
    const r = row.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    const i = list.findIndex((x) => x.id === target.id);
    const idx = i >= 0 ? (before ? i : i + 1) : list.length;
    const sort = insertSort(list, idx);
    await needAuth();
    const rr = await callApi("/groups/" + DRAG_GRP.id, { method: "PUT", body: JSON.stringify({ sort }) });
    if (rr.ok) { toast("已调整顺序"); await loadData(); renderGroupManage(); } else toast("排序失败");
  };
}
el("btnAddGroup").onclick = async () => {
  const name = el("newGroupName").value.trim(); if (!name) return toast("请输入分区名");
  await needAuth();
  const r = await callApi("/groups", { method: "POST", body: JSON.stringify({ name }) });
  if (r.ok) { el("newGroupName").value = ""; toast("已添加分区"); await loadData(); renderGroupManage(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error || "添加失败"); }
};
function renameGroup(g) {
  el("grpTitle").textContent = "重命名分区";
  el("grpName").value = g.name;
  el("grpModal")._id = g.id;
  show("grpModal"); el("grpName").focus();
}
el("grpCancel").onclick = () => hide("grpModal");
el("grpSave").onclick = async () => {
  await needAuth();
  const name = el("grpName").value.trim(); if (!name) return toast("请输入名称");
  const id = el("grpModal")._id;
  const r = await callApi("/groups/" + id, { method: "PUT", body: JSON.stringify({ name }) });
  if (r.ok) { hide("grpModal"); toast("已重命名"); await loadData(); renderGroupManage(); }
  else toast("保存失败");
};
el("grpName").addEventListener("keydown", (e) => { if (e.key === "Enter") el("grpSave").click(); });

el("btnBackup").onclick = async () => {
  await needAuth();
  const r = await callApi("/backup");
  if (!r.ok) return toast("备份失败");
  const j = await r.json();
  const blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "bookmarks-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
  toast("已下载备份");
};
try { const _bak = localStorage.getItem("bakEmail"); if (_bak && el("bakEmail")) el("bakEmail").value = _bak; } catch {}
el("btnBackupEmail").onclick = async () => {
  await needAuth();
  const to = ((el("bakEmail").value) || "").trim();
  if (!to) return toast("请填收件邮箱");
  const btn = el("btnBackupEmail");
  const oldTxt = btn.textContent;
  btn.textContent = "发送中…"; btn.disabled = true;
  try {
    const r = await callApi("/backup-email", { method: "POST", body: JSON.stringify({ to: to }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { toast("备份成功，邮件已发送"); try { localStorage.setItem("bakEmail", to); } catch {} }
    else toast(j.error || ("发送失败（" + r.status + "）"));
  } catch (e) { toast("发送失败"); }
  finally { btn.textContent = oldTxt; btn.disabled = false; }
};
el("btnRestore").onclick = () => el("restoreFile").click();
el("restoreFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await needAuth();
  const text = await f.text();
  let j; try { j = JSON.parse(text); } catch { return toast("JSON 解析失败"); }
  const r = await callApi("/restore", { method: "POST", body: JSON.stringify(j) });
  if (r.ok) { const x = await r.json(); toast(`恢复完成：分类 ${x.categories} / 书签 ${x.bookmarks} / 图标 ${x.icons}`); await loadData(); }
  else toast("恢复失败");
  e.target.value = "";
};
el("btnWipe").onclick = async () => {
  if (!confirm("确定清空全部分类和书签？此操作不可恢复，建议先备份！")) return;
  await needAuth();
  const r = await callApi("/data", { method: "DELETE" });
  if (r.ok) { toast("已清空"); ACTIVE_CAT = "all"; await loadData(); } else toast("清空失败");
};
el("btnRefreshIcons").onclick = async () => {
  await needAuth();
  toast("正在更新图标…");
  const r = await callApi("/icons/refresh", { method: "POST" });
  if (r.ok) {
    const x = await r.json();
    const now = Date.now();
    BMS.forEach((b) => { const h = hostOf(b.url); if (h) ICON_BUST[h] = now; });
    ICONS = {}; // 强制重新从服务端取
    render();
    toast(`图标更新：${x.cached}/${x.hosts}`);
  } else toast("更新失败");
};
el("btnPwd").onclick = () => { el("pwdNew").value = ""; el("pwdNew2").value = ""; show("pwdModal"); el("pwdNew").focus(); };
el("pwdCancel").onclick = () => hide("pwdModal");
el("pwdOk").onclick = async () => {
  await needAuth();
  const p1 = el("pwdNew").value.trim(), p2 = el("pwdNew2").value.trim();
  if (!p1 || p1.length < 4) return toast("密码至少 4 位");
  if (p1 !== p2) return toast("两次密码不一致");
  const r = await callApi("/password", { method: "POST", body: JSON.stringify({ password: p1 }) });
  if (r.ok) {
    const j = await r.json(); TOKEN = j.token; localStorage.setItem("bm_token", TOKEN); updateLoginBtn();
    hide("pwdModal"); toast("密码已修改，请牢记新密码");
  } else toast("修改失败");
};

// ---------------- 访问锁 / 免密密钥 ----------------
let ACCESS = { gate: true, key: "" };
async function loadAccess() {
  try {
    const headers = {};
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const r = await fetch(API + "/api/access", { headers });
    if (!r.ok) return;
    ACCESS = await r.json();
    el("btnGate").textContent = ACCESS.gate ? "已开启（点击关闭）" : "已关闭（点击开启）";
    el("btnGate").className = ACCESS.gate ? "primary small" : "small";
  } catch {}
}
function updateAccessLink() {
  const k = el("accessKeyIn").value.trim();
  el("accessLink").value = k ? location.origin + "/k/" + k : "";
}
el("btnGate").onclick = async () => {
  await needAuth();
  const r = await callApi("/access", { method: "POST", body: JSON.stringify({ gate: !ACCESS.gate }) });
  if (r.ok) {
    ACCESS = await r.json();
    await loadAccess();
    toast(ACCESS.gate ? "访问锁已开启，进站需要密码" : "访问锁已关闭，站点公开只读");
  } else toast("操作失败");
};
el("btnAccessKey").onclick = async () => {
  await needAuth();
  await loadAccess();
  el("accessKeyIn").value = ACCESS.key || "";
  updateAccessLink();
  show("accessModal");
};
el("accessKeyIn").oninput = updateAccessLink;
el("btnRegenKey").onclick = async () => {
  const r = await callApi("/access", { method: "POST", body: JSON.stringify({ regenerate: true }) });
  if (r.ok) {
    ACCESS = await r.json();
    el("accessKeyIn").value = ACCESS.key;
    updateAccessLink();
    toast("已生成新密钥，旧链接立即失效");
  } else toast("生成失败");
};
el("btnCopyLink").onclick = async () => {
  const v = el("accessLink").value;
  if (!v) return toast("请先生成密钥");
  try { await navigator.clipboard.writeText(v); toast("链接已复制"); }
  catch { el("accessLink").select(); try { document.execCommand("copy"); toast("链接已复制"); } catch { toast("复制失败，请手动复制"); } }
};
el("accessCancel").onclick = () => hide("accessModal");
el("accessSave").onclick = async () => {
  const k = el("accessKeyIn").value.trim();
  if (k && k.length < 8) return toast("密钥至少 8 位");
  const r = await callApi("/access", { method: "POST", body: JSON.stringify({ key: k }) });
  if (r.ok) {
    ACCESS = await r.json();
    el("accessKeyIn").value = ACCESS.key;
    updateAccessLink();
    hide("accessModal");
    toast("密钥已保存");
  } else toast("保存失败");
};

// ---------------- Tabs ----------------
el("groupTabs").onclick = (e) => {
  const b = e.target.closest("button[data-g]");
  if (!b) return;
  GROUP = b.dataset.g; localStorage.setItem("bm_group", GROUP); SEARCH_Q = ""; if (el("search")) el("search").value = ""; ACTIVE_CAT = "all"; render();
};

// ---------------- 侧栏宽度拖拽 ----------------
(function initResizer() {
  const sw = localStorage.getItem("bm_side_w");
  if (sw) el("catNav").style.width = sw + "px";
  const rz = el("sideResizer");
  rz.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el("catNav").offsetWidth;
    function mv(ev) {
      const w = Math.max(120, Math.min(440, startW + ev.clientX - startX));
      el("catNav").style.width = w + "px";
    }
    function up() {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      localStorage.setItem("bm_side_w", el("catNav").offsetWidth);
    }
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  });
})();

// ---------------- 搜索 ----------------
let searchTimer = 0;
el("search").addEventListener("input", (e) => {
  SEARCH_Q = e.target.value.trim();
  updateSearchClear();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderMain(), 120);
});
el("searchClear").onclick = () => { el("search").value = ""; SEARCH_Q = ""; renderMain(); el("search").focus(); };
function updateSearchClear() { const w = el("searchWrap"); if (w) w.classList.toggle("has-q", !!el("search").value); }
el("search").addEventListener("keydown", (e) => { if (e.key === "Escape") { el("search").value = ""; SEARCH_Q = ""; updateSearchClear(); renderMain(); } });
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); el("search").focus(); el("search").select(); } });

// ---------------- 检查更新 ----------------
el("btnCheckUpdate").onclick = () => checkUpdate(false);
async function checkUpdate(silent) {
  const box = el("updateInfo");
  if (!silent) { box.style.display = "block"; box.innerHTML = "正在检查更新…"; }
  try {
    const r = await fetch(API + "/api/check-update");
    const j = await r.json();
    if (!silent) {
      if (j.hasUpdate) {
        box.innerHTML = '发现新版本 <b>' + esc(j.latest) + '</b>（当前 ' + esc(j.current) + '）。<br><a href="' + esc(j.url) + '" target="_blank" rel="noopener">前往 GitHub 下载 / 查看</a>' + (j.notes ? '<br><small>' + esc(j.notes) + '</small>' : '');
      } else if (j.error) {
        box.innerHTML = '暂无法检查更新：' + esc(j.error);
      } else {
        box.innerHTML = '已是最新版本 <b>' + esc(j.current) + '</b>。';
      }
    } else if (j.hasUpdate) {
      toast('发现新版本 ' + j.latest + '，可在设置里更新');
    }
  } catch {
    if (!silent) box.innerHTML = '检查更新失败（网络错误）';
  }
}

// ---------------- Esc 关闭浮层 ----------------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideCtx();
  resolveCatDelete(false);
  const login = el("loginModal");
  if (login && login.classList.contains("show")) { hide("loginModal"); resolveLogin(false); }
  document.querySelectorAll(".modal.show").forEach((m) => m.classList.remove("show"));
  el("settingsDrawer").classList.remove("show");
});

// ---------------- 启动 ----------------
function applyAppearance(theme,density) {
  theme=["sonoma","titanium","studio"].includes(theme)?theme:"sonoma";
  density=density==="compact"?"compact":"cards";
  document.documentElement.dataset.theme=theme;document.documentElement.dataset.density=density;
  el("themeSelect").value=theme;
  el("viewCards").setAttribute("aria-pressed",String(density==="cards"));
  el("viewCompact").setAttribute("aria-pressed",String(density==="compact"));
  const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==="studio"?"#f5f5f7":theme==="titanium"?"#09090b":"#0b0f17";
  try{localStorage.setItem("bm_theme",theme);localStorage.setItem("bm_density",density);}catch{}
}
applyAppearance(document.documentElement.dataset.theme,document.documentElement.dataset.density);
el("viewCards").onclick=()=>applyAppearance(document.documentElement.dataset.theme,"cards");
el("viewCompact").onclick=()=>applyAppearance(document.documentElement.dataset.theme,"compact");
el("themeSelect").onchange=()=>applyAppearance(el("themeSelect").value,document.documentElement.dataset.density);
updateLoginBtn();
loadData();
loadAccess();
checkUpdate(true);

// 手机无需依赖右键和触摸拖拽：编辑按钮、移动分类与前后排序。
el("btnEditMode").onclick=()=>{EDIT_MODE=!EDIT_MODE;document.body.classList.toggle("edit-mode",EDIT_MODE);el("btnEditMode").textContent=EDIT_MODE?"完成编辑":"编辑模式";};
el("bmGroup").onchange=()=>fillCatSelect("");
let metadataSeq=0,metadataTimer=0;
async function fetchMetadata() {
  const input=el("bmUrl"),value=input.value.trim();
  if(!/^https?:\/\//i.test(value))return;
  const seq=++metadataSeq,existing=el("bmTitle_in").value;
  el("metadataStatus").textContent="正在获取…";
  try {
    await needAuth();if(!TOKEN)return;
    const r=await callApi("/url-metadata",{method:"POST",body:JSON.stringify({url:value}),timeout:10000});
    const result=await r.json();
    if(seq!==metadataSeq||input.value.trim()!==value||!el("bmModal").classList.contains("show"))return;
    if(result.title&&el("bmTitle_in").value===existing&&(!existing||existing===value))el("bmTitle_in").value=result.title;
    const host=hostOf(value);if(host){delete ICONS[host];ICON_BUST[host]=Date.now();}
    el("metadataStatus").textContent=result.title?"标题已获取，图标后台更新":"未获取标题，可手动填写";
  } catch {if(seq===metadataSeq)el("metadataStatus").textContent="获取失败，可手动填写";}
}
el("btnFetchTitle").onclick=fetchMetadata;
el("bmUrl").addEventListener("input",()=>{metadataSeq++;clearTimeout(metadataTimer);el("metadataStatus").textContent="";metadataTimer=setTimeout(fetchMetadata,600);});
let linkCheckRunning=false,stopLinkCheck=false;
function linkCheckDue(b,now=Date.now()) {
  const ttl=b.link_status==="unknown"?3600000:86400000;
  return !["ok","broken","unknown"].includes(b.link_status)||!b.link_checked_at||now-b.link_checked_at>=ttl;
}
async function checkLinks(force=false) {
  if(linkCheckRunning)return;
  if(pendingSave||pendingMove)return toast("请等待当前保存完成");
  await needAuth();if(!TOKEN)return;
  if(linkCheckRunning||pendingSave||pendingMove)return;
  const btn=el("btnCheckLinks"),recheck=el("btnRecheckLinks"),stop=el("btnStopLinks");
  pendingSave=true;linkCheckRunning=true;stopLinkCheck=false;btn.disabled=true;recheck.disabled=true;stop.hidden=false;stop.disabled=false;
  let checked=0,total=0,skipped=0;
  try {
    el("linkCheckInfo").textContent="正在同步已有检查进度…";
    const current=await callApi("/bookmarks",{cache:"no-store",timeout:25000});
    if(!current.ok)throw Error("同步进度失败（HTTP "+current.status+"）");
    for(const remote of await current.json()){const b=BMS.find(b=>b.id===remote.id&&b.url===remote.url);if(b)for(const field of ["link_status","link_http_status","link_checked_at"]) {if(remote[field]!==undefined)b[field]=remote[field];else delete b[field];}}
    const now=Date.now(),ids=BMS.filter(b=>force||linkCheckDue(b,now)).map(b=>b.id);total=ids.length;skipped=BMS.length-total;
    persistCurrentData();render();
    for(let i=0;i<ids.length&&!stopLinkCheck;i+=8){
      el("linkCheckInfo").textContent="检查中 "+checked+" / "+total+"，跳过近期结果 "+skipped+" 条";
      let j;
      for(let attempt=0;attempt<2;attempt++){
        try{
          const r=await callApi("/check-links",{method:"POST",body:JSON.stringify({ids:ids.slice(i,i+8)}),timeout:25000});
          if(!r.ok)throw Error("HTTP "+r.status);
          j=await r.json();if(!Array.isArray(j.results))throw Error("返回格式异常");break;
        }catch(e){if(e.message==="unauthorized"||attempt===1||stopLinkCheck)throw e;el("linkCheckInfo").textContent="当前批次网络异常，正在重试；已完成 "+checked+" / "+total;}
      }
      for(const result of j.results){const b=BMS.find(b=>b.id===result.id&&b.url===result.url);if(b)Object.assign(b,{link_status:result.status,link_http_status:result.http_status,link_checked_at:result.checked_at});}
      checked+=j.results.length;mutationEpoch++;persistCurrentData();
      // 检查期间仅更新状态，结束后统一重绘，避免每批重建全部书签。
    }
    el("linkCheckInfo").textContent=(stopLinkCheck?"已暂停，":"检查完成，")+"本次 "+checked+" / "+total+" 条；跳过近期结果 "+skipped+" 条；失效 "+BMS.filter(b=>b.link_status==="broken").length+"，待确认 "+BMS.filter(b=>b.link_status==="unknown").length;
  } catch(e) {el("linkCheckInfo").textContent="检查中断（"+(e.name==="AbortError"?"网络超时":e.message)+"），本次已保留 "+checked+" 条；点“继续检查”会跳过已完成项";}
  finally {pendingSave=false;linkCheckRunning=false;btn.disabled=false;recheck.disabled=false;stop.hidden=true;render();}
}
el("btnCheckLinks").onclick=()=>checkLinks(false);
el("btnRecheckLinks").onclick=()=>checkLinks(true);
el("btnStopLinks").onclick=()=>{stopLinkCheck=true;el("btnStopLinks").disabled=true;el("linkCheckInfo").textContent="正在保存当前批次后暂停…";};
el("bookmarklet").href="javascript:"+encodeURIComponent("(()=>{window.open("+JSON.stringify(location.origin+"/?add=")+"+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank')})()");
const addParams=new URLSearchParams(location.search);
if(addParams.has("add")){addBm();el("bmUrl").value=addParams.get("add")||"";el("bmTitle_in").value=addParams.get("title")||"";history.replaceState(null,"","/");setTimeout(fetchMetadata,700);}
let installPrompt;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;});
let swRegistration;
if("serviceWorker" in navigator)swRegistration=navigator.serviceWorker.register("/sw.js");
el("btnInstall").onclick=async()=>{
  try {
    if(!swRegistration)return toast("当前浏览器未支持离线功能");
    await swRegistration;const reg=await navigator.serviceWorker.ready;
    const worker=reg.active;if(!worker)throw new Error("not ready");
    const channel=new MessageChannel();const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("timeout")),10000);channel.port1.onmessage=e=>{clearTimeout(timer);e.data.ok?resolve():reject(Error("cache failed"));};});
    worker.postMessage({type:"ENABLE_OFFLINE",asset:"/app.js?v="+VERSION},[channel.port2]);await done;
    localStorage.setItem("bm_offline","1");toast("已启用本机离线只读；可添加到主屏幕");
    if(installPrompt){await installPrompt.prompt();installPrompt=null;}
  }catch{toast("离线准备失败，请联网后重试");}
};
window.addEventListener("offline",()=>toast("当前离线，可浏览缓存；修改需联网"));
// 仅隐藏检测提示，不删除服务端检查记录，也不重绘整页。
setInterval(()=>{
  const now=Date.now();
  document.querySelectorAll(".link-state[data-expires]").forEach(node=>{
    if(Number(node.dataset.expires)<=now){node.hidden=true;node.textContent="";delete node.dataset.expires;}
  });
},1000);

