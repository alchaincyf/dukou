---
name: dukou
description: 渡口——终端AI agent与渡口Chrome插件的稿件互通。能力：(1)把md文章（含图片）渡到 X Articles / B站专栏，自动打开编辑页并填充图文；(2)让插件抓取微信公众号文章（带登录态、防盗链图片可下载），落盘为本地md+图片；(3)导出插件文章库任意一篇为md+图片。
  当用户提到「渡到X」「发到X Articles」「发B站专栏」「填入X/B站」「公众号文章转md」「抓微信文章」「渡口」时使用。
  即使用户只说「把这篇发到X」「这篇也发B站」「抓一下这篇公众号」「这篇文章存下来」也应触发。
  需要配合渡口Chrome插件（https://github.com/alchaincyf/dukou），未安装时按「引导安装」提示用户。
---

# 渡口 · 稿件分发

Chrome插件负责浏览器侧（抓取、填充、文章库），本skill负责终端侧（md进出、任务下发）。两侧通过本地桥（127.0.0.1:8787）互通。

**核心原则：所有命令由你执行，用户零终端操作。** 桥服务由CLI自动拉起（探活失败就后台启动，日志 `/tmp/dukou-bridge.log`），永远不要让用户手动跑任何命令。用户只需要：Chrome开着、渡口插件加载着。

## 命令

CLI在本skill目录的 `scripts/dukou.js`（自包含零依赖，下文以 `~/.claude/skills/dukou` 为例，按实际安装路径调整）：

```bash
# 投稿：md → 插件文章库 → 自动打开平台编辑页并填充
node ~/.claude/skills/dukou/scripts/dukou.js send 文章.md --dest x --autofill
node ~/.claude/skills/dukou/scripts/dukou.js send 文章.md --dest bili --autofill
node ~/.claude/skills/dukou/scripts/dukou.js send 文章.md              # 只入库

# 取稿：微信公众号文章 → 本地 <目录>/<标题>/<标题>.md + images/
node ~/.claude/skills/dukou/scripts/dukou.js fetch "https://mp.weixin.qq.com/s/xxx" --save-to ./素材

# 导出插件文章库（缺省最新一篇）
node ~/.claude/skills/dukou/scripts/dukou.js export --save-to ./素材

node ~/.claude/skills/dukou/scripts/dukou.js ping   # 探活（顺带自动启动桥）
```

时效：插件每30秒轮询桥，CLI阻塞到任务完成（`--wait 秒数`可调，import默认90/fetch默认240）。告诉用户点一下Chrome工具栏的渡口图标可立即同步。

## send 的 md 约定

- 首个 `# 一级标题` 作为文章标题（不进正文）；其余各级标题都渡成H2
- 图片 `![](相对路径)` 必须独占一行；支持 jpg/png/gif/webp；路径相对md所在目录
- 行内支持 `**粗**` `*斜*` `` `code` `` `[链接](url)`；分割线会被丢弃（X不支持）
- 可选frontmatter：`title:` `author:` `cover:`（头图路径）
- X单图约5MB限制：插件填充时自动压缩超限图（先降质量后缩尺寸），无需预处理

## 平台差异

- `--dest x --autofill`：自动打开 X Articles，**用户需点一下 Write 新建草稿**，之后自动填入标题/正文/图片/头图（头图弹裁剪框需用户点Apply确认）
- `--dest bili --autofill`：自动打开B站专栏编辑页，全自动填入
- 填充完成后发布动作永远留给用户，不要尝试代替用户发布

## 排错与引导安装

1. CLI报「连不上渡口桥/自动启动失败」→ 看 `/tmp/dukou-bridge.log`
2. ping通但任务等待超时（插件一直没来取）→ 依次确认：
   - Chrome是否开着？
   - 渡口插件是否已安装加载？**未安装时引导用户**：clone https://github.com/alchaincyf/dukou ，打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选仓库里的 `extension/` 目录。装好后队列里的任务会被自动取走，无需重发
   - 让用户点一下渡口插件图标（立即同步）
3. 改过 `extension/` 代码后必须让用户重载插件并刷新目标页；旧页面点「填入」会提示刷新
