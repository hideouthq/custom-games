#!/usr/bin/env python3
"""Install the SDK tools, open Hammer, and compile this project's own assets."""
from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from common import ADDON, CONFIG, MAP, OUTPUT, ROOT, SDK, SOURCE, STAMP, TOOLS
from common import build_lock, digest, sdk_revision, source_hashes, windows_path, write_json


def steam_root():
    for path in (Path.home() / ".local/share/Steam", Path.home() / ".steam/steam"):
        if (path / "steamapps").is_dir():
            return path.resolve()
    return None


def installed() -> bool:
    state = TOOLS / ".cache/installed.json"
    return state.is_file() and bool(json.loads(state.read_text()).get("complete")) and \
        (TOOLS / "game/bin/win64/resourcecompiler.exe").is_file()


def profile_text(base: str, name: str) -> str:
    sys.path.insert(0, str(SDK / "scripts"))
    gameinfo = importlib.import_module("gameinfo")
    document = gameinfo.parse(base)

    def section(pairs, key):
        matches = [value for label, value in pairs if label.lower() == key.lower()]
        if len(matches) != 1 or isinstance(matches[0], str):
            raise ValueError(f"Expected one gameinfo {key} block")
        return matches[0]

    paths = section(section(section(document, "GameInfo"), "FileSystem"), "SearchPaths")
    for key in ("Mod", "Write", "Game"):
        matches = [index for index, (label, value) in enumerate(paths)
                   if label.lower() == key.lower() and value == "citadel"]
        if len(matches) != 1:
            raise ValueError(f"The SDK gameinfo {key} entry changed; review the generated profile")
        index = matches[0]
        if key == "Game":
            paths.insert(index, ("Game", f"citadel_addons/{ADDON}"))
        else:
            paths[index] = (key, name)
    return gameinfo.format_block(document)


