"""Build a community mode from the upstream revision its submodule pins, with Hideout's Modlock.

Each community mode's scripts/gameplay.py calls run() with a stage function. run() exports the pinned revision
into a temporary folder, lets stage() adapt it, checks the staged manifest against the reviewed
gameplay/mod.json, then runs the verb with the pinned runtime. The upstream LICENSE ships in the build.
"""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Callable

import runtime

REPO = Path(__file__).resolve().parents[1]


def export(mode: Path, folder: Path) -> None:
    """Write the revision staged for mods/MODE/upstream into folder."""
    link = mode.relative_to(REPO) / "upstream"
    revision = subprocess.check_output(["git", "rev-parse", f":{link.as_posix()}"], cwd=REPO, text=True).strip()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", revision], cwd=mode / "upstream", stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(folder, filter="data")


def run(mode: Path, verb: str, options: list[str], stage: Callable[[Path], Path] | None = None) -> None:
    """stage(folder) adapts the exported revision and returns the folder holding the mod.json to build."""
    name = mode.name
    if not (mode / "upstream/.git").exists():
        raise ValueError(f"Run git submodule update --init mods/{name}/upstream")
    reviewed = json.loads((mode / "gameplay/mod.json").read_text())
    with tempfile.TemporaryDirectory(prefix=f"{name}-") as temporary:
        folder = Path(temporary) / "upstream"
        folder.mkdir()
        export(mode, folder)
        project = stage(folder) if stage else folder
        if json.loads((project / "mod.json").read_text()) != reviewed:
            raise ValueError(f"Review mods/{name}/gameplay/mod.json against the updated upstream manifest")
        runtime.require()
        if verb == "ready":
            return
        if verb == "dev":
            print(f"Watching the staged project in {project}", flush=True)
            subprocess.run(runtime.command(project, "dev", *options), check=True)
            return
        subprocess.run(runtime.command(project, "build", "--release"), check=True)
        built = project / "build"
        (built / ".build.lock").unlink(missing_ok=True)
        manifest = json.loads((built / "mod.json").read_text())
        if verb == "test":
            if not (built / manifest["entry"]).is_file():
                raise ValueError("Expected the compiled gameplay")
            if manifest.get("map", "").startswith("hl_") and not (built / "maps" / f"{manifest['map']}.vpk").is_file():
                raise ValueError("Expected the declared map")
            return
        shutil.copy2(folder / "LICENSE", built / "LICENSE")
        if verb == "play":
            subprocess.run(runtime.command(project, "play", "--watch=false", *options), check=True)
            return
        if verb != "build":
            raise ValueError(f"Unknown action {verb}")
        output = mode / "gameplay/build"
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(built, output)


def main(mode: Path, title: str, stage: Callable[[Path], Path] | None = None) -> None:
    verb, *options = sys.argv[1:] or ["build"]
    try:
        run(mode, verb, options, stage)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f"{title}: {error}")
