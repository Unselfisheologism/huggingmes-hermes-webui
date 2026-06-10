"""
Hermes WebUI — Multi-user authentication module.
SQLite-backed user accounts + session management.
"""
import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path


DB_PATH = None
_local = threading.local()


def _get_db_path():
    global DB_PATH
    if DB_PATH is not None:
        return DB_PATH
    state_dir = os.environ.get("HERMES_WEBUI_STATE_DIR", "")
    if state_dir:
        p = Path(state_dir) / "users.db"
    else:
        p = Path(__file__).resolve().parent.parent / "state" / "users.db"
    p.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH = str(p)
    return DB_PATH


def _get_conn():
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(_get_db_path())
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


def init_db():
    """Create tables if they don't exist. Safe to call repeatedly."""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'free',
            display_name TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    """)
    conn.commit()


def hash_password(password: str) -> str:
    """SHA-256 hash with salt (first 16 chars = salt)."""
    salt = secrets.token_hex(8)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return salt + h


def verify_password(password: str, stored: str) -> bool:
    """Verify password against stored hash."""
    if len(stored) < 16:
        return False
    salt = stored[:16]
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return (salt + h) == stored


def create_user(email: str, password: str, tier: str = "free", display_name: str = "") -> dict:
    """Create a new user. Returns user dict or None if email exists."""
    conn = _get_conn()
    pw_hash = hash_password(password)
    try:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, tier, display_name) VALUES (?, ?, ?, ?)",
            (email.strip().lower(), pw_hash, tier, display_name.strip()),
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "email": email.strip().lower(),
            "tier": tier,
            "display_name": display_name.strip(),
        }
    except sqlite3.IntegrityError:
        return None


def verify_login(email: str, password: str) -> dict:
    """Verify email+password. Returns user dict or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM users WHERE email = ?",
        (email.strip().lower(),),
    ).fetchone()
    if row is None:
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return {
        "id": row["id"],
        "email": row["email"],
        "tier": row["tier"],
        "display_name": row["display_name"],
        "created_at": row["created_at"],
    }


def create_session(user_id: int, ttl_days: int = 30) -> str:
    """Create a session token for a user. Returns the token string."""
    conn = _get_conn()
    token = secrets.token_urlsafe(48)
    expires_at = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + ttl_days * 86400))
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires_at),
    )
    conn.commit()
    return token


def get_session(token: str) -> dict:
    """Look up a session token. Returns user dict or None if invalid/expired."""
    if not token:
        return None
    conn = _get_conn()
    row = conn.execute(
        """SELECT u.id, u.email, u.tier, u.display_name, u.created_at
           FROM sessions s JOIN users u ON s.user_id = u.id
           WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))""",
        (token,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "email": row["email"],
        "tier": row["tier"],
        "display_name": row["display_name"],
        "created_at": row["created_at"],
    }


def delete_session(token: str) -> None:
    """Delete a session token (logout)."""
    if not token:
        return
    conn = _get_conn()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()


def get_user_by_id(user_id: int) -> dict:
    """Get user by ID. Returns dict or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, email, tier, display_name, created_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "email": row["email"],
        "tier": row["tier"],
        "display_name": row["display_name"],
        "created_at": row["created_at"],
    }


def get_all_users() -> list:
    """Get all users (admin)."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, email, tier, display_name, created_at FROM users ORDER BY created_at DESC"
    ).fetchall()
    return [{
        "id": r["id"],
        "email": r["email"],
        "tier": r["tier"],
        "display_name": r["display_name"],
        "created_at": r["created_at"],
    } for r in rows]


def extract_session_token(headers, cookies=None) -> str:
    """Extract session token from Authorization header or cookie."""
    # Check Authorization: Bearer <token>
    auth = headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    # Check X-Session-Token header
    token = headers.get("X-Session-Token", "")
    if token:
        return token
    # Check cookie
    if cookies:
        for c in cookies.split("; "):
            if c.startswith("hermes_user_session="):
                return c[19:]
    return ""


# ── JSON helpers for server.py integration ───────────────────────────

def json_response(data, status=200):
    """Return a (status, body, content_type) tuple for server.py."""
    return status, json.dumps(data), "application/json"


def json_error(message, status=400):
    return json_response({"error": message}, status)