def prepare() -> Path:
    if not installed():
        raise RuntimeError("The toolkit is not installed. Run python3 scripts/project.py install first")
    links = [(TOOLS / "content/citadel_addons" / ADDON, SOURCE),
             (TOOLS / "game/citadel_addons" / ADDON, OUTPUT)]
    for destination, source in links:
        if (destination.exists() or destination.is_symlink()) and destination.resolve() != source.resolve():
            raise RuntimeError(f"Refusing to replace an existing addon directory: {destination}")
    for destination, source in links:
        source.mkdir(parents=True, exist_ok=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.is_symlink():
            destination.symlink_to(source, target_is_directory=True)
    profile = TOOLS / "game" / f"{ADDON}_tools"
    profile.mkdir(parents=True, exist_ok=True)
    base = (TOOLS / "game/citadel/gameinfo.gi").read_text()
    # VRAD discovers gameinfo from Write/_vrad3, so Mod and Write must share this profile.
    (profile / "gameinfo.gi").write_text(profile_text(base, profile.name))
    return profile


def runtime(proton_override: Path | None):
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise RuntimeError("Run editor/compiler commands from the graphical desktop session")
    steam = steam_root()
    if steam is None:
        raise RuntimeError("Steam was not found in ~/.local/share/Steam or ~/.steam/steam")
    proton = proton_override or steam / "steamapps/common/Proton - Experimental/proton"
    if not proton.is_file():
        raise RuntimeError("Install Proton Experimental or pass --proton /path/to/proton")
    prefix = ROOT / ".local/editor-proton"
    prefix.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(STEAM_COMPAT_DATA_PATH=str(prefix), STEAM_COMPAT_CLIENT_INSTALL_PATH=str(steam),
               SteamAppId="0", SteamGameId="0")
    return proton, env


def ensure_map_closed() -> None:
    xdotool = shutil.which("xdotool")
    if xdotool is None:
        raise RuntimeError("Install xdotool so the build can check whether this map is open in Hammer")
    windows = subprocess.run([xdotool, "search", "--name", "^Hammer"], text=True,
                             capture_output=True, timeout=5)
    if windows.returncode not in (0, 1) or windows.stderr.strip():
        raise RuntimeError("Cannot check Hammer windows from this desktop session")
    for window in windows.stdout.split():
        title = subprocess.check_output([xdotool, "getwindowname", window], text=True, timeout=5)
        if MAP + ".vmap" in title:
            raise RuntimeError("Save and close this map in Hammer before compiling it externally")


def compile_map(proton_override: Path | None, fast: bool) -> None:
    ensure_map_closed()
    profile = prepare()
    proton, env = runtime(proton_override)
    before = source_hashes()
    map_source = SOURCE / "maps" / (MAP + ".vmap")
    if not map_source.is_file():
        raise FileNotFoundError(map_source)
    logs = ROOT / ".private/build-logs"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not (Path(env["STEAM_COMPAT_DATA_PATH"]) / "pfx/system.reg").is_file():
        with (logs / "prefix.log").open("w") as output:
            subprocess.run([str(proton), "run", "cmd.exe", "/c", "exit", "0"], env=env,
                           stdout=output, stderr=subprocess.STDOUT, check=True)
    STAMP.unlink(missing_ok=True)
    assets = [path for suffix in ("*.vmat", "*.vpcf", "*.vmdl") for path in sorted(SOURCE.rglob(suffix))]
    flags = ["-fshallow", "-world", "-phys", "-nolightmaps"] if fast else [
        "-fshallow", "-world", "-phys", "-vis", "-bakedlighting", "-bakelighting",
        "-lightmapMaxResolution", "4096", "-lightmapVRadQuality", "2"]
    for index, (asset, options) in enumerate([(asset, ["-f"]) for asset in assets] + [(map_source, flags)]):
        logical = TOOLS / "content/citadel_addons" / ADDON / asset.relative_to(SOURCE)
        log = logs / f"{index:03d}-{asset.stem}.log"
        command = [str(proton), "runinprefix", str(TOOLS / "game/bin/win64/resourcecompiler.exe"),
                   "-game", windows_path(profile), "-i", windows_path(logical), "-nop4", *options]
        print(f"Compiling {asset.relative_to(SOURCE)}. Log: {log}", flush=True)
        expected = OUTPUT / asset.relative_to(SOURCE)
        expected = expected.with_suffix(".vpk") if asset == map_source else Path(str(expected) + "_c")
        with tempfile.TemporaryDirectory(dir=ROOT / ".local/build", prefix="previous-") as temporary:
            backup = Path(temporary) / expected.name
            if expected.is_file():
                expected.replace(backup)
            try:
                with log.open("w") as output:
                    result = subprocess.run(command, cwd=TOOLS / "game/bin/win64", env=env,
                                            stdout=output, stderr=subprocess.STDOUT)
                report = log.read_text(errors="replace")
                if result.returncode or re.search(r"\b[1-9][0-9]* failed\b", report) or "referencing missing material" in report:
                    raise RuntimeError(f"Compilation failed. Inspect {log}")
                if not expected.is_file() or expected.stat().st_size < 32:
                    raise RuntimeError(f"The compiler did not create {expected}. Inspect {log}")
            except BaseException:
                if backup.is_file():
                    backup.replace(expected)
                raise
    package = OUTPUT / "maps" / (MAP + ".vpk")
    if not package.is_file() or package.stat().st_size < 32:
        raise RuntimeError("The compiler did not produce the project's map VPK")
    if source_hashes() != before:
        raise RuntimeError("Sources changed during compilation. Rebuild before staging")
    compiled = {str(path.relative_to(OUTPUT)): digest(path) for path in sorted(OUTPUT.rglob("*"))
                if path.is_file() and (path.name.endswith("_c") or path == package)}
    write_json(STAMP, {"map": MAP, "sdkRevision": sdk_revision(), "config": digest(ROOT / "project.json"),
                       "sources": before, "compiled": compiled, "lighting": "fast" if fast else "baked"})
    print(f"Compiled {package}. Editor rendering and live gameplay are separate checks.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("doctor", "install", "link-addon", "hammer", "compile"))
    parser.add_argument("--proton", type=Path)
    parser.add_argument("--fast", action="store_true", help="compile geometry without baked lighting")
    args = parser.parse_args()
    sdk_revision()
    if args.action == "doctor":
        print(json.dumps({"root": str(ROOT), "sdkRevision": CONFIG["sdkRevision"],
                          "toolkitInstalled": installed(), "source": str(SOURCE), "output": str(OUTPUT),
                          "steam": str(steam_root()), "uv": shutil.which("uv"),
                          "xdotool": shutil.which("xdotool")}, indent=2))
    elif args.action == "install":
        uv = shutil.which("uv")
        if uv is None:
            raise RuntimeError("Install uv from https://docs.astral.sh/uv/ first")
        env = os.environ.copy()
        env.update(UV_CACHE_DIR=str(ROOT / ".tools/uv-cache"),
                   UV_PYTHON_INSTALL_DIR=str(ROOT / ".tools/python"))
        subprocess.run([uv, "run", "--no-project", "--python", "3.14", str(SDK / "scripts/install.py"),
                        "--destination", str(TOOLS)], cwd=ROOT, env=env, check=True)
    elif args.action == "hammer":
        prepare()
        proton, env = runtime(args.proton)
        sys.path.insert(0, str(SDK / "scripts"))
        flags = importlib.import_module("toolkit").EDITOR_ARGS
        subprocess.run([str(proton), "run", str(TOOLS / "game/bin/win64/sdk-launcher.exe"),
                        *flags, "-addon", ADDON, "-asset", f"maps/{MAP}.vmap", "+show_tool", "hammer"],
                       cwd=TOOLS / "game/bin/win64", env=env, check=True)
    else:
        with build_lock():
            if args.action == "link-addon":
                print(prepare())
            else:
                compile_map(args.proton, args.fast)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(f"project: {error}")
