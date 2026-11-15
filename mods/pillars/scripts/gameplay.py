#!/usr/bin/env python3
"""Stage a verified custom map, then build, test or run this mode. scripts/modes.py runs these verbs for every mode."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from common import MAP, OUTPUT, ROOT, SOURCE, STAMP
from common import build_lock, digest, sdk_revision, source_hashes

sys.path.insert(0, str(ROOT.parents[1] / "scripts"))
import runtime  # noqa: E402

PROJECT = ROOT / "gameplay"


def verify() -> dict:
    if not STAMP.is_file():
        raise RuntimeError("No verified map build. Run python3 scripts/project.py compile first")
    record = json.loads(STAMP.read_text())
    manifest = json.loads((PROJECT / "mod.json").read_text())
    if manifest.get("map") != MAP or record.get("map") != MAP:
        raise ValueError("The gameplay manifest must name this project's compiled custom map")
    if record.get("sdkRevision") != sdk_revision() or record.get("config") != digest(ROOT / "project.json"):
        raise ValueError("Project configuration or SDK changed. Recompile the map")
    if record.get("sources") != source_hashes():
        raise ValueError("Authored sources changed. Recompile before staging or playing")
    compiled = record.get("compiled", {})
    for name, expected in compiled.items():
        path = OUTPUT / name
        if not path.resolve().is_relative_to(OUTPUT.resolve()):
            raise ValueError("Compiled output path escapes this project")
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"Compiled output is missing or changed: {name}. Recompile")
    package = OUTPUT / "maps" / (MAP + ".vpk")
    if f"maps/{MAP}.vpk" not in compiled:
        raise ValueError("The build record does not contain this project's map")
    runtime.map_tool("check", "-require", f"maps/{MAP}/world.vwrld_c", package)
    return record


def stage() -> dict:
    record = verify()
    stage_ui()
    local = ROOT / ".local/staging"
    local.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=local) as temporary:
        package = Path(temporary) / (MAP + ".vpk")
        print(runtime.map_tool("pack", "-compiled", OUTPUT, "-authored", SOURCE, "-record", STAMP,
                               OUTPUT / "maps" / package.name, package), end="")
        (PROJECT / "maps").mkdir(exist_ok=True)
        package.replace(PROJECT / "maps" / package.name)
    return record


def stage_ui() -> None:
    authored = SOURCE / "panorama"
    target = PROJECT / "content"
    if target.is_symlink():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)
    if authored.is_dir():
        shutil.copytree(authored, target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("ready", "stage", "build", "test", "play", "dev"))
    parser.add_argument("--no-game", action="store_true", help="run the server without opening Deadlock")
    parser.add_argument("--bots", type=int, default=0, help="fill empty seats with this many idle bots")
    parser.add_argument("--dev", action="store_true", help="enable the /pillars test commands")
    parser.add_argument("--port", type=int, default=27069, help="server UDP port (default: 27069)")
    parser.add_argument("--ui-port", type=int, default=4334, help="UI port; 0 disables it (default: 4334)")
    parser.add_argument("--preview-port", type=int, default=4336,
                        help="browser preview port; 0 disables it (default: 4336)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or any(not 0 <= port <= 65535 for port in (args.ui_port, args.preview_port)):
        parser.error("--port must be 1–65535; UI and preview ports must be 0–65535")
    if args.action == "ready":
        problems = runtime.mode_problems(verify)
        print("\n".join(problems))
        sys.exit(1 if problems else 0)
    if args.action == "test":
        runtime.test_sources(ROOT)
        return
    with build_lock():
        record = stage()
        if args.action == "stage":
            print(json.dumps({"map": MAP, "lighting": record["lighting"], "compiledFiles": len(record["compiled"])}, indent=2))
            return
        if args.action in ("build", "play"):
            subprocess.run(runtime.command(PROJECT, "build"), check=True)
            if args.action == "build":
                return
    options = ["dev", "--watch"] if args.action == "dev" else ["play", "--watch=false"]
    options.extend(["--port", str(args.port), "--ui-port", str(args.ui_port),
                    "--preview-port", str(args.preview_port)])
    if args.no_game:
        options.append("--no-game")
    if args.bots:
        options.extend(["--arg", f"bots={args.bots}"])
    if args.dev:
        options.extend(["--arg", "dev"])
    if args.action == "dev":
        sys.exit(runtime.run_following(runtime.command(PROJECT, *options), [SOURCE / "panorama"], stage_ui))
    subprocess.run(runtime.command(PROJECT, *options), check=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(f"gameplay: {error}")
