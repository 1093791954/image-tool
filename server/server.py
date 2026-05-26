#!/usr/bin/env python3
from __future__ import annotations

import http.cookiejar
import base64
import binascii
import ipaddress
import json
import logging
import mimetypes
import os
import posixpath
import re
import socket
import sqlite3
import threading
import time
import traceback
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
IMAGE_GROUP = "gpt-image-2 生图低价"
IMAGE_MODEL = "gpt-image-2"
IMAGE_TOKEN_NAME = "GPT Image Tools - gpt-image-2"
CODEX_GROUP = "codex 满血高速"
CODEX_MODEL = "gpt-5.5"
CODEX_TOKEN_NAME = "GPT Image Tools - codex"
MAX_JSON_BODY = 16 * 1024
MAX_IMAGE_BODY = 32 * 1024 * 1024
MAX_PROXY_BODY = 96 * 1024 * 1024
TOKEN_LIST_PAGE_SIZE = 100
TOKEN_LIST_MAX_PAGES = 50
REQUEST_TIMEOUT = env_int("IMAGE_TOOLS_REQUEST_TIMEOUT", 25)
IMAGE_REQUEST_TIMEOUT = env_int("IMAGE_TOOLS_IMAGE_REQUEST_TIMEOUT", 600)
CACHE_MAX_BYTES = env_int("IMAGE_TOOLS_CACHE_MAX_BYTES", 1024 * 1024 * 1024)
LOG_MAX_ROWS = env_int("IMAGE_TOOLS_LOG_MAX_ROWS", 5000)
DB_MAX_BYTES = env_int("IMAGE_TOOLS_DB_MAX_BYTES", 64 * 1024 * 1024)
DEFAULT_LOCAL_PROXY = "http://127.0.0.1:7897"
DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1"
DEFAULT_LOCAL_PROXY_PORT = 7897
TASK_POLL_SECONDS = 1.5
OPENAI_IMAGE_PROXY_PATHS = {
    "/api/openai/v1/images/generations": "/v1/images/generations",
    "/api/openai/v1/images/edits": "/v1/images/edits",
}

DATA_DIR = Path(os.environ.get("IMAGE_TOOLS_DATA_DIR", "server-data")).resolve()
CACHE_DIR = Path(os.environ.get("IMAGE_TOOLS_CACHE_DIR", str(DATA_DIR / "image-cache"))).resolve()
DB_PATH = Path(os.environ.get("IMAGE_TOOLS_DB_PATH", str(DATA_DIR / "image-tools.sqlite3"))).resolve()
DEFAULT_STYLE_LIBRARY_DIR = (
    r"D:\tmp\image-tool-lib\风格" if os.name == "nt" else "/opt/image-tool-lib/风格"
)
STYLE_LIBRARY_DIR = Path(
    os.environ.get("IMAGE_TOOLS_STYLE_LIBRARY_DIR", DEFAULT_STYLE_LIBRARY_DIR)
).resolve()

DB_LOCK = threading.RLock()
LOGGER = logging.getLogger("image-tools")


class NewApiError(Exception):
    pass


class ImageFetchError(Exception):
    pass


class OpenAIProxyError(Exception):
    pass


