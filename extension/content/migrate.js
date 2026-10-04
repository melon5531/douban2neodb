// 离豆 · 历史标记迁移器（内容脚本，隔离世界）
// 在 movie.douban.com 上运行：分页抓取个人标记列表（看过/想看/在看），
// 逐条发给后台同步到 NeoDB。进度写入 chrome.storage.local('migrateV1')，
// 弹窗据此显示进度；可随时暂停，从断点续传。
(() => {
  'use strict';

  const KEY = 'migrateV1';          // 进度状态（不含标记数据）
  const KEY_MARKS = 'migrateMarks'; // 抓取到的全部标记（抓取完成时写入一次）
  const KEY_KICK = 'migrateKick';   // 弹窗「开始/继续」信号 {ts, mode}
  const KEY_CANCEL = 'migrateCancel';
  const PAGE_DELAY = [2600, 4200];  // 抓取列表页的间隔（毫秒，随机区间）
  const ITEM_DELAY = [700, 1600];   // 每条同步之间的间隔
  const PEOPLE_URL = 'https://movie.douban.com/people/mine/collect?sort=time&mode=detail';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = ([a, b]) => a + Math.random() * (b - a);
  const readOne = (k) => new Promise((res) => chrome.storage.local.get(k, (o) => res(o && o[k])));
  const write = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

  const blank = () => ({
    phase: 'idle',            // idle | scrape | sync | paused | done
    scrapedDone: false,
    uid: '',
    idx: 0, total: 0, scrapeCount: 0,
    results: { synced: 0, same: 0, missing: 0, failed: 0 },
    log: [],
    ts: Date.now()
  });

  const pushLog = (st, line) => {
    st.log = [{ t: Date.now(), m: line }].concat(st.log || []).slice(0, 30);
  };
  const saveState = (st) => write({ [KEY]: st });

  let cancelled = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY_CANCEL]) cancelled = !!changes[KEY_CANCEL].newValue;
  });
  chrome.storage.local.get(KEY_CANCEL, (o) => { cancelled = !!(o && o[KEY_CANCEL]); });

  // ---- 页面解析 ----

  function parsePage(doc) {
    const items = [];
    doc.querySelectorAll('div.item').forEach((it) => {
      const link = it.querySelector('a[href*="movie.douban.com/subject/"]');
      if (!link || !it.querySelector('li.title')) return;
      const m = /movie\.douban\.com\/subject\/(\d+)/.exec(link.href || '');
      if (!m) return;
      let stars = 0;
      const rEl = it.querySelector('span[class*="rating"]');
      if (rEl) {
        const c = rEl.className || '';
        const r1 = /rating(\d)-t/.exec(c), r2 = /allstar(\d)0/.exec(c);
        stars = parseInt((r1 && r1[1]) || (r2 && r2[1]) || '0', 10);
      }
      const date = (it.querySelector('span.date') || {}).textContent || '';
      const comment = (it.querySelector('span.comment') || {}).textContent || '';
      const title = ((it.querySelector('li.title a em') || {}).textContent || '')
        .replace(/\s+/g, ' ').trim();
      items.push({
        id: m[1],
        doubanUrl: 'https://movie.douban.com/subject/' + m[1] + '/',
        title: title || ('条目 ' + m[1]),
        stars: stars >= 1 && stars <= 5 ? stars : 0,
        date: date.trim(),
        comment: comment.trim()
      });
    });
    const nextA = doc.querySelector('span.next a[href*="start="]');
    return { items, hasNext: !!nextA };
  }

  async function scrapeList(uid, status, st) {
    let start = 0, stride = 30, count = 0;
    const out = [];
    while (true) {
      if (cancelled) return out;
      const url = `https://movie.douban.com/people/${uid}/${status}?start=${start}&sort=time&mode=detail`;
      let html;
      try {
        html = await fetch(url, { credentials: 'same-origin' }).then((r) => r.text());
      } catch (e) {
        pushLog(st, `抓取失败（${status} start=${start}），10 秒后重试`);
        await saveState(st);
        await sleep(10000);
        continue;
      }
      if (/有异常请求来自您的/.test(html) || /accounts\.douban\.com/.test(html)) {
        pushLog(st, '豆瓣触发风控/要求登录，迁移已暂停。请稍后或重新登录后再继续');
        cancelled = true;
        await write({ [KEY_CANCEL]: true });
        return out;
      }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const { items, hasNext } = parsePage(doc);
      if (!items.length) break;
      stride = Math.max(stride, items.length);
      items.forEach((it) => { it.doubanStatus = status; });
      out.push(...items);
      count += items.length;
      st.phase = 'scrape';
      st.scrapeCount = count;
      pushLog(st, `抓取「${{ collect: '看过', wish: '想看', do: '在看' }[status]}」已 ${count} 条`);
      await saveState(st);
      if (!hasNext) break;
      start += stride;
      await sleep(jitter(PAGE_DELAY));
    }
    return out;
  }

  async function runMigration(resume) {
    let S = (await readOne(KEY)) || blank();
    const canResume = resume && S.phase === 'paused' && S.scrapedDone;

    if (!canResume) {
      const fresh = blank();
      fresh.uid = S.uid || fresh.uid;
      await write({ [KEY]: fresh, [KEY_MARKS]: null });
      S = fresh;
    } else {
      S.cancel = false;
    }
    cancelled = false;
    await write({ [KEY_CANCEL]: false });

    // 1. 抓取阶段（collect → wish → do，重复条目以先抓到的为准）
    if (!canResume) {
      if (!S.uid) S.uid = uidFromPath();
      S.phase = 'scrape';
      S.scrapedDone = false;
      pushLog(S, '开始抓取豆瓣标记…');
      await saveState(S);

      const seen = {};
      const all = [];
      for (const status of ['collect', 'wish', 'do']) {
        const list = await scrapeList(S.uid, status, S);
        if (cancelled) break;
        list.forEach((it) => { if (!seen[it.id]) { seen[it.id] = 1; all.push(it); } });
      }
      if (cancelled) {
        S.phase = 'paused';
        pushLog(S, '已暂停（抓取未完成，下次从头重抓）');
        await saveState(S);
        return;
      }
      S.total = all.length;
      S.idx = 0;
      S.results = { synced: 0, same: 0, missing: 0, failed: 0 };
      S.scrapedDone = true;
      S.phase = 'sync';
      pushLog(S, `共抓到 ${all.length} 条，开始同步到 NeoDB…`);
      await write({ [KEY]: S, [KEY_MARKS]: all });
    } else {
      S.phase = 'sync';
      pushLog(S, `继续迁移（第 ${S.idx}/${S.total} 条）`);
      await saveState(S);
    }

    // 2. 同步阶段（断点续传：从 S.idx 继续）
    const marks = (await readOne(KEY_MARKS)) || [];
    while (S.idx < marks.length) {
      if (cancelled) {
        S.phase = 'paused';
        pushLog(S, `已暂停于 ${S.idx}/${S.total}，可随时继续`);
        await saveState(S);
        return;
      }
      const mark = marks[S.idx];
      const res = await new Promise((res2) => {
        try {
          chrome.runtime.sendMessage({
            type: 'd2n-migrate-one',
            payload: {
              doubanUrl: mark.doubanUrl,
              title: mark.title,
              shelf: { collect: 'complete', wish: 'wishlist', do: 'progress' }[mark.doubanStatus],
              rating: mark.stars,
              comment: mark.comment,
              date: mark.date
            }
          }, (r) => {
            if (chrome.runtime.lastError) res2({ status: 'failed', message: '扩展后台不可用' });
            else res2(r || { status: 'failed', message: '无响应' });
          });
        } catch (e) { res2({ status: 'failed', message: '扩展后台不可用' }); }
      });

      if (res.status === 'synced') {
        S.results.synced++;
        pushLog(S, `+ ${mark.title}（${mark.date || '无日期'}）`);
      } else if (res.status === 'failed') {
        S.results.failed++;
        pushLog(S, `✗ ${mark.title}：${res.message || '失败'}`);
      } else if (res.status === 'same') S.results.same++;
      else if (res.status === 'missing') S.results.missing++;

      S.idx++;
      await saveState(S);   // 轻量状态（不含 marks），每条一存
      await sleep(jitter(ITEM_DELAY));
    }

    S.phase = 'done';
    pushLog(S, `迁移完成：新增 ${S.results.synced}，已一致 ${S.results.same}，` +
      `无法收录 ${S.results.missing}，失败 ${S.results.failed}`);
    await saveState(S);
    await write({ [KEY_MARKS]: null, [KEY_CANCEL]: false });   // 释放存储
  }

  // ---- 启动入口 ----

  function isPeopleMarksPage() {
    return /^\/people\/[^/]+\/(collect|wish|do)/.test(location.pathname);
  }
  function uidFromPath() {
    const m = /^\/people\/([^/]+)\//.exec(location.pathname);
    return m ? m[1] : '';
  }

  async function onKick() {
    const kick = (await readOne(KEY_KICK)) || {};
    if (!kick.ts || Date.now() - kick.ts > 120000) return;
    const st = (await readOne(KEY)) || blank();
    const resumeOk = kick.mode === 'resume' && st.phase === 'paused' && st.scrapedDone;
    if (!isPeopleMarksPage()) {
      // 停在别的豆瓣页：跳到个人标记页，加载后 kick 信号仍有效（2 分钟内）
      location.href = PEOPLE_URL;
      return;
    }
    if (resumeOk) {
      st.uid = uidFromPath();
      await write({ [KEY]: st, [KEY_KICK]: null });
      runMigration(true);
    } else {
      const fresh = blank();
      fresh.uid = uidFromPath();
      await write({ [KEY]: fresh, [KEY_MARKS]: null, [KEY_KICK]: null });
      runMigration(false);
    }
  }

  chrome.storage.local.get(KEY_KICK, () => onKick());   // 页面加载：检查 kick 信号
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'd2n-migrate-kick') onKick();
  });
})();
