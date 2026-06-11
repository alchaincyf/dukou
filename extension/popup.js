const urlInput = document.getElementById('url');
const statusEl = document.getElementById('status');
const libraryEl = document.getElementById('library');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

// ---------- 抓取 ----------

function start(dest) {
  let url = urlInput.value.trim();
  if (!url) { setStatus('请先粘贴链接', true); return; }
  url = url.replace(/^http:\/\//, 'https://');

  // 飞书文档链接 → 走API读取
  if (/feishu\.cn|larksuite\.com/.test(url) && /\/(docx|wiki)\//.test(url)) {
    setStatus('正在读取飞书文档…');
    chrome.runtime.sendMessage({ cmd: 'feishu_read', url, dest }, () => {
      if (chrome.runtime.lastError) setStatus('启动失败：' + chrome.runtime.lastError.message, true);
    });
    return;
  }

  if (!/^https:\/\/mp\.weixin\.qq\.com\/s/.test(url)) {
    setStatus('不支持的链接。支持：微信文章 (mp.weixin.qq.com/s) 或 飞书文档 (/docx/ 或 /wiki/)', true);
    return;
  }
  setStatus('正在打开文章页抓取…');
  chrome.runtime.sendMessage({ cmd: 'start', url, dest }, () => {
    if (chrome.runtime.lastError) setStatus('启动失败：' + chrome.runtime.lastError.message, true);
  });
}

document.getElementById('go-x').addEventListener('click', () => start('x'));
document.getElementById('go-bili').addEventListener('click', () => start('bili'));
document.getElementById('go-save').addEventListener('click', () => start('none'));

// 状态展示与同步
chrome.storage.local.get('wx_status', (d) => {
  if (d.wx_status) setStatus(d.wx_status.text, d.wx_status.error);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.wx_status?.newValue) setStatus(changes.wx_status.newValue.text, changes.wx_status.newValue.error);
  if (changes.wx_index) renderLibrary();
});

// ---------- 文章库 ----------

