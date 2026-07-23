// ===== 配置 =====
const PASSWORD = '123456'; // 改成你自己的密码

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ===== 1. 入口页面 =====
    const hasUpstream =
      url.pathname.match(/^\/(https?:\/\/.+)$/) ||
      getCookie(request.headers.get('cookie') || '', '_upstream');

    if (!hasUpstream && (url.pathname === '/' || url.pathname === '')) {
      return new Response(ENTRY_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // OPTIONS 预检直接返回
    if (request.method === 'OPTIONS') {
      const corsHeaders = new Headers();
      corsHeaders.set('Access-Control-Allow-Origin', '*');
      corsHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
      corsHeaders.set('Access-Control-Allow-Headers', '*');
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ===== 2. 解析上游 + 密码校验（只校验一次）=====
    let upstream = null;
    let rewrittenPath = url.pathname;
    let rewrittenSearch = url.search;
    let needSetCookie = false;

    const m = url.pathname.match(/^\/(https?:\/\/.+)$/);
    if (m) {
      const rawUpstream = decodeURIComponent(m[1]);
      const parts = rawUpstream.split('/');
      const possiblePwd = parts[parts.length - 1];

      if (possiblePwd === PASSWORD) {
        // 密码正确，去掉末尾密码段
        upstream = parts.slice(0, -1).join('/') + url.search;
        needSetCookie = true;
        rewrittenPath = '';
        rewrittenSearch = '';
      } else {
        // 已登录模式，校验 Cookie
        const cookieToken = getCookie(request.headers.get('cookie') || '', '_token');
        if (cookieToken !== PASSWORD) {
          // 未登录，但如果是静态资源请求（css/js/img/font），直接放行代理
          const resourceExts = /\.(css|js|mjs|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|otf|ico|map|webp|avif|bmp|tiff|mp4|webm|mp3|wav|ogg|flac|pdf|wasm)$/i;
          if (resourceExts.test(url.pathname)) {
            upstream = rawUpstream + url.search;
            rewrittenPath = '';
            rewrittenSearch = '';
          } else {
            return Response.redirect('https://www.baidu.com', 302);
          }
        } else {
          upstream = rawUpstream + url.search;
          rewrittenPath = '';
          rewrittenSearch = '';
        }
      }
    } else {
      const cookieUp = getCookie(request.headers.get('cookie') || '', '_upstream');
      if (cookieUp) {
        upstream = decodeURIComponent(cookieUp);
      }
    }

    if (!upstream) {
      return new Response('Not Found', { status: 404 });
    }

    // ===== 3. 校验协议 =====
    let upstreamUrlObj;
    try {
      upstreamUrlObj = new URL(upstream);
      if (!/^https?:$/.test(upstreamUrlObj.protocol)) throw new Error('bad scheme');
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }

    // ===== 4. 拼接上游 URL =====
    const upstreamUrl = m
      ? upstream
      : upstreamUrlObj.origin + rewrittenPath + rewrittenSearch;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('x-upstream');
    headers.delete('x-pwd');
    headers.delete('cookie');

    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    let response = await fetch(upstreamReq);

    const respHeaders = new Headers(response.headers);

    // ===== 5. 删除安全限制头 =====
    // CSP 会阻止从 worker 域名加载资源，必须删除
    respHeaders.delete('content-security-policy');
    respHeaders.delete('content-security-policy-report-only');
    respHeaders.delete('x-content-security-policy');
    respHeaders.delete('x-webkit-csp');
    // X-Frame-Options 会阻止被 iframe 嵌入，也删除
    respHeaders.delete('x-frame-options');
    // HSTS 可能导致跳转问题，删除
    respHeaders.delete('strict-transport-security');

    // ===== 5.5 CORS 头 =====
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    respHeaders.set('Access-Control-Allow-Headers', '*');

    // ===== 6. 重写 Location =====
    const location = respHeaders.get('location');
    if (location) {
      try {
        const locUrl = new URL(location, upstream);
        if (locUrl.origin === upstreamUrlObj.origin) {
          // 同上游域名的重定向，改写为 worker 域名 + 原路径
          respHeaders.set('location', url.origin + locUrl.pathname + locUrl.search);
        } else {
          // 跨域重定向（如 github.com → raw.githubusercontent.com），改写为经过 worker 代理
          respHeaders.set('location', url.origin + '/' + locUrl.href);
        }
      } catch {}
    }

    // ===== 7. 写 Cookie =====
    if (needSetCookie) {
      respHeaders.append(
        'set-cookie',
        `_upstream=${encodeURIComponent(upstreamUrlObj.origin)}; Path=/; Max-Age=604800; SameSite=Lax`
      );
      respHeaders.append(
        'set-cookie',
        `_token=${PASSWORD}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly`
      );
    }

    // ===== 8. 文本替换 =====
    const ct = (respHeaders.get('content-type') || '').toLowerCase();
    const isText =
      ct.includes('text') ||
      ct.includes('json') ||
      ct.includes('javascript') ||
      ct.includes('xml');

    if (isText) {
      const text = await response.text();
      const upstreamOrigin = upstreamUrlObj.origin;
      const upstreamHost = upstreamUrlObj.host;

      // 1. 替换上游域名 -> worker 域名
      let replaced = text.split(upstreamOrigin).join(url.origin);
      replaced = replaced.split(upstreamHost).join(url.host);

      // 2. 外部绝对 URL 资源改写为经过 worker 代理
      //    匹配 src="https://..." href="https://..." action="https://..."
      replaced = replaced.replace(
        /((?:src|href|action)\s*=\s*["'])(https?:\/\/[^"']+)/gi,
        (match, prefix, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return prefix + url.origin + '/' + fullUrl;
        }
      );

      // 3. CSS url(https://...) 改写（字体、背景图等）
      replaced = replaced.replace(
        /(url\(\s*['"]?)(https?:\/\/[^)'"\s]+)/gi,
        (match, prefix, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return prefix + url.origin + '/' + fullUrl;
        }
      );

      // 4. JS 中的字符串字面量改写（动态加载资源）
      //    匹配带扩展名的资源文件
      replaced = replaced.replace(
        /(["'`])(https?:\/\/[^"'`\s<>]+\/[^"'`\s<>]+\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|otf|ico|map|webp|avif|mp4|webm|mp3|wav|ogg|pdf|wasm))\1/gi,
        (match, quote, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return quote + url.origin + '/' + fullUrl + quote;
        }
      );

      // 4.5 匹配常见 GitHub CDN 域名的 URL（无扩展名也改写）
      const cdnDomains = [
        'avatars.githubusercontent.com',
        'raw.githubusercontent.com',
        'camo.githubusercontent.com',
        'github.githubassets.com',
        'user-images.githubusercontent.com',
        'cloud.githubusercontent.com',
        'avatars0.githubusercontent.com',
        'avatars1.githubusercontent.com',
        'avatars2.githubusercontent.com',
        'avatars3.githubusercontent.com',
      ];
      for (const domain of cdnDomains) {
        // 匹配 "https://domain/..." 或 'https://domain/...' 或 `https://domain/...`
        const escapedDomain = domain.replace(/\./g, '\\.');
        const re = new RegExp(
          '(["\'`])(https?:\/\/' + escapedDomain + '[^"\'`\\s<>)]+)\\1',
          'gi'
        );
        replaced = replaced.replace(re, (match, quote, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return quote + url.origin + '/' + fullUrl + quote;
        });
        // 匹配无引号的 url(https://domain/...)
        const reUrl = new RegExp(
          '(url\\(\\s*[\'"]?)(https?:\/\/' + escapedDomain + '[^)\'"\\s]+)',
          'gi'
        );
        replaced = replaced.replace(reUrl, (match, prefix, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return prefix + url.origin + '/' + fullUrl;
        });
        // 匹配 src/href 属性中无引号或引号的情况已在上面处理
        // 匹配 =https://domain/... (无引号赋值)
        const reAssign = new RegExp(
          '(\\s(?:src|href|action|content)=)(https?:\/\/' + escapedDomain + '[^\\s>]+)',
          'gi'
        );
        replaced = replaced.replace(reAssign, (match, prefix, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return prefix + url.origin + '/' + fullUrl;
        });
      }

      // 5. CSS @import "https://..." 改写
      replaced = replaced.replace(
        /(@import\s+["'])(https?:\/\/[^"']+)/gi,
        (match, prefix, fullUrl) => {
          if (fullUrl.startsWith(url.origin)) return match;
          return prefix + url.origin + '/' + fullUrl;
        }
      );

      return new Response(replaced, { status: response.status, headers: respHeaders });
    }

    return new Response(response.body, { status: response.status, headers: respHeaders });
  },
};

function getCookie(cookieStr, name) {
  const match = cookieStr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

const ENTRY_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trace</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 16px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    background: linear-gradient(135deg, #f8faff 0%, #fcfbff 25%, #fefcfd 55%, #fffdf9 100%);
    position: relative;
    overflow: hidden;
  }
  body::before, body::after {
    content: '';
    position: absolute;
    border-radius: 50%;
    filter: blur(100px);
    z-index: 0;
    pointer-events: none;
  }
  body::before {
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(99,102,241,0.06), transparent 70%);
    top: -120px; left: -80px;
  }
  body::after {
    width: 450px; height: 450px;
    background: radial-gradient(circle, rgba(236,72,153,0.04), transparent 70%);
    bottom: -100px; right: -60px;
  }
  .card {
    position: relative;
    z-index: 1;
    background: rgba(255,255,255,0.72);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1.5px solid rgba(165,180,252,0.5);
    border-radius: 28px;
    padding: 48px 40px;
    width: 100%;
    max-width: 1000px;
    box-shadow: 0 1px 0 0 rgba(255,255,255,0.9) inset, 0 20px 50px -20px rgba(99,102,241,0.1), 0 8px 24px -8px rgba(0,0,0,0.03);
    display: flex;
    align-items: center;
    gap: 40px;
    animation: cardIn 0.5s ease-out;
  }
  @keyframes cardIn {
    from { opacity: 0; transform: translateY(12px) scale(0.99); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .card-left {
    width: 120px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .icon-wrap {
    width: 56px; height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, #6366f1, #7c3aed);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 24px;
    box-shadow: 0 8px 20px -6px rgba(99,102,241,0.4);
    transition: transform 0.3s;
  }
  .icon-wrap:hover { transform: scale(1.05) rotate(-3deg); }
  .icon-wrap svg { width: 28px; height: 28px; fill: white; }
  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: #1e293b;
    letter-spacing: -0.02em;
    margin-bottom: 8px;
    white-space: nowrap;
  }
  .subtitle { font-size: 0.85rem; color: #64748b; white-space: nowrap; }
  .card-right {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
  }
  .field {
    margin-bottom: 22px;
    width: 500px;
    max-width: 100%;
  }
  .field label {
    display: block;
    font-size: 0.8rem;
    font-weight: 600;
    color: #475569;
    margin-bottom: 8px;
    letter-spacing: 0.01em;
  }
  .input-wrap { position: relative; width: 100%; }
  .input-wrap svg {
    position: absolute;
    left: 14px; top: 50%;
    transform: translateY(-50%);
    width: 18px; height: 18px;
    fill: #94a3b8;
    pointer-events: none;
    transition: fill 0.2s;
  }
  input {
    width: 100%;
    padding: 13px 14px 13px 44px;
    background: rgba(255,255,255,0.6);
    border: 1.5px solid #a5b4fc;
    border-radius: 12px;
    color: #1e293b;
    font-size: 0.95rem;
    transition: all 0.2s;
  }
  input::placeholder { color: #c7d2fe; }
  input:hover { border-color: #818cf8; background: rgba(255,255,255,0.8); }
  input:focus {
    outline: none;
    border-color: #6366f1;
    background: white;
    box-shadow: 0 0 0 4px rgba(99,102,241,0.12);
  }
  .input-wrap:focus-within svg { fill: #6366f1; }
  button {
    width: 500px;
    max-width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, #6366f1, #7c3aed);
    border: none;
    border-radius: 12px;
    color: white;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.25s;
    box-shadow: 0 8px 20px -6px rgba(99,102,241,0.4);
  }
  button:hover {
    transform: translateY(-1px);
    background: linear-gradient(135deg, #4f46e5, #6d28d9);
    box-shadow: 0 12px 28px -6px rgba(99,102,241,0.5);
  }
  button:active { transform: translateY(0); }
  .error { color: #ef4444; font-size: 0.85rem; margin-top: 14px; min-height: 20px; text-align: center; }
  .hint { color: #94a3b8; font-size: 0.75rem; margin-top: 24px; text-align: center; }
  @media (max-width: 768px) {
    .card { flex-direction: column; max-width: 420px; padding: 40px 32px; gap: 32px; }
    .card-left { width: auto; }
    .field, button { width: 100%; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="card-left">
    <div class="icon-wrap">
      <svg viewBox="0 0 24 24"><path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5zm0 2.18L19 8.5v8.5c0 4.24-2.97 7.78-7 8.94-4.03-1.16-7-4.7-7-8.94V8.5l7-4.32zM12 7l-4 2v4c0 2.06 1.63 3.86 4 4.44 2.37-.58 4-2.38 4-4.44V9l-4-2z"/></svg>
    </div>
    <h1>反向追踪</h1>
    <p class="subtitle">输入目标地址和密码开始访问</p>
  </div>
  <div class="card-right">
    <form id="form">
      <div class="field">
        <label for="upstream">目标地址</label>
        <div class="input-wrap">
          <input type="text" id="upstream" placeholder="https://example.com" autocomplete="off" value="https://www.baidu.com">
          <svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        </div>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <div class="input-wrap">
          <input type="password" id="password" placeholder="请输入密码" autocomplete="off">
          <svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
        </div>
      </div>
      <button type="submit">进入</button>
      <div class="error" id="error"></div>
    </form>
    <p class="hint">首次输入密码后，7天内无需重复输入</p>
  </div>
</div>
<script>
document.getElementById('form').addEventListener('submit', function(e) {
  e.preventDefault();
  var upstream = document.getElementById('upstream').value.trim();
  var pwd = document.getElementById('password').value.trim();
  var errEl = document.getElementById('error');
  errEl.textContent = '';
  if (!upstream) { errEl.textContent = '请填写目标地址'; return; }
  var target = '/' + upstream + '/' + encodeURIComponent(pwd);
  window.location.href = target;
});
</script>
</body>
</html>`;
