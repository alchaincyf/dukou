// 通用填充层：浮动面板（含历史文章选择，默认最新）+ 填充流程
// 站点差异由先加载的适配器提供：
// window.WX2X = { siteName, hint, maxTitleLen?, findTitleField(), findBodyEditor(), fillCover?(article) }
// 填充架构：全文HTML一次性粘贴（逐段粘贴会黏成一个段落）；
// 图片随后按锚点从下往上以File粘贴（图文交替粘贴会被图片caption吞文字，v1.1的坑）

const ADAPTER = window.WX2X;
let panel = null;

init();

async function init() {
  // 站点门控：编辑器可能嵌在iframe里（如B站），只在能看到编辑器的frame里挂面板
  if (ADAPTER.gate) {
    const ok = await waitFor(() => ADAPTER.gate(), 12000);
    if (!ok) return;
  }
  await refreshPanel();
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.wx_index || changes.wx_current) refreshPanel();
  });
  maybeAutoFill();
}

// 渡口桥的autofill任务：background入库后放了wx_autofill标记并打开本页
// 标记等到编辑器真出现、即将动手填时才消费——X要用户先点Write，可能要等一会儿
async function maybeAutoFill() {
  if (!ADAPTER.key) return;
  const { wx_autofill } = await chrome.storage.local.get('wx_autofill');
  if (!wx_autofill || wx_autofill.dest !== ADAPTER.key) return;
  if (Date.now() - wx_autofill.at > 10 * 60 * 1000) {
    chrome.storage.local.remove('wx_autofill'); // 过期标记清掉不执行
    return;
  }
  const data = await chrome.storage.local.get('art_' + wx_autofill.id);
  const article = data['art_' + wx_autofill.id];
  if (!article) { chrome.storage.local.remove('wx_autofill'); return; }
  progress(`渡口桥：《${article.title}》待自动填入，等编辑器出现…${ADAPTER.key === 'x' ? '（请点 Write 新建草稿）' : ''}`);
  const ed = await waitFor(() => ADAPTER.findBodyEditor(), 10 * 60 * 1000);
  if (!ed) { progress('没等到编辑器，请手动点「填入这篇」'); return; }
  // 动手前再确认标记还在（可能已被别的tab执行掉），确认后消费
  const { wx_autofill: still } = await chrome.storage.local.get('wx_autofill');
  if (!still || still.at !== wx_autofill.at) return;
  await chrome.storage.local.remove('wx_autofill');
  fillArticle(article);
}

async function refreshPanel() {
  const { wx_index = [], wx_current } = await chrome.storage.local.get(['wx_index', 'wx_current']);
  if (wx_index.length === 0) { removePanel(); return; }
  showPanel(wx_index, wx_current);
}

// ---------- 浮动面板 ----------

// 「渡口」品牌图形：纸渡于舟上（白色，置于朱砂底）
const DK_MARK = `
  <rect x="25.5" y="10" width="13" height="18" rx="1" fill="#fff"/>
  <path d="M13 36 H51 L42.5 48.5 H21.5 Z" fill="#fff"/>
  <rect x="24" y="55" width="16" height="2.6" rx="1.3" fill="#fff" opacity=".75"/>`;

function dkMarkSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64">${DK_MARK}</svg>`;
}

