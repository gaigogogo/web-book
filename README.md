<!-- platform-releases -->
## 版本选择

- **Cloudflare：v4.6 最终版，停止更新。** 使用 Workers + KV，下载 [CF v4.6](https://github.com/jeffak000/webbook-cf/releases/tag/v4.6)。
- **腾讯云：v4.8-noteone，持续维护。** 使用 EdgeOne + Blob，源码位于 noteone/，下载 [noteone v4.8](https://github.com/jeffak000/webbook-cf/releases/tag/v4.8-noteone)。包括备注标识、本地快照缓存与手动刷新。

两版部署配置不同，升级前导出 JSON 备份。需要 CF 的用户请选择 v4.6（含）或更早版本。

# webbook-cf · 极简书签导航站

> 一个跑在 Cloudflare Workers + KV 上的**免费**书签导航站。不用买服务器，不用装数据库，自带访问密码锁，打开即用，数据全在你自己手里。
>
> A free, serverless bookmark hub on Cloudflare Workers + KV. Password-protected, zero backend to maintain.

**在线演示**：https://book.090803.xyz

**适合谁**：想把收藏的网址整理成一个导航页、又能手机电脑同步访问的人。

---

## 目录

- [一、它能做什么](#一它能做什么)
- [二、开始前要准备什么](#二开始前要准备什么)
- [三、手把手安装（Windows）](#三手把手安装windows)
- [四、装好之后必做的两件事](#四装好之后必做的两件事)
- [五、绑定自己的域名（可选）](#五绑定自己的域名可选)
- [六、日常使用](#六日常使用)
- [七、备份与恢复](#七备份与恢复)
- [八、怎么升级到新版](#八怎么升级到新版)
- [九、常见问题 FAQ](#九常见问题-faq)
- [十、版本更新记录](#十版本更新记录)
- [十一、安全提醒](#十一安全提醒)

---

## 一、它能做什么

| 功能 | 说明 |
|---|---|
| **分组 + 分类** | 两级整理，比如「工作 → 设计工具」「个人 → 影视」 |
| **一键加书签** | 分类名右侧和每张链接卡片末尾都有「＋」，点一下自动归到该分类并排最前 |
| **全站访问锁** | 没输密码前整站锁屏，数据接口全部 401，一条书签都不泄露 |
| **免密分享链接** | 生成 48 位密钥，凭 `https://你的域名/k/<密钥>` 直接进站，可随时作废 |
| **站内全局搜索** | 标题/网址/备注/分类名一次搜全，`Ctrl+K`（Mac `⌘+K`）聚焦，`Esc` 清空 |
| **图标自动抓取** | 按域名自动取网站图标，浏览器缓存 1 天 |
| **备份到邮箱** | 填个邮箱点一下，全量备份 JSON 作为附件发过去 |
| **检查更新** | 页脚显示版本号，设置里一键比对 GitHub 最新版 |
| **手机适配** | 头部自动换行、分类变横向滚动胶囊、书签两列撑满 |
| **极速首屏** | 单请求拉全量数据 + 本地快照，二次访问秒开 |

技术架构：

```
浏览器 ──HTTPS──> Cloudflare Worker (worker/index.js)
                    ├─ 访问锁拦截（未登录 → 锁屏页 / 401）
                    ├─ /api/*  业务逻辑（书签/分类/图标/登录/免密）
                    ├─ Workers Assets 托管 public/ 静态前端
                    └─ Cloudflare KV (BOOKMARKS) 存数据
```

- 前端：`public/index.html` + `public/app.js`（原生 JS，**不需要打包构建**）
- 后端：`worker/index.js`（单文件 Worker）

---

## 二、开始前要准备什么

只要三样，全免费：

| 需要 | 说明 | 费用 |
|---|---|---|
| Cloudflare 账号 | 去 https://dash.cloudflare.com/sign-up 用邮箱注册 | 免费 |
| Node.js | 去 https://nodejs.org 下载 **LTS 版本**，一路下一步安装 | 免费 |
| 本项目代码 | 下面会讲怎么拿 | 免费 |

> 不需要服务器、不需要域名（用 Cloudflare 送的 `*.workers.dev` 地址就能访问）。

---

## 三、手把手安装（Windows）

全程约 10 分钟。按顺序做就行。

### 步骤 1：拿到代码

**方式 A（推荐，会用 git）**：打开命令行，执行

```bash
git clone https://github.com/jeffak000/webbook-cf.git
cd webbook-cf
```

**方式 B（不会 git）**：打开 https://github.com/jeffak000/webbook-cf → 点绿色 **Code** 按钮 → **Download ZIP** → 解压到本地任意文件夹（比如 `D:\webbook-cf`）。

### 步骤 2：装 wrangler（Cloudflare 的部署工具）

在**项目文件夹里**打开命令行（资源管理器地址栏输入 `cmd` 回车即可），执行：

```bash
npm install wrangler
```

装完别关这个窗口，后面都在这里执行。

### 步骤 3：找到你的「账户 ID」

1. 登录 https://dash.cloudflare.com
2. 左侧点 **Workers 和 Pages**（旧版界面叫 Workers）
3. 右侧能看到 **账户 ID**，一串 32 位字符，点它复制

记下来，等下要用。

### 步骤 4：创建 API 令牌（部署凭证）

1. 右上角头像 → **我的个人资料** → 左侧 **API 令牌**
   （直达链接：https://dash.cloudflare.com/profile/api-tokens）
2. 点 **创建令牌** → 找到 **编辑 Cloudflare Workers** 这一行，点右边 **使用模板**
3. 权限已经帮你选好了，确认包含这两项：
   - `账户 - Workers 脚本 - 编辑`
   - `账户 - Workers KV 存储 - 编辑`
4. 账户资源选 **你的账户**；区域资源保持默认
5. 点 **继续以显示摘要** → **创建令牌**
6. **令牌只显示这一次**，立刻复制保存好（关掉页面就再也看不到了）

### 步骤 5：创建 KV 数据库

回到命令行，执行：

```bash
npx wrangler kv namespace create BOOKMARKS
```

第一次会让你登录 Cloudflare（浏览器点「Allow」授权）。成功后会输出类似：

```
✨ Success!
id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
```

**把这串 id 复制下来** —— 这是你的数据库编号。

### 步骤 6：改配置文件

用记事本（或 VS Code）打开项目里的 `wrangler.toml`，改两处：

```toml
# 第 7 行：把 YOUR_CLOUDFLARE_ACCOUNT_ID 换成步骤 3 的账户 ID
account_id = "你的32位账户ID"

# 第 12 行：把 YOUR_BOOKMARKS_KV_ID 换成步骤 5 的数据库 id
kv_namespaces = [
  { binding = "BOOKMARKS", id = "你的KV数据库id" }
]
```

**注意**：引号要保留，只替换引号里面的内容。

### 步骤 7：部署

在命令行执行（把 `cfut_你的令牌` 换成步骤 4 复制的令牌）：

```bash
set CLOUDFLARE_API_TOKEN=cfut_你的令牌
npx wrangler deploy
```

看到 `Deployed webbook-cf triggers` 和一串网址，就是成功了：

```
https://webbook-cf.你的子域.workers.dev
```

**打开那个网址，就能看到你的书签导航站了。**

> 如果改用 PowerShell，把 `set X=Y` 换成 `$env:X="Y"`。
> 如果想省掉每次输令牌，可以执行 `npx wrangler login` 用浏览器登录一次，之后直接 `npx wrangler deploy` 即可。

### 步骤 8（可选）：一键部署脚本

`deploy.example.bat` 是 Windows 一键部署模板：自动换版本号 → 部署 → 清缓存。

把里面的占位路径和凭据填好后，**重命名成 `deploy.bat`**，以后双击就能部署。
该文件已在 `.gitignore` 里，**不会被上传到 GitHub**，密钥安全。

---

## 四、装好之后必做的两件事

### 1. 改掉默认密码

默认密码是 `admin`，**任何人都能进**。

登录后点右上角 **设置** → 找到修改密码 → 改成你自己的。

或者用命令行设置（更安全，密码不进代码）：

```bash
npx wrangler secret put APP_PASSWORD
```

### 2. 生成免密链接（方便手机访问）

设置面板里点「免密访问密钥」→ 生成 → 复制链接 `https://你的域名/k/<密钥>`。

手机上打开这个链接就能直接进，不用每次输密码。密钥泄露时可一键重新生成，旧链接立即失效。

---

## 五、绑定自己的域名（可选）

前提：你的域名已经接入 Cloudflare（NS 指向 Cloudflare）。

打开 `wrangler.toml`，把最后这段的注释符号 `#` 删掉，改成你的域名：

```toml
routes = [
  { pattern = "book.your-domain.com", custom_domain = true }
]
```

保存后重新执行 `npx wrangler deploy`。Cloudflare 会自动帮你申请证书、配好解析。

---

## 六、日常使用

| 操作 | 怎么做 |
|---|---|
| 加书签 | 顶部「+ 书签」，或点分类/卡片上的「＋」直接加到该分类 |
| 搜索 | 顶部搜索框，或 `Ctrl+K` / `⌘+K` 唤起 |
| 拖动排序 | 书签直接拖；分区在「设置 → 分区管理」里按住 ⠿ 拖动 |
| 改图标 | 自动抓，抓不到可在编辑里填图标地址 |
| 切分组 | 顶部「个人 / 工作」标签 |
| 检查更新 | 设置 → 关于/更新 → 检查更新 |

---

## 七、备份与恢复

数据存在 Cloudflare KV（云端），不在代码里。建议定期备份。

**方式 1：网页导出**
设置 → 备份 → 下载，得到 `bookmarks-日期.json`。

**方式 2：发到邮箱**（推荐，不容易丢）
设置 → 备份到邮箱 → 填邮箱 → 发送。会作为附件发过去。
需要配置 Resend 邮件服务（免费 3000 封/月）：

```bash
npx wrangler secret put RESEND_API_KEY   # 填 re_ 开头的 key
npx wrangler secret put MAIL_FROM        # 填 "Book Hub <backup@你的域名>"
```

> ⚠️ 两个都要设！只填 KEY 不填 `MAIL_FROM` 的话，发件人会走默认值，导致只能发到你自己注册邮箱。

**方式 3：命令行脚本**
`restore.example.mjs` 是模板，改成 `restore-kv.mjs` 后可批量导入导出（已在 `.gitignore`，不会上传）。

**恢复**：设置 → 恢复 → 选择之前导出的 JSON 文件。

---

## 八、怎么升级到新版

方法 A（简单）：下载新版代码，只替换 `worker/index.js`、`public/index.html`、`public/app.js` 三个文件，然后重新 `npx wrangler deploy`。**数据不会丢**（数据在 KV 里）。

方法 B（会用 git）：

```bash
git pull
npx wrangler deploy
```

升级后浏览器按 `Ctrl+Shift+R` 强制刷新，否则可能看到旧界面。

站点内的「检查更新」会提示新版本并跳转到 GitHub 下载页。

---

## 九、常见问题 FAQ

| 问题 | 解决 |
|---|---|
| `npx wrangler` 报错找不到命令 | Node.js 没装好，重装 LTS 版并重启命令行 |
| 部署时报 `Authentication error` | 令牌错了或过期，重新生成一个；确认 `set` 和 `npx` 在**同一个**命令行窗口执行 |
| 提示 KV namespace 不存在 | 步骤 5 的 id 填错了，重新 `npx wrangler kv namespace list` 查 |
| 打开是 404 / 空白 | 等 1 分钟再试；或用 `*.workers.dev` 地址先验证 |
| 改了代码但页面没变 | 浏览器强制刷新 `Ctrl+Shift+R`；确认执行过 `node bump.js` |
| 忘了密码 | 命令行 `npx wrangler secret put APP_PASSWORD` 重设 |
| 手机打开排版很乱 | 已适配，先强制刷新；旧版本缓存问题 |
| 部署一直卡住 | 检查网络代理；代理环境可设 `set NO_PROXY=api.cloudflare.com` |
| 免费额度够用吗 | Workers 每天 10 万请求、KV 每天 10 万读，个人使用远远够 |

---

## 十、版本更新记录

最新在上。

| 版本 | 日期 | 更新内容 |
|---|---|---|
| **v4.6** | 2026-09-30 | 修复 Zen 浏览器左侧右键删除分类无反应：改用页面内确认弹窗；确认后才删除分类及其书签，支持取消和 Esc 关闭；删除成功立即刷新列表与本地快照；失败时显示原因，防止重复提交；修正页脚版本号重复 v 前缀 |
| **v4.5** | 2026-09-28 | 新增「备份到邮箱」：填收件邮箱一键把全量备份 JSON 作为附件发出（经 Resend，API Key 存 Worker Secret 不进仓库）；自动记住上次邮箱；本地下载备份保留不变 |
| v4.4 | 2026-09-27 | 书签卡片末尾新增「＋」：鼠标移到链接上显现（手机常驻），点一下自动选好该链接所属分类，保存即归入并排最前；侧栏分类「＋」保留不变 |
| v4.3 | 2026-09-25 | 侧栏分类行新增「＋」：点击直接新建书签并归入该分类，排在该分类最前，自动切换并聚焦；移动端胶囊分类同样支持 |
| v4.2 | 2026-09-20 | 移动端布局重做：头部换行（标题+按钮 / 分区标签 / 搜索各一行）、分类变顶部横向滚动胶囊条、书签两列撑满；体验优化：首屏骨架屏、图标懒加载防抖、搜索清除按钮、`Esc` 关闭浮层、键盘焦点可见、深色滚动条 + `color-scheme:dark`；「分区管理」支持拖动排序（新增分区 `sort` 字段） |
| v4.1 | 2026-09-11 | 新增站内全局搜索（跨分组/分类，实时过滤高亮 + `Ctrl/⌘+K` 快捷键）；新增「检查更新」入口（页脚版本号 + 设置里比对 GitHub 最新版，配套 `version.json` 自检） |
| v4.0 | 2026-09-11 | 缓存加固：静态资源按版本号长缓存 1 年（immutable），改版自动生效；修复安全缺口——`run_worker_first` 强制静态资源过 Worker，未登录无法下载前端源码；新增 `bump.js` 自动版本号、`deploy.bat` 一键部署+清缓存；代码开源 |
| v3.0 | 2026-09-10 | 性能优化：新增 `/api/bootstrap?icons=1` 单接口（5 请求→1 请求）；HTML 内联预取省一个 RTT；localStorage 快照首帧渲染；Worker 内缓存热点数据；开启 HTTP/3 / 0-RTT / Brotli |
| v2.0 | 2026-09-10 | 新增全站访问密码锁；后台可生成 48 位免密长密钥，凭 `/k/<key>` 免登录进入；修复未登录数据泄露 |
| v1.0 | 2026-09-10 | 初版上线：Cloudflare Workers + KV 部署，基础书签导航（分组/分类/图标/后台管理/导入导出） |

---

## 十一、安全提醒

- **默认密码 `admin` 必须改掉。**
- 部署用的令牌/密钥不要写进要提交的文件，优先用 `wrangler secret`。
- 本仓库**不含任何真实凭据**；`wrangler.toml`、`deploy.example.bat`、`restore.example.mjs` 都只是占位模板。

---

## 许可证 / License

MIT © jeffak000 — 自由使用、修改、分发。

觉得好用的话给个 ⭐ Star 吧。
