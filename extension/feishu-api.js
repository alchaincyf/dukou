// 飞书OpenAPI模块（在background service worker里通过importScripts加载）
// 写入：文章库 → 新建docx文档（文字块批量写入 + 图片三步流程：建空block→upload_all→replace_image）
// 读取：docx/wiki链接 → 拉取全部blocks → 转成文章库格式（图片下载转dataURL）

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

async function feishuGetConfig() {
  const { wx_feishu_cfg } = await chrome.storage.local.get('wx_feishu_cfg');
  if (!wx_feishu_cfg?.app_id || !wx_feishu_cfg?.app_secret) {
    throw new Error('未配置飞书应用。点开插件popup底部的「飞书配置」，填入app_id和app_secret。');
  }
  return wx_feishu_cfg;
}

async function feishuToken(cfg) {
  const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }),
  });
  const data = await resp.json();
  if (!data.tenant_access_token) throw new Error('获取飞书token失败：' + (data.msg || JSON.stringify(data)));
  return data.tenant_access_token;
}

async function feishuApi(token, method, path, body) {
  const resp = await fetch(`${FEISHU_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`飞书API错误 ${path}: ${data.msg} (code ${data.code})`);
  return data.data;
}

// ---------- 写入：文章 → 飞书文档 ----------

// blocksSpec: popup预转换好的飞书block数组，图片位是 {__image: true}
async function feishuWriteArticle(article, blocksSpec, setStatus) {
  const cfg = await feishuGetConfig();
  const token = await feishuToken(cfg);

  setStatus('正在创建飞书文档…');
  const doc = await feishuApi(token, 'POST', '/docx/v1/documents', { title: article.title });
  const docId = doc.document.document_id;

  // 文字块+空图片块按顺序批量写入（每批≤50）
  setStatus(`写入 ${blocksSpec.length} 个内容块…`);
  const children = blocksSpec.map((b) => (b.__image ? { block_type: 27, image: {} } : b));
  const created = [];
  for (let i = 0; i < children.length; i += 50) {
    const batch = children.slice(i, i + 50);
    const res = await feishuApi(token, 'POST',
      `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: batch });
    created.push(...(res.children || []));
    setStatus(`写入内容块 ${Math.min(i + 50, children.length)}/${children.length}…`);
  }

  // 图片：upload_all到对应block，再replace_image
  const imageDataUrls = article.blocks.filter((b) => b.type === 'image').map((b) => b.dataUrl);
  const imageBlockIds = created
    .map((blk, i) => (blocksSpec[i]?.__image ? blk.block_id : null))
    .filter(Boolean);
  for (let i = 0; i < imageBlockIds.length; i++) {
    setStatus(`上传图片 ${i + 1}/${imageBlockIds.length}…`);
    try {
      const blob = dataUrlToBlob(imageDataUrls[i]);
      const form = new FormData();
      form.append('file_name', `img_${i + 1}.${blob.type.split('/')[1] || 'jpg'}`);
      form.append('parent_type', 'docx_image');
      form.append('parent_node', imageBlockIds[i]);
      form.append('size', String(blob.size));
      form.append('file', blob);
      const up = await feishuApi(token, 'POST', '/drive/v1/medias/upload_all', form);
      await feishuApi(token, 'PATCH',
        `/docx/v1/documents/${docId}/blocks/${imageBlockIds[i]}`,
        { replace_image: { token: up.file_token } });
    } catch (e) {
      console.warn('[wx2x] 飞书图片上传失败', i + 1, e);
    }
  }

  // 给花叔的open_id加编辑权限（bot创建的文档默认归bot）
  if (cfg.open_id) {
    setStatus('设置文档权限…');
    try {
      await feishuApi(token, 'POST',
        `/drive/v1/permissions/${docId}/members?type=docx&need_notification=false`,
        { member_type: 'openid', member_id: cfg.open_id, perm: 'full_access' });
    } catch (e) {
      console.warn('[wx2x] 权限设置失败', e);
    }
  }

  return `https://feishu.cn/docx/${docId}`;
}

// ---------- 读取：飞书文档 → 文章 ----------

