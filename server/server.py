#!/usr/bin/env python3
from __future__ import annotations

import http.cookiejar
import json
import logging
import os
import posixpath
import re
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
IMAGE_GROUP = "gpt-image-2 生图低价"
IMAGE_MODEL = "gpt-image-2"
IMAGE_TOKEN_NAME = "GPT Image Tools - gpt-image-2"
CODEX_GROUP = "codex 满血高速"
CODEX_MODEL = "gpt-5.5"
CODEX_TOKEN_NAME = "GPT Image Tools - codex"
MAX_JSON_BODY = 16 * 1024
TOKEN_LIST_PAGE_SIZE = 100
TOKEN_LIST_MAX_PAGES = 50
REQUEST_TIMEOUT = env_int("IMAGE_TOOLS_REQUEST_TIMEOUT", 25)
LOG_MAX_ROWS = env_int("IMAGE_TOOLS_LOG_MAX_ROWS", 5000)
DB_MAX_BYTES = env_int("IMAGE_TOOLS_DB_MAX_BYTES", 64 * 1024 * 1024)
DEFAULT_LOCAL_PROXY = "http://127.0.0.1:7897"
DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1"
DEFAULT_LOCAL_PROXY_PORT = 7897
DATA_DIR = Path(os.environ.get("IMAGE_TOOLS_DATA_DIR", "server-data")).resolve()
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
                    "features": ["newapi-login-key"],
                },
            )
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
