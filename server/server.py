#!/usr/bin/env python3
from __future__ import annotations

import http.cookiejar
import base64
import ipaddress
import json
import os
import posixpath
import socket
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://cc.api-corp.top"
ALLOWED_NEW_API_HOST = "cc.api-corp.top"
IMAGE_GROUP = "gpt-image-2 生图低价"
IMAGE_MODEL = "gpt-image-2"
IMAGE_TOKEN_NAME = "GPT Image Tools - gpt-image-2"
CODEX_GROUP = "codex 满血高速"
CODEX_MODEL = "gpt-5.5"
CODEX_TOKEN_NAME = "GPT Image Tools - codex"
MAX_JSON_BODY = 16 * 1024
MAX_IMAGE_BODY = 32 * 1024 * 1024
MAX_PROXY_BODY = 96 * 1024 * 1024
REQUEST_TIMEOUT = 25
IMAGE_REQUEST_TIMEOUT = 180
OPENAI_IMAGE_PROXY_PATHS = {
    "/api/openai/v1/images/generations": "/v1/images/generations",
    "/api/openai/v1/images/edits": "/v1/images/edits",
}


class NewApiError(Exception):
    pass


class ImageFetchError(Exception):
    pass


class OpenAIProxyError(Exception):
    pass


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
        raise NewApiError("当前只允许登录 https://cc.api-corp.top/")
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
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
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


class NewApiSession:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
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
        response = self.request("GET", "/api/token/?p=1&size=100")
        if not response.get("success"):
            raise NewApiError(str(response.get("message") or "获取秘钥列表失败"))

        data = response.get("data") or {}
        items = data.get("items") or []
        if not isinstance(items, list):
            return []
        return [item for item in items if isinstance(item, dict)]

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
            raise NewApiError(str(response.get("message") or "创建秘钥失败"))

        token = self.find_target_token(group, model)
        if token is None:
            raise NewApiError(f"{group} 秘钥已创建，但重新查询时没有找到")
        return token

    def get_full_key(self, token_id: int) -> str:
        response = self.request("POST", f"/api/token/{token_id}/key")
        if not response.get("success"):
            raise NewApiError(str(response.get("message") or "获取完整秘钥失败"))

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
            "apiKey": self.get_full_key(token_id),
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


class ImageToolsHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

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
            headers = {
                "Accept": "application/json",
                "Authorization": auth_header,
                "Content-Type": self.headers.get("Content-Type", "application/json"),
                "User-Agent": "GPT-Image-Tools/1.0",
            }
            request = urllib.request.Request(
                f"{base_url}{upstream_path}",
                data=body,
                method="POST",
                headers=headers,
            )

            try:
                with urllib.request.urlopen(request, timeout=IMAGE_REQUEST_TIMEOUT) as response:
                    response_body = response.read()
                    status = response.status
                    content_type = response.headers.get(
                        "Content-Type", "application/json; charset=utf-8"
                    )
            except urllib.error.HTTPError as exc:
                response_body = exc.read()
                status = exc.code
                content_type = exc.headers.get("Content-Type", "application/json; charset=utf-8")
            except urllib.error.URLError as exc:
                raise OpenAIProxyError(f"无法连接中转站：{exc.reason}") from exc

            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
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
