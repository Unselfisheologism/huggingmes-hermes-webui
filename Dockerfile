# HuggingMes + Hermes WebUI — merged deployment for Hugging Face Spaces
# Base: NousResearch Hermes Agent (ships Hermes CLI, gateway, dashboard, Python venv)

ARG HERMES_AGENT_VERSION=latest
FROM nousresearch/hermes-agent:${HERMES_AGENT_VERSION}

ARG WEBUI_REF=master

USER root

# System deps (mirrors HuggingMes) + git/nodejs for WebUI checkout + router
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    git \
    python3 \
    nodejs \
    npm \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libx11-6 \
    libxext6 \
    libxfixes3 \
    libasound2 \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /opt/hermes/.venv/bin/python --no-cache-dir \
        huggingface_hub hf_transfer pyyaml

# Clone nesquena/hermes-webui (install deps into the agent venv so imports resolve)
RUN git clone --depth 1 --branch ${WEBUI_REF} \
        https://github.com/nesquena/hermes-webui.git /opt/hermes-webui \
 && ( [ -f /opt/hermes-webui/requirements.txt ] \
      && /opt/hermes/.venv/bin/pip install --no-cache-dir -r /opt/hermes-webui/requirements.txt \
      || true ) \
 && chown -R hermes:hermes /opt/hermes-webui

# HuggingMes-style integration scripts (vendored from somratpro/HuggingMes)
COPY --chown=hermes:hermes start.sh                       /opt/huggingmes/start.sh
COPY --chown=hermes:hermes health-server.js               /opt/huggingmes/health-server.js
COPY --chown=hermes:hermes hermes-sync.py                 /opt/huggingmes/hermes-sync.py
COPY --chown=hermes:hermes cloudflare-proxy-setup.py      /opt/huggingmes/cloudflare-proxy-setup.py
COPY --chown=hermes:hermes cloudflare-keepalive-setup.py  /opt/huggingmes/cloudflare-keepalive-setup.py

RUN chmod +x \
    /opt/huggingmes/start.sh \
    /opt/huggingmes/hermes-sync.py \
    /opt/huggingmes/cloudflare-proxy-setup.py \
    /opt/huggingmes/cloudflare-keepalive-setup.py

# Idempotent kanban migration patch (same workaround HuggingMes ships)
RUN python3 - <<'PY'
from pathlib import Path
import sys
p = Path("/opt/hermes/hermes_cli/kanban_db.py")
if not p.exists():
    sys.exit(0)
src = p.read_text(encoding="utf-8")
sentinel = "# huggingmes-webui: idempotent-alter"
if sentinel in src:
    sys.exit(0)
old = (
    '    conn.execute(\n'
    '        "ALTER TABLE tasks ADD COLUMN consecutive_failures "\n'
    '        "INTEGER NOT NULL DEFAULT 0"\n'
    '    )'
)
new = (
    f'    try:  {sentinel}\n'
    '        conn.execute(\n'
    '            "ALTER TABLE tasks ADD COLUMN consecutive_failures "\n'
    '            "INTEGER NOT NULL DEFAULT 0"\n'
    '        )\n'
    '    except Exception:\n'
    '        pass'
)
if old in src:
    p.write_text(src.replace(old, new), encoding="utf-8")
    print("kanban patch: applied")
PY

# ── Multi-user auth overlay (signup/login/me/logout) ───────────────────
COPY --chown=hermes:hermes api/users.py /opt/hermes-webui/api/users.py
RUN python3 - <<'PY'
from pathlib import Path
import sys

p = Path("/opt/hermes-webui/server.py")
src = p.read_text(encoding="utf-8")
sentinel = "# huggingmes-webui: multiuser-auth"
if sentinel in src:
    print("multiuser auth: already patched")
    sys.exit(0)

# 1. Add import for users module after the last api import
old_import = "from api.routes import handle_delete, handle_get, handle_patch, handle_post, handle_put"
new_import = old_import + "\nfrom api import users  # " + sentinel + " multiuser-auth"
if old_import not in src:
    print("ERROR: import line not found")
    sys.exit(1)
src = src.replace(old_import, new_import)