class ImageTaskError(Exception):
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
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS generation_tasks (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                completed_at REAL,
                base_url TEXT NOT NULL,
                upstream_path TEXT NOT NULL,
                request_content_type TEXT NOT NULL,
                request_size INTEGER NOT NULL,
                model TEXT,
                prompt TEXT,
                error TEXT,
                result_json TEXT,
                cache_bytes INTEGER NOT NULL DEFAULT 0
            )
            """
        )
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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON generation_tasks(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_completed ON generation_tasks(completed_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_ts ON service_logs(ts)")
        conn.commit()


def recover_incomplete_tasks() -> None:
    with DB_LOCK, connect_db() as conn:
        conn.execute(
            """
            UPDATE generation_tasks
            SET status = 'failed',
                updated_at = ?,
                completed_at = ?,
                error = '服务器重启导致任务中断，请重新生成'
            WHERE status IN ('queued', 'running')
            """,
            (now_ts(), now_ts()),
        )
        conn.commit()


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


def parse_generation_metadata(content_type: str, body: bytes) -> dict[str, Any]:
    if content_type.startswith("multipart/form-data"):
        metadata: dict[str, Any] = {
            "model": None,
            "prompt": None,
            "image_count": 0,
            "image_bytes": 0,
            "image_fields": [],
            "field_names": [],
            "size": None,
            "quality": None,
            "input_fidelity": None,
        }
        boundary_match = re.search(r'boundary="?([^";]+)"?', content_type)
        if not boundary_match:
            return metadata

        delimiter = f"--{boundary_match.group(1)}".encode("utf-8")
        for raw_part in body.split(delimiter):
            part = raw_part.strip(b"\r\n")
            if not part or part == b"--":
                continue
            if part.endswith(b"--"):
                part = part[:-2].rstrip(b"\r\n")

            headers_blob, separator, payload = part.partition(b"\r\n\r\n")
            if not separator:
                continue
            if payload.endswith(b"\r\n"):
                payload = payload[:-2]

            headers_text = headers_blob.decode("utf-8", errors="replace")
            name_match = re.search(r'name="([^"]+)"', headers_text)
            if not name_match:
                continue
            name = name_match.group(1)
            if name not in metadata["field_names"]:
                metadata["field_names"].append(name)
            has_filename = bool(re.search(r'filename="[^"]*"', headers_text))

            if has_filename or name.startswith("image"):
                metadata["image_count"] += 1
                metadata["image_bytes"] += len(payload)
                if name not in metadata["image_fields"]:
                    metadata["image_fields"].append(name)
                continue

            if name in {"model", "prompt", "size", "quality", "input_fidelity"}:
                value = payload.decode("utf-8", errors="replace").strip()
                limit = 2000 if name == "prompt" else 200
                metadata[name] = value[:limit] or None

        return metadata

    if not content_type.startswith("application/json"):
        return {"model": None, "prompt": None}
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return {"model": None, "prompt": None}
    return {
        "model": str(payload.get("model") or "")[:200] or None,
        "prompt": str(payload.get("prompt") or "")[:2000] or None,
        "size": str(payload.get("size") or "")[:200] or None,
        "quality": str(payload.get("quality") or "")[:200] or None,
        "count": payload.get("n"),
        "response_format": str(payload.get("response_format") or "")[:200] or None,
    }


def task_cache_dir(task_id: str) -> Path:
    return CACHE_DIR / task_id


def safe_cache_path(task_id: str, filename: str) -> Path:
    root = task_cache_dir(task_id).resolve()
    path = (root / filename).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise ImageTaskError("缓存文件路径不安全")
    return path


def cache_public_url(task_id: str, filename: str) -> str:
    return f"/api/image-cache/{urllib.parse.quote(task_id)}/{urllib.parse.quote(filename)}"


def guess_extension(content_type: str) -> str:
    content_type = (content_type or "image/png").split(";")[0].strip().lower()
    return mimetypes.guess_extension(content_type) or ".png"


def write_task_file(task_id: str, filename: str, data: bytes) -> str:
    root = task_cache_dir(task_id)
    root.mkdir(parents=True, exist_ok=True)
    path = safe_cache_path(task_id, filename)
    path.write_bytes(data)
    return filename


def cache_dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return total
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return total


def total_cache_size() -> int:
    return cache_dir_size(CACHE_DIR)


def remove_cache_tree(path: Path) -> None:
    if not path.exists():
        return
    entries = sorted(
        path.rglob("*"),
        key=lambda item: (len(item.parts), item.is_dir()),
        reverse=True,
    )
    for item in entries:
        if item.is_file() or item.is_symlink():
            item.unlink(missing_ok=True)
        elif item.is_dir():
            item.rmdir()
    path.rmdir()


def evict_cache_if_needed(skip_task_id: str | None = None) -> None:
    current_size = total_cache_size()
    if current_size <= CACHE_MAX_BYTES:
        return

    evicted_task_ids: list[str] = []
    with DB_LOCK, connect_db() as conn:
        rows = conn.execute(
            """
            SELECT id FROM generation_tasks
            WHERE status = 'completed' AND cache_bytes > 0
            ORDER BY COALESCE(completed_at, updated_at), created_at
            """
        ).fetchall()

        for row in rows:
            task_id = str(row["id"])
            if task_id == skip_task_id:
                continue
            try:
                remove_cache_tree(task_cache_dir(task_id))
            except OSError:
                LOGGER.exception("failed to remove cache for task %s", task_id)
            conn.execute(
                """
                UPDATE generation_tasks
                SET status = 'expired',
                    updated_at = ?,
                    error = '服务器临时缓存已过期，请重新生成',
                    result_json = NULL,
                    cache_bytes = 0
                WHERE id = ?
                """,
                (now_ts(), task_id),
            )
            evicted_task_ids.append(task_id)
            current_size = total_cache_size()
            if current_size <= CACHE_MAX_BYTES:
                break
        conn.commit()

    for task_id in evicted_task_ids:
        write_log("INFO", "cache_evict", "已清理旧生成缓存", task_id)


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


def normalize_public_base_url(value: str) -> str:
    raw = (value or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "https" or not parsed.netloc:
        raise OpenAIProxyError("Base URL 必须是 https 地址")
    if parsed.username or parsed.password:
        raise OpenAIProxyError("Base URL 不允许包含账号密码")
    if not is_public_hostname(parsed.hostname):
        raise OpenAIProxyError("Base URL 不是可公开访问地址")
    return f"{parsed.scheme}://{parsed.netloc}"


def split_model_limits(value: str | None) -> set[str]:
    return {item.strip() for item in (value or "").split(",") if item.strip()}


def is_public_hostname(hostname: str | None) -> bool:
    if not hostname:
        return False
    if hostname.lower() in {"localhost"}:
        return False

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False

    for info in infos:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False
    return True


def fetch_image_as_data_url(url: str) -> str:
    parsed = urllib.parse.urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImageFetchError("图片 URL 格式不正确")
    if parsed.username or parsed.password:
        raise ImageFetchError("图片 URL 不允许包含账号密码")
    if not is_public_hostname(parsed.hostname):
        raise ImageFetchError("图片 URL 不是可公开访问地址")

    request = urllib.request.Request(
        urllib.parse.urlunparse(parsed),
        headers={
            "Accept": "image/*,*/*;q=0.8",
            "User-Agent": "GPT-Image-Tools/1.0",
        },
    )
    try:
        with open_url(request, timeout=REQUEST_TIMEOUT) as response:
            content_type = response.headers.get("Content-Type", "image/png").split(";")[0].strip()
            if not content_type.startswith("image/"):
                raise ImageFetchError("返回内容不是图片")

            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_IMAGE_BODY:
                    raise ImageFetchError("图片过大，无法保存到浏览器")
                chunks.append(chunk)
    except urllib.error.URLError as exc:
        raise ImageFetchError(f"无法下载生成图片：{exc.reason}") from exc

    encoded = base64.b64encode(b"".join(chunks)).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def fetch_image_bytes(url: str) -> tuple[bytes, str]:
    parsed = urllib.parse.urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImageFetchError("图片 URL 格式不正确")
    if parsed.username or parsed.password:
        raise ImageFetchError("图片 URL 不允许包含账号密码")
    if not is_public_hostname(parsed.hostname):
        raise ImageFetchError("图片 URL 不是可公开访问地址")

    request = urllib.request.Request(
        urllib.parse.urlunparse(parsed),
        headers={
            "Accept": "image/*,*/*;q=0.8",
            "User-Agent": "GPT-Image-Tools/1.0",
        },
    )
    with open_url(request, timeout=REQUEST_TIMEOUT) as response:
        content_type = response.headers.get("Content-Type", "image/png").split(";")[0].strip()
        if not content_type.startswith("image/"):
            raise ImageFetchError("返回内容不是图片")

        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_IMAGE_BODY:
                raise ImageFetchError("图片过大，无法缓存到服务器")
            chunks.append(chunk)
    return b"".join(chunks), content_type


def cache_openai_image_response(task_id: str, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    cached = dict(body)
    cached_data: list[dict[str, Any]] = []
    cache_bytes = 0

    for index, item in enumerate(body.get("data") or []):
        if not isinstance(item, dict):
            continue

        next_item = dict(item)
        try:
            if item.get("b64_json"):
                raw = base64.b64decode(str(item["b64_json"]), validate=True)
                filename = f"image-{index + 1}.png"
                write_task_file(task_id, filename, raw)
                cache_bytes += len(raw)
                next_item.pop("b64_json", None)
                next_item["url"] = cache_public_url(task_id, filename)
            elif item.get("url"):
                raw, content_type = fetch_image_bytes(str(item["url"]))
                filename = f"image-{index + 1}{guess_extension(content_type)}"
                write_task_file(task_id, filename, raw)
                cache_bytes += len(raw)
                next_item["url"] = cache_public_url(task_id, filename)
        except (binascii.Error, ImageFetchError, urllib.error.URLError, ValueError) as exc:
            write_log(
                "WARN",
                "image_cache_miss",
                "生成结果已返回，但服务器缓存其中一张图片失败",
                task_id,
                {"index": index, "error": str(exc)},
            )
        cached_data.append(next_item)

    cached["data"] = cached_data
    result_bytes = json.dumps(cached, ensure_ascii=False).encode("utf-8")
    cache_bytes += len(result_bytes)
    return cached, cache_bytes


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


def create_generation_task(
    base_url: str,
    upstream_path: str,
    content_type: str,
    body: bytes,
) -> str:
    task_id = uuid.uuid4().hex
    metadata = parse_generation_metadata(content_type, body)
    timestamp = now_ts()
    with DB_LOCK, connect_db() as conn:
        conn.execute(
            """
            INSERT INTO generation_tasks (
                id, status, created_at, updated_at, base_url, upstream_path,
                request_content_type, request_size, model, prompt
            )
            VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                timestamp,
                timestamp,
                base_url,
                upstream_path,
                content_type,
                len(body),
                metadata["model"],
                metadata["prompt"],
            ),
        )
        conn.commit()
    write_log(
        "INFO",
        "task_created",
        "生图任务已投递到服务器后台",
        task_id,
        {
            "upstream_path": upstream_path,
            "request_size": len(body),
            "model": metadata["model"],
            "image_count": metadata.get("image_count"),
            "image_bytes": metadata.get("image_bytes"),
            "image_fields": metadata.get("image_fields"),
            "field_names": metadata.get("field_names"),
            "size": metadata.get("size"),
            "quality": metadata.get("quality"),
            "count": metadata.get("count"),
            "response_format": metadata.get("response_format"),
            "input_fidelity": metadata.get("input_fidelity"),
        },
    )
    return task_id