function showPanel(index, currentId) {
  removePanel();
  panel = document.createElement('div');
  panel.id = 'wx2x-panel';

  // 最近10分钟内抓取过 → 自动展开，否则缩成小气泡不打扰
  const latest = index[0];
  const autoExpand = latest && Date.now() - latest.extractedAt < 10 * 60 * 1000;
  const userCollapsed = sessionStorage.getItem('wx2x-collapsed') === '1';

  let selectedId = index.some((e) => e.id === currentId) ? currentId : index[0].id;
  const metaOf = (e) => {
    const d = new Date(e.extractedAt);
    return `${d.getMonth() + 1}月${d.getDate()}日 · ${e.imgCount}图`;
  };
  const items = index.map((e) => `
    <div class="dk-item${e.id === selectedId ? ' sel' : ''}" data-id="${e.id}">
      <span class="t">${escapeText(e.title)}</span>
      <span class="m">${metaOf(e)}</span>
    </div>`).join('');

  panel.innerHTML = `
    <style>
      #wx2x-panel{position:fixed;right:20px;bottom:20px;z-index:999999;
        font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB',sans-serif;
        font-size:13px;color:#1F1D1A;-webkit-font-smoothing:antialiased;line-height:normal;}
      #wx2x-panel *{margin:0;padding:0;box-sizing:border-box;}
      #wx2x-bubble{display:none;width:44px;height:44px;border-radius:50%;background:#BF3B1F;
        box-shadow:0 6px 18px rgba(165,48,15,.32);cursor:pointer;align-items:center;justify-content:center;}
      #wx2x-card{width:300px;background:#FFFFFF;border:1px solid #E6E2D8;border-radius:8px;
        box-shadow:0 12px 32px rgba(31,29,26,.13);}
      .dk-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #EFECE4;}
      .dk-head .dk-l{display:flex;align-items:center;gap:8px;}
      .dk-head .dk-mark{width:18px;height:18px;border-radius:4px;background:#BF3B1F;line-height:0;}
      .dk-head .dk-name{font-family:'Songti SC','STSong','Noto Serif SC',serif;font-weight:700;font-size:13px;letter-spacing:3px;}
      #wx2x-collapse{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:4px;cursor:pointer;color:#6E695F;}
      #wx2x-collapse:hover{background:#EFECE4;}
      .dk-body{padding:14px;}
      #wx2x-picker{position:relative;}
      #wx2x-cur{width:100%;display:flex;align-items:center;gap:8px;border:1px solid #E6E2D8;border-radius:4px;
        background:#FAF9F6;padding:8px 10px;cursor:pointer;text-align:left;font-family:inherit;color:#1F1D1A;}
      #wx2x-cur:hover{border-color:#D8D2C4;}
      #wx2x-cur .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}
      #wx2x-cur .m{flex:none;font-size:11px;color:#6E695F;}
      #wx2x-cur .c{flex:none;line-height:0;color:#6E695F;}
      #wx2x-list{position:absolute;left:0;right:0;bottom:calc(100% + 6px);display:none;background:#FFFFFF;
        border:1px solid #E6E2D8;border-radius:6px;box-shadow:0 10px 28px rgba(31,29,26,.16);
        max-height:236px;overflow-y:auto;}
      .dk-item{padding:9px 12px;cursor:pointer;}
      .dk-item + .dk-item{border-top:1px solid #F4F1EA;}
      .dk-item:hover{background:#FAF9F6;}
      .dk-item .t{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .dk-item .m{display:block;font-size:11px;color:#6E695F;margin-top:3px;}
      .dk-item.sel{box-shadow:inset 2px 0 0 #BF3B1F;}
      .dk-item.sel .t{color:#BF3B1F;font-weight:600;}
      #wx2x-fill{margin-top:12px;width:100%;background:#BF3B1F;color:#fff;border:none;border-radius:4px;
        padding:11px 0;font-size:14px;letter-spacing:4px;cursor:pointer;
        font-family:'Songti SC','STSong','Noto Serif SC',serif;font-weight:600;}
      #wx2x-fill:hover{background:#A5300F;}
      #wx2x-fill:disabled{opacity:.55;cursor:default;}
      #wx2x-prog{margin-top:12px;display:none;}
      #wx2x-prog .dk-bar{height:3px;background:#EFECE4;border-radius:2px;overflow:hidden;}
      #wx2x-prog .dk-bar i{display:block;height:100%;width:0;background:#BF3B1F;transition:width .3s;}
      #wx2x-progress{margin-top:7px;font-size:11px;line-height:1.6;color:#6E695F;white-space:pre-wrap;word-break:break-all;}
    </style>
    <div id="wx2x-bubble" title="渡口">${dkMarkSvg(24)}</div>
    <div id="wx2x-card">
      <div class="dk-head">
        <div class="dk-l">
          <span class="dk-mark">${dkMarkSvg(18)}</span>
          <span class="dk-name">渡口</span>
        </div>
        <span id="wx2x-collapse" title="收起">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 13 H12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </span>
      </div>
      <div class="dk-body">
        <div id="wx2x-picker">
          <button id="wx2x-cur" title="选择要填入的文章"></button>
          <div id="wx2x-list">${items}</div>
        </div>
        <button id="wx2x-fill">填入这篇</button>
        <div id="wx2x-prog">
          <div class="dk-bar"><i id="wx2x-bar"></i></div>
          <div id="wx2x-progress"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const bubble = panel.querySelector('#wx2x-bubble');
  const card = panel.querySelector('#wx2x-card');
  const setCollapsed = (c) => {
    bubble.style.display = c ? 'flex' : 'none';
    card.style.display = c ? 'none' : 'block';
    sessionStorage.setItem('wx2x-collapsed', c ? '1' : '0');
  };
  setCollapsed(userCollapsed || !autoExpand);

  bubble.addEventListener('click', () => setCollapsed(false));
  panel.querySelector('#wx2x-collapse').addEventListener('click', () => setCollapsed(true));

  // 文章选择器（自绘下拉，向上展开）
  const curBtn = panel.querySelector('#wx2x-cur');
  const list = panel.querySelector('#wx2x-list');
  const renderCur = () => {
    const e = index.find((x) => x.id === selectedId) || index[0];
    curBtn.innerHTML = `
      <span class="t">${escapeText(e.title)}</span>
      <span class="m">${metaOf(e)}</span>
      <span class="c"><svg width="10" height="10" viewBox="0 0 16 16"><path d="M4 10 L8 6 L12 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  };
  renderCur();
  curBtn.addEventListener('click', () => {
    list.style.display = list.style.display === 'block' ? 'none' : 'block';
  });
  list.addEventListener('click', (ev) => {
    const item = ev.target.closest('.dk-item');
    if (!item) return;
    selectedId = item.dataset.id;
    list.querySelectorAll('.dk-item').forEach((el) => el.classList.toggle('sel', el.dataset.id === selectedId));
    renderCur();
    list.style.display = 'none';
  });
  // 点击选择器外部收起列表（面板每次重建都换新监听器，旧的移除避免累积）
  if (window.__wx2xDocClose) document.removeEventListener('click', window.__wx2xDocClose, true);
  window.__wx2xDocClose = (ev) => {
    if (!ev.composedPath().includes(panel?.querySelector('#wx2x-picker'))) list.style.display = 'none';
  };
  document.addEventListener('click', window.__wx2xDocClose, true);

  panel.querySelector('#wx2x-fill').addEventListener('click', async () => {
    // 插件重载/更新后，旧content script的chrome.*全部失效，点击会静默无反应
    if (!chrome.runtime?.id) {
      progress('渡口插件已更新，请刷新本页面后重试');
      return;
    }
    const id = selectedId;
    const data = await chrome.storage.local.get('art_' + id);
    const article = data['art_' + id];
    if (!article) { progress('没找到这篇的数据，可能已在文库删除'); return; }
    fillArticle(article);
  });
}

