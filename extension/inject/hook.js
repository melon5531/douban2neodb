// 豆瓣 → NeoDB 同步
// 页面世界钩子（MAIN world）：在豆瓣页面自己的 XHR/fetch 发出前包装它们，
// 拦截“标记/打分/短评”提交接口（URL 形如 /j/.../interest），把请求字段和响应
// 通过 CustomEvent('d2n-capture') 抛给隔离世界的内容脚本。
// 尽早执行（document_start），保证豆瓣脚本拿到的是已包装的 XHR/fetch。
(() => {
  'use strict';
  if (window.__d2nHooked) return;
  window.__d2nHooked = true;

  // 豆瓣各条目类目的兴趣/标记提交接口都含 /j/...interest
  const INTEREST_RE = /\/j\/[^\s?#]*interest/i;

  const emit = (payload) => {
    try {
      payload.pageUrl = location.href;
      payload.pageTitle = document.title || '';
      window.dispatchEvent(new CustomEvent('d2n-capture', { detail: payload }));
    } catch (e) { /* 忽略 */ }
  };

  // 把各种请求体统一成普通对象（键→值）
  const normalizeBody = (body) => {
    if (body == null) return {};
    try {
      if (typeof body === 'string') {
        const o = {};
        if (body.startsWith('{')) { Object.assign(o, JSON.parse(body)); return o; }
        new URLSearchParams(body).forEach((v, k) => { o[k] = v; });
        return o;
      }
      if (body instanceof FormData) {
        const o = {};
        body.forEach((v, k) => { o[k] = String(v); });
        return o;
      }
      if (body instanceof URLSearchParams) {
        const o = {};
        body.forEach((v, k) => { o[k] = v; });
        return o;
      }
    } catch (e) { /* 忽略 */ }
    return {};
  };

  const capture = (url, fields, respText) => {
    try {
      if (!url || !fields || !Object.keys(fields).length) return;
      if (!INTEREST_RE.test(String(url))) return;
      emit({ url: String(url), fields, response: respText ? String(respText).slice(0, 800) : '' });
    } catch (e) { /* 忽略 */ }
  };

  // ---- 包装 fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && INTEREST_RE.test(url)) {
          const fields = normalizeBody(init && init.body);
          const p = origFetch.apply(this, arguments);
          p.then((res) => {
            try {
              res.clone().text().then((t) => capture(url, fields, t)).catch(() => capture(url, fields, ''));
            } catch (e) { capture(url, fields, ''); }
          }).catch(() => capture(url, fields, ''));
          return p;
        }
      } catch (e) { /* 忽略 */ }
      return origFetch.apply(this, arguments);
    };
  }

  // ---- 包装 XMLHttpRequest ----
  const X = window.XMLHttpRequest;
  if (X && X.prototype) {
    const origOpen = X.prototype.open;
    const origSend = X.prototype.send;
    X.prototype.open = function (method, url) {
      try {
        this.__d2n = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };
    X.prototype.send = function (body) {
      try {
        const meta = this.__d2n || {};
        if (meta.method === 'POST' && INTEREST_RE.test(meta.url)) {
          const fields = normalizeBody(body);
          this.addEventListener('load', () => {
            let t = '';
            try { t = this.responseText || ''; } catch (e) { /* 忽略 */ }
            capture(meta.url, fields, t);
          });
          this.addEventListener('error', () => capture(meta.url, fields, ''));
        }
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  }
})();