def update_task_status(
    task_id: str,
    status: str,
    *,
    error: str | None = None,
    result: dict[str, Any] | None = None,
    cache_bytes: int | None = None,
    completed: bool = False,
) -> None:
    result_json = json.dumps(result, ensure_ascii=False) if result is not None else None
    timestamp = now_ts()
    with DB_LOCK, connect_db() as conn:
        conn.execute(
            """
            UPDATE generation_tasks
            SET status = ?,
                updated_at = ?,
                completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
                error = ?,
                result_json = COALESCE(?, result_json),
                cache_bytes = COALESCE(?, cache_bytes)
            WHERE id = ?
            """,
            (
                status,
                timestamp,
                1 if completed else 0,
                timestamp,
                error,
                result_json,
                cache_bytes,
                task_id,
            ),
        )
        conn.commit()


def read_task(task_id: str) -> dict[str, Any] | None:
    with DB_LOCK, connect_db() as conn:
        row = conn.execute(
            """
            SELECT id, status, created_at, updated_at, completed_at, model, prompt,
                   error, result_json, cache_bytes
            FROM generation_tasks
            WHERE id = ?
            """,
            (task_id,),
        ).fetchone()
    if row is None:
        return None

    result = None
    if row["result_json"]:
        try:
            result = json.loads(str(row["result_json"]))
        except json.JSONDecodeError:
            result = None
    return {
        "id": row["id"],
        "status": row["status"],
        "createdAt": int(float(row["created_at"]) * 1000),
        "updatedAt": int(float(row["updated_at"]) * 1000),
        "completedAt": int(float(row["completed_at"]) * 1000) if row["completed_at"] else None,
        "model": row["model"],
        "prompt": row["prompt"],
        "error": row["error"],
        "result": result,
        "cacheBytes": row["cache_bytes"],
    }


