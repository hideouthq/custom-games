#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "content/citadel_addons/pillars/ui/hideout/how-to-play-map.svg"
TARGET = ROOT / "gameplay/art/how-to-play-map@2x.png"
SIZE = (2000, 646)
FONT = "Fira Sans"


def main() -> None:
    for tool in ("rsvg-convert", "fc-match"):
        if shutil.which(tool) is None:
            sys.exit(f"{tool} is needed to render the diagram")
    found = subprocess.run(["fc-match", "--format=%{family}", f"{FONT}:bold"],
                           check=True, capture_output=True, text=True).stdout
    if FONT not in found.split(","):
        sys.exit(f"The diagram is set in {FONT}, which is not installed (fontconfig offers {found})")
    TARGET.parent.mkdir(exist_ok=True)
    subprocess.run(["rsvg-convert", "--width", str(SIZE[0]), "--height", str(SIZE[1]),
                    "--output", str(TARGET), str(SOURCE)], check=True)
    print(TARGET.relative_to(ROOT))


if __name__ == "__main__":
    main()
