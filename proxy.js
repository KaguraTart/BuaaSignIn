/**
 * BUAA iClass 本地代理服务
 * 直接连接 iClass（不走代理），通过 cloudflared 暴露到公网
 * 运行: node proxy.js
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = 8787;

// iClass 内网域名，强制直连（不走任何代理）
const BYPASS_PROXY = new Set([
  'iclass.buaa.edu.cn',
]);

function shouldBypassProxy(host) {
  return BYPASS_PROXY.has(host);
}

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

    // 始终直连，不走任何代理
    const proto = isHttps ? https : http;
    const req = proto.request({ hostname, port, path: parsed.pathname + parsed.search, method: opts.method, headers }, resolve);
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function collectBody(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  let targetProto, targetHost, targetPort, targetPath;
  if (url.pathname.startsWith('/iclass/')) {
    targetProto = http;  targetHost = 'iclass.buaa.edu.cn';
    targetPort = 8081;   targetPath = '/app' + url.pathname.replace('/iclass', '');
  } else {
    targetProto = https; targetHost = 'iclass.buaa.edu.cn';
    targetPort = 8347;   targetPath = '/app' + url.pathname;
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
    // 直接请求，不走代理
    let proxyRes = await doRequest(targetUrl, { method: req.method, headers, body });

    // 跟随重定向
    for (let i = 0; i < 5; i++) {
      if (![301, 302, 303, 307, 308].includes(proxyRes.statusCode)) break;
      const location = proxyRes.headers.location;
      if (!location) break;

      // 解析重定向目标
      let redirectUrl;
      try { redirectUrl = new URL(location, targetUrl).toString(); } catch { break; }

      proxyRes = await doRequest(redirectUrl, { method: req.method, headers, body });
    }

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
  console.log(`   直连模式，不走代理`);
});
