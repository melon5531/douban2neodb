# 离豆 douban2neodb

**离豆**——离开豆瓣，标记不散。一套把豆瓣书影音标记搬进 [NeoDB](https://neodb.social) 的完整方案，**不经过任何导出文件**：

| 组件 | 干什么 | 什么时候用 |
| --- | --- | --- |
| **离豆桌面工具**（本仓库根目录，Python） | 一次性迁移**全部历史标记**（看过/想看/在看 + 星级 + 短评 + 标记日期） | 迁移的第一步，跑一次 |
| **浏览器扩展**（[`extension/`](extension/README.md)，Chrome/Edge） | **一键迁移全部历史标记** + 之后在豆瓣标记/打分/写短评的当下实时同步 | 装一次，全部搞定 |

两个组件共用同一套 NeoDB API（条目收录 + 标记写入），都只把令牌保存在本地。

## 为什么做这个工具

豆瓣上的影视条目时不时会「消失」——下架、合并、审核，都可能让多年攒下的标记和短评说没就没。
而豆坟这类备份工具流程偏繁琐：装插件、等备份、导出文件、再手动导入。

于是有了「离豆」：装一个浏览器扩展，**一键把历史标记连同评分、短评、日期搬进开源的 NeoDB**，
之后每一次新标记都会实时同步过去——数据从此握在自己手里，不依赖任何中间文件。

## 快速开始（浏览器扩展，一条龙）

> 全程只需浏览器：登录着豆瓣的 Chrome / Edge（Chromium 内核，需 Chrome 111+）。

**1. 安装扩展**

下载本仓库 → 浏览器打开 `chrome://extensions`（Edge 输入 `edge://extensions`）→
打开右上角的**「开发者模式」**→ 点**「加载已解压的扩展程序」**→ 选择 `extension` 文件夹 →
固定到工具栏。

**2. 配置 NeoDB 令牌**

点扩展图标 → **打开设置** → 粘贴访问令牌 → **保存设置 → 测试连接**。
令牌获取：NeoDB → 设置 → 开发者（[neodb.social/developer](https://neodb.social/developer/)）→ Authorize 生成，
或用仓库自带的 [`docs/token-tool.html`](docs/token-tool.html) 小工具三步生成。

**3. 迁移历史标记**

点扩展图标 → **「历史标记迁移」→ 开始迁移**。扩展会自动打开你的豆瓣标记页，
分页抓取**看过 → 想看 → 在看**（含星级、短评、标记日期）并逐条同步到 NeoDB。
进度条实时显示，可随时**暂停**、再点**继续**从断点接着跑；
已同步的条目自动跳过，重复运行不会产生重复标记。

**4. 完事，日常无感同步**

迁移完成后什么都不用做：之后在豆瓣的每一次**标记、打分、写短评**都会自动实时同步到 NeoDB，
页面右下角会弹出同步结果提示。

> 迁移节奏保守（豆瓣页面间隔约 3 秒），上千条标记预计 1~2 小时，期间保持豆瓣标签页打开即可。
> 扩展的详细说明与常见问题见 [`extension/README.md`](extension/README.md)。

## 桌面工具（可选的备用方案）

`extension` 之外的 Python 脚本是同一功能的命令行实现，适合不想装扩展、或想在不打开浏览器的情况下批量处理的人：

1. `pip install requests`，复制 `config.example.ini` 为 `config.ini`，填入豆瓣 user_id、豆瓣 Cookie、NeoDB 令牌；
2. `python gui.py` 打开图形界面（或双击 `启动同步界面.bat`），或直接命令行：

   ```bash
   python sync_douban_to_neodb.py check            # 验证凭据
   python sync_douban_to_neodb.py sync --dry-run   # 预览，不写入
   python sync_douban_to_neodb.py sync             # 全量增量同步
   ```

同步是增量的：未变化自动跳过、可中断续传；抓取结果缓存于 `marks_cache.json`（6 小时内有效）。
常见问题：豆瓣提示异常请求 = 触发风控，等几小时并调大 `config.ini` 的 `delay`；
NeoDB 401 = 令牌失效，重新生成；个别条目收录失败 = 豆瓣已下架，`sync --full` 可补齐。

![桌面工具图形界面](docs/screenshot.png)

## 免责声明

本项目仅供个人备份**自己的**豆瓣数据使用，请勿用于抓取他人数据或任何商业用途。
对豆瓣的访问方式属于个人数据导出，与豆瓣服务条款的关系请自行评估；使用本项目产生的
账号风控等后果由使用者自行承担。本项目与豆瓣和 NeoDB 官方均无关联。

`config.ini`、`state.json`、`marks_cache.json` 含 Cookie、令牌和个人数据，已在 `.gitignore` 中排除，请勿分享。

## 致谢

- [NeoDB](https://github.com/neodb-social/neodb) —— 开源、联邦宇宙的书影音记录服务
- [bambooom/douban-backup-extension](https://github.com/bambooom/douban-backup-extension)、[zx2592/douban_backup](https://github.com/zx2592/douban_backup) —— 同类豆瓣备份项目（抓取思路来源）

## License

[MIT](LICENSE)
