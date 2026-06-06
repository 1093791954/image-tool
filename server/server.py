#!/usr/bin/env python3
from __future__ import annotations

import http.client
import http.cookiejar
import base64
import hashlib
import json
import logging
import os
import posixpath
import queue
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


DEFAULT_BASE_URL = "https://hotapi.top"
ALLOWED_NEW_API_HOST = "hotapi.top"
IMAGE_GROUP = "gpt 2"
IMAGE_MODEL = "gpt-image-2"
IMAGE_TOKEN_NAME = "GPT Image Tools - gpt-image-2"
CODEX_GROUP = "gpt 2"
CODEX_MODEL = "gpt-5.5"
CODEX_TOKEN_NAME = "GPT Image Tools - codex"
MAX_JSON_BODY = 16 * 1024
MAX_OPENAI_PROXY_BODY = env_int("IMAGE_TOOLS_OPENAI_PROXY_MAX_BODY", 64 * 1024 * 1024)
OPENAI_PROXY_CACHE_MAX_BYTES = env_int(
    "IMAGE_TOOLS_OPENAI_PROXY_CACHE_MAX_BYTES", 1024 * 1024 * 1024
)
OPENAI_PROXY_CACHE_MAX_AGE_SECONDS = env_int(
    "IMAGE_TOOLS_OPENAI_PROXY_CACHE_MAX_AGE_SECONDS", 30 * 24 * 60 * 60
)
TOKEN_LIST_PAGE_SIZE = 100
TOKEN_LIST_MAX_PAGES = 50
REQUEST_TIMEOUT = env_int("IMAGE_TOOLS_REQUEST_TIMEOUT", 25)
OPENAI_PROXY_TIMEOUT = env_int("IMAGE_TOOLS_OPENAI_PROXY_TIMEOUT", 500)
LOG_MAX_ROWS = env_int("IMAGE_TOOLS_LOG_MAX_ROWS", 5000)
DB_MAX_BYTES = env_int("IMAGE_TOOLS_DB_MAX_BYTES", 64 * 1024 * 1024)
DEFAULT_LOCAL_PROXY = "http://127.0.0.1:7897"
DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1"
DEFAULT_LOCAL_PROXY_PORT = 7897
DATA_DIR = Path(os.environ.get("IMAGE_TOOLS_DATA_DIR", "server-data")).resolve()
DB_PATH = Path(os.environ.get("IMAGE_TOOLS_DB_PATH", str(DATA_DIR / "image-tools.sqlite3"))).resolve()
OPENAI_PROXY_CACHE_DIR = Path(
    os.environ.get(
        "IMAGE_TOOLS_OPENAI_PROXY_CACHE_DIR",
        str(DATA_DIR / "openai-proxy-cache"),
    )
).resolve()
DEFAULT_STYLE_LIBRARY_DIR = (
    r"D:\tmp\image-tool-lib\风格" if os.name == "nt" else "/opt/image-tool-lib/风格"
)
STYLE_LIBRARY_DIR = Path(
    os.environ.get("IMAGE_TOOLS_STYLE_LIBRARY_DIR", DEFAULT_STYLE_LIBRARY_DIR)
).resolve()

DB_LOCK = threading.RLock()
TASKS_LOCK = threading.RLock()
TASK_SECRETS: dict[str, str] = {}
LOGGER = logging.getLogger("image-tools")
TASK_SECRET_KEY_PATH = Path(
    os.environ.get("IMAGE_TOOLS_TASK_SECRET_KEY_PATH", str(DATA_DIR / "task-secret.key"))
).resolve()
TASK_SECRET_VERSION = "v1"


class NewApiError(Exception):
    pass


def local_proxy_is_available() -> bool:
    try:
        with socket.create_connection(
            (DEFAULT_LOCAL_PROXY_HOST, DEFAULT_LOCAL_PROXY_PORT),
            timeout=0.35,
        ):
            return True
    except OSError:
        return False


def resolve_outbound_proxy() -> str | None:
    raw = os.environ.get("IMAGE_TOOLS_OUTBOUND_PROXY")
    if raw is not None:
        value = raw.strip()
        if value.lower() in {"", "0", "false", "no", "none", "off", "direct"}:
            return None
        return value

    if local_proxy_is_available():
        return DEFAULT_LOCAL_PROXY
    return None


def build_url_opener(*handlers: urllib.request.BaseHandler) -> urllib.request.OpenerDirector:
    proxy_url = resolve_outbound_proxy()
    if proxy_url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}),
            *handlers,
        )
    return urllib.request.build_opener(*handlers)


def open_url(request: urllib.request.Request, timeout: float | None = None):
    return build_url_opener().open(request, timeout=timeout)


def now_ts() -> float:
    return time.time()


def init_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS service_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                level TEXT NOT NULL,
                event TEXT NOT NULL,
                task_id TEXT,
                message TEXT NOT NULL,
                details TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_ts ON service_logs(ts)")
        conn.commit()
    scrub_task_secrets_from_disk()
    resume_interrupted_image_tasks()