def handle_signup(body: dict) -> tuple:
    """POST /api/signup"""
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()

    if not email or "@" not in email:
        return json_error("Valid email required")
    if len(password) < 6:
        return json_error("Password must be at least 6 characters")

    user = create_user(email, password, "free", display_name)
    if user is None:
        return json_error("Email already registered", 409)

    token = create_session(user["id"])
    return json_response({"token": token, "user": user})


def handle_login(body: dict) -> tuple:
    """POST /api/login"""
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""

    user = verify_login(email, password)
    if user is None:
        return json_error("Invalid email or password", 401)

    token = create_session(user["id"])
    return json_response({"token": token, "user": user})


def handle_get_me(headers) -> tuple:
    """GET /api/me — get current user from session token."""
    token = extract_session_token(headers, headers.get("Cookie", ""))
    user = get_session(token)
    if user is None:
        return json_error("Not authenticated", 401)
    return json_response({"user": user})


def handle_logout(headers) -> tuple:
    """POST /api/logout"""
    token = extract_session_token(headers, headers.get("Cookie", ""))
    if token:
        delete_session(token)
    return json_response({"status": "ok"})


LOGIN_PAGE_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>AI Tutor — Sign In</title>
<style>
:root { color-scheme: dark; --bg:#0e0e16; --panel:#161622; --line:#2a2a3e; --text:#f0f0fa; --muted:#7878a0; --accent:#6366f1; --accent-hover:#5457e0; --good:#34d399; }
* { box-sizing:border-box; margin:0; padding:0; }
body { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:20px; }
.card { width:min(420px,100%); background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:36px 28px; }
h1 { font-size:1.6rem; margin-bottom:4px; }
.subtitle { color:var(--muted); font-size:.87rem; margin-bottom:28px; line-height:1.5; }
.tabs { display:flex; gap:0; margin-bottom:24px; border-bottom:1px solid var(--line); }
.tab { flex:1; text-align:center; padding:10px 0; cursor:pointer; color:var(--muted); font-size:.85rem; font-weight:600; border-bottom:2px solid transparent; transition:all .15s; }
.tab.active { color:var(--accent); border-bottom-color:var(--accent); }
.tab-content { display:none; }
.tab-content.active { display:block; }
label { display:block; color:var(--muted); font-size:.82rem; margin-bottom:6px; margin-top:16px; }
label:first-child { margin-top:0; }
input { width:100%; min-height:44px; border:1px solid var(--line); border-radius:8px; background:#0a0a14; color:var(--text); padding:0 14px; font-size:.95rem; outline:none; transition:border .15s; }
input:focus { border-color:var(--accent); }
button { width:100%; min-height:44px; margin-top:24px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:.95rem; font-weight:700; cursor:pointer; transition:background .15s; }
button:hover { background:var(--accent-hover); }
button:disabled { opacity:.5; cursor:not-allowed; }
.error { display:none; border:1px solid rgba(239,68,68,.4); background:rgba(239,68,68,.1); color:#fecaca; border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:.85rem; }
.error.show { display:block; }
.success { display:none; border:1px solid rgba(52,211,153,.4); background:rgba(52,211,153,.1); color:#a7f3d0; border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:.85rem; text-align:center; }
.success.show { display:block; }
.toggle-link { text-align:center; margin-top:14px; font-size:.85rem; color:var(--muted); cursor:pointer; }
.toggle-link:hover { color:var(--accent); }
.logged-in { display:none; text-align:center; }
.logged-in.show { display:block; }
.logged-in h2 { margin-bottom:8px; }
.logged-in p { color:var(--muted); margin-bottom:20px; }
.btn-admin { display:block; text-align:center; margin-top:14px; font-size:.8rem; color:var(--muted); }
.btn-admin:hover { color:var(--accent); }
.spinner { display:inline-block; width:16px; height:16px; border:2px solid rgba(255,255,255,.3); border-radius:50%; border-top-color:#fff; animation:spin .6s linear infinite; margin-right:6px; vertical-align:middle; }
@keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="card" id="app">
  <h1>AI Tutor</h1>
  <p class="subtitle">Sign in for 24/7 concept explainers, SVGs, and interactive demos</p>

  <div class="error" id="errorMsg"></div>
  <div class="success" id="successMsg"></div>

  <div id="loggedIn" class="logged-in">
    <h2>Welcome back 👋</h2>
    <p id="userEmail" style="color:var(--accent)"></p>
    <button onclick="goToChat()">Open AI Tutor →</button>
    <button onclick="logout()" style="margin-top:8px;background:transparent;border:1px solid var(--line);color:var(--muted);font-size:.82rem">Sign out</button>
  </div>

  <div id="authForms">
    <div class="tabs">
      <div class="tab active" data-tab="login" onclick="switchTab('login')">Sign In</div>
      <div class="tab" data-tab="signup" onclick="switchTab('signup')">Sign Up</div>
    </div>

    <div class="tab-content active" id="tab-login">
      <form onsubmit="return doLogin(event)">
        <label for="loginEmail">Email</label>
        <input type="email" id="loginEmail" placeholder="your@email.com" required autocomplete="email">
        <label for="loginPassword">Password</label>
        <input type="password" id="loginPassword" placeholder="Enter password" required autocomplete="current-password">
        <button type="submit" id="loginBtn">Sign In</button>
      </form>
      <div class="toggle-link" onclick="switchTab('signup')">Don't have an account? Sign Up</div>
    </div>

    <div class="tab-content" id="tab-signup">
      <form onsubmit="return doSignup(event)">
        <label for="signupEmail">Email</label>
        <input type="email" id="signupEmail" placeholder="your@email.com" required autocomplete="email">
        <label for="signupPassword">Password</label>
        <input type="password" id="signupPassword" placeholder="Min 6 characters" required minlength="6" autocomplete="new-password">
        <label for="signupName">Name (optional)</label>
        <input type="text" id="signupName" placeholder="Your name" autocomplete="name">
        <button type="submit" id="signupBtn">Create Account</button>
      </form>
      <div class="toggle-link" onclick="switchTab('login')">Already have an account? Sign In</div>
    </div>
  </div>

  <a class="btn-admin" href="/admin-login" target="_blank">Admin login (password)</a>
</div>

<script>
let currentToken = localStorage.getItem('hermes_session_token');

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  hideError();
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('show');
}

function hideError() {
  document.getElementById('errorMsg').classList.remove('show');
}

function showSuccess(msg) {
  const el = document.getElementById('successMsg');
  el.textContent = msg;
  el.classList.add('show');
}

function hideSuccess() {
  document.getElementById('successMsg').classList.remove('show');
}

async function api(path, body) {
  const headers = {'Content-Type': 'application/json'};
  if (currentToken) headers['X-Session-Token'] = currentToken;
  const res = await fetch(path, {method:'POST', headers, body: JSON.stringify(body)});
  return res.json();
}

async function doLogin(e) {
  e.preventDefault(); hideError();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  document.getElementById('loginBtn').disabled = true;
  document.getElementById('loginBtn').innerHTML = '<span class="spinner"></span> Signing in...';
  const data = await api('/api/login', {email, password});
  document.getElementById('loginBtn').disabled = false;
  document.getElementById('loginBtn').textContent = 'Sign In';
  if (data.error) { showError(data.error); return; }
  currentToken = data.token;
  localStorage.setItem('hermes_session_token', data.token);
  document.cookie = 'hermes_user_session=' + data.token + '; path=/; max-age=2592000; SameSite=Lax';
  showLoggedIn(data.user);
}

async function doSignup(e) {
  e.preventDefault(); hideError(); hideSuccess();
  const email = document.getElementById('signupEmail').value;
  const password = document.getElementById('signupPassword').value;
  const display_name = document.getElementById('signupName').value;
  document.getElementById('signupBtn').disabled = true;
  document.getElementById('signupBtn').innerHTML = '<span class="spinner"></span> Creating...';
  const data = await api('/api/signup', {email, password, display_name});
  document.getElementById('signupBtn').disabled = false;
  document.getElementById('signupBtn').textContent = 'Create Account';
  if (data.error) { showError(data.error); return; }
  currentToken = data.token;
  localStorage.setItem('hermes_session_token', data.token);
  document.cookie = 'hermes_user_session=' + data.token + '; path=/; max-age=2592000; SameSite=Lax';
  showLoggedIn(data.user);
}

function showLoggedIn(user) {
  document.getElementById('authForms').style.display = 'none';
  document.getElementById('loggedIn').classList.add('show');
  document.getElementById('userEmail').textContent = user.email;
}

function goToChat() {
  window.location.href = '/';
}

function logout() {
  if (currentToken) {
    fetch('/api/logout', {method:'POST', headers:{'X-Session-Token': currentToken}});
  }
  localStorage.removeItem('hermes_session_token');
  document.cookie = 'hermes_user_session=; path=/; max-age=0';
  currentToken = null;
  document.getElementById('authForms').style.display = 'block';
  document.getElementById('loggedIn').classList.remove('show');
}

async function checkSession() {
  if (!currentToken) return;
  const res = await fetch('/api/me', {headers:{'X-Session-Token': currentToken}});
  if (res.ok) {
    const data = await res.json();
    if (data.user) showLoggedIn(data.user);
  } else {
    localStorage.removeItem('hermes_session_token');
    currentToken = null;
  }
}
checkSession();
</script>
</body>
</html>"""

ADMIN_LOGIN_PAGE_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Login</title>
<style>
:root { color-scheme:dark; --bg:#0e0e16; --panel:#161622; --line:#2a2a3e; --text:#f0f0fa; --muted:#7878a0; --accent:#6366f1; }
* { box-sizing:border-box; margin:0; padding:0; }
body { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:20px; }
.card { width:min(380px,100%); background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:32px 24px; text-align:center; }
h2 { margin-bottom:18px; font-size:1.2rem; }
input { width:100%; min-height:44px; border:1px solid var(--line); border-radius:8px; background:#0a0a14; color:var(--text); padding:0 14px; outline:none; margin-bottom:14px; }
button { width:100%; min-height:44px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:.95rem; font-weight:700; cursor:pointer; }
.error { color:#fecaca; margin-bottom:10px; font-size:.85rem; display:none; }
</style>
</head>
<body>
<div class="card">
  <h2>Admin Login</h2>
  <div class="error" id="err"></div>
  <form method="post" action="/login">
    <input type="password" name="password" placeholder="Admin password" required autofocus>
    <button type="submit">Continue to Dashboard</button>
  </form>
</div>
</body>
</html>"""


# ── Server handler functions (called by patched server.py) ─────────────

def _send_json(handler, data, status=200):
    """Send a JSON response via the HTTP handler."""
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _send_html(handler, html):
    """Send an HTML response via the HTTP handler."""
    body = html.encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler) -> dict:
    """Read and parse JSON body from a POST/PUT request."""
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


def serve_auth_page(handler):
    """GET /signin — serve the login/signup page."""
    # If already authenticated via session, redirect to /
    token = extract_session_token(handler.headers, handler.headers.get("Cookie", ""))
    if token and get_session(token):
        handler.send_response(302)
        handler.send_header("Location", "/")
        handler.end_headers()
        return
    _send_html(handler, LOGIN_PAGE_HTML)


def serve_admin_login_page(handler):
    """GET /admin-login — serve the admin password login page."""
    _send_html(handler, ADMIN_LOGIN_PAGE_HTML)


def handle_me_get(handler):
    """GET /api/me — return current user from session token."""
    token = extract_session_token(handler.headers, handler.headers.get("Cookie", ""))
    user = get_session(token)
    if user:
        _send_json(handler, {"user": user})
    else:
        _send_json(handler, {"error": "Not authenticated"}, 401)


def handle_signup_post(handler):
    """POST /api/signup — create a new user account."""
    body = _read_body(handler)
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()

    if not email or "@" not in email:
        return _send_json(handler, {"error": "Valid email required"}, 400)
    if len(password) < 6:
        return _send_json(handler, {"error": "Password must be at least 6 characters"}, 400)

    user = create_user(email, password, "free", display_name)
    if user is None:
        return _send_json(handler, {"error": "Email already registered"}, 409)

    token = create_session(user["id"])
    _send_json(handler, {"token": token, "user": user})


def handle_login_post(handler):
    """POST /api/login — authenticate user and create session."""
    body = _read_body(handler)
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""

    user = verify_login(email, password)
    if user is None:
        return _send_json(handler, {"error": "Invalid email or password"}, 401)

    token = create_session(user["id"])
    _send_json(handler, {"token": token, "user": user})


def handle_logout_post(handler):
    """POST /api/logout — destroy session."""
    token = extract_session_token(handler.headers, handler.headers.get("Cookie", ""))
    if token:
        delete_session(token)
    _send_json(handler, {"status": "ok"})
