"use strict";

/**
 * HuggingMes + Hermes WebUI — single-port router on HF Space port 7861.
 *
 * Routes:
 *   /login                -> HuggingMes login (password = GATEWAY_TOKEN)
 *   /health /status       -> JSON health (unauthenticated — for HF probes + keepalive)
 *   /hm  /hm/*            -> HuggingMes status page + app (auth-gated)
 *   /hmd /hmd/*           -> Hermes dashboard passthrough for off-Space
 *                            workspaces (no router auth — dashboard's own
 *                            session token gates writes; opt-in by URL)
 *   /dashboard            -> redirect to /hm
 *   /v1  /v1/*            -> Hermes gateway (bearer auth; HTML => login redirect)
 *   /telegram  /telegram/*-> Telegram webhook (unauthenticated; Telegram needs to reach it)
 *   everything else       -> Hermes WebUI (nesquena/hermes-webui) as the primary UI
 *                           WebUI handles its own login at /login-... no, wait: WebUI
 *                           also exposes /login. We keep HuggingMes' login at /login
 *                           so the shared GATEWAY_TOKEN gates both.
 *
 * Based on github.com/somratpro/HuggingMes with added WebUI routing as the
 * primary UI.
 */

const http = require("http");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const WEBUI_PORT = Number(process.env.HERMES_WEBUI_PORT || 8787);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const HM_PREFIX = "/hm";
// Dashboard passthrough for off-Space workspaces (e.g. hermes-workspace
// running on a laptop). Anything under /hmd/* is forwarded directly to the
// internal dashboard with no router-level auth — the dashboard's own
// ephemeral session token is the only gate. This is intentional: the
// workspace scrapes that token from /hmd/ and then sends it as the bearer
// on /hmd/api/* requests, exactly mirroring the dashboard's normal flow.
//
// Implication: anyone who can reach this Space's URL can call the dashboard
// API (sessions, skills, config). If you don't need remote workspace access,
// don't share the Space URL or set up an upstream auth layer.
const HMD_PREFIX = "/hmd";
const LOGIN_PATH = "/hm/login";
const SESSION_COOKIE = "huggingmes_session";
const PRIMARY_UI = (process.env.PRIMARY_UI || "webui").toLowerCase();

const SYNC_STATUS_FILE = "/tmp/huggingmes-sync-status.json";
const CLOUDFLARE_KEEPALIVE_STATUS_FILE =
  "/tmp/huggingmes-cloudflare-keepalive-status.json";

/* ── Port probing + auth ──────────────────────────────────────────── */

