#!/usr/bin/env python3
"""fontconfig silently swaps a missing font family for another, so the render is refused instead."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "content/citadel_addons/bebop_wars/ui/hideout/how-to-play-map.svg"
TARGET = ROOT / "gameplay/art/how-to-play-map@2x.png"
SIZE = (2000, 646)
FONTS = ("Liberation Sans", "DejaVu Sans Mono")


def main() -> None:
    for tool in ("rsvg-convert", "fc-match"):
        if shutil.which(tool) is None:
            sys.exit(f"{tool} is needed to render the diagram")
    for family in FONTS:
        found = subprocess.run(["fc-match", "--format=%{family}", family], check=True, capture_output=True, text=True).stdout
        if family not in found.split(","):
            sys.exit(f"The diagram is set in {family}, which is not installed (fontconfig offers {found})")
    # The portrait is referenced relative to the SVG, which librsvg resolves from the file's own folder.
    subprocess.run(["rsvg-convert", "--width", str(SIZE[0]), "--height", str(SIZE[1]), "--output", str(TARGET), str(SOURCE)], check=True)
    print(TARGET)


if __name__ == "__main__":
    main()