# 2. Add /signin, /admin-login, /api/me routes to do_GET (before check_auth)
old_get = (
    '        try:\n'
    '            parsed = urlparse(self.path)\n'
    '            if not check_auth(self, parsed): return\n'
    '            result = handle_get(self, parsed)'
)
new_get = (
    '        try:\n'
    '            parsed = urlparse(self.path)\n'
    '            path = parsed.path\n'
    '            # Multi-user auth public GET paths  ' + sentinel + '\n'
    '            if path == \'/signin\':\n'
    '                return users.serve_auth_page(self)\n'
    '            if path == \'/admin-login\':\n'
    '                return users.serve_admin_login_page(self)\n'
    '            if path == \'/api/me\':\n'
    '                return users.handle_me_get(self)\n'
    '            if not check_auth(self, parsed): return\n'
    '            result = handle_get(self, parsed)'
)
if old_get not in src:
    print("ERROR: do_GET try block not found")
    sys.exit(1)
src = src.replace(old_get, new_get)

# 3. Add /api/signup, /api/login, /api/logout routes to _handle_write (before check_auth)
old_write = (
    '            if not _is_csp_report_post and not check_auth(self, parsed): return\n'
    '            result = route_func(self, parsed)'
)
new_write = (
    '            if not _is_csp_report_post:\n'
    '                path = parsed.path\n'
    '                # Multi-user auth public POST paths  ' + sentinel + '\n'
    '                if path == \'/api/signup\':\n'
    '                    return users.handle_signup_post(self)\n'
    '                if path == \'/api/login\':\n'
    '                    return users.handle_login_post(self)\n'
    '                if path == \'/api/logout\':\n'
    '                    return users.handle_logout_post(self)\n'
    '                if not check_auth(self, parsed): return\n'
    '            result = route_func(self, parsed)'
)
if old_write not in src:
    print("ERROR: _handle_write block not found")
    sys.exit(1)
src = src.replace(old_write, new_write)

# 4. Modify check_auth in api/auth.py to also accept user session tokens
ap = Path("/opt/hermes-webui/api/auth.py")
auth_src = ap.read_text(encoding="utf-8")
auth_sentinel = "# huggingmes-webui: multiuser-auth"
if auth_sentinel not in auth_src:
    old_public = "PUBLIC_PATHS = frozenset({"
    new_public = (
        "PUBLIC_PATHS = frozenset({\n"
        "    '/signin', '/admin-login', '/api/me',\n"
        "    '/api/signup', '/api/login', '/api/logout',\n"
    )
    if old_public in auth_src:
        auth_src = auth_src.replace(old_public, new_public)
    else:
        print("ERROR: PUBLIC_PATHS not found in auth.py")
        sys.exit(1)

    # Add user session check to check_auth after existing session check
    old_session_check = (
        "    cookie_val = parse_cookie(handler)\n"
        "    if cookie_val and verify_session(cookie_val):\n"
        "        return True"
    )
    new_session_check = (
        "    cookie_val = parse_cookie(handler)\n"
        "    if cookie_val and verify_session(cookie_val):\n"
        "        return True\n"
        "    # Also check multi-user session tokens  " + auth_sentinel + "\n"
        "    from api import users as _mu_users\n"
        "    _mu_token = _mu_users.extract_session_token(\n"
        "        handler.headers, handler.headers.get('Cookie', '')\n"
        "    )\n"
        "    if _mu_token and _mu_users.get_session(_mu_token):\n"
        "        return True"
    )
    if old_session_check in auth_src:
        auth_src = auth_src.replace(old_session_check, new_session_check)
    else:
        print("ERROR: session check not found in auth.py")
        # Non-fatal: the user session auth works via the server.py hooks too
        pass

    ap.write_text(auth_src, encoding="utf-8")
    print("auth.py patched")

p.write_text(src, encoding="utf-8")
print("server.py patched successfully")
PY

# Quiet hermes-webui's per-request access log noise.
# By default it prints \[webui] {"ts":...,"method":...}\ for EVERY request,
# which drowns the HF Logs tab once any browser tab is open polling
# /api/dashboard/status, /api/health/agent, /api/sessions, /sw.js, etc.
# Patch log_request() to drop 2xx responses for high-frequency poll paths.
# Errors and chat/streaming paths still log normally.
RUN python3 - <<'PY'
from pathlib import Path
import re
import sys

