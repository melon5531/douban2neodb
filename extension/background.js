// 豆瓣 → NeoDB 同步
// 后台 Service Worker：接收内容脚本的同步请求，调用 NeoDB API。
//
// NeoDB API（https://neodb.social/developer/ / openapi.json）：
//   GET  /api/catalog/fetch?url=<外部条目 URL>
//        已收录 → 302 重定向到条目 JSON（fetch 自动跟随，最终 200 + 条目数据）
//        未收录 → 202 {message:"Fetch in progress"}，服务端开始导入，轮询即可
//   POST /api/me/shelf/item/{item_uuid}
//        body: { shelf_type: wishlist|progress|complete|dropped, visibility: 0|1|2,
//                comment_text, rating_grade(0-10), tags: string[], post_to_fediverse }
//   GET  /api/me → { username, display_name, ... }
//   授权头：Authorization: Bearer <token>
'use strict';

const DEFAULTS = {
  instance: 'https://neodb.social',
  token: '',
  visibility: 0,      // 0 公开 / 1 仅关注者 / 2 仅自己
  autoSync: true,
  notify: true,
  syncTags: true,
  lastSyncs: []
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getSettings = () => new Promise((res) => chrome.storage.local.get(DEFAULTS, res));

const baseUrl = (s) => String(s.instance || DEFAULTS.instance).replace(/\/+$/, '');

async function api(s, path, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(baseUrl(s) + path, { method: opts.method || 'GET', headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: res.status, ok: res.ok, data };
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || '#0d9488' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  } catch (e) { /* 忽略 */ }
}

// 通过豆瓣 URL 定位 NeoDB 条目；未收录时触发服务端导入并轮询
async function resolveItem(s, doubanUrl) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try {
      r = await api(s, '/api/catalog/fetch?url=' + encodeURIComponent(doubanUrl));
    } catch (e) {
      return null;
    }
    if (r.ok && r.data && r.data.uuid) return r.data;       // 已收录（302 跟随后 200）
    if (r.status === 202) { await sleep(2000); continue; }  // 导入中，继续等
    if (r.status === 429) { await sleep(3000); continue; }  // 限流，稍等重试
    return null;                                            // 404/422 等：无法导入
  }
  return null;
}

async function handleSync(payload) {
  const s = await getSettings();
  payload = payload || {};

  if (!s.token) {
    return { ok: false, code: 'no-token', message: '尚未配置 NeoDB 访问令牌，点击插件图标进行设置' };
  }

  // 1. 定位条目
  const item = await resolveItem(s, payload.doubanUrl);
  if (!item || !item.uuid) {
    return {
      ok: false,
      message: 'NeoDB 暂无此条目，自动导入未完成',
      hint: baseUrl(s) + '/search?q=' + encodeURIComponent(payload.title || '')
    };
  }

  // 2. 组装标记参数
  const rating = payload.rating > 0 ? Math.max(1, Math.min(10, payload.rating * 2)) : 0;
  const tags = (s.syncTags !== false && payload.tags)
    ? String(payload.tags).split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 10)
    : [];
  const visibility = payload.doubanPrivate ? 2 : (Number(s.visibility) || 0);

  // 3. 写入标记
  let mark;
  try {
    mark = await api(s, '/api/me/shelf/item/' + encodeURIComponent(item.uuid), {
      method: 'POST',
      json: {
        shelf_type: payload.shelf || 'complete',
        visibility,
        comment_text: payload.comment || '',
        rating_grade: rating,
        tags,
        post_to_fediverse: false
      }
    });
  } catch (e) {
    setBadge('!', '#dc2626');
    return { ok: false, message: '无法连接 NeoDB：' + (e && e.message ? e.message : '网络错误') };
  }

  if (!mark.ok) {
    setBadge('!', '#dc2626');
    const msg = (mark.status === 401 || mark.status === 403)
      ? 'NeoDB 令牌无效或权限不足，请到插件设置重新生成'
      : 'NeoDB 返回错误（HTTP ' + mark.status + '）';
    return { ok: false, message: msg };
  }

  // 4. 记录 + 通知
  const itemUrl = item.url
    ? (String(item.url).startsWith('http') ? item.url : baseUrl(s) + item.url)
    : baseUrl(s) + '/';
  const entry = {
    title: payload.title || item.display_title || '',
    shelf: payload.shelf,
    rating,
    ok: true,
    time: Date.now(),
    url: itemUrl
  };
  const lastSyncs = [entry].concat(Array.isArray(s.lastSyncs) ? s.lastSyncs : []).slice(0, 20);
  chrome.storage.local.set({ lastSyncs });
  setBadge('✓');
  if (s.notify !== false) {
    try {
      chrome.notifications.create('d2n-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '已同步到 NeoDB',
        message: (entry.title || '条目')
          + (rating ? ' · ' + rating + ' 分' : '')
          + (payload.comment ? '\n' + String(payload.comment).slice(0, 60) : '')
      });
    } catch (e) { /* 忽略 */ }
  }
  return { ok: true, message: '已同步到 NeoDB', itemUrl };
}

