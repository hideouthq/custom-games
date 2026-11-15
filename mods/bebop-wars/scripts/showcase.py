#!/usr/bin/env python3
"""Stage and capture the Hideout listing screenshots in a live Deadlock client.

  showcase.py server start|stop      the staged server (gameplay.py showcase)
  showcase.py client start|stop      Deadlock in a headless Gamescope, at high settings
  showcase.py do "tp me 0 -400" ...  run showcase commands; "@0.5" sleeps half a second
  showcase.py shot NAME              save .local/showcase/shots/NAME.png
  showcase.py burst NAME COUNT SECONDS   a run of frames, NAME-01.png onwards
  showcase.py bare NAME              the world with no interface at all
  showcase.py patch FRAME BARE NAME  FRAME with its corner readouts filled from BARE
  showcase.py scrub FRAME NAME       FRAME with its corner readouts painted out, for full-screen menus
  showcase.py backdrop FRAME         the banner's wide background, cut from a bare capture
  showcase.py console "line" ...     type at the client's console
  showcase.py scene pull|rescue      stage a scene and capture a run of frames from it
  showcase.py export FRAME FILE      write a frame to gameplay/art as a 1920x1080 JPEG
  showcase.py x key Escape           xdotool on the client's display

The client is the installed game with the player's own video settings, started
with its own Proton build and without mods: it refuses to start while
gameinfo.gi mounts an addons folder. The game rewrites the player's settings
for the headless window and its key bindings, so their folder is saved first
and put back when the client stops. Everything else written lands in .local/showcase.
"""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".local/showcase"
SHOTS = WORK / "shots"
PORT = 27067
STEAM = Path.home() / ".local/share/Steam"
GAME = STEAM / "steamapps/common/Deadlock/game"
SAVED = WORK / "usercfg"
WIDTH, HEIGHT = (int(value) for value in os.environ.get("SHOWCASE_SIZE", "2560x1440").split("x"))
CORNERS = ((0.0, 0.0, 0.085, 0.05), (0.60, 0.0, 1.0, 0.045), (0.925, 0.92, 1.0, 1.0))
METER = (0.94, 0.93, 0.995, 0.975)


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
    found = sorted((WORK / "config/modlock/files").glob("*"))
    folder = found[0] if found else WORK / "config/modlock/files/bebop-wars"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "showcase.txt"


