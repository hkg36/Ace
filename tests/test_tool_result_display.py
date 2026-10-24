"""tool_result_detail_for_ui：终端等结构化工具结果的 UI 预览提取。"""

import json

import pytest

from crew.agent.loop.tool_result_display import tool_result_detail_for_ui
from crew.core.types import Message, ToolCall
from crew.gateway.routers.sessions import _session_messages_to_history_items


def test_terminal_detail_prefers_output_over_json_metadata():
  payload = (
      '{"success": true, "cwd": "C:\\\\work", "command": "python search.py", '
      '"exit_code": 0, "output": "line1\\nline2\\n世界杯赛程"}'
  )
  assert tool_result_detail_for_ui("terminal", payload) == "line1\nline2\n世界杯赛程"


def test_terminal_detail_keeps_tail_when_output_is_long():
  tail = "x" * 50
  output = ("a" * 2000) + tail
  import json

  payload = json.dumps({"success": True, "output": output}, ensure_ascii=False)
  detail = tool_result_detail_for_ui("terminal", payload, max_len=1200)
  assert detail.endswith(tail)
  assert len(detail) == 1200


def test_terminal_detail_falls_back_to_error():
  payload = '{"success": false, "error": "command blocked"}'
  assert tool_result_detail_for_ui("terminal", payload) == "command blocked"


def test_non_terminal_json_prefers_output_field():
  payload = '{"output": "hello", "meta": 1}'
  assert tool_result_detail_for_ui("web_search", payload) == "hello"


def test_plain_text_is_clipped():
  text = "z" * 3000
  assert len(tool_result_detail_for_ui("file_read", text, max_len=100)) == 100


def test_subagent_result_returns_full_json_without_clipping():
  """delegate_task/run_agent：前端 subagent 卡片需要完整 results JSON，不截断。"""
  import json

  payload = json.dumps(
      {
          "results": [
              {
                  "agent": f"task#{i}",
                  "status": "completed",
                  "summary": "摘要" * 500,  # 单条 1000 字，整体远超 1200
                  "duration_seconds": 5.38,
                  "tool_calls": 1,
              }
              for i in range(3)
          ]
      },
      ensure_ascii=False,
  )
  assert len(payload) > 1200
  for name in ("delegate_task", "run_agent"):
      detail = tool_result_detail_for_ui(name, payload)
      assert detail == payload
      # 可解析：前端 JSON.parse 的前提
      assert json.loads(detail)["results"][0]["tool_calls"] == 1


def test_subagent_result_paired_in_history_replay():
  """builtin executor 的 ToolCall.result 为空，历史回放须从 tool 消息配对完整 JSON。"""
  import json

  from crew.core.types import ToolCall
  from crew.gateway.routers.sessions import _tool_result_for_history

  payload = json.dumps(
      {"results": [{"agent": "task#0", "status": "completed", "summary": " done " * 400,
                    "duration_seconds": 3, "tool_calls": 2}]},
      ensure_ascii=False,
  )
  tc = ToolCall(id="tc-1", name="delegate_task", arguments={"tasks": [{"goal": "g"}]})
  assert _tool_result_for_history(tc, {"tc-1": payload}) == payload
  # 普通工具同样恢复结果，但保留实时展示的预览长度限制。
  other = ToolCall(id="tc-2", name="file_read", arguments={})
  assert _tool_result_for_history(other, {"tc-2": "x" * 5000}) == "x" * 1200


@pytest.mark.parametrize(
    ("name", "payload", "expected"),
    [
        ("file_read", "file contents", "file contents"),
        ("file_read", "x" * 5000, "x" * 1200),
        ("web_search", '{"content": "search results", "meta": 1}', "search results"),
        ("terminal", '{"success": true, "output": "line1\\nline2"}', "line1\nline2"),
        ("terminal", json.dumps({"output": "a" * 2000 + "tail"}), "a" * 1196 + "tail"),
        ("terminal", '{"success": false, "error": "command blocked"}', "command blocked"),
        ("terminal", '{"success": false, "exit_code": 2}', "terminal exited with code 2"),
        ("file_read", "", ""),
    ],
    ids=["plain", "clipped", "structured", "stdout", "stdout-tail", "error", "exit-code", "empty"],
)
def test_history_restores_paired_tool_result_preview(name, payload, expected):
    call = ToolCall(id="call-1", name=name, arguments={}, status="done")
    items = _session_messages_to_history_items([
        Message(role="assistant", content="", tool_calls=[call]),
        Message(role="tool", content=payload, tool_call_id=call.id),
        Message(role="assistant", content="finished"),
    ])

    assert [item["role"] for item in items] == ["assistant", "assistant"]
    assert items[0]["tool_calls"][0]["result"] == expected
    assert items[0]["tool_calls"][0]["status"] == "done"


def test_history_pairs_results_by_call_id_and_preserves_persisted_results():
    calls = [
        ToolCall(id="call-1", name="file_read", arguments={}),
        ToolCall(id="call-2", name="file_read", arguments={}, result="saved preview"),
        ToolCall(id="call-3", name="file_read", arguments={}),
    ]
    items = _session_messages_to_history_items([
        Message(role="assistant", content="", tool_calls=calls),
        Message(role="tool", content="second result", tool_call_id="call-2"),
        Message(role="tool", content="first result", tool_call_id="call-1"),
        Message(role="tool", content="unrelated result", tool_call_id="other"),
    ])

    assert [call["result"] for call in items[0]["tool_calls"]] == [
        "first result", "saved preview", "",
    ]


def test_inspiration_surface_survives_live_detail_and_history_replay():
  import json

  from crew.core.types import ToolCall
  from crew.gateway.routers.sessions import _tool_result_for_history

  surface = {
      "kind": "inspiration", "mode": "widget", "sessionId": "session-1",
      "widgetId": "widget_123456789abc", "title": "行情", "status": "preparing",
  }
  payload = json.dumps({"ok": True, "data": {"large": "x" * 3000}, "surface": surface})
  detail = tool_result_detail_for_ui("Widget", payload)
  assert json.loads(detail) == {"ok": True, "surface": surface}
  tc = ToolCall(id="show-1", name="Widget", arguments={"action": "show", "widgetId": surface["widgetId"]})
  assert json.loads(_tool_result_for_history(tc, {"show-1": payload})) == {"ok": True, "surface": surface}

  site_surface = {
      "kind": "inspiration", "mode": "site", "sessionId": "session-1",
      "inspirationId": "site_123456789abc", "siteId": "site_123456789abc",
      "title": "应用", "status": "ready",
  }
  site_payload = json.dumps({"ok": True, "site_id": site_surface["siteId"], "surface": site_surface})
  site_call = ToolCall(id="publish-1", name="publish_site", arguments={"name": "应用"})
  assert json.loads(_tool_result_for_history(site_call, {"publish-1": site_payload})) == {
      "ok": True, "surface": site_surface,
  }
