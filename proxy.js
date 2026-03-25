/**
 * BUAA iClass 本地代理服务
 * 直接连接 iClass（不走代理），通过 cloudflared 暴露到公网
 * 运行: node proxy.js
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = 8787;

function httpRequest(targetUrl, opts) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      reject(new Error('Invalid URL: ' + targetUrl + ' - ' + e.message));
      return;
    }

    const hostname = parsed.hostname;
    const isHttps = (parsed.protocol || '').startsWith('https');
    const port = parsed.port || (isHttps ? 443 : 80);

    console.log('→ 请求:', targetUrl, 'port:', port);

    const headers = { ...opts.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];

    const httpMod = isHttps ? https : http;
    const reqOptions = {
      hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: opts.method,
      headers,
    };
    if (isHttps) reqOptions.rejectUnauthorized = false;
    const req = httpMod.request(reqOptions, (res) => {
      console.log('← 状态:', res.statusCode);
      resolve(res);
    });
    req.on('error', (e) => {
      console.log('✗ 错误:', e.message);
      reject(e);
    });
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

const server = http.createServer((req, res) => {
  (async () => {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      console.log('收到:', req.method, reqUrl.pathname + reqUrl.search);

      let targetProto, targetHost, targetPort, targetPath;
      if (reqUrl.pathname.startsWith('/iclass/')) {
        targetProto = 'http';  targetHost = 'iclass.buaa.edu.cn';
        targetPort = 8081;     targetPath = '/app' + reqUrl.pathname.replace('/iclass', '');
      } else {
        targetProto = 'https'; targetHost = 'iclass.buaa.edu.cn';
        targetPort = 8347;     targetPath = '/app' + reqUrl.pathname;
      }

      let targetUrl = `${targetProto}://${targetHost}:${targetPort}${targetPath}${reqUrl.search}`;

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

      let response = await httpRequest(targetUrl, { method: req.method, headers, body });

      // 跟随重定向
      for (let i = 0; i < 5; i++) {
        if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
        const location = response.headers.location;
        if (!location) break;

        try {
          targetUrl = new URL(location, targetUrl).toString();
        } catch (e) {
          console.log('重定向 URL 解析失败:', location);
          break;
        }
        console.log('重定向到:', targetUrl);
        response = await httpRequest(targetUrl, { method: req.method, headers, body });
      }

      const bodyBuf = await collectBody(response);

      const outHeaders = {
        ...response.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, sessionId',
      };
      delete outHeaders['transfer-encoding'];
      delete outHeaders['content-encoding'];
      delete outHeaders['content-length'];
      outHeaders['Content-Length'] = bodyBuf.length;

      res.writeHead(response.statusCode, outHeaders);
      res.end(bodyBuf);

    } catch (e) {
      console.log('请求失败:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
  })();
});

server.listen(PORT, () => {
  console.log(`✅  BUAA iClass 代理已启动: http://localhost:${PORT}`);
  console.log(`   直连 iClass，不走代理`);
});
