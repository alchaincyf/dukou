#!/usr/bin/env node
// 渡口桥 · CLI：终端agent用这个和渡口插件打交道（需先启动 bridge/server.js，Chrome开着）
//
// 用法：
//   node dukou.js send <文章.md> [--dest x|bili|none] [--autofill] [--cover 图片] [--title "标题"]
//       md入插件文章库。--dest 自动打开目标平台页；--autofill 到编辑页后自动填入
//       md规则：首个"# 标题"作为文章标题；图片用 ![](相对路径) 且独占一行；支持 **粗** *斜* `code` [链接](url)
//       可选frontmatter：title / author / cover（路径相对md所在目录）
//   node dukou.js fetch <微信文章链接> [--save-to 目录]
//       让插件抓取微信文章，结果写成 <目录>/<标题>/<标题>.md + images/
//   node dukou.js export [--id 文章id] [--save-to 目录]
//       导出插件文章库里的文章（缺省最新一篇）为 md + 图片
//   node dukou.js ping
//
// 时效说明：插件每30秒轮询一次桥（用户点开插件图标会立即同步），命令会等到任务完成才返回

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BRIDGE = 'http://127.0.0.1:' + (process.env.DUKOU_PORT || 8787);
const SERVER_LOG = '/tmp/dukou-bridge.log';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const [cmd, ...rest] = process.argv.slice(2);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));
const flagOf = (k, dflt) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : dflt; };
const hasFlag = (k) => rest.includes(k);

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });

async function main() {
  if (!['send', 'fetch', 'export', 'ping'].includes(cmd)) {
    console.log('用法见文件头注释：send / fetch / export / ping');
    process.exit(cmd ? 1 : 0);
  }
  await ensureServer(); // 桥没在跑就自动后台拉起，用户永远不需要手动起服务

  if (cmd === 'ping') {
    const r = await api('GET', '/ping');
    console.log(`✓ 渡口桥在线（待取任务 ${r.queued} 个）`);
    return;
  }
  if (cmd === 'send') return send();
  if (cmd === 'fetch') return fetchArticle();
  if (cmd === 'export') return exportArticle();
}

// 桥服务自动管理：探活→不在就detached拉起server.js→等就绪（日志在 /tmp/dukou-bridge.log）
async function ensureServer() {
  try { await api('GET', '/ping'); return; } catch (e) { /* 没在跑，拉起 */ }
  const logFd = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await api('GET', '/ping'); console.log('（渡口桥已自动启动）'); return; } catch (e) { /* 再等 */ }
  }
  throw new Error(`渡口桥自动启动失败，看日志：${SERVER_LOG}`);
}

// ---------- send：md → 插件文章库 ----------

async function send() {
  const mdPath = positional[0];
  if (!mdPath) throw new Error('用法：node dukou.js send <文章.md> [--dest x|bili|none] [--autofill]');
  const raw = fs.readFileSync(path.resolve(mdPath), 'utf8');
  const baseDir = path.dirname(path.resolve(mdPath));

  const { meta, body } = parseFrontmatter(raw);
  const parsed = mdToBlocks(body, baseDir);
  const title = flagOf('--title') || meta.title || parsed.title;
  if (!title) throw new Error('没有标题：md里加一行"# 标题"，或用 --title 指定');

  const coverPath = flagOf('--cover') || meta.cover;
  const coverDataUrl = coverPath ? fileToDataUrl(path.resolve(baseDir, coverPath)) : '';

  const dest = flagOf('--dest', 'none');
  if (!['x', 'bili', 'none'].includes(dest)) throw new Error('--dest 只能是 x / bili / none');
  const autoFill = hasFlag('--autofill');
  if (autoFill && dest === 'none') throw new Error('--autofill 需要配合 --dest x 或 --dest bili');

  const article = {
    id: 'br_' + hash(title),
    title,
    author: meta.author || 'Claude Code',
    coverDataUrl,
    blocks: parsed.blocks,
  };
  const imgCount = parsed.blocks.filter((b) => b.type === 'image').length;
  console.log(`《${title}》：${parsed.blocks.length - imgCount}个段落 + ${imgCount}张图${coverDataUrl ? ' + 头图' : ''}`);

  const { taskId } = await api('POST', '/tasks', { type: 'import', article, dest, autoFill });
  console.log(`已入队（${taskId}），等插件来取（≤30秒，点开插件图标立即同步）…`);
  await waitDone(taskId, parseInt(flagOf('--wait', '90')));
  console.log('✓ 已入插件文章库' + (dest !== 'none'
    ? `，已打开${dest === 'x' ? ' X Articles' : 'B站专栏'}${autoFill ? '，将自动填入' + (dest === 'x' ? '（X需手动点Write新建草稿）' : '') : '，请点右下角面板「填入这篇」'}`
    : ''));
}

