# 适配资料快照

网站构建只读取已检入的 `src/data/games.json` 和 `public/covers/`，不需要原适配仓库在旁边，也不在构建时联网查询或抓取游戏文件。

维护者更新资料时运行：

```sh
npm run sync:catalog -- --source /path/to/autorun-cn
```

省略 `--source` 时，仅此同步命令默认读取网站仓库旁的 `../autorun-cn`。脚本只读取 `wine-nx-probe/profiles/catalog.json`、各游戏的 `README.zh-CN.md` 和 catalog 指定的封面；不写入原仓库，也不复制 DLL、适配包 ZIP、游戏本体或设备日志。所有封面逐字节复制，不裁切、不重绘。缺少封面时输出 `null`，缺少说明时输出空字符串，由页面显示文字占位。

`source.commit` 和 `source.workingTreeDirty` 记录同步来源。后者只检查原仓库 profiles 路径下的改动；从源码压缩包导入、无法取得 Git 信息时，两者为 `null`。`source.kind` 始终为 `local`：目录和说明是这次导入的本地资料，不代表已在服务器正式发布。`source.importedAt` 是 UTC 时间。

## 分类和实机状态

`src/data/editorial.json` 按游戏 ID 维护分类、`targetVersion`（适用版本）、`knownIssues`（已知情况列表）和精简验证说明。摘要仅依据原 catalog 与 README 的真实记录，不将历史阶段成功泛化为完整可玩。默认所有游戏是 `unverified`，意为“本站尚未记录完整验证”，不抹去原说明中已有的局部实机结果。`description` 和 `readme` 保留原始文字；页面展示精简摘要，完整 README 仅保留在快照中供编辑核对。

有新证据时，可添加 `verification: "partial"` 或 `"verified"`，同时必须填写 `verificationNote`（具体版本、设备、日期、已验证项目及局限）与 `evidence`（可追踪的测试记录）。主机构建、静态检查或成功上传不能作为完整可玩的证据。脚本不会推断这些状态。

## 数据契约

`games.json` 含 `source` 和 `games`。每个游戏提供 `id`、`name`、`version`、`minApi`、`keywords`、`description`、`cover`、`readme`、`category`、`verification`、`verificationNote`、`targetVersion`、`knownIssues`。`readme` 为 Markdown 原文，含内部诊断过程，不直接用于产品页面。目录路径、Markdown 链接均属于原始资料，不是执行指令。

社区分享链接来自用户提交并保存在数据库，不写入此资料快照。更新静态资料不会覆盖社区分享。
