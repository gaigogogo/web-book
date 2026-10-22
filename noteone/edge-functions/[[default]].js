import { getStore } from "@edgeone/pages-blob";
// ---------------------------------------------------------------------------
// Cloudflare Workers 书签中心后端（与 EdgeOne 版功能对等）
// 单文件 Worker：worker/index.js  ->  所有 /api/*
// 存储：Cloudflare KV 命名空间 "BOOKMARKS"（在 wrangler.toml 中绑定）
//   data/categories.json  -> [{id,name,sort,group,created_at}]
//   data/bookmarks.json   -> [{id,category_id,title,url,icon,note,sort,group,visits,last_visit_at,created_at}]
//   data/groups.json      -> [{id,name}]  分区列表（默认 个人区/工作区）
//   data/icons.json       -> { "<host>": "data:image/png;base64,...." }
//   data/password.json    -> { password: "..." }  可选覆盖 env.APP_PASSWORD
//   data/site.json        -> 站点信息（名称 / 作者 / 网址）
// 鉴权：Bearer Token（HMAC，Web Crypto）+ 可选 HttpOnly Cookie
// 静态资源：由 wrangler.toml 的 assets 绑定（ASSETS）托管 index.html / app.js
// ---------------------------------------------------------------------------

const PUBLIC = new Set(["categories", "bookmarks", "icon", "health"]);
const APP_VERSION = "v4.9-noteone";                  // 语义版本，对应 GitHub 上的发行版
const REPO_VERSION_URL = "https://raw.githubusercontent.com/gaigogogo/web-book/main/noteone/version.json";

// --------------------------- 基础工具 ---------------------------
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      ...extra,
    },
  });
}

function b64u(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function abToB64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function ctOfDataUrl(du) {
  const m = du.match(/^data:([^;]+);/);
  return m ? m[1] : "image/png";
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// --------------------------- KV 数据访问 ---------------------------
async function kvGet(env, key) {
  return await env.BOOKMARKS.get(key, "json");
}
async function kvPut(env, key, val) {
  await env.BOOKMARKS.put(key, JSON.stringify(val));
}
async function kvDel(env, key) {
  await env.BOOKMARKS.delete(key);
}

// --------------------------- 鉴权 ---------------------------
let PWD_CACHE = { t: 0, v: undefined };
async function getStoredPwd(env) {
  if (PWD_CACHE.v !== undefined && Date.now() - PWD_CACHE.t < 30000) return PWD_CACHE.v;
  let v = null;
  try {
    const p = await kvGet(env, "data/password.json");
    if (p && p.password) v = p.password;
  } catch {}
  PWD_CACHE = { t: Date.now(), v };
  return v;
}
async function setStoredPwd(env, pwd) {
  await kvPut(env, "data/password.json", { password: pwd, updated_at: Date.now() });
  PWD_CACHE = { t: 0, v: undefined };
}
function getPwd(env, stored) {
  return stored || env.APP_PASSWORD || "admin";
}

async function importKey(key) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmac(msg, key) {
  const k = await importKey(key);
  const buf = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(buf)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function b64url(obj) {
  return b64u(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

async function makeToken(pwd) {
  const exp = Date.now() + 7 * 86400000;
  const p = b64url({ exp });
  const sig = await hmac(p, pwd);
  return p + "." + sig;
}

async function verifyToken(tok, pwd) {
  try {
    const [p, sig] = tok.split(".");
    if (!p || !sig) return false;
    const expect = await hmac(p, pwd);
    if (sig !== expect) return false;
    const { exp } = JSON.parse(b64urlDecode(p));
    return exp > Date.now();
  } catch {
    return false;
  }
}

async function requireAuth(req, env) {
  const stored = await getStoredPwd(env);
  const pwd = getPwd(env, stored);
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && (await verifyToken(m[1], pwd))) return true;
  const cookie = req.headers.get("cookie") || "";
  const cm = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (cm && (await verifyToken(cm[1], pwd))) return true;
  return false;
}

// base64（UTF-8 安全），用于邮件附件
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// --------------------------- 数据访问 ---------------------------
async function getCats(env) {
  const arr = (await kvGet(env, "data/categories.json")) || [];
  for (const c of arr) if (!c.group) c.group = "personal";
  return arr;
}
async function setCats(env, arr) {
  await kvPut(env, "data/categories.json", arr);
}
async function getBms(env) {
  const arr = (await kvGet(env, "data/bookmarks.json")) || [];
  for (const b of arr) {
    if (!b.group) b.group = "personal";
    if (!b.icon && b.url) b.icon = null;
  }
  return arr;
}
async function setBms(env, arr) {
  await kvPut(env, "data/bookmarks.json", arr);
}
async function getIcons(env) {
  return (await kvGet(env, "data/icons.json")) || {};
}
async function setIcons(env, map) {
  await kvPut(env, "data/icons.json", map);
  ICON_CACHE = { t: 0, map: null }; // 写入即失效
}

// 图标读取很频繁（每个图标一个请求），在 isolate 内缓存 30 秒，避免反复解析大 JSON
let ICON_CACHE = { t: 0, map: null };
async function getIconsFast(env) {
  if (ICON_CACHE.map && Date.now() - ICON_CACHE.t < 30000) return ICON_CACHE.map;
  const map = await getIcons(env);
  ICON_CACHE = { t: Date.now(), map };
  return map;
}
async function getGroups(env) {
  let arr = (await kvGet(env, "data/groups.json")) || [];
  let dirty = false;
  if (!arr.length) {
    arr = [{ id: "personal", name: "个人区", sort: 0 }, { id: "work", name: "工作区", sort: 1 }];
    await kvPut(env, "data/groups.json", arr);
  }
  arr.forEach((g, i) => { if (typeof g.sort !== "number") { g.sort = i; dirty = true; } });
  if (dirty) await kvPut(env, "data/groups.json", arr);
  return arr;
}
async function setGroups(env, arr) {
  await kvPut(env, "data/groups.json", arr);
}
async function getSite(env) {
  let o = (await kvGet(env, "data/site.json")) || {};
  if (!o.name) o.name = "gai溜子导航站";
  if (!o.author) o.author = "gai溜子到处跑";
  if (!o.url) o.url = "www.090803.xyz";
  return o;
}
async function setSite(env, o) {
  await kvPut(env, "data/site.json", o);
}
function groupOf(q) {
  if (q && q !== "all") return q;
  return null;
}

// --------------------------- 访问锁 / 免密密钥 ---------------------------
// data/access.json -> { gate: true/false, key: "<长密钥>", updated_at }
// gate=true：进站必须验证（密码登录，或带 key 的免密链接）
// gate=false：内容公开只读，仅编辑需要登录
function genKey() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
let ACCESS_CACHE = { t: 0, v: null };
async function getAccess(env) {
  if (ACCESS_CACHE.v && Date.now() - ACCESS_CACHE.t < 30000) return ACCESS_CACHE.v;
  let o = (await kvGet(env, "data/access.json")) || {};
  let dirty = false;
  if (typeof o.gate !== "boolean") { o.gate = true; dirty = true; }
  if (typeof o.key !== "string" || o.key.length < 16) { o.key = genKey(); dirty = true; }
  if (dirty) await kvPut(env, "data/access.json", o);
  ACCESS_CACHE = { t: Date.now(), v: o };
  return o;
}
async function setAccess(env, o) {
  await kvPut(env, "data/access.json", o);
  ACCESS_CACHE = { t: 0, v: null };
}
function safeEqual(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authCookie(token, maxAge, secure) {
  return (
    "token=" + token +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge +
    (secure ? "; Secure" : "")
  );
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

function cmpVer(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 检查 GitHub 仓库是否发布了更新；结果在 isolate 内缓存 5 分钟，避免频繁请求
let UPDATE_CACHE = { t: 0, v: null };
async function checkUpdate(env) {
  if (UPDATE_CACHE.v && Date.now() - UPDATE_CACHE.t < 300000) return json(UPDATE_CACHE.v, 200, { "cache-control": "no-store" });
  const out = {
    current: APP_VERSION,
    latest: null,
    url: "https://github.com/gaigogogo/web-book/releases",
    notes: "",
    hasUpdate: false,
    error: null,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(REPO_VERSION_URL, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!r.ok) { out.error = "仓库尚未发布版本信息"; }
    else {
      const j = await r.json().catch(() => null);
      if (j && j.version) {
        out.latest = j.version;
        out.url = j.url || out.url;
        out.notes = j.notes || "";
        out.hasUpdate = cmpVer(j.version, APP_VERSION) > 0;
      } else { out.error = "版本信息格式错误"; }
    }
  } catch { out.error = "无法连接 GitHub"; }
  UPDATE_CACHE = { t: Date.now(), v: out };
  return json(out, 200, { "cache-control": "no-store" });
}

// 未通过访问锁时返回的锁屏页（不依赖任何静态资源）
function gatePage(site, msg) {
  const name = escHtml((site && site.name) || "书签中心");
  const tip = msg ? '<div class="err">' + escHtml(msg) + "</div>" : "";
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '<meta name="robots" content="noindex,nofollow" />' +
    "<title>需要密码 · " + name + "</title><style>" +
    "*{box-sizing:border-box}" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111217;color:#e8eaed;" +
    "font:14px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}" +
    ".card{width:340px;max-width:90vw;background:#181a20;border:1px solid #2a2e37;border-radius:14px;padding:26px 24px;text-align:center}" +
    ".lock{font-size:30px;margin-bottom:6px}" +
    "h1{margin:0 0 4px;font-size:16px;font-weight:600}" +
    "p{margin:0 0 16px;color:#8b929d;font-size:12px}" +
    "input{width:100%;background:#111217;border:1px solid #2a2e37;color:#e8eaed;border-radius:8px;padding:9px 11px;font:inherit;outline:none}" +
    "input:focus{border-color:#4f8cff}" +
    "button{width:100%;margin-top:10px;background:#4f8cff;border:none;color:#fff;border-radius:8px;padding:9px;font:inherit;cursor:pointer}" +
    "button:hover{background:#3b6fd4}" +
    "button:disabled{opacity:.6;cursor:default}" +
    ".err{color:#ff5d5d;font-size:12px;margin-top:10px;min-height:16px}" +
    "</style></head><body>" +
    '<form class="card" id="f"><div class="lock">🔒</div><h1>' + name + "</h1><p>请输入访问密码以进入</p>" +
    '<input id="p" type="password" placeholder="访问密码" autocomplete="current-password" autofocus />' +
    '<button id="b" type="submit">进入</button>' + tip + "</form>" +
    "<script>" +
    "var f=document.getElementById('f'),b=document.getElementById('b'),p=document.getElementById('p'),e=document.querySelector('.err');" +
    "f.addEventListener('submit',async function(ev){ev.preventDefault();b.disabled=true;b.textContent='验证中…';" +
    "try{var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});" +
    "if(r.ok){location.replace('/'+location.search);}else{e.textContent='密码错误';b.disabled=false;b.textContent='进入';}}" +
    "catch(err){e.textContent='网络错误，请重试';b.disabled=false;b.textContent='进入';}});" +
    "</script></body></html>";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// --------------------------- 图标生成 ---------------------------
async function fetchIcon(host) {
  const sources = [
    "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=64",
    "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(host) + ".ico",
  ];
  for (const url of sources) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf && buf.byteLength > 32) {
          return "data:" + (r.headers.get("content-type") || "image/png") + ";base64," + abToB64(buf);
        }
      }
    } catch {
      // 继续下一个源
    }
  }
  return null;
}

function letterIcon(host) {
  const ch = (host || "?").charAt(0).toUpperCase();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" rx="12" fill="#4b5563"/>' +
    '<text x="32" y="43" font-size="34" text-anchor="middle" fill="#fff" font-family="sans-serif">' +
    ch +
    "</text></svg>";
  return "data:image/svg+xml;base64," + b64u(svg);
}

async function serveIcon(env, host, fallback = true) {
  const map = await getIconsFast(env);
  let du = map[host];
  if (!du && fallback) du = letterIcon(host);
  if (!du) return json({ error: "no icon" }, 404);
  const ct = ctOfDataUrl(du);
  const b64 = du.split(",")[1] || "";
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(buf, {
    headers: {
      "content-type": ct,
      // 图标长缓存 30 天；刷新图标时前端会带 &t= 时间戳，自动绕过缓存
      "cache-control": "public, max-age=2592000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

// 仅由显式刷新或保存书签时后台触发；不阻塞请求、不自动写回失败占位图
async function maybeFetchIcon(env, host) {
  if (!host) return;
  const map = await getIcons(env);
  if (map[host]) return;
  const du = await fetchIcon(host);
  if (du) {
    map[host] = du;
    await setIcons(env, map);
  }
}

async function refreshAllIcons(env) {
  const bms = await getBms(env);
  const hosts = [...new Set(bms.map((b) => {
    try { return new URL(b.url).host; } catch { return null; }
  }).filter(Boolean))];
  const map = await getIcons(env);
  let n = 0;
  for (const h of hosts) {
    if (map[h]) { n++; continue; }
    const du = (await fetchIcon(h)) || letterIcon(h);
    map[h] = du;
    n++;
  }
  await setIcons(env, map);
  return { hosts: hosts.length, cached: n };
}

async function refreshOneIcon(env, host) {
  if (!host) return null;
  const map = await getIcons(env);
  const du = (await fetchIcon(host)) || letterIcon(host);
  map[host] = du;
  await setIcons(env, map);
  return du;
}

// 只探测公共 HTTP(S) 域名；逐次检查重定向，限制时间、跳数及读取体积。
function publicWebUrl(value) {
  const u = new URL(String(value || ""));
  const h = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || u.username || u.password ||
      (u.port && !["80","443"].includes(u.port)) || !h.includes(".") ||
      /^[\d.]+$/.test(h) || h.includes(":") ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(h)) throw new Error("unsupported URL");
  return u;
}
function decodeTitle(t) {
  return t.replace(/<[^>]*>/g," ").replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=> {
    const v=n[0].toLowerCase()==="x"?parseInt(n.slice(1),16):Number(n);
    return v>0&&v<=0x10ffff?String.fromCodePoint(v):"";
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi,(_,n)=>({amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "}[n.toLowerCase()])).replace(/\s+/g," ").trim().slice(0,200);
}
async function checkPublicDns(host, signal) {
  await Promise.all(["A","AAAA"].map(async type => {
    const r=await fetch("https://dns.google/resolve?name="+encodeURIComponent(host)+"&type="+type,{signal});
    if(!r.ok)throw new Error("DNS check failed");
    const j=await r.json();if(j.Status!==0)throw new Error("DNS failed");
    for(const answer of j.Answer||[]) {
      if(answer.type===1) {
        const p=answer.data.split(".").map(Number);
        if(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0)||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&(p[1]===18||p[1]===19))throw new Error("Private address");
      }
      if(answer.type===28&&!/^2[0-9a-f]{3}:/i.test(answer.data))throw new Error("Unsupported IPv6");
    }
  }));
}
async function inspectUrl(value, metadata, dnsMemo = new Map()) {
  const checked_at = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), metadata ? 6500 : 4500);
  try {
    let u = publicWebUrl(value), r;
    for (let i=0;i<5;i++) {
      if(!dnsMemo.has(u.hostname)) dnsMemo.set(u.hostname,checkPublicDns(u.hostname,ctrl.signal));
      await dnsMemo.get(u.hostname);
      r=await fetch(u.href,{method:metadata?"GET":"HEAD",redirect:"manual",signal:ctrl.signal});
      if(!metadata&&[405,501].includes(r.status)) {
        if(r.body)await r.body.cancel();
        r=await fetch(u.href,{method:"GET",headers:{Range:"bytes=0-1023"},redirect:"manual",signal:ctrl.signal});
      }
      if ([301,302,303,307,308].includes(r.status)) {
        const location=r.headers.get("location");
        if (!location) break;
        if (r.body) await r.body.cancel();
        u=publicWebUrl(new URL(location,u).href);continue;
      }
      break;
    }
    const status = r.ok?"ok":([404,410].includes(r.status)?"broken":"unknown");
    let title="";
    if (metadata && r.ok && /html/i.test(r.headers.get("content-type")||"")) {
      const reader=r.body?.getReader();let text="",size=0;
      const decoder=new TextDecoder();
      if(reader) { try { while(size<131072){const part=await reader.read();if(part.done)break;size+=part.value.length;text+=decoder.decode(part.value,{stream:true});if(/<\/title>/i.test(text))break;} } finally {await reader.cancel();} }
      title=decodeTitle((text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"");
    } else if(r.body)await r.body.cancel();
    return {status,http_status:r.status,checked_at,title};
  } catch { return {status:"unknown",http_status:null,checked_at,title:""}; }
  finally {clearTimeout(timer);}
}

// --------------------------- 主路由 ---------------------------
const worker = {
  async fetch(request, env, ctx) {
    if (!env.BOOKMARKS) {
      return json({ error: "KV 命名空间 BOOKMARKS 未绑定，请在 wrangler.toml 配置后部署" }, 500);
    }
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (["/sw.js","/manifest.webmanifest","/pwa-icon.png"].includes(url.pathname) && ["GET","HEAD"].includes(method)) {
      const response=await env.ASSETS.fetch(request);
      const headers=new Headers(response.headers);headers.set("cache-control","no-cache");
      if(url.pathname==="/sw.js")headers.set("service-worker-allowed","/");
      return new Response(response.body,{status:response.status,headers});
    }

    // 非 /api 请求：先过访问锁，再交给 Workers Assets 托管静态前端
    if (!url.pathname.startsWith("/api")) {
      const acc = await getAccess(env);
      if (acc.gate) {
        // 免密链接：/?key=<长密钥>  或  /k/<长密钥>
        const keyParam =
          url.searchParams.get("key") ||
          (url.pathname.startsWith("/k/") ? decodeURIComponent(url.pathname.slice(3).split("/")[0]) : "");
        if (keyParam) {
          if (safeEqual(keyParam, acc.key)) {
            const pwd = getPwd(env, await getStoredPwd(env));
            const token = await makeToken(pwd);
            return new Response(null, {
              status: 302,
              headers: {
                location: "/",
                "set-cookie": authCookie(token, 30 * 86400, url.protocol === "https:"),
                "cache-control": "no-store",
              },
            });
          }
        }
        if (!(await requireAuth(request, env))) {
          // 静态子资源不返回锁屏 HTML，直接拒绝
          if (/\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|json|map)$/i.test(url.pathname)) {
            return new Response("locked", { status: 403, headers: { "cache-control": "no-store" } });
          }
          return gatePage(await getSite(env));
        }
      }
      // HTML 不缓存（否则锁屏/已登录状态会串号）
      // 带 v= 版本号的静态资源（app.js?v=xxx）可长缓存 1 年：改版时版本号变化 = 新 URL，自动取新文件
      // 不带版本号的按 5 分钟兜底，避免裸路径下拿到旧文件
      const resp = await env.ASSETS.fetch(request);
      const ct = resp.headers.get("content-type") || "";
      const cc = ct.includes("text/html")
        ? "no-store, must-revalidate"
        : url.searchParams.has("v")
        ? "private, max-age=31536000, immutable"
        : "private, max-age=300";
      const hdr = new Headers(resp.headers);
      hdr.set("cache-control", cc);
      hdr.set("x-content-type-options", "nosniff");
      hdr.set("referrer-policy", "strict-origin-when-cross-origin");
      hdr.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      hdr.set("x-cc-by", "worker");
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: hdr });
    }

    const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    const head = parts[0] || "";

    if (head === "health") return json({ ok: true });

    // 版本与更新检查：公开接口（不要求登录），供访客/下载者自查是否有新版
    if (head === "version" && method === "GET") return json({ version: APP_VERSION }, 200, { "cache-control": "no-store" });
    if (head === "check-update" && method === "GET") return checkUpdate(env);

    if (method === "POST" && head === "login") {
      const body = await readBody(request);
      const stored = await getStoredPwd(env);
      const pwd = getPwd(env, stored);
      if (!body.password || body.password !== pwd) return json({ error: "密码错误" }, 401);
      const token = await makeToken(pwd);
      return json({ ok: true, token }, 200, {
        "set-cookie": authCookie(token, 7 * 86400, url.protocol === "https:"),
      });
    }

    // 退出：清除访问锁 Cookie（任何状态都可调用）
    if (method === "POST" && head === "logout") {
      const clear = "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (url.protocol === "https:" ? "; Secure" : "");
      return json({ ok: true }, 200, { "set-cookie": clear });
    }

    if (head === "icon" && method === "GET") {
      const host = url.searchParams.get("host");
      if (!host) return json({ error: "missing host" }, 400);
      // 访问锁开启时，图标同样需要登录（浏览器同源 img 请求会自动带 Cookie）
      const accIcon = await getAccess(env);
      if (accIcon.gate && !(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);
      return serveIcon(env, host);
    }

    // 访问锁开启时：所有 /api 数据接口（含只读）都必须已通过验证
    // 访问锁关闭时：只读接口公开，写入 / 敏感接口仍需登录
    const acc = await getAccess(env);
    const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const sensitive = ["backup", "backup-email", "restore", "data", "icons", "access", "password"];
    if (acc.gate || isWrite || sensitive.includes(head)) {
      if (!(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);
    }

    if (head === "url-metadata" && method === "POST") {
      const body = await readBody(request);
      try {
        const result = await inspectUrl(body.url, true);
        if (result.status === "ok" && ctx?.waitUntil) ctx.waitUntil(maybeFetchIcon(env, new URL(body.url).host));
        return json(result);
      } catch { return json({error:"无法读取网页信息，请手动填写标题"}, 400); }
    }
    if (head === "check-links" && method === "POST") {
      const body = await readBody(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].slice(0, 8) : [];
      if (!ids.length) return json({error:"请选择待检查书签"},400);
      const bookmarks = await getBms(env);
      const selected = bookmarks.filter(b => ids.includes(b.id));
      const dnsMemo = new Map();
      const results = await Promise.all(selected.map(async b => ({id:b.id, url:b.url, ...(await inspectUrl(b.url, false, dnsMemo))})));
      // 探测完成后重读，避免长时间探测期间覆盖其他设备的新增/修改。
      const latest = await getBms(env);
      for (const result of results) {
        const b = latest.find(b => b.id === result.id && b.url === result.url);
        if (b) Object.assign(b, {link_status:result.status, link_http_status:result.http_status, link_checked_at:result.checked_at});
      }
      await setBms(env, latest);
      return json({results});
    }

    // ---- 首屏一次性拉取（减少 4 次往返 + 4 次 KV 冷读）----
    if (head === "bootstrap" && method === "GET") {
      const [groups, categories, bookmarks, site] = await Promise.all([
        getGroups(env),
        getCats(env),
        getBms(env),
        getSite(env),
      ]);
      const data = { version: 3, groups, categories, bookmarks, site };
      if (url.searchParams.get("icons") === "1") data.icons = await getIcons(env);
      const body = JSON.stringify(data);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const etag = '"' + Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("") + '"';
      const headers = { "cache-control": "private, no-cache", "etag": etag, "vary": "Cookie, Authorization" };
      if (request.headers.get("if-none-match") === etag) return new Response(null, {status: 304, headers});
      return json(data, 200, headers);
    }

    // ---- 分类 ----
    if (head === "categories") {
      if (method === "GET") {
        const cats = await getCats(env);
        const g = groupOf(url.searchParams.get("group"));
        return json(g ? cats.filter((c) => c.group === g) : cats);
      }
      if (method === "POST") {
        const body = await readBody(request);
        const cats = await getCats(env);
        const maxSort = cats.reduce((m, c) => Math.max(m, c.sort || 0), 0);
        const cat = {
          id: crypto.randomUUID(),
          name: String(body.name || "未命名"),
          sort: body.sort != null ? Number(body.sort) : maxSort + 1,
          group: (typeof body.group === "string" && body.group) ? body.group : "personal",
          created_at: Date.now(),
        };
        cats.push(cat);
        await setCats(env, cats);
        return json(cat, 201);
      }
      const id = parts[1];
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const cats = await getCats(env);
        const c = cats.find((x) => x.id === id);
        if (!c) return json({ error: "not found" }, 404);
        if (body.name != null) c.name = String(body.name);
        if (body.sort != null) c.sort = Number(body.sort);
        if (typeof body.group === "string" && body.group && body.group !== c.group) {
          const newGroup = body.group;
          c.group = newGroup;
          // 级联：把该分类下的书签一并移动到新分区
          const bms = await getBms(env);
          for (const b of bms) if (b.category_id === id) b.group = newGroup;
          await setBms(env, bms);
        }
        await setCats(env, cats);
        return json(c);
      }
      if (method === "DELETE") {
        const cats = await getCats(env);
        const bms = await getBms(env);
        const remaining = cats.filter((x) => x.id !== id);
        if (remaining.length === cats.length) return json({ error: "not found" }, 404);
        const newBms = bms.filter((x) => x.category_id !== id);
        await setCats(env, remaining);
        await setBms(env, newBms);
        return json({
          ok: true,
          deleted: cats.length - remaining.length,
          bookmarksDeleted: bms.length - newBms.length,
        });
      }
    }

    // ---- 书签 ----
    if (head === "bookmarks") {
      if (method === "GET") {
        const bms = await getBms(env);
        const g = groupOf(url.searchParams.get("group"));
        return json(g ? bms.filter((b) => b.group === g) : bms);
      }
      if (method === "POST") {
        const body = await readBody(request);
        if (!body.url) return json({ error: "url required" }, 400);
        const bms = await getBms(env);
        const maxSort = bms.reduce((m, b) => Math.max(m, b.sort || 0), 0);
        const host = (() => {
          try { return new URL(body.url).host; } catch { return null; }
        })();
        const bm = {
          id: crypto.randomUUID(),
          category_id: body.category_id || null,
          title: String(body.title || body.url),
          url: String(body.url),
          icon: body.icon || null,
          note: body.note || null,
          sort: body.sort != null ? Number(body.sort) : maxSort + 1,
          group: (typeof body.group === "string" && body.group) ? body.group : "personal",
          visits: 0,
          last_visit_at: null,
          created_at: Date.now(),
        };
        bms.push(bm);
        await setBms(env, bms);
        if (host && ctx && ctx.waitUntil) ctx.waitUntil(maybeFetchIcon(env, host));
        return json(bm, 201);
      }
      const id = parts[1];
      if (!id) return json({ error: "id required" }, 400);
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const bms = await getBms(env);
        const b = bms.find((x) => x.id === id);
        if (!b) return json({ error: "not found" }, 404);
        for (const f of ["title", "url", "icon", "note", "sort"]) {
          if (body[f] != null) b[f] = f === "sort" ? Number(body[f]) : body[f];
        }
        if (body.category_id !== undefined) b.category_id = body.category_id; // 允许显式置 null
        if (body.note === null) b.note = null;
        if(body.url !== undefined) {delete b.link_status;delete b.link_http_status;delete b.link_checked_at;}
        if (typeof body.group === "string" && body.group) b.group = body.group;
        await setBms(env, bms);
        const host = body.url
          ? (() => {
              try { return new URL(body.url).host; } catch { return null; }
            })()
          : null;
        if (host && ctx && ctx.waitUntil) ctx.waitUntil(maybeFetchIcon(env, host));
        return json(b);
      }
      if (method === "DELETE") {
        const bms = await getBms(env);
        const remaining = bms.filter((x) => x.id !== id);
        if (remaining.length === bms.length) return json({ error: "not found" }, 404);
        await setBms(env, remaining);
        return json({ ok: true });
      }
    }

    // ---- 备份 / 恢复 / 清空 ----
    if (head === "backup" && method === "GET") {
      const [cats, bms, icons, groups] = await Promise.all([getCats(env), getBms(env), getIcons(env), getGroups(env)]);
      return json({
        version: 3,
        generator: "bookmark-hub-cf",
        exportedAt: new Date().toISOString(),
        groups,
        categories: cats,
        bookmarks: bms,
        icons,
      });
    }

    // ---- 备份发送到邮箱（Resend 附件）----
    if (head === "backup-email" && method === "POST") {
      const body = await readBody(request);
      const to = String((body && body.to) || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "收件邮箱格式不正确" }, 400);
      const key = env.RESEND_API_KEY;
      if (!key) return json({ error: "未配置邮件服务密钥（RESEND_API_KEY）" }, 500);
      const [cats, bms, icons, groups] = await Promise.all([getCats(env), getBms(env), getIcons(env), getGroups(env)]);
      const payload = { version: 3, generator: "bookmark-hub-cf", exportedAt: new Date().toISOString(), groups, categories: cats, bookmarks: bms, icons };
      const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间日期，避免备份文件名比本地日期早一天
      const dateStr = d.toISOString().slice(0, 10);
      const filename = "bookmarks-" + dateStr + ".json";
      let upstream;
      try {
        upstream = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({
            from: env.MAIL_FROM || "Book Hub <onboarding@resend.dev>",
            to: [to],
            subject: "书签备份 " + dateStr + "（" + cats.length + " 分类 / " + bms.length + " 书签）",
            text: "附件是 " + dateStr + " 的全量备份 JSON，可用于「设置 → 恢复」。",
            attachments: [{ filename: filename, content: b64encode(JSON.stringify(payload, null, 2)) }],
          }),
        });
      } catch (e) {
        return json({ error: "调用邮件服务失败" }, 502);
      }
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => "");
        let msg = "邮件发送失败";
        try { const j = JSON.parse(t); msg = j.message || j.error || msg; } catch {}
        if (/only send testing emails|verify a domain/i.test(msg)) {
          msg = "当前只能发送到已验证邮箱，请先在 Resend 验证域名。";
        }
        return json({ error: msg }, 502);
      }
      return json({ ok: true, file: filename, categories: cats.length, bookmarks: bms.length });
    }

    if (head === "restore" && method === "POST") {
      const body = await readBody(request);
      if (!body || !Array.isArray(body.categories) || !Array.isArray(body.bookmarks))
        return json({ error: "invalid backup" }, 400);
      let icons = {};
      if (body.icons && typeof body.icons === "object") {
        for (const [h, v] of Object.entries(body.icons)) {
          if (typeof v === "string") icons[h] = v;
          else if (v && v.b64) icons[h] = "data:" + (v.ct || "image/png") + ";base64," + v.b64;
        }
      }
      // 分区：优先用备份里的 groups；并补齐书签/分类引用到、但备份缺失的分区，
      // 避免恢复后自定义分区“消失”、其书签变成无标签页可挂的孤儿。
      let groups = [];
      if (Array.isArray(body.groups)) {
        for (const g of body.groups) {
          if (g && g.id) groups.push({ id: String(g.id), name: String(g.name || g.id) });
        }
      }
      const have = new Set(groups.map((g) => g.id));
      const need = new Set();
      for (const c of body.categories) if (c && c.group) need.add(String(c.group));
      for (const b of body.bookmarks) if (b && b.group) need.add(String(b.group));
      for (const gid of need) {
        if (!have.has(gid)) { groups.push({ id: gid, name: "分区 " + gid }); have.add(gid); }
      }
      await setCats(env, body.categories);
      await setBms(env, body.bookmarks);
      await setIcons(env, icons);
      if (groups.length) await setGroups(env, groups);
      return json({
        ok: true,
        categories: body.categories.length,
        bookmarks: body.bookmarks.length,
        icons: Object.keys(icons).length,
        groups: groups.length,
      });
    }

    if (head === "data" && method === "DELETE") {
      await kvDel(env, "data/categories.json");
      await kvDel(env, "data/bookmarks.json");
      await kvDel(env, "data/icons.json");
      return json({ ok: true });
    }

    if (head === "icons") {
      if (method === "GET") {
        const icons = await getIcons(env);
        return json(icons);
      }
      if (parts[1] === "refresh" && method === "POST") {
        const body = await readBody(request);
        if (body && body.host) {
          const du = await refreshOneIcon(env, String(body.host));
          return json({
            ok: true,
            host: body.host,
            refreshed: true,
            hasIcon: !!du && !String(du).startsWith("data:image/svg"),
          });
        }
        const r = await refreshAllIcons(env);
        return json({ ok: true, ...r });
      }
    }

    if (head === "password" && method === "POST") {
      const body = await readBody(request);
      if (!body.password || typeof body.password !== "string" || body.password.length < 1)
        return json({ error: "password required" }, 400);
      await setStoredPwd(env, body.password);
      const token = await makeToken(body.password);
      return json({ ok: true, token }, 200, {
        "set-cookie": authCookie(token, 7 * 86400, url.protocol === "https:"),
      });
    }

    // ---- 访问锁 / 免密密钥 ----
    if (head === "access") {
      if (method === "GET") {
        const a = await getAccess(env);
        return json({ gate: a.gate, key: a.key });
      }
      if (method === "POST") {
        const body = await readBody(request);
        const a = await getAccess(env);
        if (body.gate === true || body.gate === false) a.gate = body.gate;
        if (body.regenerate) a.key = genKey();
        else if (typeof body.key === "string") {
          const k = body.key.trim();
          if (k.length >= 8) a.key = k;
          else return json({ error: "密钥至少 8 位" }, 400);
        }
        a.updated_at = Date.now();
        await setAccess(env, a);
        return json({ gate: a.gate, key: a.key });
      }
    }

    // ---- 分区 ----
    if (head === "groups") {
      if (method === "GET") {
        const g = await getGroups(env);
        return json(g);
      }
      if (method === "POST") {
        const body = await readBody(request);
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "名称必填" }, 400);
        const g = await getGroups(env);
        const id = body.id && /^[A-Za-z0-9_-]{1,32}$/.test(String(body.id)) ? String(body.id) : crypto.randomUUID().slice(0, 8);
        if (g.find((x) => x.id === id)) return json({ error: "该分区已存在" }, 409);
        const maxSort = g.reduce((m, x) => Math.max(m, x.sort || 0), 0);
        const ng = { id, name, sort: maxSort + 1 };
        g.push(ng);
        await setGroups(env, g);
        return json(ng, 201);
      }
      const id = parts[1];
      if (method === "PUT" || method === "PATCH") {
        if (!id) return json({ error: "id required" }, 400);
        const body = await readBody(request);
        const g = await getGroups(env);
        const target = g.find((x) => x.id === id);
        if (!target) return json({ error: "not found" }, 404);
        if (body.name != null) {
          const name = String(body.name).trim();
          if (!name) return json({ error: "名称必填" }, 400);
          target.name = name;
        }
        if (body.sort != null) target.sort = Number(body.sort);
        await setGroups(env, g);
        return json(target);
      }
      if (method === "DELETE") {
        if (!id) return json({ error: "id required" }, 400);
        const g = await getGroups(env);
        if (g.length <= 1) return json({ error: "至少保留一个分区" }, 400);
        const target = g.find((x) => x.id === id);
        if (!target) return json({ error: "not found" }, 404);
        const fallback = g.find((x) => x.id !== id).id;
        const cats = await getCats(env);
        const bms = await getBms(env);
        for (const c of cats) if (c.group === id) c.group = fallback;
        for (const b of bms) if (b.group === id) b.group = fallback;
        await setCats(env, cats);
        await setBms(env, bms);
        await setGroups(env, g.filter((x) => x.id !== id));
        return json({ ok: true, fallback });
      }
    }

    // ---- 站点信息 ----
    if (head === "site") {
      if (method === "GET") {
        const o = await getSite(env);
        return json(o);
      }
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(request);
        const o = await getSite(env);
        if (body.name != null) o.name = String(body.name).slice(0, 40);
        if (body.author != null) o.author = String(body.author).slice(0, 40);
        if (body.url != null) o.url = String(body.url).slice(0, 120);
        await setSite(env, o);
        return json(o);
      }
    }

    return json({ error: "not found", path }, 404);
  },
};