function removePanel() {
  document.getElementById('wx2x-panel')?.remove();
  panel = null;
}

// text=进度文字；ratio=0~1可选，驱动顶部细进度条
function progress(text, ratio) {
  console.log('[wx2x]', text);
  const wrap = document.getElementById('wx2x-prog');
  const el = document.getElementById('wx2x-progress');
  if (wrap) wrap.style.display = 'block';
  if (el) el.textContent = text;
  if (typeof ratio === 'number') {
    const bar = document.getElementById('wx2x-bar');
    if (bar) bar.style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
  }
}

// ---------- 填充主流程 ----------

async function fillArticle(article) {
  const fillBtn = document.getElementById('wx2x-fill');
  fillBtn.disabled = true;

  try {
    // 1. 找编辑器
    progress('正在定位编辑器…');
    const editor = await waitFor(() => ADAPTER.findBodyEditor(), 8000);
    if (!editor) throw new Error(`没找到正文编辑器。${ADAPTER.hint}`);

    // 2. 填标题
    const titleEl = ADAPTER.findTitleField();
    if (titleEl) {
      let title = article.title;
      if (ADAPTER.maxTitleLen && title.length > ADAPTER.maxTitleLen) {
        title = title.slice(0, ADAPTER.maxTitleLen);
        progress(`标题超过${ADAPTER.maxTitleLen}字已截断，记得手动调整`);
        await sleep(800);
      }
      progress('填入标题…');
      await fillTitle(titleEl, title);
      await sleep(500);
    } else {
      progress('⚠️ 没找到标题框，跳过（可手动填）');
      await sleep(800);
    }

    // 3. 全部文字一次性粘贴
    const htmlBlocks = article.blocks.filter((b) => b.type === 'html');
    const htmlAll = htmlBlocks.map((b) => b.html).join('');

    // 图片清单：每张图记住原文中它前面最近的文字段落（作为插入锚点）
    const images = [];
    let lastAnchor = null;
    for (const b of article.blocks) {
      if (b.type === 'html') lastAnchor = normText(htmlToPlain(b.html));
      else if (b.type === 'image') images.push({ dataUrl: b.dataUrl, anchor: lastAnchor });
    }

    progress(`粘贴全部正文（${htmlBlocks.length}个段落）…`, 0.1);
    focusEditorEnd(editor);
    await sleep(200);
    pasteInto(editor, { html: htmlAll, text: htmlToPlain(htmlAll) });

    // 等正文渲染完成：能在编辑器里找到最后一段的文字
    const lastProbe = htmlBlocks.length
      ? normText(htmlToPlain(htmlBlocks[htmlBlocks.length - 1].html)).slice(0, 30) : '';
    const rendered = await waitFor(() => normText(editor.textContent).includes(lastProbe), 15000);
    if (!rendered) throw new Error('正文粘贴后未检测到完整渲染，请看Console日志。');
    progress('正文已就位', 0.3);
    await sleep(600);

    // 4. 图片从下往上插入（先插后面的，前面的锚点位置不受影响）
    for (let i = images.length - 1; i >= 0; i--) {
      const img = images[i];
      progress(`插入图片 ${i + 1}/${images.length}，等待上传…`, 0.3 + 0.7 * (images.length - 1 - i) / images.length);
      const dataUrl = await fitImageToLimit(img.dataUrl, `图片${i + 1}`);
      const anchorEl = findAnchorBlock(editor, img.anchor);
      if (anchorEl) placeCaretAtEnd(anchorEl);
      else focusEditorEnd(editor); // 找不到锚点兜底放末尾
      await sleep(300);

      const before = countEditorImages(editor);
      pasteInto(editor, { file: dataUrlToFile(dataUrl, `image_${i + 1}`) });
      const ok = await waitFor(() => countEditorImages(editor) > before, 20000);
      if (!ok) console.warn(`[wx2x] 第 ${i + 1} 张图片20秒内未出现，可能上传失败`);
      await sleep(600);
    }

    // 5. 填封面（站点支持才做，失败不中断）
    // 放最后：X上传头图会弹出裁剪框，放开头会全程挡住填充画面，像卡死
    let coverNote = '';
    if (ADAPTER.fillCover && article.coverDataUrl) {
      progress('上传头图…', 0.95);
      try {
        const coverDataUrl = await fitImageToLimit(article.coverDataUrl, '头图');
        await ADAPTER.fillCover({ ...article, coverDataUrl });
        await sleep(1500);
        coverNote = '；头图已就位';
      } catch (e) {
        console.warn('[wx2x] 头图填入失败（不影响正文）', e);
        coverNote = `；⚠️ 头图未成功（${e.message}），请手动添加`;
      }
    }

    progress(`已渡达：${htmlBlocks.length}个段落 + ${images.length}张图，请对照原文检查${coverNote}`, 1);
  } catch (e) {
    console.error('[wx2x]', e);
    progress('出错了：' + e.message);
  } finally {
    fillBtn.disabled = false;
  }
}

