#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BANNER = ROOT / "content/citadel_addons/bebop_wars/ui/hideout/banner"
ART = ROOT / "gameplay/art"
RENDER = (1120, 40)
OVERLAY = (1496, -80)
CARD = (1056, -40, 2256, 560)
TILE = (1500, 60, 1980, 540)


def window(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    left, top, right, bottom = box
    inside = image.crop((max(left, 0), max(top, 0), min(right, image.width), min(bottom, image.height)))
    canvas = inside.resize((right - left, bottom - top), Image.BILINEAR)
    canvas.paste(inside, (max(-left, 0), max(-top, 0)))
    return canvas


def preview(background: Image.Image, render: Image.Image, overlay: Image.Image, above: int, right: int) -> Image.Image:
    canvas = Image.new("RGBA", (background.width + right, background.height + above), (0, 0, 0, 0))
    canvas.paste(background, (0, above))
    for layer, (x, y) in ((render, RENDER), (overlay, OVERLAY)):
        canvas.alpha_composite(layer, (x, y + above))
    return canvas


def main() -> None:
    anchors = json.loads((BANNER / "asset-manifest.json").read_text())["anchors"]
    wrist = (RENDER[0] + anchors["body"][0], RENDER[1] + anchors["body"][1])
    cable = (OVERLAY[0] + anchors["tether"][0], OVERLAY[1] + anchors["tether"][1])
    if max(abs(wrist[0] - cable[0]), abs(wrist[1] - cable[1])) > 1:
        raise ValueError("The cable no longer meets the wrist at the positions Hideout draws the layers")
    background = Image.open(BANNER / "arena-background@2x.png").convert("RGB")
    render = Image.open(BANNER / "bebop-render@2x.png").convert("RGBA")
    overlay = Image.open(BANNER / "bebop-hook-layer@2x.png").convert("RGBA")
    icon = Image.open(BANNER / "bebop-icon@2x.png").convert("RGBA")

    ART.mkdir(exist_ok=True)
    background.save(ART / "banner-background@2x.jpg", quality=90, optimize=True)
    card = window(background, CARD).resize((600, 300), Image.LANCZOS).filter(ImageFilter.GaussianBlur(5))
    card.save(ART / "card-background@2x.jpg", quality=90, optimize=True)
    render.save(ART / "bebop-render@2x.png", optimize=True)
    overlay.save(ART / "bebop-hook-layer@2x.png", optimize=True)
    tile = background.crop(TILE).resize((96, 96), Image.LANCZOS).filter(ImageFilter.GaussianBlur(2)).convert("RGBA")
    tile.alpha_composite(icon.resize((96, 96), Image.LANCZOS))
    tile.save(ART / "bebop-thumb@2x.png", optimize=True)

    clipped = preview(background, render, overlay, 0, 0).crop((0, 0, 2256, 640))
    clipped.save(BANNER / "banner-preview@2x.png", optimize=True)
    preview(background, render, overlay, 80, 40).save(BANNER / "banner-preview-expanded@2x.png", optimize=True)

    art = json.loads((ROOT / "gameplay/hideout.json").read_text())["art"]
    assets = [ROOT / "gameplay" / art[key] for key in ("card", "backdrop", "render", "overlay", "tile")]
    subprocess.run([ROOT.parents[1] / "scripts/grade-banner", ROOT, *assets], check=True)


if __name__ == "__main__":
    main()
