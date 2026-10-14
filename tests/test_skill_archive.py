import io
import zipfile

import pytest

from crew.agent import skill_archive
from crew.agent.skill_archive import SkillArchiveError, export_skills_zip, import_skills_zip

SKILL_MD = (
    "---\nname: demo-skill\ndescription: 演示技能，用于测试导入导出功能是否正常工作\n---\n"
    "# Demo\n\n" + "这里是足够长的正文内容，用来满足校验对正文长度的最低要求。" * 3 + "\n"
)


@pytest.fixture(autouse=True)
def crew_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CREW_HOME", str(tmp_path))
    return tmp_path


def _zip(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


def test_import_export_roundtrip(crew_home):
    result = import_skills_zip(_zip({"demo-skill/SKILL.md": SKILL_MD, "demo-skill/a.txt": "x"}))
    assert result["installed"] == ["demo-skill"]
    assert (crew_home / "skills" / "demo-skill" / "a.txt").is_file()

    data, name = export_skills_zip(["demo-skill"])
    assert name == "skill-demo-skill.zip"
    assert "demo-skill/SKILL.md" in zipfile.ZipFile(io.BytesIO(data)).namelist()

    data_all, _ = export_skills_zip(None)
    assert "demo-skill/a.txt" in zipfile.ZipFile(io.BytesIO(data_all)).namelist()


def test_import_root_level_and_overwrite(crew_home):
    assert import_skills_zip(_zip({"SKILL.md": SKILL_MD}))["installed"] == ["demo-skill"]
    again = import_skills_zip(_zip({"SKILL.md": SKILL_MD}))
    assert again["installed"] == [] and again["skipped"][0]["reason"] == "已存在同名技能"
    assert import_skills_zip(_zip({"SKILL.md": SKILL_MD}), overwrite=True)["installed"] == ["demo-skill"]


def test_import_rejects_zip_slip():
    with pytest.raises(SkillArchiveError):
        import_skills_zip(_zip({"../evil/SKILL.md": SKILL_MD}))


def test_import_rejects_invalid():
    with pytest.raises(SkillArchiveError):
        import_skills_zip(b"not a zip")
    with pytest.raises(SkillArchiveError):
        import_skills_zip(_zip({"readme.txt": "hi"}))
    assert skill_archive.MAX_ENTRIES > 0
