#!/usr/bin/env python3
"""Build the pinned Shattered Arena sources with Hideout's Modlock."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

MODE = Path(__file__).resolve().parents[1]
PROJECT = MODE / "gameplay"
UPSTREAM = MODE / "upstream"
sys.path.insert(0, str(MODE.parents[1] / "scripts"))
import runtime

# In upstream 0.2.7 these updates landed at the root instead of at their import paths.
MOVED = {"sinners.ts": "arena/sinners.ts", "knockback.ts": "rules/knockback.ts",
         "tickets.ts": "rules/tickets.ts", "hud.tsx": "screen/hud.tsx",
         "hl_arena_pit.vpk": "maps/hl_arena_pit.vpk"}


def stage(folder):
    revision = subprocess.check_output(["git", "rev-parse", ":mods/arena-pit/upstream"], cwd=MODE.parents[1], text=True).strip()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "archive", revision, "arena", "bonus", "match", "rules", "screen",
                        "mod.json", "LICENSE", "main.ts", "config.ts", "tsconfig.json", *MOVED],
                       cwd=UPSTREAM, stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(folder, filter="data")
    (folder / "maps").mkdir()
    for source, destination in MOVED.items():
        (folder / source).replace(folder / destination)
    if json.loads((folder / "mod.json").read_text()) != json.loads((PROJECT / "mod.json").read_text()):
        raise ValueError("Review gameplay/mod.json against the updated upstream manifest")
    subprocess.run(["git", "apply", str(MODE / "scripts/native-rifts.patch")], cwd=folder, check=True)


def main(verb, *options):
    if not (UPSTREAM / ".git").exists():
        raise ValueError("Run git submodule update --init mods/arena-pit/upstream")
    with tempfile.TemporaryDirectory(prefix="shattered-arena-") as temporary:
        folder = Path(temporary)
        stage(folder)
        runtime.require()
        if verb == "ready":
            return
        if verb == "dev":
            print(f"Watching the staged project in {folder}", flush=True)
            subprocess.run(runtime.command(folder, "dev", *options), check=True)
            return
        subprocess.run(runtime.command(folder, "build"), check=True)
        built = folder / "build"
        if verb == "test":
            manifest = json.loads((built / "mod.json").read_text())
            if not (built / manifest["entry"]).is_file() or not (built / "maps" / (manifest["map"] + ".vpk")).is_file():
                raise ValueError("Expected compiled gameplay and the declared map")
            if (built / "particles").exists():
                raise ValueError("The release should reference the game’s installed portal effects")
            return
        shutil.copy2(folder / "LICENSE", built / "LICENSE")
        if verb == "play":
            subprocess.run(runtime.command(folder, "play", "--watch=false", *options), check=True)
            return
        if verb != "build":
            raise ValueError(f"Unknown action {verb}")
        output = PROJECT / "build"
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(built, output)


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f"Shattered Arena: {error}")
