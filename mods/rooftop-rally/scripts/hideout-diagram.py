#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "content/citadel_addons/new_deadlock_game/ui/hideout/how-to-play-map.svg"
TARGET = ROOT / "gameplay/art/how-to-play-map@2x.png"
SIZE = (2000, 646)


def main() -> None:
    if not shutil.which("rsvg-convert"):
        raise SystemExit("rsvg-convert is not installed; it comes with librsvg")
    if "Fira Sans" not in subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, check=True).stdout:
        raise SystemExit("The diagram's labels are set in Fira Sans, which is not installed")
    TARGET.parent.mkdir(exist_ok=True)
    # The portrait is a relative link, which librsvg only follows from the source's own folder.
    subprocess.run(
        ["rsvg-convert", "--width", str(SIZE[0]), "--height", str(SIZE[1]), "--output", str(TARGET), SOURCE.name],
        cwd=SOURCE.parent, check=True,
    )
    print(TARGET.relative_to(ROOT))


if __name__ == "__main__":
    main()
