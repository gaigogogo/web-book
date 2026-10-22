# Web Book · EdgeOne 书签导航站

一个轻量的网址收藏与导航站：用分组、分类、搜索和备注整理常用网址，支持电脑、手机和 iPad 浏览及维护。

**当前维护平台：腾讯云 EdgeOne Pages / Makers。当前版本：v{{VERSION}}。**

[在线演示](https://book.090803.xyz/) · [下载最新版](https://github.com/gaigogogo/web-book/releases/tag/{{TAG}}) · [全部版本](https://github.com/gaigogogo/web-book/releases) · [完整介绍与更新历史](https://www.090803.xyz/feed/10)

> 平台名称统一为 **EdgeOne**。仓库中的 `noteone/` 是沿用的历史源码目录名，Release 标签中的 `-noteone` 为兼容历史下载和更新检查而保留，不代表另一种平台。

## 一、先选对版本

| 版本 | 平台与存储 | 状态 | 下载 |
| --- | --- | --- | --- |
| **EdgeOne v{{VERSION}}** | 腾讯云 EdgeOne + Blob | 持续维护，推荐新部署使用 | [EdgeOne 最新版](https://github.com/gaigogogo/web-book/releases/tag/{{TAG}}) |
| Cloudflare v4.6 | Cloudflare Workers + KV | 最终保留版，停止更新 | [CF v4.6](https://github.com/gaigogogo/web-book/releases/tag/v4.6) |

腾讯云正式入口：[book.090803.xyz](https://book.090803.xyz/)；CF 独立保留入口：[bookcf.090803.xyz](https://bookcf.090803.xyz/)。两站数据独立，不能当作自动同步的镜像。

**需要 CF 的用户请选择 v4.6（含）或更早版本。** 不要把 EdgeOne 代码直接覆盖进 CF Worker。仓库根目录保留的旧 Worker 文件属于历史实现；当前 EdgeOne 代码请看 [`noteone/`](https://github.com/gaigogogo/web-book/tree/main/noteone)。

## 二、主要功能

- 分组和分类：按用途组织网址，支持新建、改名、移动、排序和数量统计。
- 全局搜索：跨分组搜索标题、URL、备注与分类名；支持 Ctrl/⌘+K。
- 书签维护：新增、编辑、删除、拖拽移动；保存成功直接更新页面，减少全量重载。
- 快速添加：粘贴 HTTP(S) URL 自动尝试获取网页标题、后台获取图标；提供书签栏小工具。
- 备注提示：带备注的书签显示橙色标识，悬停或聚焦快速查看。
- 手机编辑：编辑模式提供编辑、删除、前后排序按钮；书签支持触屏长按菜单。手机宽度不超过700px时隐藏分类导航。
- 链接检测：每批8条，支持继续、暂停、重新检查全部；异常自动重试。检测状态文字10分钟后自动隐藏，记录保留。
- 访问控制：共享密码、公开只读开关、免密链接；不是多用户账号系统。
- 备份恢复：导出/恢复 JSON，可通过 Resend 发送备份附件。
- 加载优化：本地快照先显示、后台同步、资源版本化、手动刷新数据。
- PWA：可添加到主屏幕；主动启用后支持本机离线只读，不提供离线写入。

自动标题遇到动态网页、登录限制或网络问题时可手填。链接检测中404/410标记失效，超时、拒绝访问等标为“待确认”，不等于确定死链。检测速度取决于目标站网络。

## 三、技术与目录

前端为原生 HTML/CSS/JavaScript，后端为 EdgeOne 函数入口，存储使用 `@edgeone/pages-blob`（Blob 名称 `bookmarks`，强一致读取）。无需为导航站另配 Turso 或 SQL 数据库。

```text
noteone/                       # 当前 EdgeOne 版
  public/index.html            # 页面和样式
  public/app.js                # 交互、搜索与缓存
  public/sw.js                 # 离线页面缓存
  public/manifest.webmanifest  # PWA 安装信息
  worker-source.js             # API、鉴权与业务逻辑
  build.cjs                    # 将页面与后端构建为部署入口
  bump.cjs                     # 更新浏览器资源版本号
  edge-functions/              # 构建生成文件
  edgeone.json                 # 构建配置
  version.json                 # 当前发行版本与更新入口
  RELEASE_NOTES.md             # 当前版本说明
  maintenance/                # 维护与发布脚本
```

请修改 `public/` 和 `worker-source.js` 后重新构建，不要只修改生成的 `edge-functions/`。`dist/` 仅是部署占位页；只部署静态目录无法提供完整网站和 API。

## 四、部署到 EdgeOne

### 准备条件

1. Node.js 18或以上及 npm；现有CLI部署流程使用 EdgeOne CLI。
2. 腾讯云国际 EdgeOne Pages / Makers 项目及相应部署权限。
3. **可用区必须选择「全球可用区（不含中国大陆）」**，CLI 参数为 `-a overseas`。
4. 配置 Blob 存储 `bookmarks` 和站点密码。套餐、免费额度及域名条件以平台当前规则为准，本文不承诺永久免费或固定访问速度。

### 构建

克隆仓库后进入 EdgeOne 源码目录；若下载的是独立 ZIP，则进入包含 `package.json` 的目录。

```bash
git clone https://github.com/gaigogogo/web-book.git
cd web-book/noteone
npm ci
node bump.cjs
node build.cjs
```

### 发布

先通过 EdgeOne CLI 登录自己的账号并确认项目配置，然后部署：

```bash
npx edgeone@1.6.41 makers deploy -n your-project-name -a overseas --skip-ai-gateway-sync --json
```

将 `your-project-name` 换成自己的项目名。不要照搬作者项目ID、密码或令牌。绑定自定义域名后按控制台返回值配置 DNS 与 HTTPS。

## 五、配置说明

| 配置 | 用途 |
| --- | --- |
| Blob `bookmarks` | 保存分组、分类、书签、图标、站点信息和访问配置 |
| `APP_PASSWORD` | 初始登录密码，务必设置；站内修改后的存储密码优先 |
| `RESEND_API_KEY` | 可选，备份邮件发送能力 |
| `MAIL_FROM` | 可选，已验证域名下的发件地址，如 `导航站备份 <backup@example.com>` |

邮件发给非测试收件人时，需在 Resend 验证自己的发信域名。密钥仅保存在平台私有环境或本机私有配置，不写进源码、README 或下载包。

## 六、日常使用

进入网站后选择分组或搜索网址。新增可使用顶部“+书签”或分类旁“+”；电脑右键打开管理菜单，手机可用“编辑模式”。

新增、编辑、移动网址会直接保存到 Blob，**无需重新部署代码**。其他设备可重新打开页面，或在设置中点“刷新数据”。

设置中的“继续检查”跳过24小时内正常/失效结果和1小时内待确认结果。要强制重新探测所有网址，使用“重新检查全部”。检测时保持页面打开，暂停或中断后已完成结果保留。

PWA 首次需联网登录并在设置中启用离线。iPad 使用 Safari 分享菜单中的“添加到主屏幕”。离线仅显示已保存在当前设备的内容；共享设备请谨慎启用并在使用后退出登录。

## 七、怎么升级到新版

### 当前可用：EdgeOne 手动升级

1. 在设置中导出 JSON 备份。
2. 下载 [最新 EdgeOne ZIP](https://github.com/gaigogogo/web-book/releases/tag/{{TAG}})，或在本地仓库执行 `git pull`。
3. 使用完整 EdgeOne 源码构建，不能只替换 CF 文档中的三个文件：

```bash
cd noteone
npm ci
node bump.cjs
node build.cjs
npx edgeone@1.6.41 makers deploy -n your-project-name -a overseas --skip-ai-gateway-sync --json
```

4. 部署到**同一个项目**，保留原有 Blob 和环境变量；不要删除存储，不执行清空、恢复或旧迁移导入脚本。
5. 刷新网站，检查页脚版本；必要时按 Ctrl+Shift+R。安装过PWA的设备也应联网重新打开。

正常的同项目代码部署不会主动删除 Blob 书签，但仍建议事先备份。不要把“重新建项目”“覆盖恢复数据”与“更新代码”混为一谈。

### 后台一键更新：接入中，尚未可用

计划流程：设置 → 检查更新 → 一键更新 → 输入站点密码 → GitHub Actions 构建部署 → 页面查看进度。

目前工作流已添加，功能代码已准备，但仓库 Secret 配置权限尚未补齐，**尚未完成上线和端到端验证**。因此当前升级仍按上面的手动方法，不能将“检查更新”理解为已经自动安装。

### 维护者自动发布

本仓库维护流程在一组代码改动完成后递增版本（4.9 → 4.10 → 4.11），同步 GitHub 源码、独立 ZIP、中文 Release 说明及博客。`maintenance/release.cjs` 是作者本机维护脚本，依赖作者私有配置；其他部署者不能直接照搬运行。

自动发布新版本与部署者安装新版本是两件事。当前站内“检查更新”负责提示发行版和下载入口。

### CF 历史版

CF 用户继续使用 [v4.6及更早版本](https://github.com/gaigogogo/web-book/releases/tag/v4.6) 自带文档及 `wrangler deploy` 流程。CF 的 KV 配置不适用于 EdgeOne；本 README 的当前部署命令以 EdgeOne 为准。

## 八、版本与更新说明

| 版本 | 主要内容 |
| --- | --- |
| **v{{VERSION}}** | 仓库说明重整为 EdgeOne 主版本；网站页脚显示 EdgeOne；区分可用升级流程与尚未接通的一键更新 |
| [v4.9](https://github.com/gaigogogo/web-book/releases/tag/v4.9-noteone) | 手机分类导航隐藏、链接检测提速与续查、状态文字10分钟自动隐藏、维护发布流程 |
| [v4.8](https://github.com/gaigogogo/web-book/releases/tag/v4.8-noteone) | 自动标题、小工具、链接检测、手机编辑模式、长按菜单与PWA |
| [v4.7](https://github.com/gaigogogo/web-book/releases/tag/v4.7-noteone) | EdgeOne独立版、备注标识、本地快照与手动刷新、保存和移动优化 |
| [CF v4.6](https://github.com/gaigogogo/web-book/releases/tag/v4.6) | Cloudflare最终保留版，停止更新 |

完整历史以 [GitHub Releases](https://github.com/gaigogogo/web-book/releases) 和 [博客说明](https://www.090803.xyz/feed/10) 为准。

## 九、当前边界

- 当前是共享密码管理，不提供注册、用户独立收藏或多角色账号系统。
- Blob 数组以整份JSON读写，多设备同时修改存在覆盖风险；不是事务型数据库。
- 免密链接未实现独立只读角色，不应当作严格的只读分享权限使用。
- 图标、标题抓取和链接检测受外部站点与网络限制；不保证所有网站都能探测。
- JSON备份包含分组、分类、书签、图标，不是环境变量和全部站点设置的完整备份。
- 手机布局已适配，但各浏览器的触屏菜单、PWA与系统分享支持可能不同。

以上限制并不影响常规个人书签使用，重要数据仍建议定期备份。