function canConnect(port, host = GATEWAY_HOST, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readJson(path, fallback = null) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function expectedSessionValue() {
  if (!API_SERVER_KEY) return "";
  return crypto
    .createHmac("sha256", API_SERVER_KEY)
    .update("huggingmes-session-v1")
    .digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const sep = item.indexOf("=");
    if (sep < 0) continue;
    const name = item.slice(0, sep).trim();
    const value = item.slice(sep + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function buildSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

function isAuthorized(req) {
  if (!API_SERVER_KEY) return true;
  return (
    timingSafeEqualString(getBearerToken(req), API_SERVER_KEY) ||
    timingSafeEqualString(
      parseCookies(req)[SESSION_COOKIE],
      expectedSessionValue(),
    )
  );
}

function sanitizeNext(value, fallback = "/") {
  if (!value || typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* ── Login page ───────────────────────────────────────────────────── */

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath, "/");
  const errorHtml = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMes + Hermes WebUI — Login</title>
  <style>
    :root { color-scheme: dark; --bg:#10141f; --panel:#171d2b; --line:#293246; --text:#f4f7fb; --muted:#9aa7bd; --bad:#ef4444; --accent:#38bdf8; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); padding:20px; }
    main { width:min(440px, 100%); border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:28px; }
    h1 { margin:0 0 8px; font-size:1.55rem; }
    p { margin:0 0 22px; color:var(--muted); line-height:1.5; }
    label { display:block; color:var(--muted); font-size:.82rem; margin-bottom:8px; }
    input { width:100%; min-height:46px; border:1px solid var(--line); border-radius:7px; background:#0b0f18; color:var(--text); padding:0 12px; font:inherit; }
    button { width:100%; min-height:44px; margin-top:16px; border:0; border-radius:7px; color:#07111f; background:var(--accent); font:inherit; font-weight:750; cursor:pointer; }
    .error { border:1px solid rgba(239,68,68,.4); background:rgba(239,68,68,.1); color:#fecaca; border-radius:7px; padding:10px 12px; margin-bottom:16px; }
  </style>
</head>
<body>
  <main>
    <h1>HuggingMes Admin</h1>
    <p>Enter the <code>GATEWAY_TOKEN</code> from your Space secrets to access the status dashboard.<br>For the Hermes chat UI, go to <a href="/" style="color:var(--accent)">/</a>.</p>
    ${errorHtml}
    <form method="post" action="${LOGIN_PATH}">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
      <label for="token">GATEWAY_TOKEN</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(parsed.searchParams.get("next") || "/", "/");

  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLoginPage(nextPath));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath, "/");

    if (!timingSafeEqualString(submittedToken, API_SERVER_KEY)) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        renderLoginPage(
          submittedNext,
          "That token did not match GATEWAY_TOKEN.",
        ),
      );
      return;
    }

    res.writeHead(302, {
      location: submittedNext,
      "set-cookie": buildSessionCookie(req),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(error.message || "Invalid login request.");
  }
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

/* ── Upstream proxy ────────────────────────────────────────────────── */

function proxyRequest(
  req,
  res,
  targetPort,
  rewritePath = (path) => path,
  headerOverrides = {},
) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const localOrigin = `http://${GATEWAY_HOST}:${targetPort}`;
  const headers = {
    ...req.headers,
    ...headerOverrides,
    host: `${GATEWAY_HOST}:${targetPort}`,
    origin: localOrigin,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };

  // Python's BaseHTTPRequestHandler (used by hermes-webui and the dashboard)
  // cannot decode chunked request bodies — read_body() only reads via
  // Content-Length, and leftover chunk framing corrupts subsequent requests
  // on keep-alive connections (HTTP 501 with junk prepended to the method).
  // Buffer the full body and send it with an explicit Content-Length header
  // so Node.js never uses Transfer-Encoding: chunked.
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (hasBody) {
    const chunks = [];
    let size = 0;
    const limit = 20 * 1024 * 1024;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
        }
      }
    });
    req.on("end", () => {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(size);
      const proxy = http.request(
        {
          hostname: GATEWAY_HOST,
          port: targetPort,
          method: req.method,
          path: targetPath,
          headers,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
        }
      });
      if (size > 0) proxy.write(Buffer.concat(chunks));
      proxy.end();
    });
    req.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
      }
    });
    return;
  }

  const proxy = http.request(
    {
      hostname: GATEWAY_HOST,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}


/* ── Multi-user auth helpers (parent accounts) ───────────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL || "https://xqhnjbbewoldwtndxfrm.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxaG5qYmJld29sZHd0bmR4ZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwOTY4NDMsImV4cCI6MjA5NjY3Mjg0M30.9WHMU3utNiMGVyHrwYZs5ivGDT29SN8XFtQ5oSU76Lw";

/**
 * Verify a Supabase JWT by calling the Auth REST API.
 * Returns user object on success, null on failure.
 * @param {string} token - The access_token JWT
 * @returns {Promise<object|null>}
 */
async function verifySupabaseToken(token) {
  if (!token) return null;
  try {
    const url = `${SUPABASE_URL}/auth/v1/user`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": SUPABASE_ANON_KEY
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user;
  } catch (e) {
    console.error("supabase-verify:", e.message);
    return null;
  }
}

/**
 * Parse Authorization header and extract Bearer token.
 */
function extractBearerToken(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}
const AI_TUTOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>AI Tutor</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.1/dist/umd/supabase.min.js"><\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0c29;--card:#1a1740;--surface:#242052;--text:#e8e6f0;--text-muted:#9490b8;--accent:#7c6cf0;--accent-hover:#9488f5;--accent-bg:rgba(124,108,240,.15);--border:rgba(255,255,255,.08);--radius:12px;--shadow:0 4px 24px rgba(0,0,0,.3)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
.chat-app{width:100%;max-width:800px;height:100vh;display:flex;flex-direction:column;background:var(--card);box-shadow:var(--shadow)}
@media(min-width:640px){.chat-app{max-height:900px;border-radius:var(--radius);margin:20px;height:calc(100vh - 40px)}}
.chat-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.chat-header h1{font-size:18px;font-weight:700;background:linear-gradient(135deg,#7c6cf0,#b8aaff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.chat-header .actions{display:flex;gap:8px}
.chat-header button{background:var(--surface);border:none;color:var(--text);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s}
.chat-header button:hover{background:var(--accent-bg);color:var(--accent)}
.messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.msg{max-width:92%;padding:12px 16px;border-radius:var(--radius);font-size:15px;line-height:1.6;animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.msg.user{background:var(--accent);align-self:flex-end;border-bottom-right-radius:4px;word-break:break-word}
.msg.assistant{background:var(--surface);align-self:flex-start;border-bottom-left-radius:4px;word-break:break-word}
.msg.assistant p{margin-bottom:8px}.msg.assistant p:last-child{margin-bottom:0}
.msg.assistant strong{color:var(--accent)}
.msg.assistant code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;font-size:13px;font-family:'Cascadia Code','Fira Code',monospace}
.msg.assistant pre{background:rgba(0,0,0,.4);padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:13px}
.msg.assistant .svg-container{background:var(--card);border-radius:8px;padding:12px;margin:8px 0;text-align:center;overflow:hidden}
.msg.assistant .svg-container svg{max-width:100%;height:auto;border-radius:4px}
.msg.assistant ul,.msg.assistant ol{padding-left:20px;margin:8px 0}
.typing{padding:12px 16px;background:var(--surface);border-radius:var(--radius);align-self:flex-start;font-size:14px;color:var(--text-muted);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
.input-area{border-top:1px solid var(--border);padding:10px 14px;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
.input-area textarea{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:15px;font-family:inherit;resize:none;min-height:44px;max-height:120px;outline:none;transition:border .2s}
.input-area textarea:focus{border-color:var(--accent)}
.input-area textarea::placeholder{color:var(--text-muted)}
.input-area button{background:var(--accent);border:none;color:#fff;width:44px;height:44px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
.input-area button:hover{background:var(--accent-hover)}
.input-area button:disabled{opacity:.4;cursor:not-allowed}
.input-area button svg{width:20px;height:20px}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#d32f2f;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:1000;display:none}
.welcome{padding:40px 20px;text-align:center;color:var(--text-muted);flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.welcome h2{font-size:22px;color:var(--text)}.welcome p{font-size:14px;max-width:400px;line-height:1.6}
</style>
</head>
<body>
<div class="chat-app">
<div class="chat-header">
<h1>AI Tutor</h1>
<div class="actions">
<button onclick="newChat()" title="New chat">&#x2795;</button>
<button onclick="logout()" title="Sign out">&#x2192;</button>
</div>
</div>
<div class="messages" id="messages">
<div class="welcome" id="welcome"><h2>Your AI Tutor</h2><p>Ask any question about your studies. I explain concepts with clear examples, diagrams, and step-by-step guidance.</p><p style="font-size:12px;color:var(--text-muted)">Try: "Explain Pythagoras theorem" or "Solve x² + 5x + 6 = 0"</p></div>
</div>
<div class="input-area">
<textarea id="input" rows="1" placeholder="Ask anything..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"><\/textarea>
<button id="sendBtn" onclick="send()" disabled>
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/><\/svg>
<\/button>
</div>
</div>
<div class="toast" id="toast"><\/div>
<script>
const SUPABASE_URL="{SUPABASE_URL}",SUPABASE_ANON_KEY="{SUPABASE_ANON_KEY}";
const supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{{auth:{{persistSession:true,autoRefreshToken:true,storageKey:'ai-tutor-auth'}}}});
const STORAGE_KEY='ai_tutor_conv';let convId=null,loading=false;
function toast(m){{const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',4000)}}
function loadC(){{try{{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{{}}')}}catch{{return{{}}}}}}
function saveC(c){{localStorage.setItem(STORAGE_KEY,JSON.stringify(c))}}
function renderMD(t){{let h=t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
h=h.replace(/<pre><code>svg\n?([\s\S]*?)<\/code><\/pre>/gi,(m,s)=>{{const d=s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');return '<div class="svg-container">'+d+'<\/div>'}})
h=h.replace(/<pre><code>\w*\n?([\s\S]*?)<\/code><\/pre>/gi,'<pre><code>$1<\/code><\/pre>').replace(/<code>([^<]+)<\/code>/g,'<code>$1<\/code>')
h=h.replace(/\*\*(.*?)\*\*/g,'<strong>$1<\/strong>').replace(/\*(.*?)\*/g,'<em>$1<\/em>').replace(/\n/g,'<br>')
h=h.replace(/(<br>){{2,}}/g,'<\/p><p>');if(!h.startsWith('<'))h='<p>'+h+'<\/p>';return h}}
async function send(){{const i=document.getElementById('input'),b=document.getElementById('sendBtn'),t=i.value.trim();if(!t||loading)return;i.value='';i.style.height='auto'
const {{data:{{session}}}}=await supabase.auth.getSession();if(!session){{window.location.href='/signin';return}}
let c=loadC();if(!convId||!c[convId]){{convId='c_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);c[convId]={{id:convId,title:t.slice(0,50),messages:[],createdAt:new Date().toISOString()}}}}
c[convId].messages.push({{role:'user',content:t}});saveC(c)
const m=document.getElementById('messages');m.insertAdjacentHTML('beforeend','<div class="msg user"><p>'+t.replace(/</g,'&lt;')+'<\/p><\/div>')
const wel=document.getElementById('welcome');if(wel)wel.style.display='none'
loading=true;b.disabled=true;const te=document.createElement('div');te.className='typing';te.id='typing';te.textContent='Thinking...';m.appendChild(te);m.scrollTop=m.scrollHeight
try{{const msgs=c[convId].messages.map(m=>({{role:m.role,content:m.content}}));const r=await fetch('/api/chat',{{method:'POST',headers:{{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token}},body:JSON.stringify({{messages:msgs}})}});const e=document.getElementById('typing');if(e)e.remove()
if(!r.ok){{const d=await r.json().catch(()=>({{error:'Request failed'}}));m.insertAdjacentHTML('beforeend','<div class="msg assistant"><p>Error: '+d.error+'<\/p><\/div>');c[convId].messages.push({{role:'assistant',content:'Error: '+d.error}})}}
else{{const d=await r.json(),reply=d.choices?.[0]?.message?.content||'No response';m.insertAdjacentHTML('beforeend','<div class="msg assistant">'+renderMD(reply)+'<\/div>');c[convId].messages.push({{role:'assistant',content:reply}})}}
saveC(c);m.scrollTop=m.scrollHeight}}catch(e){{const tel=document.getElementById('typing');if(tel)tel.remove();toast('Network error')}}finally{{loading=false;b.disabled=false;i.focus()}}}}
function newChat(){{convId=null;document.getElementById('messages').innerHTML='<div class="welcome" id="welcome"><h2>Your AI Tutor<\/h2><p>Ask any question about your studies. I explain concepts with clear examples, diagrams, and step-by-step guidance.<\/p><p style="font-size:12px;color:var(--text-muted)">Try: "Explain Pythagoras theorem" or "Solve x² + 5x + 6 = 0"<\/p><\/div>';document.getElementById('input').value='';document.getElementById('input').focus()}}
async function logout(){{await supabase.auth.signOut();window.location.href='/signin'}}
const ta=document.getElementById('input');ta.addEventListener('input',()=>{{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,120)+'px';document.getElementById('sendBtn').disabled=!ta.value.trim()||loading}})
// Check auth on load
supabase.auth.getSession().then(({{data:{{session}}}})=>{{if(!session)window.location.href='/signin'}})
ta.focus();
<\/script>
</body>
</html>`;const SIGNIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Tutor — Sign In</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.1/dist/umd/supabase.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.card h1{font-size:24px;margin-bottom:8px;color:#1a1a2e}
.card p{color:#666;font-size:14px;margin-bottom:24px}
.tabs{display:flex;gap:0;margin-bottom:24px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0}
.tab{flex:1;padding:10px;text-align:center;cursor:pointer;font-size:14px;font-weight:500;background:#f5f5f5;color:#666;border:none;transition:all .2s}
.tab.active{background:#302b63;color:#fff}
.form{display:none}
.form.active{display:block}
.form label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:6px}
.form input{width:100%;padding:12px 14px;border:2px solid #e0e0e0;border-radius:8px;font-size:15px;transition:border .2s;margin-bottom:16px}
.form input:focus{outline:none;border-color:#302b63}
.form button{width:100%;padding:12px;background:linear-gradient(135deg,#302b63,#24243e);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
.form button:hover{opacity:.9}
.form button:disabled{opacity:.5;cursor:not-allowed}
.error{color:#d32f2f;font-size:13px;margin-top:-10px;margin-bottom:12px;display:none}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#d32f2f;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;z-index:1000;display:none;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.loader{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="toast" id="toast"></div>
<div class="card">
<h1>AI Tutor</h1>
<p>Your personal AI learning assistant</p>
<div class="tabs">
<button class="tab active" onclick="switchTab('signin')" id="tab-signin">Sign In</button>
<button class="tab" onclick="switchTab('signup')" id="tab-signup">Sign Up</button>
</div>
<div class="form active" id="form-signin">
<form onsubmit="return doLogin(event)">
<label for="email">Email</label>
<input type="email" id="login-email" placeholder="your@email.com" required autocomplete="email">
<label for="password">Password</label>
<input type="password" id="login-pass" placeholder="Enter password" required autocomplete="current-password">
<button type="submit" id="login-btn">Sign In</button>
<div class="error" id="login-error"></div>
</form>
</div>
<div class="form" id="form-signup">
<form onsubmit="return doSignup(event)">
<label for="name">Your Name</label>
<input type="text" id="signup-name" placeholder="Parent's name" autocomplete="name">
<label for="email">Email</label>
<input type="email" id="signup-email" placeholder="your@email.com" required autocomplete="email">
<label for="password">Password (min 6 characters)</label>
<input type="password" id="signup-pass" placeholder="Create a password" required autocomplete="new-password">
<button type="submit" id="signup-btn">Create Account</button>
<div class="error" id="signup-error"></div>
</form>
</div>
</div>
<script>
const SUPABASE_URL = "https://xqhnjbbewoldwtndxfrm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxaG5qYmJld29sZHd0bmR4ZnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwOTY4NDMsImV4cCI6MjA5NjY3Mjg0M30.9WHMU3utNiMGVyHrwYZs5ivGDT29SN8XFtQ5oSU76Lw";
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function switchTab(t){
document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
document.getElementById('tab-'+t).classList.add('active');
document.querySelectorAll('.form').forEach(f=>f.classList.remove('active'));
document.getElementById('form-'+t).classList.add('active');
document.querySelectorAll('.error').forEach(e=>e.style.display='none');
}

function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',4000)}

async function doLogin(e){
e.preventDefault();const btn=document.getElementById('login-btn');btn.disabled=true;btn.innerHTML='<span class="loader"><\/span> Signing in...';
try{
const {data,error} = await supabase.auth.signInWithPassword({
email: document.getElementById('login-email').value,
password: document.getElementById('login-pass').value
});
if(error){document.getElementById('login-error').textContent=error.message;document.getElementById('login-error').style.display='block';btn.innerHTML='Sign In';btn.disabled=false}
else{window.location.href='/'}
}catch(e){toast('Network error. Please try again.');btn.innerHTML='Sign In';btn.disabled=false}
}

async function doSignup(e){
e.preventDefault();const btn=document.getElementById('signup-btn');btn.disabled=true;btn.innerHTML='<span class="loader"><\/span> Creating...';
try{
const name = document.getElementById('signup-name').value || document.getElementById('signup-email').value.split('@')[0];
const {data,error} = await supabase.auth.signUp({
email: document.getElementById('signup-email').value,
password: document.getElementById('signup-pass').value,
options: { data: { full_name: name } }
});
if(error){document.getElementById('signup-error').textContent=error.message;document.getElementById('signup-error').style.display='block';btn.innerHTML='Create Account';btn.disabled=false}
else{toast('Account created! Redirecting...');setTimeout(()=>window.location.href='/',1500)}
}catch(e){toast('Network error. Please try again.');btn.innerHTML='Create Account';btn.disabled=false}
}

// Check if already logged in — redirect straight to chat
supabase.auth.getSession().then(({data:{session}})=>{
if(session) window.location.href='/';
});
<\/script>
</body>
</html>`;

/* ── Dashboard SPA proxy with HTML rewriting ──────────────────────────
 *
 * The Hermes dashboard is a Vite React app built for root-path deployment.
 * Its HTML hardcodes window.__HERMES_BASE_PATH__="" and absolute src/href
 * paths like /assets/index-XXX.js. Under /hm/app, React's router wouldn't
 * know its basename and client-side routes (/config, /sessions, etc.) 404
 * on refresh.
 *
 * This proxy:
 *   - serves the dashboard's index.html for any non-asset /hm/app/* path
 *     (SPA fallback, so /config, /profiles etc. work on direct load)
 *   - rewrites the returned HTML so React router uses /hm/app as its
 *     basename and absolute asset paths get prefixed with /hm/app
 */
function proxyDashboard(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const inner = parsed.pathname.replace(`${HM_PREFIX}/app`, "") || "/";

  const isAssetLike =
    inner.startsWith("/assets/") ||
    inner.startsWith("/api/") ||
    inner.startsWith("/dashboard-plugins/") ||
    inner.startsWith("/ds-assets/") ||
    /\.[a-z0-9]{1,6}$/i.test(inner);

  // SPA routes → serve index.html; everything else → forward as-is.
  const targetPath =
    (isAssetLike || inner === "/" ? inner : "/") + parsed.search;

  const headers = {
    ...req.headers,
    host: `${GATEWAY_HOST}:${DASHBOARD_PORT}`,
    origin: `http://${GATEWAY_HOST}:${DASHBOARD_PORT}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
    // Disable upstream compression so we can rewrite text responses.
    "accept-encoding": "identity",
  };

  const upstream = http.request(
    {
      hostname: GATEWAY_HOST,
      port: DASHBOARD_PORT,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upRes) => {
      const contentType = String(upRes.headers["content-type"] || "");
      const shouldRewrite =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml");

      if (!shouldRewrite) {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        return;
      }

      const chunks = [];
      upRes.on("data", (chunk) => chunks.push(chunk));
      upRes.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");

        // Tell the React router its basename.
        body = body.replace(
          /window\.__HERMES_BASE_PATH__\s*=\s*"[^"]*"/g,
          `window.__HERMES_BASE_PATH__="${HM_PREFIX}/app"`,
        );

        // Prefix absolute asset URLs so they stay under /hm/app.
        const prefix = `${HM_PREFIX}/app`;
        body = body.replace(
          /\b(src|href)="\/(?!\/|http)([^"]*)"/g,
          (match, attr, rest) => {
            if (
              ("/" + rest).startsWith(prefix + "/") ||
              "/" + rest === prefix
            ) {
              return match;
            }
            return `${attr}="${prefix}/${rest}"`;
          },
        );

        const buf = Buffer.from(body, "utf8");
        const outHeaders = { ...upRes.headers };
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-encoding"];
        outHeaders["content-length"] = String(buf.length);

        res.writeHead(upRes.statusCode || 502, outHeaders);
        res.end(buf);
      });
      upRes.on("error", () => {
        try {
          res.writeHead(502);
          res.end();
        } catch {}
      });
    },
  );

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  // Buffer body before forwarding — same chunked-encoding fix as proxyRequest.
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (hasBody) {
    const bodyChunks = [];
    let bodySize = 0;
    req.on("data", (chunk) => {
      bodyChunks.push(chunk);
      bodySize += chunk.length;
    });
    req.on("end", () => {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(bodySize);
      upstream.end(Buffer.concat(bodyChunks));
    });
    req.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
      }
    });
  } else {
    req.pipe(upstream);
  }
}

/* ── Status JSON + HuggingMes status page ─────────────────────────── */

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function statusPayload() {
  const gateway = await canConnect(GATEWAY_PORT);
  const dashboard = await canConnect(DASHBOARD_PORT);
  const webui = await canConnect(WEBUI_PORT);
  const telegramWebhook =
    !!process.env.TELEGRAM_WEBHOOK_URL &&
    (await canConnect(TELEGRAM_WEBHOOK_PORT));
  const sync = readJson(
    SYNC_STATUS_FILE,
    process.env.HF_TOKEN
      ? { status: "configured", message: "Backup enabled; waiting for first sync." }
      : { status: "disabled", message: "HF_TOKEN is not configured." },
  );

  return {
    ok: gateway && webui,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    webui,
    authConfigured: !!API_SERVER_KEY,
    primaryUi: PRIMARY_UI,
    ports: {
      public: PORT,
      gateway: GATEWAY_PORT,
      dashboard: DASHBOARD_PORT,
      webui: WEBUI_PORT,
      telegramWebhook: TELEGRAM_WEBHOOK_PORT,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
      proxy: process.env.CLOUDFLARE_PROXY_URL || "",
    },
    model:
      process.env.MODEL_FOR_CONFIG ||
      process.env.HERMES_MODEL ||
      process.env.LLM_MODEL ||
      "",
    provider:
      process.env.PROVIDER_FOR_CONFIG ||
      process.env.HERMES_INFERENCE_PROVIDER ||
      "auto",
    backup: sync,
    keepalive: readJson(CLOUDFLARE_KEEPALIVE_STATUS_FILE, null),
  };
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function valueOrUnset(value, fallback = "Not set") {
  return value
    ? escapeHtml(value)
    : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral", meta = "" }) {
  return `<article class="tile ${tone}">
    <div class="tile-head">
      <span class="tile-title">${escapeHtml(title)}</span>
      <span class="tile-dot"></span>
    </div>
    <div class="tile-value">${value}</div>
    ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
    ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
  </article>`;
}

function renderStatusPage(data) {
  const syncStatus = String(data.backup?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(syncStatus)
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const telegramTone = data.telegram.configured
    ? data.telegram.webhookListening || !data.telegram.webhook
      ? "ok"
      : "warn"
    : "warn";
  const keepaliveConfigured = data.keepalive?.configured === true;
  const keepaliveStatus = String(
    data.keepalive?.status ||
      (process.env.CLOUDFLARE_WORKERS_TOKEN ? "pending" : "not configured"),
  );
  const keepAliveTone = keepaliveConfigured
    ? "ok"
    : process.env.CLOUDFLARE_WORKERS_TOKEN
      ? "warn"
      : "neutral";
  const telegramDetail = data.telegram.configured
    ? `${data.telegram.webhook ? "Webhook" : "Polling"}${data.telegram.proxy ? " via CF proxy" : ""}`
    : "Not configured";
  const backupDetail = data.backup?.message
    ? escapeHtml(data.backup.message)
    : "No status yet";
  // Extra one-line warning row for known-loud failure modes (currently:
  // ephemeral .env on a Space). hermes-sync.py emits this via warning.message.
  const backupWarning = data.backup?.warning?.message
    ? `<div class="tile-warning">${escapeHtml(data.backup.warning.message)}</div>`
    : "";
  const keepAliveDetail = keepaliveConfigured
    ? `Pinging <code>${escapeHtml(data.keepalive.targetUrl || "/health")}</code>`
    : keepaliveStatus === "error" && data.keepalive?.message
      ? escapeHtml(data.keepalive.message)
      : process.env.CLOUDFLARE_WORKERS_TOKEN
        ? "Worker pending or failed"
        : "Not configured";

  const tiles = [
    renderTile({
      title: "WebUI",
      value: toneBadge(data.webui ? "Online" : "Offline", data.webui ? "ok" : "off"),
      detail: data.webui ? `Port ${data.ports.webui}` : "Unreachable",
      tone: data.webui ? "ok" : "off",
    }),
    renderTile({
      title: "Gateway",
      value: toneBadge(data.gateway ? "Online" : "Offline", data.gateway ? "ok" : "off"),
      detail: data.gateway ? `API on port ${data.ports.gateway}` : "Unreachable",
      tone: data.gateway ? "ok" : "off",
      meta: data.authConfigured ? "Protected" : "Unprotected",
    }),
    renderTile({
      title: "Model",
      value: `<code>${valueOrUnset(data.model)}</code>`,
      detail: `Provider: ${valueOrUnset(data.provider || "auto")}`,
      tone: data.model ? "ok" : "warn",
    }),
    renderTile({
      title: "Runtime",
      value: escapeHtml(data.uptime),
      detail: `Port ${data.ports.public}`,
      tone: "neutral",
    }),
    renderTile({
      title: "Telegram",
      value: toneBadge(data.telegram.configured ? "Configured" : "Disabled", telegramTone),
      detail: telegramDetail,
      tone: telegramTone,
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), data.backup?.warning ? "warn" : syncTone),
      detail: backupDetail + backupWarning,
      tone: data.backup?.warning ? "warn" : syncTone,
      meta: data.backup?.timestamp
        ? `<span class="local-time" data-iso="${data.backup.timestamp}"></span>`
        : "",
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(
        keepaliveConfigured ? "CF Cron" : keepaliveStatus.toUpperCase(),
        keepAliveTone,
      ),
      detail: keepAliveDetail,
      tone: keepAliveTone,
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMes + Hermes WebUI</title>
  <style>
    :root { color-scheme: dark; --bg:#08080f; --panel:#12111b; --line:#26243a; --text:#f6f4ff; --muted:#7f7a9e; --soft:#b8b3d7; --good:#22c55e; --warn:#f5c542; --bad:#fb7185; --accent:#6557df; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); font-size:13px; }
    main { width:min(720px, calc(100% - 32px)); margin:0 auto; padding:36px 0 44px; }
    header { text-align:center; margin-bottom:22px; }
    h1 { margin:0; font-size:1.65rem; }
    .subtitle { margin-top:12px; color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.14em; font-weight:800; }
    .row { display:flex; gap:10px; margin:24px 0 20px; flex-wrap:wrap; }
    .hero-action { flex:1 1 200px; min-height:46px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:#ffffff; color:#000000; text-decoration:none; font-weight:850; font-size:.98rem; }
    .hero-action.secondary { background:#232234; color:var(--text); border:1px solid var(--line); }
    .hero-action:hover { opacity:.9; }
    .overview { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:10px; }
    .tile { border:1px solid var(--line); background:var(--panel); border-radius:11px; padding:18px; min-height:124px; display:flex; flex-direction:column; gap:10px; position:relative; }
    .tile.ok { border-color:rgba(34,197,94,.22); }
    .tile.warn { border-color:rgba(245,197,66,.24); }
    .tile.off { border-color:rgba(251,113,133,.28); }
    .tile-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .tile-title { color:var(--muted); font-size:.67rem; letter-spacing:.18em; text-transform:uppercase; font-weight:850; }
    .tile-dot { width:7px; height:7px; border-radius:50%; background:var(--line); }
    .tile.ok .tile-dot { background:var(--good); }
    .tile.warn .tile-dot { background:var(--warn); }
    .tile.off .tile-dot { background:var(--bad); }
    .tile-value { font-size:1.12rem; font-weight:850; overflow-wrap:anywhere; }
    .tile-detail { color:var(--soft); line-height:1.45; font-size:.83rem; }
    .tile-meta { color:var(--muted); line-height:1.4; font-size:.75rem; margin-top:auto; overflow-wrap:anywhere; }
    .tile-warning { color:#fde68a; background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.32); border-radius:6px; padding:6px 8px; margin-top:6px; font-size:.78rem; line-height:1.4; }
    code { background:#232234; border:1px solid #34324c; border-radius:6px; padding:2px 6px; color:var(--text); font-size:.9em; }
    .badge { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:5px 10px; font-size:.72rem; font-weight:850; line-height:1; text-transform:uppercase; }
    .badge.ok { color:var(--good); border-color:rgba(34,197,94,.34); background:rgba(34,197,94,.11); }
    .badge.warn { color:var(--warn); border-color:rgba(245,197,66,.34); background:rgba(245,197,66,.11); }
    .badge.off { color:var(--bad); border-color:rgba(251,113,133,.34); background:rgba(251,113,133,.11); }
    .badge.neutral { color:var(--soft); }
    .muted { color:var(--muted); }
    footer { color:var(--muted); text-align:center; font-size:.74rem; margin-top:18px; }
    @media (max-width: 700px) { .overview { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>HuggingMes + Hermes WebUI</h1>
      <div class="subtitle">Self-hosted Hermes Agent on HF Spaces</div>
    </header>
    <div class="row">
      <a class="hero-action" href="/" target="_blank" rel="noopener">Open Hermes WebUI -&gt;</a>
      <a class="hero-action secondary" href="${HM_PREFIX}/app/" target="_blank" rel="noopener">Open Hermes Dashboard</a>
    </div>
    <section class="overview">
      ${tiles}
    </section>
    <footer>Built on <a href="https://github.com/somratpro/HuggingMes" style="color:var(--accent)">HuggingMes</a> + <a href="https://github.com/nesquena/hermes-webui" style="color:var(--accent)">Hermes WebUI</a></footer>
  </main>
  <script>
    document.querySelectorAll('.local-time').forEach(el => {
      const date = new Date(el.getAttribute('data-iso'));
      if (!isNaN(date)) el.textContent = 'At ' + date.toLocaleTimeString();
    });
  </script>
</body>
</html>`;
}

/* ── Server ───────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  // 1. /hm/login — HuggingMes admin login (cookie-based, gates /hm/*).
  //    hermes-webui handles its own /login at the catch-all below.
  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }

  // 2. /health — unauthenticated; HF Spaces probes + Cloudflare keepalive.
  if (path === "/health") {
    const data = await statusPayload();
    res.writeHead(data.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: data.ok,
        gateway: data.gateway,
        webui: data.webui,
        uptime: data.uptime,
      }),
    );
    return;
  }

  // 3. /status — unauthenticated JSON status dump.
  if (path === "/status" || path === "/api/status") {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // 4. /telegram — webhook endpoint; no auth (Telegram can't do our cookie).
  if (path === "/telegram" || path.startsWith("/telegram/")) {
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }

  // 5. /v1/* — Hermes gateway OpenAI-compatible API.
  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message: "Use Authorization: Bearer <GATEWAY_TOKEN>.",
        }),
      );
      return;
    }
    const upstreamHeaders =
      getBearerToken(req) || !API_SERVER_KEY
        ? {}
        : { authorization: `Bearer ${API_SERVER_KEY}` };
    proxyRequest(req, res, GATEWAY_PORT, (p) => p, upstreamHeaders);
    return;
  }

  // 6. /hm — HuggingMes status page.
  if (path === HM_PREFIX || path === `${HM_PREFIX}/`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  // /hmd/* — Off-Space dashboard passthrough.
  //
  // Forwards verbatim to the internal Hermes dashboard on DASHBOARD_PORT,
  // including its /api/* endpoints, /assets/*, root HTML (which carries the
  // ephemeral session token), and WebSocket upgrades. Workspace clients
  // (e.g. hermes-workspace) point HERMES_DASHBOARD_URL at
  //   https://<space>/hmd
  // and the workspace's own scrape-the-token-from-root-HTML logic just
  // works because /hmd/ returns the unmodified dashboard index.
  //
  // SECURITY: this prefix has no router-level auth on purpose — the
  // dashboard's own session token gates writes. If you need an extra layer,
  // wrap your Space behind a Cloudflare Access policy or remove this
  // handler.
  if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    proxyRequest(req, res, DASHBOARD_PORT, (p) => p.replace(HMD_PREFIX, "") || "/");
    return;
  }

  // /hm/app/* -> Hermes dashboard (SPA with HTML rewriting for base path)
  if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    if (!requireAuth(req, res)) return;
    proxyDashboard(req, res);
    return;
  }

  // /hm/status -> JSON
  if (path === `${HM_PREFIX}/status`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // /hm/logs — view service logs without needing HF Pro SSH.
  if (path === `${HM_PREFIX}/logs` || path.startsWith(`${HM_PREFIX}/logs/`)) {
    if (!requireAuth(req, res)) return;
    const logDir = `${process.env.HERMES_HOME || "/opt/data"}/logs`;
    const logFiles = ["dashboard.log", "gateway.log", "webui.log"];
    if (path.startsWith(`${HM_PREFIX}/logs/`)) {
      const name = path.slice(`${HM_PREFIX}/logs/`.length);
      if (!logFiles.includes(name)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      try {
        const tail = Number(parsed.searchParams.get("tail") || 200);
        const content = fs.readFileSync(`${logDir}/${name}`, "utf8");
        const lines = content.split("\n");
        const sliced = lines.slice(-tail);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(sliced.join("\n"));
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`Log file ${name} not found`);
      }
      return;
    }
    const links = logFiles.map((f) => {
      const size = (() => { try { return fs.statSync(`${logDir}/${f}`).size; } catch { return 0; } })();
      return `<li><a href="${HM_PREFIX}/logs/${f}?tail=200">${escapeHtml(f)}</a> (${(size / 1024).toFixed(1)} KB)</li>`;
    }).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>HuggingMes Logs</title>
<style>body{font-family:monospace;background:#0a0a12;color:#e0e0e0;padding:20px}a{color:#38bdf8}h1{font-size:1.2rem}li{margin:8px 0}</style></head>
<body><h1>Service Logs</h1><p>Append <code>?tail=N</code> to limit lines (default 200).</p><ul>${links}</ul></body></html>`);
    return;
  }

  // /hm/debug/model-options — debug proxy: fetch /api/model/options from
  // the dashboard directly and return the raw response so we can see the
  // actual error body without needing SSH/Pro.
  if (path === `${HM_PREFIX}/debug/model-options`) {
    if (!requireAuth(req, res)) return;
    const localHost = `${GATEWAY_HOST}:${DASHBOARD_PORT}`;
    const localOrigin = `http://${localHost}`;
    // Step 1: fetch dashboard root to extract session token
    const rootReq = http.request(
      { hostname: GATEWAY_HOST, port: DASHBOARD_PORT, method: "GET", path: "/", headers: { host: localHost, origin: localOrigin } },
      (rootRes) => {
        const chunks = [];
        rootRes.on("data", (c) => chunks.push(c));
        rootRes.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          const m = html.match(/__HERMES_SESSION_TOKEN__\s*[=:]\s*["']([A-Za-z0-9_\-]+)["']/)
            || html.match(/session[_-]?token\s*[=:]\s*["']([A-Za-z0-9_\-]+)["']/i);
          const token = m ? m[1] : "";
          if (!token) {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(`Could not extract session token from dashboard HTML.\n\nHTML preview (first 500 chars):\n${html.slice(0, 500)}`);
            return;
          }
          // Step 2: hit /api/model/options with the token
          const apiReq = http.request(
            { hostname: GATEWAY_HOST, port: DASHBOARD_PORT, method: "GET", path: "/api/model/options", headers: { host: localHost, origin: localOrigin, "x-hermes-session-token": token } },
            (apiRes) => {
              const bodyChunks = [];
              apiRes.on("data", (c) => bodyChunks.push(c));
              apiRes.on("end", () => {
                const body = Buffer.concat(bodyChunks).toString("utf8");
                res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
                res.end(`Token: ${token.slice(0, 8)}...\nStatus: ${apiRes.statusCode}\nHeaders: ${JSON.stringify(apiRes.headers, null, 2)}\n\n${body}`);
              });
              apiRes.on("error", (e) => {
                res.writeHead(502, { "content-type": "text/plain" });
                res.end(`API probe error: ${e.message}`);
              });
            },
          );
          apiReq.on("error", (e) => {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`API connection error: ${e.message}`);
          });
          apiReq.end();
        });
        rootRes.on("error", (e) => {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Dashboard root error: ${e.message}`);
        });
      },
    );
    rootReq.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Dashboard connection error: ${e.message}`);
    });
    rootReq.end();
    return;
  }

  // /hm/debug/model-options-trace — runs Python directly to call
  // build_models_payload() with full traceback output.
  if (path === `${HM_PREFIX}/debug/model-options-trace`) {
    if (!requireAuth(req, res)) return;
    const { execFile } = require("child_process");
    const pyCode = `
import os, sys, traceback
os.environ.setdefault("HERMES_HOME", "/opt/data")
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/opt/hermes/.venv/lib/python3.12/site-packages")
try:
    from hermes_cli.inventory import build_models_payload, load_picker_context
    ctx = load_picker_context()
    print("=== load_picker_context OK ===")
    print("  current_model:", repr(ctx.current_model))
    print("  current_provider:", repr(ctx.current_provider))
    print("  current_base_url:", repr(ctx.current_base_url))
    print("  user_providers:", type(ctx.user_providers).__name__, list(ctx.user_providers.keys()) if isinstance(ctx.user_providers, dict) else "")
    print("  custom_providers:", type(ctx.custom_providers).__name__, list(ctx.custom_providers.keys()) if isinstance(ctx.custom_providers, dict) else "")
except Exception:
    print("=== load_picker_context FAILED ===")
    traceback.print_exc()
    sys.exit(0)
try:
    result = build_models_payload(ctx, max_models=50, include_unconfigured=True, picker_hints=True, canonical_order=True, pricing=True, capabilities=True)
    print("=== build_models_payload OK ===")
    print("  providers count:", len(result.get("providers", [])))
    print("  model:", repr(result.get("model")))
    print("  provider:", repr(result.get("provider")))
except Exception:
    print("=== build_models_payload FAILED ===")
    traceback.print_exc()
`;
    execFile("/opt/hermes/.venv/bin/python", ["-c", pyCode], { timeout: 30000 }, (err, stdout, stderr) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit ---\n${err ? err.message : "0"}`);
    });
    return;
  }

  // Legacy /dashboard -> /hm
  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${HM_PREFIX}${parsed.search}`);
    return;
  }

  // Root-path dashboard routes (config, env, providers, etc.) that users
  // type or bookmark without the /hm/app prefix. Redirect them there.
  const dashboardRootRoutes = new Set([
    "/config",
    "/env",
    "/models",
    "/providers",
    "/profiles",
    "/sessions",
    "/skills",
    "/cron",
    "/analytics",
    "/logs",
    "/plugins",
    "/chat",
    "/docs",
  ]);
  if (dashboardRootRoutes.has(path) || [...dashboardRootRoutes].some((r) => path.startsWith(r + "/"))) {
    redirect(res, `${HM_PREFIX}/app${path}${parsed.search}`);
    return;
  }

  // 6b. Root-path requests whose Referer came from /hm/app/* must go to
  //     the dashboard, not WebUI. This covers:
  //       - Absolute assets    (/assets/*, /ds-assets/*, /dashboard-plugins/*)
  //       - API calls          (/api/*) when dashboard code uses absolute paths
  //       - Favicon            (/favicon.ico)
  //       - WebSocket upgrades from dashboard pages
  //       - File downloads     (any extensioned path referenced by dashboard)
  //     Both the Hermes dashboard AND hermes-webui use /api/* internally,
  //     so the Referer is the only reliable way to disambiguate.
  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  if (refererIsDashboard) {
    // Anything with a Referer from the dashboard goes to the dashboard,
    // *except* requests that explicitly start with /webui (escape hatch).
    if (!path.startsWith("/webui")) {
      if (!requireAuth(req, res)) return;
      // Assets must NOT get the SPA fallback; pass them through as-is.
      const parsed2 = new URL(req.url, "http://localhost");
      const looksLikeAsset =
        path.startsWith("/assets/") ||
        path.startsWith("/ds-assets/") ||
        path.startsWith("/dashboard-plugins/") ||
        path.startsWith("/api/") ||
        path === "/favicon.ico" ||
        /\.[a-z0-9]{1,6}$/i.test(path);
      if (looksLikeAsset) {
        proxyRequest(req, res, DASHBOARD_PORT);
      } else {
        // Unlikely: a dashboard-referrer request for a non-asset, non-/hm
        // path. Treat as a dashboard sub-route.
        proxyDashboard(req, res);
      }
      return;
    }
  }

  // 6c. /api/* routes — these are WebUI API calls when Referer isn't the
  //     dashboard. Fall through to the catch-all below.
  //
  // Exception: hermes-workspace probes for the *legacy* enhanced-fork chat
  // endpoint at POST /api/sessions/<id>/chat/stream. Without this rule the
  // request falls through to WebUI's catch-all, which doesn't 404 it
  // cleanly, so the workspace's detector sets `enhancedChat=true`, sends
  // chat there at runtime, and the UI surfaces a generic "Authentication
  // error". Returning an explicit 404 here makes the workspace fall back
  // to the OpenAI-compatible /v1/chat/completions path on the gateway —
  // which is the only chat surface this Space actually exposes.
  //
  // Anything the dashboard or WebUI legitimately need under /api/sessions/
  // already has a more specific match above (referer check / /hmd
  // passthrough), so this only fires for cross-origin probes.
  if (
    /^\/api\/sessions\/[^/]+\/chat\/stream\/?$/.test(path) &&
    !refererIsDashboard
  ) {
    res.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: "not_found",
        message:
          "Legacy enhanced-fork chat stream is not exposed by this Space. Use /v1/chat/completions.",
      }),
    );
    return;
  }

  // 7. Anything else -> Hermes WebUI (primary UI) OR HuggingMes status page.
  //    WebUI handles its own auth internally via HERMES_WEBUI_PASSWORD.
  if (PRIMARY_UI === "dashboard" && path === "/") {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  // ── Multi-user auth routes (parent accounts) ──────────────────────
  // GET /signin → Supabase signin/signup page
  if (path === "/signin") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SIGNIN_HTML);
      return;
    }
    res.writeHead(405, { allow: "GET" });
    res.end("Method not allowed");
    return;
  }

  

  

  // GET /api/me — verify Supabase JWT
  if (path === "/api/me") {
    const token = extractBearerToken(req);
    if (!token) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, authenticated: false })); return; }
    verifySupabaseToken(token).then(user => {
      if (user) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, authenticated: true, user: { id: user.id, email: user.email, display_name: user.user_metadata?.full_name || user.email } })); }
      else { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, authenticated: false })); }
    }).catch(() => {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, authenticated: false }));
    });
    return;
  }

  // POST /api/logout
  if (path === "/api/logout" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

    // POST /api/chat — proxy to Gateway with JWT verification
  if (path === "/api/chat" && req.method === "POST") {
    // Verify Supabase JWT from Authorization header
    const token = extractBearerToken(req);
    if (!token) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    
    let chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const body = JSON.stringify({
        model: data.model || process.env.MODEL_FOR_CONFIG || process.env.HERMES_MODEL || "default",
        messages: data.messages || [],
        stream: false
      });
      const opts = {
        hostname: GATEWAY_HOST,
        port: GATEWAY_PORT,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Authorization": "Bearer " + API_SERVER_KEY
        }
      };
      const proxyReq = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, "access-control-allow-origin": "*" });
        proxyRes.pipe(res);
      });
      proxyReq.on("error", (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "gateway_error", message: e.message })); });
      proxyReq.end(body);
    });
    req.on("error", (e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // GET /tutor — serve chat interface
  if (path === "/tutor" || path === "/tutor/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(AI_TUTOR_HTML);
    return;
  }

    // Catch-all -> serve chat interface or proxy to WebUI for admin
  const token = extractBearerToken(req);
  const adminAuthed = API_SERVER_KEY ? isAuthorized(req) : false;
  const muAuthed = token ? await verifySupabaseToken(token) : null;
  
  if (!muAuthed && !adminAuthed) {
    if (wantsHtml(req)) {
      redirect(res, "/signin");
    } else {
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "unauthorized", message: "Login required." }));
    }
    return;
  }
  
  // mu-authenticated user -> tutor chat interface (per-user isolated)
  if (muAuthed) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(AI_TUTOR_HTML);
    return;
  }
  
  // Admin-authenticated (GATEWAY_TOKEN) -> full Hermes WebUI
  proxyRequest(req, res, WEBUI_PORT);

});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HuggingMes + Hermes WebUI router listening on 0.0.0.0:${PORT}`);
});

/* ── WebSocket upgrade handling ─────────────────────────────────────
 *
 * Both the Hermes dashboard and hermes-webui can open WebSocket
 * connections for live updates. Route the upgrade to the correct
 * upstream based on path prefix + referer, same as HTTP requests.
 */
server.on("upgrade", (req, clientSocket, head) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  let targetPort = WEBUI_PORT;
  let targetPath = req.url;

  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  if (path === "/v1" || path.startsWith("/v1/")) {
    targetPort = GATEWAY_PORT;
  } else if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    // Off-Space dashboard passthrough (mirrors the HTTP /hmd handler).
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(HMD_PREFIX, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  } else if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(`${HM_PREFIX}/app`, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  } else if (refererIsDashboard && !path.startsWith("/webui")) {
    targetPort = DASHBOARD_PORT;
  } else if (path.startsWith("/webui/") || path === "/webui") {
    targetPort = WEBUI_PORT;
    targetPath = path.replace(/^\/webui/, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  }

  const upstream = net.createConnection(targetPort, GATEWAY_HOST, () => {
    // Rewrite Host to the local backend so the dashboard/gateway accept the
    // WebSocket origin. Desktop app → HF proxy sends Host: <space>.hf.space
    // but the dashboard checks against its own bind address (127.0.0.1:PORT).
    const localHost = `${GATEWAY_HOST}:${targetPort}`;
    const headerLines = [
      `${req.method} ${targetPath} HTTP/1.1`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      // Rewrite Host and Origin so the backend accepts the WS handshake.
      // The dashboard's origin guard checks Origin against its own host.
      if (name.toLowerCase() === "host") {
        headerLines.push(`Host: ${localHost}`);
        continue;
      }
      if (name.toLowerCase() === "origin") {
        // Rewrite wss://<space>.hf.space or https:// to the local backend.
        try {
          const origUrl = new URL(value);
          headerLines.push(`Origin: http://${localHost}`);
        } catch {
          headerLines.push(`Origin: http://${localHost}`);
        }
        continue;
      }
      if (Array.isArray(value)) {
        for (const v of value) headerLines.push(`${name}: ${v}`);
      } else {
        headerLines.push(`${name}: ${value}`);
      }
    }
    headerLines.push("", "");
    upstream.write(headerLines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    try {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {}
  });
  clientSocket.on("error", () => {
    try {
      upstream.destroy();
    } catch {}
  });
});
