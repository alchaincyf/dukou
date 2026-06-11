#!/usr/bin/env node
// 渡口桥 · 本地服务：终端agent（Claude Code/Codex）和渡口插件之间的中转站
// 零依赖，只监听 127.0.0.1。职责：任务队列 + 把插件回传的文章写成 md+图片
//
// 启动：node bridge/server.js [--port 8787] [--dir <默认导出目录>]
//
// 协议（插件每30秒轮询，点开插件图标立即同步）：
//   agent侧   POST /tasks    入队任务，返回 {taskId}
//             GET  /result?id=<taskId>  查任务状态
//   插件侧    GET  /tasks    取走全部待办任务
//             POST /results  回传结果（导出任务带article，由本服务落盘）
//
// 任务类型：
//   import  {type, article:{id,title,author,coverDataUrl,blocks}, dest:'x'|'bili'|'none', autoFill}
//   export  {type, articleId?, saveTo}     文章库某篇（缺省最新）→ 磁盘 md+图片
//   fetch   {type, url, saveTo}            微信链接 → 抓取入库 → 磁盘 md+图片

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (k, dflt) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : dflt; };
const PORT = parseInt(argOf('--port', '8787'));
const DEFAULT_DIR = path.resolve(argOf('--dir', path.join(process.cwd(), '渡口导出')));

let seq = 0;
const queue = [];       // 待插件取走的任务
const results = {};     // taskId → {state:'queued'|'pending'|'done'|'error', ...}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (req.method === 'GET' && url.pathname === '/ping') {
      return json(res, { ok: true, name: 'dukou-bridge', queued: queue.length });
    }

    if (req.method === 'POST' && url.pathname === '/tasks') {
      const task = await readJson(req);
      if (!['import', 'export', 'fetch'].includes(task.type)) {
        return json(res, { error: '未知任务类型：' + task.type }, 400);
      }
      if (task.type !== 'import') {
        task.saveTo = path.resolve(task.saveTo || DEFAULT_DIR);
      }
      task.taskId = 't' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
      queue.push(task);
      results[task.taskId] = { state: 'queued' };
      log(`收到任务 ${task.taskId}（${task.type}${task.dest ? ' → ' + task.dest : ''}）`);
      return json(res, { taskId: task.taskId });
    }

    if (req.method === 'GET' && url.pathname === '/tasks') {
      const tasks = queue.splice(0, queue.length);
      if (tasks.length) {
        tasks.forEach((t) => { results[t.taskId].state = 'pending'; });
        log(`插件取走 ${tasks.length} 个任务`);
      }
      return json(res, { tasks });
    }

    if (req.method === 'POST' && url.pathname === '/results') {
      const r = await readJson(req);
      const entry = results[r.taskId] || (results[r.taskId] = {});
      if (!r.ok) {
        entry.state = 'error';
        entry.error = r.error || '插件侧失败';
        log(`任务 ${r.taskId} 失败：${entry.error}`);
      } else if (r.article) {
        try {
          entry.path = writeArticle(r.article, r.saveTo || DEFAULT_DIR);
          entry.state = 'done';
          log(`任务 ${r.taskId} 完成：已写入 ${entry.path}`);
        } catch (e) {
          entry.state = 'error';
          entry.error = '落盘失败：' + e.message;
          log(`任务 ${r.taskId} ${entry.error}`);
        }
      } else {
        entry.state = 'done';
        entry.note = r.note || '';
        log(`任务 ${r.taskId} 完成${entry.note ? '：' + entry.note : ''}`);
      }
      return json(res, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/result') {
      return json(res, results[url.searchParams.get('id')] || { state: 'unknown' });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用——大概率已有一个渡口桥在运行（curl http://127.0.0.1:${PORT}/ping 可确认）`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  log(`渡口桥已启动 http://127.0.0.1:${PORT} · 默认导出目录 ${DEFAULT_DIR}`);
  log('保持 Chrome 开着即可，插件每 30 秒来同步一次（点开插件图标立即同步）');
});

// ---------- 文章 → 磁盘（md + images/） ----------

function writeArticle(article, saveTo) {
  const name = safeName(article.title);
  const dir = path.join(path.resolve(saveTo), name);
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  let md = `# ${article.title}\n\n`;
  md += `> 来源：${article.author || '渡口'} · ${new Date(article.extractedAt || Date.now()).toLocaleString('zh-CN')}`;
  md += article.sourceUrl && article.sourceUrl.startsWith('http') ? `\n> ${article.sourceUrl}\n\n` : '\n\n';

  if (article.coverDataUrl) {
    const ext = extOf(article.coverDataUrl);
    fs.writeFileSync(path.join(imgDir, `cover.${ext}`), b64Of(article.coverDataUrl), 'base64');
    md += `![cover](images/cover.${ext})\n\n`;
  }

  let imgN = 0;
  for (const b of article.blocks || []) {
    if (b.type === 'image') {
      imgN++;
      const ext = extOf(b.dataUrl);
      fs.writeFileSync(path.join(imgDir, `img_${imgN}.${ext}`), b64Of(b.dataUrl), 'base64');
      md += `![img_${imgN}](images/img_${imgN}.${ext})\n\n`;
    } else {
      md += htmlBlockToMd(b.html) + '\n\n';
    }
  }
  fs.writeFileSync(path.join(dir, `${name}.md`), md);
  return dir;
}

// ---------- 简化HTML块 → md ----------
// 词汇表受控（见wechat-extract.js）：块级 p/h2/blockquote/pre/ul/ol，行内 b/i/code/a/br，实体已转义

function htmlBlockToMd(html) {
  const m = (html || '').match(/^<(h2|blockquote|pre|ul|ol|p)>([\s\S]*)<\/\1>$/i);
  if (!m) return inlineToMd(html || '');
  const tag = m[1].toLowerCase();
  const inner = m[2];
  if (tag === 'h2') return '## ' + inlineToMd(inner);
  if (tag === 'pre') return '```\n' + unescapeHtml(inner) + '\n```';
  if (tag === 'blockquote') return inlineToMd(inner).split('\n').map((l) => '> ' + l).join('\n');
  if (tag === 'ul' || tag === 'ol') {
    return [...inner.matchAll(/<li>([\s\S]*?)<\/li>/gi)]
      .map((x, i) => (tag === 'ul' ? '- ' : `${i + 1}. `) + inlineToMd(x[1]))
      .join('\n');
  }
  return inlineToMd(inner);
}

function inlineToMd(s) {
  return unescapeHtml(
    s.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*')
      .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// ---------- 工具 ----------

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 300 * 1024 * 1024) { reject(new Error('请求体超过300MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON解析失败')); }
    });
    req.on('error', reject);
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function safeName(s) {
  return (s || 'article').replace(/[\\/:*?"<>|#%{}~]/g, '').trim().slice(0, 40) || 'article';
}

function extOf(dataUrl) {
  const mime = (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
  return (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
}

function b64Of(dataUrl) {
  return String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`);
}
