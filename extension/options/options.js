// 豆瓣 → NeoDB 同步 · 设置页逻辑
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  instance: 'https://neodb.social',
  token: '',
  visibility: 0,
  autoSync: true,
  notify: true,
  syncTags: true
};

const base = () => ($('instance').value.trim().replace(/\/+$/, '') || DEFAULTS.instance);

function setStatus(text, isErr) {
  const el = $('status');
  el.textContent = text;
  el.className = isErr ? 'err' : '';
}

function load() {
  chrome.storage.local.get(DEFAULTS, (s) => {
    $('instance').value = s.instance;
    $('token').value = s.token;
    $('visibility').value = String(Number(s.visibility) || 0);
    $('autoSync').checked = s.autoSync !== false;
    $('notify').checked = s.notify !== false;
    $('syncTags').checked = s.syncTags !== false;
    $('devLinkText').textContent = base() + '/developer/';
    if (s.token) testConnection();
  });
}

function collect() {
  return {
    instance: base(),
    token: $('token').value.trim(),
    visibility: Number($('visibility').value) || 0,
    autoSync: $('autoSync').checked,
    notify: $('notify').checked,
    syncTags: $('syncTags').checked
  };
}

function save(cb) {
  const values = collect();
  if (!/^https:\/\//.test(values.instance)) {
    setStatus('实例地址必须以 https:// 开头', true);
    return;
  }
  chrome.storage.local.set(values, async () => {
    $('devLinkText').textContent = values.instance + '/developer/';
    // 非官方实例需要为该域名申请 API 访问权限
    let host = '';
    try { host = new URL(values.instance).host; } catch (e) { /* 忽略 */ }
    if (host && !host.endsWith('neodb.social')) {
      try {
        const granted = await chrome.permissions.request({ origins: [values.instance + '/*'] });
        if (!granted) setStatus('注意：未授予该域名权限，可能无法调用其 API', true);
      } catch (e) { /* 用户未交互时可能抛错，忽略 */ }
    }
    setStatus('已保存 ✓');
    if (cb) cb();
  });
}

async function api(path, opts = {}) {
  const headers = { Accept: 'application/json' };
  const token = $('token').value.trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(base() + path, { method: opts.method || 'GET', headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 忽略 */ }
  return { status: res.status, ok: res.ok, data };
}

async function testConnection() {
  if (!$('token').value.trim()) { setStatus('请先填入访问令牌', true); return; }
  setStatus('正在测试连接…');
  try {
    const r = await api('/api/me');
    if (r.ok && r.data && r.data.username) {
      const name = r.data.display_name || r.data.username;
      setStatus('连接成功 ✓ 当前账号：' + name + ' (@' + r.data.username + ')');
    } else if (r.status === 401 || r.status === 403) {
      setStatus('令牌无效或权限不足（HTTP ' + r.status + '），请重新生成', true);
    } else {
      setStatus('连接失败（HTTP ' + r.status + '）', true);
    }
  } catch (e) {
    setStatus('连接失败：' + (e && e.message ? e.message : '网络错误'), true);
  }
}

// ---- 一键 OAuth ----
async function oauthStart() {
  setStatus('正在注册 OAuth 应用…');
  try {
    const res = await fetch(base() + '/api/v1/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'douban2neodb-browser-extension',
        redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
        scopes: 'read write',
        website: 'https://neodb.social'
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const app = await res.json();
    if (!app || !app.client_id) throw new Error('返回数据缺少 client_id');
    chrome.storage.local.set({
      oauthApp: { base: base(), client_id: app.client_id, client_secret: app.client_secret }
    });
    const url = base() + '/oauth/authorize'
      + '?response_type=code'
      + '&client_id=' + encodeURIComponent(app.client_id)
      + '&redirect_uri=' + encodeURIComponent('urn:ietf:wg:oauth:2.0:oob')
      + '&scope=read+write';
    chrome.tabs.create({ url });
    setStatus('已打开授权页面：登录并授权后，把页面显示的授权码粘贴到输入框，点击「换取令牌」');
  } catch (e) {
    setStatus('注册应用失败：' + (e && e.message ? e.message : '网络错误') + '（可改用方式 A 手动生成令牌）', true);
  }
}

async function oauthFinish() {
  const code = $('oauthCode').value.trim();
  if (!code) { setStatus('请先粘贴授权码', true); return; }
  chrome.storage.local.get({ oauthApp: null }, async (st) => {
    const app = st.oauthApp;
    if (!app || !app.client_id) { setStatus('请先点击「一键授权」', true); return; }
    setStatus('正在换取令牌…');
    try {
      const res = await fetch((app.base || base()) + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: app.client_id,
          client_secret: app.client_secret,
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          grant_type: 'authorization_code',
          code
        }).toString()
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.access_token) {
        $('token').value = data.access_token;
        $('oauthCode').value = '';
        save(() => testConnection());
        setStatus('授权成功，令牌已保存 ✓');
      } else {
        setStatus('换取令牌失败：' + (data && data.error ? data.error : 'HTTP ' + res.status), true);
      }
    } catch (e) {
      setStatus('换取令牌失败：' + (e && e.message ? e.message : '网络错误'), true);
    }
  });
}

$('save').addEventListener('click', () => save());
$('test').addEventListener('click', () => testConnection());
$('oauthStart').addEventListener('click', oauthStart);
$('oauthFinish').addEventListener('click', oauthFinish);
$('instance').addEventListener('change', () => { $('devLinkText').textContent = base() + '/developer/'; });

load();
