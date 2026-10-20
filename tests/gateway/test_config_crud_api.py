"""模型 profile CRUD 端点集成测试。

完全隔离的 tmp 环境：
- 用 tmp_path 构造独立 config.yaml
- CREW_HOME / db_path 指向 tmp，避免污染真实 .crew/ 与 db
- 不调用全局 build_app() 默认 fixture，所有 app 实例都从 tmp 配置加载
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml
from httpx import ASGITransport, AsyncClient

from crew.app import build_app
from crew.core.types import Message, ToolCall
from crew.gateway.server import create_app
from crew.state.config import ModelProfile, load_config
from crew.state.home import owner_path_segment

OWNER_A = "A:uid-a"
OWNER_A_SAFE = owner_path_segment(OWNER_A)


def _owner_overlay_path(tmp_path: Path, owner: str = OWNER_A) -> Path:
    """owner overlay 落在 hash 派生目录 accounts/acct_*/config.yaml（非旧式 A_uid-a）。"""
    return tmp_path / ".crew" / "accounts" / owner_path_segment(owner) / "config.yaml"


def _bootstrap_tmp_env(tmp_path: Path) -> Path:
    """构造隔离的 config.yaml，包含 2 个 profile，并预置 env key。"""
    config_yaml = tmp_path / "config.yaml"
    data = {
        "llm": {
            "active": "alpha",
            "models": {
                "alpha": {
                    "name": "Alpha",
                    "api_key": "sk-alpha-xxx",
                    "api_key_env": "TEST_ALPHA_API_KEY",
                    "base_url": "https://alpha.example.com/v1",
                    "model": "alpha-1",
                },
            },
        },
        "runtime": {
            "db_path": str(tmp_path / "crew.db"),
            "log_level": "WARNING",
            "llm_trace": False,
        },
        "gateway": {"host": "127.0.0.1", "port": 8000, "admin_accounts": ["A:uid-a"]},
    }
    config_yaml.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    # CREW_HOME 指向 tmp，避免污染真实 .crew/
    os.environ["CREW_HOME"] = str(tmp_path / ".crew")
    owner_overlay = _owner_overlay_path(tmp_path)
    owner_overlay.parent.mkdir(parents=True, exist_ok=True)
    owner_overlay.write_text(
        yaml.safe_dump(
            {
                "llm": {
                    "active": "alpha",
                    "models": {
                        "beta": {
                            "name": "Beta",
                            "api_key": "sk-beta-xxx",
                            "api_key_env": "TEST_BETA_API_KEY",
                            "base_url": "https://beta.example.com/v1",
                            "model": "beta-1",
                            "loaded": False,
                            "builtin": True,
                        }
                    },
                }
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return config_yaml


@pytest.fixture
def api(tmp_path: Path):
    config_yaml = _bootstrap_tmp_env(tmp_path)
    cfg = load_config(config_path=str(config_yaml))
    crew = build_app(config=cfg, enable_team=False)
    app = create_app(crew)
    app.state.crew = crew
    yield app
    # 清理 env
    for var in ("TEST_ALPHA_API_KEY", "TEST_BETA_API_KEY", "TEST_GAMMA_API_KEY", "TEST_DELTA_API_KEY", "TEST_PERSONAL_API_KEY"):
        os.environ.pop(var, None)
    os.environ.pop("CREW_HOME", None)


# ----------------------- POST /api/config/models -----------------------


@pytest.mark.asyncio
async def test_create_model_success(api, tmp_path: Path, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={
            "id": "gamma",
            "name": "Gamma",
            "api_key_env": "TEST_GAMMA_API_KEY",
            "base_url": "https://gamma.example.com/v1",
            "model": "gamma-1",
            "api_key": "sk-gamma-xxx",
        })
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["profile"]["id"] == "gamma"
    assert data["profile"]["model"] == "gamma-1"
    assert data["profile"]["api_key"] == "sk-gamma-xxx"
    assert data["profile"]["api_key_env"] == "TEST_GAMMA_API_KEY"
    assert data["profile"]["loaded"] is True
    # 列表应包含 3 个
    ids = {m["id"] for m in data["models"]}
    assert {"alpha", "gamma"} == ids
    # 激活模型未变
    assert data["active_model_id"] == "alpha"


@pytest.mark.asyncio
async def test_browser_proxy_settings_are_persisted_without_exposing_password(api, tmp_path: Path, auth_headers):
    api.state.crew.config.gateway_admin_accounts = []
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        saved = await client.put(
            "/api/config/browser-proxy",
            json={
                "server": "http://127.0.0.1:7890",
                "username": "browser-user",
                "password": "browser-secret",
            },
        )
        assert saved.status_code == 200, saved.text
        assert saved.json() == {
            "ok": True,
            "server": "http://127.0.0.1:7890",
            "username": "browser-user",
            "has_password": True,
        }

        updated = await client.put(
            "/api/config/browser-proxy",
            json={
                "server": "https://proxy.example.com:8443",
                "username": "browser-user",
                "password": "",
            },
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["has_password"] is True

        invalid = await client.put(
            "/api/config/browser-proxy",
            json={"server": "socks5://127.0.0.1:1080", "username": "", "password": ""},
        )
        assert invalid.status_code == 400

    config = api.state.crew.config
    assert config.browser.upstream_proxy_url == (
        "https://browser-user:browser-secret@proxy.example.com:8443"
    )
    persisted = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert persisted["tools"]["browser"]["upstream_proxy_url"] == config.browser.upstream_proxy_url
    assert not getattr(config.network, "proxy_url", "")


@pytest.mark.asyncio
async def test_local_owner_can_create_model(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={
            "id": "personal",
            "api_key_env": "TEST_PERSONAL_API_KEY",
            "model": "p-1",
            "api_key": "sk-personal",
        })

    assert resp.status_code == 201
    assert resp.json()["profile"]["id"] == "personal"
    assert resp.json()["profile"]["builtin"] is False


@pytest.mark.asyncio
async def test_owner_private_model_is_not_visible_to_other_owner(api, auth_headers, monkeypatch):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        created = await client.post("/api/config/models", json={
            "id": "personal",
            "api_key_env": "TEST_PERSONAL_API_KEY",
            "model": "p-1",
            "api_key": "sk-personal",
        })
        assert created.status_code == 201
        logged_out = await client.post("/api/auth/logout")
        assert logged_out.status_code == 200

    monkeypatch.setattr("crew.gateway.auth.LOCAL_OWNER_ACCOUNT_ID", "B:uid-b")
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        visible = await client.get("/api/config")
        switch_resp = await client.post("/api/config/model", json={"model_id": "personal"})

    assert visible.status_code == 200
    body = visible.json()
    assert "personal" not in {item["id"] for item in body["models"]}
    assert "personal" not in {item["id"] for item in body["model_profiles"]}
    assert switch_resp.status_code == 404


@pytest.mark.asyncio
async def test_switch_model_is_owner_scoped(api, auth_headers, monkeypatch):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        created = await client.post("/api/config/models", json={
            "id": "personal",
            "api_key_env": "TEST_PERSONAL_API_KEY",
            "model": "p-1",
            "api_key": "sk-personal",
        })
        assert created.status_code == 201
        switched = await client.post("/api/config/model", json={"model_id": "personal"})
        assert switched.status_code == 200
        assert switched.json()["active_model_id"] == "personal"
        logged_out = await client.post("/api/auth/logout")
        assert logged_out.status_code == 200

    monkeypatch.setattr("crew.gateway.auth.LOCAL_OWNER_ACCOUNT_ID", "B:uid-b")
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        visible = await client.get("/api/config")

    assert visible.status_code == 200
    assert visible.json()["active_model_id"] == "alpha"


@pytest.mark.asyncio
async def test_local_owner_can_manage_global_model(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        update = await client.put("/api/config/models/alpha", json={"temperature": 0.2})
        delete = await client.delete("/api/config/models/alpha")

    assert update.status_code == 200
    assert update.json()["profile"]["builtin"] is False
    assert delete.status_code != 403


@pytest.mark.asyncio
async def test_local_owner_can_view_builtin_model_profiles(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    body = resp.json()
    assert "alpha" in {item["id"] for item in body["model_profiles"]}
    assert "beta" in {item["id"] for item in body["model_profiles"]}


@pytest.mark.asyncio
async def test_owner_overlay_cannot_spoof_builtin_flag(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    beta = next(item for item in resp.json()["model_profiles"] if item["id"] == "beta")
    assert beta["builtin"] is False


@pytest.mark.asyncio
async def test_session_history_returns_optional_timing_metadata(api, auth_headers):
    app_crew = api.state.crew
    user = Message.user("hi")
    user.timestamp = 10.0
    assistant = Message.assistant(
        "done",
        [ToolCall("tc1", "terminal", {"command": "echo hi"}, started_at=11.0, duration=1.2)],
    )
    assistant.timestamp = 12.0
    assistant.turn_started_at = 10.0
    assistant.turn_duration = 2.0
    assistant.thinking = "推理过程示例"
    assistant.turn_file_changes = [
        {
            "path": "/tmp/snake_game.html",
            "name": "snake_game.html",
            "added": 419,
            "removed": 117,
            "status": "modified",
        }
    ]
    app_crew.session_store.save("timed", [user, assistant], owner_account_id="A:uid-a")

    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/session/timed")

    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["timestamp"] == 10.0
    assert data[1]["timestamp"] == 12.0
    assert data[1]["turn_started_at"] == 10.0
    assert data[1]["turn_duration"] == 2.0
    assert data[1]["tool_calls"][0]["started_at"] == 11.0
    assert data[1]["tool_calls"][0]["duration"] == 1.2
    assert data[1]["thinking"] == "推理过程示例"
    assert data[1]["turn_file_changes"] == [
        {
            "path": "/tmp/snake_game.html",
            "name": "snake_game.html",
            "added": 419,
            "removed": 117,
            "status": "modified",
        }
    ]


@pytest.mark.asyncio
async def test_session_history_recovers_tool_result_for_ui(api, auth_headers):
    app_crew = api.state.crew
    screenshot_path = (
        "/tmp/.crew/accounts/acct_0123456789abcdef/"
        "task_workspaces/default/downloads/browser/shot.png"
    )
    assistant = Message.assistant(
        "",
        [ToolCall("shot-1", "browser_use", {"action": "screenshot"})],
    )
    tool_result = Message.tool("shot-1", screenshot_path, name="browser_use")
    app_crew.session_store.save(
        "screenshot-history",
        [Message.user("截图给我看"), assistant, tool_result],
        owner_account_id="A:uid-a",
    )

    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/session/screenshot-history")

    assert resp.status_code == 200
    assert resp.json()[1]["tool_calls"][0]["result"] == screenshot_path


@pytest.mark.asyncio
async def test_create_model_writes_key_to_yaml_not_env(api, tmp_path: Path, auth_headers):
    """新增时 API Key 写入账号 YAML，不再写入单独的 .env。"""
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={
            "id": "delta",
            "api_key_env": "TEST_DELTA_API_KEY",
            "base_url": "",
            "model": "d-1",
            "api_key": "sk-delta-secret",
        })
    assert resp.status_code == 201
    env_path = _owner_overlay_path(tmp_path).parent / ".env"
    assert not env_path.exists()
    overlay = yaml.safe_load(_owner_overlay_path(tmp_path).read_text(encoding="utf-8")) or {}
    assert overlay["llm"]["models"]["delta"]["api_key"] == "sk-delta-secret"


@pytest.mark.asyncio
async def test_create_model_ignores_api_key_environment_name(api, auth_headers, tmp_path, monkeypatch):
    """旧 api_key_env 字段不再用于读取密钥或修改进程环境。"""
    protected_home = str(tmp_path / "keep-this-home")
    monkeypatch.setenv("CREW_HOME", protected_home)
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={
            "id": "legacy-env",
            "api_key_env": "CREW_HOME",
            "model": "legacy-env-1",
        })

    assert resp.status_code == 201
    assert resp.json()["profile"]["has_key"] is False
    assert os.environ["CREW_HOME"] == protected_home


@pytest.mark.asyncio
async def test_create_model_rejects_duplicate(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={"id": "alpha"})
    assert resp.status_code == 409
    assert "已存在" in resp.json()["error"]


@pytest.mark.asyncio
async def test_create_model_rejects_empty_id(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.post("/api/config/models", json={"id": ""})
    assert resp.status_code == 409
    assert "不能为空" in resp.json()["error"]


@pytest.mark.asyncio
async def test_create_model_persists_to_yaml(api, tmp_path: Path, auth_headers):
    """新增后重新加载 yaml，profile 应可见。"""
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        await client.post("/api/config/models", json={
            "id": "gamma",
            "api_key_env": "TEST_GAMMA_API_KEY",
            "model": "g-1",
        })

    overlay = yaml.safe_load(_owner_overlay_path(tmp_path).read_text(encoding="utf-8")) or {}
    assert overlay["llm"]["models"]["gamma"]["model"] == "g-1"


@pytest.mark.asyncio
async def test_create_model_persists_api_key_in_owner_yaml(api, tmp_path: Path, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        created = await client.post("/api/config/models", json={
            "id": "yaml-key",
            "api_key_env": "TEST_GAMMA_API_KEY",
            "model": "yaml-key-model",
            "api_key": "key-persisted-in-yaml",
        })
        listed = await client.get("/api/config")
        unchanged = await client.put("/api/config/models/yaml-key", json={
            "api_key": "",
            "temperature": 0.2,
        })

    assert created.status_code == 201
    assert created.json()["profile"]["api_key"] == "key-persisted-in-yaml"
    listed_profile = next(
        item for item in listed.json()["model_profiles"] if item["id"] == "yaml-key"
    )
    assert listed_profile["api_key"] == "key-persisted-in-yaml"
    assert unchanged.status_code == 200
    assert unchanged.json()["profile"]["api_key"] == "key-persisted-in-yaml"
    overlay = yaml.safe_load(_owner_overlay_path(tmp_path).read_text(encoding="utf-8")) or {}
    assert overlay["llm"]["models"]["yaml-key"]["api_key"] == "key-persisted-in-yaml"

    reloaded = load_config(config_path=str(tmp_path / "config.yaml"))
    reloaded_profile = reloaded.owner_model_profiles(OWNER_A)["yaml-key"]
    assert reloaded_profile.api_key == "key-persisted-in-yaml"


# ----------------------- PUT /api/config/models/{id} -----------------------


@pytest.mark.asyncio
async def test_update_model_success(api, tmp_path: Path, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.put("/api/config/models/alpha", json={
            "temperature": 0.1,
            "base_url": "https://new.example.com/v1",
            "system_prompt": "仅在 ask_model 时使用",
        })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["profile"]["id"] == "alpha"
    assert data["profile"]["builtin"] is False
    # 拿不到 temperature（public_dict 有），验证一下
    assert data["profile"]["temperature"] == 0.1
    assert data["profile"]["system_prompt"] == "仅在 ask_model 时使用"
    assert api.state.crew.owner_model_profiles(OWNER_A)["alpha"].base_url == "https://new.example.com/v1"
    overlay = yaml.safe_load(_owner_overlay_path(tmp_path).read_text(encoding="utf-8")) or {}
    assert overlay["llm"]["models"]["alpha"]["system_prompt"] == "仅在 ask_model 时使用"


@pytest.mark.asyncio
async def test_only_default_config_model_is_builtin(api, auth_headers):
    api.state.crew.config.model_profiles["default"] = ModelProfile(
        id="default",
        name="Default",
        model="default",
        builtin=True,
        shared=True,
    )
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    profiles = {item["id"]: item for item in resp.json()["model_profiles"]}
    assert profiles["default"]["builtin"] is True
    assert profiles["alpha"]["builtin"] is False


@pytest.mark.asyncio
async def test_deleting_shared_model_only_hides_it_for_current_owner(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        await client.put("/api/config/models/beta", json={"loaded": True})
        deleted = await client.delete("/api/config/models/alpha")
        another_owner_profiles = api.state.crew.config.owner_model_profiles("B:uid-b")

    assert deleted.status_code == 200, deleted.text
    assert "alpha" not in {item["id"] for item in deleted.json()["model_profiles"]}
    assert "alpha" in another_owner_profiles


@pytest.mark.asyncio
async def test_update_model_not_found(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.put("/api/config/models/nonexistent", json={"temperature": 0.1})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_active_model_rebuilds_provider(api, auth_headers):
    """更新当前激活模型时，应触发 Provider 重建（行为对齐 use_model）。

    验证手段：观察 has_key 状态变化（构造无 key 的临时场景）。
    """
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        await client.put("/api/config/models/beta", json={"loaded": True})
        await client.post("/api/config/model", json={"model_id": "beta"})
        # 先确认 alpha 当前 has_key
        resp1 = await client.get("/api/config")
        assert resp1.json()["has_key"] is True

        # 修改旧 api_key_env 元数据不会替换或重新读取模型密钥。
        resp2 = await client.put("/api/config/models/beta", json={
            "api_key_env": "NONEXISTENT_API_KEY_VAR_XYZ",
        })
    assert resp2.status_code == 200
    assert resp2.json()["has_key"] is True


@pytest.mark.asyncio
async def test_config_includes_all_model_profiles_for_settings(api, auth_headers):
    app_crew = api.state.crew
    profiles = app_crew.owner_model_profiles("A:uid-a")
    profiles["no_key"] = app_crew.config.model_profiles["alpha"].__class__(
        id="no_key",
        name="No Key",
        api_key="",
        api_key_env="NO_API_KEY_ENV",
        model="no-key-model",
    )
    app_crew.config.persist_owner_model_profiles("A:uid-a", profiles, active_model_id=app_crew.config.owner_active_model_id("A:uid-a"))

    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    body = resp.json()
    assert "no_key" not in {item["id"] for item in body["models"]}
    assert "no_key" in {item["id"] for item in body["model_profiles"]}


@pytest.mark.asyncio
async def test_can_load_and_unload_model_without_deleting_url_or_key(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        loaded = await client.put("/api/config/models/beta", json={"loaded": True})
        unloaded = await client.put("/api/config/models/beta", json={"loaded": False})

    assert loaded.status_code == 200
    assert "beta" in {item["id"] for item in loaded.json()["models"]}
    assert unloaded.status_code == 200
    body = unloaded.json()
    assert "beta" not in {item["id"] for item in body["models"]}
    beta = next(item for item in body["model_profiles"] if item["id"] == "beta")
    assert beta["loaded"] is False
    assert beta["base_url"] == "https://beta.example.com/v1"
    assert beta["has_key"] is True


@pytest.mark.asyncio
async def test_unload_active_model_is_rejected(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.put("/api/config/models/alpha", json={"loaded": False})

    assert resp.status_code == 409
    assert "当前激活模型" in resp.json()["error"]


# ----------------------- DELETE /api/config/models/{id} -----------------------


@pytest.mark.asyncio
async def test_delete_model_success(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.delete("/api/config/models/beta")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["removed"]["id"] == "beta"
    # 删除非激活模型时，激活应保持
    assert data["active_model_id"] == "alpha"
    ids = {m["id"] for m in data["models"]}
    assert ids == {"alpha"}
    env_text = api.state.crew.config.owner_env_map("A:uid-a")
    assert env_text.get("TEST_BETA_API_KEY", "") == ""


@pytest.mark.asyncio
async def test_delete_model_keeps_shared_env_key_for_remaining_profile(api, auth_headers):
    profiles = api.state.crew.owner_model_profiles("A:uid-a")
    profiles["shared"] = api.state.crew.config.model_profiles["alpha"].__class__(
        id="shared",
        name="Shared",
        api_key="sk-beta",
        api_key_env="TEST_BETA_API_KEY",
        base_url="https://shared.example.com/v1",
        model="shared-1",
        loaded=True,
    )
    api.state.crew.config.persist_owner_model_profiles("A:uid-a", profiles, active_model_id=api.state.crew.config.owner_active_model_id("A:uid-a"))
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.delete("/api/config/models/beta")

    assert resp.status_code == 200
    assert api.state.crew.config.owner_env_map("A:uid-a").get("TEST_BETA_API_KEY") is None
    assert api.state.crew.owner_model_profiles("A:uid-a")["shared"].api_key == "sk-beta"


@pytest.mark.asyncio
async def test_delete_active_model_switches_to_first(api, auth_headers):
    """删除当前 owner 的激活私有模型 beta，应自动切回剩余可用模型 alpha。"""
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        await client.put("/api/config/models/beta", json={"loaded": True})
        await client.post("/api/config/model", json={"model_id": "beta"})
        resp = await client.delete("/api/config/models/beta")
    assert resp.status_code == 200
    data = resp.json()
    assert data["removed"]["id"] == "beta"
    assert data["switched_to"] == "alpha"
    assert data["active_model_id"] == "alpha"


@pytest.mark.asyncio
async def test_delete_last_model_forbidden(api, auth_headers):
    """删到只剩一个时，再删应返回 409。"""
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        await client.delete("/api/config/models/beta")
        # 此时只剩 alpha
        resp = await client.delete("/api/config/models/alpha")
    assert resp.status_code == 409
    assert "至少保留" in resp.json()["error"]


@pytest.mark.asyncio
async def test_delete_model_not_found(api, auth_headers):
    transport = ASGITransport(app=api)
    async with AsyncClient(transport=transport, base_url="http://test", headers=auth_headers) as client:
        resp = await client.delete("/api/config/models/nonexistent")
    assert resp.status_code == 404


# ----------------------- 端到端：CRUD 链路 -----------------------


@pytest.mark.asyncio
async def test_crud_chain(api, tmp_path: Path, auth_headers):
    """新增 → 更新 → 切换激活 → 删除（非激活）→ 重启加载验证。"""
    transport = ASGITransport(app=api)
    base = "http://test"
    async with AsyncClient(transport=transport, base_url=base, headers=auth_headers) as client:
        # 1. 新增 gamma
        r1 = await client.post("/api/config/models", json={
            "id": "gamma",
            "api_key_env": "TEST_GAMMA_API_KEY",
            "base_url": "https://gamma.example.com/v1",
            "model": "gamma-1",
            "api_key": "sk-gamma",
        })
        assert r1.status_code == 201

        # 2. 更新 gamma 的 temperature
        r2 = await client.put("/api/config/models/gamma", json={"temperature": 0.2})
        assert r2.status_code == 200
        assert r2.json()["profile"]["temperature"] == 0.2

        # 3. 切换激活到 gamma
        await client.put("/api/config/models/gamma", json={"loaded": True})
        r3 = await client.post("/api/config/model", json={"model_id": "gamma"})
        assert r3.status_code == 200
        assert r3.json()["active_model_id"] == "gamma"

        # 4. 删除 beta（非激活）
        r4 = await client.delete("/api/config/models/beta")
        assert r4.status_code == 200
        assert r4.json()["active_model_id"] == "gamma"

    overlay = yaml.safe_load(_owner_overlay_path(tmp_path).read_text(encoding="utf-8")) or {}
    assert set(overlay["llm"]["models"].keys()) == {"gamma"}
    assert overlay["llm"]["active"] == "gamma"
    assert overlay["llm"]["models"]["gamma"]["temperature"] == 0.2
