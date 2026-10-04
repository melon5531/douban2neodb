// 豆瓣 → NeoDB 同步 · 弹窗逻辑
'use strict';

const DEFAULTS = { token: '', autoSync: true, lastSyncs: [] };
const SHELF_CN = { complete: '完成', progress: '进行中', wishlist: '愿望单', dropped: '放弃' };

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

chrome.storage.local.get(DEFAULTS, (s) => {
  const conn = document.getElementById('conn');
  if (s.token) {
    conn.innerHTML = '已配置令牌 <b class="ok">✓</b>';
  } else {
    conn.innerHTML = '未配置令牌 <b class="bad">✗</b>，请先打开设置';
  }
  document.getElementById('autoSync').checked = s.autoSync !== false;

  const list = document.getElementById('list');
  const items = Array.isArray(s.lastSyncs) ? s.lastSyncs.slice(0, 8) : [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">暂无记录 · 去豆瓣标记一条试试</div>';
  } else {
    list.innerHTML = items.map((it) => {
      const title = String(it.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const inner = it.ok
        ? '<a href="' + it.url + '" target="_blank">' + title + '</a>'
        : '<span style="color:#9ca3af">' + title + '</span>';
      const shelf = it.shelf ? '<span class="shelf">· ' + (SHELF_CN[it.shelf] || it.shelf) + (it.rating ? ' · ' + it.rating + ' 分' : '') + '</span>' : '';
      return '<div class="item"><div class="t">' + inner
        + '<span class="time">' + fmtTime(it.time) + '</span></div>'
        + '<span class="badge ' + (it.ok ? 'ok' : 'err') + '">' + (it.ok ? '成功' : '失败') + '</span> ' + shelf + '</div>';
    }).join('');
    list.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  }
});

document.getElementById('autoSync').addEventListener('change', (e) => {
  chrome.storage.local.set({ autoSync: e.target.checked });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---- 历史标记迁移 ----

const PHASE_CN = {
  idle: '未开始', scrape: '正在抓取豆瓣标记…', sync: '正在同步到 NeoDB…',
  paused: '已暂停', done: '已完成'
};
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const $ = (id) => document.getElementById(id);
const els = {
  phase: $('migPhase'), count: $('migCount'), bar: $('migBar'),
  detail: $('migDetail'), start: $('migStart'), resume: $('migResume'),
  stop: $('migStop'), log: $('migLog')
};

function renderMigrate(st) {
  st = st || { phase: 'idle' };
  const phase = st.phase || 'idle';
  els.phase.textContent = PHASE_CN[phase] || phase;

  const running = phase === 'scrape' || phase === 'sync';
  els.start.style.display = (phase === 'idle' || phase === 'done' || phase === 'paused' && !st.scrapedDone) ? '' : 'none';
  els.start.textContent = phase === 'paused' && !st.scrapedDone ? '重新开始' : '开始迁移';
  els.resume.style.display = (phase === 'paused' && st.scrapedDone) ? '' : 'none';
  els.stop.style.display = running ? '' : 'none';
  els.log.style.display = (st.log && st.log.length) ? '' : 'none';

  if (phase === 'scrape') {
    els.count.textContent = (st.scrapeCount || 0) + ' 条';
    els.bar.style.width = '35%';
    els.detail.textContent = '抓取速度约每页 3 秒，期间请保持此标签页打开';
  } else if (phase === 'sync' || phase === 'paused' || phase === 'done') {
    const total = st.total || 0, idx = st.idx || 0;
    els.count.textContent = total ? `${idx} / ${total}` : '';
    els.bar.style.width = total ? (100 * idx / total).toFixed(1) + '%' : '100%';
    const r = st.results || {};
    els.detail.textContent = `新增 ${r.synced || 0} · 已一致 ${r.same || 0} · 无法收录 ${r.missing || 0} · 失败 ${r.failed || 0}`;
  } else {
    els.count.textContent = '';
    els.bar.style.width = '0';
    els.detail.innerHTML = '&nbsp;';
  }

  els.log.innerHTML = (st.log || []).map((l) => {
    const cls = l.m.startsWith('+') ? 'ok' : (l.m.startsWith('✗') ? 'err' : '');
    return `<div class="${cls}" title="${escapeHtml(l.m)}">${escapeHtml(l.m)}</div>`;
  }).join('');
}

function pollMigrate() {
  chrome.storage.local.get('migrateV1', (o) => renderMigrate(o && o.migrateV1));
}

els.start.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'd2n-migrate-kick', mode: 'start' });
  setTimeout(pollMigrate, 600);
});
els.resume.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'd2n-migrate-kick', mode: 'resume' });
  setTimeout(pollMigrate, 600);
});
els.stop.addEventListener('click', () => {
  chrome.storage.local.set({ migrateCancel: true });
  els.phase.textContent = '正在暂停（等当前条目完成）…';
});

pollMigrate();
setInterval(pollMigrate, 1000);

// ---- 数据导出 ----

const expStat = $('expStat');
const expButtons = [$('expCsv'), $('expMd'), $('expJson')];

function runExport(format, label) {
  chrome.storage.local.get(['token'], (s) => {
    if (!s || !s.token) {
      expStat.textContent = '尚未配置 NeoDB 访问令牌，请先打开设置';
      return;
    }
    expButtons.forEach((b) => { b.disabled = true; });
    expStat.textContent = `正在导出为 ${label}…（条目多时需几秒）`;
    try {
      chrome.runtime.sendMessage({ type: 'd2n-export', format }, (res) => {
        res = res || { ok: false, message: '无响应，请重试' };
        expStat.textContent = res.message || (res.ok ? '导出完成' : '导出失败');
        expButtons.forEach((b) => { b.disabled = false; });
      });
    } catch (e) {
      expStat.textContent = '扩展后台不可用，请重试';
      expButtons.forEach((b) => { b.disabled = false; });
    }
  });
}

$('expCsv').addEventListener('click', () => runExport('csv', 'CSV'));
$('expMd').addEventListener('click', () => runExport('markdown', 'Markdown'));
$('expJson').addEventListener('click', () => runExport('json', 'JSON'));
