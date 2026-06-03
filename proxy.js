/**
 * BUAA iClass 本地代理服务
 * 同时提供前端页面 + API 代理（直连 iClass）
 * 通过 cloudflared tunnel 暴露到公网
 * 运行: node proxy.js
 */
import http from 'http';
import https from 'https';

const PORT = 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function logReq(...args) { const ts = new Date().toISOString().slice(11, 23); console.log(`[${ts}]`, ...args); }

// 简单的同步 cookie 存储，按 cookie 自己的 Domain 属性分组
class CookieStore {
  constructor() { this.jar = new Map(); }  // domain (with leading dot or exact) -> Map(name -> value)
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
      // 解析 Domain 属性
      let domain = u.hostname;
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
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    // 收集所有匹配 host 的 cookie：精确匹配 + 以 .domain 形式匹配子域
    const cookies = [];
    for (const [dom, m] of this.jar) {
      const bare = dom.startsWith('.') ? dom.slice(1) : dom;
      if (host === bare || host.endsWith('.' + bare)) {
        for (const [k, v] of m) cookies.push(`${k}=${v}`);
      }
    }
    return cookies.join('; ');
  }
}

// 根据 path 推断端口/协议（2026.06 新版路由）
//  - app/common/get_timestamp    → 8081 (HTTP, 时间戳校准)
//  - eschool/app/course/...      → 8081 (HTTP, 签到)
//  - eschool/app/user/login_buaa → 8346 (HTTPS, 登录)
//  - 其他 /app/...               → 8347 (HTTPS, 课表等)
function pickRoute(path) {
  if (path.includes('/app/common/get_timestamp')) return { port: 8081, https: false };
  if (path.includes('/eschool/app/course/')) return { port: 8081, https: false };
  if (path.includes('/eschool/app/user/login_buaa')) return { port: 8346, https: true };
  return { port: 8347, https: true };
}

// 通用 HTTP 请求：支持 cookie 存储、跟随重定向、强制协议、保留指定 header
// opts: { method, headers, body, cookieStore, keepHeaders (key set), dropCookie (bool) }
// 返回的 res 会被注入 .url = 最终 URL（跟随重定向后）
function rawRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const followChain = (u, lastUrl) => {
      const p = new URL(u);
      const reqHeaders = { ...(opts.headers || {}) };
      if (opts.cookieStore && !opts.dropCookie) {
        const ck = opts.cookieStore.header(u);
        if (ck) reqHeaders['Cookie'] = ck;
      } else if (opts.dropCookie) {
        delete reqHeaders['Cookie'];
      }
      const reqOpts = {
        hostname: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        path: p.pathname + p.search,
        method: opts.method || 'GET',
        headers: reqHeaders,
        rejectUnauthorized: false,
      };
      const req = lib.request(reqOpts, (res) => {
        if (opts.cookieStore && res.headers['set-cookie']) {
          opts.cookieStore.ingest(u, res.headers['set-cookie']);
        }
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          let loc = res.headers.location;
          if (opts.forceHttps && loc.startsWith('http://')) loc = loc.replace('http://', 'https://');
          const next = new URL(loc, u).toString();
          res.resume();
          const newHeaders = {};
          if (opts.keepHeaders) {
            for (const k of opts.keepHeaders) {
              if (opts.headers && opts.headers[k] != null) newHeaders[k] = opts.headers[k];
            }
          }
          followChain(next, next);
          return;
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          res.body = body;
          res.url = lastUrl;
          resolve(res);
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    };
    followChain(urlStr, urlStr);
  });
}