const EMBEDDED_ASSETS = {"/":"<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n<meta name=\"theme-color\" content=\"#111217\" />\n<link rel=\"manifest\" href=\"/manifest.webmanifest\" />\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\" />\n<link rel=\"apple-touch-icon\" href=\"/pwa-icon.png\" />\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%96%3C/text%3E%3C/svg%3E\" />\n<title>书签中心</title>\n<!-- 尽早发出首屏数据请求（不等 app.js 下载执行），省一个往返 -->\n<script>window.__boot = fetch(\"/api/bootstrap?icons=1\", { credentials: \"same-origin\" }).catch(function(){ return new Response(null, { status: 599 }); });</script>\n<style>\n  :root{ --bg:#111217; --panel:#181a20; --panel2:#20232a; --line:#2a2e37; --tx:#e8eaed; --mut:#8b929d; --acc:#4f8cff; --acc2:#3b6fd4; --danger:#ff5d5d; --ok:#3ecf8e; --work:#ff9f43; }\n  *{box-sizing:border-box}\n  html,body{height:100%}\n  body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;overflow:hidden;display:flex;flex-direction:column}\n  a{color:inherit;text-decoration:none}\n  button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--tx);padding:6px 10px;border-radius:8px;transition:.15s;white-space:nowrap}\n  button:hover{border-color:var(--acc);background:#252830}\n  button.primary{background:var(--acc);border-color:var(--acc);color:#fff}\n  button.primary:hover{background:var(--acc2)}\n  button.danger{color:var(--danger);border-color:#5a2a2a}\n  button.danger:hover{background:#3a1d1d}\n  button.ghost{background:transparent}\n  button.small{padding:4px 8px;font-size:12px;border-radius:6px}\n\n  header{height:48px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel);flex:none}\n  header h1{font-size:15px;margin:0;font-weight:600;display:flex;align-items:center;gap:8px}\n  .spacer{flex:1}\n  .tabs{display:flex;gap:4px;background:var(--panel2);padding:3px;border-radius:10px}\n  .tabs button{border:none;background:transparent;padding:5px 14px;border-radius:7px;font-size:13px;color:var(--mut)}\n  .tabs button.active{background:var(--acc);color:#fff}\n\n  .layout{display:flex;flex:1;min-height:0}\n  .foot{height:34px;flex:none;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--panel);border-top:1px solid var(--line);color:var(--mut);font-size:12px}\n  .foot .dot{opacity:.5}\n  .foot a{color:var(--acc)}\n  .side{width:170px;flex:none;border-right:1px solid var(--line);background:var(--panel);padding:10px 0;overflow:auto;display:flex;flex-direction:column}\n  .side h2{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin:0 14px 8px}\n  .cat{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;color:var(--mut);border-left:2px solid transparent}\n  .cat:hover{background:var(--panel2);color:var(--tx)}\n  .cat.active{color:var(--tx);background:var(--panel2);border-left-color:var(--acc)}\n  .cat .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}\n  .cat .cnt{font-size:11px;background:var(--panel2);border:1px solid var(--line);padding:1px 6px;border-radius:999px}\n  .cat.active .cnt{background:var(--acc);color:#fff;border-color:var(--acc)}\n  .cat .add{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;border:1px solid var(--line);background:var(--panel2);color:var(--mut);border-radius:6px;cursor:pointer;opacity:.5;transition:.12s}\n  .cat:hover .add,.cat.active .add,.cat .add:focus-visible{opacity:1}\n  .cat .add:hover{background:var(--acc);border-color:var(--acc);color:#fff}\n  .cat.active .add:hover{background:#fff;border-color:#fff;color:var(--acc)}\n  .resizer{width:5px;flex:none;cursor:col-resize;background:transparent;margin-left:-3px;z-index:8}\n  .resizer:hover{background:var(--acc)}\n\n  main{flex:1;overflow:auto;padding:18px 22px}\n  .bar{display:flex;align-items:center;gap:10px;margin-bottom:14px;position:sticky;top:0;background:var(--bg);z-index:5;padding:4px 0}\n  .bar h3{margin:0;font-size:15px;font-weight:600}\n  .bar .count{color:var(--mut);font-size:12px}\n\n  .sec{margin-bottom:18px}\n  .sec-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}\n  .sec-head h4{margin:0;font-size:14px;font-weight:600;color:var(--tx);display:flex;align-items:center;gap:8px}\n  .sec-head .count{color:var(--mut);font-size:11px;background:var(--panel);border:1px solid var(--line);padding:1px 7px;border-radius:999px}\n  .items{display:flex;flex-wrap:wrap;gap:8px}\n  .item{display:inline-flex;align-items:center;gap:8px;width:180px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:grab;transition:.12s}\n  .item:hover{background:var(--panel2);border-color:var(--acc);transform:translateY(-1px)}\n  .item.dragging{opacity:.45;cursor:grabbing}\n  .item img{width:18px;height:18px;flex:none;object-fit:contain;border-radius:3px}\n  .item .icon-wrap{position:relative;display:inline-flex;flex:none;width:18px;height:18px}\n  .item .note-mark{position:absolute;right:-6px;top:-7px;width:12px;height:12px;border-radius:50%;background:#ff9f43;color:#241500;border:1px solid var(--panel);box-shadow:0 0 0 1px #0003;cursor:help;text-align:center;font:bold 9px/11px sans-serif}\n  .item .note-mark::after{content:attr(data-note);position:absolute;left:12px;top:-5px;z-index:20;display:none;min-width:150px;max-width:260px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--tx);font-size:12px;line-height:1.4;white-space:normal;box-shadow:0 6px 18px #0008;pointer-events:none}\n  .item .note-mark:hover::after,.item .note-mark:focus-visible::after{display:block}\n  .item .add{flex:none;width:18px;height:18px;margin-left:6px;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;padding:0;border:1px solid var(--line);background:var(--panel2);color:var(--mut);border-radius:6px;cursor:pointer;opacity:0;transition:.12s}\n  .item:hover .add,.item:focus-within .add,.item .add:focus-visible{opacity:1}\n  .item .add:hover{background:var(--acc);border-color:var(--acc);color:#fff}\n  .item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;flex:1;min-width:0}\n  .edit-tools{display:none;gap:4px;margin-top:4px;width:100%}\n  .cat-tools{display:none;gap:3px;width:100%;flex-wrap:wrap}\n  body.edit-mode .cat{flex-wrap:wrap}\n  body.edit-mode .cat-tools{display:flex}\n  body.edit-mode .item{flex-wrap:wrap;cursor:default}\n  body.edit-mode .edit-tools{display:flex}\n  .edit-tools button{padding:4px 6px;font-size:12px}\n  .link-state{font-size:11px;color:var(--mut)}\n  .link-state.broken{color:var(--danger)}\n  .sec.drop-ok{outline:2px dashed var(--acc);outline-offset:-3px;border-radius:10px;background:var(--panel2)}\n  .tabs button.drop-ok{background:var(--acc);color:#fff;outline:2px dashed #fff;outline-offset:-3px}\n  .item.drop-before{box-shadow:inset 0 3px 0 0 var(--acc)}\n  .item.drop-after{box-shadow:inset 0 -3px 0 0 var(--acc)}\n  .cat.drop-before{border-top:2px solid var(--acc)}\n  .cat.drop-after{border-bottom:2px solid var(--acc)}\n  .item img{width:18px;height:18px;flex:none;object-fit:contain;border-radius:3px}\n  .item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;flex:1;min-width:0}\n  .empty{color:var(--mut);padding:30px 0;font-size:13px}\n\n  .ctx{position:fixed;min-width:140px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:0 8px 28px #000a;display:none;z-index:95}\n  .ctx.show{display:block}\n  .ctx-item{padding:8px 12px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--tx);display:flex;justify-content:space-between;align-items:center;gap:10px}\n  .ctx-item:hover{background:var(--panel2)}\n  .ctx-item.danger{color:var(--danger)}\n  .ctx-item.has-sub .ctx-arrow{color:var(--mut);font-size:11px}\n  .ctx-sub{display:block;left:0;top:0;margin:0}\n  .ctx-sep{height:1px;background:var(--line);margin:5px 4px}\n\n  .drawer{position:fixed;inset:0 0 0 auto;width:320px;max-width:88vw;background:var(--panel);border-left:1px solid var(--line);transform:translateX(100%);transition:.2s;z-index:60;display:flex;flex-direction:column}\n  .drawer.show{transform:translateX(0)}\n  .drawer-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}\n  .drawer-head h3{margin:0;font-size:15px;flex:1}\n  .drawer-body{flex:1;overflow:auto;padding:12px 16px 20px}\n  .setting{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}\n  .setting:last-child{border-bottom:none}\n  .setting>div{flex:1}\n  .setting label{font-size:13px;font-weight:500;display:block;margin-bottom:2px}\n  .setting small{font-size:11px;color:var(--mut)}\n\n  .modal{position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center;z-index:70}\n  .modal.show{display:flex}\n  .box{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;width:440px;max-width:92vw;max-height:92vh;overflow:auto}\n  .box h3{margin:0 0 14px;font-size:15px}\n  .field{margin-bottom:12px}\n  .field label{display:block;color:var(--mut);font-size:12px;margin-bottom:5px}\n  .field input,.field select,.field textarea{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font:inherit}\n  .field textarea{resize:vertical;min-height:60px}\n  .row{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}\n\n  .toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--line);padding:9px 16px;border-radius:10px;opacity:0;transition:.25s;pointer-events:none;z-index:90;font-size:13px}\n  .toast.show{opacity:1}\n\n  .search{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px 26px 6px 10px;font:inherit;outline:none}\n  .search:focus{border-color:var(--acc)}\n  .search::placeholder{color:var(--mut)}\n  mark{background:rgba(79,140,255,.32);color:inherit;border-radius:3px;padding:0 1px}\n  .upd-info{font-size:12px;color:var(--mut);line-height:1.6;margin:-4px 0 12px;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px}\n  .upd-info a{color:var(--acc)}\n\n  /* ---------- 整体细节优化 ---------- */\n  :root{color-scheme:dark}\n  *::-webkit-scrollbar{width:10px;height:10px}\n  *::-webkit-scrollbar-thumb{background:#2f3440;border-radius:999px;border:2px solid transparent;background-clip:content-box}\n  *::-webkit-scrollbar-thumb:hover{background:#3a4150;background-clip:content-box}\n  *::-webkit-scrollbar-track{background:transparent}\n  button,.cat,.item,.tabs button{-webkit-tap-highlight-color:transparent;user-select:none}\n  button:focus-visible,.cat:focus-visible,.item:focus-visible,.search:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}\n  .item{box-shadow:0 1px 2px #0004}\n  .item:hover{box-shadow:0 6px 18px #0007}\n  .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:48px 16px;color:var(--mut)}\n  .empty::before{content:\"🗂️\";font-size:20px;opacity:.75}\n  .items .empty{display:block;padding:10px 0}\n  .items .empty::before{content:none}\n  .toast{box-shadow:0 10px 34px #0008;max-width:82vw;text-align:center}\n  .search-wrap{position:relative;display:flex;align-items:center;width:190px}\n  .search-clear{position:absolute;right:5px;display:none;border:none;background:transparent;color:var(--mut);padding:2px 5px;border-radius:6px;line-height:1;font-size:12px;cursor:pointer}\n  .search-clear:hover{color:var(--tx);background:var(--panel2)}\n  .search-wrap.has-q .search-clear{display:block}\n  .skel-head{height:14px;width:130px;border-radius:6px;background:var(--panel2);margin-bottom:10px}\n  .skel-item{width:180px;height:34px;border-radius:8px;background:var(--panel2)}\n  .skel-sec{animation:skelPulse 1.2s ease-in-out infinite}\n  @keyframes skelPulse{0%,100%{opacity:.5}50%{opacity:.95}}\n  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n\n  .grp-row{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;background:var(--bg);border:1px solid var(--line);border-radius:8px}\n  .grp-row.dragging{opacity:.5}\n  .grp-row.drop-before{box-shadow:inset 0 2px 0 0 var(--acc)}\n  .grp-row.drop-after{box-shadow:inset 0 -2px 0 0 var(--acc)}\n  .grp-drag{cursor:grab;color:var(--mut);font-size:14px;line-height:1;user-select:none}\n  .grp-drag:active{cursor:grabbing}\n  .grp-row .grp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}\n\n  @media (max-width:700px){\n    /* 头部换行：标题+按钮一行；分区标签一行；搜索整行 */\n    header{flex-wrap:wrap;height:auto;padding:8px 10px;row-gap:8px;column-gap:8px}\n    header h1{font-size:14px;flex:1 1 auto;min-width:0}\n    .spacer{display:none}\n    #btnSettings,#btnEditMode,#btnAddBm,#btnLogin{order:1}\n    .tabs{flex:1 1 100%;order:2;overflow-x:auto}\n    .search-wrap{flex:1 1 100%;order:3;width:100%}\n\n    /* 布局改竖向：分类变顶部横向滚动胶囊条 */\n    .layout{flex-direction:column}\n    .resizer{display:none}\n    .side{display:none}\n    .side::-webkit-scrollbar{display:none}\n    .side h2{display:none}\n    .cat{width:auto;flex:none;padding:6px 12px;border-left:none;border:1px solid var(--line);border-radius:999px;color:var(--mut);justify-content:center}\n    .cat .name{display:block}\n    .cat .cnt{margin-left:6px}\n    .cat.active{background:var(--acc);border-color:var(--acc);color:#fff}\n    .cat.active .cnt{background:#fff;color:var(--acc);border-color:#fff}\n    .cat .add{opacity:1;width:16px;height:16px;font-size:13px}\n\n    main{padding:12px 12px}\n    .bar{margin-bottom:10px}\n    .bar h3{font-size:14px}\n\n    /* 书签两列撑满 */\n    .items{gap:8px}\n    .item{width:auto;flex:1 1 calc(50% - 4px);min-height:38px}\n    .item .add{opacity:1;width:16px;height:16px;font-size:14px}\n  }\n</style>\n</head>\n<body>\n<header>\n  <h1 id=\"siteName\">🔖 书签中心</h1>\n  <div class=\"tabs\" id=\"groupTabs\">\n    <button data-g=\"personal\" class=\"active\">个人</button>\n    <button data-g=\"work\">工作</button>\n  </div>\n  <span class=\"search-wrap\" id=\"searchWrap\">\n    <input id=\"search\" class=\"search\" placeholder=\"搜索书签 (Ctrl/⌘+K)\" />\n    <button class=\"search-clear\" id=\"searchClear\" type=\"button\" aria-label=\"清空搜索\">✕</button>\n  </span>\n  <span class=\"spacer\"></span>\n  <button class=\"ghost\" id=\"btnSettings\">设置</button>\n  <button class=\"ghost\" id=\"btnEditMode\">编辑模式</button>\n  <button class=\"primary\" id=\"btnAddBm\">+ 书签</button>\n  <button class=\"primary\" id=\"btnLogin\">登录</button>\n</header>\n\n<div class=\"layout\">\n  <aside class=\"side\" id=\"catNav\">\n    <h2>分类</h2>\n    <div id=\"catList\"></div>\n  </aside>\n  <div class=\"resizer\" id=\"sideResizer\"></div>\n  <main id=\"mainWrap\">\n    <div class=\"bar\">\n      <h3 id=\"curTitle\">全部</h3>\n      <span class=\"count\" id=\"curCount\"></span>\n      <span class=\"spacer\"></span>\n    </div>\n    <div id=\"content\"></div>\n  </main>\n</div>\n\n<footer class=\"foot\">\n  <span id=\"siteAuthor\">gai溜子到处跑</span>\n  <span class=\"dot\">·</span>\n  <a id=\"siteUrl\" href=\"https://www.090803.xyz\" target=\"_blank\" rel=\"noopener\">www.090803.xyz</a>\n  <span class=\"dot\">·</span>\n  <span id=\"siteVer\">v4.9-noteone</span>\n  <span class=\"dot\">·</span>\n  <a id=\"repoLink\" href=\"https://github.com/gaigogogo/web-book\" target=\"_blank\" rel=\"noopener\">GitHub 更新</a>\n</footer>\n\n<!-- 设置抽屉 -->\n<div class=\"drawer\" id=\"settingsDrawer\">\n  <div class=\"drawer-head\">\n    <h3>设置</h3>\n    <button class=\"ghost\" id=\"btnCloseSettings\">✕</button>\n  </div>\n  <div class=\"drawer-body\">\n    <div class=\"setting\"><div><label>检查网址</label><small>优先检查未检或过期项；正常/失效结果保留24小时，待确认保留1小时。404/410为失效，超时等为待确认。</small><div id=\"linkCheckInfo\" aria-live=\"polite\"></div><button id=\"btnRecheckLinks\" class=\"small\">重新检查全部</button><button id=\"btnStopLinks\" class=\"small\" hidden>暂停</button></div><button id=\"btnCheckLinks\" class=\"small\">继续检查</button></div>\n    <div class=\"setting\"><div><label>主屏幕与离线访问</label><small>安装后保留本机页面及书签快照；离线只读，退出登录清理离线页面。iPad：Safari 分享 → 添加到主屏幕。</small></div><button id=\"btnInstall\" class=\"small\">启用离线</button></div>\n    <div class=\"setting\"><div><label>快速添加小工具</label><small>把下面链接拖到电脑书签栏，浏览网页时点击可收录</small><a id=\"bookmarklet\" style=\"color:var(--acc)\">保存到导航站</a></div></div>\n    <div class=\"setting\">\n      <div><label>本地缓存</label><small>再次打开先显示缓存；修改内容后可手动同步最新数据</small></div>\n      <button class=\"small\" id=\"btnRefreshData\">刷新数据</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>站点信息</label><small>名称、作者、网址，显示在首页底部</small></div>\n      <button class=\"small\" id=\"btnEditSite\">编辑</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>分区管理</label><small>添加 / 删除「个人区 / 工作区」等分组</small></div>\n    </div>\n    <div id=\"groupList\" style=\"margin:0 0 8px\"></div>\n    <div style=\"display:flex;gap:8px;margin-bottom:14px\">\n      <input id=\"newGroupName\" placeholder=\"新分区名称\" style=\"flex:1;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:7px 10px;font:inherit\" />\n      <button class=\"primary small\" id=\"btnAddGroup\">+ 添加</button>\n    </div>\n    <small style=\"display:block;color:var(--mut);margin:-6px 0 14px;line-height:1.6\">提示：在书签上按住拖动，可把它拖到顶部分区标签（改分区）或拖到某个分类区（改分类，并随其所在分区移动）。下方分区列表可按住拖动排序。</small>\n    <div class=\"setting\" style=\"border-top:1px solid var(--line)\">\n      <div><label>更新图标</label><small>抓取所有书签的 favicon，失败保持占位</small></div>\n      <button class=\"primary small\" id=\"btnRefreshIcons\">更新</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>备份数据</label><small>导出 JSON 到本地</small></div>\n      <button class=\"small\" id=\"btnBackup\">备份</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>备份到邮箱</label><small>把备份 JSON 作为附件发到你的邮箱</small></div>\n      <div style=\"display:flex;gap:6px;align-items:center\">\n        <input id=\"bakEmail\" placeholder=\"收件邮箱\" style=\"width:170px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:5px 8px;font:inherit;outline:none\" />\n        <button class=\"small\" id=\"btnBackupEmail\">发送</button>\n      </div>\n    </div>\n    <div class=\"setting\">\n      <div><label>恢复数据</label><small>从 JSON 文件恢复分类、书签、图标</small></div>\n      <button class=\"small\" id=\"btnRestore\">恢复</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>站点密码</label><small>修改登录密码</small></div>\n      <button class=\"small\" id=\"btnPwd\">修改</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>访问密码锁</label><small>开启后进站需先输入密码；关闭则公开只读</small></div>\n      <button class=\"small\" id=\"btnGate\">访问锁</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>免密访问密钥</label><small>生成长密钥，用带密钥的链接可直接进站</small></div>\n      <button class=\"small\" id=\"btnAccessKey\">管理</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>关于 / 更新</label><small>当前版本与 GitHub 更新检查</small></div>\n      <button class=\"small\" id=\"btnCheckUpdate\">检查更新</button>\n    </div>\n    <div id=\"updateInfo\" class=\"upd-info\" style=\"display:none\"></div>\n    <div class=\"setting\">\n      <div><label>清空全部</label><small>删除所有分类和书签，建议先备份</small></div>\n      <button class=\"danger small\" id=\"btnWipe\">清空</button>\n    </div>\n  </div>\n</div>\n\n<!-- 登录 -->\n<div class=\"modal\" id=\"loginModal\">\n  <div class=\"box\">\n    <h3>登录</h3>\n    <div class=\"field\"><label>密码</label><input id=\"pwd\" type=\"password\" placeholder=\"请输入站点密码\" /></div>\n    <div class=\"row\"><button id=\"loginCancel\" class=\"ghost\">取消</button><button id=\"loginOk\" class=\"primary\">登录</button></div>\n  </div>\n</div>\n\n<!-- 分类删除确认 -->\n<div class=\"modal\" id=\"catDeleteModal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"catDeleteTitle\">\n  <div class=\"box\">\n    <h3 id=\"catDeleteTitle\">删除分类</h3>\n    <p id=\"catDeleteMessage\"></p>\n    <p style=\"color:var(--mut);font-size:12px\">此操作不可恢复。</p>\n    <div class=\"row\"><button id=\"catDeleteCancel\" class=\"ghost\">取消</button><button id=\"catDeleteOk\" class=\"primary\">确认删除</button></div>\n  </div>\n</div>\n\n<!-- 分类编辑 -->\n<div class=\"modal\" id=\"catModal\">\n  <div class=\"box\">\n    <h3 id=\"catTitle\">新建分类</h3>\n    <div class=\"field\"><label>名称</label><input id=\"catName\" placeholder=\"分类名\" /></div>\n    <div class=\"field\"><label>归属</label><select id=\"catGroup\"></select></div>\n    <div class=\"row\"><button id=\"catCancel\" class=\"ghost\">取消</button><button id=\"catSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 书签编辑 -->\n<div class=\"modal\" id=\"bmModal\">\n  <div class=\"box\">\n    <h3 id=\"bmTitle\">新建书签</h3>\n    <div class=\"field\"><label>标题</label><input id=\"bmTitle_in\" placeholder=\"标题\" /></div>\n    <div class=\"field\"><label>URL</label><input id=\"bmUrl\" placeholder=\"https://\" /><button id=\"btnFetchTitle\" type=\"button\" class=\"small\">获取标题与图标</button><small id=\"metadataStatus\" aria-live=\"polite\"></small></div>\n    <div class=\"field\"><label>分类</label><select id=\"bmCat\"></select></div>\n    <div class=\"field\"><label>归属</label><select id=\"bmGroup\"></select></div>\n    <div class=\"field\"><label>备注</label><textarea id=\"bmNote\" placeholder=\"可选\"></textarea></div>\n    <div class=\"row\"><button id=\"bmCancel\" class=\"ghost\">取消</button><button id=\"bmSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 修改密码 -->\n<div class=\"modal\" id=\"pwdModal\">\n  <div class=\"box\">\n    <h3>修改密码</h3>\n    <div class=\"field\"><label>新密码</label><input id=\"pwdNew\" type=\"password\" placeholder=\"不少于 4 位\" /></div>\n    <div class=\"field\"><label>确认密码</label><input id=\"pwdNew2\" type=\"password\" placeholder=\"再输一次\" /></div>\n    <div class=\"row\"><button id=\"pwdCancel\" class=\"ghost\">取消</button><button id=\"pwdOk\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 免密访问密钥 -->\n<div class=\"modal\" id=\"accessModal\">\n  <div class=\"box\">\n    <h3>免密访问密钥</h3>\n    <div class=\"field\"><label>长密钥</label><input id=\"accessKeyIn\" placeholder=\"自定义或点击「重新生成」\" /></div>\n    <div class=\"field\"><label>免密链接（打开即进站）</label><input id=\"accessLink\" readonly /></div>\n    <div class=\"row\" style=\"justify-content:flex-start\">\n      <button class=\"ghost small\" id=\"btnCopyLink\">复制链接</button>\n      <button class=\"ghost small\" id=\"btnRegenKey\">重新生成</button>\n    </div>\n    <small style=\"display:block;color:var(--mut);margin:10px 0 0;line-height:1.6\">重新生成后旧链接立即失效；密钥只影响「进站」，修改数据仍需站点密码。</small>\n    <div class=\"row\"><button id=\"accessCancel\" class=\"ghost\">取消</button><button id=\"accessSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<input id=\"restoreFile\" type=\"file\" accept=\"application/json\" hidden />\n\n<!-- 站点信息编辑 -->\n<div class=\"modal\" id=\"siteModal\">\n  <div class=\"box\">\n    <h3>站点信息</h3>\n    <div class=\"field\"><label>站点名称</label><input id=\"siteNameIn\" placeholder=\"如 gai溜子导航站\" /></div>\n    <div class=\"field\"><label>作者</label><input id=\"siteAuthorIn\" placeholder=\"如 gai溜子到处跑\" /></div>\n    <div class=\"field\"><label>网址</label><input id=\"siteUrlIn\" placeholder=\"如 www.090803.xyz\" /></div>\n    <div class=\"row\"><button id=\"siteCancel\" class=\"ghost\">取消</button><button id=\"siteSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 重命名分区 -->\n<div class=\"modal\" id=\"grpModal\">\n  <div class=\"box\">\n    <h3 id=\"grpTitle\">重命名分区</h3>\n    <div class=\"field\"><label>名称</label><input id=\"grpName\" placeholder=\"分区名\" /></div>\n    <div class=\"row\"><button id=\"grpCancel\" class=\"ghost\">取消</button><button id=\"grpSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<div class=\"ctx\" id=\"ctxMenu\"></div>\n\n<script src=\"app.js?v=202610222338\"></script>\n</body>\n</html>\n\r\n","/index.html":"<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n<meta name=\"theme-color\" content=\"#111217\" />\n<link rel=\"manifest\" href=\"/manifest.webmanifest\" />\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\" />\n<link rel=\"apple-touch-icon\" href=\"/pwa-icon.png\" />\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%96%3C/text%3E%3C/svg%3E\" />\n<title>书签中心</title>\n<!-- 尽早发出首屏数据请求（不等 app.js 下载执行），省一个往返 -->\n<script>window.__boot = fetch(\"/api/bootstrap?icons=1\", { credentials: \"same-origin\" }).catch(function(){ return new Response(null, { status: 599 }); });</script>\n<style>\n  :root{ --bg:#111217; --panel:#181a20; --panel2:#20232a; --line:#2a2e37; --tx:#e8eaed; --mut:#8b929d; --acc:#4f8cff; --acc2:#3b6fd4; --danger:#ff5d5d; --ok:#3ecf8e; --work:#ff9f43; }\n  *{box-sizing:border-box}\n  html,body{height:100%}\n  body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;overflow:hidden;display:flex;flex-direction:column}\n  a{color:inherit;text-decoration:none}\n  button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--tx);padding:6px 10px;border-radius:8px;transition:.15s;white-space:nowrap}\n  button:hover{border-color:var(--acc);background:#252830}\n  button.primary{background:var(--acc);border-color:var(--acc);color:#fff}\n  button.primary:hover{background:var(--acc2)}\n  button.danger{color:var(--danger);border-color:#5a2a2a}\n  button.danger:hover{background:#3a1d1d}\n  button.ghost{background:transparent}\n  button.small{padding:4px 8px;font-size:12px;border-radius:6px}\n\n  header{height:48px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel);flex:none}\n  header h1{font-size:15px;margin:0;font-weight:600;display:flex;align-items:center;gap:8px}\n  .spacer{flex:1}\n  .tabs{display:flex;gap:4px;background:var(--panel2);padding:3px;border-radius:10px}\n  .tabs button{border:none;background:transparent;padding:5px 14px;border-radius:7px;font-size:13px;color:var(--mut)}\n  .tabs button.active{background:var(--acc);color:#fff}\n\n  .layout{display:flex;flex:1;min-height:0}\n  .foot{height:34px;flex:none;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--panel);border-top:1px solid var(--line);color:var(--mut);font-size:12px}\n  .foot .dot{opacity:.5}\n  .foot a{color:var(--acc)}\n  .side{width:170px;flex:none;border-right:1px solid var(--line);background:var(--panel);padding:10px 0;overflow:auto;display:flex;flex-direction:column}\n  .side h2{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin:0 14px 8px}\n  .cat{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;color:var(--mut);border-left:2px solid transparent}\n  .cat:hover{background:var(--panel2);color:var(--tx)}\n  .cat.active{color:var(--tx);background:var(--panel2);border-left-color:var(--acc)}\n  .cat .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}\n  .cat .cnt{font-size:11px;background:var(--panel2);border:1px solid var(--line);padding:1px 6px;border-radius:999px}\n  .cat.active .cnt{background:var(--acc);color:#fff;border-color:var(--acc)}\n  .cat .add{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;border:1px solid var(--line);background:var(--panel2);color:var(--mut);border-radius:6px;cursor:pointer;opacity:.5;transition:.12s}\n  .cat:hover .add,.cat.active .add,.cat .add:focus-visible{opacity:1}\n  .cat .add:hover{background:var(--acc);border-color:var(--acc);color:#fff}\n  .cat.active .add:hover{background:#fff;border-color:#fff;color:var(--acc)}\n  .resizer{width:5px;flex:none;cursor:col-resize;background:transparent;margin-left:-3px;z-index:8}\n  .resizer:hover{background:var(--acc)}\n\n  main{flex:1;overflow:auto;padding:18px 22px}\n  .bar{display:flex;align-items:center;gap:10px;margin-bottom:14px;position:sticky;top:0;background:var(--bg);z-index:5;padding:4px 0}\n  .bar h3{margin:0;font-size:15px;font-weight:600}\n  .bar .count{color:var(--mut);font-size:12px}\n\n  .sec{margin-bottom:18px}\n  .sec-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}\n  .sec-head h4{margin:0;font-size:14px;font-weight:600;color:var(--tx);display:flex;align-items:center;gap:8px}\n  .sec-head .count{color:var(--mut);font-size:11px;background:var(--panel);border:1px solid var(--line);padding:1px 7px;border-radius:999px}\n  .items{display:flex;flex-wrap:wrap;gap:8px}\n  .item{display:inline-flex;align-items:center;gap:8px;width:180px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:grab;transition:.12s}\n  .item:hover{background:var(--panel2);border-color:var(--acc);transform:translateY(-1px)}\n  .item.dragging{opacity:.45;cursor:grabbing}\n  .item img{width:18px;height:18px;flex:none;object-fit:contain;border-radius:3px}\n  .item .icon-wrap{position:relative;display:inline-flex;flex:none;width:18px;height:18px}\n  .item .note-mark{position:absolute;right:-6px;top:-7px;width:12px;height:12px;border-radius:50%;background:#ff9f43;color:#241500;border:1px solid var(--panel);box-shadow:0 0 0 1px #0003;cursor:help;text-align:center;font:bold 9px/11px sans-serif}\n  .item .note-mark::after{content:attr(data-note);position:absolute;left:12px;top:-5px;z-index:20;display:none;min-width:150px;max-width:260px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--tx);font-size:12px;line-height:1.4;white-space:normal;box-shadow:0 6px 18px #0008;pointer-events:none}\n  .item .note-mark:hover::after,.item .note-mark:focus-visible::after{display:block}\n  .item .add{flex:none;width:18px;height:18px;margin-left:6px;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;padding:0;border:1px solid var(--line);background:var(--panel2);color:var(--mut);border-radius:6px;cursor:pointer;opacity:0;transition:.12s}\n  .item:hover .add,.item:focus-within .add,.item .add:focus-visible{opacity:1}\n  .item .add:hover{background:var(--acc);border-color:var(--acc);color:#fff}\n  .item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;flex:1;min-width:0}\n  .edit-tools{display:none;gap:4px;margin-top:4px;width:100%}\n  .cat-tools{display:none;gap:3px;width:100%;flex-wrap:wrap}\n  body.edit-mode .cat{flex-wrap:wrap}\n  body.edit-mode .cat-tools{display:flex}\n  body.edit-mode .item{flex-wrap:wrap;cursor:default}\n  body.edit-mode .edit-tools{display:flex}\n  .edit-tools button{padding:4px 6px;font-size:12px}\n  .link-state{font-size:11px;color:var(--mut)}\n  .link-state.broken{color:var(--danger)}\n  .sec.drop-ok{outline:2px dashed var(--acc);outline-offset:-3px;border-radius:10px;background:var(--panel2)}\n  .tabs button.drop-ok{background:var(--acc);color:#fff;outline:2px dashed #fff;outline-offset:-3px}\n  .item.drop-before{box-shadow:inset 0 3px 0 0 var(--acc)}\n  .item.drop-after{box-shadow:inset 0 -3px 0 0 var(--acc)}\n  .cat.drop-before{border-top:2px solid var(--acc)}\n  .cat.drop-after{border-bottom:2px solid var(--acc)}\n  .item img{width:18px;height:18px;flex:none;object-fit:contain;border-radius:3px}\n  .item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;flex:1;min-width:0}\n  .empty{color:var(--mut);padding:30px 0;font-size:13px}\n\n  .ctx{position:fixed;min-width:140px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:0 8px 28px #000a;display:none;z-index:95}\n  .ctx.show{display:block}\n  .ctx-item{padding:8px 12px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--tx);display:flex;justify-content:space-between;align-items:center;gap:10px}\n  .ctx-item:hover{background:var(--panel2)}\n  .ctx-item.danger{color:var(--danger)}\n  .ctx-item.has-sub .ctx-arrow{color:var(--mut);font-size:11px}\n  .ctx-sub{display:block;left:0;top:0;margin:0}\n  .ctx-sep{height:1px;background:var(--line);margin:5px 4px}\n\n  .drawer{position:fixed;inset:0 0 0 auto;width:320px;max-width:88vw;background:var(--panel);border-left:1px solid var(--line);transform:translateX(100%);transition:.2s;z-index:60;display:flex;flex-direction:column}\n  .drawer.show{transform:translateX(0)}\n  .drawer-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}\n  .drawer-head h3{margin:0;font-size:15px;flex:1}\n  .drawer-body{flex:1;overflow:auto;padding:12px 16px 20px}\n  .setting{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}\n  .setting:last-child{border-bottom:none}\n  .setting>div{flex:1}\n  .setting label{font-size:13px;font-weight:500;display:block;margin-bottom:2px}\n  .setting small{font-size:11px;color:var(--mut)}\n\n  .modal{position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center;z-index:70}\n  .modal.show{display:flex}\n  .box{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;width:440px;max-width:92vw;max-height:92vh;overflow:auto}\n  .box h3{margin:0 0 14px;font-size:15px}\n  .field{margin-bottom:12px}\n  .field label{display:block;color:var(--mut);font-size:12px;margin-bottom:5px}\n  .field input,.field select,.field textarea{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font:inherit}\n  .field textarea{resize:vertical;min-height:60px}\n  .row{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}\n\n  .toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--line);padding:9px 16px;border-radius:10px;opacity:0;transition:.25s;pointer-events:none;z-index:90;font-size:13px}\n  .toast.show{opacity:1}\n\n  .search{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px 26px 6px 10px;font:inherit;outline:none}\n  .search:focus{border-color:var(--acc)}\n  .search::placeholder{color:var(--mut)}\n  mark{background:rgba(79,140,255,.32);color:inherit;border-radius:3px;padding:0 1px}\n  .upd-info{font-size:12px;color:var(--mut);line-height:1.6;margin:-4px 0 12px;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px}\n  .upd-info a{color:var(--acc)}\n\n  /* ---------- 整体细节优化 ---------- */\n  :root{color-scheme:dark}\n  *::-webkit-scrollbar{width:10px;height:10px}\n  *::-webkit-scrollbar-thumb{background:#2f3440;border-radius:999px;border:2px solid transparent;background-clip:content-box}\n  *::-webkit-scrollbar-thumb:hover{background:#3a4150;background-clip:content-box}\n  *::-webkit-scrollbar-track{background:transparent}\n  button,.cat,.item,.tabs button{-webkit-tap-highlight-color:transparent;user-select:none}\n  button:focus-visible,.cat:focus-visible,.item:focus-visible,.search:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}\n  .item{box-shadow:0 1px 2px #0004}\n  .item:hover{box-shadow:0 6px 18px #0007}\n  .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:48px 16px;color:var(--mut)}\n  .empty::before{content:\"🗂️\";font-size:20px;opacity:.75}\n  .items .empty{display:block;padding:10px 0}\n  .items .empty::before{content:none}\n  .toast{box-shadow:0 10px 34px #0008;max-width:82vw;text-align:center}\n  .search-wrap{position:relative;display:flex;align-items:center;width:190px}\n  .search-clear{position:absolute;right:5px;display:none;border:none;background:transparent;color:var(--mut);padding:2px 5px;border-radius:6px;line-height:1;font-size:12px;cursor:pointer}\n  .search-clear:hover{color:var(--tx);background:var(--panel2)}\n  .search-wrap.has-q .search-clear{display:block}\n  .skel-head{height:14px;width:130px;border-radius:6px;background:var(--panel2);margin-bottom:10px}\n  .skel-item{width:180px;height:34px;border-radius:8px;background:var(--panel2)}\n  .skel-sec{animation:skelPulse 1.2s ease-in-out infinite}\n  @keyframes skelPulse{0%,100%{opacity:.5}50%{opacity:.95}}\n  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}\n\n  .grp-row{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;background:var(--bg);border:1px solid var(--line);border-radius:8px}\n  .grp-row.dragging{opacity:.5}\n  .grp-row.drop-before{box-shadow:inset 0 2px 0 0 var(--acc)}\n  .grp-row.drop-after{box-shadow:inset 0 -2px 0 0 var(--acc)}\n  .grp-drag{cursor:grab;color:var(--mut);font-size:14px;line-height:1;user-select:none}\n  .grp-drag:active{cursor:grabbing}\n  .grp-row .grp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}\n\n  @media (max-width:700px){\n    /* 头部换行：标题+按钮一行；分区标签一行；搜索整行 */\n    header{flex-wrap:wrap;height:auto;padding:8px 10px;row-gap:8px;column-gap:8px}\n    header h1{font-size:14px;flex:1 1 auto;min-width:0}\n    .spacer{display:none}\n    #btnSettings,#btnEditMode,#btnAddBm,#btnLogin{order:1}\n    .tabs{flex:1 1 100%;order:2;overflow-x:auto}\n    .search-wrap{flex:1 1 100%;order:3;width:100%}\n\n    /* 布局改竖向：分类变顶部横向滚动胶囊条 */\n    .layout{flex-direction:column}\n    .resizer{display:none}\n    .side{display:none}\n    .side::-webkit-scrollbar{display:none}\n    .side h2{display:none}\n    .cat{width:auto;flex:none;padding:6px 12px;border-left:none;border:1px solid var(--line);border-radius:999px;color:var(--mut);justify-content:center}\n    .cat .name{display:block}\n    .cat .cnt{margin-left:6px}\n    .cat.active{background:var(--acc);border-color:var(--acc);color:#fff}\n    .cat.active .cnt{background:#fff;color:var(--acc);border-color:#fff}\n    .cat .add{opacity:1;width:16px;height:16px;font-size:13px}\n\n    main{padding:12px 12px}\n    .bar{margin-bottom:10px}\n    .bar h3{font-size:14px}\n\n    /* 书签两列撑满 */\n    .items{gap:8px}\n    .item{width:auto;flex:1 1 calc(50% - 4px);min-height:38px}\n    .item .add{opacity:1;width:16px;height:16px;font-size:14px}\n  }\n</style>\n</head>\n<body>\n<header>\n  <h1 id=\"siteName\">🔖 书签中心</h1>\n  <div class=\"tabs\" id=\"groupTabs\">\n    <button data-g=\"personal\" class=\"active\">个人</button>\n    <button data-g=\"work\">工作</button>\n  </div>\n  <span class=\"search-wrap\" id=\"searchWrap\">\n    <input id=\"search\" class=\"search\" placeholder=\"搜索书签 (Ctrl/⌘+K)\" />\n    <button class=\"search-clear\" id=\"searchClear\" type=\"button\" aria-label=\"清空搜索\">✕</button>\n  </span>\n  <span class=\"spacer\"></span>\n  <button class=\"ghost\" id=\"btnSettings\">设置</button>\n  <button class=\"ghost\" id=\"btnEditMode\">编辑模式</button>\n  <button class=\"primary\" id=\"btnAddBm\">+ 书签</button>\n  <button class=\"primary\" id=\"btnLogin\">登录</button>\n</header>\n\n<div class=\"layout\">\n  <aside class=\"side\" id=\"catNav\">\n    <h2>分类</h2>\n    <div id=\"catList\"></div>\n  </aside>\n  <div class=\"resizer\" id=\"sideResizer\"></div>\n  <main id=\"mainWrap\">\n    <div class=\"bar\">\n      <h3 id=\"curTitle\">全部</h3>\n      <span class=\"count\" id=\"curCount\"></span>\n      <span class=\"spacer\"></span>\n    </div>\n    <div id=\"content\"></div>\n  </main>\n</div>\n\n<footer class=\"foot\">\n  <span id=\"siteAuthor\">gai溜子到处跑</span>\n  <span class=\"dot\">·</span>\n  <a id=\"siteUrl\" href=\"https://www.090803.xyz\" target=\"_blank\" rel=\"noopener\">www.090803.xyz</a>\n  <span class=\"dot\">·</span>\n  <span id=\"siteVer\">v4.9-noteone</span>\n  <span class=\"dot\">·</span>\n  <a id=\"repoLink\" href=\"https://github.com/gaigogogo/web-book\" target=\"_blank\" rel=\"noopener\">GitHub 更新</a>\n</footer>\n\n<!-- 设置抽屉 -->\n<div class=\"drawer\" id=\"settingsDrawer\">\n  <div class=\"drawer-head\">\n    <h3>设置</h3>\n    <button class=\"ghost\" id=\"btnCloseSettings\">✕</button>\n  </div>\n  <div class=\"drawer-body\">\n    <div class=\"setting\"><div><label>检查网址</label><small>优先检查未检或过期项；正常/失效结果保留24小时，待确认保留1小时。404/410为失效，超时等为待确认。</small><div id=\"linkCheckInfo\" aria-live=\"polite\"></div><button id=\"btnRecheckLinks\" class=\"small\">重新检查全部</button><button id=\"btnStopLinks\" class=\"small\" hidden>暂停</button></div><button id=\"btnCheckLinks\" class=\"small\">继续检查</button></div>\n    <div class=\"setting\"><div><label>主屏幕与离线访问</label><small>安装后保留本机页面及书签快照；离线只读，退出登录清理离线页面。iPad：Safari 分享 → 添加到主屏幕。</small></div><button id=\"btnInstall\" class=\"small\">启用离线</button></div>\n    <div class=\"setting\"><div><label>快速添加小工具</label><small>把下面链接拖到电脑书签栏，浏览网页时点击可收录</small><a id=\"bookmarklet\" style=\"color:var(--acc)\">保存到导航站</a></div></div>\n    <div class=\"setting\">\n      <div><label>本地缓存</label><small>再次打开先显示缓存；修改内容后可手动同步最新数据</small></div>\n      <button class=\"small\" id=\"btnRefreshData\">刷新数据</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>站点信息</label><small>名称、作者、网址，显示在首页底部</small></div>\n      <button class=\"small\" id=\"btnEditSite\">编辑</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>分区管理</label><small>添加 / 删除「个人区 / 工作区」等分组</small></div>\n    </div>\n    <div id=\"groupList\" style=\"margin:0 0 8px\"></div>\n    <div style=\"display:flex;gap:8px;margin-bottom:14px\">\n      <input id=\"newGroupName\" placeholder=\"新分区名称\" style=\"flex:1;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:7px 10px;font:inherit\" />\n      <button class=\"primary small\" id=\"btnAddGroup\">+ 添加</button>\n    </div>\n    <small style=\"display:block;color:var(--mut);margin:-6px 0 14px;line-height:1.6\">提示：在书签上按住拖动，可把它拖到顶部分区标签（改分区）或拖到某个分类区（改分类，并随其所在分区移动）。下方分区列表可按住拖动排序。</small>\n    <div class=\"setting\" style=\"border-top:1px solid var(--line)\">\n      <div><label>更新图标</label><small>抓取所有书签的 favicon，失败保持占位</small></div>\n      <button class=\"primary small\" id=\"btnRefreshIcons\">更新</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>备份数据</label><small>导出 JSON 到本地</small></div>\n      <button class=\"small\" id=\"btnBackup\">备份</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>备份到邮箱</label><small>把备份 JSON 作为附件发到你的邮箱</small></div>\n      <div style=\"display:flex;gap:6px;align-items:center\">\n        <input id=\"bakEmail\" placeholder=\"收件邮箱\" style=\"width:170px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:5px 8px;font:inherit;outline:none\" />\n        <button class=\"small\" id=\"btnBackupEmail\">发送</button>\n      </div>\n    </div>\n    <div class=\"setting\">\n      <div><label>恢复数据</label><small>从 JSON 文件恢复分类、书签、图标</small></div>\n      <button class=\"small\" id=\"btnRestore\">恢复</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>站点密码</label><small>修改登录密码</small></div>\n      <button class=\"small\" id=\"btnPwd\">修改</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>访问密码锁</label><small>开启后进站需先输入密码；关闭则公开只读</small></div>\n      <button class=\"small\" id=\"btnGate\">访问锁</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>免密访问密钥</label><small>生成长密钥，用带密钥的链接可直接进站</small></div>\n      <button class=\"small\" id=\"btnAccessKey\">管理</button>\n    </div>\n    <div class=\"setting\">\n      <div><label>关于 / 更新</label><small>当前版本与 GitHub 更新检查</small></div>\n      <button class=\"small\" id=\"btnCheckUpdate\">检查更新</button>\n    </div>\n    <div id=\"updateInfo\" class=\"upd-info\" style=\"display:none\"></div>\n    <div class=\"setting\">\n      <div><label>清空全部</label><small>删除所有分类和书签，建议先备份</small></div>\n      <button class=\"danger small\" id=\"btnWipe\">清空</button>\n    </div>\n  </div>\n</div>\n\n<!-- 登录 -->\n<div class=\"modal\" id=\"loginModal\">\n  <div class=\"box\">\n    <h3>登录</h3>\n    <div class=\"field\"><label>密码</label><input id=\"pwd\" type=\"password\" placeholder=\"请输入站点密码\" /></div>\n    <div class=\"row\"><button id=\"loginCancel\" class=\"ghost\">取消</button><button id=\"loginOk\" class=\"primary\">登录</button></div>\n  </div>\n</div>\n\n<!-- 分类删除确认 -->\n<div class=\"modal\" id=\"catDeleteModal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"catDeleteTitle\">\n  <div class=\"box\">\n    <h3 id=\"catDeleteTitle\">删除分类</h3>\n    <p id=\"catDeleteMessage\"></p>\n    <p style=\"color:var(--mut);font-size:12px\">此操作不可恢复。</p>\n    <div class=\"row\"><button id=\"catDeleteCancel\" class=\"ghost\">取消</button><button id=\"catDeleteOk\" class=\"primary\">确认删除</button></div>\n  </div>\n</div>\n\n<!-- 分类编辑 -->\n<div class=\"modal\" id=\"catModal\">\n  <div class=\"box\">\n    <h3 id=\"catTitle\">新建分类</h3>\n    <div class=\"field\"><label>名称</label><input id=\"catName\" placeholder=\"分类名\" /></div>\n    <div class=\"field\"><label>归属</label><select id=\"catGroup\"></select></div>\n    <div class=\"row\"><button id=\"catCancel\" class=\"ghost\">取消</button><button id=\"catSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 书签编辑 -->\n<div class=\"modal\" id=\"bmModal\">\n  <div class=\"box\">\n    <h3 id=\"bmTitle\">新建书签</h3>\n    <div class=\"field\"><label>标题</label><input id=\"bmTitle_in\" placeholder=\"标题\" /></div>\n    <div class=\"field\"><label>URL</label><input id=\"bmUrl\" placeholder=\"https://\" /><button id=\"btnFetchTitle\" type=\"button\" class=\"small\">获取标题与图标</button><small id=\"metadataStatus\" aria-live=\"polite\"></small></div>\n    <div class=\"field\"><label>分类</label><select id=\"bmCat\"></select></div>\n    <div class=\"field\"><label>归属</label><select id=\"bmGroup\"></select></div>\n    <div class=\"field\"><label>备注</label><textarea id=\"bmNote\" placeholder=\"可选\"></textarea></div>\n    <div class=\"row\"><button id=\"bmCancel\" class=\"ghost\">取消</button><button id=\"bmSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 修改密码 -->\n<div class=\"modal\" id=\"pwdModal\">\n  <div class=\"box\">\n    <h3>修改密码</h3>\n    <div class=\"field\"><label>新密码</label><input id=\"pwdNew\" type=\"password\" placeholder=\"不少于 4 位\" /></div>\n    <div class=\"field\"><label>确认密码</label><input id=\"pwdNew2\" type=\"password\" placeholder=\"再输一次\" /></div>\n    <div class=\"row\"><button id=\"pwdCancel\" class=\"ghost\">取消</button><button id=\"pwdOk\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 免密访问密钥 -->\n<div class=\"modal\" id=\"accessModal\">\n  <div class=\"box\">\n    <h3>免密访问密钥</h3>\n    <div class=\"field\"><label>长密钥</label><input id=\"accessKeyIn\" placeholder=\"自定义或点击「重新生成」\" /></div>\n    <div class=\"field\"><label>免密链接（打开即进站）</label><input id=\"accessLink\" readonly /></div>\n    <div class=\"row\" style=\"justify-content:flex-start\">\n      <button class=\"ghost small\" id=\"btnCopyLink\">复制链接</button>\n      <button class=\"ghost small\" id=\"btnRegenKey\">重新生成</button>\n    </div>\n    <small style=\"display:block;color:var(--mut);margin:10px 0 0;line-height:1.6\">重新生成后旧链接立即失效；密钥只影响「进站」，修改数据仍需站点密码。</small>\n    <div class=\"row\"><button id=\"accessCancel\" class=\"ghost\">取消</button><button id=\"accessSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<input id=\"restoreFile\" type=\"file\" accept=\"application/json\" hidden />\n\n<!-- 站点信息编辑 -->\n<div class=\"modal\" id=\"siteModal\">\n  <div class=\"box\">\n    <h3>站点信息</h3>\n    <div class=\"field\"><label>站点名称</label><input id=\"siteNameIn\" placeholder=\"如 gai溜子导航站\" /></div>\n    <div class=\"field\"><label>作者</label><input id=\"siteAuthorIn\" placeholder=\"如 gai溜子到处跑\" /></div>\n    <div class=\"field\"><label>网址</label><input id=\"siteUrlIn\" placeholder=\"如 www.090803.xyz\" /></div>\n    <div class=\"row\"><button id=\"siteCancel\" class=\"ghost\">取消</button><button id=\"siteSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<!-- 重命名分区 -->\n<div class=\"modal\" id=\"grpModal\">\n  <div class=\"box\">\n    <h3 id=\"grpTitle\">重命名分区</h3>\n    <div class=\"field\"><label>名称</label><input id=\"grpName\" placeholder=\"分区名\" /></div>\n    <div class=\"row\"><button id=\"grpCancel\" class=\"ghost\">取消</button><button id=\"grpSave\" class=\"primary\">保存</button></div>\n  </div>\n</div>\n\n<div class=\"ctx\" id=\"ctxMenu\"></div>\n\n<script src=\"app.js?v=202610222338\"></script>\n</body>\n</html>\n\r\n","/app.js":"// 书签中心前端（EdgeOne Makers 同源版）\nconst API = \"\";\nlet TOKEN = localStorage.getItem(\"bm_token\") || \"\";\nlet CATS = [];\nlet BMS = [];\nlet ICONS = {};\nlet GROUPS = [{ id: \"personal\", name: \"个人区\" }, { id: \"work\", name: \"工作区\" }];\nlet SITE = { name: \"gai溜子导航站\", author: \"gai溜子到处跑\", url: \"www.090803.xyz\" };\nconst VERSION = \"202610222338\";\nconst APP_VERSION = \"v4.9-noteone\";\nconst SNAPSHOT_VERSION = 4;\nconst REPO_URL = \"https://github.com/gaigogogo/web-book\";\nlet SEARCH_Q = \"\";\nlet GROUP = localStorage.getItem(\"bm_group\") || \"personal\";\nlet ACTIVE_CAT = \"all\";\nlet DRAG_BM = null; // 当前被拖拽的书签\nlet DRAG_CAT = null; // 当前被拖拽的分类\nlet DRAG_GRP = null; // 当前被拖拽的分区\nlet EDIT_MODE = false;\nfunction clearDropHints() {\n  document.querySelectorAll(\".drop-ok, .drop-before, .drop-after\").forEach((n) => n.classList.remove(\"drop-ok\", \"drop-before\", \"drop-after\"));\n}\n\nfunction hostOf(url) {\n  try { return new URL(url).host; } catch { return \"\"; }\n}\nfunction el(id) { return document.getElementById(id); }\nfunction esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"]/g, (m) => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",\"\\\"\":\"&quot;\"}[m])); }\n\nfunction hl(text, q) {\n  const s = String(text == null ? \"\" : text);\n  if (!q) return esc(s);\n  const i = s.toLowerCase().indexOf(String(q).toLowerCase());\n  if (i < 0) return esc(s);\n  return esc(s.slice(0, i)) + \"<mark>\" + esc(s.slice(i, i + q.length)) + \"</mark>\" + esc(s.slice(i + q.length));\n}\n\nfunction toast(msg) {\n  let t = document.querySelector(\".toast\");\n  if (!t) { t = document.createElement(\"div\"); t.className = \"toast\"; document.body.appendChild(t); }\n  t.textContent = msg; t.classList.add(\"show\");\n  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove(\"show\"), 2200);\n}\n\nfunction renderSkeleton() {\n  const c = el(\"content\"); if (!c || c.children.length) return;\n  let h = \"\";\n  for (let sk = 0; sk < 3; sk++) {\n    h += '<div class=\"sec skel-sec\"><div class=\"skel-head\"></div><div class=\"items\">';\n    for (let i = 0; i < 5; i++) h += '<div class=\"skel-item\"></div>';\n    h += \"</div></div>\";\n  }\n  c.innerHTML = h;\n}\n\nfunction letterIconSvg(host) {\n  const ch = (host || \"?\").charAt(0).toUpperCase();\n  const svg = `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\"><rect width=\"18\" height=\"18\" rx=\"4\" fill=\"#4b5563\"/><text x=\"9\" y=\"13\" font-size=\"12\" text-anchor=\"middle\" fill=\"#fff\" font-family=\"sans-serif\">${ch}</text></svg>`;\n  return \"data:image/svg+xml;base64,\" + btoa(unescape(encodeURIComponent(svg)));\n}\n// 有整包图标时直接用内联 data URL；没有（本地快照首帧）才按需向服务端取\nconst ICON_BUST = {};\nfunction iconSrc(host) {\n  if (!host) return letterIconSvg(\"?\");\n  if (ICONS[host]) return ICONS[host];\n  const b = ICON_BUST[host] ? \"&t=\" + ICON_BUST[host] : \"\";\n  return \"/api/icon?host=\" + encodeURIComponent(host) + b;\n}\n\nfunction iconError(img, host) {\n  img.onerror = null;\n  img.src = letterIconSvg(host);\n}\n\nasync function fetchWithRetry(url, opts = {}, retries = 1) {\n  let last;\n  for (let attempt = 0; attempt <= retries; attempt++) {\n    const ctrl = new AbortController();\n    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 12000);\n    try {\n      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));\n      clearTimeout(timer);\n      if (res.ok || res.status === 401 || attempt === retries) return res;\n      last = new Error(\"HTTP \" + res.status);\n    } catch (e) {\n      clearTimeout(timer); last = e;\n      if (attempt === retries) throw e;\n    }\n  }\n  throw last || new Error(\"网络请求失败\");\n}\n\nasync function callApi(path, opts = {}) {\n  if(!navigator.onLine && opts.method && opts.method!==\"GET\")throw new Error(\"离线只读，请联网后修改\");\n  const headers = Object.assign({}, opts.headers || {});\n  if (TOKEN) headers[\"Authorization\"] = \"Bearer \" + TOKEN;\n  if (opts.body && !(opts.body instanceof FormData)) headers[\"Content-Type\"] = \"application/json\";\n  const res = await fetchWithRetry(API + \"/api\" + path, Object.assign({}, opts, { headers }), opts.method && opts.method !== \"GET\" ? 0 : 1);\n  if (res.status === 401) {\n    TOKEN = \"\"; localStorage.removeItem(\"bm_token\"); updateLoginBtn();\n    openLogin(); throw new Error(\"unauthorized\");\n  }\n  return res;\n}\n\nfunction updateLoginBtn() {\n  el(\"btnLogin\").textContent = TOKEN ? \"退出\" : \"登录\";\n  el(\"btnLogin\").className = TOKEN ? \"ghost\" : \"primary\";\n}\n\nfunction applyData(j) {\n  GROUPS = j.groups || GROUPS;\n  CATS = j.categories || CATS;\n  BMS = j.bookmarks || BMS;\n  if (j.site) SITE = j.site;\n  if (!GROUPS.find((g) => g.id === GROUP)) { const sg = sortedGroups(); GROUP = sg[0] ? sg[0].id : \"personal\"; }\n  render();\n  renderSite();\n}\n\nlet mutationEpoch = 0;\nlet pendingMove = false;\nlet pendingSave = false;\nfunction persistCurrentData() {\n  try { localStorage.setItem(\"bm_snapshot\", JSON.stringify({version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS})); } catch {}\n}\nfunction commitBookmark(b) {\n  const i = BMS.findIndex(x => x.id === b.id);\n  if (i < 0) BMS.push(b); else BMS[i] = b;\n  mutationEpoch++; persistCurrentData(); render();\n}\nasync function saveMove(bm, patch, message) {\n  if (pendingMove || pendingSave) return toast(\"正在保存，请稍候\");\n  await needAuth();\n  if (pendingMove || pendingSave) return;\n  pendingMove = true;\n  const current = BMS.find(x => x.id === bm.id);\n  if (!current) { pendingMove = false; return; }\n  const previous = {...current};\n  mutationEpoch++;\n  Object.assign(current, patch); render(); toast(\"正在保存…\");\n  try {\n    const r = await callApi(\"/bookmarks/\" + bm.id, {method:\"PUT\", body:JSON.stringify(patch)});\n    if (!r.ok) throw new Error(\"移动失败\");\n    commitBookmark(await r.json()); toast(message);\n  } catch (e) {\n    commitBookmark(previous); toast(\"移动未确认，已恢复原位置，请刷新核对\");\n  } finally { pendingMove = false; }\n}\nasync function loadData(force = false) {\n  if (pendingMove) return false;\n  const epoch = mutationEpoch;\n  let cachedData = \"\";\n  // 1) 先用本地快照秒开（离线缓存），避免首屏白屏\n  try {\n    const snap = JSON.parse(localStorage.getItem(\"bm_snapshot\") || \"null\");\n    if (!force && snap && snap.version === SNAPSHOT_VERSION && Array.isArray(snap.categories)) { ICONS = snap.icons || {}; applyData(snap); cachedData = JSON.stringify({groups:GROUPS,categories:CATS,bookmarks:BMS,site:SITE,icons:ICONS}); }\n  } catch {}\n  if (!BMS.length) renderSkeleton();\n  // 2) 再拉一次服务端全量（单请求，复用 HTML 里提前发出的那个请求，省一个 RTT）\n  try {\n    let r;\n    if (window.__boot) { r = await window.__boot; window.__boot = null; }\n    else r = await callApi(\"/bootstrap?icons=1\", force ? {cache:\"no-store\"} : {});\n    // 预加载失败时再走一次带超时/重试的请求，避免冷启动或瞬时网络错误导致白屏\n    if (r.status === 599) r = await callApi(\"/bootstrap?icons=1\");\n    if (r.status === 401) {\n      TOKEN = \"\"; localStorage.removeItem(\"bm_token\"); updateLoginBtn();\n      openLogin(); throw new Error(\"unauthorized\");\n    }\n    if (!r.ok) throw new Error(\"HTTP \" + r.status);\n    const j = await r.json();\n    if (epoch !== mutationEpoch || pendingMove) return false;\n    if (j.icons) ICONS = j.icons;\n    const incoming = JSON.stringify({groups:j.groups,categories:j.categories,bookmarks:j.bookmarks,site:j.site,icons:j.icons || ICONS});\n    if (incoming !== cachedData) applyData(j);\n    try {\n      localStorage.setItem(\"bm_snapshot\", JSON.stringify({ version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS }));\n    } catch {}\n    return true;\n  } catch (e) { if (e.message !== \"unauthorized\") toast(cachedData ? \"已显示本地缓存，暂时无法同步最新内容\" : \"加载失败：\" + e.message); return false; }\n}\n\nel(\"btnRefreshData\").onclick = async () => {\n  const btn = el(\"btnRefreshData\");\n  btn.disabled = true; btn.textContent = \"刷新中…\";\n  try { if (await loadData(true)) toast(\"已刷新为最新内容\"); }\n  finally { btn.disabled = false; btn.textContent = \"刷新数据\"; }\n};\n\nfunction groupName(id) { const g = GROUPS.find((x) => x.id === id); return g ? g.name : \"个人区\"; }\nfunction sortedCats() { return [...CATS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }\nfunction sortedGroups() { return [...GROUPS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }\nfunction sortedBms() { return [...BMS].sort((a, b) => (a.sort || 0) - (b.sort || 0)); }\nfunction bmsOfCat(cid) { return sortedBms().filter((b) => b.category_id === cid && b.group === GROUP); }\nfunction bmCount(cid) { return BMS.filter((b) => b.category_id === cid && b.group === GROUP).length; }\nfunction bmsOfUncat() { return groupBms().filter((b) => !b.category_id); }\nfunction groupBms() { return sortedBms().filter((b) => b.group === GROUP); }\nfunction groupCats() { return sortedCats().filter((c) => c.group === GROUP); }\n\nfunction render() {\n  renderTabs();\n  renderCatNav();\n  renderMain();\n}\n\nfunction renderSite() {\n  const name = SITE.name || \"我的导航站\";\n  el(\"siteName\").textContent = \"🔖 \" + name;\n  document.title = name;\n  el(\"siteAuthor\").textContent = SITE.author || \"\";\n  const u = (SITE.url || \"\").trim();\n  el(\"siteUrl\").textContent = u;\n  el(\"siteUrl\").href = /^https?:\\/\\//i.test(u) ? u : (u ? \"https://\" + u : \"#\");\n  el(\"siteVer\").textContent = APP_VERSION;\n}\n\nfunction renderTabs() {\n  const tabs = el(\"groupTabs\"); tabs.innerHTML = \"\";\n  for (const g of sortedGroups()) {\n    const b = document.createElement(\"button\");\n    b.dataset.g = g.id;\n    b.textContent = g.name;\n    if (g.id === GROUP) b.classList.add(\"active\");\n    tabs.appendChild(b);\n  }\n}\n\nfunction renderCatNav() {\n  const list = el(\"catList\"); list.innerHTML = \"\";\n  const all = document.createElement(\"div\");\n  all.className = \"cat\" + (ACTIVE_CAT === \"all\" ? \" active\" : \"\");\n  all.dataset.virtual = \"1\";\n  all.innerHTML = `<span class=\"name\">全部</span><span class=\"cnt\">${groupBms().length}</span>`;\n  all.onclick = () => { SEARCH_Q = \"\"; if (el(\"search\")) el(\"search\").value = \"\"; ACTIVE_CAT = \"all\"; render(); };\n  list.appendChild(all);\n  for (const c of groupCats()) {\n    const d = document.createElement(\"div\");\n    d.className = \"cat\" + (ACTIVE_CAT === c.id ? \" active\" : \"\");\n    d._cat = c;\n    d.draggable = true;\n    d.innerHTML = `<span class=\"name\">${esc(c.name)}</span><span class=\"cnt\">${bmCount(c.id)}</span><span class=\"add\" role=\"button\" tabindex=\"0\" title=\"添加书签到「${esc(c.name)}」\">＋</span>`;\n    d.onclick = () => { SEARCH_Q = \"\"; if (el(\"search\")) el(\"search\").value = \"\"; ACTIVE_CAT = c.id; render(); };\n    const addBtn = d.querySelector(\".add\");\n    if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); addBmTo(c.id); };\n    const tools=document.createElement(\"span\");tools.className=\"cat-tools\";\n    for(const [text,action]of [[\"编辑\",()=>editCat(c)],[\"删除\",()=>delCat(c)]]){const button=document.createElement(\"button\");button.className=\"small\";button.textContent=text;button.onclick=e=>{e.stopPropagation();action();};tools.appendChild(button);}\n    for(const direction of [-1,1]){const button=document.createElement(\"button\");button.className=\"small\";button.textContent=direction<0?\"↑\":\"↓\";button.onclick=async e=>{e.stopPropagation();if(pendingMove||pendingSave)return toast(\"请等待当前操作完成\");const list=groupCats(),i=list.findIndex(x=>x.id===c.id),next=list[i+direction];if(!next)return;const filtered=list.filter(x=>x.id!==c.id),ni=filtered.findIndex(x=>x.id===next.id)+(direction>0?1:0);try{await needAuth();if(!TOKEN)return;const r=await callApi(\"/categories/\"+c.id,{method:\"PUT\",body:JSON.stringify({sort:insertSort(filtered,ni)})});if(!r.ok)throw Error();Object.assign(c,await r.json());mutationEpoch++;persistCurrentData();render();}catch{toast(\"排序未确认，请刷新核对\");}};tools.appendChild(button);}\n    d.appendChild(tools);\n    d.addEventListener(\"dragstart\", (e) => {\n      DRAG_CAT = c; e.dataTransfer.effectAllowed = \"move\";\n      try { e.dataTransfer.setData(\"text/plain\", c.id); } catch {}\n      d.classList.add(\"dragging\");\n    });\n    d.addEventListener(\"dragend\", () => { d.classList.remove(\"dragging\"); clearDropHints(); DRAG_CAT = null; });\n    list.appendChild(d);\n  }\n  const add = document.createElement(\"button\");\n  add.className = \"ghost small\"; add.style.cssText = \"margin:10px 14px 0\";\n  add.textContent = \"+ 新建分类\";\n  add.onclick = () => addCat();\n  list.appendChild(add);\n}\n\nfunction renderMain() {\n  updateSearchClear();\n  if (SEARCH_Q) { renderSearch(SEARCH_Q); return; }\n  const c = el(\"content\"); c.innerHTML = \"\";\n  el(\"curTitle\").textContent = groupName(GROUP);\n  const gbms = groupBms();\n  el(\"curCount\").textContent = `${gbms.length} 书签 / ${groupCats().length} 分类`;\n\n  if (ACTIVE_CAT !== \"all\") {\n    const cat = groupCats().find((x) => x.id === ACTIVE_CAT);\n    if (!cat) { ACTIVE_CAT = \"all\"; return renderMain(); }\n    const items = bmsOfCat(cat.id);\n    c.appendChild(section(cat.name, items.length, items, cat));\n    return;\n  }\n\n  if (!gbms.length && !groupCats().length) {\n    c.innerHTML = `<div class=\"empty\">当前分区还没有内容，点击「+ 书签」或「+ 新建分类」开始添加。</div>`;\n    return;\n  }\n\n  for (const cat of groupCats()) {\n    const items = bmsOfCat(cat.id);\n    c.appendChild(section(cat.name, items.length, items, cat));\n  }\n  const uncat = gbms.filter((b) => !b.category_id);\n  if (uncat.length) c.appendChild(section(\"未分类\", uncat.length, uncat, null));\n}\n\nfunction renderSearch(q) {\n  const c = el(\"content\"); c.innerHTML = \"\";\n  el(\"curTitle\").textContent = \"搜索\";\n  const ql = q.toLowerCase();\n  // 全局搜索：跨所有分区 + 所有分类\n  const hits = sortedBms().filter((b) => {\n    const cat = sortedCats().find((x) => x.id === b.category_id);\n    const catName = cat ? cat.name : \"\";\n    return (b.title || \"\").toLowerCase().includes(ql) ||\n           (b.url || \"\").toLowerCase().includes(ql) ||\n           (b.note || \"\").toLowerCase().includes(ql) ||\n           catName.toLowerCase().includes(ql);\n  });\n  el(\"curCount\").textContent = hits.length + \" 个结果（跨分区 / 分类）\";\n  if (!hits.length) { c.innerHTML = '<div class=\"empty\">没有匹配「' + esc(q) + '」的书签</div>'; return; }\n  const byKey = {};\n  for (const b of hits) {\n    const cat = sortedCats().find((x) => x.id === b.category_id);\n    const gName = (GROUPS.find((g) => g.id === b.group) || {}).name || (b.group || \"未分区\");\n    const cName = cat ? cat.name : \"未分类\";\n    const key = gName + \" / \" + cName;\n    (byKey[key] = byKey[key] || []).push(b);\n  }\n  const ordered = Object.keys(byKey).sort((a, b) => a.localeCompare(b));\n  for (const key of ordered) {\n    c.appendChild(section(key, byKey[key].length, byKey[key], null));\n  }\n}\n\nfunction section(title, count, items, cat) {\n  const sec = document.createElement(\"section\"); sec.className = \"sec\"; sec._cat = cat || null;\n  const head = document.createElement(\"div\"); head.className = \"sec-head\";\n  head.innerHTML = `<h4>${esc(title)}</h4><span class=\"count\">${count}</span>`;\n  sec.appendChild(head);\n  const box = document.createElement(\"div\"); box.className = \"items\";\n  if (!items.length) {\n    box.innerHTML = `<div class=\"empty\" style=\"padding:10px 0\">该分类下暂无书签</div>`;\n  } else {\n    for (const b of items) box.appendChild(bmItem(b));\n  }\n  sec.appendChild(box);\n  return sec;\n}\n\nfunction bmItem(b) {\n  const h = hostOf(b.url);\n  const d = document.createElement(\"div\"); d.className = \"item\"; d._bm = b; d.draggable = true;\n  d.title = [b.title, b.url, b.note].filter(Boolean).join(\"\\n\");\n  const note = String(b.note || b.notes || b.remark || b.description || \"\").trim();\n  const noteMark = note ? `<span class=\"note-mark\" data-note=\"${esc(note)}\" role=\"img\" tabindex=\"0\" aria-label=\"备注：${esc(note)}\">!</span>` : \"\";\n  d.innerHTML = `<span class=\"icon-wrap\"><img src=\"${iconSrc(h)}\" alt=\"\" width=\"18\" height=\"18\" loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\"/>${noteMark}</span><span class=\"t\">${hl(b.title || b.url, SEARCH_Q)}</span><button class=\"add bm-add\" type=\"button\" title=\"添加到本分类\" aria-label=\"添加到本分类\">＋</button>`;\n  const img = d.querySelector(\"img\");\n  img.addEventListener(\"error\", () => iconError(img, h), { once: true });\n  const state = document.createElement(\"span\");\n  state.className = \"link-state \" + (b.link_status || \"\");\n  const label = b.link_checked_at && Date.now() - b.link_checked_at < 10 * 60 * 1000\n    ? {ok:\"正常\",broken:\"失效\",unknown:\"待确认\"}[b.link_status] : \"\";\n  state.hidden = !label;\n  if(label)state.dataset.expires=String(b.link_checked_at+10*60*1000);\n  state.textContent = label || \"\";\n  state.title = b.link_checked_at ? \"最后检查：\" + new Date(b.link_checked_at).toLocaleString() + (b.link_http_status ? \" HTTP \" + b.link_http_status : \"\") : \"\";\n  if(label){state.tabIndex=0;state.setAttribute(\"role\",\"button\");state.onclick=e=>{e.stopPropagation();toast(state.title);};state.onkeydown=e=>{if(e.key===\"Enter\"){e.stopPropagation();toast(state.title);}};}\n  d.appendChild(state);\n  const tools=document.createElement(\"div\"); tools.className=\"edit-tools\";\n  for(const [label,action] of [[\"编辑\",()=>editBm(b)],[\"删除\",()=>delBm(b)]]) {\n    const button=document.createElement(\"button\");button.textContent=label;\n    button.onclick=e=>{e.stopPropagation();action();};tools.appendChild(button);\n  }\n  for(const direction of [-1,1]) {\n    const button=document.createElement(\"button\");button.textContent=direction<0?\"前移\":\"后移\";\n    button.onclick=e=>{e.stopPropagation();const list=sortedBms().filter(x=>x.group===b.group&&x.category_id===b.category_id);const i=list.findIndex(x=>x.id===b.id),next=list[i+direction];if(!next)return;const filtered=list.filter(x=>x.id!==b.id);const ni=filtered.findIndex(x=>x.id===next.id)+(direction>0?1:0);applyMove(b,{sort:insertSort(filtered,ni)});};tools.appendChild(button);\n  }\n  d.appendChild(tools);\n  d.addEventListener(\"click\",e=>{if(d._suppressClick>Date.now()){e.preventDefault();e.stopPropagation();}},true);\n  let press=0,start;\n  d.addEventListener(\"pointerdown\",e=>{if(e.pointerType===\"mouse\"||e.target.closest(\"button\"))return;start={x:e.clientX,y:e.clientY};press=setTimeout(()=>{d._suppressClick=Date.now()+1000;showBookmarkMenu(b,start.x,start.y);},550);});\n  const cancel=()=>{clearTimeout(press);press=0;};\n  d.addEventListener(\"pointermove\",e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>10)cancel();});\n  for(const name of [\"pointerup\",\"pointercancel\",\"dragstart\"])d.addEventListener(name,cancel);\n  const addB = d.querySelector(\".bm-add\");\n  if (addB) {\n    addB.addEventListener(\"mousedown\", (e) => e.stopPropagation());\n    addB.onclick = (e) => { e.stopPropagation(); addBmTo(b.category_id); };\n  }\n  d.addEventListener(\"dragstart\", (e) => {\n    DRAG_BM = b;\n    e.dataTransfer.effectAllowed = \"move\";\n    try { e.dataTransfer.setData(\"text/plain\", b.id); } catch {}\n    d.classList.add(\"dragging\");\n  });\n  d.addEventListener(\"dragend\", () => { d.classList.remove(\"dragging\"); clearDropHints(); DRAG_BM = null; });\n  return d;\n}\n\n// ---------------- 右键菜单 ----------------\n// items 支持：{label, onClick, danger} 普通项；{label, submenu:[...]} 子菜单；{sep:true} 分隔线\nfunction showCtx(x, y, items) {\n  const m = el(\"ctxMenu\");\n  m.innerHTML = \"\";\n  fillCtx(m, items);\n  m.classList.add(\"show\");\n  const r = m.getBoundingClientRect();\n  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + \"px\";\n  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + \"px\";\n}\nfunction fillCtx(m, items) {\n  for (const it of items) {\n    if (it.sep) { const s = document.createElement(\"div\"); s.className = \"ctx-sep\"; m.appendChild(s); continue; }\n    const d = document.createElement(\"div\");\n    d.className = \"ctx-item\" + (it.danger ? \" danger\" : \"\") + (it.submenu ? \" has-sub\" : \"\");\n    d.innerHTML = `<span>${esc(it.label)}</span>` + (it.submenu ? `<span class=\"ctx-arrow\">▸</span>` : \"\");\n    if (it.submenu) {\n      d.addEventListener(\"mouseenter\", () => {\n        m.querySelectorAll(\".ctx-sub\").forEach((n) => n.remove());\n        const sub = document.createElement(\"div\");\n        sub.className = \"ctx ctx-sub\";\n        fillCtx(sub, it.submenu);\n        m.appendChild(sub);\n        const dr = d.getBoundingClientRect();\n        sub.style.left = (dr.right - 4) + \"px\";\n        sub.style.top = dr.top + \"px\";\n        const sr = sub.getBoundingClientRect();\n        if (sr.right > window.innerWidth - 8) sub.style.left = (dr.left - sr.width + 4) + \"px\";\n        if (sr.bottom > window.innerHeight - 8) sub.style.top = (window.innerHeight - sr.height - 8) + \"px\";\n      });\n    } else {\n      d.onclick = () => { hideCtx(); it.onClick && it.onClick(); };\n    }\n    m.appendChild(d);\n  }\n}\nfunction hideCtx() { el(\"ctxMenu\").classList.remove(\"show\"); }\n\ndocument.addEventListener(\"click\", hideCtx);\ndocument.addEventListener(\"scroll\", hideCtx, true);\n\nel(\"content\").addEventListener(\"contextmenu\", (e) => {\n  const item = e.target.closest(\".item\");\n  if (!item) return;\n  e.preventDefault();\n  const b = item._bm;\n  showBookmarkMenu(b,e.clientX,e.clientY);\n});\nfunction showBookmarkMenu(b,x,y) {\n  showCtx(x, y, [\n    { label: \"打开链接\", onClick: () => window.open(b.url, \"_blank\") },\n    { label: \"编辑\", onClick: () => editBm(b) },\n    { label: \"刷新图标\", onClick: () => refreshBmIcon(b) },\n    { label: \"删除\", danger: true, onClick: () => delBm(b) },\n  ]);\n}\nel(\"catList\").addEventListener(\"contextmenu\", (e) => {\n  const cat = e.target.closest(\".cat\");\n  if (!cat || cat.dataset.virtual) return;\n  e.preventDefault();\n  const c = cat._cat;\n  const groupItems = GROUPS.map((g) => ({\n    label: (g.id === c.group ? \"✓ \" : \"\") + g.name,\n    onClick: () => moveCatToGroup(c, g.id),\n  }));\n  showCtx(e.clientX, e.clientY, [\n    { label: \"编辑\", onClick: () => editCat(c) },\n    { label: \"移动到分区\", submenu: groupItems },\n    { label: \"删除\", danger: true, onClick: () => delCat(c) },\n  ]);\n});\n// 左键点击书签仍打开链接\nel(\"content\").addEventListener(\"click\", (e) => {\n  const item = e.target.closest(\".item\");\n  if (item && item._bm && !EDIT_MODE && !(item._suppressClick>Date.now())) window.open(item._bm.url, \"_blank\");\n});\n\n// ---------------- 拖拽：书签 & 分类 ----------------\n// 书签：\n//   拖到分区标签   -> 改 group（归入该分区「未分类」）\n//   拖到分类区/书签 -> 改 category_id + group，并按落点插入排序（移动位置）\n//   拖到「未分类」区 -> 取消分类、留当前分区，并按落点排序\n// 分类（左侧列表）：\n//   拖到分区标签   -> 改 group（整组搬家，书签级联跟随）\n//   在列表内拖动   -> 改 sort（调整分类显示顺序）\nfunction insertSort(filtered, idx) {\n  if (!filtered.length) return 0;\n  if (idx <= 0) return filtered[0].sort - 1;\n  if (idx >= filtered.length) return filtered[filtered.length - 1].sort + 1;\n  return (filtered[idx - 1].sort + filtered[idx].sort) / 2;\n}\n\nel(\"groupTabs\").addEventListener(\"dragover\", (e) => {\n  const b = e.target.closest(\"button[data-g]\");\n  if (b && (DRAG_BM || DRAG_CAT)) { e.preventDefault(); clearDropHints(); b.classList.add(\"drop-ok\"); }\n});\nel(\"groupTabs\").addEventListener(\"drop\", async (e) => {\n  const b = e.target.closest(\"button[data-g]\");\n  if (!b) return;\n  if (DRAG_BM) {\n    e.preventDefault(); b.classList.remove(\"drop-ok\"); moveToGroup(DRAG_BM, b.dataset.g);\n  } else if (DRAG_CAT) {\n    e.preventDefault(); b.classList.remove(\"drop-ok\");\n    if (DRAG_CAT.group === b.dataset.g) { toast(\"已在该分区\"); return; }\n    await needAuth();\n    const r = await callApi(\"/categories/\" + DRAG_CAT.id, { method: \"PUT\", body: JSON.stringify({ group: b.dataset.g }) });\n    if (r.ok) { toast(\"已移动到「\" + groupName(b.dataset.g) + \"」\"); await loadData(); renderGroupManage(); } else toast(\"移动失败\");\n  }\n});\n\nel(\"content\").addEventListener(\"dragover\", (e) => {\n  if (!DRAG_BM) return;\n  const sec = e.target.closest(\".sec\");\n  if (!sec) return;\n  e.preventDefault(); clearDropHints(); sec.classList.add(\"drop-ok\");\n  const item = e.target.closest(\".item\");\n  if (item && item._bm && item._bm.id !== DRAG_BM.id) {\n    const r = item.getBoundingClientRect();\n    item.classList.add((e.clientY - r.top) < r.height / 2 ? \"drop-before\" : \"drop-after\");\n  }\n});\nel(\"content\").addEventListener(\"drop\", (e) => {\n  if (!DRAG_BM) return;\n  const sec = e.target.closest(\".sec\");\n  if (!sec) return;\n  e.preventDefault(); clearDropHints();\n  const cat = sec._cat; // null = 未分类\n  const list = sortedBms().filter((b) => cat ? (b.category_id === cat.id && b.group === cat.group) : (!b.category_id && b.group === GROUP));\n  const filtered = list.filter((b) => b.id !== DRAG_BM.id);\n  const item = e.target.closest(\".item\");\n  let idx = filtered.length;\n  if (item && item._bm && item._bm.id !== DRAG_BM.id) {\n    const r = item.getBoundingClientRect();\n    const before = (e.clientY - r.top) < r.height / 2;\n    const i = filtered.findIndex((b) => b.id === item._bm.id);\n    if (i >= 0) idx = before ? i : i + 1;\n  }\n  applyMove(DRAG_BM, { category_id: cat ? cat.id : null, group: cat ? cat.group : GROUP, sort: insertSort(filtered, idx) });\n});\n\n// 左侧分类列表：拖动分类改顺序 / 拖到分区标签搬家\nel(\"catList\").addEventListener(\"dragover\", (e) => {\n  if (!DRAG_CAT) return;\n  const c = e.target.closest(\".cat\");\n  if (!c || c.dataset.virtual) return;\n  e.preventDefault(); clearDropHints();\n  const r = c.getBoundingClientRect();\n  c.classList.add((e.clientY - r.top) < r.height / 2 ? \"drop-before\" : \"drop-after\");\n});\nel(\"catList\").addEventListener(\"drop\", async (e) => {\n  if (!DRAG_CAT) return;\n  const c = e.target.closest(\".cat\");\n  if (!c || c.dataset.virtual) return;\n  e.preventDefault(); clearDropHints();\n  const target = c._cat;\n  if (!target || target.id === DRAG_CAT.id) return;\n  const list = groupCats().filter((x) => x.id !== DRAG_CAT.id);\n  const r = c.getBoundingClientRect();\n  const before = (e.clientY - r.top) < r.height / 2;\n  const i = list.findIndex((x) => x.id === target.id);\n  const idx = i >= 0 ? (before ? i : i + 1) : list.length;\n  await needAuth();\n  const rr = await callApi(\"/categories/\" + DRAG_CAT.id, { method: \"PUT\", body: JSON.stringify({ sort: insertSort(list, idx) }) });\n  if (rr.ok) { toast(\"已调整顺序\"); await loadData(); } else toast(\"排序失败\");\n});\n\nasync function moveToGroup(bm, groupId) {\n  if (bm.group === groupId) { toast(\"已在「\" + groupName(groupId) + \"」\"); return; }\n  await saveMove(bm, {group:groupId, category_id:null}, \"已移动到「\" + groupName(groupId) + \"」\");\n}\nasync function moveCatToGroup(c, groupId) {\n  if (c.group === groupId) { toast(\"已在「\" + groupName(groupId) + \"」\"); return; }\n  await needAuth();\n  const r = await callApi(\"/categories/\" + c.id, { method: \"PUT\", body: JSON.stringify({ group: groupId }) });\n  if (r.ok) { toast(\"已移动到「\" + groupName(groupId) + \"」\"); await loadData(); renderGroupManage(); } else toast(\"移动失败\");\n}\nasync function applyMove(bm, patch) {\n  await saveMove(bm, patch, \"已保存\");\n}\n\n// ---------------- 分类 ----------------\nfunction addCat() {\n  el(\"catTitle\").textContent = \"新建分类\";\n  el(\"catName\").value = \"\";\n  fillGroupSelect(\"catGroup\", GROUP);\n  el(\"catModal\")._id = null;\n  show(\"catModal\"); el(\"catName\").focus();\n}\nfunction editCat(c) {\n  el(\"catTitle\").textContent = \"编辑分类\";\n  el(\"catName\").value = c.name;\n  fillGroupSelect(\"catGroup\", c.group || \"personal\");\n  el(\"catModal\")._id = c.id;\n  show(\"catModal\"); el(\"catName\").focus();\n}\nlet CAT_DELETE_BUSY = false;\nfunction confirmCatDelete(c) {\n  el(\"catDeleteTitle\").textContent = \"删除分类\";\n  el(\"catDeleteMessage\").textContent = \"删除分类「\" + c.name + \"」及其下 \" + BMS.filter((b) => b.category_id === c.id).length + \" 个书签？\";\n  show(\"catDeleteModal\");\n  el(\"catDeleteCancel\").focus();\n  return new Promise((resolve) => { el(\"catDeleteModal\")._resolve = resolve; });\n}\nfunction resolveCatDelete(ok) {\n  const modal = el(\"catDeleteModal\");\n  const resolve = modal._resolve;\n  modal._resolve = null;\n  hide(\"catDeleteModal\");\n  if (resolve) resolve(ok);\n}\nel(\"catDeleteCancel\").onclick = () => resolveCatDelete(false);\nel(\"catDeleteOk\").onclick = () => resolveCatDelete(true);\nasync function delCat(c) {\n  if (CAT_DELETE_BUSY) return;\n  CAT_DELETE_BUSY = true;\n  try {\n    if (!await confirmCatDelete(c)) return;\n    await needAuth();\n    if (!TOKEN) return;\n    const r = await callApi(\"/categories/\" + encodeURIComponent(c.id), { method: \"DELETE\" });\n    if (!r.ok) {\n      const detail = await r.json().catch(() => ({}));\n      throw new Error(detail.error || \"HTTP \" + r.status);\n    }\n    // 使用成功响应更新本地列表，避免立即重读 KV 时旧数据让分类重新出现。\n    CATS = CATS.filter((cat) => cat.id !== c.id);\n    BMS = BMS.filter((b) => b.category_id !== c.id);\n    if (ACTIVE_CAT === c.id) ACTIVE_CAT = \"all\";\n    render();\n    try {\n      localStorage.setItem(\"bm_snapshot\", JSON.stringify({ version: SNAPSHOT_VERSION, groups: GROUPS, categories: CATS, bookmarks: BMS, site: SITE, icons: ICONS }));\n    } catch {}\n    toast(\"已删除\");\n  } catch (e) {\n    if (e.message !== \"unauthorized\") toast(\"删除失败：\" + e.message);\n  } finally {\n    CAT_DELETE_BUSY = false;\n  }\n}\n\n// ---------------- 书签 ----------------\nfunction addBm() {\n  el(\"bmTitle\").textContent = \"新建书签\";\n  el(\"bmTitle_in\").value = \"\"; el(\"bmUrl\").value = \"\"; el(\"bmNote\").value = \"\";\n  fillGroupSelect(\"bmGroup\", GROUP); fillCatSelect(\"\");\n  el(\"bmModal\")._id = null; el(\"bmModal\")._toCat = null; show(\"bmModal\"); el(\"bmUrl\").focus();\n}\n// 从分类行的「＋」进来：新书签直接归入该分类，并排在该分类最前\nfunction addBmTo(catId) {\n  const cat = CATS.find((x) => x.id === catId);\n  if (!cat) return addBm();\n  el(\"bmTitle\").textContent = \"添加到「\" + cat.name + \"」\";\n  el(\"bmTitle_in\").value = \"\"; el(\"bmUrl\").value = \"\"; el(\"bmNote\").value = \"\";\n  fillGroupSelect(\"bmGroup\", cat.group || GROUP); fillCatSelect(cat.id);\n  el(\"bmModal\")._id = null; el(\"bmModal\")._toCat = cat.id;\n  show(\"bmModal\"); el(\"bmUrl\").focus();\n}\nfunction editBm(b) {\n  el(\"bmTitle\").textContent = \"编辑书签\";\n  el(\"bmTitle_in\").value = b.title || \"\"; el(\"bmUrl\").value = b.url || \"\"; el(\"bmNote\").value = b.note || \"\";\n  fillGroupSelect(\"bmGroup\", b.group || GROUP); fillCatSelect(b.category_id || \"\");\n  el(\"bmModal\")._id = b.id; el(\"bmModal\")._toCat = null; show(\"bmModal\");\n}\nfunction fillCatSelect(sel) {\n  const s = el(\"bmCat\"); s.innerHTML = `<option value=\"\">（未分类）</option>`;\n  const group=el(\"bmGroup\").value||GROUP;\n  for (const c of sortedCats().filter(c=>c.group===group)) s.insertAdjacentHTML(\"beforeend\", `<option value=\"${c.id}\"${c.id === sel ? \" selected\" : \"\"}>${esc(c.name)}</option>`);\n}\nfunction fillGroupSelect(selId, val) {\n  const s = el(selId); s.innerHTML = \"\";\n  for (const g of sortedGroups()) s.insertAdjacentHTML(\"beforeend\", `<option value=\"${g.id}\"${g.id === val ? \" selected\" : \"\"}>${esc(g.name)}</option>`);\n}\nasync function delBm(b) {\n  if (CAT_DELETE_BUSY || pendingMove || pendingSave) return toast(\"正在处理，请稍候\");\n  CAT_DELETE_BUSY = true;\n  pendingSave = true;\n  try {\n    el(\"catDeleteTitle\").textContent = \"删除书签\";\n    el(\"catDeleteMessage\").textContent = \"删除书签「\" + (b.title || b.url) + \"」？\";\n    show(\"catDeleteModal\"); el(\"catDeleteCancel\").focus();\n    if (!await new Promise(resolve => { el(\"catDeleteModal\")._resolve = resolve; })) return;\n    await needAuth();\n    if (!TOKEN) return;\n    pendingSave = true;\n    toast(\"正在删除…\");\n    const r = await callApi(\"/bookmarks/\" + encodeURIComponent(b.id), {method:\"DELETE\"});\n    if (!r.ok) {\n      const detail = await r.json().catch(() => ({}));\n      throw new Error(detail.error || \"HTTP \" + r.status);\n    }\n    BMS = BMS.filter(x => x.id !== b.id);\n    mutationEpoch++; persistCurrentData(); render(); toast(\"已删除\");\n  } catch (e) {\n    if (e.message !== \"unauthorized\") toast(\"删除未确认，请刷新核对：\" + e.message);\n  } finally { CAT_DELETE_BUSY = false; pendingSave = false; }\n}\nasync function refreshBmIcon(b) {\n  const h = hostOf(b.url); if (!h) return;\n  await needAuth();\n  toast(\"正在刷新图标…\");\n  const r = await callApi(\"/icons/refresh\", { method: \"POST\", body: JSON.stringify({ host: h }) });\n  if (r.ok) {\n    const x = await r.json();\n    toast(x.hasIcon ? \"图标已更新\" : \"未获取到，已用占位图\");\n    await loadData();\n  } else toast(\"刷新失败\");\n}\n\n// ---------------- 鉴权 ----------------\nfunction show(id) { el(id).classList.add(\"show\"); }\nfunction hide(id) { el(id).classList.remove(\"show\"); }\nfunction openLogin() { el(\"pwd\").value = \"\"; show(\"loginModal\"); el(\"pwd\").focus(); }\nasync function needAuth() {\n  if (TOKEN) return;\n  openLogin();\n  return new Promise((resolve) => { el(\"loginModal\")._resolve = resolve; });\n}\nel(\"btnLogin\").onclick = async () => {\n  if (TOKEN) {\n    try { await callApi(\"/logout\", { method: \"POST\" }); } catch {}\n    TOKEN = \"\"; localStorage.removeItem(\"bm_token\"); updateLoginBtn(); toast(\"已退出\");\n    localStorage.removeItem(\"bm_snapshot\");localStorage.removeItem(\"bm_offline\");\n    if(navigator.serviceWorker) {const registration=await navigator.serviceWorker.getRegistration();registration?.active?.postMessage({type:\"CLEAR_OFFLINE\"});}\n    setTimeout(() => location.reload(), 300);\n  } else openLogin();\n};\nel(\"loginCancel\").onclick = () => { hide(\"loginModal\"); resolveLogin(false); };\nel(\"loginOk\").onclick = async () => {\n  const r = await callApi(\"/login\", { method: \"POST\", body: JSON.stringify({ password: el(\"pwd\").value }) });\n  if (r.ok) {\n    const j = await r.json(); TOKEN = j.token; localStorage.setItem(\"bm_token\", TOKEN); updateLoginBtn(); hide(\"loginModal\"); toast(\"登录成功\"); resolveLogin(true);\n  } else { toast(\"密码错误\"); resolveLogin(false); }\n};\nel(\"pwd\").addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") el(\"loginOk\").click(); });\nfunction resolveLogin(ok) {\n  const r = el(\"loginModal\")._resolve;\n  el(\"loginModal\")._resolve = null;\n  if (r) r(ok);\n}\n\n// ---------------- 分类 / 书签 保存 ----------------\nel(\"catCancel\").onclick = () => hide(\"catModal\");\nel(\"catSave\").onclick = async () => {\n  await needAuth();\n  const name = el(\"catName\").value.trim(); if (!name) return toast(\"请输入名称\");\n  const payload = { name, group: el(\"catGroup\").value };\n  const id = el(\"catModal\")._id;\n  const r = id ? await callApi(\"/categories/\" + id, { method: \"PUT\", body: JSON.stringify(payload) })\n               : await callApi(\"/categories\", { method: \"POST\", body: JSON.stringify(payload) });\n  if (r.ok) { hide(\"catModal\"); await loadData(); } else toast(\"保存失败\");\n};\n\nel(\"bmCancel\").onclick = () => { el(\"bmModal\")._toCat = null; hide(\"bmModal\"); };\nel(\"bmSave\").onclick = async () => {\n  const btn = el(\"bmSave\");\n  if (btn.disabled || pendingMove || pendingSave) return;\n  pendingSave = true;\n  btn.disabled = true;\n  const label = btn.textContent; btn.textContent = \"保存中…\";\n  try {\n  await needAuth();\n  const url = el(\"bmUrl\").value.trim(); if (!url) return toast(\"请输入 URL\");\n  const payload = {\n    title: el(\"bmTitle_in\").value.trim() || url,\n    url,\n    category_id: el(\"bmCat\").value || null,\n    group: el(\"bmGroup\").value,\n    note: el(\"bmNote\").value.trim() || null\n  };\n  const id = el(\"bmModal\")._id;\n  const toCat = el(\"bmModal\")._toCat;\n  if (!id && toCat) {\n    const sorts = BMS.filter((b) => b.category_id === toCat).map((b) => b.sort || 0);\n    payload.sort = sorts.length ? Math.min.apply(null, sorts) - 1 : 0;\n  }\n  const r = id ? await callApi(\"/bookmarks/\" + id, { method: \"PUT\", body: JSON.stringify(payload) })\n               : await callApi(\"/bookmarks\", { method: \"POST\", body: JSON.stringify(payload) });\n  if (r.ok) {\n    const saved = await r.json();\n    hide(\"bmModal\");\n    const h = hostOf(payload.url);\n    if (h) { delete ICONS[h]; ICON_BUST[h] = Date.now(); } // 让该图标重新拉取\n    if (toCat) {\n      const nm = (CATS.find((x) => x.id === toCat) || {}).name || \"\";\n      el(\"bmModal\")._toCat = null;\n      SEARCH_Q = \"\"; if (el(\"search\")) el(\"search\").value = \"\";\n      ACTIVE_CAT = \"all\";\n      commitBookmark(saved);\n      if (nm) toast(\"已添加到「\" + nm + \"」\");\n    } else { commitBookmark(saved); toast(\"已保存\"); }\n  } else toast(\"保存失败\");\n  } catch (e) { toast(\"保存未确认，请刷新核对后再试\"); }\n  finally { pendingSave = false; btn.disabled = false; btn.textContent = label; }\n};\n\n// ---------------- 设置抽屉 ----------------\nel(\"btnSettings\").onclick = () => { renderGroupManage(); show(\"settingsDrawer\"); };\nel(\"btnCloseSettings\").onclick = () => hide(\"settingsDrawer\");\nel(\"settingsDrawer\").onclick = (e) => { if (e.target === el(\"settingsDrawer\")) hide(\"settingsDrawer\"); };\nel(\"btnAddBm\").onclick = addBm;\n\n// ---------------- 站点信息（首页展示，可在设置里修改） ----------------\nel(\"btnEditSite\").onclick = () => {\n  el(\"siteNameIn\").value = SITE.name || \"\";\n  el(\"siteAuthorIn\").value = SITE.author || \"\";\n  el(\"siteUrlIn\").value = SITE.url || \"\";\n  show(\"siteModal\");\n};\nel(\"siteCancel\").onclick = () => hide(\"siteModal\");\nel(\"siteSave\").onclick = async () => {\n  await needAuth();\n  const payload = {\n    name: el(\"siteNameIn\").value.trim() || \"我的导航站\",\n    author: el(\"siteAuthorIn\").value.trim(),\n    url: el(\"siteUrlIn\").value.trim(),\n  };\n  const r = await callApi(\"/site\", { method: \"PUT\", body: JSON.stringify(payload) });\n  if (r.ok) { SITE = await r.json(); hide(\"siteModal\"); renderSite(); toast(\"已保存站点信息\"); }\n  else toast(\"保存失败\");\n};\n\nfunction clearGrpHints() { document.querySelectorAll(\".grp-row.drop-before, .grp-row.drop-after\").forEach((n) => n.classList.remove(\"drop-before\", \"drop-after\")); }\nfunction renderGroupManage() {\n  const box = el(\"groupList\"); box.innerHTML = \"\";\n  for (const g of sortedGroups()) {\n    const row = document.createElement(\"div\"); row.className = \"grp-row\"; row.draggable = true; row._g = g;\n    row.innerHTML = `<span class=\"grp-drag\" title=\"按住拖动排序\">⠿</span><span class=\"grp-name\">${esc(g.name)}</span>`;\n    const ren = document.createElement(\"button\");\n    ren.className = \"small\"; ren.textContent = \"重命名\";\n    ren.onclick = () => renameGroup(g);\n    const del = document.createElement(\"button\");\n    del.className = \"danger small\"; del.textContent = \"删除\";\n    del.onclick = async () => {\n      if (GROUPS.length <= 1) return toast(\"至少保留一个分区\");\n      if (!confirm(`删除分区「${g.name}」？其下分类和书签会移到「${groupName(GROUPS.find((x) => x.id !== g.id).id)}」`)) return;\n      await needAuth();\n      const r = await callApi(\"/groups/\" + g.id, { method: \"DELETE\" });\n      if (r.ok) { const j = await r.json(); if (GROUP === g.id) GROUP = j.fallback; localStorage.setItem(\"bm_group\", GROUP); toast(\"已删除分区\"); await loadData(); renderGroupManage(); }\n      else toast(\"删除失败\");\n    };\n    row.appendChild(ren);\n    row.appendChild(del);\n    row.addEventListener(\"dragstart\", (e) => { DRAG_GRP = g; e.dataTransfer.effectAllowed = \"move\"; try { e.dataTransfer.setData(\"text/plain\", g.id); } catch {} row.classList.add(\"dragging\"); });\n    row.addEventListener(\"dragend\", () => { row.classList.remove(\"dragging\"); clearGrpHints(); DRAG_GRP = null; });\n    box.appendChild(row);\n  }\n  box.ondragover = (e) => {\n    if (!DRAG_GRP) return;\n    const row = e.target.closest(\".grp-row\"); if (!row || row._g.id === DRAG_GRP.id) return;\n    e.preventDefault(); clearGrpHints();\n    const r = row.getBoundingClientRect();\n    row.classList.add((e.clientY - r.top) < r.height / 2 ? \"drop-before\" : \"drop-after\");\n  };\n  box.ondrop = async (e) => {\n    if (!DRAG_GRP) return;\n    const row = e.target.closest(\".grp-row\"); if (!row || row._g.id === DRAG_GRP.id) return;\n    e.preventDefault(); clearGrpHints();\n    const target = row._g;\n    const list = sortedGroups().filter((x) => x.id !== DRAG_GRP.id);\n    const r = row.getBoundingClientRect();\n    const before = (e.clientY - r.top) < r.height / 2;\n    const i = list.findIndex((x) => x.id === target.id);\n    const idx = i >= 0 ? (before ? i : i + 1) : list.length;\n    const sort = insertSort(list, idx);\n    await needAuth();\n    const rr = await callApi(\"/groups/\" + DRAG_GRP.id, { method: \"PUT\", body: JSON.stringify({ sort }) });\n    if (rr.ok) { toast(\"已调整顺序\"); await loadData(); renderGroupManage(); } else toast(\"排序失败\");\n  };\n}\nel(\"btnAddGroup\").onclick = async () => {\n  const name = el(\"newGroupName\").value.trim(); if (!name) return toast(\"请输入分区名\");\n  await needAuth();\n  const r = await callApi(\"/groups\", { method: \"POST\", body: JSON.stringify({ name }) });\n  if (r.ok) { el(\"newGroupName\").value = \"\"; toast(\"已添加分区\"); await loadData(); renderGroupManage(); }\n  else { const j = await r.json().catch(() => ({})); toast(j.error || \"添加失败\"); }\n};\nfunction renameGroup(g) {\n  el(\"grpTitle\").textContent = \"重命名分区\";\n  el(\"grpName\").value = g.name;\n  el(\"grpModal\")._id = g.id;\n  show(\"grpModal\"); el(\"grpName\").focus();\n}\nel(\"grpCancel\").onclick = () => hide(\"grpModal\");\nel(\"grpSave\").onclick = async () => {\n  await needAuth();\n  const name = el(\"grpName\").value.trim(); if (!name) return toast(\"请输入名称\");\n  const id = el(\"grpModal\")._id;\n  const r = await callApi(\"/groups/\" + id, { method: \"PUT\", body: JSON.stringify({ name }) });\n  if (r.ok) { hide(\"grpModal\"); toast(\"已重命名\"); await loadData(); renderGroupManage(); }\n  else toast(\"保存失败\");\n};\nel(\"grpName\").addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") el(\"grpSave\").click(); });\n\nel(\"btnBackup\").onclick = async () => {\n  await needAuth();\n  const r = await callApi(\"/backup\");\n  if (!r.ok) return toast(\"备份失败\");\n  const j = await r.json();\n  const blob = new Blob([JSON.stringify(j, null, 2)], { type: \"application/json\" });\n  const a = document.createElement(\"a\"); a.href = URL.createObjectURL(blob);\n  a.download = \"bookmarks-\" + new Date().toISOString().slice(0, 10) + \".json\"; a.click();\n  toast(\"已下载备份\");\n};\ntry { const _bak = localStorage.getItem(\"bakEmail\"); if (_bak && el(\"bakEmail\")) el(\"bakEmail\").value = _bak; } catch {}\nel(\"btnBackupEmail\").onclick = async () => {\n  await needAuth();\n  const to = ((el(\"bakEmail\").value) || \"\").trim();\n  if (!to) return toast(\"请填收件邮箱\");\n  const btn = el(\"btnBackupEmail\");\n  const oldTxt = btn.textContent;\n  btn.textContent = \"发送中…\"; btn.disabled = true;\n  try {\n    const r = await callApi(\"/backup-email\", { method: \"POST\", body: JSON.stringify({ to: to }) });\n    const j = await r.json().catch(() => ({}));\n    if (r.ok) { toast(\"备份成功，邮件已发送\"); try { localStorage.setItem(\"bakEmail\", to); } catch {} }\n    else toast(j.error || (\"发送失败（\" + r.status + \"）\"));\n  } catch (e) { toast(\"发送失败\"); }\n  finally { btn.textContent = oldTxt; btn.disabled = false; }\n};\nel(\"btnRestore\").onclick = () => el(\"restoreFile\").click();\nel(\"restoreFile\").onchange = async (e) => {\n  const f = e.target.files[0]; if (!f) return;\n  await needAuth();\n  const text = await f.text();\n  let j; try { j = JSON.parse(text); } catch { return toast(\"JSON 解析失败\"); }\n  const r = await callApi(\"/restore\", { method: \"POST\", body: JSON.stringify(j) });\n  if (r.ok) { const x = await r.json(); toast(`恢复完成：分类 ${x.categories} / 书签 ${x.bookmarks} / 图标 ${x.icons}`); await loadData(); }\n  else toast(\"恢复失败\");\n  e.target.value = \"\";\n};\nel(\"btnWipe\").onclick = async () => {\n  if (!confirm(\"确定清空全部分类和书签？此操作不可恢复，建议先备份！\")) return;\n  await needAuth();\n  const r = await callApi(\"/data\", { method: \"DELETE\" });\n  if (r.ok) { toast(\"已清空\"); ACTIVE_CAT = \"all\"; await loadData(); } else toast(\"清空失败\");\n};\nel(\"btnRefreshIcons\").onclick = async () => {\n  await needAuth();\n  toast(\"正在更新图标…\");\n  const r = await callApi(\"/icons/refresh\", { method: \"POST\" });\n  if (r.ok) {\n    const x = await r.json();\n    const now = Date.now();\n    BMS.forEach((b) => { const h = hostOf(b.url); if (h) ICON_BUST[h] = now; });\n    ICONS = {}; // 强制重新从服务端取\n    render();\n    toast(`图标更新：${x.cached}/${x.hosts}`);\n  } else toast(\"更新失败\");\n};\nel(\"btnPwd\").onclick = () => { el(\"pwdNew\").value = \"\"; el(\"pwdNew2\").value = \"\"; show(\"pwdModal\"); el(\"pwdNew\").focus(); };\nel(\"pwdCancel\").onclick = () => hide(\"pwdModal\");\nel(\"pwdOk\").onclick = async () => {\n  await needAuth();\n  const p1 = el(\"pwdNew\").value.trim(), p2 = el(\"pwdNew2\").value.trim();\n  if (!p1 || p1.length < 4) return toast(\"密码至少 4 位\");\n  if (p1 !== p2) return toast(\"两次密码不一致\");\n  const r = await callApi(\"/password\", { method: \"POST\", body: JSON.stringify({ password: p1 }) });\n  if (r.ok) {\n    const j = await r.json(); TOKEN = j.token; localStorage.setItem(\"bm_token\", TOKEN); updateLoginBtn();\n    hide(\"pwdModal\"); toast(\"密码已修改，请牢记新密码\");\n  } else toast(\"修改失败\");\n};\n\n// ---------------- 访问锁 / 免密密钥 ----------------\nlet ACCESS = { gate: true, key: \"\" };\nasync function loadAccess() {\n  try {\n    const headers = {};\n    if (TOKEN) headers[\"Authorization\"] = \"Bearer \" + TOKEN;\n    const r = await fetch(API + \"/api/access\", { headers });\n    if (!r.ok) return;\n    ACCESS = await r.json();\n    el(\"btnGate\").textContent = ACCESS.gate ? \"已开启（点击关闭）\" : \"已关闭（点击开启）\";\n    el(\"btnGate\").className = ACCESS.gate ? \"primary small\" : \"small\";\n  } catch {}\n}\nfunction updateAccessLink() {\n  const k = el(\"accessKeyIn\").value.trim();\n  el(\"accessLink\").value = k ? location.origin + \"/k/\" + k : \"\";\n}\nel(\"btnGate\").onclick = async () => {\n  await needAuth();\n  const r = await callApi(\"/access\", { method: \"POST\", body: JSON.stringify({ gate: !ACCESS.gate }) });\n  if (r.ok) {\n    ACCESS = await r.json();\n    await loadAccess();\n    toast(ACCESS.gate ? \"访问锁已开启，进站需要密码\" : \"访问锁已关闭，站点公开只读\");\n  } else toast(\"操作失败\");\n};\nel(\"btnAccessKey\").onclick = async () => {\n  await needAuth();\n  await loadAccess();\n  el(\"accessKeyIn\").value = ACCESS.key || \"\";\n  updateAccessLink();\n  show(\"accessModal\");\n};\nel(\"accessKeyIn\").oninput = updateAccessLink;\nel(\"btnRegenKey\").onclick = async () => {\n  const r = await callApi(\"/access\", { method: \"POST\", body: JSON.stringify({ regenerate: true }) });\n  if (r.ok) {\n    ACCESS = await r.json();\n    el(\"accessKeyIn\").value = ACCESS.key;\n    updateAccessLink();\n    toast(\"已生成新密钥，旧链接立即失效\");\n  } else toast(\"生成失败\");\n};\nel(\"btnCopyLink\").onclick = async () => {\n  const v = el(\"accessLink\").value;\n  if (!v) return toast(\"请先生成密钥\");\n  try { await navigator.clipboard.writeText(v); toast(\"链接已复制\"); }\n  catch { el(\"accessLink\").select(); try { document.execCommand(\"copy\"); toast(\"链接已复制\"); } catch { toast(\"复制失败，请手动复制\"); } }\n};\nel(\"accessCancel\").onclick = () => hide(\"accessModal\");\nel(\"accessSave\").onclick = async () => {\n  const k = el(\"accessKeyIn\").value.trim();\n  if (k && k.length < 8) return toast(\"密钥至少 8 位\");\n  const r = await callApi(\"/access\", { method: \"POST\", body: JSON.stringify({ key: k }) });\n  if (r.ok) {\n    ACCESS = await r.json();\n    el(\"accessKeyIn\").value = ACCESS.key;\n    updateAccessLink();\n    hide(\"accessModal\");\n    toast(\"密钥已保存\");\n  } else toast(\"保存失败\");\n};\n\n// ---------------- Tabs ----------------\nel(\"groupTabs\").onclick = (e) => {\n  const b = e.target.closest(\"button[data-g]\");\n  if (!b) return;\n  GROUP = b.dataset.g; localStorage.setItem(\"bm_group\", GROUP); SEARCH_Q = \"\"; if (el(\"search\")) el(\"search\").value = \"\"; ACTIVE_CAT = \"all\"; render();\n};\n\n// ---------------- 侧栏宽度拖拽 ----------------\n(function initResizer() {\n  const sw = localStorage.getItem(\"bm_side_w\");\n  if (sw) el(\"catNav\").style.width = sw + \"px\";\n  const rz = el(\"sideResizer\");\n  rz.addEventListener(\"mousedown\", (e) => {\n    e.preventDefault();\n    const startX = e.clientX;\n    const startW = el(\"catNav\").offsetWidth;\n    function mv(ev) {\n      const w = Math.max(120, Math.min(440, startW + ev.clientX - startX));\n      el(\"catNav\").style.width = w + \"px\";\n    }\n    function up() {\n      document.removeEventListener(\"mousemove\", mv);\n      document.removeEventListener(\"mouseup\", up);\n      document.body.style.cursor = \"\";\n      localStorage.setItem(\"bm_side_w\", el(\"catNav\").offsetWidth);\n    }\n    document.addEventListener(\"mousemove\", mv);\n    document.addEventListener(\"mouseup\", up);\n    document.body.style.cursor = \"col-resize\";\n  });\n})();\n\n// ---------------- 搜索 ----------------\nlet searchTimer = 0;\nel(\"search\").addEventListener(\"input\", (e) => {\n  SEARCH_Q = e.target.value.trim();\n  updateSearchClear();\n  clearTimeout(searchTimer);\n  searchTimer = setTimeout(() => renderMain(), 120);\n});\nel(\"searchClear\").onclick = () => { el(\"search\").value = \"\"; SEARCH_Q = \"\"; renderMain(); el(\"search\").focus(); };\nfunction updateSearchClear() { const w = el(\"searchWrap\"); if (w) w.classList.toggle(\"has-q\", !!el(\"search\").value); }\nel(\"search\").addEventListener(\"keydown\", (e) => { if (e.key === \"Escape\") { el(\"search\").value = \"\"; SEARCH_Q = \"\"; updateSearchClear(); renderMain(); } });\ndocument.addEventListener(\"keydown\", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === \"k\") { e.preventDefault(); el(\"search\").focus(); el(\"search\").select(); } });\n\n// ---------------- 检查更新 ----------------\nel(\"btnCheckUpdate\").onclick = () => checkUpdate(false);\nasync function checkUpdate(silent) {\n  const box = el(\"updateInfo\");\n  if (!silent) { box.style.display = \"block\"; box.innerHTML = \"正在检查更新…\"; }\n  try {\n    const r = await fetch(API + \"/api/check-update\");\n    const j = await r.json();\n    if (!silent) {\n      if (j.hasUpdate) {\n        box.innerHTML = '发现新版本 <b>' + esc(j.latest) + '</b>（当前 ' + esc(j.current) + '）。<br><a href=\"' + esc(j.url) + '\" target=\"_blank\" rel=\"noopener\">前往 GitHub 下载 / 查看</a>' + (j.notes ? '<br><small>' + esc(j.notes) + '</small>' : '');\n      } else if (j.error) {\n        box.innerHTML = '暂无法检查更新：' + esc(j.error);\n      } else {\n        box.innerHTML = '已是最新版本 <b>' + esc(j.current) + '</b>。';\n      }\n    } else if (j.hasUpdate) {\n      toast('发现新版本 ' + j.latest + '，可在设置里更新');\n    }\n  } catch {\n    if (!silent) box.innerHTML = '检查更新失败（网络错误）';\n  }\n}\n\n// ---------------- Esc 关闭浮层 ----------------\ndocument.addEventListener(\"keydown\", (e) => {\n  if (e.key !== \"Escape\") return;\n  hideCtx();\n  resolveCatDelete(false);\n  const login = el(\"loginModal\");\n  if (login && login.classList.contains(\"show\")) { hide(\"loginModal\"); resolveLogin(false); }\n  document.querySelectorAll(\".modal.show\").forEach((m) => m.classList.remove(\"show\"));\n  el(\"settingsDrawer\").classList.remove(\"show\");\n});\n\n// ---------------- 启动 ----------------\nupdateLoginBtn();\nloadData();\nloadAccess();\ncheckUpdate(true);\n\n// 手机无需依赖右键和触摸拖拽：编辑按钮、移动分类与前后排序。\nel(\"btnEditMode\").onclick=()=>{EDIT_MODE=!EDIT_MODE;document.body.classList.toggle(\"edit-mode\",EDIT_MODE);el(\"btnEditMode\").textContent=EDIT_MODE?\"完成编辑\":\"编辑模式\";};\nel(\"bmGroup\").onchange=()=>fillCatSelect(\"\");\nlet metadataSeq=0,metadataTimer=0;\nasync function fetchMetadata() {\n  const input=el(\"bmUrl\"),value=input.value.trim();\n  if(!/^https?:\\/\\//i.test(value))return;\n  const seq=++metadataSeq,existing=el(\"bmTitle_in\").value;\n  el(\"metadataStatus\").textContent=\"正在获取…\";\n  try {\n    await needAuth();if(!TOKEN)return;\n    const r=await callApi(\"/url-metadata\",{method:\"POST\",body:JSON.stringify({url:value}),timeout:10000});\n    const result=await r.json();\n    if(seq!==metadataSeq||input.value.trim()!==value||!el(\"bmModal\").classList.contains(\"show\"))return;\n    if(result.title&&el(\"bmTitle_in\").value===existing&&(!existing||existing===value))el(\"bmTitle_in\").value=result.title;\n    const host=hostOf(value);if(host){delete ICONS[host];ICON_BUST[host]=Date.now();}\n    el(\"metadataStatus\").textContent=result.title?\"标题已获取，图标后台更新\":\"未获取标题，可手动填写\";\n  } catch {if(seq===metadataSeq)el(\"metadataStatus\").textContent=\"获取失败，可手动填写\";}\n}\nel(\"btnFetchTitle\").onclick=fetchMetadata;\nel(\"bmUrl\").addEventListener(\"input\",()=>{metadataSeq++;clearTimeout(metadataTimer);el(\"metadataStatus\").textContent=\"\";metadataTimer=setTimeout(fetchMetadata,600);});\nlet linkCheckRunning=false,stopLinkCheck=false;\nfunction linkCheckDue(b,now=Date.now()) {\n  const ttl=b.link_status===\"unknown\"?3600000:86400000;\n  return ![\"ok\",\"broken\",\"unknown\"].includes(b.link_status)||!b.link_checked_at||now-b.link_checked_at>=ttl;\n}\nasync function checkLinks(force=false) {\n  if(linkCheckRunning)return;\n  if(pendingSave||pendingMove)return toast(\"请等待当前保存完成\");\n  await needAuth();if(!TOKEN)return;\n  if(linkCheckRunning||pendingSave||pendingMove)return;\n  const btn=el(\"btnCheckLinks\"),recheck=el(\"btnRecheckLinks\"),stop=el(\"btnStopLinks\");\n  pendingSave=true;linkCheckRunning=true;stopLinkCheck=false;btn.disabled=true;recheck.disabled=true;stop.hidden=false;stop.disabled=false;\n  let checked=0,total=0,skipped=0;\n  try {\n    el(\"linkCheckInfo\").textContent=\"正在同步已有检查进度…\";\n    const current=await callApi(\"/bookmarks\",{cache:\"no-store\",timeout:25000});\n    if(!current.ok)throw Error(\"同步进度失败（HTTP \"+current.status+\"）\");\n    for(const remote of await current.json()){const b=BMS.find(b=>b.id===remote.id&&b.url===remote.url);if(b)for(const field of [\"link_status\",\"link_http_status\",\"link_checked_at\"]) {if(remote[field]!==undefined)b[field]=remote[field];else delete b[field];}}\n    const now=Date.now(),ids=BMS.filter(b=>force||linkCheckDue(b,now)).map(b=>b.id);total=ids.length;skipped=BMS.length-total;\n    persistCurrentData();render();\n    for(let i=0;i<ids.length&&!stopLinkCheck;i+=8){\n      el(\"linkCheckInfo\").textContent=\"检查中 \"+checked+\" / \"+total+\"，跳过近期结果 \"+skipped+\" 条\";\n      let j;\n      for(let attempt=0;attempt<2;attempt++){\n        try{\n          const r=await callApi(\"/check-links\",{method:\"POST\",body:JSON.stringify({ids:ids.slice(i,i+8)}),timeout:25000});\n          if(!r.ok)throw Error(\"HTTP \"+r.status);\n          j=await r.json();if(!Array.isArray(j.results))throw Error(\"返回格式异常\");break;\n        }catch(e){if(e.message===\"unauthorized\"||attempt===1||stopLinkCheck)throw e;el(\"linkCheckInfo\").textContent=\"当前批次网络异常，正在重试；已完成 \"+checked+\" / \"+total;}\n      }\n      for(const result of j.results){const b=BMS.find(b=>b.id===result.id&&b.url===result.url);if(b)Object.assign(b,{link_status:result.status,link_http_status:result.http_status,link_checked_at:result.checked_at});}\n      checked+=j.results.length;mutationEpoch++;persistCurrentData();\n      // 检查期间仅更新状态，结束后统一重绘，避免每批重建全部书签。\n    }\n    el(\"linkCheckInfo\").textContent=(stopLinkCheck?\"已暂停，\":\"检查完成，\")+\"本次 \"+checked+\" / \"+total+\" 条；跳过近期结果 \"+skipped+\" 条；失效 \"+BMS.filter(b=>b.link_status===\"broken\").length+\"，待确认 \"+BMS.filter(b=>b.link_status===\"unknown\").length;\n  } catch(e) {el(\"linkCheckInfo\").textContent=\"检查中断（\"+(e.name===\"AbortError\"?\"网络超时\":e.message)+\"），本次已保留 \"+checked+\" 条；点“继续检查”会跳过已完成项\";}\n  finally {pendingSave=false;linkCheckRunning=false;btn.disabled=false;recheck.disabled=false;stop.hidden=true;render();}\n}\nel(\"btnCheckLinks\").onclick=()=>checkLinks(false);\nel(\"btnRecheckLinks\").onclick=()=>checkLinks(true);\nel(\"btnStopLinks\").onclick=()=>{stopLinkCheck=true;el(\"btnStopLinks\").disabled=true;el(\"linkCheckInfo\").textContent=\"正在保存当前批次后暂停…\";};\nel(\"bookmarklet\").href=\"javascript:\"+encodeURIComponent(\"(()=>{window.open(\"+JSON.stringify(location.origin+\"/?add=\")+\"+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank')})()\");\nconst addParams=new URLSearchParams(location.search);\nif(addParams.has(\"add\")){addBm();el(\"bmUrl\").value=addParams.get(\"add\")||\"\";el(\"bmTitle_in\").value=addParams.get(\"title\")||\"\";history.replaceState(null,\"\",\"/\");setTimeout(fetchMetadata,700);}\nlet installPrompt;\nwindow.addEventListener(\"beforeinstallprompt\",e=>{e.preventDefault();installPrompt=e;});\nlet swRegistration;\nif(\"serviceWorker\" in navigator)swRegistration=navigator.serviceWorker.register(\"/sw.js\");\nel(\"btnInstall\").onclick=async()=>{\n  try {\n    if(!swRegistration)return toast(\"当前浏览器未支持离线功能\");\n    await swRegistration;const reg=await navigator.serviceWorker.ready;\n    const worker=reg.active;if(!worker)throw new Error(\"not ready\");\n    const channel=new MessageChannel();const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(\"timeout\")),10000);channel.port1.onmessage=e=>{clearTimeout(timer);e.data.ok?resolve():reject(Error(\"cache failed\"));};});\n    worker.postMessage({type:\"ENABLE_OFFLINE\",asset:\"/app.js?v=\"+VERSION},[channel.port2]);await done;\n    localStorage.setItem(\"bm_offline\",\"1\");toast(\"已启用本机离线只读；可添加到主屏幕\");\n    if(installPrompt){await installPrompt.prompt();installPrompt=null;}\n  }catch{toast(\"离线准备失败，请联网后重试\");}\n};\nwindow.addEventListener(\"offline\",()=>toast(\"当前离线，可浏览缓存；修改需联网\"));\n// 仅隐藏检测提示，不删除服务端检查记录，也不重绘整页。\nsetInterval(()=>{\n  const now=Date.now();\n  document.querySelectorAll(\".link-state[data-expires]\").forEach(node=>{\n    if(Number(node.dataset.expires)<=now){node.hidden=true;node.textContent=\"\";delete node.dataset.expires;}\n  });\n},1000);\n\r\n","/manifest.webmanifest":"{\"id\":\"/\",\"name\":\"书签导航站\",\"short_name\":\"导航站\",\"start_url\":\"/\",\"scope\":\"/\",\"display\":\"standalone\",\"background_color\":\"#111217\",\"theme_color\":\"#111217\",\"icons\":[{\"src\":\"/pwa-icon.png\",\"sizes\":\"512x512\",\"type\":\"image/png\",\"purpose\":\"any maskable\"}],\"share_target\":{\"action\":\"/\",\"method\":\"GET\",\"params\":{\"title\":\"title\",\"url\":\"add\"}}}\n","/sw.js":"const CACHE = 'book-offline-v1';\nself.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));\nself.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));\nself.addEventListener('message',event=>{\n  if(event.data?.type==='CLEAR_OFFLINE')event.waitUntil(caches.delete(CACHE));\n  if(event.data?.type==='ENABLE_OFFLINE')event.waitUntil((async()=>{\n    try {\n      const cache=await caches.open(CACHE);\n      const page=await fetch('/',{credentials:'same-origin',cache:'no-store'});\n      if(!page.ok||page.headers.get('x-book-shell')!=='1')throw Error('login required');\n      const asset=new URL(event.data.asset,self.location.origin);\n      if(asset.origin!==self.location.origin||asset.pathname!=='/app.js')throw Error('invalid asset');\n      const script=await fetch(asset.href,{credentials:'same-origin',cache:'no-store'});\n      if(!script.ok||!/javascript/.test(script.headers.get('content-type')||''))throw Error('script failed');\n      await cache.put('/',page);await cache.put(asset.href,script);\n      event.ports[0]?.postMessage({ok:true});\n    }catch{event.ports[0]?.postMessage({ok:false});}\n  })());\n});\nself.addEventListener('fetch',event=>{\n  const url=new URL(event.request.url);\n  if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/'))return;\n  if(event.request.mode==='navigate')event.respondWith((async()=>{\n    try {\n      const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),4500);\n      let response;try {response=await fetch(event.request,{signal:ctrl.signal});}finally{clearTimeout(timer);}\n      const cache=await caches.open(CACHE);\n      if(response.ok&&response.headers.get('x-book-shell')==='1'&&await cache.match('/')){\n        const html=await response.clone().text();const asset=(html.match(/app\\.js\\?v=[A-Za-z0-9]+/)||[])[0];\n        if(asset)event.waitUntil((async()=>{try{const script=await fetch('/'+asset,{credentials:'same-origin'});if(script.ok){await cache.put('/'+asset,script);await cache.put('/',response.clone());}}catch{}})());\n      }\n      return response;\n    }catch{return await caches.match('/')||new Response('请联网登录后，在设置中启用离线访问。',{headers:{'content-type':'text/plain; charset=utf-8'}});}\n  })());\n  else if(url.pathname==='/app.js')event.respondWith(fetch(event.request).catch(async()=>await caches.match(event.request)||Response.error()));\n});\n"};
const PWA_ICON = "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";
export async function onRequest(context) {
  const store = getStore({ name: 'bookmarks', consistency: 'strong' });
  const binding = {get: (key, type) => store.get(key, {type: type || 'text', consistency: 'strong'}), put: (key, value) => store.set(key, value), delete: (key) => store.delete(key)};
  const env = {...(context.env || {}), BOOKMARKS: binding, ASSETS: {fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if(path==='/pwa-icon.png')return new Response(Uint8Array.from(atob(PWA_ICON),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}});
    const body = EMBEDDED_ASSETS[path === '/' || path.startsWith('/k/') ? '/' : path];
    if(body === undefined) return new Response('Not found', {status:404});
    const ct=path.endsWith('.js')?'application/javascript; charset=utf-8':path.endsWith('.webmanifest')?'application/manifest+json':'text/html; charset=utf-8';
    return new Response(request.method === 'HEAD' ? null : body, {headers:{'content-type':ct,...(path==='/'||path==='/index.html'?{'x-book-shell':'1'}:{})}});
  }}};
  try {return await worker.fetch(context.request, env, context);} catch {return json({error:'服务暂时不可用，请稍后重试'},503,{'cache-control':'no-store'});}
}
