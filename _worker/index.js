/**
 * BUAA iClass Sign-In - Cloudflare Worker
 * 同时提供前端页面 + API 代理
 *
 * 2026-04-22 修复: 添加 timestamp offset 二分搜索，参考 buaasign_daemon.py
 * iClass 扫码签到接口对时间戳有校验，没有精确 offset 会报「参数错误」
 */

const ICRAFT_LOGIN = 'https://abstracts-homepage-facial-teens.trycloudflare.com/app/user/login.action';
const ICRAFT_SCHEDULE = 'https://abstracts-homepage-facial-teens.trycloudflare.com/app/course/get_stu_course_sched.action';
const ICRAFT_SIGN = 'https://abstracts-homepage-facial-teens.trycloudflare.com/iclass/app/course/stu_scan_sign.action';

// Offset 搜索范围（毫秒，与 daemon.py 保持一致）
const OFFSET_MIN = -15000;
const OFFSET_MAX = -1000;

// 缓存 offset 到 Worker KV（跨请求复用）
// 如果没有 KV，则用内存缓存（单 Worker 实例内有效）
let _cachedOffset = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * 单次签到请求（用于 offset 搜索）
 */
async function doSignOnce(sessionId, userId, courseSchedId, timestamp) {
  const signUrl = `${ICRAFT_SIGN}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}`;
  const res = await fetch(signUrl, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 wxwork/4.1.22 MicroMessenger/7.0.1 NetType/WIFI Language/zh ColorScheme/Light',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sessionid': sessionId,
    },
    body: `id=${encodeURIComponent(userId)}`,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: '1', message: '响应解析失败' }; }
}

/**
 * 判断是否为 offset 相关错误
 */
function isOffsetError(msg) {
  return msg && (msg.includes('参数错误') || msg.includes('二维码已失效') || msg.includes('已失效'));
}

/**
 * 二分搜索找有效的 timestamp offset
 */
async function binarySearchOffset(sessionId, userId, courseSchedId, baseTs) {
  let lo = OFFSET_MIN, hi = OFFSET_MAX;

  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    const data = await doSignOnce(sessionId, userId, courseSchedId, String(baseTs + mid));
    const status = data.STATUS || data.status || '';
    const msg = data.ERRMSG || data.message || '';

    if (status === '0') return mid;

    if (msg.includes('参数错误')) {
      hi = mid;
    } else if (msg.includes('二维码已失效') || msg.includes('已失效')) {
      lo = mid;
    } else {
      // 非 offset 错误，说明接口本身有问题，停止搜索
      console.log(`[offset搜索] 非offset错误: ${msg}`);
      return null;
    }
  }

  // 尝试边界值
  for (const off of [lo, lo + 1, hi - 1, hi]) {
    if (off < OFFSET_MIN || off > OFFSET_MAX) continue;
    const data = await doSignOnce(sessionId, userId, courseSchedId, String(baseTs + off));
    if ((data.STATUS === '0' || data.status === '0')) return off;
  }
  return null;
}

/**
 * 带 offset 补偿的签到（先试缓存，再二分搜索）
 */
