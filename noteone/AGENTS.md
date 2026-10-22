# 项目维护与发布约定

用户已要求：以后本项目完成改动并上线后，自动升级版本、上传 GitHub、发布独立 ZIP 与中文更新说明，并同步博客，不必逐次请求发布确认。只更新内容数据或排查而未改代码时无需发版本。

- 当前仓库：https://github.com/gaigogogo/web-book ，腾讯云源码 noteone/；CF v4.6 停止更新，不修改其源码或版本信息。
- 每次完成的一组代码改动递增一次小版本：4.9 → 4.10 → 4.11。用户指定版本时以指定值为准。不能在每次尝试部署时反复加版本。
- 先写 RELEASE_NOTES.md，说明实际改变、验证结果和限制，不声称未实测能力。
- 执行 `node maintenance/release.cjs`：自动递增版本、检查、构建、部署、源码提交、Release/ZIP、博客同步。指定版本可用 `--version 4.9`。
- 重试发布已部署版本使用 `node maintenance/release.cjs --publish-only`，不再递增；不要改动历史 Release 标签。
- EdgeOne 必须全球可用区（不含中国大陆），项目 book-hub / makers-3hrieuxrkwdr。
- API 入口 D:/api/API总目录.md；GitHub token 读取 D:/api/GitHubAPI.md。不要输出、上传密钥、.env、用户数据或会话。
- 博客 https://www.090803.xyz/feed/10 保留全部历史，在已有版本段落更新或末尾追加，不能覆盖整篇历史。
- 发布失败时报告具体环节，不可宣称全完成；检查线上版本、Release ZIP 和博客回读。
