#!/usr/bin/env python3
"""The one Modlock runtime every mode runs on, pinned in runtime.json.

The runtime is three files: the Linux and Windows command lines and the Windows host bundle, the same files the custom
games feed names. `install` takes them from the site, where every published runtime stays, and checks each against the
digest runtime.json records. `build` makes them from the pinned revision instead, which a new pin needs once, before
its first publish. Toolchains, the checkout and every output stay in the repository's ignored .tools and .local.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parents[1]
PIN_PATH = REPO / "runtime.json"
PIN = json.loads(PIN_PATH.read_text())
SOURCE = REPO / ".tools/modlock"
TOOLS = REPO / ".tools/runtime-toolchains"
LOCAL = REPO / ".local/runtime"
BUILD = LOCAL / "host-build"
RELEASES = "https://hideouthq.gg/customgames/runtime"
LINUX_CLI, WINDOWS_CLI, HOST_ZIP = "modlock-linux-amd64", "modlock-windows-amd64.exe", "modlock-host-windows-x64.zip"
FILES = (LINUX_CLI, WINDOWS_CLI, HOST_ZIP)
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def files_dir() -> Path:
    return LOCAL / PIN["version"]


def cli() -> Path:
    return files_dir() / LINUX_CLI


def host() -> Path:
    return files_dir() / "host/modlock-host.exe"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def environment() -> dict[str, str]:
    env = os.environ.copy()
    bins = [str(TOOLS / tool["bin"]) for tool in PIN["toolchains"]]
    env.update({
        "PATH": os.pathsep.join(bins + [env.get("PATH", "")]),
        "GOCACHE": str(LOCAL / "go-build"),
        "GOPATH": str(LOCAL / "go"),
        "GOTOOLCHAIN": "local",
        "GOFLAGS": "-mod=mod",
        "XDG_CACHE_HOME": str(LOCAL / "cache"),
        "MODLOCK_HOST": str(host()),
        "MODLOCK_NO_UPDATE_CHECK": "1",
        "MODLOCK_PROTON_BUILD_DIR": str(BUILD),
    })
    if "MODLOCK_PROTON" not in env:
        proton = Path.home() / ".steam/steam/steamapps/common/Proton - Experimental"
        if (proton / "proton").is_file():
            env["MODLOCK_PROTON"] = str(proton)
    return env


def run(args, cwd=SOURCE, log=None, env=None) -> None:
    env = environment() if env is None else env
    if log is None:
        subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)
        return
    folder = LOCAL / "logs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / log
    print(f"Log: {path}", flush=True)
    with path.open("w") as stream:
        result = subprocess.run([str(a) for a in args], cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        print("\n".join(path.read_text(errors="replace").splitlines()[-40:]), file=sys.stderr)
        raise RuntimeError(f"Command failed ({result.returncode}); see {path}")


def capture(args, cwd=SOURCE) -> str:
    return subprocess.check_output(args, cwd=cwd, env=environment(), text=True).strip()


def install_tools() -> None:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise RuntimeError("This bootstrap supports Linux x86_64; the mode packages are portable.")
    TOOLS.mkdir(parents=True, exist_ok=True)
    for tool in PIN["toolchains"]:
        archive = TOOLS / tool["url"].rsplit("/", 1)[1]
        binary = TOOLS / tool["bin"] / tool["name"]
        if binary.is_file() and archive.is_file() and sha256(archive) == tool["sha256"]:
            continue
        if not archive.exists() or sha256(archive) != tool["sha256"]:
            print(f"Downloading {tool['name']} {tool['version']}", flush=True)
            download(tool["url"], archive, tool["sha256"])
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    if not (TOOLS / member.filename).resolve().is_relative_to(TOOLS.resolve()):
                        raise RuntimeError("Tool archive path escapes its directory")
                source.extractall(TOOLS)
            binary.chmod(0o755)
        else:
            with tarfile.open(archive) as source:
                source.extractall(TOOLS, filter="data")


def download(url: str, target: Path, digest: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "hideout-publish"})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
    except urllib.error.HTTPError as error:
        error.close()
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"{url} answered {error.code}") from None
    if sha256(partial) != digest:
        partial.unlink()
        raise RuntimeError(f"{url} is not the file runtime.json records (SHA-256 {digest})")
    partial.replace(target)


def prepare_source() -> None:
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    if not (SOURCE / ".git").exists():
        run(["git", "clone", PIN["upstream"], SOURCE], REPO)
    if capture(["git", "rev-parse", "HEAD"]) != PIN["revision"]:
        if capture(["git", "status", "--porcelain"]):
            raise RuntimeError("The Modlock checkout has local changes; cannot change its revision")
        run(["git", "fetch", PIN["upstream"], PIN["revision"]])
        run(["git", "checkout", "--detach", PIN["revision"]])
    run(["git", "submodule", "update", "--init", "--recursive"])
    run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], log="bun-install.log")
    run(["go", "run", "./cmd/modlock-library"], log="library-build.log")


def link_modes() -> None:
    for mode in sorted((REPO / "mods").iterdir()):
        link = mode / ".tools/modlock"
        if not (mode / "gameplay").is_dir() or (link.is_symlink() and link.resolve() == SOURCE.resolve()):
            continue
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            raise RuntimeError(f"{link} is a Modlock checkout of its own. Remove it; every mode now uses {SOURCE}")
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(SOURCE, link.parent), target_is_directory=True)


def runtime_files() -> dict[str, str]:
    recorded = PIN["files"]
    missing = [name for name in FILES if name not in recorded]
    if missing:
        raise RuntimeError(f"runtime.json records no digest for {', '.join(missing)} of {PIN['version']}. "
                           "Build the runtime with python3 scripts/runtime.py build")
    for name in FILES:
        path = files_dir() / name
        if path.is_file() and sha256(path) == recorded[name]:
            continue
        print(f"Downloading {name} of {PIN['version']}", flush=True)
        try:
            download(f"{RELEASES}/{PIN['version']}/{name}", path, recorded[name])
        except (RuntimeError, urllib.error.URLError) as error:
            raise RuntimeError(f"Cannot fetch runtime {PIN['version']} ({error}). If it was never published, build it "
                               "with python3 scripts/runtime.py build") from None
    return {name: recorded[name] for name in FILES}


def install_runtime() -> None:
    files = runtime_files()
    cli().chmod(cli().stat().st_mode | stat.S_IXUSR)
    unpacked = files_dir() / "host"
    with tempfile.TemporaryDirectory(dir=files_dir()) as temporary:
        staging = Path(temporary) / "host"
        with zipfile.ZipFile(files_dir() / HOST_ZIP) as archive:
            for member in archive.infolist():
                if not (staging / member.filename).resolve().is_relative_to(staging.resolve()):
                    raise RuntimeError("The host bundle names a path outside its folder")
            archive.extractall(staging)
        if unpacked.exists():
            shutil.rmtree(unpacked)
        staging.replace(unpacked)
    (files_dir() / "installed.json").write_text(json.dumps(files, indent=2) + "\n")


def require() -> None:
    stamp = files_dir() / "installed.json"
    if not stamp.is_file() or json.loads(stamp.read_text()) != PIN["files"] or not cli().is_file() or not host().is_file():
        raise RuntimeError(f"Runtime {PIN['version']} is not installed. Run python3 scripts/runtime.py install")


def command(cwd: Path, *arguments) -> list[str]:
    return [sys.executable, str(Path(__file__).resolve()), "exec", "--cwd", str(cwd), "--", *map(str, arguments)]


def hideout() -> Path | None:
    folder = Path(os.environ.get("HIDEOUT_REPO") or REPO.parent / "hideout").resolve()
    return folder if (folder / "tools/link/pin_modlock.py").is_file() else None


def mode_problems(verify_map) -> list[str]:
    problems = []
    try:
        require()
    except RuntimeError as error:
        problems.append(str(error))
    try:
        verify_map()
    except (OSError, ValueError, RuntimeError) as error:
        problems.append(f"{error}. A map compile needs the asset toolkit, Proton and a desktop session")
    return problems


def map_tool(*arguments) -> str:
    if not (SOURCE / "go.mod").is_file():
        raise RuntimeError("The runtime's checkout is missing. Run python3 scripts/runtime.py install")
    env = environment()
    if not shutil.which("go", path=env["PATH"]):
        raise RuntimeError("The runtime's Go is missing. Run python3 scripts/runtime.py install")
    result = subprocess.run(["go", "run", str(REPO / "scripts/package-map/main.go"), *map(str, arguments)],
                            cwd=SOURCE, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip().removesuffix("exit status 1").strip() or f"package-map {arguments[0]} failed")
    return result.stdout


def test_sources(root: Path) -> None:
    tools = SOURCE / "node_modules/.bin"
    if not tools.is_dir():
        raise RuntimeError("The runtime's packages are missing. Run python3 scripts/runtime.py install")
    for line in (["bun", "test", "--tsconfig-override", "tests/tsconfig.json", "tests"],
                 [tools / "tsrs", "--noEmit", "-p", "tests"],
                 [tools / "oxfmt", "--check", "gameplay/*.ts", "tests/*.ts"]):
        subprocess.run([str(part) for part in line], cwd=root, env=environment(), check=True)


def run_following(session: list[str], folders: list[Path], stage) -> int:
    def stamp(path):
        try:
            found = path.stat()
        except FileNotFoundError:
            return None
        return found.st_mtime_ns, found.st_size

    def snapshot():
        return {path: stamp(path) for folder in folders if folder.is_dir() for path in sorted(folder.rglob("*")) if path.is_file()}

    seen = snapshot()
    process = subprocess.Popen(session)
    try:
        while process.poll() is None:
            time.sleep(0.5)
            if (now := snapshot()) != seen:
                seen = now
                stage()
                print("Staged the authored UI; the session reloads it", flush=True)
    except KeyboardInterrupt:
        pass
    return process.wait()


def write_zip(folder: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w") as archive:
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, path.read_bytes())


def build() -> None:
    install_tools()
    prepare_source()
    out = LOCAL / "build-out"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for goos, name in (("linux", LINUX_CLI), ("windows", WINDOWS_CLI)):
        env = {**environment(), "CGO_ENABLED": "0", "GOOS": goos, "GOARCH": "amd64", "GOAMD64": "v1"}
        run(["go", "build", "-trimpath", "-ldflags", f"-X main.Version={PIN['version']}", "-o", out / name, "./cmd/modlock"],
            log=f"{goos}-cli-build.log", env=env)
    run(["bash", "scripts/proton-build.sh"], log="host-build.log")
    write_zip(BUILD / "sdk/bin", out / HOST_ZIP)
    built = {name: sha256(out / name) for name in FILES}
    if PIN["files"] and PIN["files"] != built:
        differ = ", ".join(name for name in FILES if PIN["files"].get(name) != built[name])
        raise RuntimeError(f"This build differs from the recorded {PIN['version']} in {differ}, and a published runtime's "
                           f"files are never replaced. The build is in {out}. To ship it, pin a new version first")
    if not PIN["files"]:
        PIN["files"] = built
        PIN_PATH.write_text(json.dumps(PIN, indent=2) + "\n")
        print(f"Recorded the digests of {PIN['version']} in {PIN_PATH.name}")
    files_dir().mkdir(parents=True, exist_ok=True)
    for name in FILES:
        (out / name).replace(files_dir() / name)
    install_runtime()


def resolve(ref: str) -> str:
    if len(ref) == 40 and all(c in "0123456789abcdef" for c in ref):
        return ref
    listed = subprocess.check_output(["git", "ls-remote", PIN["upstream"], f"refs/heads/{ref}", f"refs/tags/{ref}"],
                                     text=True).split()
    if not listed:
        raise RuntimeError(f"{PIN['upstream']} has no branch or tag {ref}; give a branch, a tag or a full commit")
    return listed[0]


def pin_revision(ref: str) -> None:
    revision = resolve(ref)
    checkout = hideout()
    if checkout is None:
        raise RuntimeError("There is no Hideout checkout with tools/link/pin_modlock.py at HIDEOUT_REPO or ../hideout. "
                           "Set HIDEOUT_REPO to one")
    if revision != PIN["revision"]:
        PIN.update(revision=revision, version=f"{revision[:7]}-hideout.1", files={})
        PIN_PATH.write_text(json.dumps(PIN, indent=2) + "\n")
    subprocess.run([sys.executable, str(checkout / "tools/link/pin_modlock.py"), revision], cwd=checkout, check=True)
    building = "" if PIN["files"] else "python3 scripts/runtime.py build, then "
    print(f"Pinned {PIN['version']} here and in Hideout's helper at {checkout}. "
          f"Next: {building}commit runtime.json here and tools/link there")


def test() -> None:
    require()
    run(["bun", "test", "js/test/command.test.ts"], log="command-tests.log")
    run(["go", "test", "./cmd/modlock-sdkgen", "./project"], log="generator-tests.log")
    run(["cmake", "-S", SOURCE, "-B", BUILD, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
         f"-DCMAKE_TOOLCHAIN_FILE={SOURCE / 'cmake/zig-windows.cmake'}", "-DBUILD_TESTING=ON"],
        log="native-test-configure.log")
    # The native tests build into one executable. These suites run under Proton without the game;
    # wasm_definition_changes_test resolves schema slots in a loaded schemasystem.dll, so it runs only in the fork's
    # Linux build.
    suites = ("AbilityUpgrades", "AbilityInputHook", "InputChangesTest", "ConsoleVariables")
    run(["cmake", "--build", BUILD, "--target", "modlock_tests", "--parallel", "4"], log="native-test-build.log")
    folder = LOCAL / "native-tests/bin"
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BUILD / "modlock_tests.exe", folder)
    for path in host().parent.glob("*.dll"):
        shutil.copy2(path, folder)
    env = environment()
    proton = Path(env.get("MODLOCK_PROTON", "")) / "proton"
    if not proton.is_file():
        raise RuntimeError("Set MODLOCK_PROTON to an installed Proton directory to run native tests")
    prefix = LOCAL / "test-prefix"
    prefix.mkdir(parents=True, exist_ok=True)
    env.update({"STEAM_COMPAT_DATA_PATH": str(prefix),
                "STEAM_COMPAT_CLIENT_INSTALL_PATH": str(Path.home() / ".steam/steam"),
                "SteamAppId": "0", "SteamGameId": "0", "WINEDEBUG": "-all"})
    report = folder / "modlock_tests.xml"
    report.unlink(missing_ok=True)
    run([proton, "run", folder / "modlock_tests.exe", "--gtest_filter=" + ":".join(f"{suite}.*" for suite in suites),
         f"--gtest_output=xml:{report.name}"], cwd=folder, log="native-tests.log", env=env)
    if not report.is_file():
        raise RuntimeError(f"Native test process returned without producing {report}")
    result = ET.parse(report).getroot()
    ran = {suite.get("name"): int(suite.get("tests", "0")) for suite in result.iter("testsuite")}
    if any(not ran.get(suite) for suite in suites) or any(int(result.get(key, "0")) for key in ("failures", "errors", "disabled")):
        raise RuntimeError(f"Native tests did not all pass: {report}")
    print(f"{result.get('tests')} native tests passed in {', '.join(suites)}. Report: {report}")


def doctor() -> None:
    env = environment()
    stamp = files_dir() / "installed.json"
    print(json.dumps({
        "revision": PIN["revision"], "version": PIN["version"], "source": str(SOURCE),
        "cli": str(cli()), "host": str(host()),
        "installed": stamp.is_file() and json.loads(stamp.read_text()) == PIN["files"],
        "tools": {name: shutil.which(name, path=env["PATH"]) for name in ("go", "zig", "bun", "cmake", "ninja")},
    }, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install", help="toolchains, the checkout and its packages, and the pinned runtime files")
    sub.add_parser("build", help="build the pinned runtime files from source")
    pinner = sub.add_parser("pin", help="move every mode to another revision of the fork")
    pinner.add_argument("ref", nargs="?", default="hideout", help="a branch, tag or full commit (default: hideout)")
    sub.add_parser("test", help="the fork's native tests, under Proton")
    sub.add_parser("doctor")
    sub.add_parser("env")
    runner = sub.add_parser("exec", help="run the pinned modlock CLI")
    runner.add_argument("--cwd", type=Path, required=True)
    runner.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == "install":
        install_tools()
        prepare_source()
        link_modes()
        install_runtime()
    elif args.command == "build":
        build()
    elif args.command == "pin":
        pin_revision(args.ref)
    elif args.command == "test":
        test()
    elif args.command == "doctor":
        doctor()
    elif args.command == "env":
        env = environment()
        wanted = ("PATH", "GOCACHE", "GOPATH", "GOTOOLCHAIN", "GOFLAGS", "XDG_CACHE_HOME", "MODLOCK_HOST",
                  "MODLOCK_NO_UPDATE_CHECK", "MODLOCK_PROTON_BUILD_DIR", "MODLOCK_PROTON")
        print(json.dumps({key: env[key] for key in wanted if key in env}, indent=2))
    else:
        arguments = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
        require()
        os.chdir(args.cwd)
        os.execve(cli(), [str(cli()), *arguments], environment())


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f"runtime: {error}", file=sys.stderr)
        sys.exit(1)