// ---------- 通用编辑器定位（适配器的兜底） ----------

// 标题框：textarea/input/contenteditable，placeholder等提示含 title/标题
function findTitleFieldHeuristic() {
  const candidates = [
    ...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'),
  ];
  for (const el of candidates) {
    const hint = [
      el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid'),
      el.getAttribute('aria-placeholder'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (/title|标题/.test(hint)) return el;
  }
  return null;
}

// 正文编辑器：面积最大的 contenteditable（排除标题）
function findBodyEditorHeuristic() {
  const editors = [...document.querySelectorAll('[contenteditable="true"]')];
  let best = null, bestArea = 0;
  for (const el of editors) {
    const hint = ((el.getAttribute('aria-label') || '') + (el.getAttribute('data-testid') || '')).toLowerCase();
    if (/title|标题/.test(hint)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = el; }
  }
  // 要求至少有一定面积，避免误抓回复框之类
  return bestArea > 10000 ? best : null;
}

// ---------- 填充原语 ----------

async function fillTitle(el, title) {
  el.focus();
  await sleep(100);
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, title);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    // contenteditable标题：用粘贴纯文本
    pasteInto(el, { text: title });
  }
}

function pasteInto(el, { html, text, file }) {
  const dt = new DataTransfer();
  if (file) dt.items.add(file);
  if (text) dt.setData('text/plain', text);
  if (html) dt.setData('text/html', html);
  el.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  }));
}

