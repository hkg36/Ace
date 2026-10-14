"""Skill 的 zip 导出 / 导入。

技能目录是本机全局共享的（get_user_skills_dir()，不分账号），所以导入的技能
天然对本机所有登录账号可见，不需要额外的"对所有用户可见"选项。

zip 布局：每个技能一个顶层目录 ``<slug>/SKILL.md``；导入时也接受 SKILL.md 直接
位于 zip 根部的单技能包（slug 取自 frontmatter name）。
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from crew.agent.skills import (
    _parse_frontmatter,
    _slugify,
    get_skills,
    get_user_skills_dir,
    install_skill_from_dir,
    uninstall_skill,
    validate_generated_skill,
)

MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ENTRIES = 2000
_SKIP_DIRS = frozenset({"__pycache__", ".git", "node_modules"})


class SkillArchiveError(ValueError):
    """zip 内容不合法（越界路径、符号链接、超限等）。"""


def _write_tree(zf: zipfile.ZipFile, src: Path, arc_root: str) -> None:
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not Path(dirpath, d).is_symlink()]
        for name in filenames:
            path = Path(dirpath, name)
            if path.is_symlink() or not path.is_file():
                continue
            rel = path.relative_to(src).as_posix()
            zf.write(path, f"{arc_root}/{rel}")


def export_skills_zip(slugs: list[str] | None = None) -> tuple[bytes, str]:
    """打包技能为 zip，返回 (内容, 建议文件名)。

    slugs 为空时导出全部用户技能；指定时可导出任意已发现的技能（含内置）。
    """
    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if slugs:
            skills = get_skills()
            for slug in slugs:
                info = skills.get(f"/{slug.lstrip('/')}")
                if info is None:
                    raise SkillArchiveError(f"skill 不存在: {slug}")
                skill_dir = Path(info["skill_dir"])
                _write_tree(zf, skill_dir, skill_dir.name)
                count += 1
        else:
            user_dir = get_user_skills_dir()
            if user_dir.is_dir():
                for child in sorted(user_dir.iterdir()):
                    if child.name.startswith(".") or not child.is_dir():
                        continue
                    _write_tree(zf, child, child.name)
                    count += 1
    if count == 0:
        raise SkillArchiveError("没有可导出的技能")
    name = f"skill-{slugs[0]}.zip" if slugs and len(slugs) == 1 else "crew-skills.zip"
    return buf.getvalue(), name.replace("/", "-")


def _safe_extract(data: bytes, dest: Path) -> None:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise SkillArchiveError("不是有效的 zip 文件") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise SkillArchiveError(f"zip 内文件数超过上限 {MAX_ENTRIES}")
        if sum(i.file_size for i in infos) > MAX_ARCHIVE_BYTES:
            raise SkillArchiveError("zip 解压后体积超过上限")
        root = dest.resolve()
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = PurePosixPath(name).parts
            if parts and parts[0] == "__MACOSX":
                continue
            if name.startswith("/") or ".." in parts or (parts and ":" in parts[0]):
                raise SkillArchiveError(f"zip 含非法路径: {info.filename!r}")
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise SkillArchiveError(f"zip 含符号链接: {info.filename!r}")
            target = (dest / Path(*parts)).resolve() if parts else root
            if target != root and root not in target.parents:
                raise SkillArchiveError(f"zip 含越界路径: {info.filename!r}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with zf.open(info) as src, open(target, "wb") as out:
                while chunk := src.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_ARCHIVE_BYTES:
                        raise SkillArchiveError("zip 解压后体积超过上限")
                    out.write(chunk)


def _discover(extracted: Path, workdir: Path) -> list[tuple[str, Path]]:
    """返回 [(slug, 技能目录)]。"""
    if (extracted / "SKILL.md").is_file():
        try:
            fm, _ = _parse_frontmatter((extracted / "SKILL.md").read_text("utf-8"))
        except (OSError, UnicodeDecodeError) as exc:
            raise SkillArchiveError(f"SKILL.md 无法读取: {exc}") from exc
        slug = _slugify(str(fm.get("name") or ""))
        if not slug:
            raise SkillArchiveError("根目录 SKILL.md 缺少 frontmatter name")
        staged = workdir / "root" / slug
        shutil.copytree(extracted, staged)
        return [(slug, staged)]
    found = []
    for child in sorted(extracted.iterdir()):
        if child.is_dir() and (child / "SKILL.md").is_file():
            found.append((child.name, child))
    return found


def import_skills_zip(
    data: bytes,
    *,
    overwrite: bool = False,
    operator_account_id: str | None = None,
) -> dict[str, Any]:
    """导入 zip 内的技能。返回 {installed: [...], skipped: [{slug, reason}]}。"""
    if not data:
        raise SkillArchiveError("zip 内容为空")
    if len(data) > MAX_ARCHIVE_BYTES:
        raise SkillArchiveError("zip 文件过大")
    installed: list[str] = []
    skipped: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="crew-skill-import-") as tmp:
        tmp_path = Path(tmp)
        extracted = tmp_path / "x"
        extracted.mkdir()
        _safe_extract(data, extracted)
        candidates = _discover(extracted, tmp_path)
        if not candidates:
            raise SkillArchiveError("zip 中没有找到含 SKILL.md 的技能目录")
        user_dir = get_user_skills_dir()
        for slug, skill_dir in candidates:
            if not slug or _slugify(slug) != slug:
                skipped.append({"slug": slug, "reason": "目录名不是合法 slug"})
                continue
            existing = user_dir / slug
            if existing.is_symlink():
                skipped.append({"slug": slug, "reason": "已存在同名本地共享技能（软链），不覆盖"})
                continue
            if existing.exists() and not overwrite:
                skipped.append({"slug": slug, "reason": "已存在同名技能"})
                continue
            problems = validate_generated_skill(skill_dir, slug)
            if problems:
                skipped.append({"slug": slug, "reason": "；".join(problems)})
                continue
            if existing.exists():
                # _install_skill_tree 拒绝覆盖已有目标；校验已通过，先走审计过的卸载再发布。
                if not uninstall_skill(slug, operator_account_id=operator_account_id, source="zip-import"):
                    skipped.append({"slug": slug, "reason": "无法移除旧版本"})
                    continue
            ok = install_skill_from_dir(
                skill_dir,
                slug=slug,
                operator_account_id=operator_account_id,
                source="zip-import",
                validate=False,
            )
            if ok:
                installed.append(slug)
            else:
                skipped.append({"slug": slug, "reason": "安装失败，详见 Gateway 日志"})
    return {"installed": installed, "skipped": skipped}
