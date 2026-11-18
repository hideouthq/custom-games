#!/usr/bin/env python3

import configparser
from fnmatch import fnmatchcase
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MODS = {
    "bebop-wars": ("bebop_wars", "winter_arena", "gameplay/arena.lock.json", "sdkCommit"),
    "rooftop-rally": ("new_deadlock_game", "rooftop_arena", "project.json", "sdkRevision"),
    "pillars": ("pillars", "pillars_arena", "project.json", "sdkRevision"),
}
COMMUNITY_MODE = "arena-pit"
COMMUNITY_LINK = f"mods/{COMMUNITY_MODE}/upstream"
ROOT_FILES = {"README.md", "LICENSE", ".gitignore", ".gitattributes", ".gitmodules", "runtime.json", "release.json"}
ROOT_DIRS = {"feed", "mods", "scripts", "upcoming", ".github"}
PRIVATE_DIRS = {
    ".tools", ".local", ".private", ".cache", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".playwright-cli",
    "userdata", "steamapps", "build",
}
PRIVATE_FILES = (
    "*.pyc", "*.log", "*.dmp", "*.mdmp", "exceptions.txt",
    "*.vmap_autosave", "*.vmap_backup", "*_c", "*.exe", "*.dll", "*.so",
    "*.dylib", "*.vpk", "*.zip", "*.7z", "*.tar", "*.gz", "*.xz",
    ".env", ".env.*", "*.key", "*.pem", "*.p12", "*.pfx", "ssfn*",
    "loginusers.vdf", "config.vdf", ".DS_Store",
)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def staged_text(path):
    return git("show", f":{path}").decode("utf-8")


def main():
    entries = {}
    errors = []
    for record in git("ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, name = record.decode("utf-8").split("\t", 1)
        mode, revision, stage = metadata.split()
        entries[name] = (mode, revision)
        path = PurePosixPath(name)
        parts = path.parts
        if stage != "0":
            errors.append(f"Unmerged index entry: {name}")
        if (len(parts) == 1 and name not in ROOT_FILES) or (
            len(parts) > 1 and parts[0] not in ROOT_DIRS
        ):
            errors.append(f"Unexpected repository path: {name}")
        if parts[0] == "mods" and (len(parts) < 3 or parts[1] not in {*MODS, COMMUNITY_MODE}):
            errors.append(f"Unexpected mode path: {name}")
        if mode == "120000":
            errors.append(f"Tracked symlink is outside the source layout: {name}")
        if set(parts) & PRIVATE_DIRS or any(
            fnmatchcase(path.name, pattern) for pattern in PRIVATE_FILES
        ) and path.name != ".env.example":
            errors.append(f"Generated or private path: {name}")
        if any(
            pair in ("gameplay/content", "gameplay/maps", "docs/evidence")
            for pair in ("/".join(parts[i:i + 2]) for i in range(len(parts) - 1))
        ):
            errors.append(f"Generated or capture directory: {name}")
        if path.name == ".gitmodules" and len(parts) != 1:
            errors.append(f"Submodule entries belong in root .gitmodules: {name}")

    expected_links = {f"mods/{name}/tools/modlock-sdk" for name in MODS}
    expected_links.add(COMMUNITY_LINK)
    actual_links = {path for path, (mode, _) in entries.items() if mode == "160000"}
    if actual_links != expected_links:
        errors.append("Gitlinks differ from the expected mode dependencies")

    config = configparser.ConfigParser(interpolation=None)
    if ".gitmodules" in entries:
        config.read_string(staged_text(".gitmodules"))
        declared = [config.get(section, "path", fallback="") for section in config.sections()]
        if len(declared) != len(expected_links) or set(declared) != expected_links:
            errors.append("Root .gitmodules must declare exactly the mode dependency paths")
        for section in config.sections():
            expected_url = ("https://github.com/CosmicCapt/Shattered-Arena.git" if config.get(section, "path") == COMMUNITY_LINK
                            else "https://github.com/paralin/modlock-sdk.git")
            if config.get(section, "url", fallback="") != expected_url:
                errors.append(f"Unexpected dependency source in .gitmodules section {section}")
    else:
        errors.append("Missing staged root .gitmodules")

    for name, (addon, arena, pin_file, pin_field) in MODS.items():
        prefix = f"mods/{name}"
        pin_path = f"{prefix}/{pin_file}"
        manifest_path = f"{prefix}/gameplay/mod.json"
        required = {
            pin_path, manifest_path, f"{prefix}/gameplay/main.ts",
            f"{prefix}/content/citadel_addons/{addon}/maps/{arena}.vmap",
        }
        missing = required - entries.keys()
        errors.extend(f"Missing staged mode source: {path}" for path in sorted(missing))
        if missing:
            continue
        link = entries.get(f"{prefix}/tools/modlock-sdk")
        if not link or link[1] != json.loads(staged_text(pin_path)).get(pin_field):
            errors.append(f"SDK gitlink differs from {pin_field} in {pin_path}")
        if json.loads(staged_text(manifest_path)).get("map") != arena:
            errors.append(f"Custom map differs from the authored arena: {manifest_path}")

    if "runtime.json" not in entries:
        errors.append("Missing staged runtime.json")
    elif json.loads(staged_text("runtime.json")).get("upstream") != "https://github.com/hideouthq/modlock.git":
        errors.append("The runtime must be the maintained Modlock fork: runtime.json")

    if errors:
        print("Repository check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Checked {len(entries)} staged entries, {len(MODS) + 1} game modes and their dependencies.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, configparser.Error, subprocess.CalledProcessError) as error:
        sys.exit(f"Repository check failed: {error}")