// 历史迁移：单条同步（不弹通知、不刷角标，带 created_time 保留豆瓣标记日期）
async function handleMigrateOne(payload) {
  const s = await getSettings();
  payload = payload || {};
  if (!s.token) return { status: 'failed', message: '尚未配置 NeoDB 访问令牌' };

  const item = await resolveItem(s, payload.doubanUrl);
  if (!item || !item.uuid) return { status: 'missing' };

  const rating = payload.rating > 0 ? Math.max(1, Math.min(10, payload.rating * 2)) : 0;

  // 已有标记且完全一致 → 跳过（幂等）
  const existing = await api(s, '/api/me/shelf/item/' + encodeURIComponent(item.uuid));
  if (existing.ok && existing.data && existing.data.shelf_type === payload.shelf &&
      (existing.data.rating_grade || 0) === rating &&
      (existing.data.comment_text || '') === String(payload.comment || '')) {
    return { status: 'same' };
  }

  const body = {
    shelf_type: payload.shelf || 'complete',
    visibility: Number(s.visibility) || 0,
    comment_text: payload.comment || '',
    rating_grade: rating,
    tags: [],
    post_to_fediverse: false
  };
  if (payload.date) body.created_time = payload.date + 'T12:00:00+08:00';

  let mark = await api(s, '/api/me/shelf/item/' + encodeURIComponent(item.uuid), {
    method: 'POST', json: body
  });
  if (mark.status === 429) {           // 限流：退避后重试一次
    await sleep(10000);
    mark = await api(s, '/api/me/shelf/item/' + encodeURIComponent(item.uuid), {
      method: 'POST', json: body
    });
  }
  if (!mark.ok) {
    const msg = (mark.status === 401 || mark.status === 403)
      ? 'NeoDB 令牌无效或权限不足'
      : 'NeoDB 返回错误（HTTP ' + mark.status + '）';
    return { status: 'failed', message: msg };
  }
  return { status: 'synced' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'd2n-sync') {
    handleSync(msg.payload)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, message: '同步异常：' + (e && e.message ? e.message : e) }));
    return true; // 异步响应
  }
  if (msg.type === 'd2n-migrate-one') {
    handleMigrateOne(msg.payload)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ status: 'failed', message: (e && e.message) || String(e) }));
    return true;
  }
  if (msg.type === 'd2n-migrate-kick') {
    // 弹窗 → 后台 → 找到/打开豆瓣标记页，交给迁移内容脚本
    const mode = msg.mode || 'start';
    chrome.storage.local.set({ migrateKick: { ts: Date.now(), mode } }, () => {
      chrome.tabs.query({ url: 'https://movie.douban.com/*' }, (tabs) => {
        const tab = tabs.find((t) => /\/people\/[^/]+\/(collect|wish|do)/.test(t.url || ''));
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { type: 'd2n-migrate-kick' }, () => {
            if (chrome.runtime.lastError) {
              // 内容脚本未就绪（页面是旧的）→ 直接导航刷新
              chrome.tabs.update(tab.id, { url: 'https://movie.douban.com/people/mine/collect?sort=time&mode=detail' });
            }
          });
        } else {
          chrome.tabs.create({ url: 'https://movie.douban.com/people/mine/collect?sort=time&mode=detail' });
        }
      });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'd2n-open-options') {
    chrome.runtime.openOptionsPage();
  }
});
