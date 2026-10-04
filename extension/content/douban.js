// 豆瓣 → NeoDB 同步
// 内容脚本（隔离世界）：
// 1. 接收页面世界钩子抛出的 d2n-capture 事件（XHR/fetch 拦截）；
// 2. 兜底：监听豆瓣“标记”表单的 submit 事件；
// 3. 组装同步数据发给后台，并把结果显示为页面角标 toast。
(() => {
  'use strict';

  // 仅在条目页生效：/subject/{id}/ 或 /game/{id}/
  const ITEM_PATH_RE = /^\/(subject|game)\/\d+\/?$/;

  const cleanTitle = () => {
    let t = (document.title || '').replace(/\s*[（(]豆瓣[)）]\s*$/i, '').trim();
    t = t.replace(/\s*-\s*豆瓣$/, '').trim();
    return t || '未知条目';
  };

  const canonicalItemUrl = () => {
    if (!ITEM_PATH_RE.test(location.pathname)) return null;
    const p = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
    return location.origin + p;
  };

  // 豆瓣状态值 → NeoDB shelf_type
  // done/collect = 看过/读过/听过/玩过；do/doing = 在看/在读/在玩；wish = 想看/想读/想玩
  const parseShelf = (s) => {
    if (!s) return null;
    s = String(s).toLowerCase();
    if (s === 'wish' || s === 'wished') return 'wishlist';
    if (s === 'do' || s === 'doing') return 'progress';
    if (s === 'done' || s === 'collect' || s === 'collected') return 'complete';
    return null;
  };

  const buildPayload = (fields, response) => {
    const doubanUrl = canonicalItemUrl();
    if (!doubanUrl) return null;
    const f = fields || {};

    const ratingNum = parseInt(f.rating, 10);
    const rating = ratingNum >= 1 && ratingNum <= 5 ? ratingNum : 0;
    const comment = String(f.comment || '').trim();
    const tags = String(f.tags || '').trim();

    // 兼容新版 status 字段与旧版 interest 字段
    let shelf = parseShelf(f.status) || parseShelf(f.interest);
    if (!shelf && (rating || comment)) shelf = 'complete';
    if (!shelf) return null;

    return {
      doubanUrl,
      title: cleanTitle(),
      shelf,
      rating,
      comment,
      tags,
      doubanPrivate: /private/i.test(String(f.privacy || '')),
      response: String(response || '')
    };
  };

  // 豆瓣提交失败的明显特征（未登录等）→ 跳过同步
  const looksFailed = (resp) => {
    if (!resp) return false;
    if (/"r"\s*:\s*1/.test(resp)) return true;
    if (/请登录|需要登录|登录后|login_required|not_login/i.test(resp)) return true;
    return false;
  };

  // 同一次提交可能触发两条事件（form submit + XHR），后到者覆盖，300ms 防抖后统一处理
  let pending = null;
  let timer = null;
  const consider = (payload, response) => {
    payload.response = response || '';
    pending = payload;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };

  const flush = () => {
    const payload = pending;
    pending = null;
    timer = null;
    if (!payload) return;

    if (looksFailed(payload.response)) {
      showToast({ ok: false, message: '豆瓣标记未提交成功，已跳过 NeoDB 同步' });
      return;
    }

    chrome.storage.local.get(['autoSync'], (cfg) => {
      if (cfg && cfg.autoSync === false) return; // 总开关关闭
      try {
        chrome.runtime.sendMessage({ type: 'd2n-sync', payload }, (res) => {
          if (chrome.runtime.lastError) {
            showToast({ ok: false, message: '扩展后台不可用，请刷新页面重试' });
            return;
          }
          showToast(res || { ok: false, message: '同步失败：无响应' });
        });
      } catch (e) {
        showToast({ ok: false, message: '扩展后台不可用，请刷新页面重试' });
      }
    });
  };

  // 页面世界钩子事件
  window.addEventListener('d2n-capture', (e) => {
    try {
      const d = e.detail || {};
      const payload = buildPayload(d.fields || {}, d.response || '');
      if (payload) consider(payload, d.response || '');
    } catch (err) { /* 忽略 */ }
  });

  // 兜底：直接拦截标记表单 submit（XHR 钩子失效时仍可用）
  document.addEventListener('submit', (e) => {
    try {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const action = (form.getAttribute('action') || '') + ' ' + (form.id || '');
      if (!/interest/i.test(action)) return;
      const fields = {};
      new FormData(form).forEach((v, k) => { fields[k] = String(v); });
      const payload = buildPayload(fields, '');
      if (payload) consider(payload, '');
    } catch (err) { /* 忽略 */ }
  }, true);

  // ---- 结果 toast（Shadow DOM 隔离样式）----
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function showToast(res) {
    try {
      const old = document.getElementById('d2n-toast-host');
      if (old) old.remove();
      res = res || {};
      const ok = !!res.ok;
      const host = document.createElement('div');
      host.id = 'd2n-toast-host';
      const root = host.attachShadow({ mode: 'open' });

      let link = '';
      if (res.itemUrl) {
        link = '<a class="lnk" href="' + escapeHtml(res.itemUrl) + '" target="_blank" rel="noreferrer">查看 NeoDB 条目 →</a>';
      } else if (res.hint) {
        link = '<a class="lnk" href="' + escapeHtml(res.hint) + '" target="_blank" rel="noreferrer">在 NeoDB 搜索此条目 →</a>';
      } else if (res.code === 'no-token') {
        link = '<a class="lnk" href="#" id="d2n-open-settings">打开插件设置 →</a>';
      }

      root.innerHTML = `
        <style>
          :host, :host * { box-sizing: border-box; }
          .toast {
            position: fixed; right: 20px; bottom: 24px; z-index: 2147483646;
            display: flex; align-items: flex-start; gap: 10px;
            max-width: 340px; padding: 12px 14px;
            background: #1f2937; color: #f9fafb;
            border-left: 4px solid ${ok ? '#0d9488' : '#dc2626'};
            border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
            font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          }
          .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px;
                 background: ${ok ? '#0d9488' : '#dc2626'}; }
          .msg { word-break: break-all; }
          .lnk { display: inline-block; margin-top: 4px; color: #5eead4;
                 text-decoration: none; font-size: 12px; }
          .lnk:hover { text-decoration: underline; }
          .err .lnk { color: #fca5a5; }
        </style>
        <div class="toast ${ok ? 'ok' : 'err'}">
          <span class="dot"></span>
          <div class="body">
            <div class="msg">${escapeHtml(res.message || (ok ? '已同步到 NeoDB' : '同步失败'))}</div>
            ${link}
          </div>
        </div>`;

      document.documentElement.appendChild(host);
      const s = root.getElementById('d2n-open-settings');
      if (s) {
        s.addEventListener('click', (e) => {
          e.preventDefault();
          try { chrome.runtime.sendMessage({ type: 'd2n-open-options' }); } catch (err) { /* 忽略 */ }
        });
      }
      setTimeout(() => host.remove(), ok ? 6000 : 10000);
    } catch (e) { /* 忽略 */ }
  }
})();
