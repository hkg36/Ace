from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from crew.browser.driver import BrowserDriver, BrowserDriverError
from crew.browser.manager import BrowserManager
from crew.browser.types import BrowserConfig
from crew.state.workspace_store import SQLiteWorkspaceStore


class WorkspaceDriver(BrowserDriver):
    def __init__(self) -> None:
        self.cleared: list[Path] = []
        self.closed: list[Path] = []

    def available(self) -> bool:
        return True

    async def execute(self, *args, **kwargs):
        raise AssertionError("This test must not execute a browser command")

    def requires_policy_proxy(self) -> bool:
        return False

    async def clear_owner_data(self, owner_session, profile_dir, **kwargs):
        self.cleared.append(profile_dir)
        return True

    async def close(self, owner_session, profile_dir):
        self.closed.append(profile_dir)
        return True


@pytest.fixture
def workspace_browser(tmp_path, monkeypatch):
    monkeypatch.setenv("CREW_HOME", str(tmp_path))
    memberships = {"a1": "project-a", "a2": "project-a", "b": "project-b", "d": "default"}
    driver = WorkspaceDriver()
    manager = BrowserManager(
        BrowserConfig(),
        driver,
        workspace_for_session=lambda session, owner: memberships.get(session),
    )
    return manager, driver


async def test_profiles_and_runtime_are_shared_only_inside_one_workspace(workspace_browser):
    manager, driver = workspace_browser
    try:
        a, a2, b, default = [
            await manager._owner("owner", sid) for sid in ("a1", "a2", "b", "d")
        ]
        assert a is a2
        assert len({a.profile_dir, b.profile_dir, default.profile_dir}) == 3
        assert a.runtime_key == b.runtime_key == default.runtime_key
        assert a.lock is not b.lock
        assert a.profile_dir.parts[-4:] == ("project-a", ".crew", "browser", "profile")
    finally:
        await manager.aclose()


async def test_host_events_and_state_find_sessions_across_workspaces(workspace_browser):
    manager, _ = workspace_browser
    try:
        for sid in ("a1", "b", "d"):
            owner = await manager._owner("owner", sid)
            session = manager._session(owner, sid)
            session.recording_id = {"a1": "aa001122", "b": "bb001122", "d": "dd001122"}[sid]
            assert manager._get_owner("owner", sid) is owner
            assert manager.session_for_recording_id("owner", session.recording_id) == sid
        assert manager.session_for_recording_id("other", "aa001122") is None
    finally:
        await manager.aclose()


async def test_revoke_fences_and_closes_all_workspace_profiles(workspace_browser):
    manager, driver = workspace_browser
    owners = [await manager._owner("owner", sid) for sid in ("a1", "b", "d")]
    for owner in owners:
        owner.running = True
    await manager.revoke_owner("owner")
    assert set(driver.closed) == {owner.profile_dir for owner in owners}
    assert not manager._account_owners("owner")
    assert manager.capability_generation("owner") == 1
    await manager.aclose()


async def test_clear_account_includes_cold_workspace_profiles(workspace_browser):
    manager, driver = workspace_browser
    owner = await manager._owner("owner", "a1")
    cold = manager._workspace_profile("owner", "project-b")
    cold.mkdir(parents=True)
    await manager.clear_owner_data("owner")
    assert set(driver.cleared) == {
        owner.profile_dir, cold, manager._workspace_profile("owner", "default"),
    }
    assert not manager._account_owners("owner")
    await manager.aclose()


async def test_delete_removes_only_selected_workspace_browser_directory(workspace_browser):
    manager, driver = workspace_browser
    a = await manager._owner("owner", "a1")
    b = await manager._owner("owner", "b")
    for owner in (a, b):
        owner.profile_dir.mkdir(parents=True)
        (owner.profile_dir / "Cookies").write_text("private")
    user_file = a.profile_dir.parents[2] / "keep.txt"
    user_file.write_text("workspace content")
    await manager.delete_workspace_data("owner", "project-a")
    assert not a.profile_dir.parent.exists()
    assert (b.profile_dir / "Cookies").is_file()
    assert user_file.is_file()
    assert driver.cleared == [a.profile_dir]
    with pytest.raises(BrowserDriverError, match="工作空间已删除"):
        await manager._owner("owner", "a1")
    await manager.aclose()


async def test_locked_profile_cleanup_is_persistent_and_retried_at_startup(
    workspace_browser, monkeypatch,
):
    import crew.browser.manager as module

    if module.os.name != "nt":
        pytest.skip("Windows Session file locks")
    manager, _ = workspace_browser
    owner = await manager._owner("owner", "a1")
    owner.profile_dir.mkdir(parents=True)
    original = module.shutil.rmtree

    def locked(path):
        raise PermissionError("Electron still holds the Session")

    monkeypatch.setattr(module.shutil, "rmtree", locked)
    await manager.delete_workspace_data("owner", "project-a")
    marker = owner.profile_dir.parents[1] / "browser-delete-pending"
    assert marker.is_file()
    BrowserManager.cleanup_pending_workspace_profiles()
    assert marker.is_file()
    monkeypatch.setattr(module.shutil, "rmtree", original)
    BrowserManager.cleanup_pending_workspace_profiles()
    assert not marker.exists()
    assert not owner.profile_dir.parent.exists()
    await manager.aclose()


async def test_deleted_session_does_not_fall_back_to_default_profile(workspace_browser):
    manager, _ = workspace_browser
    with pytest.raises(BrowserDriverError, match="会话不存在"):
        await manager._owner("owner", "missing")
    await manager.aclose()


