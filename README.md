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

于是有了「离豆」：先用桌面工具**一条命令（或一次点击）把历史标记连同评分、短评、日期搬进开源的 NeoDB**，
再装上浏览器扩展，之后每一次新标记都会实时同步过去——数据从此握在自己手里，不依赖任何中间文件。

## 快速开始

### 第一步：迁移历史标记（桌面工具）

1. 安装 Python 3.9+ 和 `pip install requests`；
2. 复制 `config.example.ini` 为 `config.ini`，填三项：
   - `user_id`：豆瓣主页地址 `https://www.douban.com/people/xxxxxx/` 里的 `xxxxxx`；
   - `cookie`：浏览器登录豆瓣后 F12 → Network → 任一请求 → 整串 `Cookie:`；
   - `token`：NeoDB → 设置 → 开发者 → 创建访问令牌（勾 `read` + `write`），
     或用仓库自带的 [`docs/token-tool.html`](docs/token-tool.html) 小工具生成；
3. 双击 `启动同步界面.bat`（或 `python gui.py`）：测试连接 → 预览 → 开始同步；
   命令行党：`python sync_douban_to_neodb.py sync`（支持 `--dry-run` / `--limit` / `--statuses` / `--full`）。

![图形界面](docs/screenshot.png)

同步是增量的：未变化自动跳过、可中断续传、重复运行不产生重复标记。
抓取结果缓存于 `marks_cache.json`（6 小时内有效），删除即强制重抓。

### 第二步：日常实时同步（浏览器扩展）

见 [`extension/README.md`](extension/README.md)——加载扩展、配置令牌（支持一键 OAuth），
之后在豆瓣页面的每次标记都会自动同步，右下角弹窗提示结果。

### 获取 NeoDB 访问令牌

- **网页小工具**：仓库自带 [`docs/token-tool.html`](docs/token-tool.html)，双击本地打开（或访问在线版），三步拿到令牌；
- **开发者控制台**：登录 NeoDB → `https://neodb.social/developer/` → Dev Console → Authorize。

## 常见问题（桌面工具）

- **豆瓣提示异常请求**：触发风控，等几小时、必要时换 Cookie，调大 `config.ini` 里的 `delay`（别低于 2 秒）；
- **个别条目收录失败**：多为豆瓣已下架条目，NeoDB 无法收录，脚本会跳过并汇总；之后 `sync --full` 可补齐；
- **NeoDB 返回 401**：令牌失效（重新生成过或退出登录），重新生成即可；
- **会重复吗**：不会。本地缓存 + NeoDB 端标记双重比对，重复运行只处理有变化的部分。

扩展的常见问题见 [`extension/README.md`](extension/README.md)。

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