function opButton(iconId, title, onClick) {
  const btn = document.createElement('button');
  btn.title = title;
  btn.innerHTML = `<svg width="15" height="15"><use href="#${iconId}"/></svg>`;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

async function renderLibrary() {
  const { wx_index = [], wx_current } = await chrome.storage.local.get(['wx_index', 'wx_current']);
  const countEl = document.getElementById('lib-count');
  countEl.textContent = wx_index.length ? `共${wx_index.length}篇` : '';
  if (wx_index.length === 0) {
    libraryEl.innerHTML = '<div class="empty">还没有渡过稿件</div>';
    return;
  }
  libraryEl.innerHTML = '';
  for (const e of wx_index) {
    const d = new Date(e.extractedAt);
    const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const item = document.createElement('div');
    item.className = 'lib-item';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'title';
    titleDiv.textContent = e.title;
    titleDiv.title = e.title;
    if (e.id === wx_current) {
      const badge = document.createElement('span');
      badge.className = 'latest';
      badge.textContent = '最新';
      titleDiv.appendChild(badge);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${dateStr} · ${e.blockCount}块 · ${e.imgCount}图${e.author ? ' · ' + e.author : ''}`;

    const ops = document.createElement('div');
    ops.className = 'lib-ops';
    ops.appendChild(opButton('i-zip', '下载zip（md+图片）', (btn) => downloadArticle(e.id, btn)));
    ops.appendChild(opButton('i-feishu', '写入飞书文档', (btn) => writeToFeishu(e.id, btn)));
    ops.appendChild(opButton('i-del', '从文库删除', () => deleteArticle(e.id)));

    metaRow.appendChild(meta);
    metaRow.appendChild(ops);
    item.appendChild(titleDiv);
    item.appendChild(metaRow);
    libraryEl.appendChild(item);
  }
}

async function deleteArticle(id) {
  const { wx_index = [], wx_current } = await chrome.storage.local.get(['wx_index', 'wx_current']);
  const newIndex = wx_index.filter((e) => e.id !== id);
  const updates = { wx_index: newIndex };
  if (wx_current === id) updates.wx_current = newIndex[0]?.id || '';
  await chrome.storage.local.set(updates);
  await chrome.storage.local.remove('art_' + id);
  renderLibrary();
}

// ---------- 下载为 MD + 图片 ----------

async function downloadArticle(id, btn) {
  btn.disabled = true;
  try {
    const data = await chrome.storage.local.get('art_' + id);
    const article = data['art_' + id];
    if (!article) { setStatus('文章数据缺失', true); return; }

    // 打包成单个zip（逐文件下载会让Chrome弹一连串确认框）
    const name = safeName(article.title);
    const zip = new JSZip();
    const root = zip.folder(name);
    const imgFolder = root.folder('images');
    let imgTotal = 0;

    // 头图
    let coverRef = '';
    if (article.coverDataUrl) {
      const ext = extOf(article.coverDataUrl);
      imgFolder.file(`cover.${ext}`, article.coverDataUrl.split(',')[1], { base64: true });
      coverRef = `![cover](images/cover.${ext})\n\n`;
      imgTotal++;
    }

    // 正文：html块转md，图片存zip并以相对路径引用
    let md = `# ${article.title}\n\n`;
    md += `> 来源：${article.author || '微信公众号'} · 抓取于 ${new Date(article.extractedAt).toLocaleString('zh-CN')}\n\n`;
    md += coverRef;
    let imgN = 0;
    for (const b of article.blocks) {
      if (b.type === 'image') {
        imgN++;
        const ext = extOf(b.dataUrl);
        imgFolder.file(`img_${imgN}.${ext}`, b.dataUrl.split(',')[1], { base64: true });
        md += `![img_${imgN}](images/img_${imgN}.${ext})\n\n`;
        imgTotal++;
      } else {
        md += htmlBlockToMd(b.html) + '\n\n';
      }
    }
    root.file(`${name}.md`, md);

    setStatus('正在打包zip…');
    const b64 = await zip.generateAsync({ type: 'base64' });
    await download('data:application/zip;base64,' + b64, `微信文章库/${name}.zip`);
    setStatus(`已下载 下载/微信文章库/${name}.zip（md + ${imgTotal} 张图）`);
  } catch (e) {
    setStatus('下载失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function download(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite' }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

// 单个简化HTML块 → markdown（块都是单根元素：p/h2/blockquote/ul/ol/pre）
function htmlBlockToMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild;
  if (!el) return doc.body.textContent.trim();
  const tag = el.tagName;
  if (tag === 'H2') return '## ' + inlineMd(el);
  if (tag === 'BLOCKQUOTE') return inlineMd(el).split('\n').map((l) => '> ' + l).join('\n');
  if (tag === 'PRE') return '```\n' + el.textContent + '\n```';
  if (tag === 'UL') return [...el.children].map((li) => '- ' + inlineMd(li)).join('\n');
  if (tag === 'OL') return [...el.children].map((li, i) => `${i + 1}. ` + inlineMd(li)).join('\n');
  return inlineMd(el); // p等
}

function inlineMd(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out += child.textContent; continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    const inner = inlineMd(child);
    if (tag === 'B' || tag === 'STRONG') out += `**${inner}**`;
    else if (tag === 'I' || tag === 'EM') out += `*${inner}*`;
    else if (tag === 'CODE') out += '`' + inner + '`';
    else if (tag === 'A') out += `[${inner}](${child.getAttribute('href') || ''})`;
    else if (tag === 'BR') out += '\n';
    else out += inner;
  }
  return out;
}

// ---------- 写入飞书 ----------

// SW里没有DOMParser，block转换在popup里做好再发给background
async function writeToFeishu(id, btn) {
  btn.disabled = true;
  try {
    const data = await chrome.storage.local.get('art_' + id);
    const article = data['art_' + id];
    if (!article) { setStatus('文章数据缺失', true); return; }
    const blocksSpec = articleToFeishuSpec(article);
    setStatus('开始写入飞书（进度看这里）…');
    chrome.runtime.sendMessage({ cmd: 'feishu_write', id, blocksSpec }, () => {
      if (chrome.runtime.lastError) setStatus('启动失败：' + chrome.runtime.lastError.message, true);
    });
  } finally {
    btn.disabled = false;
  }
}

function articleToFeishuSpec(article) {
  const spec = [];
  for (const b of article.blocks) {
    if (b.type === 'image') { spec.push({ __image: true }); continue; }
    const doc = new DOMParser().parseFromString(b.html, 'text/html');
    const el = doc.body.firstElementChild;
    if (!el) continue;
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      const bt = tag === 'UL' ? 12 : 13;
      const field = tag === 'UL' ? 'bullet' : 'ordered';
      for (const li of el.children) {
        spec.push({ block_type: bt, [field]: { elements: elementsOf(li) } });
      }
    } else if (tag === 'PRE') {
      spec.push({
        block_type: 14,
        code: { elements: [{ text_run: { content: el.textContent } }], style: { language: 1 } },
      });
    } else if (tag === 'BLOCKQUOTE') {
      spec.push({ block_type: 15, quote: { elements: elementsOf(el) } });
    } else if (/^H[1-6]$/.test(tag)) {
      spec.push({ block_type: 4, heading2: { elements: elementsOf(el) } });
    } else {
      spec.push({ block_type: 2, text: { elements: elementsOf(el) } });
    }
  }
  return spec;
}

// 块级入口：保证elements非空（飞书不接受空elements的块）
function elementsOf(el) {
  const els = inlineToElements(el);
  if (els.length === 0) els.push({ text_run: { content: ' ', text_element_style: {} } });
  return els;
}

// 简化HTML的行内内容 → 飞书text_run数组（bold/italic/inline_code/link）
function inlineToElements(node, style = {}) {
  const els = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) {
        els.push({ text_run: { content: child.textContent, text_element_style: { ...style } } });
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (tag === 'BR') {
      els.push({ text_run: { content: '\n', text_element_style: { ...style } } });
      continue;
    }
    const newStyle = { ...style };
    if (tag === 'B' || tag === 'STRONG') newStyle.bold = true;
    if (tag === 'I' || tag === 'EM') newStyle.italic = true;
    if (tag === 'CODE') newStyle.inline_code = true;
    // 飞书要求link.url是百分号编码
    if (tag === 'A') newStyle.link = { url: encodeURIComponent(child.getAttribute('href') || '') };
    els.push(...inlineToElements(child, newStyle));
  }
  return els;
}

// ---------- 飞书配置 ----------

const fsAppId = document.getElementById('fs-appid');
const fsSecret = document.getElementById('fs-secret');
const fsOpenId = document.getElementById('fs-openid');

chrome.storage.local.get('wx_feishu_cfg', ({ wx_feishu_cfg }) => {
  if (wx_feishu_cfg) {
    fsAppId.value = wx_feishu_cfg.app_id || '';
    fsSecret.value = wx_feishu_cfg.app_secret || '';
    fsOpenId.value = wx_feishu_cfg.open_id || '';
  }
});

document.getElementById('fs-save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    wx_feishu_cfg: {
      app_id: fsAppId.value.trim(),
      app_secret: fsSecret.value.trim(),
      open_id: fsOpenId.value.trim(),
    },
  });
  setStatus('飞书配置已保存');
});

function safeName(s) {
  return s.replace(/[\\/:*?"<>|#%{}~]/g, '').trim().slice(0, 40) || 'article';
}

function extOf(dataUrl) {
  const mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
  return (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
}

function b64Unicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

renderLibrary();

// 打开popup就同步一次渡口桥任务（平时background每30秒轮询）
chrome.runtime.sendMessage({ cmd: 'bridge_poll' }, () => chrome.runtime.lastError);
