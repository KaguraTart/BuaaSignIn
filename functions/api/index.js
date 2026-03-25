/**
 * Cloudflare Pages Functions - BUAA iClass API Proxy
 *
 * Proxies requests to BUAA iClass system and adds CORS headers,
 * enabling browser-based access from the deployed frontend.
 *
 * Routes (matched by directory structure in functions/):
 *   GET  /api/status   - Health check
 *   GET  /api/login    - Login, params: phone
 *   GET  /api/schedule - Query schedule, params: dateStr, userId, sessionId
 *   POST /api/sign     - Sign in, body: { courseSchedId, userId }
 */

const ICRAFT_LOGIN_URL = 'https://iclass.buaa.edu.cn:8347/app/user/login.action';
const ICRAFT_SCHEDULE_URL = 'https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action';
const ICRAFT_SIGN_URL = 'http://iclass.buaa.edu.cn:8081/app/course/stu_scan_sign.action';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function makeJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Health check
  if (pathname === '/api/status') {
    return makeJsonResponse({ ok: true, ts: Date.now() });
  }

  // Login
  if (pathname === '/api/login' && request.method === 'GET') {
    const phone = url.searchParams.get('phone');
    if (!phone) return makeJsonResponse({ status: '1', message: '缺少 phone 参数' }, 400);

    try {
      const loginUrl = new URL(ICRAFT_LOGIN_URL);
      loginUrl.searchParams.set('phone', phone);
      loginUrl.searchParams.set('password', '');
      loginUrl.searchParams.set('userLevel', '1');
      loginUrl.searchParams.set('verificationType', '2');
      loginUrl.searchParams.set('verificationUrl', '');

      const res = await fetch(loginUrl.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return makeJsonResponse({ status: '1', message: 'iClass 响应解析失败' }, 502); }

      if (json.STATUS === '0' || json.status === '0') {
        return makeJsonResponse({ status: '0', result: { id: json.result?.id, sessionId: json.result?.sessionId } });
      }
      return makeJsonResponse({ status: '1', message: json.message || '登录失败' }, 200);
    } catch (e) {
      return makeJsonResponse({ status: '1', message: '网络请求失败' }, 502);
    }
  }

  // Schedule
  if (pathname === '/api/schedule' && request.method === 'GET') {
    const dateStr = url.searchParams.get('dateStr');
    const userId = url.searchParams.get('userId');
    const sessionId = url.searchParams.get('sessionId');

    if (!dateStr || !userId || !sessionId) {
      return makeJsonResponse({ status: '1', message: '缺少必要参数' }, 400);
    }

    try {
      const scheduleUrl = new URL(ICRAFT_SCHEDULE_URL);
      scheduleUrl.searchParams.set('dateStr', dateStr);
      scheduleUrl.searchParams.set('id', userId);

      const res = await fetch(scheduleUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'sessionId': sessionId,
        },
      });

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return makeJsonResponse({ status: '1', message: 'iClass 响应解析失败' }, 502); }

      if (json.STATUS === '0' || json.status === '0') {
        return makeJsonResponse({ status: '0', result: json.result || [] });
      }
      return makeJsonResponse({ status: '1', message: json.message || '查询失败' }, 200);
    } catch (e) {
      return makeJsonResponse({ status: '1', message: '网络请求失败' }, 502);
    }
  }

  // Sign In
  if (pathname === '/api/sign' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return makeJsonResponse({ status: '1', message: '请求体解析失败' }, 400);
    }

    const { courseSchedId, userId: uid } = body;
    if (!courseSchedId || !uid) {
      return makeJsonResponse({ status: '1', message: '缺少必要参数' }, 400);
    }

    try {
      const timestamp = Date.now();
      const signUrl = `${ICRAFT_SIGN_URL}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}`;

      const res = await fetch(signUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `id=${encodeURIComponent(uid)}`,
      });

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return makeJsonResponse({ status: '1', message: 'iClass 响应解析失败' }, 502); }

      if (json.STATUS === '0' || json.status === '0') {
        return makeJsonResponse({ status: '0', message: '签到成功' });
      }
      return makeJsonResponse({ status: '1', message: json.message || '签到失败' }, 200);
    } catch (e) {
      return makeJsonResponse({ status: '1', message: '网络请求失败' }, 502);
    }
  }

  return makeJsonResponse({ status: '1', message: '未知的 API 路径' }, 404);
}