p = Path("/opt/hermes-webui/server.py")
if not p.exists():
    sys.exit(0)
src = p.read_text(encoding="utf-8")
sentinel = "# huggingmes-webui: quiet-poll-paths"
if sentinel in src:
    sys.exit(0)

old = (
    "    def log_request(self, code: str='-', size: str='-') -> None:\n"
    "        \"\"\"Structured JSON logs for each request.\"\"\"\n"
    "        import json as _json\n"
    "        duration_ms = round((time.time() - getattr(self, '_req_t0', time.time())) * 1000, 1)\n"
    "        record = _json.dumps({\n"
    "            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),\n"
    "            'method': self.command or '-',\n"
    "            'path': self.path or '-',\n"
    "            'status': int(code) if str(code).isdigit() else code,\n"
    "            'ms': duration_ms,\n"
    "        })\n"
    "        print(f'[webui] {record}', flush=True)"
)

new = (
    "    _QUIET_POLL_PATHS = (  " + sentinel + "\n"
    "        '/api/health/agent', '/api/dashboard/status',\n"
    "        '/api/dashboard/config', '/api/sessions', '/api/profiles',\n"
    "        '/api/profile/active', '/api/onboarding/status',\n"
    "        '/api/insights', '/api/system/health',\n"
    "        '/api/settings', '/api/projects', '/api/reasoning',\n"
    "        '/api/models', '/api/chat/stream/status',\n"
    "        '/api/git-info', '/sw.js', '/health',\n"
    "    )\n"
    "    _QUIET_PREFIXES = ('/static/', '/session/static/', '/assets/')\n"
    "\n"
    "    def log_request(self, code: str='-', size: str='-') -> None:\n"
    "        \"\"\"Structured JSON logs for each request, skipping noisy polls.\"\"\"\n"
    "        # Always log non-2xx so 401/404/5xx remain visible.\n"
    "        try:\n"
    "            status_int = int(code) if str(code).isdigit() else 0\n"
    "        except Exception:\n"
    "            status_int = 0\n"
    "        path = (self.path or '').split('?', 1)[0]\n"
    "        if 200 <= status_int < 400:\n"
    "            if path in self._QUIET_POLL_PATHS:\n"
    "                return\n"
    "            for pref in self._QUIET_PREFIXES:\n"
    "                if path.startswith(pref):\n"
    "                    return\n"
    "        import json as _json\n"
    "        duration_ms = round((time.time() - getattr(self, '_req_t0', time.time())) * 1000, 1)\n"
    "        record = _json.dumps({\n"
    "            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),\n"
    "            'method': self.command or '-',\n"
    "            'path': self.path or '-',\n"
    "            'status': int(code) if str(code).isdigit() else code,\n"
    "            'ms': duration_ms,\n"
    "        })\n"
    "        print(f'[webui] {record}', flush=True)"
)

if old in src:
    p.write_text(src.replace(old, new), encoding="utf-8")
    print("webui log-quiet patch: applied")
else:
    print("webui log-quiet patch: pattern not found, skipping")
PY

# Fix permissions so hermes user can self-update packages
RUN chown -R hermes:hermes /opt/hermes/.venv

# Keep hermes CLI on PATH for all shell types (login/interactive/non-interactive)
RUN echo 'export PATH="/opt/hermes/.venv/bin:/opt/data/.local/bin:$PATH"' \
    > /etc/profile.d/hermes-venv.sh

ENV HERMES_HOME=/opt/data \
    HUGGINGMES_APP_DIR=/opt/huggingmes \
    HERMES_WEBUI_REPO=/opt/hermes-webui \
    HERMES_AGENT_VERSION=${HERMES_AGENT_VERSION} \
    HERMES_WEBUI_TRUST_FORWARDED_HOST=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD curl -fsS http://localhost:7861/health || exit 1

USER hermes
ENTRYPOINT ["/opt/huggingmes/start.sh"]