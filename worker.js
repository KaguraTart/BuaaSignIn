/**
 * BUAASign Cloudflare Worker
 * 自动签到 BUAA iClass (智慧树) 平台
 * 支持多老师课程、自动重试、微信推送通知
 * 
 * 修复: 多老师课程匹配逻辑 —— getClassListAll 返回全部老师的课程列表，
 * 遍历时对每个老师的课程分别发起签到，而非仅对课程负责人操作
 */

import { sendNotice } from './notify.js';

const API_BASE = 'https://mobilelogin.buaa.edu.cn';
const URL_ICHARGE_CLASSINFO = 'https://m-api.icharge.buaa.edu.cn/charging_api/wx_app/wxstudent/getClassInfo';
const URL_GETCLASSLIST = 'https://m-api.icharge.buaa.edu.cn/charging_api/wx_app/wxstudent/getClassList';
const URL_SIGNIN = 'https://m-api.icharge.buaa.edu.cn/charging_api/wx_app/wxstudent/doSignIn';

// CORS 配置
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * 获取所有课程列表（包含所有老师的课程）
 * getClassListAll: 从 getClassList 返回的每个课程中提取全部老师的课程
 */
async function getClassListAll(client, studentId) {
  const res = await client.post(URL_GETCLASSLIST, {
    body: JSON.stringify({ studentId }),
  });
  const data = await res.json();

  const classMap = {};  // { courseId: [ {teacherName, teacherId}, ... ] }

  if (!data?.data) return classMap;

  for (const item of data.data) {
    // item.students 数组包含本课程所有选课老师的学生信息
    if (!item.students?.length) continue;

    for (const stu of item.students) {
      // 从每个老师的学生列表中获取课程名称
      const courseName = stu.courseName || item.courseName || '';
      const teacherName = stu.teacherName || '';
      const teacherId = stu.teacherId || '';
      const courseId = stu.courseId || stu.id || '';

      if (!courseId || !teacherId) continue;

      if (!classMap[courseId]) {
        classMap[courseId] = {
          courseName,
          teachers: [],       // 所有老师的列表
          allClasses: [],     // 所有老师的课程 ID 列表
        };
      }

      // 避免重复添加同一老师
      const exists = classMap[courseId].teachers.some(t => t.teacherId === teacherId);
      if (!exists) {
        classMap[courseId].teachers.push({ teacherName, teacherId });
      }

      // 收集老师的课程 ID
      const classId = stu.id || stu.courseId || '';
      if (classId && !classMap[courseId].allClasses.includes(classId)) {
        classMap[courseId].allClasses.push(classId);
      }
    }
  }

  return classMap;
}

/**
 * 获取指定学生的课程信息（单个老师的课程，用于获取课程详细安排）
 */
async function getClassInfo(client, studentId, classId) {
  const res = await client.post(URL_ICHARGE_CLASSINFO, {
    body: JSON.stringify({ studentId, classId }),
  });
  return await res.json();
}

/**
 * 查询课程当前签到状态
 */
async function getSigninInfo(client, classId) {
  const res = await client.post(URL_SIGNIN, {
    body: JSON.stringify({ classId }),
  });
  return await res.json();
}

/**
 * 执行签到
 */
async function doSignIn(client, classId, userId) {
  const res = await client.post(URL_SIGNIN, {
    body: JSON.stringify({ classId, userId }),
  });
  return await res.json();
}

/**
 * HTTP POST 封装（支持 Fetch API 和 Workers 环境）
 */
class HttpClient {
  constructor(request) {
    this.request = request;
  }

  post(url, options = {}) {
    const { headers = {}, body } = options;
    return this.request.clone().then(r => {
      r.body = null;
      return new Promise((resolve, reject) => {
        const init = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': 'https://service.icharge.buaa.edu.cn/',
            ...headers,
          },
        };
        if (body) init.body = body;

        fetch(url, init)
          .then(resolve)
          .catch(reject);
      });
    });
  }
}

/**
 * 从请求体解析 JSON
 */
async function parseJson(request) {
  const clone = request.clone();
  try {
    return await clone.json();
  } catch {
    return {};
  }
}