// 在编辑器里找文字与anchor匹配的段落块（取最后一个匹配，应对重复文本）
function findAnchorBlock(editor, anchor) {
  if (!anchor) return null;
  const probe = anchor.slice(0, 40);
  if (!probe) return null;
  // Draft.js的块元素带 data-block；Quill等用常规块级标签兜底
  let blocks = [...editor.querySelectorAll('[data-block="true"]')];
  if (blocks.length === 0) blocks = [...editor.querySelectorAll('p, h1, h2, h3, blockquote, li, div[data-offset-key]')];
  let found = null;
  for (const el of blocks) {
    if (normText(el.textContent).startsWith(probe)) found = el;
  }
  return found;
}

function placeCaretAtEnd(el) {
  el.scrollIntoView({ block: 'center' });
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusEditorEnd(editor) {
  editor.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false); // 光标到末尾
  sel.removeAllRanges();
  sel.addRange(range);
}

function countEditorImages(editor) {
  return editor.querySelectorAll('img, [data-testid*="media"], [style*="background-image"]').length;
}

// ---------- 工具 ----------

function normText(s) {
  return (s || '').replace(/\s+/g, '');
}

// ---------- 图片体积限制（如X单图约5MB，超限会被静默丢弃） ----------

function dataUrlBytes(dataUrl) {
  return Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
}

// 超限图片压到限内，尽量保画质：原尺寸下逐档降JPEG质量，仍超限再缩尺寸重试
// 注意：动图GIF重编码后会变静态图（超限GIF本来就传不上去，保内容优先）
async function fitImageToLimit(dataUrl, label) {
  const max = ADAPTER.maxImageBytes;
  const bytes = dataUrlBytes(dataUrl);
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  console.log(`[wx2x] ${label}：${mb(bytes)}`);
  if (!max || bytes <= max) return dataUrl;

  progress(`${label} ${mb(bytes)} 超过${ADAPTER.siteName}限制，压缩中…`);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let scale = 1, out = dataUrl;
    for (let round = 0; round < 6; round++) {
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.fillStyle = '#fff'; // JPEG无透明通道，透明区域垫白底
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.92, 0.85, 0.78, 0.7]) {
        out = canvas.toDataURL('image/jpeg', q);
        if (dataUrlBytes(out) <= max) {
          console.log(`[wx2x] ${label} 压缩完成：${mb(bytes)} → ${mb(dataUrlBytes(out))}（${canvas.width}px宽 · 质量${q}）`);
          return out;
        }
      }
      scale *= 0.8; // 质量0.7仍超限：缩小尺寸再走一轮质量阶梯
    }
    console.warn(`[wx2x] ${label} 压缩6轮仍超限（${mb(dataUrlBytes(out))}），按最后结果尝试上传`);
    return out;
  } catch (e) {
    console.warn(`[wx2x] ${label} 压缩失败，按原图尝试上传`, e);
    return dataUrl;
  }
}

function dataUrlToFile(dataUrl, name) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:([^;]+)/)[1];
  const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `${name}.${ext}`, { type: mime });
}

// HTML转纯文本（粘贴的text/plain兜底），段落间保留空行
function htmlToPlain(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|blockquote|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitFor(fn, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const result = fn();
      if (result || Date.now() - start > timeout) {
        clearInterval(timer);
        resolve(result || null);
      }
    }, 300);
  });
}
