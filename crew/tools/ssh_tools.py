"""SSH tools backed by the authenticated desktop host; credentials stay in Electron."""

from __future__ import annotations

import hashlib
from functools import partial
from typing import Any

from crew.browser.electron_bridge import ElectronBridgeError, electron_browser_bridge
from crew.core.errors import ToolError
from crew.core.runctx import current_owner_account_id
from crew.tools.registry import Registry, tool_error, tool_result


SSH_SCHEMAS: dict[str, dict[str, Any]] = {}
for _name, _description, _fields in (
    ("ssh_list", "列出已配置的 SSH 服务器，只返回 id 和 name，不包含连接信息或凭据。", ()),
    (
        "ssh_connent",
        "使用已保存的配置 id 连接 SSH 服务器，返回句柄字符串 profileId。"
        "空闲 10 分钟后关闭连接；失效后必须重新调用本工具获取新句柄。",
        ("id",),
    ),
    (
        "ssh_exec",
        "在 SSH 服务器执行命令，返回 exitCode、stdout、stderr。"
        "超时 60 秒，输出合计最多 1 MiB；结果不确定时不要盲目重试可能产生副作用的命令。",
        ("profileId", "command"),
    ),
    (
        "ssh_read_file",
        "通过 SFTP 读取远端 UTF-8 文件，返回 content，最多 1 MiB。",
        ("profileId", "path"),
    ),
    (
        "ssh_write_file",
        "通过 SFTP 创建或覆盖远端 UTF-8 文件，返回 ok，最多 1 MiB；父目录必须存在。",
        ("profileId", "path", "content"),
    ),
):
    SSH_SCHEMAS[_name] = {
        "name": _name,
        "description": _description,
        "parameters": {
            "type": "object",
            "properties": {
                field: {"type": "string", **({} if field == "content" else {"minLength": 1})}
                for field in _fields
            },
            "required": list(_fields),
            "additionalProperties": False,
        },
    }


async def handle_ssh(method: str, args: dict[str, Any]) -> str:
    owner_id = current_owner_account_id.get().strip()
    if not owner_id:
        raise ToolError("SSH requires an authenticated desktop account")
    runtime_key = f"crew_{hashlib.sha256(owner_id.encode('utf-8')).hexdigest()[:12]}"
    if not electron_browser_bridge.connected(runtime_key):
        raise ToolError("SSH desktop host is not connected; open the desktop app and stay logged in")
    try:
        response = await electron_browser_bridge.request(
            runtime_key,
            method,
            args,
            timeout=65,
            mutating=method in {"ssh_connent", "ssh_exec", "ssh_write_file"},
        )
        return tool_result(response)
    except ElectronBridgeError as exc:
        raise ToolError(
            tool_error(
                str(exc),
                uncertain=exc.uncertain,
                reconnect_required=exc.stop_unconfirmed,
            )
        ) from exc


def register_ssh_tools(registry: Registry) -> None:
    for name, schema in SSH_SCHEMAS.items():
        registry.register(
            name=name,
            toolset="ssh",
            schema=schema,
            handler=partial(handle_ssh, name),
            is_async=True,
            search_hint="ssh remote server connect command exec sftp read write file",
        )
