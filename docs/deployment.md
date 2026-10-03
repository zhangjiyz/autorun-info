# 部署到 Cloudflare

本站使用 **Workers Static Assets + D1**。Cloudflare 连接本仓库后可以自动构建并部署，网盘分享记录保存在 D1 中。正式部署前先完成本地检查：

```sh
npm ci
npm run check
npm test
npm run build
```

下面涉及 `--remote`、`secret put` 和 `deploy` 的命令会操作 Cloudflare 云端；本地预览不需要执行这些命令。

## 1. 创建 D1 数据库

使用网页后台时，进入 **D1 SQL 数据库 → autorun-info → Console / 控制台**。先清空 SQL 输入框，输入 `SELECT 1 AS ok;` 并点击 Execute，确认结果为 `ok = 1`。

首次建表使用 [网页控制台 SQL](d1-console.sql)：文件没有注释，共 7 行，每行是一条完整语句。每次清空输入框、粘贴一整行并执行，按顺序完成 7 行。最后一行是触发器，必须从 `CREATE TRIGGER` 到 `END;` 整行执行。脚本使用 `IF NOT EXISTS`，本次初始化即使先前部分执行成功，也可以重复执行而不清空分享数据。

完成后运行 `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('shares', 'rate_limits', 'share_reports') ORDER BY name;`，应看到这 3 张表。网页手工初始化不会登记 Wrangler 的迁移记录；首次迁移已采用可重复执行的建表语句，后续切换迁移工具时仍须核对现有结构。

下面是命令行方式，网页操作无需执行这些命令。

在项目目录登录并创建数据库：

```sh
npx wrangler login
npx wrangler d1 create autorun-info
```

将命令返回的 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases`，保留代码使用的 `binding: "DB"`，数据库名称与创建的名称保持一致。仓库初始 ID 是本地占位值，不能作为生产数据库使用。

应用云端数据库迁移：

```sh
npm run db:migrate:remote
```

后续新增迁移文件时，在部署对应代码前应用迁移。网站部署与数据迁移分开执行，自动构建不会擅自修改数据库结构。[D1 官方入门](https://developers.cloudflare.com/d1/get-started/)

## 2. 配置运行时变量

网站无需人机验证。将频率限制使用的随机盐保存为 Worker secret：

```sh
npx wrangler secret put RATE_LIMIT_SALT
```

输入独立生成的至少 32 字符随机字符串，用于频率限制标识的哈希。生产 secret 不要填写在代码、README、`.dev.vars.example` 或 GitHub 中。也可以在 Worker 的 **Settings → Variables and Secrets** 中添加同名 Secret。

保留 `wrangler.jsonc` 中的 `ENVIRONMENT: "production"`。构建时通过环境变量 `SITE_URL` 设置最终地址，例如 `https://games.example.com`，用于生成页面 canonical 地址。它不是 Worker 运行时变量。正式域名尚未绑定时，可以先使用实际的 `workers.dev` 地址完成验证，之后统一更换。

本地启动脚本会生成独立的随机盐，只用于本地开发。

临时批量发布时，在 Worker 的 **Settings → Variables and Secrets → Add** 添加文本变量 `SHARE_RATE_LIMIT_BYPASS_UNTIL`，填入带时区的 ISO 截止时间，再点 **Deploy**。例如 `2026-10-04T00:45:00+08:00` 表示北京时间 2026 年 10 月 4 日 00:45；实际使用时填写需要的未来时间。该变量是运行时设置，不填在 Build variables and secrets 中。

截止前全站分享提交暂不限制次数，也不消耗原额度；每次请求都会检查时间，到期自动恢复原限制。未配置、时间无效或已过期时均按原限制执行。提前恢复可删除变量并部署。已有计数保留，重复链接检查与失效反馈限流继续生效。仓库不设固定截止时间，`keep_vars: true` 会保留后台设置的变量，后续 Git 部署不会将其清除。[Wrangler 变量保留说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

## 3. 首次部署

首次可以在本地完成部署，确认 Worker 与 D1 联通：

```sh
SITE_URL=https://games.example.com npm run deploy
```

部署命令会先检查生产配置，再生成页面并调用 Wrangler。缺少真实 D1 ID、HTTPS 站点地址，或环境不是 `production` 时，应先修正配置。部署预检不会读取云端 secret；`RATE_LIMIT_SALT` 是否正确，以部署后的分享提交结果为准。

打开部署返回的地址，检查游戏列表、详情页和封面；向任意游戏提交测试分享并刷新，确认无需审核即可显示。部署完成只表示服务已经发布，不代表所有游戏的实机兼容性已经验证。

## 4. 连接 GitHub 自动部署

在 Cloudflare Workers 项目中连接 `autorun-info` GitHub 仓库，建议设置：

| 设置                    | 值                                 |
| ----------------------- | ---------------------------------- |
| 生产分支                | `main`                             |
| 根目录                  | 仓库根目录                         |
| 构建命令                | `npm run check && npm test`        |
| 部署命令                | `npm run deploy`                   |
| 构建变量 `NODE_VERSION` | `22`，与本地和 CI 一致，至少 22.19 |
| 构建变量 `SITE_URL`     | 正式网站的完整 HTTPS 地址          |

`npm run deploy` 已包含页面构建，因此这里不重复填写 `npm run build`。Cloudflare 会根据仓库的 npm 锁文件安装依赖。

构建环境变量与 Worker 运行时变量不是同一组设置：`SITE_URL` 在构建时生成页面链接；`RATE_LIMIT_SALT` 是 Worker 运行时 secret。不要只把运行时 secret 填在 Build variables and secrets 中。[Workers Builds 配置文档](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

第一版只启用 `main` 生产部署。若以后启用其他分支的在线预览，应为预览配置独立 D1 和随机盐，避免测试分享写入生产数据库。

仓库自带的 GitHub Actions 负责安装依赖、类型检查、自动测试、Astro 构建和 `wrangler deploy --dry-run`；它不需要 Cloudflare token，也不会部署。正式发布由 Cloudflare Git 集成执行。

## 5. 绑定域名

进入该 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，填入已托管在 Cloudflare 的域名或子域名，例如 `games.example.com`。完成绑定后，同步更新构建环境中的 `SITE_URL`，再重新部署。[Workers 自定义域名文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 日常更新

适配资料更新后，运行同步脚本更新游戏快照，检查后提交到本仓库；推送 `main` 后由 Cloudflare 更新网站。社区分享直接写入 D1，不需要修改 GitHub 或触发网站构建，也没有待审核状态。

本地 `.wrangler/` 和 `.dev.vars` 不应提交。D1 的数据库 ID 不是密码，可以保存在 Wrangler 配置；API token 和 Worker secret 应留在 Cloudflare 的凭据设置中。

## 依赖检查记录

2026-10-03 的 `npm audit` 报告包含两个 high 条目，来自同一条依赖链 `astro → http-cache-semantics@4.2.0`。该缓存库的 `max-stale` 处理存在跨用户缓存泄露公告，目前 npm 未发布修复版本；自动修复建议是将 Astro 降到 2.10.9，不能作为本站的兼容补丁使用。[安全公告 GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)

已核对当前调用路径：Astro 在远程图片构建缓存中引用该库；本站封面是本地静态文件，页面使用原生 `<img>`，没有启用远程图片优化，分享 Worker 也不导入 Astro 或该缓存库。当前功能不经过公告描述的跨用户共享响应缓存路径。该依赖告警仍保留，后续升级应重新核对公告和 `npm audit` 结果。
