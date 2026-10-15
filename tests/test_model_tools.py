"""Tests for lightweight, single-request model tools."""

from __future__ import annotations

import json

import pytest

from crew.app import build_app
from crew.core.mocks import FakeProvider
from crew.core.runctx import current_owner_account_id
from crew.core.types import ChatResponse, ToolCall
from crew.state.config import Config, ModelProfile
from crew.tools.model_tools import register_model_tools
from crew.tools.registry import Registry


def _register(profiles: dict[str, ModelProfile], provider: FakeProvider) -> Registry:
    registry = Registry()
    register_model_tools(
        registry,
        profiles_for_owner=lambda _owner: profiles,
        provider_factory=lambda _profile: provider,
    )
    return registry


def test_build_app_registers_model_tools(tmp_path):
    config = Config(max_iterations=1)
    config.db_path = str(tmp_path / "crew.db")
    config.memory_db_path = str(tmp_path / "memory.db")
    config.crew_home = str(tmp_path / ".crew")

    app = build_app(config=config, enable_team=False)

    assert {"ask_model", "list_models"} <= set(app.registry.names())


async def test_list_models_returns_only_ids_and_capabilities():
    registry = _register(
        {
            "human": ModelProfile(
                id="human",
                api_key="key",
                capabilities=["text", "vision"],
            ),
            "default": ModelProfile(id="default", capabilities=[]),
            "disabled": ModelProfile(id="disabled", api_key="key", loaded=False),
        },
        FakeProvider(),
    )

    result = await registry.execute(ToolCall("list", "list_models", {}))

    assert not result.is_error
    assert json.loads(result.content) == [
        {"id": "human", "capabilities": ["text", "vision"]},
    ]


async def test_ask_model_makes_one_text_only_request():
    provider = FakeProvider(script=[ChatResponse(text="更自然的回复")])
    registry = _register(
        {"human": ModelProfile(id="human", api_key="key", capabilities=["text"])},
        provider,
    )
    token = current_owner_account_id.set("owner-1")
    try:
        result = await registry.execute(
            ToolCall("ask", "ask_model", {"model": "human", "prompt": "请更拟人化地回复"})
        )
    finally:
        current_owner_account_id.reset(token)

    assert not result.is_error
    assert json.loads(result.content) == {
        "model": "human",
        "output": "更自然的回复",
    }
    assert len(provider.calls) == 1
    assert provider.calls[0][0].content == "请更拟人化地回复"


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({"model": "missing", "prompt": "hello"}, "模型不可用"),
        ({"model": "human", "prompt": ""}, "prompt 不能为空"),
    ],
)
async def test_ask_model_reports_invalid_requests(arguments, message):
    registry = _register(
        {"human": ModelProfile(id="human", api_key="key", capabilities=["text"])},
        FakeProvider(),
    )

    result = await registry.execute(ToolCall("ask", "ask_model", arguments))

    assert result.is_error
    assert message in result.content
