#!/usr/bin/env python3
"""The one entry point for every mode: the same verbs for each, the checks that need no game, and publishing.

  test [MODE...]     unit tests and typecheck, and the format check where a mode has one
  ready [MODE...]    what this computer still lacks for build, found without building
  build [MODE...]    gameplay/build with the listing and its art: the folder Hideout hosts and the feed packages
  dev MODE ...       a live session; saved gameplay and authored UI reload without a restart
  play MODE ...      a session of the built mode
  check              every check that needs no game: every mode, the feed publisher, release.json and the runtime pin
  publish            Hideout's custom games feed from release.json: a dry run unless --key and --upload

With no MODE, test, ready and build take every mode. dev and play pass the flags they don't know to the mode, such
as --no-game, --bots 3 or --teams 1v1. publish also holds the runtime pin to the Modlock commit Hideout's link helper
imports when a Hideout checkout is at HIDEOUT_REPO, else ../hideout.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
MODS = REPO / "mods"
RELEASE = REPO / "release.json"
UPCOMING = REPO / "upcoming"
WORK = REPO / ".local/publish"
FEED = REPO / "feed"
sys.path[:0] = [str(REPO / "scripts"), str(FEED)]
import make_feed  # noqa: E402
import runtime  # noqa: E402


def modes() -> list[str]:
    return sorted(path.name for path in MODS.iterdir() if (path / "gameplay/mod.json").is_file())


def mode_command(mode: str, verb: str, *extra: str) -> list[str]:
    return [sys.executable, str(MODS / mode / "scripts/gameplay.py"), verb, *extra]


def listing_into_build(mode: str) -> Path:
    project = MODS / mode / "gameplay"
    build = project / "build"
    build.mkdir(exist_ok=True)
    shutil.copyfile(project / "hideout.json", build / "hideout.json")
    if (build / "art").exists():
        shutil.rmtree(build / "art")
    shutil.copytree(project / "art", build / "art")
    return build


def ready(mode: str) -> list[str]:
    result = subprocess.run(mode_command(mode, "ready"), capture_output=True, text=True)
    return [line for line in result.stdout.splitlines() if line] or ([result.stderr.strip()] if result.returncode else [])


def build(mode: str) -> None:
    if subprocess.run(mode_command(mode, "build")).returncode:
        raise RuntimeError(f"{mode} did not build")
    listing_into_build(mode)


def listing_problems(where: str, path: Path, upcoming: bool = False) -> list[str]:
    try:
        listing = make_feed.read_json(path)
    except make_feed.Problem as error:
        return [f"{where}: {error}"]
    problems = [f"{where}: {path.name} {problem}" for problem in make_feed.listing_problems(listing, upcoming=upcoming)]
    return problems or make_feed.art_problems(where, path.parent.resolve(), listing)


def release_problems() -> list[str]:
    release = json.loads(RELEASE.read_text())
    named = release["modes"] + release["upcoming"]
    problems = [f"release.json names {name} twice" for name in sorted({name for name in named if named.count(name) > 1})]
    for mode in release["modes"]:
        manifest_path = MODS / mode / "gameplay/mod.json"
        if not manifest_path.is_file():
            problems.append(f"{mode}: release.json names it, but there is no {manifest_path.relative_to(REPO)}")
            continue
        manifest = json.loads(manifest_path.read_text())
        if not make_feed.MODE_ID.fullmatch(mode):
            problems.append(f"{mode}: a feed id is lower-case letters, digits, '.', '_' or '-', at most 64")
        if manifest.get("slug") != mode:
            problems.append(f"{mode}: mod.json's slug is {manifest.get('slug')!r}, and a feed id must be its mode's slug")
        if not make_feed.FILE_NAME_PART.fullmatch(str(manifest.get("version", ""))):
            problems.append(f"{mode}: mod.json's version {manifest.get('version')!r} names files, so it holds only letters, digits, '.', '_', '+' and '-'")
        problems += listing_problems(mode, MODS / mode / "gameplay/hideout.json")
    for name in release["upcoming"]:
        path = UPCOMING / f"{name}.json"
        problems += listing_problems(f"upcoming {name}", path, upcoming=True) if path.is_file() else [f"upcoming {name}: no {path.relative_to(REPO)}"]
    problems += [f"upcoming/{path.name} is not in release.json" for path in sorted(UPCOMING.glob("*.json")) if path.stem not in release["upcoming"]]
    return problems


def pin_problems() -> list[str]:
    pin = runtime.PIN
    problems = [f"runtime.json records no digest for {name}. Build the runtime with python3 scripts/runtime.py build"
                for name in runtime.FILES if name not in pin["files"]]
    if not pin["version"].startswith(pin["revision"][:7]):
        problems.append(f"runtime.json's version {pin['version']} does not name its revision {pin['revision'][:7]}")
    return problems


def helper_problems(hideout: Path) -> list[str]:
    revision = runtime.PIN["revision"]
    replace = re.search(r"^replace github\.com/paralin/modlock => github\.com/hideouthq/modlock (\S+)$",
                        (hideout / "tools/link/go.mod").read_text(), re.M)
    imported = replace.group(1) if replace else "nothing"
    if imported.endswith(f"-{revision[:12]}"):
        return []
    return [f"Hideout's helper at {hideout} imports Modlock {imported}, but runtime.json pins {revision[:12]}. Set "
            f"HIDEOUT_REPO to the checkout you release from, or move it with python3 scripts/runtime.py pin {revision}"]


def check() -> int:
    failed = []
    if subprocess.run([sys.executable, str(REPO / "scripts/check_repository.py")]).returncode:
        failed.append("the repository check")
    problems = release_problems() + pin_problems()
    for problem in problems:
        print(f"- {problem}", file=sys.stderr)
    if problems:
        failed.append("the release and runtime pins")
    for mode in modes():
        print(f"Testing {mode}", flush=True)
        if subprocess.run(mode_command(mode, "test")).returncode:
            failed.append(f"{mode}'s tests")
    for test in sorted((REPO / "scripts").glob("test_*.py")) + sorted(FEED.glob("test_*.py")):
        if subprocess.run([sys.executable, str(test)], cwd=REPO).returncode:
            failed.append(test.name)
    if failed:
        print(f"Check failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"Checked the repository, {len(modes())} modes, the feed publisher, release.json and the runtime pin")
    return 0


def release_document(release: dict, folders: dict[str, Path]) -> dict:
    pin = runtime.PIN

    def entry(name):
        return {"url": f"{runtime.RELEASES}/{pin['version']}/{name}", "file": str(runtime.files_dir() / name), "sha256": pin["files"][name]}

    return {
        "modlock": pin["version"],
        "cli": {"linux": entry(runtime.LINUX_CLI), "windows": entry(runtime.WINDOWS_CLI)},
        "host": entry(runtime.HOST_ZIP),
        "modes": [{"id": mode, "dir": str(folders[mode])} for mode in release["modes"]],
        "upcoming": [{"id": name, "listing": str(UPCOMING / f"{name}.json")} for name in release["upcoming"]],
    }


def publish(args) -> int:
    tool = [sys.executable, str(FEED / "publish.py")]
    if args.verify:
        return subprocess.run([*tool, "--verify"]).returncode
    problems = release_problems() + pin_problems()
    hideout = runtime.hideout()
    if hideout:
        problems += helper_problems(hideout)
    else:
        print("No Hideout checkout at HIDEOUT_REPO or ../hideout, so the runtime pin is not held to its link helper", flush=True)
    if problems:
        raise RuntimeError("\n".join(problems))
    release = json.loads(RELEASE.read_text())
    given = {}
    for item in args.mode:
        mode, _, folder = item.partition("=")
        if mode not in release["modes"] or not folder:
            raise RuntimeError(f"--mode {item}: give a mode release.json names and its built folder, as <id>=<folder>")
        given[mode] = Path(folder).resolve()
    runtime.runtime_files()
    building = [mode for mode in release["modes"] if mode not in given]
    paths = [RELEASE, runtime.PIN_PATH, UPCOMING, *(MODS / mode for mode in building)]
    uncommitted = subprocess.check_output(["git", "status", "--porcelain", "--", *map(str, paths)], cwd=REPO, text=True).splitlines()
    if uncommitted:
        raise RuntimeError("Commit these first, so what is published is a commit:\n" + "\n".join(uncommitted))
    lacking = [f"{mode}: {problem}" for mode in building for problem in ready(mode)]
    if lacking:
        raise RuntimeError("\n".join(lacking + ["Provide what is missing, or build those modes where they can be built and "
                                                "pass --mode <id>=<that gameplay/build folder>"]))
    for mode in building:
        build(mode)
    folders = {**{mode: MODS / mode / "gameplay/build" for mode in building}, **given}
    WORK.mkdir(parents=True, exist_ok=True)
    out = WORK / "out"
    if out.exists():
        shutil.rmtree(out)
    (WORK / "release.json").write_text(json.dumps(release_document(release, folders), indent=2) + "\n")
    commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, text=True).strip()
    print(f"Modes at {commit}, runtime {runtime.PIN['version']}. Built here: {', '.join(building) or 'none'}."
          + "".join(f" {mode} from {folder}." for mode, folder in given.items()), flush=True)
    command = [*tool, "--release", str(WORK / "release.json"), "--out", str(out)]
    if args.key:
        command += ["--key", args.key]
    if args.upload:
        command.append("--upload")
    return subprocess.run(command).returncode


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="verb", required=True)
    for verb in ("test", "ready", "build"):
        sub.add_parser(verb).add_argument("modes", nargs="*")
    for verb in ("dev", "play"):
        sub.add_parser(verb).add_argument("mode")
    sub.add_parser("check")
    publisher = sub.add_parser("publish")
    publisher.add_argument("--mode", action="append", default=[], metavar="ID=FOLDER",
                           help="publish a mode built elsewhere from its gameplay/build folder")
    publisher.add_argument("--key", help="the feed's private key; without it the run is a dry run")
    publisher.add_argument("--upload", action="store_true", help="upload in order and read the live feed back; needs --key")
    publisher.add_argument("--verify", action="store_true", help="only check the live feed and every file it names")
    args, extra = parser.parse_known_args(argv)
    if extra and args.verb not in ("dev", "play"):
        parser.error(f"unrecognized arguments: {' '.join(extra)}")
    named = [args.mode] if args.verb in ("dev", "play") else getattr(args, "modes", [])
    unknown = [mode for mode in named if mode not in modes()]
    if unknown:
        parser.error(f"no mode {', '.join(unknown)}; the modes are {', '.join(modes())}")
    if args.verb in ("dev", "play"):
        listing_into_build(args.mode)
        os.execv(sys.executable, mode_command(args.mode, args.verb, *extra))
    if args.verb == "check":
        return check()
    if args.verb == "publish":
        return publish(args)
    failed = []
    for mode in args.modes or modes():
        if args.verb == "ready":
            problems = ready(mode)
            print(f"{mode}: " + ("ready" if not problems else "\n  ".join(["needs"] + problems)))
            failed += [mode] if problems else []
        elif args.verb == "build":
            build(mode)
            print(f"Built {MODS / mode / 'gameplay/build'}")
        elif subprocess.run(mode_command(mode, "test")).returncode:
            failed.append(mode)
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f"modes: {error}")
