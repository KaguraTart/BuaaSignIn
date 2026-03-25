/**
 * BUAA iClass 本地代理服务
 * 将 iClass API 暴露给 cloudflared tunnel
 * 运行: node proxy.js
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = 8787;

// ── 代理配置 ────────────────────────────────────────────────
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
              process.env.https_proxy  || process.env.http_proxy  || '';
const NO_PROXY = (process.env.NO_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);

// 强制走代理的内网地址（Clash Verge 走代理）
const FORCE_PROXY = new Set([
  'iclass.buaa.edu.cn',
  '10.20.11.166',
  '10.111.6.238',
  '10.111.7.193',
]);

function shouldBypassProxy(host) {
  if (FORCE_PROXY.has(host)) return false;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return NO_PROXY.some(rule => {
    if (rule.startsWith('.')) return host.endsWith(rule) || host === rule.slice(1);
    return rule === host;
  });
}

// ── 发请求 ─────────────────────────────────────────────────
function doRequest(targetUrl, opts) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname;
    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port || (isHttps ? 443 : 80);

    const headers = { ...opts.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];

    if (!PROXY || shouldBypassProxy(hostname)) {
      const proto = isHttps ? https : http;
      const req = proto.request({ hostname, port, path: parsed.pathname + parsed.search, method: opts.method, headers }, resolve);
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
      return;
    }

    // HTTP CONNECT 代理
    const proxy = new URL(PROXY);
    const req = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 8080,
      path: targetUrl,
      method: opts.method,
      headers: { ...headers, host: parsed.host },
    }, resolve);
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── 收集响应体 ─────────────────────────────────────────────
function collectBody(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ── 服务器 ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  let targetProto, targetHost, targetPort, targetPath;
  if (url.pathname.startsWith('/iclass/')) {
    targetProto = 'http';  targetHost = 'iclass.buaa.edu.cn';
    targetPort = 8081;    targetPath = '/app' + url.pathname.replace('/iclass', '');
  } else {
    targetProto = 'https'; targetHost = 'iclass.buaa.edu.cn';
    targetPort = 8347;     targetPath = '/app' + url.pathname;
  }

  const targetUrl = `${targetProto}://${targetHost}:${targetPort}${targetPath}${url.search}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://iclass.buaa.edu.cn/',
    'Accept-Encoding': 'identity',
  };
  if (req.headers['sessionid']) headers['sessionId'] = req.headers['sessionid'];

  let body = '';
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks).toString();
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  try {
    const proxyRes = await doRequest(targetUrl, { method: req.method, headers, body });

    // 收集响应体再转发，避免 pipe 挂住
    const bodyBuf = await collectBody(proxyRes);

    const outHeaders = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, sessionId',
    };
    delete outHeaders['transfer-encoding'];
    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    outHeaders['Content-Length'] = bodyBuf.length;

    res.writeHead(proxyRes.statusCode, outHeaders);
    res.end(bodyBuf);
  } catch (e) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`✅  BUAA iClass 代理已启动: http://localhost:${PORT}`);
  console.log(`   /iclass/* → http://iclass.buaa.edu.cn:8081 (签到)`);
  console.log(`   其他路径  → https://iclass.buaa.edu.cn:8347 (登录/课表)`);
  console.log(`   代理: ${PROXY || '直连'}`);
  console.log('\n下一步: cloudflared tunnel --url http://localhost:8787');
});
