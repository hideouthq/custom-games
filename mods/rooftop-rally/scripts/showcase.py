#!/usr/bin/env python3
"""Stage and capture Rooftop Rally's listing screenshots in a live Deadlock client.

  showcase.py server start|stop      the staged server, a watched copy of the mode
  showcase.py sync                   copy edited sources into the running copy
  showcase.py client start|stop      Deadlock in a headless Gamescope
  showcase.py do "bot Juno" "@0.5"   run staging commands; "@0.5" sleeps half a second
  showcase.py shot NAME              save .local/showcase/shots/NAME.png
  showcase.py bare NAME              the same view with no interface at all
  showcase.py mark LABEL NAME        capture NAME when the server logs `mark LABEL`
  showcase.py patch FRAME BARE NAME  FRAME with the runtime's corner readouts filled from BARE
  showcase.py scrub FRAME NAME       FRAME with those readouts painted out, for a full-screen menu
  showcase.py scene duel|winner      stage a scene and capture it; key=value changes its timing or camera
  showcase.py export FRAME FILE      write a frame to gameplay/art as a 1920x1080 JPEG
  showcase.py x key Escape           xdotool on the client's display

The staged copy is the mode's own sources with gameplay/development/showcase.ts
added, so the published mode carries none of this. The client is the installed
game with the player's own video settings and no mods: it refuses to start
while gameinfo.gi mounts an addons folder. The game rewrites the player's
settings for the headless window, so their folder is saved first and put back
when the client stops. Everything written lands in .local/showcase.
"""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / "scripts"))
import runtime  # noqa: E402

GAMEPLAY = ROOT / "gameplay"
WORK = ROOT / ".local/showcase"
PROJECT = WORK / "project"
SHOTS = WORK / "shots"
SAVED = WORK / "usercfg"
PORT = 27068
UI_PORT = 4324
STEAM = Path.home() / ".local/share/Steam"
GAME = STEAM / "steamapps/common/Deadlock/game"
WIDTH, HEIGHT = (int(value) for value in os.environ.get("SHOWCASE_SIZE", "2560x1440").split("x"))
# What the runtime and the stock client draw over every screen: the runtime's mark, its version line with the
# FPS readout, and the movement meter.
CORNERS = ((0.0, 0.0, 0.085, 0.05), (0.60, 0.0, 1.0, 0.045), (0.925, 0.92, 1.0, 1.0))
ENTRY = "import { game } from './mode'\nimport { stage } from './development/showcase'\n\nstage(game)\n"


def stage_project() -> None:
    subprocess.run([sys.executable, str(ROOT / "scripts/gameplay.py"), "stage"], check=True, stdout=subprocess.DEVNULL)
    shutil.copytree(GAMEPLAY / "maps", PROJECT / "maps", dirs_exist_ok=True)
    copy_sources()
    modules = PROJECT / "node_modules"
    if not modules.exists():
        modules.symlink_to(GAMEPLAY / "node_modules")


def copy_sources() -> None:
    def put(target: Path, text: str) -> None:
        if not target.is_file() or target.read_text() != text:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)

    for source in GAMEPLAY.glob("*.ts"):
        put(PROJECT / ("mode.ts" if source.name == "main.ts" else source.name), source.read_text())
    put(PROJECT / "development/showcase.ts", (GAMEPLAY / "development/showcase.ts").read_text())
    put(PROJECT / "main.ts", ENTRY)
    put(PROJECT / "mod.json", (GAMEPLAY / "mod.json").read_text())
    config = json.loads((GAMEPLAY / "tsconfig.json").read_text())
    config["include"].append("development/*.ts")
    put(PROJECT / "tsconfig.json", json.dumps(config, indent=2) + "\n")
    authored = ROOT / "content/citadel_addons/new_deadlock_game/panorama"
    for source in authored.rglob("*"):
        if source.is_file() and source.name != "rally.xml":
            target = PROJECT / "content" / source.relative_to(authored)
            if not target.is_file() or target.read_bytes() != source.read_bytes():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
    include = '    <include src="file://{resources}/scripts/{addon}/meter.js" />\n'
    layout = (authored / "layout/rally.xml").read_text()
    if include not in layout:
        raise ValueError("rally.xml no longer includes meter.js, which the staging script is placed after")
    put(PROJECT / "content/layout/rally.xml", layout.replace(include, include + include.replace("meter.js", "showcase.js")))
    put(PROJECT / "content/scripts/showcase.js", (GAMEPLAY / "development/showcase.js").read_text())


