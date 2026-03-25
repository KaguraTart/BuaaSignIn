/**
 * Cloudflare Worker - Serves index.html + proxies BUAA iClass API
 */

const ICRAFT_LOGIN_URL = 'https://iclass.buaa.edu.cn:8347/app/user/login.action';
const ICRAFT_SCHEDULE_URL = 'https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action';
const ICRAFT_SIGN_URL = 'http://iclass.buaa.edu.cn:8081/app/course/stu_scan_sign.action';

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BUAA 课程签到</title>
    <style>
        :root {
            --theme: #3498db;
            --theme-dark: #2980b9;
            --success: #2ecc71;
            --success-dark: #27ae60;
            --error: #e74c3c;
            --error-dark: #c0392b;
            --bg-start: #f5f7fa;
            --bg-end: #e4edf5;
            --card-bg: rgba(255, 255, 255, 0.9);
            --border: rgba(52, 152, 219, 0.2);
            --text: #2c3e50;
            --text-muted: #7f8c8d;
            --radius: 12px;
            --shadow: 0 8px 32px rgba(52, 152, 219, 0.12);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            min-height: 100vh;
            background: linear-gradient(135deg, var(--bg-start) 0%, var(--bg-end) 100%);
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 40px 20px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: var(--text);
        }
        .card {
            width: 100%;
            max-width: 560px;
            background: var(--card-bg);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            box-shadow: var(--shadow);
            border: 1px solid var(--border);
            padding: 36px 32px;
            margin-top: 20px;
        }
        .header { text-align: center; margin-bottom: 28px; }
        .logo {
            width: 64px; height: 64px; margin: 0 auto 12px;
            background: linear-gradient(135deg, var(--theme), var(--theme-dark));
            border-radius: 16px;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.3);
        }
        .logo svg { width: 36px; height: 36px; }
        h1 {
            font-size: 24px; font-weight: 700;
            background: linear-gradient(90deg, var(--theme), var(--theme-dark));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            margin-bottom: 4px;
        }
        .subtitle { font-size: 13px; color: var(--text-muted); }
        .collapse {
            background: linear-gradient(135deg, rgba(52, 152, 219, 0.06), rgba(52, 152, 219, 0.03));
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 14px 16px;
            font-size: 13px;
            color: var(--text-muted);
            margin-bottom: 24px;
            line-height: 1.8;
        }
        .collapse summary { cursor: pointer; outline: none; font-weight: 600; color: var(--theme); user-select: none; }
        .collapse summary:hover { color: var(--theme-dark); }
        .form-group { margin-bottom: 16px; }
        label { display: block; font-size: 13px; font-weight: 500; color: var(--text-muted); margin-bottom: 6px; }
        input, select {
            width: 100%; padding: 12px 16px;
            border: 1.5px solid #dce4ed;
            border-radius: var(--radius);
            font-size: 15px;
            background: rgba(255, 255, 255, 0.8);
            transition: all 0.25s;
            color: var(--text);
        }
        input:focus, select:focus {
            border-color: var(--theme);
            outline: none;
            box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.15);
            background: #fff;
        }
        input::placeholder { color: #bdc3c7; }
        .btn-row { display: flex; gap: 12px; margin-top: 20px; }
        button {
            flex: 1; padding: 13px 16px;
            border: none; border-radius: var(--radius);
            font-size: 15px; font-weight: 600;
            cursor: pointer; transition: all 0.2s;
            display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn-primary {
            background: linear-gradient(135deg, var(--theme), var(--theme-dark));
            color: #fff; box-shadow: 0 4px 12px rgba(52, 152, 219, 0.3);
        }
        .btn-primary:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(52, 152, 219, 0.4); }
        .btn-signin {
            background: linear-gradient(135deg, #95a5a6, #7f8c8d);
            color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .btn-signin.active {
            background: linear-gradient(135deg, var(--success), var(--success-dark));
            box-shadow: 0 4px 12px rgba(46, 204, 113, 0.3);
        }
        .btn-signin:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }
        .spinner {
            width: 16px; height: 16px;
            border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
            border-radius: 50%; animation: spin 0.7s linear infinite; display: none;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .message {
            margin-top: 16px; padding: 12px 16px;
            border-radius: var(--radius); font-size: 13px; text-align: center;
            opacity: 0; transform: translateY(-8px); transition: all 0.3s;
        }
        .message.show { opacity: 1; transform: translateY(0); }
        .message.success { background: rgba(46, 204, 113, 0.12); color: var(--success-dark); border: 1px solid rgba(46, 204, 113, 0.3); }
        .message.error { background: rgba(231, 76, 60, 0.1); color: var(--error-dark); border: 1px solid rgba(231, 76, 60, 0.25); }
        .course-list {
            margin-top: 16px; max-height: 300px; overflow-y: auto;
            border-radius: var(--radius); border: 1.5px solid var(--border);
        }
        .course-list::-webkit-scrollbar { width: 6px; }
        .course-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        .course-item {
            padding: 12px 16px; border-bottom: 1px solid var(--border);
            cursor: pointer; transition: all 0.15s;
            display: flex; align-items: center; gap: 12px;
        }
        .course-item:last-child { border-bottom: none; }
        .course-item:hover { background: rgba(52, 152, 219, 0.05); }
        .course-item.selected { background: rgba(52, 152, 219, 0.1); border-left: 3px solid var(--theme); }
        .course-item.signed { opacity: 0.6; cursor: not-allowed; }
        .course-radio {
            width: 18px; height: 18px; border: 2px solid var(--border);
            border-radius: 50%; flex-shrink: 0; transition: all 0.15s;
        }
        .course-item.selected .course-radio { border-color: var(--theme); background: var(--theme); box-shadow: inset 0 0 0 3px #fff; }
        .course-item.signed .course-radio { border-color: var(--success); background: var(--success); }
        .course-info { flex: 1; min-width: 0; }
        .course-name { font-size: 14px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .course-detail { font-size: 12px; color: var(--text-muted); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
        .course-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
        .badge-signed { background: rgba(46, 204, 113, 0.15); color: var(--success-dark); }
        .badge-unsigned { background: rgba(231, 76, 60, 0.1); color: var(--error-dark); }
        .empty-state { text-align: center; padding: 32px; color: var(--text-muted); font-size: 13px; }
        .footer { text-align: center; font-size: 12px; color: #bdc3c7; margin-top: 24px; line-height: 1.8; }
        .footer a { color: var(--theme); text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
        .api-status {
            display: inline-flex; align-items: center; gap: 6px;
            font-size: 12px; padding: 4px 12px; border-radius: 20px; margin-bottom: 20px;
        }
        .api-status.online { background: rgba(46, 204, 113, 0.1); color: var(--success-dark); }
        .api-status.offline { background: rgba(231, 76, 60, 0.1); color: var(--error-dark); }
        .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .divider { height: 1px; background: linear-gradient(90deg, transparent, #e0e7ed, transparent); margin: 24px 0; }
        @media (max-width: 480px) { .card { padding: 24px 16px; } .btn-row { flex-direction: column; } h1 { font-size: 20px; } }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="logo">
                <svg viewBox="0 0 36 36" fill="none"><rect x="2" y="2" width="14" height="14" rx="3" fill="white" fill-opacity="0.9"/><rect x="20" y="2" width="14" height="14" rx="3" fill="white" fill-opacity="0.7"/><rect x="2" y="20" width="14" height="14" rx="3" fill="white" fill-opacity="0.7"/><rect x="20" y="20" width="14" height="14" rx="3" fill="white" fill-opacity="0.9"/><circle cx="27" cy="9" r="4" fill="white" fill-opacity="0.5"/><path d="M25 9L26.5 10.5L29 8" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h1>BUAA 课程签到</h1>
            <p class="subtitle">输入学号与姓名，查询今日课程并签到</p>
        </div>
        <div id="apiStatus" class="api-status offline"><span class="status-dot"></span><span>检测连接中...</span></div>
        <details class="collapse"><summary>使用方法 / 免责声明</summary>
            <p>1. 填写真实学号、姓名，点击「查询课程」。</p>
            <p>2. 从列表中选择要签到的课程，点击「签到」。</p>
            <p>3. 签到窗口：课程开始前10分钟 至 课程结束。</p>
            <p>4. 本项目仅用于个人学习与研究交流，请勿用于违反学校规定的用途。</p>
            <p>5. 使用本工具造成的一切后果由使用者自行承担。</p>
        </details>
        <div class="form-group"><label for="studentId">学号</label><input id="studentId" placeholder="请输入学号" autocomplete="off" spellcheck="false"></div>
        <div class="form-group"><label for="studentName">姓名</label><input id="studentName" placeholder="请输入姓名" autocomplete="off" spellcheck="false"></div>
        <div class="form-group"><label for="dateInput">查询日期</label><input type="date" id="dateInput"></div>
        <div class="btn-row">
            <button class="btn-primary" id="getScheduleBtn"><span class="spinner" id="querySpinner"></span><span id="queryBtnText">查询课程</span></button>
            <button class="btn-signin" id="SignInBtn" disabled><span class="spinner" id="signSpinner"></span><span id="signBtnText">签到</span></button>
        </div>
        <div id="courseList" class="course-list" style="display:none;"></div>
        <div id="message" class="message"></div>
        <div class="divider"></div>
        <div class="footer"><div>基于 BUAA iClass API 构建 · 参考自 <a href="https://github.com/theFool-wn" target="_blank">GitHub</a></div><div>仅供学习交流，请合理使用</div></div>
    </div>
    <script>
        let userId = '', sessionId = '', courses = [], selectedCourse = null;
        const studentIdEl = document.getElementById('studentId');
        const studentNameEl = document.getElementById('studentName');
        const dateInputEl = document.getElementById('dateInput');
        const getBtn = document.getElementById('getScheduleBtn');
        const signBtn = document.getElementById('SignInBtn');
        const querySpinner = document.getElementById('querySpinner');
        const signSpinner = document.getElementById('signSpinner');
        const queryBtnText = document.getElementById('queryBtnText');
        const signBtnText = document.getElementById('signBtnText');
        const msgEl = document.getElementById('message');
        const courseListEl = document.getElementById('courseList');
        const apiStatusEl = document.getElementById('apiStatus');
        const today = new Date();
        dateInputEl.value = today.toISOString().split('T')[0];
        async function checkApiStatus() {
            try {
                const res = await fetch('/api/status');
                if (res.ok) { setApiStatus(true, '服务正常'); return; }
            } catch {}
            setApiStatus(false, '连接失败');
        }
        function setApiStatus(online, text) {
            apiStatusEl.className = 'api-status ' + (online ? 'online' : 'offline');
            apiStatusEl.querySelector('span:last-child').textContent = text;
        }
        checkApiStatus();
        function showMessage(text, type='success') {
            msgEl.textContent = text; msgEl.className = 'message ' + type + ' show';
            clearTimeout(msgEl._timer); msgEl._timer = setTimeout(() => msgEl.classList.remove('show'), 5000);
        }
        function setLoading(btn, spinner, textEl, loading, defaultText) {
            btn.disabled = loading;
            spinner.style.display = loading ? 'inline-block' : 'none';
            textEl.textContent = loading ? (btn.id === 'getScheduleBtn' ? '查询中...' : '签到中...') : defaultText;
        }
        function fmtTime(iso) { return iso ? iso.substring(11, 16) : '--:--'; }
        async function login(phone) {
            const res = await fetch('/api/login?phone=' + encodeURIComponent(phone));
            const data = await res.json();
            if (data.status !== '0') throw new Error(data.message || '登录失败');
            return { userId: data.result.id, sessionId: data.result.sessionId };
        }
        async function querySchedule() {
            const id = studentIdEl.value.trim(), name = studentNameEl.value.trim();
            const date = dateInputEl.value.replace(/-/g, '');
            if (!id || !name) return showMessage('请填写学号与姓名', 'error');
            setLoading(getBtn, querySpinner, queryBtnText, true, '查询课程');
            try {
                const { userId: uid, sessionId: sid } = await login(id);
                userId = uid; sessionId = sid;
                const res = await fetch('/api/schedule?dateStr=' + date + '&userId=' + encodeURIComponent(userId) + '&sessionId=' + encodeURIComponent(sessionId));
                const data = await res.json();
                if (data.status !== '0') return showMessage(data.message || '查询失败', 'error');
                courses = data.result || [];
                if (courses.length === 0) { courseListEl.style.display = 'none'; return showMessage('该日期没有课程', 'success'); }
                renderCourseList(courses);
                showMessage('查询成功，共 ' + courses.length + ' 节课', 'success');
            } catch (e) { showMessage(e.message || '网络请求失败', 'error'); }
            finally { setLoading(getBtn, querySpinner, queryBtnText, false, '查询课程'); }
        }
        function renderCourseList(list) {
            courseListEl.innerHTML = ''; courseListEl.style.display = 'block';
            const now = new Date();
            list.forEach((item, idx) => {
                const begin = item.classBeginTime ? new Date(item.classBeginTime) : null;
                const end = item.classEndTime ? new Date(item.classEndTime) : null;
                const tenMinBefore = begin ? new Date(begin.getTime() - 600000) : null;
                const signed = item.signStatus === '1';
                const inWindow = !signed && begin && end && now >= tenMinBefore && now <= end;
                const el = document.createElement('div');
                el.className = 'course-item' + (signed ? ' signed' : '');
                el.innerHTML = '<div class="course-radio"></div><div class="course-info"><div class="course-name">' + (item.courseName || '未知课程') + '</div><div class="course-detail"><span>' + fmtTime(item.classBeginTime) + ' - ' + fmtTime(item.classEndTime) + '</span><span>' + (item.classroomName || '') + '</span><span>' + (item.teacherName || '') + '</span>' + (signed ? '<span class="course-badge badge-signed">已签到</span>' : '<span class="course-badge badge-unsigned">' + (inWindow ? '可签到' : '未开始') + '</span>') + '</div></div>';
                if (!signed) el.addEventListener('click', () => selectCourse(idx, el));
                courseListEl.appendChild(el);
            });
        }
        function selectCourse(idx, el) {
            document.querySelectorAll('.course-item').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            selectedCourse = { ...courses[idx], userId, sessionId };
            signBtn.disabled = false; signBtn.classList.add('active');
        }
        async function doSignIn() {
            if (!selectedCourse) return;
            const item = selectedCourse;
            setLoading(signBtn, signSpinner, signBtnText, true, '签到');
            try {
                const res = await fetch('/api/sign', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ courseSchedId: item.id, userId: item.userId, sessionId: item.sessionId }) });
                const data = await res.json();
                if (data.status === '0') {
                    const sel = document.querySelector('.course-item.selected');
                    if (sel) { sel.classList.add('signed'); const b = sel.querySelector('.badge-unsigned'); if (b) { b.className='course-badge badge-signed'; b.textContent='已签到'; } sel.querySelector('.course-radio').style.cssText='border-color:var(--success);background:var(--success)'; sel.classList.remove('selected'); }
                    selectedCourse = null; signBtn.disabled = true; signBtn.classList.remove('active');
                    showMessage('签到成功', 'success');
                } else { showMessage(data.message || '签到失败', 'error'); }
            } catch (e) { showMessage('网络错误', 'error'); }
            finally { setLoading(signBtn, signSpinner, signBtnText, false, '签到'); }
        }
        getBtn.addEventListener('click', querySchedule);
        signBtn.addEventListener('click', doSignIn);
        studentIdEl.addEventListener('input', () => { courses=[]; selectedCourse=null; courseListEl.style.display='none'; signBtn.disabled=true; signBtn.classList.remove('active'); });
        studentNameEl.addEventListener('input', () => { courses=[]; selectedCourse=null; courseListEl.style.display='none'; signBtn.disabled=true; signBtn.classList.remove('active'); });
        [studentIdEl, studentNameEl].forEach(el => el.addEventListener('keydown', e => { if (e.key==='Enter') querySchedule(); }));
    </script>
</body>
</html>`;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
    });
}

function makeHtmlResponse(body) {
    return new Response(body, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
    });
}

async function handleApi(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/status') {
        return json({ ok: true, ts: Date.now() });
    }

    // Login
    if (url.pathname === '/api/login' && request.method === 'GET') {
        const phone = url.searchParams.get('phone');
        if (!phone) return json({ status: '1', message: '缺少 phone 参数' }, 400);
        try {
            const loginUrl = new URL(ICRAFT_LOGIN_URL);
            loginUrl.searchParams.set('phone', phone);
            loginUrl.searchParams.set('password', '');
            loginUrl.searchParams.set('userLevel', '1');
            loginUrl.searchParams.set('verificationType', '2');
            loginUrl.searchParams.set('verificationUrl', '');
            const res = await fetch(loginUrl.toString(), {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { return json({ status: '1', message: 'iClass 响应解析失败' }, 502); }
            if (data.STATUS === '0' || data.status === '0') {
                return json({ status: '0', result: { id: data.result?.id, sessionId: data.result?.sessionId } });
            }
            return json({ status: '1', message: data.message || '登录失败' }, 200);
        } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
    }

    // Schedule
    if (url.pathname === '/api/schedule' && request.method === 'GET') {
        const { dateStr, userId: uid, sessionId: sid } = Object.fromEntries(url.searchParams);
        if (!dateStr || !uid || !sid) return json({ status: '1', message: '缺少必要参数' }, 400);
        try {
            const scheduleUrl = new URL(ICRAFT_SCHEDULE_URL);
            scheduleUrl.searchParams.set('dateStr', dateStr);
            scheduleUrl.searchParams.set('id', uid);
            const res = await fetch(scheduleUrl.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'sessionId': sid,
                }
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { return json({ status: '1', message: 'iClass 响应解析失败' }, 502); }
            if (data.STATUS === '0' || data.status === '0') {
                return json({ status: '0', result: data.result || [] });
            }
            return json({ status: '1', message: data.message || '查询失败' }, 200);
        } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
    }

    // Sign In
    if (url.pathname === '/api/sign' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ status: '1', message: '请求体解析失败' }, 400); }
        const { courseSchedId, userId: uid } = body;
        if (!courseSchedId || !uid) return json({ status: '1', message: '缺少必要参数' }, 400);
        try {
            const timestamp = Date.now();
            const signUrl = `${ICRAFT_SIGN_URL}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}`;
            const res = await fetch(signUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `id=${encodeURIComponent(uid)}`,
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { return json({ status: '1', message: 'iClass 响应解析失败' }, 502); }
            if (data.STATUS === '0' || data.status === '0') {
                return json({ status: '0', message: '签到成功' });
            }
            return json({ status: '1', message: data.message || '签到失败' }, 200);
        } catch (e) { return json({ status: '1', message: '网络请求失败' }, 502); }
    }

    return json({ status: '1', message: '未知的 API 路径' }, 404);
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        if (url.pathname.startsWith('/api/')) {
            return handleApi(request);
        }

        // Serve HTML for all other routes (SPA)
        return makeHtmlResponse(HTML);
    },
};
