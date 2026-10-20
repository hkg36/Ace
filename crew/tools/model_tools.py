"""Lightweight tools for making one text-only request to a configured model."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

from crew.core.errors import ToolError
from crew.core.interfaces import LLMProvider
from crew.core.runctx import current_owner_account_id
from crew.core.types import Message
from crew.state.config import ModelProfile
from crew.tools.registry import Registry, tool_result

ASK_MODEL_SCHEMA = {
    "name": "ask_model",
    "description": (
        "向指定模型发送一次独立的纯文本请求并返回回复。不会创建子智能体、不会使用工具、"
        "也不会继承或写入对话历史。先用 list_models 查询可用模型 ID。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "model": {
                "type": "string",
                "description": "list_models 返回的模型 ID",
            },
            "prompt": {
                "type": "string",
                "description": "发送给该模型的完整独立提示词",
            },
        },
        "required": ["model", "prompt"],
    },
}

LIST_MODELS_SCHEMA = {
    "name": "list_models",
    "description": (
        "列出当前账户可调用的模型 ID 及其 capabilities。"
        "仅返回这两项，不包含密钥、端点或其他模型配置。"
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}


def _callable_profiles(profiles: dict[str, ModelProfile]) -> dict[str, ModelProfile]:
    """Return profiles that can safely service a text request."""
    return {
        model_id: profile
        for model_id, profile in profiles.items()
        if profile.loaded and profile.has_key
    }


async def _close_provider(provider: LLMProvider) -> None:
    close = getattr(provider, "aclose", None)
    if not callable(close):
        return
    result = close()
    if inspect.isawaitable(result):
        await result


def register_model_tools(
    registry: Registry,
    *,
    profiles_for_owner: Callable[[str], dict[str, ModelProfile]],
    provider_factory: Callable[[ModelProfile], LLMProvider],
) -> None:
    """Register a no-loop model request tool and a minimal model catalog tool."""

    def _profiles() -> dict[str, ModelProfile]:
        return _callable_profiles(profiles_for_owner(current_owner_account_id.get() or ""))

    async def handle_list_models(_args: dict[str, Any]) -> str:
        return tool_result(
            [
                {
                    "id": model_id,
                    "capabilities": list(profile.capabilities),
                }
                for model_id, profile in sorted(_profiles().items())
            ]
        )

    async def handle_ask_model(args: dict[str, Any]) -> str:
        model_id = str(args.get("model") or "").strip()
        prompt = str(args.get("prompt") or "").strip()
        if not model_id:
            raise ToolError("model 不能为空")
        if not prompt:
            raise ToolError("prompt 不能为空")

        profile = _profiles().get(model_id)
        if profile is None:
            raise ToolError(f"模型不可用: {model_id}。请先调用 list_models 查询可用模型。")
        capabilities = {str(item).strip().lower() for item in profile.capabilities}
        if "text" not in capabilities:
            raise ToolError(f"模型 {model_id} 不支持文本请求")

        provider = provider_factory(profile)
        try:
            messages: list[Message] = []
            if profile.system_prompt.strip():
                messages.append(Message.system(profile.system_prompt))
            messages.append(Message.user(prompt))
            response = await provider.chat(messages, tools=None)
        finally:
            await _close_provider(provider)
        return tool_result({"model": model_id, "output": response.text})

    registry.register(
        name="ask_model",
        toolset="model",
        schema=ASK_MODEL_SCHEMA,
        handler=handle_ask_model,
        is_async=True,
        display_name="询问模型",
        ui_label_template="询问模型 {model}",
        should_defer=True,
        search_hint="ask another model one-shot single prompt no tools",
    )
    registry.register(
        name="list_models",
        toolset="model",
        schema=LIST_MODELS_SCHEMA,
        handler=handle_list_models,
        is_async=True,
        display_name="列出模型",
        ui_label_template="列出可用模型",
        should_defer=True,
        search_hint="list model ids capabilities choose another model",
    )
