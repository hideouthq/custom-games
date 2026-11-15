#!/usr/bin/env python3
"""Stage and capture Pillars' listing pictures in a live Deadlock client.

  showcase.py server start|stop      the staged server, a watched copy of the mode
  showcase.py sync                   copy edited sources into the running copy; a reload drops the bots
  showcase.py client start|stop      Deadlock in a headless Gamescope
  showcase.py do "bot Juno hero_lash" "@0.5"   run staging commands; "@0.5" sleeps half a second
  showcase.py shot NAME              save .local/showcase/shots/NAME.png
  showcase.py bare NAME              the same view with no interface and no health bars
  showcase.py burst NAME COUNT       COUNT frames in a row, NAME-01 onwards
  showcase.py mark LABEL NAME        capture NAME when the server logs `mark LABEL`
  showcase.py patch FRAME BARE NAME  FRAME with the runtime's corner readouts filled from BARE
  showcase.py clean FRAME NAME       the same without a bare frame, filled from the sky around them
  showcase.py scene wide             stage the banner's wide scene and capture it; key=value changes it
  showcase.py backdrop FRAME         cut a bare frame of that scene to the banner's background
  showcase.py export FRAME FILE      write a frame to gameplay/art as a 1920x1080 JPEG
  showcase.py pillar N [OUT] [LEFT]  print a place on ring pillar N, for a `tp`
  showcase.py x key Escape           xdotool on the client's display

The staged copy is the mode's own sources with gameplay/development added, so
the published mode carries none of this. The client is the installed game
with the player's own video settings and no mods: it refuses to start while
gameinfo.gi mounts an addons folder, and it needs Steam running. The game
rewrites the player's settings for the headless window, so their folder is
saved first and put back when the client stops. Everything written lands in
.local/showcase.

Once the client has joined, bind the key `bare` presses in its console:
  bind F9 "toggle r_drawpanorama; toggle citadel_unit_status_enabled"
and allow the second setting with `showcase.py do "sv sv_cheats 1"`. Set
SHOWCASE_SIZE=5120x2880 before `client start` for the wide scene, whose cut
is narrower than the frame.
"""
from __future__ import annotations

import fcntl
import json
import math
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
BANNER = ROOT / "content/citadel_addons/pillars/ui/hideout/banner"
WORK = ROOT / ".local/showcase"
PROJECT = WORK / "project"
SHOTS = WORK / "shots"
SAVED = WORK / "usercfg"
ARENA = json.loads((ROOT / "scripts/arena.json").read_text())
PORT = 27066
# The interface reaches the client through this port, so it cannot be turned off as the browser preview is.
UI_PORT = 4314
STEAM = Path.home() / ".local/share/Steam"
GAME = STEAM / "steamapps/common/Deadlock/game"
WIDTH, HEIGHT = (int(value) for value in os.environ.get("SHOWCASE_SIZE", "2560x1440").split("x"))
CORNERS = ((0.0, 0.0, 0.09, 0.09), (0.62, 0.0, 1.0, 0.03), (0.94, 0.925, 1.0, 1.0))
ENTRY = "import { game } from './mode'\nimport { stage } from './development/showcase'\n\nstage(game)\n"
HUD = """import type { UiElement } from 'modlock'

import { hud as modeHud, type HudView } from './hud-mode'

export * from './hud-mode'

export function hud(view: HudView): UiElement {
  return {
    type: 'panel',
    props: {
      style: { width: '100%', height: '100%' },
      children: [
        modeHud(view),
        { type: 'layout', props: { src: 'showcase.xml' }, key: 'showcase' },
      ],
    },
  }
}
"""


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

    renamed = {"main.ts": "mode.ts", "hud.ts": "hud-mode.ts"}
    for source in GAMEPLAY.glob("*.ts"):
        put(PROJECT / renamed.get(source.name, source.name), source.read_text())
    put(PROJECT / "development/showcase.ts", (GAMEPLAY / "development/showcase.ts").read_text())
    put(PROJECT / "main.ts", ENTRY)
    put(PROJECT / "hud.ts", HUD)
    put(PROJECT / "content/layout/showcase.xml", (GAMEPLAY / "development/showcase.xml").read_text())
    put(PROJECT / "content/scripts/showcase.js", (GAMEPLAY / "development/showcase.js").read_text())
    put(PROJECT / "mod.json", (GAMEPLAY / "mod.json").read_text())
    config = json.loads((GAMEPLAY / "tsconfig.json").read_text())
    config["include"].append("development/*.ts")
    put(PROJECT / "tsconfig.json", json.dumps(config, indent=2) + "\n")