def settings() -> Path:
    """The signed-in player's settings folder, which the game rewrites when it closes."""
    found = sorted((STEAM / "userdata").glob("*/1422450/local/cfg/video.txt"), key=lambda path: path.stat().st_mtime)
    if not found:
        sys.exit("No Deadlock settings under Steam's userdata")
    return found[-1].parent


def vanilla() -> None:
    for line in (GAME / "citadel/gameinfo.gi").read_text(errors="replace").splitlines():
        words = line.split("//")[0].split()
        if len(words) >= 2 and words[0].lower() == "game" and "addons" in words[1].lower():
            sys.exit(f"gameinfo.gi loads mods ({words[1]}). Choose Play vanilla in Hideout first.")


def proton() -> Path:
    named = os.environ.get("SHOWCASE_PROTON")
    if named:
        return Path(named)
    custom = sorted((STEAM / "compatibilitytools.d").glob("proton-*deadlock*/proton"))
    return custom[-1] if custom else STEAM / "steamapps/common/Proton - Experimental/proton"


def alive(name: str) -> int | None:
    path = WORK / f"{name}.pid"
    if not path.is_file():
        return None
    pid = int(path.read_text())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    return pid


def stop(name: str, sig: int) -> None:
    pid = alive(name)
    if pid:
        os.killpg(pid, sig)
        for _ in range(150):
            if not alive(name):
                break
            time.sleep(0.2)
        else:
            os.killpg(pid, signal.SIGKILL)
    (WORK / f"{name}.pid").unlink(missing_ok=True)


def spawn(name: str, command: list[str], env: dict[str, str] | None = None) -> Path:
    log = WORK / f"{name}.log"
    with log.open("w") as stream:
        process = subprocess.Popen(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                   start_new_session=True, env=env)
    (WORK / f"{name}.pid").write_text(str(process.pid))
    return log


def restore_settings() -> None:
    if SAVED.is_dir():
        for path in SAVED.iterdir():
            shutil.copyfile(path, settings() / path.name)
        shutil.rmtree(SAVED)


def save_settings() -> None:
    restore_settings()
    SAVED.mkdir(parents=True)
    for path in settings().iterdir():
        if path.suffix in (".txt", ".vcfg"):
            shutil.copyfile(path, SAVED / path.name)


def display_env() -> dict[str, str]:
    env = os.environ.copy()
    for line in (WORK / "client-env").read_text().splitlines():
        key, _, value = line.partition("=")
        env[key] = value
    return env


def host_file() -> Path:
    folder = WORK / "config/modlock/files/rooftop-rally"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "showcase.txt"