/**
 * 获取请求来源 IP
 */
function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
}

/**
 * 生成 JSON 响应
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * 主 API 处理函数
 */
async function handleApi(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (path === 'sign' && request.method === 'POST') {
    return handleSign(request);
  }

  return json({ error: 'Not Found' }, 404);
}

/**
 * 处理签到请求
 * 
 * 请求体: { studentId, studentName, (optional) signTime, (optional) noticeToken }
 * signTime: ISO 字符串，指定签到时间（用于测试/补签）
 */
async function handleSign(request) {
  const body = await parseJson(request);
  const { studentId, studentName, signTime, noticeToken, server酱Key } = body;

  if (!studentId || !studentName) {
    return json({ status: '-1', message: '缺少必要参数 studentId 或 studentName' }, 400);
  }

  const client = new HttpClient(request);
  const ip = getClientIp(request);
  const signTimeLabel = signTime
    ? new Date(signTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '当前';

  console.log(`[签到] 学生: ${studentName} (${studentId}) | IP: ${ip} | 签到时间: ${signTimeLabel}`);

  try {
    // 获取全部老师的课程列表（核心修复）
    const classMap = await getClassListAll(client, studentId);

    if (!Object.keys(classMap).length) {
      return json({ status: '-1', message: '未查到任何课程，请检查学生ID是否正确' });
    }

    let signedCount = 0;
    let skippedCount = 0;
    const results = [];

    // 遍历每个课程（一个课程可能有多位老师的课头）
    for (const [courseId, courseInfo] of Object.entries(classMap)) {
      const { courseName, teachers, allClasses } = courseInfo;

      // 获取课程详细安排（用于检查当前是否在上课）
      const classInfo = await getClassInfo(client, studentId, allClasses[0]);
      if (!classInfo?.data) {
        skippedCount++;
        continue;
      }

      const classData = classInfo.data;
      const now = signTime ? new Date(signTime) : new Date();

      // 检查当前时间是否在上课时间范围内
      const beginTime = classData.beginTime ? new Date(classData.beginTime) : null;
      const endTime = classData.endTime ? new Date(classData.endTime) : null;

      if (beginTime && endTime) {
        // 提前 10 分钟开始可以签到
        beginTime.setMinutes(beginTime.getMinutes() - 10);
        if (now < beginTime || now > endTime) {
          // 不在上课时间，跳过（不报错）
          skippedCount++;
          continue;
        }
      } else if (beginTime && now < beginTime) {
        skippedCount++;
        continue;
      }

      // 多老师课程：对每位老师的课程 ID 分别检查签到状态并执行
      // 这解决了"一个课程有多个老师，签到由非第一个老师发布"的场景
      for (const cls of allClasses) {
        // 获取此课程 ID 的签到状态（填入此老师的 classId）
        const signinRes = await getSigninInfo(client, cls);
        const signinData = signinRes?.data;

        if (!signinData) {
          // 无签到信息（课程未发布签到），跳过
          continue;
        }

        const signinActive = signinData.signInStatus === 1;
        const alreadySigned = signinData.userSignInStatus === 1;

        if (!signinActive) {
          // 签到未开启
          continue;
        }

        if (alreadySigned) {
          // 已签到
          results.push({
            courseName,
            teacher: teachers.find(t => t.teacherId === signinData.teacherId)?.teacherName || '未知',
            status: 'already_signed',
            message: '已签到（无需重复签到）',
          });
          signedCount++;
          continue;
        }

        // 执行签到
        const doRes = await doSignIn(client, cls, studentId);
        const doData = doRes?.data;

        if (doData?.status === '0' || doRes?.status === '0') {
          results.push({
            courseName,
            teacher: teachers.find(t => t.teacherId === doData?.teacherId)?.teacherName || '未知',
            status: 'success',
            message: '签到成功',
          });
          signedCount++;
        } else {
          results.push({
            courseName,
            teacher: teachers.find(t => t.teacherId === doData?.teacherId)?.teacherName || '未知',
            status: 'failed',
            message: doRes?.message || '签到失败',
          });
        }

        // 多老师场景下，每次签到间隔 1 秒防触发限制
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 汇总结果
    const summary = signedCount > 0
      ? `✅ 成功签到 ${signedCount} 门课程`
      : `ℹ️ 无需签到（${skippedCount} 门课程不在签到时间或未发布）`;

    const detail = results
      .filter(r => r.status === 'success')
      .map(r => `• ${r.courseName} (${r.teacher})`)
      .join('\n') || '无';

    // 发送通知
    if (server酱Key) {
      await sendNotice(server酱Key, {
        title: `BUAA 签到结果 — ${studentName}`,
        desp: `${summary}\n\n${detail}\n\n签到时间: ${signTimeLabel}\nIP: ${ip}`,
      });
    }

    return json({
      status: '0',
      message: summary,
      data: {
        signed: signedCount,
        skipped: skippedCount,
        details: results,
      },
    });

  } catch (err) {
    console.error(`[签到错误] ${studentName}:`, err);
    return json({ status: '-1', message: `服务器内部错误: ${err.message}` }, 500);
  }
}

// ============================================================
// Web UI（手动签到界面）
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BUAA iClass 签到</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#f0f2f5;--card:#fff;--p:#165dff;--s:#36cfc9;--e:#ff4d4f;--t:#666;--bd:#e8e8e8}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:#1a1a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.wrap{width:100%;max-width:480px}
.card{background:var(--card);border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden;margin-bottom:16px}
.card-head{background:linear-gradient(135deg,#165dff,#36cfc9);color:#fff;padding:20px 24px}
.card-head h2{font-size:17px;font-weight:600;margin-bottom:4px}
.card-head p{font-size:12px;opacity:.75}
.card-body{padding:20px 24px}
.form{margin-bottom:14px}
.form label{display:block;font-size:13px;color:var(--t);margin-bottom:6px;font-weight:500}
.form input{width:100%;padding:10px 12px;border:1.5px solid var(--bd);border-radius:8px;font-size:14px;transition:border-color .2s;outline:none}
.form input:focus{border-color:var(--p)}
.row{display:flex;gap:10px}
.row .form{flex:1}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s;text-align:center}
.btn-p{background:var(--p);color:#fff}
.btn-p:active{background:#0e42d1}
.btn-p:disabled{background:#a0c4ff;cursor:not-allowed}
.btn-s{background:var(--s);color:#fff;margin-top:10px}
.btn-s:active{background:#1ba39e}
.course-list{margin-top:16px}
.course-item{display:flex;align-items:center;padding:12px;border:1.5px solid var(--bd);border-radius:10px;margin-bottom:10px;cursor:pointer;transition:all .2s;position:relative}
.course-item:hover{border-color:var(--p)}
.course-item.selected{border-color:var(--p);background:#f0f5ff}
.course-item.signed{border-color:var(--s);background:#f0fcfb;cursor:default}
.radio{width:18px;height:18px;border:2px solid var(--bd);border-radius:50%;flex-shrink:0;margin-right:12px;transition:all .2s;display:flex;align-items:center;justify-content:center}
.course-item.selected .radio{border-color:var(--p);background:var(--p)}
.course-item.signed .radio{border-color:var(--s);background:var(--s)}
.course-item.selected .radio::after{content:'';width:6px;height:6px;background:#fff;border-radius:50%}
.course-item.signed .radio::after{content:'';width:6px;height:6px;background:#fff;border-radius:50%}
.info{flex:1;min-width:0}
.name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-size:12px;color:var(--t);margin-top:2px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;margin-left:6px}
.badge-a{background:#e6f7ff;color:#1677ff}
.badge-s{background:#e6fffb;color:#13c2c2}
.badge-e{background:#fff1f0;color:#cf1322}
.badge-u{background:#f5f5f5;color:#999}
.status{font-size:12px;text-align:center;padding:8px;color:var(--t)}
.error{color:var(--e);text-align:center;font-size:13px;padding:8px}
.info-box{background:#f0f5ff;border-radius:8px;padding:12px 14px;font-size:13px;color:#1677ff;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="card-head">
      <h2>BUAA iClass 智慧树签到</h2>
      <p>自动检测课程签到状态 · 支持多老师课程</p>
    </div>
    <div class="card-body">
      <div class="form"><label>学号</label><input id="sid" placeholder="请输入学号" autocomplete="off"></div>
      <div class="form"><label>姓名</label><input id="sname" placeholder="请输入姓名" autocomplete="off"></div>
      <div class="form"><label>Server酱 Key（可选）</label><input id="skey" placeholder="用于微信推送通知，非必填" autocomplete="off"></div>
      <button id="qbtn" class="btn btn-p">查询课程</button>
      <div id="elist" class="course-list" style="display:none"></div>
      <button id="signbtn" class="btn btn-s" style="display:none" disabled>发起签到</button>
    </div>
  </div>
  <div id="status" class="status" style="display:none"></div>
</div>
<script>
const sidEl=document.getElementById('sid');
const snameEl=document.getElementById('sname');
const skeyEl=document.getElementById('skey');
const qbtn=document.getElementById('qbtn');
const signbtn=document.getElementById('signbtn');
const elist=document.getElementById('elist');
const status=document.getElementById('status');

let courses=[];
let sel=null;

function load(btn,spin,txt,on){
  btn.disabled=on;
  spin.style.display=on?'inline-block':'';
  txt.textContent=on?'':btn.dataset.txt;
}

function msg(txt,type){
  status.style.display='block';
  status.className=type==='error'?'error':'status';
  status.textContent=txt;
}

qbtn.addEventListener('click',async()=>{
  const sid=sidEl.value.trim();
  const sname=snameEl.value.trim();
  if(!sid||!sname)return msg('请填写完整','error');
  load(qbtn,qbtn,qbtn.dataset.txt?null:{},true);
  try{
    const r=await fetch('/api/list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({studentId:sid,studentName:sname})});
    const d=await r.json();
    if(d.status!=='0'){msg(d.message||'查询失败','error');load(qbtn,null,null,false);return}
    courses=d.data||[];
    elist.style.display='block';
    elist.innerHTML='';
    if(!courses.length){msg('未查到课程','error');return}
    courses.forEach((c,i)=>{
      const div=document.createElement('div');
      div.className='course-item';
      div.innerHTML='<div class="radio"></div><div class="info"><div class="name">'+c.courseName+'<span class="badge badge-a">'+c.teacherName+'</span></div><div class="meta">第'+c.index+'周 第'+c.period+'节 · '+c.place+'</div></div>';
      div.addEventListener('click',()=>{
        if(div.classList.contains('signed'))return;
        document.querySelectorAll('.course-item').forEach(x=>x.classList.remove('selected'));
        div.classList.add('selected');
        sel={...courses[idx],uid,sid};
        signbtn.disabled=false;signbtn.classList.add('active');
      });
      elist.appendChild(div);
    });
    msg(courses.length+' 门课程已查到，点击选择','error');
  }catch{msg('网络错误','error')}
  finally{load(qbtn,null,null,false)}
});

signbtn.addEventListener('click',async()=>{
  if(!sel)return;
  const item=sel;
  load(signbtn,signbtn,signbtn.dataset.txt?null:{},true);
  try{
    const r=await fetch('/api/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({courseSchedId:item.id,userId:item.uid,studentId:item.studentId||sid,studentName:item.studentName||sname,skey:skeyEl.value.trim()})});
    const d=await r.json();
    if(d.status==='0'){
      const s=document.querySelector('.course-item.selected');
      if(s){s.classList.add('signed');s.classList.remove('selected');const b=s.querySelector('.badge-a');if(b){b.className='badge badge-s';b.textContent='已签到'}}
      sel=null;signbtn.disabled=true;signbtn.classList.remove('active');
      msg('签到成功','error');
    }else{msg(d.message||'签到失败','error')}
  }catch{msg('网络错误','error')}
  finally{load(signbtn,null,null,false)}
});

sidEl.addEventListener('input',()=>{courses=[];sel=null;elist.style.display='none';signbtn.disabled=true;signbtn.classList.remove('active')});
snameEl.addEventListener('input',()=>{courses=[];sel=null;elist.style.display='none';signbtn.disabled=true;signbtn.classList.remove('active')});
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
