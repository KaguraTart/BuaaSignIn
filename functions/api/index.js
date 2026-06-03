/**
 * Cloudflare Pages Functions - BUAA iClass API Proxy (v5, 2026-06 改造)
 *
 * 流程:
 *   1. /api/login   POST {stuId, stuPwd} 或 {loginName}
 *      - 走完整 SSO 登录 → ?type=jumpMyCenter 拿 loginName
 *      - 再调 login_buaa.do 拿 id
 *      - 返回 {sessionId, id, userName}
 *   2. /api/schedule GET ?dateStr&userId&sessionId
 *      - 课表查询（带 Sessionid header）
 *   3. /api/sign    POST {courseSchedId, userId, sessionId, classBeginTime, classEndTime}
 *      - 服务器时间戳 + 签到
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

// ── 简单 cookie 存储 ───────────────────────────────────────────────
class CookieStore {
  constructor() { this.jar = new Map(); }
  ingest(urlStr, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const u = new URL(urlStr);
    for (const sc of arr) {
      const parts = sc.split(';').map(s => s.trim());
      const first = parts[0];
      const eq = first.indexOf('=');
      if (eq < 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      let domain = u.hostname.toLowerCase();
      for (const p of parts.slice(1)) {
        const [k, ...vs] = p.split('=');
        if (k.toLowerCase() === 'domain' && vs.length) {
          domain = vs.join('=').trim().toLowerCase();
          if (!domain.startsWith('.')) domain = '.' + domain;
        }
      }
      if (!this.jar.has(domain)) this.jar.set(domain, new Map());
      this.jar.get(domain).set(name, value);
    }
  }
  header(urlStr) {
    const host = new URL(urlStr).hostname.toLowerCase();
    const out = [];
    for (const [dom, m] of this.jar) {
      const bare = dom.startsWith('.') ? dom.slice(1) : dom;
      if (host === bare || host.endsWith('.' + bare)) {
        for (const [k, v] of m) out.push(`${k}=${v}`);
      }
    }
    return out.join('; ');
  }
}

function parseTag(body, left, right) {
  const i = body.indexOf(left);
  if (i < 0) return null;
  const s = i + left.length;
  const e = right ? body.indexOf(right, s) : body.length;
  if (e < 0) return null;
  return body.substring(s, e);
}

// 手动跟 redirect 的 fetch（Cookie 跨请求保留）
async function rawFetch(urlStr, opts = {}, store = null) {
  let currentUrl = urlStr;
  for (let i = 0; i < 8; i++) {
    const headers = { ...(opts.headers || {}), 'User-Agent': UA };
    if (store) {
      const ck = store.header(currentUrl);
      if (ck) headers['Cookie'] = ck;
    }
    const res = await fetch(currentUrl, { ...opts, headers, redirect: 'manual' });
    if (store) {
      const sc = res.headers.get('set-cookie');
      if (sc) store.ingest(currentUrl, sc);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      currentUrl = new URL(res.headers.get('location'), currentUrl).toString();
      // 303 强制 GET，其他保留 method
      if (res.status === 303) opts = { ...opts, method: 'GET', body: undefined };
      continue;
    }
    return { res, finalUrl: currentUrl };
  }
  throw new Error('Too many redirects');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// ── SSO 登录 ────────────────────────────────────────────────────────
async function ssoLogin(store, stuId, stuPwd) {
  const ssoUrl = 'https://sso.buaa.edu.cn/login?service=' + encodeURIComponent('https://iclass.buaa.edu.cn:8346/');
  const r1 = await rawFetch(ssoUrl, { method: 'GET' }, store);
  if (r1.finalUrl && new URL(r1.finalUrl).pathname === '/') return; // 已登录
  const execution = parseTag(await r1.res.text(), '"execution" value="', '"');
  if (!execution) throw new Error('SSO: 找不到 execution');

  const form = new URLSearchParams({
    username: stuId, password: stuPwd, submit: '登录',
    type: 'username_password', execution, _eventId: 'submit',
  }).toString();
  const r2 = await rawFetch('https://sso.buaa.edu.cn/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://sso.buaa.edu.cn/login' },
    body: form,
  }, store);
  if (r2.res.status >= 400) throw new Error(`SSO 登录失败: HTTP ${r2.res.status}`);
  // 风险页 continueForm
  if ((await r2.res.clone().text()).includes('continueForm')) {
    const text2 = await r2.res.text();
    const exec2 = parseTag(text2, '"execution" value="', '"');
    if (!exec2) throw new Error('SSO 风险页: 找不到 execution');
    const f2 = new URLSearchParams({ execution: exec2, _eventId: 'ignoreAndContinue' }).toString();
    const r3 = await rawFetch('https://sso.buaa.edu.cn/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://sso.buaa.edu.cn/login' },
      body: f2,
    }, store);
    if (r3.res.status >= 400) throw new Error(`SSO 风险页失败: HTTP ${r3.res.status}`);
  }
}

async function fetchLoginName(store) {
  const r = await rawFetch('https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter', {
    method: 'GET',
    headers: { 'Referer': 'https://iclass.buaa.edu.cn/' },
  }, store);
  const ln = parseTag(r.finalUrl, 'loginName=', '&');
  if (!ln) throw new Error('未能从 iClass 拿到 loginName（SSO 未登录？）');
  return ln;
}

async function fetchClassId(loginName) {
  const qs = new URLSearchParams({
    phone: loginName, password: '',
    verificationType: '2', verificationUrl: '', userLevel: '1',
  }).toString();
  const r = await rawFetch(`https://iclass.buaa.edu.cn:8346/eschool/app/user/login_buaa.do?${qs}`, {
    method: 'GET',
    headers: { 'Referer': 'https://iclass.buaa.edu.cn/' },
  });
  if (r.res.status !== 200) throw new Error(`login_buaa.do HTTP ${r.res.status}`);
  const body = await r.res.text();
  const id = parseTag(body, '"id":"', '"');
  if (!id) throw new Error('login_buaa.do 响应中找不到 id');
  return id;
}

// ── API 处理 ────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  if (pathname === '/api/login') {
    let body;
    try { body = await context.request.json(); } catch { return jsonResponse({ status: '1', message: '请求体解析失败' }, 400); }
    const { stuId, stuPwd, loginName } = body;
    try {
      let ln = (loginName || '').trim();
      if (!ln) {
        if (!stuId || !stuPwd) return jsonResponse({ status: '1', message: '需要 stuId+stuPwd 或 loginName' }, 400);
        const store = new CookieStore();
        await ssoLogin(store, stuId, stuPwd);
        ln = await fetchLoginName(store);
      }
      const id = await fetchClassId(ln);
      return jsonResponse({ status: '0', result: { id, sessionId: ln, userName: stuId || '' } });
    } catch (e) {
      return jsonResponse({ status: '1', message: e.message || '登录失败' }, 502);
    }
  }

  if (pathname === '/api/sign') {
    let body;
    try { body = await context.request.json(); } catch { return jsonResponse({ status: '1', message: '请求体解析失败' }, 400); }
    const { courseSchedId, userId, classBeginTime, classEndTime, sessionId } = body;
    if (!courseSchedId || !userId || !sessionId) return jsonResponse({ status: '1', message: '缺少必要参数' }, 400);

    if (classBeginTime && classEndTime) {
      const now = Date.now();
      const begin = new Date(classBeginTime).getTime();
      const end = new Date(classEndTime).getTime();
      const tenMinBefore = begin - 10 * 60 * 1000;
      if (now < tenMinBefore) return jsonResponse({ status: '1', message: '签到尚未开始' });
      if (now > end) return jsonResponse({ status: '1', message: '课程已结束' });
    }

    try {
      // 1) 服务器时间戳
      const tsRes = await rawFetch('http://iclass.buaa.edu.cn:8081/app/common/get_timestamp.action', {
        method: 'POST',
        headers: { 'Sessionid': sessionId },
      });
      if (tsRes.res.status !== 200) return jsonResponse({ status: '1', message: `get_timestamp HTTP ${tsRes.res.status}` }, 502);
      const tsBody = await tsRes.res.text();
      const ts = parseTag(tsBody, '"timestamp":', '}');
      if (!ts) return jsonResponse({ status: '1', message: 'get_timestamp 响应缺 timestamp' });

      // 2) 签到
      const qs = new URLSearchParams({ courseSchedId, timestamp: ts.trim(), id: userId }).toString();
      const signRes = await rawFetch(`http://iclass.buaa.edu.cn:8081/eschool/app/course/stu_scan_sign.action?${qs}`, {
        method: 'POST',
        headers: { 'Sessionid': sessionId, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (signRes.res.status !== 200) return jsonResponse({ status: '1', message: `签到 HTTP ${signRes.res.status}` }, 502);
      const data = JSON.parse(await signRes.res.text());
      if (data.STATUS === '0' || data.status === '0') {
        return jsonResponse({ status: '0', message: '签到成功', ts: ts.trim(), stuSignStatus: data.result?.stuSignStatus });
      }
      return jsonResponse({ status: '1', message: data.ERRMSG || data.message || '签到失败' });
    } catch (e) {
      return jsonResponse({ status: '1', message: e.message || '网络请求失败' }, 502);
    }
  }

  return jsonResponse({ status: '1', message: '未知的 API 路径' }, 404);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  if (pathname === '/api/status') {
    return jsonResponse({ ok: true, ts: Date.now() });
  }

  if (pathname === '/api/schedule') {
    const dateStr = url.searchParams.get('dateStr');
    const userId = url.searchParams.get('userId');
    const sessionId = url.searchParams.get('sessionId');
    if (!dateStr || !userId || !sessionId) return jsonResponse({ status: '1', message: '缺少必要参数' }, 400);
    try {
      const qs = new URLSearchParams({ dateStr, id: userId }).toString();
      const r = await rawFetch(`https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action?${qs}`, {
        method: 'POST',
        headers: { 'Sessionid': sessionId, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (r.res.status !== 200) return jsonResponse({ status: '1', message: `HTTP ${r.res.status}` }, 502);
      const data = JSON.parse(await r.res.text());
      const errMsg = data.ERRMSG || data.message;
      if (data.STATUS === '0' || data.status === '0') {
        const courses = Array.isArray(data.result) ? data.result : [];
        return jsonResponse({ status: '0', result: courses, message: courses.length ? undefined : '今日无课程' });
      }
      if (data.STATUS === '2') return jsonResponse({ status: '0', result: [], message: '今日无课程' });
      return jsonResponse({ status: '1', message: errMsg || '查询失败' });
    } catch (e) {
      return jsonResponse({ status: '1', message: e.message || '网络请求失败' }, 502);
    }
  }

  return jsonResponse({ status: '1', message: '未知的 API 路径' }, 404);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