def settings() -> Path:
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
    folder = WORK / "config/modlock/files/pillars"
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
    target = SHOTS / f"{name}.png"
    Image.composite(clear, full, mask).save(target)
    return target


def clean(frame: str, name: str) -> Path:
    import numpy
    from PIL import Image, ImageFilter

    image = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    margin = max(24, image.width // 60)

    def blur(values: "numpy.ndarray") -> "numpy.ndarray":
        for axis in (0, 1):
            padded = numpy.pad(values, [(3, 3) if index == axis else (0, 0) for index in (0, 1)], mode="edge")
            values = sum(numpy.take(padded, range(step, step + values.shape[axis]), axis=axis) for step in range(7)) / 7
        return values

    for (left, top, right, bottom), contrast in zip(CORNERS, (5, 14, -1)):
        inner = (int(left * image.width), int(top * image.height), int(right * image.width), int(bottom * image.height))
        outer = (max(inner[0] - margin, 0), max(inner[1] - margin, 0),
                 min(inner[2] + margin, image.width), min(inner[3] + margin, image.height))
        window = image.crop(outer)
        pixels = numpy.asarray(window).astype(numpy.float32)
        size = max(9, (image.width // 80) | 1)
        behind = numpy.asarray(window.filter(ImageFilter.MedianFilter(min(size, 31)))).astype(numpy.float32)
        stands = numpy.abs(pixels - behind).max(axis=2) > contrast
        inside = numpy.zeros(stands.shape, bool)
        inside[inner[1] - outer[1]:inner[3] - outer[1], inner[0] - outer[0]:inner[2] - outer[0]] = True
        grown = Image.fromarray(((stands & inside) * 255).astype(numpy.uint8)).filter(ImageFilter.MaxFilter(size))
        mask = (numpy.asarray(grown) > 0) & inside
        weight = (~mask).astype(numpy.float32)
        fill = pixels * weight[..., None]
        for _ in range(120):
            spread = blur(weight)
            take = mask & (spread > 0.05)
            for channel in range(3):
                value = blur(fill[..., channel] * weight) / numpy.maximum(spread, 1e-4)
                fill[..., channel][take] = value[take]
            weight[take] = 1
        fill[~mask] = pixels[~mask]
        image.paste(Image.fromarray(fill.clip(0, 255).astype(numpy.uint8)), outer[:2])
    target = SHOTS / f"{name}.png"
    image.save(target)
    return target


def export(frame: str, target: str, size: str = "1920x1080") -> Path:
    from PIL import Image

    width, height = (int(value) for value in size.split("x"))
    path = GAMEPLAY / "art" / target
    Image.open(SHOTS / f"{frame}.png").convert("RGB").resize((width, height), Image.LANCZOS).save(path, quality=92, optimize=True)
    return path


def backdrop(frame: str, window: str = "0.158 0.31 0.5", gain: str = "1.45") -> Path:
    import numpy
    from PIL import Image, ImageEnhance

    left, top, width = (float(value) for value in window.split())
    source = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    across = round(width * source.width)
    if across < 2256:
        raise ValueError("The cut is narrower than the banner; capture at a larger SHOWCASE_SIZE")
    box = (round(left * source.width), round(top * source.height))
    cut = source.crop((*box, box[0] + across, box[1] + round(across * 640 / 2256))).resize((2256, 640), Image.LANCZOS)
    pixels = numpy.clip(numpy.asarray(cut).astype(numpy.float32) / 255 * float(gain), 0, 1) ** 0.92
    graded = ImageEnhance.Color(Image.fromarray((pixels * 255).astype(numpy.uint8))).enhance(1.12)
    BANNER.mkdir(parents=True, exist_ok=True)
    target = BANNER / "arena-background@2x.png"
    graded.save(target, optimize=True)
    return target


def snap() -> dict:
    return json.loads(do(["snap"], wait=0.25).rsplit("snap -> ", 1)[1].splitlines()[0])


def until(reached, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = snap()
        if reached(state):
            return state
    sys.exit("The staged match never reached the state the scene waits for")


def pillar(index: int, out: float = 0.0, left: float = 0.0, up: float = 8.0) -> str:
    angle = 2 * math.pi * index / ARENA["pillars"]
    radius = ARENA["ringRadius"] + out
    x = radius * math.cos(angle) - left * math.sin(angle)
    y = radius * math.sin(angle) + left * math.cos(angle)
    return f"{x:.1f} {y:.1f} {ARENA['topZ'] + up:.1f}"


def burst(name: str, count: int) -> list[Path]:
    return [shot(f"{name}-{index + 1:02d}") for index in range(count)]


def fresh_round(keep: str = "Vex") -> dict:
    state = snap()
    if state["phase"] in ("live", "overtime", "final"):
        do([f"kill {player['name']}" for player in state["players"]
            if player["alive"] and player["name"] != keep and player["slot"] in state["living"]])
    until(lambda now: now["phase"] in ("intermission", "countdown", "waiting", "matchEnd"), timeout=30)
    state = until(lambda now: now["phase"] == "live" and all(player["alive"] for player in now["players"]), timeout=90)
    do(["drops 3000", "centre 3000"])
    return state


def ability_key(loot: str) -> str:
    slot = json.loads(do([f"give me {loot}"]).rsplit(" -> ", 1)[1].splitlines()[0])["slot"]
    return "qxec"[slot]


def tap(key: str, seconds: float = 0.4) -> None:
    xdo("keydown", key)
    time.sleep(seconds)
    xdo("keyup", key)


def scene_wide(name: str = "wide", lens: str = "255 1305 80", look: str = "201 4", frames: str = "8",
               lead: str = "0.85 0.85") -> None:
    """A bot does not cast Grapple, so the player does, from their own camera moved off their shoulder:
    the free camera stops them casting.
    """
    throw, rise = (float(value) for value in lead.split())
    fresh_round()
    key = ability_key("grapple")
    do(["tp me -522 1329 8 222", "tp Okabe -1144.6 949 8 252", "tp Vex -1434 57 8 72", "tp Tamsin -1500 -70 8 72",
        f"tp Rill {pillar(6, 0, 60)} 0", f"tp Juno {pillar(8)} 0", "give Vex pillow", "give Tamsin flight",
        "lens off", "lens distance 1", "lens horizontalOffset 0", "lens verticalOffset 0", f"lens target {lens}",
        "@1.2", f"look me {look}", "face Vex Okabe 50", "face Okabe Vex 50", "look Tamsin 72 -30", "@2",
        "sv host_timescale 0.1"])
    xdo("key", "F9")
    first, second = sorted((("use Vex pillow", throw), ("use Tamsin flight", rise)), key=lambda step: -step[1])
    do([first[0]], wait=0)
    time.sleep(max(0.0, (first[1] - second[1]) * 10 - 0.15))
    do([second[0]], wait=0)
    time.sleep(max(0.0, second[1] * 10 - 0.6))
    tap(key)
    burst(name, int(frames))
    xdo("key", "F9")
    do(["sv host_timescale 1", "lens off"])


SCENES: dict = {"wide": scene_wide}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
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
    elif action == "clean":
        print(clean(*rest))
    elif action == "backdrop":
        print(backdrop(*rest))
    elif action == "burst":
        print(*burst(rest[0], int(rest[1])), sep="\n")
    elif action == "pillar":
        print(pillar(int(rest[0]), *(float(value) for value in rest[1:])))
    elif action == "export":
        print(export(*rest))
    elif action == "x":
        xdo(*rest)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