async function doSignWithOffset(sessionId, userId, courseSchedId) {
  const baseTs = Date.now();

  // 优先用缓存的 offset
  if (_cachedOffset !== null) {
    const data = await doSignOnce(sessionId, userId, courseSchedId, String(baseTs + _cachedOffset));
    const status = data.STATUS || data.status || '';
    const msg = data.ERRMSG || data.message || '';

    if (status === '0') return { offset: _cachedOffset, data };
    if (!isOffsetError(msg)) return { offset: null, data };

    console.log(`[签到] 缓存 offset=${_cachedOffset} 失效，进行二分搜索`);
    _cachedOffset = null;
  }

  // 二分搜索新 offset
  const newOffset = await binarySearchOffset(sessionId, userId, courseSchedId, baseTs);

  if (newOffset === null) {
    // 兜底：试几个常见值
    for (const off of [-9000, -8000, -7000, -6000, -5000]) {
      const data = await doSignOnce(sessionId, userId, courseSchedId, String(baseTs + off));
      if ((data.STATUS === '0' || data.status === '0')) {
        _cachedOffset = off;
        return { offset: off, data };
      }
    }
    return { offset: null, data: null };
  }

  _cachedOffset = newOffset;
  const data = await doSignOnce(sessionId, userId, courseSchedId, String(baseTs + newOffset));
  return { offset: newOffset, data };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// ── API 路由 ──────────────────────────────────────────────────

async function handleApi(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/status') {
    return json({ ok: true, ts: Date.now() });
  }
  // 调试：测试 iClass 连通性
  if (path === '/api/debug') {
    const phone = url.searchParams.get('phone') || '';
    try {
      const u = new URL(ICRAFT_LOGIN);
      u.searchParams.set('phone', phone);
      u.searchParams.set('password', '');
      u.searchParams.set('userLevel', '1');
      u.searchParams.set('verificationType', '2');
      u.searchParams.set('verificationUrl', '');
      const res = await fetch(u.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      const text = await res.text();
      return json({
        status: res.status,
        body: text.substring(0, 300),
      });
    } catch (e) {
      return json({ error: e.message, name: e.name });
    }
  }
  // 调试2：测试基本网络连通性
  if (path === '/api/debug2') {
    try {
      const r = await fetch('https://www.cloudflare.com/');
      return json({ cf_ok: true, status: r.status });
    } catch (e) {
      return json({ cf_ok: false, error: e.message });
    }
  }
  // 登录
  if (path === '/api/login' && request.method === 'GET') {
    const phone = url.searchParams.get('phone');
    if (!phone) return json({ status: '1', message: '缺少 phone 参数' }, 400);
    try {
      const u = new URL(ICRAFT_LOGIN);
      u.searchParams.set('phone', phone);
      u.searchParams.set('password', '');
      u.searchParams.set('userLevel', '1');
      u.searchParams.set('verificationType', '2');
      u.searchParams.set('verificationUrl', '');
      const res = await fetch(u.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://iclass.buaa.edu.cn/',
        },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return json({ status: '1', message: 'iClass 响应解析失败', raw: text.substring(0, 200), httpStatus: res.status, url: u.toString().substring(0, 100) }, 502);
      }
      if (data.STATUS === '0' || data.status === '0') {
        return json({ status: '0', result: { id: data.result?.id, sessionId: data.result?.sessionId } });
      }
      return json({ status: '1', message: data.message || '登录失败' });
    } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
  }

  // 查课表
  if (path === '/api/schedule' && request.method === 'GET') {
    const dateStr = url.searchParams.get('dateStr');
    const userId = url.searchParams.get('userId');
    const sessionId = url.searchParams.get('sessionId');
    if (!dateStr || !userId || !sessionId) return json({ status: '1', message: '缺少必要参数' }, 400);
    try {
      const u = new URL(ICRAFT_SCHEDULE);
      u.searchParams.set('dateStr', dateStr);
      u.searchParams.set('id', userId);
      const res = await fetch(u.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0', 'sessionId': sessionId },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { return json({ status: '1', message: 'iClass 响应解析失败' }, 502); }
      if (data.STATUS === '0' || data.status === '0') return json({ status: '0', result: data.result || [] });
      return json({ status: '1', message: data.message || '查询失败' });
    } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
  }

  // 签到（带 offset 二分搜索）
  if (path === '/api/sign' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ status: '1', message: '请求体解析失败' }, 400); }
    const { courseSchedId, userId: uid, sessionId: sid } = body;
    if (!courseSchedId || !uid) return json({ status: '1', message: '缺少必要参数' }, 400);
    if (!sid) return json({ status: '1', message: '缺少 sessionId，请先调用登录接口' }, 400);
    try {
      const { offset, data } = await doSignWithOffset(sid, uid, courseSchedId);
      if (!data) return json({ status: '1', message: '签到失败：无法找到有效 offset' }, 502);
      if (data.STATUS === '0' || data.status === '0') {
        return json({ status: '0', message: `签到成功 (offset=${offset})` });
      }
      return json({ status: '1', message: data.message || '签到失败' });
    } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
  }

  // 查询当前缓存的 offset（调试用）
  if (path === '/api/offset' && request.method === 'GET') {
    return json({ offset: _cachedOffset });
  }

  // 清除 offset 缓存（调试用）
  if (path === '/api/offset' && request.method === 'DELETE') {
    _cachedOffset = null;
    return json({ message: 'offset 缓存已清除' });
  }

  return json({ status: '1', message: '未知的 API 路径' }, 404);
}

