// 后台协调器：打开微信文章页 → 等内容脚本抓取入库 → 打开目标平台编辑页
// 飞书读写走OpenAPI（feishu-api.js）
// 渡口桥：轮询本地 bridge/server.js，让终端agent（Claude Code等）能入库/导出文章

importScripts('feishu-api.js');

const DEST_URLS = {
  x: 'https://x.com/compose/articles',
  bili: 'https://member.bilibili.com/platform/upload/text/new-edit',
  none: null, // 只抓取入库，不跳转
};

const BRIDGE = 'http://127.0.0.1:8787';

let wechatTabId = null;

function setStatus(text, error = false) {
  chrome.storage.local.set({ wx_status: { text, error, at: Date.now() } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === 'start') {
    startExtraction(msg.url, msg.dest || 'none');
    sendResponse({ ok: true });
    return;
  }

  // 微信内容脚本抓取完成（数据已入库）
  if (msg.cmd === 'extracted') {
    if (sender.tab?.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
    chrome.storage.local.get('wx_dest').then(({ wx_dest }) => {
      const url = DEST_URLS[wx_dest];
      if (url) {
        setStatus(`抓取完成：《${msg.title}》，正在打开${wx_dest === 'x' ? ' X Articles' : 'B站专栏'}…`);
        chrome.tabs.create({ url, active: true });
      } else {
        setStatus(`抓取完成：《${msg.title}》，已存入文章库。`);
      }
    });
    finishBridgeFetch(); // 渡口桥发起的抓取：把结果回传落盘
    sendResponse({ ok: true });
    return;
  }

  if (msg.cmd === 'extract_failed') {
    setStatus('抓取失败：' + msg.reason, true);
    failBridgeFetch(msg.reason);
    sendResponse({ ok: true });
    return;
  }

  if (msg.cmd === 'bridge_poll') {
    pollBridge();
    sendResponse({ ok: true });
    return;
  }

  // 文章库 → 飞书文档（blocksSpec由popup用DOMParser预转换，SW里没有DOM）
  if (msg.cmd === 'feishu_write') {
    (async () => {
      try {
        const data = await chrome.storage.local.get('art_' + msg.id);
        const article = data['art_' + msg.id];
        if (!article) throw new Error('文章数据缺失');
        const url = await feishuWriteArticle(article, msg.blocksSpec, setStatus);
        setStatus(`✅ 已写入飞书：《${article.title}》\n${url}`);
        chrome.tabs.create({ url, active: true });
      } catch (e) {
        setStatus('写入飞书失败：' + e.message, true);
      }
    })();
    sendResponse({ ok: true });
    return;
  }

  // 飞书文档 → 文章库（之后可填入X/B站或下载MD）
  if (msg.cmd === 'feishu_read') {
    (async () => {
      try {
        const article = await feishuReadArticle(msg.url, setStatus);
        await saveToLibrary(article);
        const destUrl = DEST_URLS[msg.dest];
        if (destUrl) {
          setStatus(`抓取完成：《${article.title}》，正在打开目标平台…`);
          chrome.tabs.create({ url: destUrl, active: true });
        } else {
          setStatus(`抓取完成：《${article.title}》，已存入文章库。`);
        }
      } catch (e) {
        setStatus('读取飞书文档失败：' + e.message, true);
      }
    })();
    sendResponse({ ok: true });
    return;
  }
});

// 入库（与wechat-extract.js里的逻辑一致：同id只保留最新）
async function saveToLibrary(article) {
  const { wx_index = [] } = await chrome.storage.local.get('wx_index');
  const entry = {
    id: article.id,
    title: article.title,
    author: article.author,
    extractedAt: article.extractedAt,
    imgCount: article.blocks.filter((b) => b.type === 'image').length,
    blockCount: article.blocks.length,
  };
  await chrome.storage.local.set({
    ['art_' + article.id]: article,
    wx_index: [entry, ...wx_index.filter((e) => e.id !== article.id)],
    wx_current: article.id,
  });
}

async function startExtraction(url, dest) {
  await chrome.storage.local.set({ wx_dest: dest });
  setStatus('正在打开文章页…');
  const tab = await chrome.tabs.create({ url, active: false });
  wechatTabId = tab.id;

  // 等页面加载完，给内容脚本发抓取指令（带重试）
  const listener = (tabId, info) => {
    if (tabId !== wechatTabId || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);
    sendExtractWithRetry(tabId, 0);
  };
  chrome.tabs.onUpdated.addListener(listener);

  // 60秒兜底超时：还没入库就报失败
  const startAt = Date.now();
  setTimeout(async () => {
    const { wx_index = [] } = await chrome.storage.local.get('wx_index');
    const fresh = wx_index[0] && wx_index[0].extractedAt > startAt;
    if (!fresh && wechatTabId === tab.id) {
      setStatus('抓取超时（60秒）。链接可能已过期（tempkey链接有时效），试试重新复制链接。', true);
    }
  }, 60000);
}

function sendExtractWithRetry(tabId, attempt) {
  if (attempt > 10) {
    setStatus('无法连接文章页内容脚本，请重试。', true);
    return;
  }
  chrome.tabs.sendMessage(tabId, { cmd: 'extract' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setTimeout(() => sendExtractWithRetry(tabId, attempt + 1), 1000);
    }
  });
}

