from pathlib import Path

import pytest
import yaml

from crew.state.config import load_config
from crew.state.home import get_owner_runtime_home


@pytest.fixture(autouse=True)
def _isolate_repo_env_files(monkeypatch):
    """隔离仓库里的本地开发 .env。

    load_config 会用 load_dotenv(override=True) 加载仓库根的 config/.env，
    本机开发时其中可能存有真实 Key，影响本文件对环境变量密钥的隔离验证。
    """
    monkeypatch.setattr("crew.state.config._load_env_files", lambda: None)


def _write_config(tmp_path: Path, *, dev_mode: bool = False) -> Path:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "llm": {
                    "active": "default",
                    "models": {
                        "default": {
                            "name": "Default",
                            "api_key_env": "CREW_MODEL_API_KEY",
                            "provider": "openai",
                            "base_url": "https://xxx/v1",
                            "model": "test-model",
                        }
                    },
                },
                "runtime": {"db_path": str(tmp_path / "crew.db")},
                "gateway": {
                    "host": "127.0.0.1",
                    "port": 8000,
                    "dev_mode": dev_mode,
                    "dev_account": "dev:dev",
                },
            },
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    return config_path


@pytest.mark.parametrize(
    "owner, dev_mode",
    [
        ("local", False),
        ("dev:dev", True),
    ],
    ids=["local-owner", "dev-owner"],
)
def test_owner_does_not_load_model_key_from_environment(tmp_path, monkeypatch, owner, dev_mode):
    monkeypatch.setenv("CREW_HOME", str(tmp_path / ".crew"))
    monkeypatch.setenv("CREW_MODEL_API_KEY", "legacy-environment-key")
    config = load_config(config_path=str(_write_config(tmp_path, dev_mode=dev_mode)))

    profile = config.owner_model_profiles(owner)["default"]

    assert profile.has_key is False
    assert profile.api_key == ""


def test_owner_uses_model_key_from_config(tmp_path, monkeypatch):
    monkeypatch.setenv("CREW_HOME", str(tmp_path / ".crew"))
    config_path = _write_config(tmp_path)
    data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    data["llm"]["models"]["default"]["api_key"] = "configured-key"
    config_path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    monkeypatch.setenv("CREW_MODEL_API_KEY", "ignored-environment-key")
    config = load_config(config_path=str(config_path))

    profile = config.owner_model_profiles("another-owner")["default"]
    assert profile.has_key is True
    assert profile.api_key == "configured-key"


def test_owner_does_not_load_model_key_from_owner_env_file(tmp_path, monkeypatch):
    monkeypatch.setenv("CREW_HOME", str(tmp_path / ".crew"))
    owner_home = get_owner_runtime_home("owner:one")
    owner_home.mkdir(parents=True, exist_ok=True)
    (owner_home / ".env").write_text(
        "CREW_MODEL_API_KEY=legacy-owner-environment-key\n",
        encoding="utf-8",
    )
    config = load_config(config_path=str(_write_config(tmp_path)))

    profile = config.owner_model_profiles("owner:one")["default"]

    assert profile.api_key == ""
    assert profile.has_key is False
