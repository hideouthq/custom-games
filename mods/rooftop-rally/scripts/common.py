from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "project.json").read_text())
ADDON = CONFIG["addon"]
MAP = CONFIG["map"]
for value in (ADDON, MAP):
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value):
        raise ValueError("Project addon and map names must be lowercase identifiers")
SDK = ROOT / "tools/modlock-sdk"
TOOLS = ROOT / ".tools/modlock-tools"
SOURCE = ROOT / "content/citadel_addons" / ADDON
OUTPUT = ROOT / ".local/compiled" / ADDON
STAMP = ROOT / ".local/build/map.json"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_hashes() -> dict[str, str]:
    return {str(path.relative_to(SOURCE)): digest(path)
            for path in sorted(SOURCE.rglob("*"))
            if path.is_file() and "panorama" != path.relative_to(SOURCE).parts[0]
            and path.relative_to(SOURCE).parts[:2] != ("ui", "hideout")
            and path.suffix not in (".vmap_autosave", ".vmap_backup")}


def sdk_revision() -> str:
    revision = subprocess.check_output(
        ["git", "-C", str(SDK), "rev-parse", "HEAD"], text=True).strip()
    if revision != CONFIG["sdkRevision"]:
        raise ValueError("The SDK checkout differs from project.json; review its version before building")
    return revision


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def windows_path(path: Path) -> str:
    # Resolving the addon symlink makes the compiler infer a different project.
    return "Z:" + str(path.absolute()).replace("/", "\\")


@contextmanager
def build_lock():
    folder = ROOT / ".local/build"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "workspace.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another project compile, stage or build is running")
        yield
