# 离豆 douban2neodb

**离豆**——离开豆瓣，标记不散。一个浏览器扩展，把你在豆瓣的书影音标记完整搬进 [NeoDB](https://neodb.social)。

## 这是一个全新的使用流程

以前想把豆瓣标记备份到别处，你要：装一个备份插件 → 等它慢慢爬完 → 导出一堆文件 →
再到另一个平台手动上传导入，漏了什么自己补。

「离豆」把这一切压成了**点一次按钮**：

| | 旧流程（豆坟式） | 离豆 |
| --- | --- | --- |
| 迁移历史标记 | 装插件 → 等备份 → 导出文件 → 手动导入 | **点「开始迁移」**，全自动 |
| 标记日期 / 评分 / 短评 | 文件里有没有全看运气 | **全部保留**，逐条写入 |
| 日常新标记 | 再手动同步一次 | **自动实时同步**，无感 |
| 数据落点 | 散落的 CSV / Excel | 直达开源的 NeoDB，握在自己手里 |
| 重复执行 | 可能重复、可能遗漏 | **幂等**：重复跑只处理有变化的 |

## 四步上手

> 只需一个登录着豆瓣的 Chrome / Edge（Chromium 内核，需 Chrome 111+），全程不碰命令行。

**① 安装扩展**

下载本仓库 → 浏览器打开 `chrome://extensions`（Edge 输入 `edge://extensions`）→
打开右上角的**「开发者模式」**→ 点**「加载已解压的扩展程序」**→ 选择 `extension` 文件夹 →
固定到工具栏。

**② 配置 NeoDB 令牌**

点扩展图标 → **打开设置** → 粘贴访问令牌 → **保存设置 → 测试连接**。
令牌获取：NeoDB → 设置 → 开发者（[neodb.social/developer](https://neodb.social/developer/)）→ Authorize 生成，
或用仓库自带的 [`docs/token-tool.html`](docs/token-tool.html) 小工具三步生成。

**③ 一键迁移历史标记**

点扩展图标 → **「历史标记迁移」→ 开始迁移**。接下来是全自动的：

- 扩展自动打开你的豆瓣标记页，按**看过 → 想看 → 在看**的顺序分页抓取（约每页 3 秒，防风控）；
- 逐条同步到 NeoDB：状态、星级（豆瓣 5 星制自动换算 10 分制）、短评、**原标记日期**；
- 进度条实时显示（新增 / 已一致 / 无法收录 / 失败），可随时**暂停**、再点**继续**从断点接着跑；
- **幂等**：已同步且未变化的条目自动跳过，中断了重跑、浏览器关了重开，都不会产生重复标记；
- 豆瓣触发风控或登录过期时自动暂停并提示，稍后点「继续」即可。

上千条标记预计 1~2 小时，期间保持豆瓣标签页打开就行。

**④ 完事，日常无感同步**

迁移完成后什么都不用做：之后在豆瓣的每一次**标记、打分、写短评**都会自动实时同步到 NeoDB，
页面右下角弹出同步结果提示；扩展弹窗里还能查看最近 20 条同步记录、临时关闭自动同步。
数据也始终是你自己的——弹窗里点一下「数据导出」，全部标记随时可存为 CSV / Markdown / JSON 本地文件。

## 获取 NeoDB 访问令牌

- **网页小工具**：仓库自带 [`docs/token-tool.html`](docs/token-tool.html)，双击本地打开（或访问在线版），三步拿到令牌；
- **开发者控制台**：登录 NeoDB → [neodb.social/developer](https://neodb.social/developer/) → Dev Console → Authorize。

## 桌面工具（可选的备用方案）

扩展之外的 Python 脚本是同一功能的命令行实现，适合不想装扩展、或想在不打开浏览器的情况下批量处理的人：

1. `pip install requests`，复制 `config.example.ini` 为 `config.ini`，填入豆瓣 user_id、豆瓣 Cookie、NeoDB 令牌；
2. `python gui.py` 打开图形界面（或双击 `启动同步界面.bat`），或直接命令行：

   ```bash
   python sync_douban_to_neodb.py check            # 验证凭据
   python sync_douban_to_neodb.py sync --dry-run   # 预览，不写入
   python sync_douban_to_neodb.py sync             # 全量增量同步
   ```

![桌面工具图形界面](docs/screenshot.png)

同步是增量的：未变化自动跳过、可中断续传；抓取结果缓存于 `marks_cache.json`（6 小时内有效）。
常见问题：豆瓣提示异常请求 = 触发风控，等几小时并调大 `config.ini` 的 `delay`；
NeoDB 401 = 令牌失效，重新生成；个别条目收录失败 = 豆瓣已下架，`sync --full` 可补齐。
扩展的详细说明见 [`extension/README.md`](extension/README.md)。

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