// ---------- fetch / export：插件 → 项目目录 ----------

async function fetchArticle() {
  const url = positional[0];
  if (!url || !/^https?:\/\/mp\.weixin\.qq\.com\/s/.test(url)) {
    throw new Error('用法：node dukou.js fetch <微信文章链接(mp.weixin.qq.com/s…)> [--save-to 目录]');
  }
  const { taskId } = await api('POST', '/tasks', { type: 'fetch', url, saveTo: saveTo() });
  console.log(`已入队（${taskId}），插件将打开文章页抓取（含图片下载，约1-2分钟）…`);
  const r = await waitDone(taskId, parseInt(flagOf('--wait', '240')));
  console.log(`✓ 已保存：${r.path}`);
}

async function exportArticle() {
  const { taskId } = await api('POST', '/tasks', { type: 'export', articleId: flagOf('--id'), saveTo: saveTo() });
  console.log(`已入队（${taskId}），等插件来取（≤30秒）…`);
  const r = await waitDone(taskId, parseInt(flagOf('--wait', '90')));
  console.log(`✓ 已保存：${r.path}`);
}

function saveTo() {
  return path.resolve(flagOf('--save-to', path.join(process.cwd(), '渡口导出')));
}

// ---------- md解析 ----------

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(m[0].length) };
}

// md → 简化HTML块（与插件 wechat-extract 同一词汇表：p/h2/blockquote/pre/ul/ol + b/i/code/a/br）
function mdToBlocks(md, baseDir) {
  const blocks = [];
  let title = '';
  const lines = md.split(/\r?\n/);
  let i = 0;

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: 'html', html: `<p>${para.map(inlineToHtml).join('<br>')}</p>` });
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); i++; continue; }

    if (line.startsWith('```')) { // 代码围栏
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      if (code.join('').trim()) blocks.push({ type: 'html', html: `<pre>${escapeHtml(code.join('\n'))}</pre>` });
      continue;
    }

    const img = line.match(/^!\[[^\]]*\]\(([^)]+)\)\s*$/); // 独占一行的图片
    if (img) {
      flushPara();
      const p = path.resolve(baseDir, decodeURIComponent(img[1]));
      if (fs.existsSync(p)) blocks.push({ type: 'image', dataUrl: fileToDataUrl(p) });
      else console.warn(`⚠ 图片不存在，跳过：${img[1]}`);
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      if (h[1] === '#' && !title) title = h[2].trim(); // 首个H1作为文章标题，不进正文
      else blocks.push({ type: 'html', html: `<h2>${inlineToHtml(h[2])}</h2>` });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'html', html: `<blockquote>${quote.map(inlineToHtml).join('<br>')}</blockquote>` });
      continue;
    }

    const isUl = (l) => /^[-*]\s+/.test(l);
    const isOl = (l) => /^\d+\.\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      flushPara();
      const tag = isUl(line) ? 'ul' : 'ol';
      const test = isUl(line) ? isUl : isOl;
      const items = [];
      while (i < lines.length && test(lines[i])) {
        items.push(lines[i++].replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
      }
      blocks.push({ type: 'html', html: `<${tag}>${items.map((t) => `<li>${inlineToHtml(t)}</li>`).join('')}</${tag}>` });
      continue;
    }

    if (/^(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); i++; continue; } // 分割线：X会忽略，丢弃

    para.push(line);
    i++;
  }
  flushPara();
  return { title, blocks };
}

function inlineToHtml(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 工具 ----------

function fileToDataUrl(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片格式 .${ext}（支持 jpg/png/gif/webp）：${p}`);
  return `data:${mime};base64,` + fs.readFileSync(p).toString('base64');
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function waitDone(taskId, timeoutSec) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await api('GET', '/result?id=' + taskId);
    if (r.state === 'done') return r;
    if (r.state === 'error') throw new Error('插件侧失败：' + r.error);
  }
  throw new Error(`等待超时（${timeoutSec}秒）。检查：Chrome是否开着？渡口插件是否已加载？`);
}

function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BRIDGE + route, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) reject(new Error(obj.error || 'HTTP ' + res.statusCode));
          else resolve(obj);
        } catch (e) { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', () => reject(new Error(`连不上渡口桥（${BRIDGE}）。先启动：node bridge/server.js`)));
    if (data) req.write(data);
    req.end();
  });
}