def run_generation_task(
    task_id: str,
    base_url: str,
    upstream_path: str,
    auth_header: str,
    content_type: str,
    body: bytes,
) -> None:
    update_task_status(task_id, "running")
    write_log("INFO", "task_running", "生图任务开始请求上游", task_id)
    request = urllib.request.Request(
        f"{base_url}{upstream_path}",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": auth_header,
            "Content-Type": content_type,
            "User-Agent": "GPT-Image-Tools/1.0",
        },
    )

    try:
        try:
            with open_url(request, timeout=IMAGE_REQUEST_TIMEOUT) as response:
                response_body = response.read()
                status = response.status
        except urllib.error.HTTPError as exc:
            response_body = exc.read()
            status = exc.code

        if status < 200 or status >= 300:
            message = response_body.decode("utf-8", errors="replace")[:1000]
            raise ImageTaskError(f"上游生图失败：HTTP {status} {message}")

        try:
            upstream_result = json.loads(response_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ImageTaskError("上游返回了无法解析的 JSON") from exc

        cached_result, cache_bytes = cache_openai_image_response(task_id, upstream_result)
        update_task_status(
            task_id,
            "completed",
            result=cached_result,
            cache_bytes=cache_bytes,
            completed=True,
        )
        write_log(
            "INFO",
            "task_completed",
            "生图任务已完成并写入服务器临时缓存",
            task_id,
            {"cache_bytes": cache_bytes},
        )
        evict_cache_if_needed(skip_task_id=task_id)
    except (TimeoutError, socket.timeout):
        message = (
            f"上游生图请求超过 {IMAGE_REQUEST_TIMEOUT} 秒仍未返回，"
            "请稍后重试或调大 IMAGE_TOOLS_IMAGE_REQUEST_TIMEOUT"
        )
        update_task_status(task_id, "failed", error=message, completed=True)
        write_log("ERROR", "task_failed", message, task_id)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            message = (
                f"上游生图请求超过 {IMAGE_REQUEST_TIMEOUT} 秒仍未返回，"
                "请稍后重试或调大 IMAGE_TOOLS_IMAGE_REQUEST_TIMEOUT"
            )
        else:
            message = f"无法连接中转站：{exc.reason}"
        update_task_status(task_id, "failed", error=message, completed=True)
        write_log("ERROR", "task_failed", message, task_id)
    except Exception as exc:
        message = str(exc) or "后台生图任务失败"
        update_task_status(task_id, "failed", error=message, completed=True)
        write_log(
            "ERROR",
            "task_failed",
            message,
            task_id,
            traceback.format_exc(limit=8),
        )


def start_generation_worker(
    task_id: str,
    base_url: str,
    upstream_path: str,
    auth_header: str,
    content_type: str,
    body: bytes,
) -> None:
    thread = threading.Thread(
        target=run_generation_task,
        args=(task_id, base_url, upstream_path, auth_header, content_type, body),
        name=f"image-task-{task_id[:8]}",
        daemon=True,
    )
    thread.start()


def task_response_payload(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "success": True,
        "data": {
            "taskId": task["id"],
            "status": task["status"],
            "createdAt": task["createdAt"],
            "updatedAt": task["updatedAt"],
            "completedAt": task["completedAt"],
            "error": task["error"],
            "result": task["result"],
            "pollAfterMs": int(TASK_POLL_SECONDS * 1000),
        },
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
        if parsed_path.path == "/api/style-library":
            self.handle_style_library()
            return
        if parsed_path.path.startswith("/api/style-library/images/"):
            self.handle_style_image(parsed_path)
            return
        if parsed_path.path.startswith("/api/openai/tasks/"):
            self.handle_openai_task_status(parsed_path)
            return
        if parsed_path.path.startswith("/api/image-cache/"):
            self.handle_cache_file(parsed_path)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path in OPENAI_IMAGE_PROXY_PATHS:
            self.handle_openai_image_proxy(parsed_path)
            return

        if parsed_path.path == "/api/image-url-to-data-url":
            self.handle_image_url_to_data_url()
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

    def handle_image_url_to_data_url(self) -> None:
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
            data_url = fetch_image_as_data_url(str(payload.get("url") or ""))
            json_response(
                self,
                HTTPStatus.OK,
                {"success": True, "message": "", "dataUrl": data_url},
            )
        except ImageFetchError as exc:
            json_response(self, HTTPStatus.OK, {"success": False, "message": str(exc)})
        except Exception:
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"success": False, "message": "下载生成图片失败，请稍后重试"},
            )

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

    def handle_openai_task_status(self, parsed_path: urllib.parse.ParseResult) -> None:
        task_id = parsed_path.path.removeprefix("/api/openai/tasks/").strip("/")
        if not task_id:
            json_response(self, HTTPStatus.BAD_REQUEST, {"success": False, "message": "缺少任务 ID"})
            return

        task = read_task(task_id)
        if task is None:
            json_response(self, HTTPStatus.NOT_FOUND, {"success": False, "message": "任务不存在"})
            return

        json_response(self, HTTPStatus.OK, task_response_payload(task))

    def handle_cache_file(self, parsed_path: urllib.parse.ParseResult) -> None:
        prefix = "/api/image-cache/"
        relative = parsed_path.path[len(prefix):]
        parts = [urllib.parse.unquote(part) for part in relative.split("/") if part]
        if len(parts) != 2:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        task_id, filename = parts
        task = read_task(task_id)
        if task is None or task["status"] != "completed":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        path = safe_cache_path(task_id, filename)
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Cache-Control", "private, max-age=300")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_openai_image_proxy(self, parsed_path: urllib.parse.ParseResult) -> None:
        try:
            query = urllib.parse.parse_qs(parsed_path.query)
            base_url = normalize_public_base_url((query.get("base_url") or [""])[0])
            upstream_path = OPENAI_IMAGE_PROXY_PATHS[parsed_path.path]
            auth_header = self.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                raise OpenAIProxyError("缺少 API Key")

            try:
                body_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                body_length = 0
            if body_length <= 0 or body_length > MAX_PROXY_BODY:
                raise OpenAIProxyError("请求体为空或过大")

            body = self.rfile.read(body_length)
            content_type = self.headers.get("Content-Type", "application/json")
            task_id = create_generation_task(base_url, upstream_path, content_type, body)
            start_generation_worker(task_id, base_url, upstream_path, auth_header, content_type, body)
            task = read_task(task_id)
            if task is None:
                raise OpenAIProxyError("任务创建成功，但读取任务状态失败")
            json_response(self, HTTPStatus.ACCEPTED, task_response_payload(task))
        except OpenAIProxyError as exc:
            json_response(
                self,
                HTTPStatus.BAD_GATEWAY,
                {"error": {"message": str(exc)}},
            )
        except Exception:
            json_response(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": {"message": "转发生图请求失败，请稍后重试"}},
            )

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
    recover_incomplete_tasks()
    evict_cache_if_needed()
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