// ---------- 渡口桥（本地 bridge/server.js，桥没启动时静默跳过） ----------

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('bridge', { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('bridge', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge') pollBridge(); });
pollBridge(); // SW每次被唤醒顺手同步一次

let bridgePolling = false;

async function pollBridge() {
  if (bridgePolling) return;
  bridgePolling = true;
  try {
    const resp = await fetch(BRIDGE + '/tasks');
    if (!resp.ok) return;
    const { tasks = [] } = await resp.json();
    for (const t of tasks) {
      try { await handleBridgeTask(t); }
      catch (e) { postBridgeResult(t, { ok: false, error: e.message }); }
    }
  } catch (e) { /* 桥未启动 */ }
  finally { bridgePolling = false; }
}

async function handleBridgeTask(t) {
  if (t.type === 'import') {
    const article = { ...t.article, sourceUrl: 'bridge', extractedAt: Date.now() };
    await saveToLibrary(article);
    setStatus(`渡口桥送来《${article.title}》，已入文章库。`);
    await postBridgeResult(t, { ok: true, note: '已入库' });
    if (t.autoFill && DEST_URLS[t.dest]) {
      // 先放autofill标记再开页，目标页content script加载后会消费它
      await chrome.storage.local.set({ wx_autofill: { id: article.id, dest: t.dest, at: Date.now() } });
    }
    if (DEST_URLS[t.dest]) chrome.tabs.create({ url: DEST_URLS[t.dest], active: true });
    return;
  }

  if (t.type === 'export') {
    const { wx_current } = await chrome.storage.local.get('wx_current');
    const id = t.articleId || wx_current;
    const data = await chrome.storage.local.get('art_' + id);
    if (!data['art_' + id]) throw new Error(`文章库里没有 ${id || '任何文章'}`);
    await postBridgeResult(t, { ok: true, article: data['art_' + id], saveTo: t.saveTo });
    return;
  }

  if (t.type === 'fetch') {
    if (!/^https:\/\/mp\.weixin\.qq\.com\/s/.test(t.url)) throw new Error('只支持微信文章链接');
    await chrome.storage.local.set({ wx_bridge_fetch: { taskId: t.taskId, saveTo: t.saveTo, at: Date.now() } });
    startExtraction(t.url, 'none');
  }
}

async function finishBridgeFetch() {
  const { wx_bridge_fetch } = await chrome.storage.local.get('wx_bridge_fetch');
  if (!wx_bridge_fetch) return;
  await chrome.storage.local.remove('wx_bridge_fetch');
  const { wx_current } = await chrome.storage.local.get('wx_current');
  const data = await chrome.storage.local.get('art_' + wx_current);
  await postBridgeResult(wx_bridge_fetch, {
    ok: !!data['art_' + wx_current],
    article: data['art_' + wx_current],
    saveTo: wx_bridge_fetch.saveTo,
    error: data['art_' + wx_current] ? undefined : '抓取后未在文章库找到数据',
  });
}

async function failBridgeFetch(reason) {
  const { wx_bridge_fetch } = await chrome.storage.local.get('wx_bridge_fetch');
  if (!wx_bridge_fetch) return;
  await chrome.storage.local.remove('wx_bridge_fetch');
  await postBridgeResult(wx_bridge_fetch, { ok: false, error: reason });
}

async function postBridgeResult(t, body) {
  try {
    await fetch(BRIDGE + '/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t.taskId, ...body }),
    });
  } catch (e) {
    console.warn('[wx2x] 回传渡口桥失败', e);
  }
}