async def test_artifacts_stay_inside_the_selected_workspace_browser_root(workspace_browser):
    manager, _ = workspace_browser
    for sid in ("a1", "b"):
        owner = await manager._owner("owner", sid)
        session = manager._session(owner, sid)
        assert manager._artifact_dir(session).is_relative_to(owner.profile_dir.parent)
    await manager.aclose()


async def test_emergency_stop_is_limited_to_the_current_workspace(workspace_browser):
    manager, driver = workspace_browser
    a = await manager._owner("owner", "a1")
    b = await manager._owner("owner", "b")
    for owner, sid in ((a, "a1"), (b, "b")):
        manager._session(owner, sid)
        owner.running = True
    await manager.user_control("owner", "a1", "stop")
    assert manager.state("owner", "a1")["mode"] == "paused"
    assert b.running
    assert driver.closed == [a.profile_dir]
    await manager.aclose()


async def test_reset_host_registration_retires_every_workspace(workspace_browser):
    manager, _ = workspace_browser
    for sid in ("a1", "b", "d"):
        owner = await manager._owner("owner", sid)
        manager._session(owner, sid)
    await asyncio.wait_for(manager.reset_host_registration("owner"), 1)
    assert not manager._account_owners("owner")
    await manager.aclose()


async def test_project_profiles_are_inside_selected_folder_and_isolate_shared_roots(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("CREW_HOME", str(tmp_path / "home"))
    root = tmp_path / "project"
    root.mkdir()
    store = SQLiteWorkspaceStore(str(tmp_path / "workspaces.db"))
    a = store.create("A", root_path=str(root), owner_account_id="owner")
    b = store.create("B", root_path=str(root), owner_account_id="owner")
    memberships = {"a": a["id"], "b": b["id"], "d": "default"}
    manager = BrowserManager(
        BrowserConfig(), WorkspaceDriver(), workspace_store=store,
        workspace_for_session=lambda sid, owner: memberships[sid],
    )
    try:
        owner_a = await manager._owner("owner", "a")
        owner_b = await manager._owner("owner", "b")
        default = await manager._owner("owner", "d")
        assert owner_a.profile_dir.is_relative_to(root / ".crew" / "browser")
        assert owner_b.profile_dir.is_relative_to(root / ".crew" / "browser")
        assert not default.profile_dir.is_relative_to(root)
        assert owner_a.profile_dir != owner_b.profile_dir
        for owner in (owner_a, owner_b):
            owner.profile_dir.mkdir(parents=True)
            (owner.profile_dir / "Cookies").write_text("cookies")
        user_file = root / "source.txt"
        user_file.write_text("keep")
        await manager.delete_workspace_data("owner", a["id"])
        assert not owner_a.profile_dir.exists()
        assert (owner_b.profile_dir / "Cookies").is_file()
        assert user_file.is_file()
    finally:
        await manager.aclose()


async def test_project_cleanup_survives_workspace_row_deletion(tmp_path, monkeypatch):
    import crew.browser.manager as module

    if module.os.name != "nt":
        pytest.skip("Windows Session file locks")
    monkeypatch.setenv("CREW_HOME", str(tmp_path / "home"))
    project = tmp_path / "project"
    project.mkdir()
    store = SQLiteWorkspaceStore(str(tmp_path / "workspaces.db"))
    workspace = store.create("A", root_path=str(project), owner_account_id="owner")
    wid = workspace["id"]
    manager = BrowserManager(
        BrowserConfig(), WorkspaceDriver(), workspace_store=store,
        workspace_for_session=lambda sid, owner: wid,
    )
    owner = await manager._owner("owner", "a")
    owner.profile_dir.mkdir(parents=True)
    original = module.shutil.rmtree

    def locked(path):
        raise PermissionError("Session locked")

    monkeypatch.setattr(module.shutil, "rmtree", locked)
    await manager.delete_workspace_data("owner", wid)
    record = manager._pending_record(owner.profile_dir.parent)
    assert record.is_file()
    store.delete(wid, owner_account_id="owner")
    monkeypatch.setattr(module.shutil, "rmtree", original)
    BrowserManager.cleanup_pending_workspace_profiles()
    assert not owner.profile_dir.exists()
    assert not record.exists()
    assert not manager._pending_marker(owner.profile_dir.parent).exists()
    await manager.aclose()


def test_invalid_cleanup_record_never_deletes_user_directory(tmp_path, monkeypatch, caplog):
    import json

    monkeypatch.setenv("CREW_HOME", str(tmp_path / "home"))
    project = tmp_path / "project"
    project.mkdir()
    user_file = project / "keep.txt"
    user_file.write_text("keep")
    record = BrowserManager._pending_record(project)
    record.parent.mkdir(parents=True)
    record.write_text(json.dumps({"browser_root": str(project)}))
    BrowserManager.cleanup_pending_workspace_profiles()
    assert user_file.is_file()
    assert record.is_file()
    assert "保留待清理记录" in caplog.text


async def test_offline_workspace_deletion_does_not_require_browser_plugin(tmp_path, monkeypatch):
    import crew.browser.manager as module

    monkeypatch.setenv("CREW_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(module.electron_browser_bridge, "connected", lambda key: False)
    manager = BrowserManager(BrowserConfig())
    profile = manager._workspace_profile("owner", "project")
    profile.mkdir(parents=True)
    (profile / "Cookies").write_text("old")
    await manager.delete_workspace_data("owner", "project")
    assert not profile.parent.exists()
    await manager.aclose()