// 在 body 中按 left/right 标签提取字符串
function parseTag(body, left, right) {
  const i = body.indexOf(left);
  if (i < 0) return null;
  const s = i + left.length;
  const e = right ? body.indexOf(right, s) : body.length;
  if (e < 0) return null;
  return body.substring(s, e);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

// 对 iClass / SSO 域发起请求（按 path 自动选端口/协议）
function apiRequest(path, opts = {}) {
  const { port, https } = pickRoute(path);
  const proto = https ? 'https' : 'http';
  const url = `${proto}://iclass.buaa.edu.cn:${port}${path}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://iclass.buaa.edu.cn/',
    'Accept-Encoding': 'identity',
    ...(opts.headers || {}),
  };
  return rawRequest(url, { ...opts, headers, forceHttps: https });
}

// SSO 登录：拿 TGC cookie 到 cookieStore
async function ssoLogin(store, stuId, stuPwd) {
  // 1) 拿 execution
  const r1 = await rawRequest(
    'https://sso.buaa.edu.cn/login?service=' + encodeURIComponent('https://iclass.buaa.edu.cn:8346/'),
    { method: 'GET', headers: { 'User-Agent': UA }, cookieStore: store }
  );
  // 已登录判断：最终 URL 是根路径
  if (r1.statusCode === 200 && r1.url && new URL(r1.url).pathname === '/') {
    return true;
  }
  const execution = parseTag(r1.body, '"execution" value="', '"');
  if (!execution) throw new Error('SSO: 找不到 execution 字段');

  // 2) 提交学号 + 密码
  const form = new URLSearchParams({
    username: stuId,
    password: stuPwd,
    submit: '登录',
    type: 'username_password',
    execution,
    _eventId: 'submit',
  }).toString();
  const r2 = await rawRequest('https://sso.buaa.edu.cn/login', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://sso.buaa.edu.cn/login',
    },
    body: form,
    cookieStore: store,
  });
  if (r2.statusCode >= 400) throw new Error(`SSO 登录失败: HTTP ${r2.statusCode}`);
  // 跳过风险继续登录（如有）
  if (r2.body && r2.body.includes('continueForm')) {
    const exec2 = parseTag(r2.body, '"execution" value="', '"');
    if (!exec2) throw new Error('SSO 风险页: 找不到 execution');
    const form2 = new URLSearchParams({ execution: exec2, _eventId: 'ignoreAndContinue' }).toString();
    const r3 = await rawRequest('https://sso.buaa.edu.cn/login', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://sso.buaa.edu.cn/login',
      },
      body: form2,
      cookieStore: store,
    });
    if (r3.statusCode >= 400) throw new Error(`SSO 风险页失败: HTTP ${r3.statusCode}`);
  }
  return true;
}

// 通过 TGC 调 ?type=jumpMyCenter 拿 loginName
async function fetchLoginName(store) {
  // 调试：打印发送的 cookie
  logReq('  cookie sent to iClass:', store.header('https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter'));
  const r = await rawRequest(
    'https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter',
    {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Referer': 'https://iclass.buaa.edu.cn/' },
      cookieStore: store,
    }
  );
  const url = r.url || '';
  const ln = parseTag(url, 'loginName=', '&');
  if (!ln) {
    logReq('LOGINNAME missing. status=', r.statusCode, 'url=', url);
    logReq('  body[:500]=', (r.body || '').slice(0, 500));
    logReq('  store jar keys:', Array.from(store.jar.keys()).map(h => `${h}:[${Array.from(store.jar.get(h) || []).map(([k]) => k).join(',')}]`).join(' '));
    throw new Error('未能从 iClass 拿到 loginName（SSO 未登录？）');
  }
  return ln;
}

// 用 loginName 调 login_buaa.do 拿 id
async function fetchClassId(loginName) {
  const qs = new URLSearchParams({
    phone: loginName,
    password: '',
    verificationType: '2',
    verificationUrl: '',
    userLevel: '1',
  }).toString();
  const path = `/eschool/app/user/login_buaa.do?${qs}`;
  const r = await apiRequest(path, { method: 'GET' });
  logReq('LOGIN_BUAA status=', r.statusCode, 'body[:200]=', (r.body || '').slice(0, 200));
  const id = parseTag(r.body, '"id":"', '"');
  if (!id) throw new Error('login_buaa.do 响应中找不到 id');
  return id;
}

// 取服务器时间戳（毫秒）
async function fetchServerTimestamp(sessionId) {
  const r = await apiRequest('/app/common/get_timestamp.action', {
    method: 'POST',
    headers: { 'Sessionid': sessionId },
  });
  logReq('TIMESTAMP status=', r.statusCode, 'body[:200]=', (r.body || '').slice(0, 200));
  if (r.statusCode !== 200) throw new Error(`get_timestamp HTTP ${r.statusCode}`);
  const ts = parseTag(r.body, '"timestamp":', '}');
  if (!ts) throw new Error('get_timestamp 响应缺 timestamp 字段');
  return ts.trim();
}

// 课表查询
async function fetchSchedule(sessionId, id, dateStr) {
  const qs = new URLSearchParams({ dateStr, id }).toString();
  const path = `/app/course/get_stu_course_sched.action?${qs}`;
  const r = await apiRequest(path, {
    method: 'POST',
    headers: { 'Sessionid': sessionId, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  logReq('SCHEDULE date=', dateStr, 'status=', r.statusCode);
  return { status: r.statusCode, body: r.body || '' };
}

// 签到
async function doCheckin(sessionId, id, courseSchedId) {
  // 1) 服务器时间戳
  const ts = await fetchServerTimestamp(sessionId);
  // 2) 签到（path 里有 eschool 前缀，端口走 8081）
  const qs = new URLSearchParams({ courseSchedId, timestamp: ts, id }).toString();
  const path = `/eschool/app/course/stu_scan_sign.action?${qs}`;
  const r = await apiRequest(path, {
    method: 'POST',
    headers: { 'Sessionid': sessionId, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  logReq('SIGN status=', r.statusCode, 'body[:200]=', (r.body || '').slice(0, 200));
  return { status: r.statusCode, body: r.body || '', ts };
}

// ── 前端 HTML ─────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BUAA 课程签到</title>
<style>
:root{--t:#3498db;--td:#2980b9;--s:#2ecc71;--e:#e74c3c;--bg1:#f5f7fa;--bg2:#e4edf5;--card:rgba(255,255,255,.9);--bdr:rgba(52,152,219,.2);--txt:#2c3e50;--muted:#7f8c8d;--r:12px;--sh:0 8px 32px rgba(52,152,219,.12)}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,var(--bg1),var(--bg2));display:flex;justify-content:center;align-items:flex-start;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--txt)}
.card{width:100%;max-width:560px;background:var(--card);backdrop-filter:blur(20px);border-radius:20px;box-shadow:var(--sh);border:1px solid var(--bdr);padding:36px 32px;margin-top:20px}
.header{text-align:center;margin-bottom:28px}
.logo{width:64px;height:64px;margin:0 auto 12px;background:linear-gradient(135deg,var(--t),var(--td));border-radius:16px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(52,152,219,.3)}
.logo svg{width:36px;height:36px}
h1{font-size:24px;font-weight:700;background:linear-gradient(90deg,var(--t),var(--td));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.subtitle{font-size:13px;color:var(--muted)}
.api-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 12px;border-radius:20px;margin-bottom:20px}
.api-status.online{background:rgba(46,204,113,.1);color:#27ae60}
.api-status.offline{background:rgba(231,76,60,.1);color:#c0392b}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.collapse{background:linear-gradient(135deg,rgba(52,152,219,.06),rgba(52,152,219,.03));border:1px solid var(--bdr);border-radius:var(--r);padding:14px 16px;font-size:13px;color:var(--muted);margin-bottom:24px;line-height:1.8}
.collapse summary{cursor:pointer;outline:none;font-weight:600;color:var(--t);user-select:none}
.collapse summary:hover{color:var(--td)}
.form-group{margin-bottom:16px}
label{display:block;font-size:13px;font-weight:500;color:var(--muted);margin-bottom:6px}
input,select{width:100%;padding:12px 16px;border:1.5px solid #dce4ed;border-radius:var(--r);font-size:15px;background:rgba(255,255,255,.8);transition:all .25s;color:var(--txt)}
input:focus,select:focus{border-color:var(--t);outline:none;box-shadow:0 0 0 3px rgba(52,152,219,.15);background:#fff}
input::placeholder{color:#bdc3c7}
.btn-row{display:flex;gap:12px;margin-top:20px}
button{flex:1;padding:13px 16px;border:none;border-radius:var(--r);font-size:15px;font-weight:600;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-primary{background:linear-gradient(135deg,var(--t),var(--td));color:#fff;box-shadow:0 4px 12px rgba(52,152,219,.3)}
.btn-primary:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 20px rgba(52,152,219,.4)}
.btn-signin{background:linear-gradient(135deg,#95a5a6,#7f8c8d);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.btn-signin.active{background:linear-gradient(135deg,var(--s),#27ae60);box-shadow:0 4px 12px rgba(46,204,113,.3)}
.btn-signin:hover:not(:disabled){transform:translateY(-2px)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none!important}
.spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:none}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{margin-top:16px;padding:12px 16px;border-radius:var(--r);font-size:13px;text-align:center;opacity:0;transform:translateY(-8px);transition:all .3s}
.msg.show{opacity:1;transform:translateY(0)}
.msg.success{background:rgba(46,204,113,.12);color:#27ae60;border:1px solid rgba(46,204,113,.3)}
.msg.error{background:rgba(231,76,60,.1);color:#c0392b;border:1px solid rgba(231,76,60,.25)}
.course-list{margin-top:16px;max-height:300px;overflow-y:auto;border-radius:var(--r);border:1.5px solid var(--bdr)}
.course-list::-webkit-scrollbar{width:6px}
.course-list::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px}
.course-item{padding:12px 16px;border-bottom:1px solid var(--bdr);cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:12px}
.course-item:last-child{border-bottom:none}
.course-item:hover{background:rgba(52,152,219,.05)}
.course-item.selected{background:rgba(52,152,219,.1);border-left:3px solid var(--t)}
.course-item.signed{opacity:.6;cursor:not-allowed}
.radio{width:18px;height:18px;border:2px solid var(--bdr);border-radius:50%;flex-shrink:0;transition:all .15s}
.course-item.selected .radio{border-color:var(--t);background:var(--t);box-shadow:inset 0 0 0 3px #fff}
.course-item.signed .radio{border-color:var(--s);background:var(--s)}
.info{flex:1;min-width:0}
.name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail{font-size:12px;color:var(--muted);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500}
.badge-s{background:rgba(46,204,113,.15);color:#27ae60}
.badge-u{background:rgba(231,76,60,.1);color:#c0392b}
.footer{text-align:center;font-size:12px;color:#bdc3c7;margin-top:24px;line-height:1.8}
.footer a{color:var(--t);text-decoration:none}
.footer a:hover{text-decoration:underline}
.divider{height:1px;background:linear-gradient(90deg,transparent,#e0e7ed,transparent);margin:24px 0}
@media(max-width:480px){.card{padding:24px 16px}.btn-row{flex-direction:column}h1{font-size:20px}}
</style>
</head>
<body>
<div class="card">
<div class="header">
<div class="logo"><svg viewBox="0 0 36 36" fill="none"><rect x="2" y="2" width="14" height="14" rx="3" fill="white" fill-opacity=".9"/><rect x="20" y="2" width="14" height="14" rx="3" fill="white" fill-opacity=".7"/><rect x="2" y="20" width="14" height="14" rx="3" fill="white" fill-opacity=".7"/><rect x="20" y="20" width="14" height="14" rx="3" fill="white" fill-opacity=".9"/><circle cx="27" cy="9" r="4" fill="white" fill-opacity=".5"/><path d="M25 9l1.5 1.5L29 8" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>BUAA 课程签到</h1>
<p class="subtitle">输入学号，查询今日课程并签到</p>
</div>
<div id="apiStatus" class="api-status offline"><span class="dot"></span><span>检测连接中...</span></div>
<details class="collapse"><summary>使用方法 / 免责声明</summary>
<p>1. 填写真实学号，点击「查询课程」。</p>
<p>2. 从列表中选择要签到的课程，点击「签到」。</p>
<p>3. 签到窗口：课程开始前10分钟 至 课程结束。</p>
<p>4. 本项目仅用于个人学习与研究交流，请勿用于违反学校规定的用途。</p>
<p>5. 使用本工具造成的一切后果由使用者自行承担。</p>
</details>
<div class="form-group"><label>学号</label><input id="sid" placeholder="请输入学号" autocomplete="off" spellcheck="false"></div>
<div class="form-group"><label>统一认证密码（不填可粘贴 loginName）</label><input id="spwd" type="password" placeholder="校园网统一认证密码（可留空）" autocomplete="off"></div>
<div class="form-group"><label>已登录的 loginName（可选）</label><input id="sloginname" placeholder="从浏览器 SSO 后的 URL 粘贴 loginName= 后面的值" autocomplete="off" spellcheck="false"></div>
<div class="form-group"><label>姓名（可不填）</label><input id="sname" placeholder="请输入姓名（可不填）" autocomplete="off" spellcheck="false"></div>
<div class="form-group"><label>查询日期</label><input type="date" id="dateInput"></div>
<div class="btn-row">
<button class="btn-primary" id="getBtn"><span class="spinner" id="qspin"></span><span id="qtxt">查询课程</span></button>
<button class="btn-signin" id="signBtn" disabled><span class="spinner" id="sspin"></span><span id="stxt">签到</span></button>
</div>
<div id="courseList" class="course-list" style="display:none"></div>
<div id="msg" class="msg"></div>
<div class="divider"></div>
<div class="footer"><div>基于 BUAA iClass API 构建 · 参考自 <a href="https://github.com/theFool-wn" target="_blank">GitHub</a></div><div>仅供学习交流，请合理使用</div></div>
</div>
<script>
let uid='',sid='',courses=[],sel=null;
const $=(s)=>document.querySelector(s);
const qspin=$('#qspin'),sspin=$('#sspin'),qtxt=$('#qtxt'),stxt=$('#stxt');
const sidEl=$('#sid'),snameEl=$('#sname'),dateEl=$('#dateInput');
const msgEl=$('#msg'),listEl=$('#courseList'),apiEl=$('#apiStatus'),signBtn=$('#signBtn'),getBtn=$('#getBtn');
function resetDate(){
  const d=new Date();
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  dateEl.value=y+'-'+m+'-'+day;
}
resetDate();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resetDate()});

async function check(){
  try{
    const r=await fetch('/api/status');
    if(r.ok){apiEl.className='api-status online';apiEl.querySelector('span:last-child').textContent='服务正常';return}
  }catch{}
  apiEl.className='api-status offline';apiEl.querySelector('span:last-child').textContent='连接失败';
}
check();

function msg(t,m='success'){msgEl.textContent=t;msgEl.className='msg '+m+' show';clearTimeout(msgEl._t);msgEl._t=setTimeout(()=>msgEl.classList.remove('show'),5e3)}
function load(b,spn,txtEl,on){b.disabled=on;spn.style.display=on?'inline-block':'none';txtEl.textContent=on?(b.id==='getBtn'?'查询中...':'签到中...'):''}
function tm(iso){return iso?iso.substring(11,16):'--:--'}

async function login(stuId, stuPwd, loginName){
  const body={};
  if(loginName) body.loginName=loginName;
  else if(stuId && stuPwd){ body.stuId=stuId; body.stuPwd=stuPwd; }
  else throw new Error('请填写学号与统一认证密码（或粘贴已登录的 loginName）');
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.status!=='0')throw new Error(d.message||'登录失败');
  return d.result;
}

async function query(){
  const id=sidEl.value.trim(),date=dateEl.value.replace(/-/g,'');
  if(!id)return msg('请填写学号','error');
  load(getBtn,qspin,qtxt,true);
  try{
    const pwd=document.getElementById('spwd')?.value||'';
    const ln=document.getElementById('sloginname')?.value||'';
    const {id:uid2,sessionId:sid2}=await login(id, pwd, ln);uid=uid2;sid=sid2;
    // 暂存到 localStorage，方便自动签到 daemon 也能用
    try{ localStorage.setItem('buaa_session', JSON.stringify({uid, sid, stuId:id})); }catch{}
    const r=await fetch('/api/schedule?dateStr='+date+'&userId='+encodeURIComponent(uid)+'&sessionId='+encodeURIComponent(sid));
    const d=await r.json();
    if(d.status!=='0')return msg(d.message||'查询失败','error');
    courses=d.result||[];
    if(!courses.length){listEl.style.display='none';return msg(d.message||'今日无课程','success')}
    render(courses);msg('查询成功，共 '+courses.length+' 节课','success');
  }catch(e){msg(e.message||'网络请求失败','error')}
  finally{load(getBtn,qspin,qtxt,false)}
}

function render(list){
  listEl.innerHTML='';listEl.style.display='block';
  const now=new Date();
  list.forEach((item,idx)=>{
    const begin=item.classBeginTime?new Date(item.classBeginTime):null;
    const end=item.classEndTime?new Date(item.classEndTime):null;
    const tenMinBefore=begin?new Date(begin.getTime()-6e5):null;
    const signed=item.signStatus==='1';
    const inWin=!signed&&begin&&end&&now>=tenMinBefore&&now<=end;
    const el=document.createElement('div');
    el.className='course-item'+(signed?' signed':'');
    el.innerHTML='<div class="radio"></div><div class="info"><div class="name">'+(item.courseName||'未知课程')+'</div><div class="detail"><span>'+tm(item.classBeginTime)+' - '+tm(item.classEndTime)+'</span><span>'+(item.classroomName||'')+'</span><span>'+(item.teacherName||'')+'</span>'+(signed?'<span class="badge badge-s">已签到</span>':'<span class="badge badge-u">'+(inWin?'可签到':'未开始')+'</span>')+'</div></div>';
    if(!signed)el.addEventListener('click',()=>pick(idx,el));
    listEl.appendChild(el);
  });
}

function pick(idx,el){
  document.querySelectorAll('.course-item').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
  sel={...courses[idx],uid,sid};
  signBtn.disabled=false;signBtn.classList.add('active');
}

async function sign(){
  if(!sel)return;
  const item=sel;load(signBtn,sspin,stxt,true);
  try{
    const r=await fetch('/api/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseSchedId:item.id,userId:item.uid,classBeginTime:item.classBeginTime,classEndTime:item.classEndTime,sessionId:item.sid})});
    const d=await r.json();
    if(d.status==='0'){
      const s=document.querySelector('.course-item.selected');
      if(s){s.classList.add('signed');const b=s.querySelector('.badge-u');if(b){b.className='badge badge-s';b.textContent='已签到'}s.querySelector('.radio').style.cssText='border-color:var(--s);background:var(--s)';s.classList.remove('selected')}
      sel=null;signBtn.disabled=true;signBtn.classList.remove('active');
      msg('签到成功','success');
    }else{msg(d.message||'签到失败','error')}
  }catch{msg('网络错误','error')}
  finally{load(signBtn,sspin,stxt,false)}
}

getBtn.addEventListener('click',query);
signBtn.addEventListener('click',sign);
sidEl.addEventListener('input',()=>{courses=[];sel=null;listEl.style.display='none';signBtn.disabled=true;signBtn.classList.remove('active')});
[sidEl,snameEl].forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')query()}));
</script>
</body>
</html>`;

// ── 服务器 ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 前端
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // API: 状态
  if (path === '/api/status') {
    return sendJson(res, { ok: true, ts: Date.now() });
  }

  // API: 登录（POST + JSON {stuId, stuPwd?, loginName?}）
  //  - 有 stuId+stuPwd：走完整 SSO 登录 → ?type=jumpMyCenter 拿 loginName → login_buaa.do
  //  - 有 loginName：直接调 login_buaa.do（用户在浏览器已登录 SSO 时可用）
  if (path === '/api/login' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJson(res, { status: '1', message: '请求体解析失败' }, 400); }
    const { stuId, stuPwd, loginName } = parsed;
    try {
      let ln = (loginName || '').trim();
      if (!ln) {
        if (!stuId || !stuPwd) {
          return sendJson(res, { status: '1', message: '需要 stuId+stuPwd 或 loginName' }, 400);
        }
        const store = new CookieStore();
        logReq('SSO_LOGIN start', stuId);
        await ssoLogin(store, stuId, stuPwd);
        logReq('SSO_LOGIN done, fetching loginName...');
        ln = await fetchLoginName(store);
        logReq('LOGIN_NAME', ln);
      }
      const id = await fetchClassId(ln);
      logReq('LOGIN_OK', { id, sessionIdLen: ln.length });
      return sendJson(res, { status: '0', result: { id, sessionId: ln, userName: stuId || '' } });
    } catch (e) {
      logReq('LOGIN_ERR', e.message);
      return sendJson(res, { status: '1', message: e.message || '登录失败' }, 502);
    }
  }

  // API: 查课表（GET ?dateStr=xxx&userId=xxx&sessionId=xxx）
  if (path === '/api/schedule' && req.method === 'GET') {
    const dateStr = url.searchParams.get('dateStr');
    const userId = url.searchParams.get('userId');
    const sessionId = url.searchParams.get('sessionId');
    if (!dateStr || !userId || !sessionId) return sendJson(res, { status: '1', message: '缺少必要参数' }, 400);
    try {
      const { status, body } = await fetchSchedule(sessionId, userId, dateStr);
      if (status !== 200) return sendJson(res, { status: '1', message: `HTTP ${status}` }, 502);
      const data = JSON.parse(body);
      logReq('SCHEDULE_RESP', dateStr, 'STATUS=' + data.STATUS + (data.ERRMSG ? ', ERR=' + data.ERRMSG : ''));
      const errMsg = data.ERRMSG || data.message;
      const errCode = data.ERRCODE;
      const isBizError = errMsg || (errCode != null && (errCode == 1 || errCode == 2));

      if (data.STATUS === '0' || data.status === '0') {
        const courses = Array.isArray(data.result) ? data.result : [];
        if (courses.length > 0) {
          return sendJson(res, { status: '0', result: courses });
        }
        return sendJson(res, { status: '0', result: [], message: '今日无课程' });
      }
      if (isBizError || data.STATUS === '2' || data.STATUS == 2) {
        return sendJson(res, { status: '0', result: [], message: '今日无课程' });
      }
      let failMsg = errMsg || '查询失败，请稍后重试';
      if (errMsg && (errMsg.includes('无权') || errMsg.includes('权限') || errMsg.includes('登录') || errMsg.includes('未登录') || errMsg.includes('会话'))) {
        failMsg = '会话已过期，请重新查询';
      } else if (errMsg && (errMsg.includes('超时') || errMsg.includes('timeout'))) {
        failMsg = '请求超时，请检查网络后重试';
      } else if (errMsg) {
        failMsg = errMsg;
      }
      return sendJson(res, { status: '1', message: failMsg });
    } catch (e) {
      return sendJson(res, { status: '1', message: '网络请求失败: ' + e.message }, 502);
    }
  }

  // API: 签到（POST + JSON {courseSchedId, userId, classBeginTime, classEndTime, sessionId}）
  if (path === '/api/sign' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJson(res, { status: '1', message: '请求体解析失败' }, 400); }
    const { courseSchedId, userId, classBeginTime, classEndTime, sessionId } = parsed;
    if (!courseSchedId || !userId || !sessionId) return sendJson(res, { status: '1', message: '缺少必要参数' }, 400);

    if (classBeginTime && classEndTime) {
      const now = Date.now();
      const begin = new Date(classBeginTime).getTime();
      const end = new Date(classEndTime).getTime();
      const tenMinBefore = begin - 10 * 60 * 1000;
      if (now < tenMinBefore) return sendJson(res, { status: '1', message: '签到尚未开始，请在课程开始前10分钟内签到' });
      if (now > end) return sendJson(res, { status: '1', message: '课程已结束，无法签到' });
    }

    try {
      const { status, body: respBody, ts } = await doCheckin(sessionId, userId, courseSchedId);
      if (status !== 200) return sendJson(res, { status: '1', message: `HTTP ${status}` }, 502);
      const data = JSON.parse(respBody);
      if (data.STATUS === '0' || data.status === '0') {
        const stuSignStatus = data.result?.stuSignStatus ?? data.result?.stuSignId ?? '';
        return sendJson(res, { status: '0', message: '签到成功', ts, stuSignStatus });
      }
      return sendJson(res, { status: '1', message: data.ERRMSG || data.message || '签到失败' });
    } catch (e) {
      return sendJson(res, { status: '1', message: '网络请求失败: ' + e.message }, 502);
    }
  }

  sendJson(res, { status: '1', message: '未知的路径' }, 404);
});

server.listen(PORT, () => {
  console.log(`✅  BUAA 签到服务已启动: http://localhost:${PORT}`);
  console.log(`   访问 http://localhost:${PORT} 查看前端`);
});