async function feishuReadArticle(url, setStatus) {
  const cfg = await feishuGetConfig();
  const token = await feishuToken(cfg);

  setStatus('解析文档链接…');
  let docId = null;
  const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (docxMatch) {
    docId = docxMatch[1];
  } else if (wikiMatch) {
    const node = await feishuApi(token, 'GET',
      `/wiki/v2/spaces/get_node?token=${wikiMatch[1]}&obj_type=wiki`);
    if (node.node?.obj_type !== 'docx') throw new Error('该wiki节点不是docx文档');
    docId = node.node.obj_token;
  } else {
    throw new Error('无法从链接中识别文档ID（支持 /docx/xxx 和 /wiki/xxx）');
  }

  setStatus('读取文档内容…');
  const meta = await feishuApi(token, 'GET', `/docx/v1/documents/${docId}`);
  const title = meta.document?.title || '无标题文档';

  // 分页拉全部blocks
  let blocks = [];
  let pageToken = '';
  do {
    const res = await feishuApi(token, 'GET',
      `/docx/v1/documents/${docId}/blocks?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`);
    blocks.push(...(res.items || []));
    pageToken = res.has_more ? res.page_token : '';
  } while (pageToken);

  // 转成文章库的block格式
  const out = [];
  const imageTokens = [];
  for (const blk of blocks) {
    const t = blk.block_type;
    if (t === 1) continue; // 根page块
    if (t === 27 && blk.image?.token) {
      out.push({ type: 'image', __token: blk.image.token });
      imageTokens.push(blk.image.token);
      continue;
    }
    const html = feishuBlockToHtml(blk);
    if (html) out.push({ type: 'html', html });
  }

  // 下载图片转dataURL
  let done = 0;
  for (const b of out) {
    if (b.type !== 'image') continue;
    done++;
    setStatus(`下载图片 ${done}/${imageTokens.length}…`);
    try {
      b.dataUrl = await feishuDownloadMedia(token, b.__token);
      delete b.__token;
    } catch (e) {
      console.warn('[wx2x] 飞书图片下载失败', e);
      b.failed = true;
    }
  }
  const finalBlocks = out.filter((b) => b.type !== 'image' || (b.dataUrl && !b.failed));

  // 合并相邻的li片段成完整列表
  const merged = mergeFeishuLists(finalBlocks);

  const firstImg = merged.find((b) => b.type === 'image');
  return {
    id: 'FS_' + docId,
    title,
    author: '飞书文档',
    coverDataUrl: firstImg?.dataUrl || '',
    blocks: merged,
    sourceUrl: url,
    extractedAt: Date.now(),
  };
}

// 飞书text block → 简化HTML
function feishuBlockToHtml(blk) {
  const TYPE_MAP = {
    2: ['p', 'text'],
    3: ['h2', 'heading1'], 4: ['h2', 'heading2'], 5: ['h2', 'heading3'],
    6: ['h2', 'heading4'], 7: ['h2', 'heading5'], 8: ['h2', 'heading6'],
    12: ['li-ul', 'bullet'], 13: ['li-ol', 'ordered'],
    14: ['pre', 'code'], 15: ['blockquote', 'quote'],
  };
  const m = TYPE_MAP[blk.block_type];
  if (!m) return null;
  const [tag, field] = m;
  const elements = blk[field]?.elements || [];
  let inner = '';
  for (const el of elements) {
    const run = el.text_run;
    if (!run) continue;
    let piece = escapeHtmlSW(run.content);
    const st = run.text_element_style || {};
    if (st.inline_code) piece = `<code>${piece}</code>`;
    if (st.bold) piece = `<b>${piece}</b>`;
    if (st.italic) piece = `<i>${piece}</i>`;
    if (st.link?.url) piece = `<a href="${escapeHtmlSW(decodeURIComponent(st.link.url))}">${piece}</a>`;
    inner += piece;
  }
  if (!inner.trim()) return null;
  if (tag === 'pre') return `<pre>${inner}</pre>`;
  if (tag === 'li-ul') return `<ul><li>${inner}</li></ul>`;
  if (tag === 'li-ol') return `<ol><li>${inner}</li></ol>`;
  return `<${tag}>${inner}</${tag}>`;
}

// 相邻的单条<ul>/<ol>合并成一个列表
function mergeFeishuLists(blocks) {
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const tag = b.type === 'html' && (b.html.startsWith('<ul>') ? 'ul' : b.html.startsWith('<ol>') ? 'ol' : null);
    const prevTag = prev?.type === 'html' && (prev.html.startsWith('<ul>') ? 'ul' : prev.html.startsWith('<ol>') ? 'ol' : null);
    if (tag && tag === prevTag) {
      prev.html = prev.html.replace(`</${tag}>`, '') + b.html.replace(`<${tag}>`, '');
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

async function feishuDownloadMedia(token, fileToken) {
  const resp = await fetch(`${FEISHU_BASE}/drive/v1/medias/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const buf = await resp.arrayBuffer();
  const mime = resp.headers.get('Content-Type') || 'image/jpeg';
  return 'data:' + mime + ';base64,' + arrayBufferToBase64(buf);
}

// ---------- 工具 ----------

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:([^;]+)/)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function escapeHtmlSW(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
