# 微信文章搬运插件（X / B站 / 飞书）

- **状态**：v3.1.0，X/B站流程已实测跑通；渡口桥（终端agent互通）插件侧待真实测试
- **类型**：Chrome插件（Manifest V3）+ 本地桥服务（`bridge/`，零依赖Node）
- **一句话**：抓取微信公众号文章（或飞书文档）入库，一键填入X Articles、B站专栏、飞书文档，支持下载为Markdown+图片；Claude Code等终端agent可通过渡口桥直接投稿/取稿。

## 安装

### 装Chrome插件

1. Chrome打开 `chrome://extensions/` → 开发者模式 → 「加载已解压的扩展程序」→ **选 `extension/` 子文件夹**
2. （可选）飞书功能：popup底部「⚙️ 飞书配置」填入自建应用的 app_id / app_secret / 你的open_id
   - 应用需要的权限scope：`docx:document`（读写文档）、`drive:drive`（上传下载素材）、`docs:permission.member:create`（给你自己加权限）

### 给AI终端装skill

把 `skill/dukou/` 拷到 Claude Code 的技能目录（其他终端agent直接告诉它读 `skill/dukou/SKILL.md`）：

```bash
cp -r skill/dukou ~/.claude/skills/
```

装好后对Claude Code说「把这篇md渡到X」「抓一下这篇公众号文章」即可，所有命令由AI执行，人不碰终端。

> 插件和skill装一个也能用，装齐才是完全体：只装插件 = 手动粘链接、点填入；配上skill = AI直接投稿/取稿。插件popup底部和skill的排错指引会互相提醒对方的安装方法。

## 功能总览

```
来源                    文章库                      去向
─────────              ──────────                 ─────────
微信文章链接   ──抓取──▶  popup里的列表    ──填入──▶  X Articles（含头图）
飞书docx/wiki链接 ──▶    （同一篇只留最新） ──填入──▶  B站专栏
                                          ──写入──▶  飞书文档（API直写）
                                          ──下载──▶  本地 md + images/
```

## 使用

**抓取**：popup粘贴链接（微信文章或飞书文档链接都行），点「抓取→X」「抓取→B站」「只入库」。抓完自动跳目标平台。

**填入X/B站**：到编辑页（X新建Article草稿 / B站专栏新建文章），点右下角浮动面板「填入」。面板的下拉框可选历史文章，默认最新一篇。10分钟内抓取过会自动展开面板，平时缩成小气泡。

**写入飞书**：popup文章列表里点「飞书」，自动建文档、写入全部图文、给你的open_id加编辑权限、打开文档。

**下载MD**：popup文章列表里点「⬇️ MD」，存到 `下载/微信文章库/<标题>/`：`<标题>.md` + `images/img_N.jpg`（md内相对路径引用）+ 头图cover。

**渡口桥（终端agent互通）**：命令全部由Claude Code等agent执行，人不需要碰终端。agent跑 `node skill/dukou/scripts/dukou.js`：`send 文章.md --dest x --autofill`（md入库+开页+自动填入）、`fetch <微信链接> --save-to 目录`（抓取落盘md+图）、`export`（导出文章库）。桥服务（127.0.0.1:8787）由CLI自动拉起，插件每30秒轮询（点开插件图标立即同步）。协议与md约定见 `skill/dukou/SKILL.md`。

## 文件结构

| 文件 | 职责 |
|------|------|
| `wechat-extract.js` | 微信文章页内容脚本：抓正文转简化HTML块+图片dataURL，按biz/mid/idx去重入库 |
| `fill-common.js` | 通用填充层：浮动面板（历史选择）+ 填充流程（全文一次粘贴+图片锚点倒序插入） |
| `x-adapter.js` | X适配器：Draft.js编辑器定位 + 封面file input填充 |
| `bili-adapter.js` | B站适配器：Quill编辑器（.rql-editor）+ 标题40字截断 |
| `feishu-api.js` | 飞书OpenAPI：建文档/批量写块/图片三步上传/权限；读文档blocks/下载图片 |
| `background.js` | 协调器：开微信页触发抓取、按目标跳转、飞书读写调度、渡口桥轮询 |
| `popup.*` | 入口UI：抓取、文章库管理、MD下载、飞书配置 |
| `skill/dukou/SKILL.md` | Claude Code skill：AI终端的使用说明书（协议、md约定、排错） |
| `skill/dukou/scripts/server.js` | 渡口桥本地服务：任务队列 + 插件回传文章落盘为md+图片 |
| `skill/dukou/scripts/dukou.js` | 渡口桥CLI：终端agent的入口（send/fetch/export/ping），自动拉起桥服务 |

## 核心技术点（踩坑记录）

1. **X编辑器（Draft.js）**：全部文字必须**一次性**粘贴（多个`<p>`一次paste才会分段；逐段粘贴全黏成一段=v1.0的坑）。图片**不能图文交替**粘贴——图片粘贴后光标落在caption框，会吞掉下一段文字（v1.1的坑）。正确做法：文字铺完后，图片按「原文中前一段落的文字」做锚点定位，**从下往上**逐张File粘贴。
2. **B站编辑器（Tiptap/ProseMirror）**：新版是`.tiptap.ProseMirror`正文（eva3-editor）+ `.title-input__inner`标题textarea（maxlength=50），且**编辑器可能嵌在iframe里**——内容脚本必须`all_frames:true`注入，配合adapter的`gate()`门控只在有编辑器的frame挂面板。旧版Quill（`.rql-editor`，来自rxliuli/bilibili-markdown，已clone在`reference-bilibili-markdown/`）作兜底保留。粘贴架构与X通用。
3. **微信抓取**：`#js_content`、`data-src`懒加载、`og:image`头图；图片在页面上下文fetch绕防盗链；微信外层section常带font-weight，样式加粗只认≤40字符短句，否则大面积误加粗。
4. **飞书图片**：三步流程——建空image block（block_type 27）→ `upload_all`（parent_type=docx_image, parent_node=block_id）→ `replace_image`。链接的url要percent编码。SW里没有DOMParser，HTML→飞书块的转换在popup做完再传。
5. `<hr>`分割线X粘贴会忽略；B站视频/音频/小程序卡片不搬。

## 已知限制

- X单图上传限制约5MB，超限的图等20秒超时后跳过（Console有警告）
- tempkey微信链接有时效，过期重新复制
- B站专栏标题上限40字，超长自动截断
- 飞书读取暂只支持文本类块和图片，表格/画板/附件等跳过
