import hashlib
import json
from unittest.mock import AsyncMock

import pytest

from crew.browser.electron_bridge import ElectronBridgeError
from crew.core.runctx import current_owner_account_id
from crew.core.types import ToolCall
from crew.state.access_control import AccessControlConfig
from crew.tools.registry import Registry, register_builtin_tools
from crew.tools.ssh_tools import SSH_SCHEMAS, register_ssh_tools


@pytest.fixture
def ssh_registry(monkeypatch):
    registry = Registry()
    register_ssh_tools(registry)
    request = AsyncMock()
    monkeypatch.setattr("crew.tools.ssh_tools.electron_browser_bridge.request", request)
    monkeypatch.setattr("crew.tools.ssh_tools.electron_browser_bridge.connected", lambda key: True)
    token = current_owner_account_id.set("local:owner")
    yield registry, request
    current_owner_account_id.reset(token)


@pytest.mark.parametrize(
    ("name", "args", "response", "mutating"),
    [
        ("ssh_list", {}, [{"id": "one", "name": "One"}], False),
        ("ssh_connent", {"id": "one"}, "opaque-handle", True),
        ("ssh_exec", {"profileId": "h", "command": "false"},
         {"exitCode": 1, "stdout": "", "stderr": "failed"}, True),
        ("ssh_read_file", {"profileId": "h", "path": "/a"}, {"content": "hello"}, False),
        ("ssh_write_file", {"profileId": "h", "path": "/a", "content": ""}, {"ok": True}, True),
    ],
)
async def test_ssh_dispatch_and_output(ssh_registry, name, args, response, mutating):
    registry, request = ssh_registry
    request.return_value = response
    result = await registry.execute(ToolCall("c", name, args))
    assert not result.is_error
    assert json.loads(result.content) == response
    key = "crew_" + hashlib.sha256(b"local:owner").hexdigest()[:12]
    request.assert_awaited_once_with(key, name, args, timeout=65, mutating=mutating)


async def test_invalid_arguments_never_reach_host(ssh_registry):
    registry, request = ssh_registry
    for args in ({}, {"profileId": "h"}, {"profileId": 1, "command": "pwd"},
                 {"profileId": "h", "command": "pwd", "host": "arbitrary"}):
        result = await registry.execute(ToolCall("c", "ssh_exec", args))
        assert result.is_error
    request.assert_not_awaited()


async def test_ssh_requires_owner_and_connected_desktop(ssh_registry, monkeypatch):
    registry, request = ssh_registry
    token = current_owner_account_id.set("")
    try:
        result = await registry.execute(ToolCall("c", "ssh_list", {}))
        assert result.is_error
    finally:
        current_owner_account_id.reset(token)
    monkeypatch.setattr("crew.tools.ssh_tools.electron_browser_bridge.connected", lambda key: False)
    result = await registry.execute(ToolCall("c", "ssh_list", {}))
    assert result.is_error
    assert "not connected" in result.content
    request.assert_not_awaited()


async def test_remote_errors_are_errors_and_preserve_uncertainty(ssh_registry):
    registry, request = ssh_registry
    request.side_effect = ElectronBridgeError("connection lost", uncertain=True, stop_unconfirmed=True)
    result = await registry.execute(
        ToolCall("c", "ssh_exec", {"profileId": "h", "command": "touch /a"})
    )
    assert result.is_error
    payload = json.loads(result.content[result.content.index("{"):])
    assert payload["uncertain"] is True
    assert payload["reconnect_required"] is True


def test_ssh_is_registered_as_builtin():
    registry = Registry()
    register_builtin_tools(registry)
    for name in SSH_SCHEMAS:
        assert registry.get(name).toolset == "ssh"


@pytest.mark.parametrize("enabled", [None, ["*"], ["browser"]])
def test_external_requires_explicit_ssh_optin(enabled):
    config = AccessControlConfig(external={"enabled_toolsets": enabled})
    assert "ssh" in config.resolve_for("external")["disabled_toolsets"]


def test_explicit_ssh_optin_still_respects_disabled_tools():
    registry = Registry()
    register_ssh_tools(registry)
    policy = AccessControlConfig(external={
        "enabled_toolsets": ["ssh"], "disabled_tools": ["ssh_exec"],
    }).resolve_for("external")
    schemas = registry.list_schemas(
        enabled_toolsets=policy["enabled_toolsets"],
        disabled_toolsets=policy["disabled_toolsets"],
        disabled_tools=policy["disabled_tools"],
    )
    names = {schema["function"]["name"] for schema in schemas}
    assert names == set(SSH_SCHEMAS) - {"ssh_exec"}