def do(commands: list[str], wait: float = 0.4) -> str:
    log = WORK / "server.log"
    offset = log.stat().st_size
    for command in commands:
        if command.startswith("@"):
            time.sleep(float(command[1:]))
            continue
        with (WORK / "sequence.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            counter = WORK / "sequence"
            sequence = (int(counter.read_text()) if counter.is_file() else 0) + 1
            with host_file().open("a") as stream:
                stream.write(f"{sequence} {command}\n")
            counter.write_text(str(sequence))
    time.sleep(wait)
    with log.open("rb") as stream:
        stream.seek(offset)
        text = stream.read().decode(errors="replace")
    return "\n".join(line.split("[Showcase] ", 1)[1] for line in text.splitlines() if "[Showcase] " in line)


def shot(name: str) -> Path:
    SHOTS.mkdir(parents=True, exist_ok=True)
    target = SHOTS / f"{name}.png"
    target.unlink(missing_ok=True)
    subprocess.run(["gamescopectl", "screenshot", str(target)], env=display_env(), check=True, stdout=subprocess.DEVNULL)
    for _ in range(100):
        if target.is_file() and target.stat().st_size:
            break
        time.sleep(0.02)
    return target


def xdo(*arguments: str) -> None:
    subprocess.run(["xdotool", *arguments], env=display_env(), check=True)


def console(*lines: str) -> None:
    """F7 opens and closes the client's console."""
    xdo("key", "F7")
    time.sleep(0.6)
    for line in lines:
        xdo("type", "--delay", "6", line)
        xdo("key", "Return")
        time.sleep(0.25)
    xdo("key", "F7")
    time.sleep(0.4)


def burst(name: str, count: int, interval: float) -> list[Path]:
    frames = []
    for index in range(1, count + 1):
        started = time.monotonic()
        frames.append(shot(f"{name}-{index:02d}"))
        time.sleep(max(0.0, interval - (time.monotonic() - started)))
    return frames


def bare(name: str) -> Path:
    xdo("key", "F9")
    time.sleep(0.4)
    target = shot(name)
    xdo("key", "F9")
    time.sleep(0.2)
    return target


def patch(frame: str, world: str, name: str) -> Path:
    from PIL import Image, ImageDraw, ImageFilter

    full = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    clear = Image.open(SHOTS / f"{world}.png").convert("RGB")
    mask = Image.new("L", full.size, 0)
    draw = ImageDraw.Draw(mask)
    for left, top, right, bottom in CORNERS:
        draw.rectangle((left * full.width, top * full.height, right * full.width, bottom * full.height), fill=255)
    target = SHOTS / f"{name}.png"
    Image.composite(clear, full, mask.filter(ImageFilter.GaussianBlur(6))).save(target)
    return target


def reset(*placing: str) -> None:
    """A pulled fighter stays on the bank they landed on until they respawn, so the bots die first."""
    do(["clear", "sv host_timescale 1", "cam off", "@1.5", "kill e1", "kill e2", "kill a1", "@6.5", "heal all", "clock 272",
        "score 9 11", *placing, "@7.0"])


def scene_pull(name: str = "pull") -> None:
    reset("tp me 600 330 270 4", "tp e1 720 -235 90", "tp e2 420 -240 90", "tp a1 420 232 270")
    do(["aim me e1", "@0.5", "when e1 y > -228 sv host_timescale 0.04", "cast me e1", "at 0.45 cast a1 e2", "@1.2"])
    burst(name, 20, 0.5)
    bare(f"{name}-bare")
    do(["sv host_timescale 1"])


def on_mark(label: str, offset: int, timeout: float = 30.0) -> None:
    log = WORK / "server.log"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with log.open("rb") as stream:
            stream.seek(offset)
            if re.search(rf"t=[\d.]+ mark {re.escape(label)} ->".encode(), stream.read()):
                return
        time.sleep(0.01)
    sys.exit(f"The scene never reached mark {label}")


def scene_rescue(name: str = "rescue", cut: str = "0.955", shoot: str = "0.99", camera: str = "330 20 50 -3 0",
                 lead: str = "0.26", slow: str = "0.6") -> None:
    """A throw cut off by the camera never leaves, so the camera cuts only once the hand is away. The game stretches
    a reeled Bebop's cloth far behind them when the clock runs much slower than this, and the capture lands a little
    after its mark, so repeat the scene until a frame has the hand in flight.
    """
    reset("tp me 640 250 270 4", "tp e1 760 -235 90", "tp e2 -200 -420 90", "tp a1 800 225 270")
    offset = (WORK / "server.log").stat().st_size
    # A spectator's camera carries the spectator's panels.
    xdo("key", "F9")
    do([f"when a1 y < 195 sv host_timescale {slow} ; cast me a1 0 0 {lead}", f"at {cut} cam free {camera}",
        f"at {shoot} mark {name}", "cast e1 a1"], wait=0)
    on_mark(name, offset)
    shot(name)
    shot(f"{name}-after")
    xdo("key", "F9")
    do(["sv host_timescale 1", "@0.8", "cam off"])


def scrub(frame: str, name: str) -> Path:
    import numpy
    from PIL import Image, ImageFilter

    full = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    pixels = numpy.asarray(full).astype(numpy.float32)
    height, width = pixels.shape[:2]
    red, green, blue = pixels[..., 0], pixels[..., 1], pixels[..., 2]
    text = (pixels.max(axis=2) > 62) & (numpy.abs(red - blue) < 7) & (numpy.abs(red - green) < 7)
    paper = (red - blue > 7) & (red > 70)

    def grow(area: "numpy.ndarray", size: int) -> "numpy.ndarray":
        return numpy.asarray(Image.fromarray((area * 255).astype(numpy.uint8)).filter(ImageFilter.MaxFilter(size))) > 0

    marks = numpy.zeros((height, width), bool)
    for left, top, right, bottom in CORNERS[:2]:
        box = numpy.s_[int(top * height):int(bottom * height), int(left * width):int(right * width)]
        marks[box] = text[box]
    mask = (grow(marks, 11) & ~paper) | grow(marks, 3)
    left, top, right, bottom = METER
    mask[int(top * height):int(bottom * height), int(left * width):int(right * width)] = True
    def blur(values: "numpy.ndarray") -> "numpy.ndarray":
        for axis in (0, 1):
            values = sum(numpy.roll(values, step, axis=axis) for step in range(-3, 4)) / 7
        return values

    source = (~mask & ~paper).astype(numpy.float32)
    fill = pixels * source[..., None]
    weight = source.copy()
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
    path = ROOT / "gameplay/art" / target
    Image.open(SHOTS / f"{frame}.png").convert("RGB").resize((width, height), Image.LANCZOS).save(path, quality=92, optimize=True)
    return path


def backdrop(frame: str) -> Path:
    from PIL import Image, ImageEnhance

    image = Image.open(SHOTS / f"{frame}.png").convert("RGB")
    height = round(image.width * 640 / 2256)
    top = (image.height - height) // 2
    band = image.crop((0, top, image.width, top + height)).resize((2256, 640), Image.LANCZOS)
    band = ImageEnhance.Contrast(ImageEnhance.Brightness(band).enhance(0.9)).enhance(1.06)
    target = ROOT / "content/citadel_addons/bebop_wars/ui/hideout/banner/arena-background@2x.png"
    band.save(target, optimize=True)
    return target


SCENES = {"pull": scene_pull, "rescue": scene_rescue}


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    action, rest = sys.argv[1], sys.argv[2:]
    if action == "server":
        if rest[0] == "start":
            if alive("server"):
                sys.exit("The showcase server is already running")
            for stale in (WORK / "sequence", host_file()):
                stale.unlink(missing_ok=True)
            teams = rest[1] if len(rest) > 1 else "2v2"
            log = spawn("server", [sys.executable, str(ROOT / "scripts/gameplay.py"), "showcase", "--teams", teams])
            deadline = time.monotonic() + 240
            while "server ready" not in log.read_text(errors="replace"):
                if time.monotonic() > deadline or not alive("server"):
                    sys.exit(f"The server did not start; read {log}")
                time.sleep(0.5)
            print(f"ready, log {log}")
        else:
            stop("server", signal.SIGINT)
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
    elif action == "scene":
        SCENES[rest[0]](**dict(pair.split("=", 1) for pair in rest[1:]))
    elif action == "export":
        print(export(*rest))
    elif action == "burst":
        print(*burst(rest[0], int(rest[1]), float(rest[2])), sep="\n")
    elif action == "backdrop":
        print(backdrop(rest[0]))
    elif action == "scrub":
        print(scrub(*rest))
    elif action == "bare":
        print(bare(rest[0]))
    elif action == "patch":
        print(patch(*rest))
    elif action == "console":
        console(*rest)
    elif action == "x":
        xdo(*rest)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
