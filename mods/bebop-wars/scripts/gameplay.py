#!/usr/bin/env python3
"""Stage, build, test and run Bebop Wars without installing over game files. scripts/modes.py runs these verbs for
every mode."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "gameplay"
AUTHORED = ROOT / "content/citadel_addons/bebop_wars"
OUTPUT = ROOT / ".local/gameplay"
MAP = ROOT / ".local/packages/winter_arena.vpk"
COMPILED = ROOT / ".local/compiled/bebop_wars"
LOCAL_PREFIXES = ("materials/mapping/", "materials/bebop_wars/", "models/bebop_wars/", "particles/bebop_wars/")
ASSET_KINDS = ("panorama", "materials", "models", "particles", "sounds", "data")
METADATA = ("mod.json", "arena.lock.json")
UI_KINDS = ("layout", "styles", "scripts")

_spec = importlib.util.spec_from_file_location("modlock_runtime", ROOT.parents[1] / "scripts/runtime.py")
modlock_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(modlock_runtime)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text())


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def map_sources() -> list:
    return ["-compiled", COMPILED, "-authored", AUTHORED, *(flag for prefix in LOCAL_PREFIXES for flag in ("-local", prefix))]


def package_map() -> None:
    MAP.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="package-", dir=MAP.parent) as temporary:
        package = Path(temporary) / MAP.name
        print(modlock_runtime.map_tool("pack", *map_sources(), COMPILED / "maps/winter_arena.vpk", package), end="")
        package.replace(MAP)
    print(f"{MAP}\nSHA256: {digest(MAP)}. Review gameplay/arena.lock.json before staging it.")


def verify_map() -> dict:
    lock = read_json(PROJECT / "arena.lock.json")
    source = AUTHORED / "maps/winter_arena.vmap"
    if not MAP.is_file():
        raise FileNotFoundError("Missing .local/packages/winter_arena.vpk. Compile and package the authored map first.")
    if digest(source) != lock["sourceSha256"]:
        raise ValueError("The arena source changed. Recompile and review arena.lock.json before staging it.")
    if digest(MAP) != lock["packageSha256"]:
        raise ValueError("The map package differs from arena.lock.json; do not use an unverified or stale package.")
    sdk = subprocess.check_output(["git", "-C", str(ROOT / "tools/modlock-sdk"), "rev-parse", "HEAD"], text=True).strip()
    if sdk != lock["sdkCommit"]:
        raise ValueError("The SDK revision differs from the arena's verified build")
    checked = json.loads(modlock_runtime.map_tool("check", *map_sources(), "-require", "maps/winter_arena/world.vwrld_c", MAP))
    if checked["resources"] != lock["resources"]:
        raise ValueError("The map resource count differs from the verified package")
    return {"resources": checked["resources"], "sha256": digest(MAP), "bytes": MAP.stat().st_size}


def effect_state(source: Path, previous: dict, sdk: str):
    relative = source.relative_to(AUTHORED)
    target = COMPILED / (str(relative) + "_c")
    expected = {"sourceSha256": digest(source), "sdkCommit": sdk}
    return relative, target, expected, target.is_file() and previous.get(str(relative), {}) == {**expected, "compiledSha256": digest(target)}


def equipment_effects() -> list[Path]:
    sources = sorted((AUTHORED / "particles/gameplay").glob("*.vpcf"))
    stamp = OUTPUT / "effects.json"
    previous = read_json(stamp) if stamp.is_file() else {}
    current = {}
    compiled = []
    sdk = read_json(PROJECT / "arena.lock.json")["sdkCommit"]
    for source in sources:
        relative, target, expected, fresh = effect_state(source, previous, sdk)
        if not fresh:
            log = OUTPUT / (source.stem + "-build.log")
            with tempfile.TemporaryDirectory(prefix="effect-backup-", dir=OUTPUT) as temporary:
                backup = Path(temporary) / target.name
                if target.is_file():
                    target.replace(backup)
                try:
                    with log.open("w") as stream:
                        subprocess.run([sys.executable, str(ROOT / "scripts/project.py"), "compile", "--asset", str(relative)],
                                       stdout=stream, stderr=subprocess.STDOUT, check=True)
                    if not target.is_file() or target.stat().st_size < 32:
                        raise ValueError(f"The compiler did not produce {target}; inspect {log}")
                except BaseException:
                    if backup.is_file():
                        backup.replace(target)
                    raise
        current[str(relative)] = {**expected, "compiledSha256": digest(target)}
        compiled.append(target)
    if not any(effect.name == "bebop_rescue_pulse.vpcf_c" for effect in compiled):
        raise ValueError("The authored rescue pulse effect is required")
    write_json(stamp, current)
    return compiled


def stage() -> dict:
    verified = verify_map()
    effects = equipment_effects()
    images = panorama_images()
    (PROJECT / "maps").mkdir(exist_ok=True)
    target = PROJECT / "maps/winter_arena.vpk"
    if not target.exists() or digest(target) != verified["sha256"]:
        shutil.copyfile(MAP, target)
    with tempfile.TemporaryDirectory(prefix="content-", dir=OUTPUT) as temporary:
        staged = Path(temporary)
        panorama = AUTHORED / "panorama"
        if panorama.is_dir():
            for kind in UI_KINDS:
                source = panorama / kind
                if source.is_dir():
                    shutil.copytree(source, staged / kind)
        for source, relative in images:
            target = staged / "images" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (staged / "particles").mkdir()
        for effect in effects:
            shutil.copyfile(effect, staged / "particles" / effect.name)
        existing = PROJECT / "content"
        if existing.is_dir():
            shutil.rmtree(existing)
        shutil.copytree(staged, existing)
    return verified


def stage_ui() -> None:
    for kind in UI_KINDS:
        source, target = AUTHORED / "panorama" / kind, PROJECT / "content" / kind
        if target.exists():
            shutil.rmtree(target)
        if source.is_dir():
            shutil.copytree(source, target)


def image_state():
    panorama = AUTHORED / "panorama"
    sources = sorted((panorama / "images").rglob("*.png"))
    if not sources:
        return [], {}, True
    manifest = panorama / "images.xml"
    expected = {str(p.relative_to(panorama)): digest(p) for p in [manifest, *sources]}
    expected["sdkCommit"] = read_json(PROJECT / "arena.lock.json")["sdkCommit"]
    images = [(COMPILED / "panorama/images" / p.relative_to(panorama / "images").with_name(p.stem + "_png.vtex_c"),
               p.relative_to(panorama / "images").with_name(p.stem + "_png.vtex_c")) for p in sources]
    stamp = OUTPUT / "images.json"
    previous = read_json(stamp) if stamp.is_file() else {}
    compiled = {str(relative): digest(path) for path, relative in images if path.is_file()}
    return images, expected, len(compiled) == len(images) and previous == {"sources": expected, "compiled": compiled}


def panorama_images() -> list[tuple[Path, Path]]:
    images, expected, fresh = image_state()
    stamp = OUTPUT / "images.json"
    if not fresh:
        sys.path.insert(0, str(ROOT / "scripts/mapping"))
        from runtime import SDK, compiler_run, environment, prepare, win
        profile = prepare()
        env, proton = environment()
        with tempfile.TemporaryDirectory(prefix="images-backup-", dir=OUTPUT) as temporary:
            backups = []
            for index, (path, _) in enumerate(images):
                if path.is_file():
                    backup = Path(temporary) / str(index)
                    path.replace(backup)
                    backups.append((backup, path))
            try:
                compiler_run([proton, "runinprefix", SDK / "game/bin/win64/resourcecompiler.exe", "-game", win(profile),
                              "-i", win(SDK / "content/citadel_addons/bebop_wars/panorama/images.xml"), "-nop4", "-f"],
                             env, OUTPUT / "images-build.log")
                for path, _ in images:
                    if not path.is_file() or path.stat().st_size < 32:
                        raise ValueError(f"The UI image compiler did not produce {path}")
            except BaseException:
                for backup, path in backups:
                    backup.replace(path)
                raise
        write_json(stamp, {"sources": expected, "compiled": {str(relative): digest(path) for path, relative in images}})
    return images


def project_sources(*, development: bool = False):
    excluded = {"build", "node_modules", "maps", "content"}
    if not development:
        excluded.add("development")
    for root, directories, files in os.walk(PROJECT):
        directories[:] = [name for name in directories if name not in excluded and not name.startswith(".")]
        for name in files:
            path = Path(root) / name
            if path.suffix in {".ts", ".tsx", ".json"} and not name.endswith(".test.ts"):
                yield path


def copy_sources(project: Path) -> None:
    for source in project_sources(development=True):
        target = project / source.relative_to(PROJECT)
        if source.name == "tsconfig.json" and source.parent == PROJECT:
            continue
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    entry = project / "main.ts"
    if not entry.is_file() or entry.read_text() != "import './development/main.ts'\n":
        entry.write_text("import './development/main.ts'\n")


@contextmanager
def development_project():
    with tempfile.TemporaryDirectory(prefix="development-", dir=OUTPUT) as temporary:
        project = Path(temporary)
        copy_sources(project)
        config = read_json(PROJECT / "tsconfig.json")
        for name, paths in config["compilerOptions"]["paths"].items():
            config["compilerOptions"]["paths"][name] = [str((PROJECT / path).resolve()) for path in paths]
        config["include"] = [str((PROJECT / path).resolve()) if path.startswith("../") else path
                             for path in config["include"]]
        config["include"].append("development/**/*.ts")
        write_json(project / "tsconfig.json", config)
        for name in ("maps", "content"):
            shutil.copytree(PROJECT / name, project / name)
        yield project


def inputs_digest() -> str:
    files = list(project_sources())
    panorama = AUTHORED / "panorama"
    if panorama.is_dir():
        files.extend(path for path in panorama.rglob("*") if path.is_file())
    files.extend((AUTHORED / "particles/gameplay").glob("*.vpcf"))
    integration = ROOT / "scripts/gameplay.py"
    if integration.is_file():
        files.append(integration)
    result = hashlib.sha256()
    for path in sorted(files):
        result.update(str(path.relative_to(ROOT)).encode() + b"\0")
        result.update(path.read_bytes())
    result.update(b"runtime.json\0" + modlock_runtime.PIN_PATH.read_bytes())
    return result.hexdigest()


def runtime(*arguments: str) -> None:
    subprocess.run(modlock_runtime.command(ROOT, *arguments), check=True)


def probe_passed(output: str, code: int, teams: str) -> bool:
    return code == 0 and "[BebopWarsProbe] FAIL" not in output and f"[BebopWarsProbe] PASS complete teams={teams}" in output


def probe(options: list[str], teams: str) -> None:
    path = OUTPUT / "probe-last.log"
    with path.open("w") as log:
        process = subprocess.Popen(modlock_runtime.command(ROOT, *options), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert process.stdout is not None
        try:
            for line in process.stdout:
                print(line, end="", flush=True)
                log.write(line)
                log.flush()
            code = process.wait()
        except BaseException:
            process.terminate()
            process.wait(timeout=20)
            raise
    output = path.read_text()
    if not probe_passed(output, code, teams):
        raise RuntimeError(f"Native probe did not pass; inspect {path}")


def content_hashes() -> dict[str, str]:
    build = PROJECT / "build"
    return {str(path.relative_to(build)): digest(path)
            for kind in ASSET_KINDS for path in sorted((build / kind).rglob("*")) if path.is_file()}


def verify_build() -> dict:
    verified = verify_map()
    build = PROJECT / "build"
    manifest = read_json(build / "mod.json")
    record = read_json(OUTPUT / "build.json")
    if record["inputsSha256"] != inputs_digest():
        raise ValueError("Gameplay inputs changed after the last build. Run the build command again.")
    if record.get("metadataSha256") != {name: digest(build / name) for name in METADATA}:
        raise ValueError("Built rules or package metadata changed after the last build.")
    if manifest.get("map") != "winter_arena" or manifest.get("runtime") != "RUNTIME_QUICKJS":
        raise ValueError("Unexpected map or runtime in the compiled mode")
    entry = build / manifest["entry"]
    if not entry.resolve().is_relative_to(build.resolve()) or not entry.is_file():
        raise ValueError("The compiled entry is missing or outside the package")
    if digest(entry) != record["entrySha256"]:
        raise ValueError("The compiled entry differs from the recorded build")
    if digest(build / "maps/winter_arena.vpk") != record["mapSha256"] or verified["sha256"] != record["mapSha256"]:
        raise ValueError("The built mode does not contain the verified map")
    if content_hashes() != record["contentSha256"]:
        raise ValueError("Compiled client content differs from the recorded build")
    return manifest


def build() -> None:
    verified = stage()
    before = inputs_digest()
    runtime("build", str(PROJECT))
    if before != inputs_digest():
        raise RuntimeError("Gameplay inputs changed while building; rebuild after the edit finishes")
    manifest = read_json(PROJECT / "build/mod.json")
    entry = PROJECT / "build" / manifest["entry"]
    shutil.copyfile(PROJECT / "arena.lock.json", PROJECT / "build/arena.lock.json")
    write_json(OUTPUT / "build.json", {
        "inputsSha256": before,
        "entrySha256": digest(entry),
        "mapSha256": verified["sha256"],
        "contentSha256": content_hashes(),
        "metadataSha256": {name: digest(PROJECT / "build" / name) for name in METADATA},
    })
    verify_build()


def ready() -> list[str]:
    problems = []
    try:
        modlock_runtime.require()
    except RuntimeError as error:
        problems.append(str(error))
    try:
        verify_map()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        problems.append(f"{error} The arena's build needs the mapping tools, Proton and a desktop session.")
        return problems
    sdk = read_json(PROJECT / "arena.lock.json")["sdkCommit"]
    stamp = OUTPUT / "effects.json"
    previous = read_json(stamp) if stamp.is_file() else {}
    stale = [str(relative) for relative, _, _, fresh in (effect_state(source, previous, sdk)
             for source in sorted((AUTHORED / "particles/gameplay").glob("*.vpcf"))) if not fresh]
    if not image_state()[2]:
        stale.append("panorama/images")
    if stale:
        problems.append(f"{', '.join(stale)} changed since their last compile, which needs the asset toolkit and Proton")
    return problems


def test() -> None:
    tools = ROOT / ".tools/modlock/node_modules/.bin"
    if not tools.is_dir():
        raise RuntimeError("The runtime's packages are missing. Run python3 scripts/runtime.py install")
    tests = sorted(PROJECT.glob("*.test.ts"))
    if not tests:
        raise FileNotFoundError("No gameplay tests found")
    subprocess.run(["node", "--experimental-strip-types", "--test", *map(str, tests)], cwd=ROOT, check=True)
    subprocess.run([str(tools / "tsrs"), "--noEmit", "-p", "tsconfig.json"], cwd=PROJECT, check=True)
    subprocess.run([sys.executable, "-m", "unittest", "-q", "scripts/test_gameplay_package.py"], cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ready", "stage", "build", "check", "test", "dev", "play", "practice", "probe", "preview",
                                            "showcase", "showcase-sync", "package-map"))
    parser.add_argument("--teams", choices=("1v1", "2v2", "3v3"), default="2v2")
    parser.add_argument("--practice", action="store_true", help="with dev, a 1v1 with the practice bot")
    parser.add_argument("--no-game", action="store_true")
    parser.add_argument("--host", action="store_true", help="Share a Modlock join code")
    args = parser.parse_args()
    if args.host and args.command != "play":
        parser.error("--host is only available with play")
    if args.practice and args.command != "dev":
        parser.error("--practice is only available with dev; the practice command is the built one")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.command == "package-map":
        package_map()
    elif args.command == "ready":
        problems = ready()
        print("\n".join(problems))
        sys.exit(1 if problems else 0)
    elif args.command == "stage":
        print(json.dumps(stage(), indent=2))
    elif args.command == "build":
        build()
    elif args.command == "check":
        print(json.dumps(verify_build(), indent=2))
    elif args.command == "test":
        test()
    elif args.command == "dev":
        verify_build()
        practice = args.practice
        options = ["play", "--watch=true", "--arg", f"teams={'1v1' if practice else args.teams}", *(["--arg", "practice"] if practice else []),
                   *(["--no-game"] if args.no_game else []), str(PROJECT)]
        sys.exit(modlock_runtime.run_following(modlock_runtime.command(ROOT, *options),
                                               [AUTHORED / "panorama" / kind for kind in UI_KINDS], stage_ui))
    elif args.command == "showcase":
        stage()
        os.environ["XDG_CONFIG_HOME"] = str(ROOT / ".local/showcase/config")
        marker = ROOT / ".local/showcase/project"
        with development_project() as project:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(str(project))
            try:
                runtime("play", "--watch=true", "--no-game", "--arg", "showcase", "--arg", f"teams={args.teams}", str(project))
            finally:
                marker.unlink(missing_ok=True)
    elif args.command == "showcase-sync":
        marker = ROOT / ".local/showcase/project"
        if not marker.is_file():
            raise RuntimeError("No showcase server is running")
        copy_sources(Path(marker.read_text()))
    elif args.command in ("preview", "probe"):
        stage()
        with development_project() as project:
            if args.command == "preview":
                runtime("dev", "--sandbox", "--no-game", "--arg", "preview", "--arg", f"teams={args.teams}",
                        "--preview-port", "4322", str(project))
            else:
                runtime("build", str(project))
                probe(["play", "--watch=false", "--no-game", "--arg", "probe", "--arg", f"teams={args.teams}",
                       str(project / "build")], args.teams)
    else:
        verify_build()
        teams = "1v1" if args.command == "practice" else args.teams
        options = ["play", "--watch=false", "--arg", f"teams={teams}"]
        if args.command == "practice":
            options.extend(["--arg", "practice"])
        if args.no_game:
            options.append("--no-game")
        if args.host:
            options.append("--host")
        runtime(*options, str(PROJECT / "build"))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
