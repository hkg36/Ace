"""Persistent suffix deletion, replay, account isolation, and turn fencing."""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from crew.app import build_app
from crew.core.types import Message
from crew.gateway.server import create_app
from crew.state.config import Config
from crew.agent.compact.store import SummaryState

OWNER = "A:uid-a"


def history():
    return [
        Message(role="user", content="keep", timestamp=10),
        Message(role="assistant", content="answer", timestamp=11),
        Message(role="user", content="discard", timestamp=20),
        Message(role="assistant", content="tool step", timestamp=21),
        Message(role="tool", content="result", timestamp=22, tool_call_id="tc"),
        Message(role="assistant", content="discarded answer", timestamp=23),
        Message(role="user", content="later", timestamp=30),
    ]


@pytest.mark.asyncio
async def test_truncate_persists_prefix_and_isolates_owner(tmp_path, auth_headers):
    crew = build_app(config=Config(
        db_path=str(tmp_path / "crew.db"), memory_db_path=str(tmp_path / "memory.db"), cron_enabled=False,
    ), enable_team=False)
    crew.session_store.save("s", history(), owner_account_id=OWNER)
    crew.session_store.save("s", history(), owner_account_id="other")
    crew.session_store.set_pinned("s", True, owner_account_id=OWNER)
    crew.session_store.set_title("s", "Custom title", owner_account_id=OWNER)
    crew.summary_store.put("s", SummaryState(text="discarded summary", covered_count=7), owner_account_id=OWNER)
    app = create_app(crew)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers=auth_headers) as client:
        response = await client.post("/api/session/s/history/truncate", json={
            "user_index": 1, "expected_user_count": 3,
        })
        assert response.status_code == 200, response.text
        assert [m.content for m in crew.session_store.load("s", owner_account_id=OWNER)] == ["keep", "answer"]
        replay = (await client.get("/api/session/s")).json()
        assert [m["content"] for m in replay] == ["keep", "answer"]
        assert len(crew.session_store.load("s", owner_account_id="other")) == 7
        row = crew.session_store.list_sessions(owner_account_id=OWNER)[0]
        assert row["title"] == "Custom title"
        assert row["pinned"] is True
        assert crew.summary_store.get("s", owner_account_id=OWNER) is None
        from crew.agent.runtime import SingleAgent
        from crew.core.envelope import Envelope
        from crew.core.mocks import FakeProvider, NullMemory
        from crew.plugins.manager import PluginManager
        from crew.tools.registry import Registry

        provider = FakeProvider()
        agent = SingleAgent(
            provider=provider, registry=Registry(), session_store=crew.session_store,
            memory=NullMemory(), plugins=PluginManager(),
        )
        chunks = [chunk async for chunk in agent.run(Envelope.of(
            "replacement", session_id="s", user_id=OWNER,
        ))]
        assert chunks[-1].kind == "final"
        model_history = [
            message.content for message in provider.calls[0]
            if not message.is_meta and message.role in {"user", "assistant"}
        ]
        assert model_history == ["keep", "answer", "replacement"]
        response = await client.post("/api/session/s/history/truncate", json={
            "user_index": 0, "expected_user_count": 2,
        })
        assert response.status_code == 200
        assert crew.session_store.session_belongs_to("s", OWNER)
        assert (await client.get("/api/session/s")).json() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("payload, status", [
    ({"user_index": -1, "expected_user_count": 3}, 422),
    ({"user_index": True, "expected_user_count": 3}, 422),
    ({"user_index": 3, "expected_user_count": 3}, 409),
    ({"user_index": 1, "expected_user_count": 2}, 409),
])
async def test_invalid_or_stale_truncation_preserves_history(tmp_path, auth_headers, payload, status):
    crew = build_app(config=Config(
        db_path=str(tmp_path / "crew.db"), memory_db_path=str(tmp_path / "memory.db"), cron_enabled=False,
    ), enable_team=False)
    crew.session_store.save("s", history(), owner_account_id=OWNER)
    async with AsyncClient(transport=ASGITransport(app=create_app(crew)), base_url="http://test", headers=auth_headers) as client:
        response = await client.post("/api/session/s/history/truncate", json=payload)
        assert response.status_code == status
        assert len(crew.session_store.load("s", owner_account_id=OWNER)) == 7
        missing = await client.post("/api/session/other/history/truncate", json={
            "user_index": 0, "expected_user_count": 1,
        })
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_truncate_removes_team_task_projection_and_child_history(tmp_path, auth_headers):
    crew = build_app(config=Config(
        db_path=str(tmp_path / "crew.db"), memory_db_path=str(tmp_path / "memory.db"), cron_enabled=False,
    ), enable_team=False)
    crew.session_store.save("team", [], owner_account_id=OWNER)
    crew.session_store.set_agent_config("team", {"executor": "team"}, owner_account_id=OWNER)
    tasks = []
    for prompt in ("keep", "discard"):
        task = crew.tasks.create_runtime(
            kind="agent_turn", session_id="team", title=prompt, detail=prompt, owner_account_id=OWNER,
        )
        crew.tasks.finish(task["task_id"], owner_account_id=OWNER, status="completed", result=f"{prompt} result")
        child_id = f"team::turn::{task['task_id']}::leader"
        crew.session_store.save(child_id, [
            Message(role="assistant", content=f"{prompt} child", timestamp=task["created_at"] + 0.00001),
        ], owner_account_id=OWNER)
        tasks.append(task)
    async with AsyncClient(transport=ASGITransport(app=create_app(crew)), base_url="http://test", headers=auth_headers) as client:
        response = await client.post("/api/session/team/history/truncate", json={
            "user_index": 1, "expected_user_count": 2,
        })
        assert response.status_code == 200, response.text
        replay = (await client.get("/api/session/team")).json()
        assert [m["content"] for m in replay if m["role"] == "user"] == ["keep"]
        assert all("discard" not in m["content"] for m in replay)
        assert len(crew.tasks.list_tasks(session_id="team", owner_account_id=OWNER)) == 1
        assert not crew.session_store.load(f"team::turn::{tasks[1]['task_id']}::leader", owner_account_id=OWNER)


@pytest.mark.asyncio
async def test_history_edit_waits_for_cancelled_writer_and_fences_new_turns():
    from crew.core.envelope import Envelope
    from crew.core.mocks import InMemorySessionStore
    from crew.gateway.dispatcher import SessionDispatcher

    dispatcher = SessionDispatcher(None, InMemorySessionStore())
    started = asyncio.Event()
    writes = []

    async def writer():
        started.set()
        try:
            await asyncio.sleep(60)
        finally:
            await asyncio.sleep(0)
            writes.append("old writer stopped")

    task = asyncio.create_task(writer())
    await started.wait()
    dispatcher._tasks[(OWNER, "s")] = {task}
    async with dispatcher.edit_history("s", OWNER):
        assert task.done()
        assert writes == ["old writer stopped"]
        chunks = [chunk async for chunk in dispatcher.run(Envelope.of(
            "blocked", session_id="s", user_id=OWNER,
        ))]
        assert len(chunks) == 1
        assert chunks[0].kind == "error"
    assert not dispatcher._history_edits