def load_task_secret_key() -> bytes:
    try:
        raw = TASK_SECRET_KEY_PATH.read_bytes()
        if len(raw) >= 32:
            return raw[:32]
    except OSError:
        pass

    key = secrets.token_bytes(32)
    TASK_SECRET_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        fd = os.open(str(TASK_SECRET_KEY_PATH), flags, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(key)
    except FileExistsError:
        raw = TASK_SECRET_KEY_PATH.read_bytes()
        if len(raw) >= 32:
            return raw[:32]
        raise RuntimeError(f"任务密钥文件无效：{TASK_SECRET_KEY_PATH}")
    except OSError as exc:
        raise RuntimeError(f"无法创建任务密钥文件：{TASK_SECRET_KEY_PATH}") from exc
    return key


def task_secret_keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    chunks: list[bytes] = []
    counter = 0
    while sum(len(chunk) for chunk in chunks) < length:
        chunks.append(
            hashlib.sha256(
                key + nonce + counter.to_bytes(8, "big", signed=False)
            ).digest()
        )
        counter += 1
    return b"".join(chunks)[:length]


def encrypt_task_api_key(api_key: str) -> str:
    key = load_task_secret_key()
    nonce = secrets.token_bytes(16)
    plain = api_key.encode("utf-8")
    stream = task_secret_keystream(key, nonce, len(plain))
    cipher = bytes(left ^ right for left, right in zip(plain, stream))
    mac = hashlib.blake2b(nonce + cipher, key=key, digest_size=32).digest()
    return ".".join(
        [
            TASK_SECRET_VERSION,
            base64.urlsafe_b64encode(nonce).decode("ascii").rstrip("="),
            base64.urlsafe_b64encode(cipher).decode("ascii").rstrip("="),
            base64.urlsafe_b64encode(mac).decode("ascii").rstrip("="),
        ]
    )


def decode_urlsafe_base64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def decrypt_task_api_key(value: str) -> str:
    version, nonce_text, cipher_text, mac_text = value.split(".", 3)
    if version != TASK_SECRET_VERSION:
        raise ValueError("unsupported task secret version")
    key = load_task_secret_key()
    nonce = decode_urlsafe_base64(nonce_text)
    cipher = decode_urlsafe_base64(cipher_text)
    mac = decode_urlsafe_base64(mac_text)
    expected_mac = hashlib.blake2b(nonce + cipher, key=key, digest_size=32).digest()
    if not secrets.compare_digest(mac, expected_mac):
        raise ValueError("invalid task secret mac")
    stream = task_secret_keystream(key, nonce, len(cipher))
    plain = bytes(left ^ right for left, right in zip(cipher, stream))
    return plain.decode("utf-8")


def task_has_persisted_secret(task: dict[str, Any]) -> bool:
    return bool(str(task.get("apiKeyEncrypted") or ""))


def resolve_task_api_key(task: dict[str, Any]) -> str | None:
    task_id = str(task.get("taskId") or "")
    api_key = TASK_SECRETS.get(task_id)
    if api_key:
        return api_key
    encrypted = str(task.get("apiKeyEncrypted") or "")
    if not encrypted:
        return None
    api_key = decrypt_task_api_key(encrypted)
    if task_id:
        TASK_SECRETS[task_id] = api_key
    return api_key


def clear_image_task_secret(task_id: str) -> None:
    TASK_SECRETS.pop(task_id, None)
    with TASKS_LOCK:
        task = read_image_task(task_id)
        if task is None:
            return
        if "apiKeyEncrypted" not in task:
            return
        task.pop("apiKeyEncrypted", None)
        task["updatedAt"] = now_ts() * 1000
        write_image_task(task_id, task)


def scrub_task_secrets_from_disk() -> None:
    tasks_root = OPENAI_PROXY_CACHE_DIR / "tasks"
    if not tasks_root.exists():
        return
    for meta_path in tasks_root.glob("*/task.json"):
        try:
            task = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        changed = False
        for key in ("upstream", "fallbackUpstream"):
            value = task.get(key)
            if isinstance(value, dict) and "apiKey" in value:
                value.pop("apiKey", None)
                changed = True
        if not changed:
            continue
        try:
            meta_path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            LOGGER.exception("failed to scrub task secret")


def resume_interrupted_image_tasks() -> None:
    tasks_root = OPENAI_PROXY_CACHE_DIR / "tasks"
    if not tasks_root.exists():
        return
    for meta_path in tasks_root.glob("*/task.json"):
        try:
            task = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if task.get("status") not in {"queued", "running"}:
            continue
        task_id = str(task.get("taskId") or meta_path.parent.name)
        if not task_has_persisted_secret(task):
            task["status"] = "failed"
            task["completedAt"] = now_ts() * 1000
            task["updatedAt"] = task["completedAt"]
            task["error"] = "后端服务已重启，旧版本任务没有持久化密钥，该任务无法继续；请重新生成。"
            try:
                write_image_task(task_id, task)
                write_log(
                    "WARN",
                    "image_task_interrupted_missing_secret",
                    f"{task_id} marked failed after backend restart without persisted secret",
                    task_id=task_id,
                )
            except Exception:
                LOGGER.exception("failed to mark interrupted image task")
            continue

        task["status"] = "queued"
        task["error"] = "后端服务已重启，任务已自动恢复执行"
        task["updatedAt"] = now_ts() * 1000
        try:
            write_image_task(task_id, task)
            thread = threading.Thread(
                target=run_image_task,
                args=(task_id,),
                name=f"image-task-resume-{task_id}",
                daemon=True,
            )
            thread.start()
            write_log(
                "WARN",
                "image_task_resumed",
                f"{task_id} resumed after backend restart",
                task_id=task_id,
            )
        except Exception:
            LOGGER.exception("failed to resume interrupted image task")


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def rotate_logs(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        DELETE FROM service_logs
        WHERE id NOT IN (
            SELECT id FROM service_logs ORDER BY id DESC LIMIT ?
        )
        """,
        (LOG_MAX_ROWS,),
    )


def compact_db_if_needed() -> None:
    try:
        if not DB_PATH.exists() or DB_PATH.stat().st_size <= DB_MAX_BYTES:
            return
        with DB_LOCK, connect_db() as conn:
            conn.execute(
                """
                DELETE FROM service_logs
                WHERE id NOT IN (
                    SELECT id FROM service_logs ORDER BY id DESC LIMIT ?
                )
                """,
                (max(100, LOG_MAX_ROWS // 2),),
            )
            conn.commit()
            conn.execute("VACUUM")
    except Exception:
        LOGGER.exception("failed to compact sqlite database")


def prune_openai_proxy_cache() -> None:
    if OPENAI_PROXY_CACHE_MAX_BYTES <= 0:
        return

    try:
        OPENAI_PROXY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        now = now_ts()
        all_files = [path for path in OPENAI_PROXY_CACHE_DIR.rglob("*") if path.is_file()]
        for path in all_files:
            try:
                if now - path.stat().st_mtime > OPENAI_PROXY_CACHE_MAX_AGE_SECONDS:
                    path.unlink(missing_ok=True)
            except OSError:
                continue

        for path in sorted(OPENAI_PROXY_CACHE_DIR.rglob("*"), reverse=True):
            if path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass

        body_files = [
            path for path in OPENAI_PROXY_CACHE_DIR.rglob("*") if path.is_file()
        ]
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for path in body_files:
            try:
                stat = path.stat()
            except OSError:
                continue
            total += stat.st_size
            entries.append((stat.st_mtime, stat.st_size, path))

        for _, size, path in sorted(entries, key=lambda item: item[0]):
            if total <= OPENAI_PROXY_CACHE_MAX_BYTES:
                break
            try:
                path.unlink(missing_ok=True)
                (OPENAI_PROXY_CACHE_DIR / f"{path.stem}.meta.json").unlink(missing_ok=True)
                total -= size
            except OSError:
                continue
    except Exception:
        LOGGER.exception("failed to prune openai proxy cache")


def cache_openai_proxy_response(
    proxy_path: str,
    status: int,
    headers: Any,
    body: bytes,
    target_url: str,
) -> str | None:
    if OPENAI_PROXY_CACHE_MAX_BYTES <= 0 or not body:
        return None
    if not proxy_path.startswith("/api/openai/v1/images/"):
        return None

    try:
        OPENAI_PROXY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        prune_openai_proxy_cache()
        cache_id = f"{int(now_ts() * 1000)}-{uuid.uuid4().hex}"
        body_path = OPENAI_PROXY_CACHE_DIR / f"{cache_id}.body"
        meta_path = OPENAI_PROXY_CACHE_DIR / f"{cache_id}.meta.json"
        body_path.write_bytes(body)
        target = urllib.parse.urlparse(target_url)
        metadata = {
            "id": cache_id,
            "createdAt": now_ts(),
            "status": status,
            "path": proxy_path,
            "target": urllib.parse.urlunparse(
                (target.scheme, target.netloc, target.path, "", "", "")
            ),
            "contentType": headers.get("Content-Type") if headers else None,
            "bytes": len(body),
        }
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        prune_openai_proxy_cache()
        return cache_id
    except Exception:
        LOGGER.exception("failed to cache openai proxy response")
        return None


def image_task_dir(task_id: str) -> Path:
    return OPENAI_PROXY_CACHE_DIR / "tasks" / task_id


def read_image_task(task_id: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", task_id):
        return None
    meta_path = image_task_dir(task_id) / "task.json"
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_image_task(task_id: str, task: dict[str, Any]) -> None:
    task_dir = image_task_dir(task_id)
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.json").write_text(
        json.dumps(task, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def hash_task_access_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def task_access_token_from_headers(headers: Any) -> str:
    return str(headers.get("X-Image-Task-Token") or "").strip()


def image_task_is_authorized(task: dict[str, Any], token: str) -> bool:
    expected = str(task.get("accessTokenHash") or "")
    if not expected or not token:
        return False
    return secrets.compare_digest(expected, hash_task_access_token(token))


def public_image_task(task: dict[str, Any], access_token: str | None = None) -> dict[str, Any]:
    payload = {
        "taskId": task["taskId"],
        "status": task["status"],
        "createdAt": task["createdAt"],
        "updatedAt": task["updatedAt"],
        "completedAt": task.get("completedAt"),
        "error": task.get("error"),
        "result": task.get("result"),
        "pollAfterMs": 1500 if task["status"] in {"queued", "running"} else 0,
        "request": task.get("request"),
        "fallbackUsed": task.get("fallbackUsed", False),
        "fallbackReason": task.get("fallbackReason"),
    }
    if access_token:
        payload["accessToken"] = access_token
    return payload


def list_public_image_tasks(limit: int = 30) -> list[dict[str, Any]]:
    return []


def update_image_task(task_id: str, **updates: Any) -> dict[str, Any]:
    with TASKS_LOCK:
        task = read_image_task(task_id)
        if task is None:
            raise KeyError(task_id)
        task.update(updates)
        task["updatedAt"] = now_ts() * 1000
        write_image_task(task_id, task)
        return task


def decode_data_url(data_url: str) -> tuple[str, bytes]:
    header, _, payload = data_url.partition(",")
    match = re.match(r"^data:([^;,]+);base64$", header)
    content_type = match.group(1) if match else "image/png"
    return content_type, base64.b64decode(payload)


def build_image_task_request(task: dict[str, Any]) -> urllib.request.Request:
    upstream = task["upstream"]
    target_url = openai_proxy_target_url(
        upstream["baseUrl"],
        f"/api/openai{upstream['path']}",
        "",
    )
    api_key = resolve_task_api_key(task) or upstream.get("apiKey")
    if not api_key:
        raise RuntimeError("任务缺少可用 API Key，请重新生成")
    if upstream["kind"] == "json":
        body = json.dumps(upstream["body"]).encode("utf-8")
        request_headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "GPT-Image-Tools/1.0",
        }
        return urllib.request.Request(
            target_url,
            data=body,
            method="POST",
            headers=request_headers,
        )

    boundary = f"----GPTImageTools{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )

    def add_file(name: str, filename: str, content_type: str, data: bytes) -> None:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                data,
                b"\r\n",
            ]
        )

    for name, value in upstream["fields"].items():
        add_field(name, str(value))
    for image in upstream["images"]:
        content_type, data = decode_data_url(str(image["dataUrl"]))
        add_file("image", str(image.get("name") or "reference.png"), content_type, data)
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(chunks)

    return urllib.request.Request(
        target_url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "GPT-Image-Tools/1.0",
        },
    )


def normalized_image_api_size(model: str, size: str) -> str:
    normalized_model = (model or "").strip().lower()
    if not normalized_model.startswith("gpt-image"):
        return size
    if size == "auto":
        return size
    supported_sizes = {"1024x1024", "1024x1536", "1536x1024"}
    if size in supported_sizes:
        return size
    match = re.fullmatch(r"(\d{2,5})x(\d{2,5})", size or "")
    if not match:
        return size
    width = int(match.group(1))
    height = int(match.group(2))
    if abs(width - height) / max(width, height) < 0.08:
        return "1024x1024"
    return "1024x1536" if height > width else "1536x1024"


def synthesize_image_task_fallback(task: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    upstream = task.get("upstream") or {}
    request_meta = task.get("request") or {}
    prompt = str(request_meta.get("prompt") or "")
    reference_names = [
        str(name)
        for name in request_meta.get("referenceImageNames") or []
        if str(name).strip()
    ]
    if reference_names:
        prompt = "\n".join(
            [
                prompt,
                "",
                f"参考图名称：{'、'.join(reference_names)}。当前上游图生图接口不可用，请根据提示词中对参考图主体、风格、构图和细节的描述完成文生图降级生成。",
            ]
        )
    model = str(request_meta.get("model") or upstream.get("fields", {}).get("model") or IMAGE_MODEL)
    size = str(request_meta.get("size") or upstream.get("fields", {}).get("size") or "1024x1024")
    quality = str(request_meta.get("quality") or upstream.get("fields", {}).get("quality") or "auto")
    response_format = str(request_meta.get("responseFormat") or "b64_json")
    fallback_request = {
        **request_meta,
        "prompt": prompt,
        "mode": "text",
        "count": 1,
        "responseFormat": response_format,
    }
    body = {
        "model": model,
        "prompt": prompt,
        "size": normalized_image_api_size(model, size),
        "n": 1,
    }
    if response_format == "b64_json" and model.strip().lower() != "gpt-image-2":
        body["response_format"] = response_format
    if quality != "auto":
        body["quality"] = quality
    fallback_upstream = {
        "kind": "json",
        "baseUrl": upstream.get("baseUrl"),
        "path": "/v1/images/generations",
        "body": body,
    }
    return fallback_request, fallback_upstream


def read_openai_image_response(
    request: urllib.request.Request,
    upstream_path: str,
    target_url: str,
) -> tuple[int, dict[str, Any]]:
    with open_url(request, timeout=OPENAI_PROXY_TIMEOUT) as response:
        response_body = response.read()
        body_text = response_body.decode("utf-8", errors="replace")
        try:
            result = json.loads(body_text) if body_text else {}
        except json.JSONDecodeError:
            result = {
                "error": {
                    "message": f"上游没有返回 JSON：{response_body[:240].decode('utf-8', errors='replace')}"
                }
            }
        cache_openai_proxy_response(
            f"/api/openai{upstream_path}",
            response.status,
            response.headers,
            response_body,
            target_url,
        )
        return response.status, result


def execute_openai_image_response(
    request: urllib.request.Request,
    upstream_path: str,
    target_url: str,
) -> tuple[int, dict[str, Any]]:
    result_queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

    def worker() -> None:
        try:
            result_queue.put(("ok", read_openai_image_response(request, upstream_path, target_url)))
        except BaseException as exc:
            result_queue.put(("error", exc))

    thread = threading.Thread(target=worker, name="openai-image-request", daemon=True)
    thread.start()
    thread.join(OPENAI_PROXY_TIMEOUT + 10)
    if thread.is_alive():
        raise TimeoutError(f"超过 {OPENAI_PROXY_TIMEOUT} 秒没有收到完整上游响应")

    kind, payload = result_queue.get_nowait()
    if kind == "error":
        raise payload
    return payload


def activate_image_task_fallback(
    task_id: str,
    reason: str,
    response_status: int | None = None,
) -> bool:
    with TASKS_LOCK:
        task = read_image_task(task_id)
        if task is None or task.get("fallbackUsed"):
            return False
        upstream = task.get("upstream") or {}
        if upstream.get("path") != "/v1/images/edits":
            return False
        request_meta = task.get("request") or {}
        if not request_meta.get("allowTextFallback"):
            return False
        fallback_upstream = task.get("fallbackUpstream")
        fallback_request = task.get("fallbackRequest")
        if not isinstance(fallback_upstream, dict):
            fallback_request, fallback_upstream = synthesize_image_task_fallback(task)

        task["fallbackUsed"] = True
        task["fallbackReason"] = reason
        task["upstream"] = fallback_upstream
        if isinstance(fallback_request, dict):
            task["request"] = fallback_request
        task["status"] = "running"
        task["error"] = "图生图上游不可用，已自动降级为文生图生成"
        task["updatedAt"] = now_ts() * 1000
        write_image_task(task_id, task)

    write_log(
        "WARN",
        "image_task_fallback",
        f"{task_id} switched to /v1/images/generations: {reason}",
        task_id=task_id,
        details={
            "reason": reason,
            "status": response_status,
            "fallbackPath": "/v1/images/generations",
        },
    )
    return True


def run_image_task(task_id: str) -> None:
    try:
        while True:
            task = update_image_task(task_id, status="running", error=None)
            upstream = task["upstream"]
            request_meta = task.get("request", {})
            retry_count = max(0, min(5, int(request_meta.get("retryCount") or 0)))
            max_attempts = retry_count + 1
            write_log(
                "INFO",
                "image_task_running",
                f"{task_id} started",
                task_id=task_id,
                details={
                    "path": upstream.get("path"),
                    "model": request_meta.get("model"),
                    "mode": request_meta.get("mode"),
                    "maxAttempts": max_attempts,
                    "fallbackUsed": task.get("fallbackUsed", False),
                },
            )
            started_at = now_ts()
            last_error_message = ""
            fallback_activated = False
            for attempt in range(1, max_attempts + 1):
                request = build_image_task_request(task)
                target_url = request.full_url
                try:
                    if attempt > 1:
                        update_image_task(
                            task_id,
                            status="running",
                            error=f"上游请求超时，正在重试 {attempt - 1}/{retry_count}",
                        )
                        write_log(
                            "WARN",
                            "image_task_retry",
                            f"{task_id} retry {attempt}/{max_attempts}",
                            task_id=task_id,
                            details={
                                "path": upstream.get("path"),
                                "model": request_meta.get("model"),
                                "mode": request_meta.get("mode"),
                            },
                        )

                    response_status, result = execute_openai_image_response(
                        request,
                        upstream["path"],
                        target_url,
                    )
                    update_image_task(
                        task_id,
                        status="completed",
                        completedAt=now_ts() * 1000,
                        result=result,
                        responseStatus=response_status,
                    )
                    write_log(
                        "INFO",
                        "image_task_completed",
                        f"{task_id} -> HTTP {response_status}",
                        task_id=task_id,
                        details={
                            "elapsedMs": round((now_ts() - started_at) * 1000),
                            "path": upstream["path"],
                            "fallbackUsed": task.get("fallbackUsed", False),
                        },
                    )
                    clear_image_task_secret(task_id)
                    return
                except urllib.error.HTTPError as exc:
                    response_body = exc.read()
                    body_text = response_body.decode("utf-8", errors="replace")
                    try:
                        result = json.loads(body_text) if body_text else {}
                    except json.JSONDecodeError:
                        result = {"error": {"message": response_snippet(body_text, 500) or exc.reason}}
                    message = (
                        result.get("error", {}).get("message")
                        if isinstance(result.get("error"), dict)
                        else result.get("message")
                    ) or f"上游返回 HTTP {exc.code}"
                    last_error_message = f"HTTP {exc.code}: {message}"
                    if is_transient_upstream_status(exc.code) and attempt < max_attempts:
                        write_log(
                            "WARN",
                            "image_task_retry",
                            f"{task_id} transient HTTP {exc.code}, retry {attempt}/{retry_count}",
                            task_id=task_id,
                            details={
                                "path": upstream.get("path"),
                                "model": request_meta.get("model"),
                                "mode": request_meta.get("mode"),
                                "status": exc.code,
                                "attempt": attempt,
                                "maxAttempts": max_attempts,
                            },
                        )
                        update_image_task(
                            task_id,
                            status="running",
                            error=f"上游返回 HTTP {exc.code}，正在重试 {attempt}/{retry_count}",
                        )
                        continue
                    if activate_image_task_fallback(task_id, last_error_message, exc.code):
                        fallback_activated = True
                        break
                    update_image_task(
                        task_id,
                        status="failed",
                        completedAt=now_ts() * 1000,
                        error=last_error_message,
                        result=result,
                        responseStatus=exc.code,
                    )
                    write_log(
                        "WARN",
                        "image_task_failed",
                        f"{task_id} -> {last_error_message}",
                        task_id=task_id,
                        details={
                            "path": upstream.get("path"),
                            "model": request_meta.get("model"),
                            "mode": request_meta.get("mode"),
                        },
                    )
                    clear_image_task_secret(task_id)
                    return
                except urllib.error.URLError as exc:
                    last_error_message = f"无法连接上游：{exc.reason}"
                except (
                    TimeoutError,
                    socket.timeout,
                    http.client.RemoteDisconnected,
                    http.client.BadStatusLine,
                    ConnectionError,
                    OSError,
                ) as exc:
                    if isinstance(exc, (TimeoutError, socket.timeout)):
                        last_error_message = f"上游读取超时：超过 {OPENAI_PROXY_TIMEOUT} 秒没有返回响应"
                    else:
                        last_error_message = f"上游连接中断：{exc}"

                if attempt < max_attempts:
                    continue

                if activate_image_task_fallback(task_id, last_error_message):
                    fallback_activated = True
                    break

                update_image_task(
                    task_id,
                    status="failed",
                    completedAt=now_ts() * 1000,
                    error=last_error_message,
                )
                write_log(
                    "WARN",
                    "image_task_failed",
                    f"{task_id} -> {last_error_message}",
                    task_id=task_id,
                    details={
                        "path": upstream.get("path"),
                        "model": request_meta.get("model"),
                        "mode": request_meta.get("mode"),
                        "attempts": max_attempts,
                        "timeoutSeconds": OPENAI_PROXY_TIMEOUT,
                    },
                )
                clear_image_task_secret(task_id)
                return

            if fallback_activated:
                continue
            return
    except Exception as exc:
        LOGGER.exception("image task failed")
        try:
            update_image_task(
                task_id,
                status="failed",
                completedAt=now_ts() * 1000,
                error=f"本地任务执行失败：{exc}",
            )
            write_log(
                "ERROR",
                "image_task_failed",
                f"{task_id} -> 本地任务执行失败：{exc}",
                task_id=task_id,
            )
            clear_image_task_secret(task_id)
        except Exception:
            LOGGER.exception("failed to persist image task failure")


def write_log(
    level: str,
    event: str,
    message: str,
    task_id: str | None = None,
    details: dict[str, Any] | str | None = None,
) -> None:
    if isinstance(details, dict):
        detail_text = json.dumps(details, ensure_ascii=False, default=str)
    else:
        detail_text = details
    try:
        with DB_LOCK, connect_db() as conn:
            conn.execute(
                """
                INSERT INTO service_logs (ts, level, event, task_id, message, details)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (now_ts(), level, event, task_id, message, detail_text),
            )
            rotate_logs(conn)
            conn.commit()
    except Exception:
        LOGGER.exception("failed to write service log")
    compact_db_if_needed()


def read_logs(
    limit: int = 100,
    level: str | None = None,
    event: str | None = None,
    task_id: str | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if level:
        clauses.append("level = ?")
        params.append(level.upper())
    if event:
        clauses.append("event = ?")
        params.append(event)
    if task_id:
        clauses.append("task_id = ?")
        params.append(task_id)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(max(1, min(500, limit)))
    with DB_LOCK, connect_db() as conn:
        rows = conn.execute(
            f"""
            SELECT id, ts, level, event, task_id, message, details
            FROM service_logs
            {where}
            ORDER BY id DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    logs: list[dict[str, Any]] = []
    for row in rows:
        details: Any = None
        if row["details"]:
            try:
                details = json.loads(row["details"])
            except json.JSONDecodeError:
                details = row["details"]
        logs.append(
            {
                "id": row["id"],
                "ts": row["ts"],
                "level": row["level"],
                "event": row["event"],
                "taskId": row["task_id"],
                "message": row["message"],
                "details": details,
            }
        )
    return logs


def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def normalize_new_api_base_url(value: str) -> str:
    raw = (value or DEFAULT_BASE_URL).strip().rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "https" or parsed.netloc != ALLOWED_NEW_API_HOST:
        raise NewApiError("当前只允许登录 https://hotapi.top/")
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_openai_proxy_base_url(value: str) -> str:
    raw = (value or "").strip().rstrip("/")
    if not raw:
        raise ValueError("缺少上游 Base URL")

    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("上游 Base URL 必须是 http 或 https 地址")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("上游 Base URL 不能包含账号、密码或片段")
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))


def openai_proxy_target_url(base_url: str, proxy_path: str, query: str) -> str:
    normalized_base = normalize_openai_proxy_base_url(base_url)
    target_path = proxy_path.removeprefix("/api/openai")
    if not target_path.startswith("/v1/"):
        raise ValueError("只允许代理 OpenAI-compatible /v1/* 接口")
    target = f"{normalized_base}{target_path}"
    if query:
        target = f"{target}?{query}"
    return target


def sanitized_forward_headers(headers: Any) -> dict[str, str]:
    blocked = {
        "accept-encoding",
        "connection",
        "content-length",
        "host",
        "origin",
        "referer",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "transfer-encoding",
    }
    forwarded: dict[str, str] = {}
    for name, value in headers.items():
        lowered = name.lower()
        if lowered in blocked or lowered.startswith("proxy-"):
            continue
        forwarded[name] = value
    forwarded.setdefault("User-Agent", "GPT-Image-Tools/1.0")
    return forwarded


def response_snippet(text: str, limit: int = 240) -> str:
    cleaned = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"<style[\s\S]*?</style>", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:limit] or "空响应"


def is_transient_upstream_status(status: int) -> bool:
    return status in {
        408,
        429,
        500,
        502,
        503,
        504,
        520,
        521,
        522,
        523,
        524,
        525,
        526,
    }


def split_model_limits(value: str | None) -> set[str]:
    return {item.strip() for item in (value or "").split(",") if item.strip()}


class NewApiSession:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = build_url_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))
        self.user_id: int | None = None

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        include_user_id: bool = True,
    ) -> dict[str, Any]:
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": "GPT-Image-Tools/1.0",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if include_user_id and self.user_id is not None:
            headers["New-Api-User"] = str(self.user_id)

        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with self.opener.open(request, timeout=REQUEST_TIMEOUT) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise NewApiError(f"中转站请求失败：HTTP {exc.code} {raw[:200]}") from exc
        except urllib.error.URLError as exc:
            raise NewApiError(f"无法连接中转站：{exc.reason}") from exc

        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise NewApiError("中转站返回了无法解析的数据") from exc

    def login(self, username: str, password: str) -> None:
        response = self.request(
            "POST",
            "/api/user/login?turnstile=",
            {"username": username, "password": password},
            include_user_id=False,
        )
        if not response.get("success"):
            raise NewApiError(str(response.get("message") or "登录失败"))

        data = response.get("data") or {}
        if data.get("require_2fa"):
            raise NewApiError("该账号开启了 2FA，请先在控制台登录并处理安全验证")

        user_id = data.get("id")
        if not isinstance(user_id, int):
            raise NewApiError("登录成功但没有返回用户 ID")
        self.user_id = user_id

    def list_tokens(self) -> list[dict[str, Any]]:
        response = self.request("GET", f"/api/token/?p=1&size={TOKEN_LIST_PAGE_SIZE}")
        if not response.get("success"):
            raise NewApiError(str(response.get("message") or "获取秘钥列表失败"))

        data = response.get("data") or {}
        items = data.get("items") or []
        if not isinstance(items, list):
            return []

        tokens = [item for item in items if isinstance(item, dict)]
        total = data.get("total")
        if not isinstance(total, int) or total <= len(tokens):
            return tokens

        page = 2
        while len(tokens) < total and page <= TOKEN_LIST_MAX_PAGES:
            response = self.request(
                "GET", f"/api/token/?p={page}&size={TOKEN_LIST_PAGE_SIZE}"
            )
            if not response.get("success"):
                raise NewApiError(str(response.get("message") or "获取秘钥列表失败"))
            data = response.get("data") or {}
            page_items = data.get("items") or []
            if not isinstance(page_items, list) or not page_items:
                break
            tokens.extend(item for item in page_items if isinstance(item, dict))
            page += 1

        return tokens

    def find_target_token(self, group: str, model: str) -> dict[str, Any] | None:
        for token in self.list_tokens():
            if token.get("group") != group:
                continue
            if token.get("status") not in (None, 1):
                continue
            if token.get("model_limits_enabled"):
                models = split_model_limits(token.get("model_limits"))
                if model not in models:
                    continue
            return token
        return None

    def create_target_token(self, name: str, group: str, model: str) -> dict[str, Any]:
        response = self.request(
            "POST",
            "/api/token/",
            {
                "name": name,
                "remain_quota": 0,
                "expired_time": -1,
                "unlimited_quota": True,
                "model_limits_enabled": True,
                "model_limits": model,
                "allow_ips": "",
                "group": group,
                "cross_group_retry": False,
            },
        )
        if not response.get("success"):
            message = str(response.get("message") or "创建秘钥失败")
            if message == "未找到":
                message = (
                    f"无法创建“{group}”分组的秘钥：中转站提示未找到。"
                    "请确认该用户拥有此分组权限，并且该分组仍可用。"
                )
            raise NewApiError(message)

        token = self.extract_created_token(response)
        if token is not None:
            return token

        token = self.find_target_token(group, model)
        if token is None:
            raise NewApiError(f"{group} 秘钥已创建，但重新查询时没有找到")
        return token

    def extract_created_token(self, response: dict[str, Any]) -> dict[str, Any] | None:
        data = response.get("data")
        if isinstance(data, dict):
            if isinstance(data.get("id"), int):
                return data
            for key in ("token", "item"):
                nested = data.get(key)
                if isinstance(nested, dict) and isinstance(nested.get("id"), int):
                    return nested
        return None

    def get_full_key(self, token_id: int, group: str) -> str:
        response = self.request("POST", f"/api/token/{token_id}/key")
        if not response.get("success"):
            message = str(response.get("message") or "获取完整秘钥失败")
            if message == "未找到":
                message = (
                    f"无法获取“{group}”分组的完整秘钥：中转站提示未找到。"
                    "请确认该用户仍拥有此分组权限，或删除异常秘钥后重试。"
                )
            raise NewApiError(message)

        data = response.get("data") or {}
        key = data.get("key")
        if not isinstance(key, str) or not key:
            raise NewApiError("中转站没有返回可用秘钥")
        return key

    def obtain_token_key(self, name: str, group: str, model: str) -> dict[str, Any]:
        token = self.find_target_token(group, model)
        created = False
        if token is None:
            token = self.create_target_token(name, group, model)
            created = True

        token_id = token.get("id")
        if not isinstance(token_id, int):
            raise NewApiError(f"{group} 目标秘钥缺少 ID")

        return {
            "apiKey": self.get_full_key(token_id, group),
            "group": group,
            "model": model,
            "tokenName": token.get("name") or name,
            "created": created,
        }


def obtain_managed_key(base_url: str, username: str, password: str) -> dict[str, Any]:
    if not username.strip() or not password:
        raise NewApiError("请输入账号和密码")

    normalized_base_url = normalize_new_api_base_url(base_url)
    session = NewApiSession(normalized_base_url)
    session.login(username.strip(), password)

    image_key = session.obtain_token_key(IMAGE_TOKEN_NAME, IMAGE_GROUP, IMAGE_MODEL)
    codex_key = session.obtain_token_key(CODEX_TOKEN_NAME, CODEX_GROUP, CODEX_MODEL)

    return {
        "baseUrl": normalized_base_url,
        "apiKey": image_key["apiKey"],
        "group": image_key["group"],
        "model": image_key["model"],
        "tokenName": image_key["tokenName"],
        "created": image_key["created"],
        "codexApiKey": codex_key["apiKey"],
        "codexGroup": codex_key["group"],
        "codexModel": codex_key["model"],
        "codexTokenName": codex_key["tokenName"],
        "codexCreated": codex_key["created"],
    }


def xlsx_column_index(cell_ref: str) -> int:
    letters = "".join(char for char in cell_ref if char.isalpha()).upper()
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)


def read_xlsx_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ElementTree.fromstring(raw)
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    values: list[str] = []
    for item in root.findall("x:si", namespace):
        parts = [text.text or "" for text in item.findall(".//x:t", namespace)]
        values.append("".join(parts))
    return values


def read_xlsx_rows(path: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        shared_strings = read_xlsx_shared_strings(archive)
        try:
            sheet_raw = archive.read("xl/worksheets/sheet1.xml")
        except KeyError:
            return rows

    root = ElementTree.fromstring(sheet_raw)
    for row in root.findall(".//x:sheetData/x:row", namespace):
        values: list[str] = []
        for cell in row.findall("x:c", namespace):
            cell_ref = cell.attrib.get("r", "A1")
            cell_index = xlsx_column_index(cell_ref)
            while len(values) <= cell_index:
                values.append("")

            cell_type = cell.attrib.get("t")
            value = ""
            if cell_type == "inlineStr":
                value = "".join(
                    text.text or "" for text in cell.findall(".//x:is/x:t", namespace)
                )
            else:
                raw_value = cell.find("x:v", namespace)
                if raw_value is not None and raw_value.text is not None:
                    if cell_type == "s":
                        try:
                            value = shared_strings[int(raw_value.text)]
                        except (ValueError, IndexError):
                            value = ""
                    else:
                        value = raw_value.text
            values[cell_index] = value
        rows.append(values)
    return rows


def normalize_style_filename_value(value: str) -> str:
    return value.replace(" ", "").replace("_", "").lower()


def find_style_image(category_dir: Path, style_name: str, marker: str) -> Path | None:
    normalized_name = normalize_style_filename_value(style_name)
    candidates = [
        path
        for path in category_dir.iterdir()
        if path.is_file()
        and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        and f"-{marker}" in path.stem
    ]
    for path in candidates:
        if normalized_name and normalized_name in normalize_style_filename_value(path.stem):
            return path
    return None


def style_image_url(style_id: str, kind: str) -> str:
    return f"/api/style-library/images/{urllib.parse.quote(style_id)}/{kind}"


def build_style_library() -> dict[str, Any]:
    if not STYLE_LIBRARY_DIR.exists() or not STYLE_LIBRARY_DIR.is_dir():
        return {"root": str(STYLE_LIBRARY_DIR), "categories": [], "styles": []}

    styles: list[dict[str, Any]] = []
    categories: list[dict[str, Any]] = []
    for category_dir in sorted(
        [path for path in STYLE_LIBRARY_DIR.iterdir() if path.is_dir()],
        key=lambda path: path.name,
    ):
        category_count = 0
        xlsx_files = sorted(category_dir.glob("*Json.xlsx"))
        if not xlsx_files:
            continue

        try:
            rows = read_xlsx_rows(xlsx_files[0])
        except (OSError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
            write_log(
                "ERROR",
                "style_library_failed",
                f"读取风格表失败：{category_dir.name}",
                details=str(exc),
            )
            continue

        for row in rows[1:]:
            if len(row) < 2:
                continue
            name = str(row[0] or "").strip()
            raw_json = str(row[1] or "").strip()
            if not name or not raw_json:
                continue
            try:
                style_json = json.loads(raw_json)
            except json.JSONDecodeError:
                write_log(
                    "ERROR",
                    "style_library_failed",
                    f"风格 JSON 无法解析：{category_dir.name}/{name}",
                )
                continue

            style_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{category_dir.name}/{name}").hex
            preview = find_style_image(category_dir, name, "风格")
            source = find_style_image(category_dir, name, "原")
            keywords = style_json.get("style_keywords") if isinstance(style_json, dict) else []
            styles.append(
                {
                    "id": style_id,
                    "category": category_dir.name,
                    "name": name,
                    "styleJson": style_json,
                    "keywords": keywords if isinstance(keywords, list) else [],
                    "previewUrl": style_image_url(style_id, "preview") if preview else None,
                    "sourceUrl": style_image_url(style_id, "source") if source else None,
                }
            )
            category_count += 1

        if category_count:
            categories.append({"name": category_dir.name, "count": category_count})

    return {"root": str(STYLE_LIBRARY_DIR), "categories": categories, "styles": styles}


def style_image_path(style_id: str, kind: str) -> Path | None:
    library = build_style_library()
    for style in library["styles"]:
        if style["id"] != style_id:
            continue
        category_dir = STYLE_LIBRARY_DIR / str(style["category"])
        marker = "风格" if kind == "preview" else "原"
        return find_style_image(category_dir, str(style["name"]), marker)
    return None


class ImageToolsHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self) -> None:
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == "/api/health":
            json_response(
                self,
                HTTPStatus.OK,
                {
                    "success": True,
                    "service": "gpt-image-tools",
                    "features": ["newapi-login-key", "openai-proxy", "image-tasks", "logs"],
                },
            )
            return
        if parsed_path.path == "/api/logs":
            self.handle_list_logs(parsed_path)
            return
        if parsed_path.path == "/api/image-tasks":
            self.handle_list_image_tasks()
            return
        if parsed_path.path.startswith("/api/image-tasks/"):
            self.handle_get_image_task(parsed_path)
            return
        if parsed_path.path.startswith("/api/openai/"):
            self.handle_openai_proxy(parsed_path)
            return
        if parsed_path.path == "/api/style-library":
            self.handle_style_library()
            return
        if parsed_path.path.startswith("/api/style-library/images/"):
            self.handle_style_image(parsed_path)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == "/api/image-tasks":
            self.handle_create_image_task()
            return
        if parsed_path.path.startswith("/api/openai/"):
            self.handle_openai_proxy(parsed_path)
            return
        if parsed_path.path != "/api/newapi/login-key":
            json_response(self, HTTPStatus.NOT_FOUND, {"success": False, "message": "Not found"})
            return

        try:
            body_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            body_length = 0
        if body_length <= 0 or body_length > MAX_JSON_BODY:
            json_response(
                self,
                HTTPStatus.BAD_REQUEST,
                {"success": False, "message": "请求体为空或过大"},
            )
            return

        try:
            payload = json.loads(self.rfile.read(body_length).decode("utf-8"))
            result = obtain_managed_key(
                str(payload.get("baseUrl") or DEFAULT_BASE_URL),
                str(payload.get("username") or ""),
                str(payload.get("password") or ""),
            )
            json_response(self, HTTPStatus.OK, {"success": True, "message": "", "data": result})
        except NewApiError as exc:
            write_log("WARN", "newapi_login_failed", str(exc))
            json_response(self, HTTPStatus.OK, {"success": False, "message": str(exc)})
        except Exception:
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"success": False, "message": "登录中转站失败，请稍后重试"},
            )

    def read_json_body(self, max_bytes: int) -> dict[str, Any]:
        try:
            body_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            body_length = 0
        if body_length <= 0 or body_length > max_bytes:
            raise ValueError("请求体为空或过大")
        body = self.rfile.read(body_length).decode("utf-8")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def handle_create_image_task(self) -> None:
        try:
            payload = self.read_json_body(MAX_OPENAI_PROXY_BODY)
            task_id = f"img_{int(now_ts() * 1000)}_{uuid.uuid4().hex[:12]}"
            access_token = secrets.token_urlsafe(24)
            created_at = now_ts() * 1000
            upstream = payload.get("upstream")
            if not isinstance(upstream, dict):
                raise ValueError("缺少 upstream 配置")
            if upstream.get("kind") not in {"json", "multipart"}:
                raise ValueError("不支持的 upstream.kind")
            if upstream.get("path") not in {"/v1/images/generations", "/v1/images/edits"}:
                raise ValueError("图片任务只允许 /v1/images/generations 或 /v1/images/edits")
            if not str(upstream.get("apiKey") or "").strip():
                raise ValueError("缺少 API Key")
            api_key = str(upstream.pop("apiKey")).strip()
            fallback_upstream = payload.get("fallbackUpstream")
            if isinstance(fallback_upstream, dict):
                fallback_upstream.pop("apiKey", None)
                if fallback_upstream.get("kind") not in {"json", "multipart"}:
                    raise ValueError("不支持的 fallbackUpstream.kind")
                if fallback_upstream.get("path") not in {"/v1/images/generations", "/v1/images/edits"}:
                    raise ValueError("图片降级任务只允许 /v1/images/generations 或 /v1/images/edits")
            else:
                fallback_upstream = None
            fallback_request = (
                payload.get("fallbackRequest") if isinstance(payload.get("fallbackRequest"), dict) else None
            )

            task = {
                "taskId": task_id,
                "status": "queued",
                "createdAt": created_at,
                "updatedAt": created_at,
                "completedAt": None,
                "error": None,
                "result": None,
                "request": payload.get("request") if isinstance(payload.get("request"), dict) else {},
                "upstream": upstream,
                "apiKeyEncrypted": encrypt_task_api_key(api_key),
                "accessTokenHash": hash_task_access_token(access_token),
            }
            if fallback_upstream:
                task["fallbackUpstream"] = fallback_upstream
            if fallback_request:
                task["fallbackRequest"] = fallback_request
            with TASKS_LOCK:
                TASK_SECRETS[task_id] = api_key
                write_image_task(task_id, task)
            write_log(
                "INFO",
                "image_task_created",
                f"{task_id} queued",
                task_id=task_id,
                details={
                    "path": upstream.get("path"),
                    "model": task.get("request", {}).get("model"),
                    "mode": task.get("request", {}).get("mode"),
                    "size": task.get("request", {}).get("size"),
                    "responseFormat": task.get("request", {}).get("responseFormat"),
                },
            )
            thread = threading.Thread(
                target=run_image_task,
                args=(task_id,),
                name=f"image-task-{task_id}",
                daemon=True,
            )
            thread.start()
            json_response(self, HTTPStatus.ACCEPTED, public_image_task(task, access_token))
        except json.JSONDecodeError:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": {"message": "请求体不是有效 JSON"}})
        except ValueError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
        except Exception:
            LOGGER.exception("failed to create image task")
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": {"message": "创建生图任务失败"}},
            )

    def handle_get_image_task(self, parsed_path: urllib.parse.ParseResult) -> None:
        task_id = parsed_path.path.removeprefix("/api/image-tasks/").strip("/")
        task = read_image_task(task_id)
        if task is None:
            json_response(self, HTTPStatus.NOT_FOUND, {"error": {"message": "生图任务不存在或已过期"}})
            return
        if not image_task_is_authorized(task, task_access_token_from_headers(self.headers)):
            json_response(self, HTTPStatus.NOT_FOUND, {"error": {"message": "生图任务不存在或已过期"}})
            return
        json_response(self, HTTPStatus.OK, public_image_task(task))

    def handle_list_image_tasks(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            limit = int(query.get("limit", ["30"])[0])
        except ValueError:
            limit = 30
        json_response(
            self,
            HTTPStatus.OK,
            {"data": list_public_image_tasks(max(1, min(100, limit)))},
        )

    def handle_list_logs(self, parsed_path: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed_path.query)
        try:
            limit = int(query.get("limit", ["100"])[0])
        except ValueError:
            limit = 100
        level = query.get("level", [""])[0].strip().upper() or None
        event = query.get("event", [""])[0].strip() or None
        task_id = query.get("taskId", [""])[0].strip() or None
        json_response(
            self,
            HTTPStatus.OK,
            {
                "success": True,
                "data": read_logs(
                    limit=max(1, min(500, limit)),
                    level=level,
                    event=event,
                    task_id=task_id,
                ),
            },
        )

    def handle_openai_proxy(self, parsed_path: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed_path.query, keep_blank_values=True)
        base_url = query.pop("baseUrl", [""])[0]
        target_query = urllib.parse.urlencode(query, doseq=True)
        try:
            target_url = openai_proxy_target_url(base_url, parsed_path.path, target_query)
        except ValueError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
            return

        try:
            body_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            body_length = 0
        if body_length < 0 or body_length > MAX_OPENAI_PROXY_BODY:
            json_response(
                self,
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"error": {"message": "代理请求体过大"}},
            )
            return

        body = self.rfile.read(body_length) if body_length else None
        request = urllib.request.Request(
            target_url,
            data=body,
            method=self.command,
            headers=sanitized_forward_headers(self.headers),
        )

        started_at = now_ts()
        try:
            with open_url(request, timeout=OPENAI_PROXY_TIMEOUT) as response:
                response_body = response.read()
                self.send_response(response.status)
                self.forward_openai_response_headers(response.headers, len(response_body))
                self.end_headers()
                self.wfile.write(response_body)
                write_log(
                    "INFO",
                    "openai_proxy",
                    f"{self.command} {parsed_path.path} -> HTTP {response.status}",
                    details={
                        "target": urllib.parse.urlparse(target_url)._replace(query="").geturl(),
                        "elapsedMs": round((now_ts() - started_at) * 1000),
                    },
                )
        except urllib.error.HTTPError as exc:
            response_body = exc.read()
            self.send_response(exc.code)
            self.forward_openai_response_headers(exc.headers, len(response_body))
            self.end_headers()
            self.wfile.write(response_body)
            write_log(
                "WARN",
                "openai_proxy_http_error",
                f"{self.command} {parsed_path.path} -> HTTP {exc.code}",
                details={
                    "target": urllib.parse.urlparse(target_url)._replace(query="").geturl(),
                    "elapsedMs": round((now_ts() - started_at) * 1000),
                },
            )
        except urllib.error.URLError as exc:
            message = f"无法连接上游：{exc.reason}"
            write_log(
                "WARN",
                "openai_proxy_network_error",
                message,
                details={
                    "target": urllib.parse.urlparse(target_url)._replace(query="").geturl(),
                    "elapsedMs": round((now_ts() - started_at) * 1000),
                },
            )
            json_response(
                self,
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": message}},
            )
        except Exception:
            LOGGER.exception("openai proxy failed")
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": {"message": "本地 OpenAI 代理请求失败"}},
            )

    def forward_openai_response_headers(self, headers: Any, body_length: int) -> None:
        blocked = {
            "connection",
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "strict-transport-security",
        }
        for name, value in headers.items():
            if name.lower() in blocked:
                continue
            self.send_header(name, value)
        self.send_header("Content-Length", str(body_length))

    def handle_style_library(self) -> None:
        try:
            json_response(
                self,
                HTTPStatus.OK,
                {"success": True, "message": "", "data": build_style_library()},
            )
        except Exception:
            LOGGER.exception("failed to read style library")
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"success": False, "message": "读取风格库失败，请检查服务器素材目录"},
            )

    def handle_style_image(self, parsed_path: urllib.parse.ParseResult) -> None:
        prefix = "/api/style-library/images/"
        relative = parsed_path.path[len(prefix):]
        parts = [urllib.parse.unquote(part) for part in relative.split("/") if part]
        if len(parts) != 2 or parts[1] not in {"preview", "source"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        style_id, kind = parts
        path = style_image_path(style_id, kind)
        if path is None or not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            if not str(path.resolve()).startswith(str(STYLE_LIBRARY_DIR)):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def translate_path(self, path: str) -> str:
        root = Path(self.directory).resolve()
        parsed = urllib.parse.urlparse(path)
        clean_path = posixpath.normpath(urllib.parse.unquote(parsed.path))
        parts = [part for part in clean_path.split("/") if part and part not in (".", "..")]
        resolved = root.joinpath(*parts).resolve()
        if not str(resolved).startswith(str(root)):
            return str(root / "index.html")
        if resolved.exists():
            return str(resolved)
        return str(root / "index.html")


def main() -> None:
    static_dir = Path(os.environ.get("IMAGE_TOOLS_STATIC_DIR", os.getcwd())).resolve()
    port = int(os.environ.get("PORT", "19080"))
    bind = os.environ.get("HOST", "0.0.0.0")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    init_storage()
    outbound_proxy = resolve_outbound_proxy()
    if outbound_proxy:
        LOGGER.info("Using outbound proxy %s", outbound_proxy)
    else:
        LOGGER.info("Using direct outbound network")

    handler = lambda *args, **kwargs: ImageToolsHandler(  # noqa: E731
        *args,
        directory=str(static_dir),
        **kwargs,
    )
    server = ThreadingHTTPServer((bind, port), handler)
    print(f"Serving {static_dir} on http://{bind}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