def do(commands: list[str], wait: float = 0.4) -> str:
    log = WORK / "server.log"
    start = log.stat().st_size
    with (WORK / "sequence.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        counter = WORK / "sequence"
        sequence = int(counter.read_text()) if counter.is_file() else 0
        for command in commands:
            if command.startswith("@"):
                time.sleep(float(command[1:]))
                continue
            sequence += 1
            with host_file().open("a") as stream:
                stream.write(f"{sequence} {command}\n")
            counter.write_text(str(sequence))
            time.sleep(0.12)
    time.sleep(wait)
    with log.open(errors="replace") as stream:
        stream.seek(start)
        return "".join(line.split("[Showcase] ", 1)[1] for line in stream if "[Showcase] " in line)


def xdo(*arguments: str) -> None:
    subprocess.run(["xdotool", *arguments], env=display_env(), check=True)


def shot(name: str) -> Path:
    SHOTS.mkdir(parents=True, exist_ok=True)
    target = SHOTS / f"{name}.png"
    target.unlink(missing_ok=True)
    subprocess.run(["gamescopectl", "screenshot", str(target)], env=display_env(), check=True, stdout=subprocess.DEVNULL)
    for _ in range(100):
        if target.is_file() and target.stat().st_size:
            return target
        time.sleep(0.05)
    sys.exit(f"No screenshot arrived at {target}")


def bare(name: str) -> Path:
    xdo("key", "F9")
    time.sleep(0.4)
    target = shot(name)
    xdo("key", "F9")
    time.sleep(0.2)
    return target


def on_mark(label: str, name: str, timeout: float = 60.0) -> Path:
    log = WORK / "server.log"
    offset = log.stat().st_size
    pattern = re.compile(rf"t=[\d.]+ \S+ mark {re.escape(label)} ->")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with log.open(errors="replace") as stream:
            stream.seek(offset)
            if pattern.search(stream.read()):
                return shot(name)
        time.sleep(0.01)
    sys.exit(f"The server never logged mark {label}")


def patch(frame: str, world: str, name: str) -> Path:
    from PIL import Image, ImageDraw, ImageFilter

    full = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    clear = Image.open(SHOTS / f"{world}.png").convert("RGB")
    mask = Image.new("L", full.size, 0)
    draw = ImageDraw.Draw(mask)
    for left, top, right, bottom in CORNERS:
        draw.rectangle((left * full.width, top * full.height, right * full.width, bottom * full.height), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(6))
    edge = 8
    inner = Image.new("L", full.size, 0)
    inner.paste(mask.crop((edge, edge, full.width - edge, full.height - edge)), (edge, edge))
    target = SHOTS / f"{name}.png"
    Image.composite(clear, full, inner).save(target)
    return target


def scrub(frame: str, name: str) -> Path:
    """The menu dims the world, so no bare capture matches it."""
    import numpy
    from PIL import Image, ImageFilter

    pixels = numpy.asarray(Image.open(SHOTS / f"{frame}.png").convert("RGB")).astype(numpy.float32)
    height, width = pixels.shape[:2]
    red, green, blue = pixels[..., 0], pixels[..., 1], pixels[..., 2]
    text = (pixels.max(axis=2) > 70) & (numpy.abs(red - blue) < 9) & (numpy.abs(red - green) < 9)
    marks = numpy.zeros((height, width), bool)
    for left, top, right, bottom in CORNERS:
        box = numpy.s_[int(top * height):int(bottom * height), int(left * width):int(right * width)]
        marks[box] = text[box]
    mask = numpy.asarray(Image.fromarray((marks * 255).astype(numpy.uint8)).filter(ImageFilter.MaxFilter(11))) > 0

    def blur(values: "numpy.ndarray") -> "numpy.ndarray":
        for axis in (0, 1):
            values = sum(numpy.roll(values, step, axis=axis) for step in range(-3, 4)) / 7
        return values

    weight = (~mask).astype(numpy.float32)
    fill = pixels * weight[..., None]
    for _ in range(80):
        spread = blur(weight)
        value = blur(fill * weight[..., None]) / numpy.maximum(spread, 1e-4)[..., None]
        take = mask & (spread > 0.05)
        fill[take] = value[take]
        weight[take] = 1
    fill[~mask] = pixels[~mask]
    target = SHOTS / f"{name}.png"
    Image.fromarray(fill.clip(0, 255).astype(numpy.uint8)).save(target)
    return target


def export(frame: str, target: str, size: str = "1920x1080") -> Path:
    from PIL import Image

    width, height = (int(value) for value in size.split("x"))
    path = GAMEPLAY / "art" / target
    Image.open(SHOTS / f"{frame}.png").convert("RGB").resize((width, height), Image.LANCZOS).save(path, quality=92, optimize=True)
    return path


def snap() -> dict:
    return json.loads(do(["snap"], wait=0.25).rsplit("snap -> ", 1)[1].splitlines()[0])


def until(reached, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = snap()
        if reached(state):
            return state
    sys.exit("The staged match never reached the state the scene waits for")


def scene_duel(name: str = "duel", returns: str = "7", camera: str = "0 -300 95 0 90", me: str = "250 0 180",
               juno: str = "-250 0 0", frames: str = "14") -> None:
    do(["clear", "sv host_timescale 1", "cam off", "rally"])
    until(lambda state: state["phase"] not in ("serve", "flight", "frozen", "reset"))
    until(lambda state: state["phase"] == "serve" and len(state["living"]) == 4)
    do(["tp Okabe -260 -1500 90", "tp Rill 260 -1500 90", f"tp Juno {juno}", f"tp me {me}", "rally me Juno",
        "cover Okabe me", "cover Rill Juno", f"cam {camera}", f"when {returns} sv host_timescale 0.08"])
    until(lambda state: state["rally"] >= int(returns))
    for index in range(int(frames)):
        shot(f"{name}-{index + 1:02d}")
    bare(f"{name}-bare")


def scene_winner(name: str = "winner", camera: str = "0 380 105 -3 90", me: str = "0 660 270") -> None:
    do(["clear", "sv host_timescale 1", "drop Juno", "drop Okabe", "drop Rill"])
    until(lambda state: state["phase"] == "intermission", timeout=120)
    do([f"tp me {me}", f"cam {camera}", "@0.7"])
    shot(name)
    bare(f"{name}-bare")


SCENES = {"duel": scene_duel, "winner": scene_winner}


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    action, rest = sys.argv[1], sys.argv[2:]
    if action == "server":
        if rest[0] == "start":
            if alive("server"):
                sys.exit("The showcase server is already running")
            for stale in (WORK / "sequence", host_file()):
                stale.unlink(missing_ok=True)
            stage_project()
            env = {**os.environ, "XDG_CONFIG_HOME": str(WORK / "config")}
            log = spawn("server", runtime.command(PROJECT, "dev", "--watch", "--no-game", "--port", PORT, "--ui-port", UI_PORT,
                                                  "--preview-port", 0, "--arg", "showcase"), env)
            deadline = time.monotonic() + 240
            while "server ready" not in log.read_text(errors="replace"):
                if time.monotonic() > deadline or not alive("server"):
                    sys.exit(f"The server did not start; read {log}")
                time.sleep(0.5)
            print(f"ready, log {log}")
        else:
            stop("server", signal.SIGINT)
    elif action == "sync":
        copy_sources()
    elif action == "client":
        if rest[0] == "start":
            if alive("client"):
                sys.exit("The showcase client is already running")
            vanilla()
            save_settings()
            inner = (
                f'printf "DISPLAY=%s\\nGAMESCOPE_WAYLAND_DISPLAY=%s\\n" "$DISPLAY" "$GAMESCOPE_WAYLAND_DISPLAY" > "{WORK}/client-env"; '
                f'export STEAM_COMPAT_CLIENT_INSTALL_PATH="{STEAM}" STEAM_COMPAT_DATA_PATH="{STEAM}/steamapps/compatdata/1422450" '
                "SteamAppId=1422450 SteamGameId=1422450 PROTON_ENABLE_WAYLAND=0 PROTON_USE_WAYLAND=0; unset WAYLAND_DISPLAY; "
                f'exec "{proton()}" run "{GAME}/bin/win64/deadlock.exe" -vulkan -novid -nojoy -nosound -console -condebug '
                f"-windowed -w {WIDTH} -h {HEIGHT} +fps_max 120 +con_enable true +connect 127.0.0.1:{PORT}"
            )
            log = spawn("client", ["gamescope", "--backend", "headless", "-W", str(WIDTH), "-H", str(HEIGHT),
                                   "-w", str(WIDTH), "-h", str(HEIGHT), "-r", "120", "--", "bash", "-c", inner])
            print(f"started, log {log}")
        else:
            stop("client", signal.SIGTERM)
            restore_settings()
    elif action == "do":
        print(do(rest))
    elif action == "shot":
        print(shot(rest[0]))
    elif action == "bare":
        print(bare(rest[0]))
    elif action == "mark":
        print(on_mark(rest[0], rest[1]))
    elif action == "patch":
        print(patch(*rest))
    elif action == "scene":
        SCENES[rest[0]](**dict(pair.split("=", 1) for pair in rest[1:]))
    elif action == "scrub":
        print(scrub(*rest))
    elif action == "export":
        print(export(*rest))
    elif action == "x":
        xdo(*rest)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
