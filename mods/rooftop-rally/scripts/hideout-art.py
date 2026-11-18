#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BANNER = ROOT / "content/citadel_addons/new_deadlock_game/ui/hideout/banner"
ART = ROOT / "gameplay/art"
HIDEOUT_RENDER = [560, 20]
HIDEOUT_OVERLAY = [748, -40]


def main() -> None:
    layout = json.loads((BANNER / "asset-manifest.json").read_text())["layoutAt1x"]
    if layout["body"]["position"] != HIDEOUT_RENDER or layout["front"]["position"] != HIDEOUT_OVERLAY:
        raise ValueError("The banner layers are not authored at the positions Hideout draws them")
    render = Image.open(BANNER / "yamato-render@2x.png")
    overlay = Image.open(BANNER / "celeste-ball-front@2x.png")
    ART.mkdir(exist_ok=True)
    background = Image.open(BANNER / "rooftop-background@2x.png").convert("RGB")
    background.save(ART / "banner-background@2x.jpg", quality=90, optimize=True)
    card = background.crop((1000, 0, 2256, 628)).resize((600, 300), Image.LANCZOS).filter(ImageFilter.GaussianBlur(6))
    card.save(ART / "card-background@2x.jpg", quality=90, optimize=True)
    render.save(ART / "yamato-render@2x.png", optimize=True)
    overlay.save(ART / "celeste-ball-layer@2x.png", optimize=True)
    icon = Image.open(BANNER / "yamato-icon@2x.png")
    tile = background.crop((1500, 0, 2140, 640)).resize(icon.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(2))
    tile.paste(icon, (0, 0), icon)
    tile.save(ART / "yamato-thumb@2x.png", optimize=True)

    art = json.loads((ROOT / "gameplay/hideout.json").read_text())["art"]
    assets = [ROOT / "gameplay" / art[key] for key in ("card", "backdrop", "render", "overlay", "tile")]
    subprocess.run([ROOT.parents[1] / "scripts/grade-banner", ROOT, *assets], check=True)


if __name__ == "__main__":
    main()
