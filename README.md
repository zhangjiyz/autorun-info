# AutoRun 适配库

独立于 `autorun-cn` 的游戏适配展示站，提供游戏列表、游戏详情和社区网盘分享。

社区分享免注册，无需人机验证，提交成功后立即公开。网站不设审核流程或管理后台；提交接口保留频率限制和重复链接检查。网站保存链接、提取码和用户填写的说明，不保存网盘中的文件。

## 本地运行

需要 Node.js 22.19 或更高的 22 LTS 版本，以及 npm。首次安装后执行：

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:8787>。启动命令会准备本地变量、迁移本地 D1、构建页面并启动 Wrangler。本地分享只写入 `.wrangler/` 中的开发数据库，不会修改云端数据。`.dev.vars` 使用本地随机盐，已被 Git 忽略。

页面使用构建产物；修改页面或同步资料后重新运行 `npm run dev`。停止服务使用 `Ctrl+C`。

## 更新游戏资料

游戏信息来自 `autorun-cn/wine-nx-probe/profiles/catalog.json` 及相邻说明、封面文件。两个仓库放在同一级目录时执行：

```sh
npm run sync:catalog -- --source ../autorun-cn
```

同步脚本将展示用快照写入本仓库，构建不依赖另外克隆 `autorun-cn`。检查快照和封面变化后，随网站代码一起提交即可。同步操作不修改原适配工程。

原工程中的游戏 `id` 用于关联详情页和社区分享，应保持稳定。适配版本和说明照来源展示；现有资料没有确认的实机结论时，不自动标记为“可玩”。网站不提供适配包下载或安装指南。

## 常用命令

| 命令                                             | 用途                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `npm run dev`                                    | 启动含分享 API 和本地 D1 的完整预览                         |
| `npm run dev:ui`                                 | 启动 Astro 页面开发服务，适用于热更新页面样式；不含分享 API |
| `npm run check`                                  | 检查 Astro 页面和 Worker TypeScript                         |
| `npm test`                                       | 运行接口规则等自动测试                                      |
| `npm run build`                                  | 生成静态页面                                                |
| `npm run sync:catalog -- --source ../autorun-cn` | 更新游戏资料快照                                            |
| `npm run db:migrate:local`                       | 应用本地 D1 迁移                                            |
| `npm run db:migrate:remote`                      | 应用云端 D1 迁移，需要 Cloudflare 登录                      |
| `npm run deploy`                                 | 预检生产配置、构建并部署，需要 Cloudflare 登录              |

## 项目结构

```text
src/                  Astro 页面、组件、样式和游戏资料快照
public/               封面等静态资源
worker/               /api/* 分享接口
migrations/           D1 数据库迁移
scripts/              资料同步、本地准备和部署预检
tests/                自动测试
docs/deployment.md    Cloudflare 与域名接入说明
wrangler.jsonc        Worker、静态资源与 D1 绑定配置
```

Astro 生成静态页面，Cloudflare Workers 托管页面并处理分享 API，D1 保存分享记录。更新或重新部署网站不会清空 D1。

## 部署

参见 [Cloudflare 部署说明](docs/deployment.md)。仓库内的初始配置供本地预览使用，正式发布前需要配置自己的 D1、频率限制随机盐和域名。GitHub Actions 只做检查和部署打包验证，不发布到云端。