// ── 前端 HTML ────────────────────────────────────────────────

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
<p class="subtitle">输入学号与姓名，查询今日课程并签到</p>
</div>
<div id="apiStatus" class="api-status offline"><span class="dot"></span><span>检测连接中...</span></div>
<details class="collapse"><summary>使用方法 / 免责声明</summary>
<p>1. 填写真实学号、姓名，点击「查询课程」。</p>
<p>2. 从列表中选择要签到的课程，点击「签到」。</p>
<p>3. 签到窗口：课程开始前10分钟 至 课程结束。</p>
<p>4. 本项目仅用于个人学习与研究交流，请勿用于违反学校规定的用途。</p>
<p>5. 使用本工具造成的一切后果由使用者自行承担。</p>
</details>
<div class="form-group"><label>学号</label><input id="sid" placeholder="请输入学号" autocomplete="off" spellcheck="false"></div>
<div class="form-group"><label>姓名</label><input id="sname" placeholder="请输入姓名" autocomplete="off" spellcheck="false"></div>
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
dateEl.value=new Date().toISOString().split('T')[0];

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

async function login(phone){
  const r=await fetch('/api/login?phone='+encodeURIComponent(phone));
  const d=await r.json();
  if(d.status!=='0')throw new Error(d.message||'登录失败');
  return d.result;
}

async function query(){
  const id=sidEl.value.trim(),name=snameEl.value.trim(),date=dateEl.value.replace(/-/g,'');
  if(!id||!name)return msg('请填写学号与姓名','error');
  load(getBtn,qspin,qtxt,true);
  try{
    const {id:uid2,sessionId:sid2}=await login(id);uid=uid2;sid=sid2;
    const r=await fetch('/api/schedule?dateStr='+date+'&userId='+encodeURIComponent(uid)+'&sessionId='+encodeURIComponent(sid));
    const d=await r.json();
    if(d.status!=='0')return msg(d.message||'查询失败','error');
    courses=d.result||[];
    if(!courses.length){listEl.style.display='none';return msg('该日期没有课程','success')}
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
    const r=await fetch('/api/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseSchedId:item.id,userId:item.uid,sessionId:item.sid})});
    const d=await r.json();
    if(d.status==='0'){
      const s=document.querySelector('.course-item.selected');
      if(s){s.classList.add('signed');const b=s.querySelector('.badge-u');if(b){b.className='badge badge-s';b.textContent='已签到'}s.querySelector('.radio').style.cssText='border-color:var(--s);background:var(--s)';s.classList.remove('selected')}
      sel=null;signBtn.disabled=true;signBtn.classList.remove('active');
      msg('签到成功 '+d.message,'success');
    }else{msg(d.message||'签到失败','error')}
  }catch{msg('网络错误','error')}
  finally{load(signBtn,sspin,stxt,false)}
}

getBtn.addEventListener('click',query);
signBtn.addEventListener('click',sign);
sidEl.addEventListener('input',()=>{courses=[];sel=null;listEl.style.display='none';signBtn.disabled=true;signBtn.classList.remove('active')});
snameEl.addEventListener('input',()=>{courses=[];sel=null;listEl.style.display='none';signBtn.disabled=true;signBtn.classList.remove('active')});
[sidEl,snameEl].forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')query()}));
</script>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname.startsWith('/api/')) return handleApi(request);
    return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  },
};
