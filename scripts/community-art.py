#!/usr/bin/env python3
"""Export a community mode's listing art from its banner sources, then grade it.

mods/MODE/content/hideout/banner holds backdrop.jpg (2256x640), render.png (520x600) and overlay.png (800x440), the
layers Hideout draws at the positions below. The card, tile and banner preview come from them.
"""
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
RENDER, OVERLAY = (1120, 40), (1496, -80)


def main(mode: str) -> None:
    root = REPO / "mods" / mode
    banner = root / "content/hideout/banner"
    art = json.loads((root / "gameplay/hideout.json").read_text())["art"]
    out = lambda key: root / "gameplay" / art[key]
    backdrop = Image.open(banner / "backdrop.jpg").convert("RGB")
    render = Image.open(banner / "render.png").convert("RGBA")
    overlay = Image.open(banner / "overlay.png").convert("RGBA")
    if backdrop.size != (2256, 640) or render.size != (520, 600) or overlay.size != (800, 440):
        raise ValueError("Banner layers must be 2256x640, 520x600 and 800x440")
    out("backdrop").parent.mkdir(parents=True, exist_ok=True)
    backdrop.save(out("backdrop"), quality=90, optimize=True)
    render.save(out("render"), optimize=True)
    overlay.save(out("overlay"), optimize=True)
    backdrop.crop((210, 0, 1490, 640)).resize((600, 300), Image.LANCZOS).save(out("card"), quality=90, optimize=True)
    # The tile is the render's head on a crop of the backdrop behind it.
    box = render.getchannel("A").point(lambda a: 255 if a > 128 else 0).getbbox()
    top = next(y for y in range(box[1], box[3]) if any(render.getpixel((x, y))[3] > 128 for x in range(box[0], box[2])))
    row = [x for x in range(box[0], box[2]) if render.getpixel((x, top + 40))[3] > 128]
    cx, size = (row[0] + row[-1]) // 2, 190
    left, upper = max(0, min(520 - size, cx - size // 2)), max(0, top - 12)
    tile = backdrop.crop((RENDER[0] + left, RENDER[1] + upper, RENDER[0] + left + size, RENDER[1] + upper + size)).convert("RGBA")
    tile.alpha_composite(render.crop((left, upper, left + size, upper + size)))
    tile.convert("RGB").resize((96, 96), Image.LANCZOS).save(out("tile"), optimize=True)
    subprocess.run([REPO / "scripts/grade-banner", root, *(out(key) for key in ("card", "backdrop", "render", "overlay", "tile"))], check=True)
    preview = Image.open(out("backdrop")).convert("RGBA")
    preview.alpha_composite(Image.open(out("render")).convert("RGBA"), RENDER)
    over = Image.open(out("overlay")).convert("RGBA")
    preview.alpha_composite(over.crop((0, -OVERLAY[1], over.width, over.height)), (OVERLAY[0], 0))
    preview.save(banner / "banner-preview@2x.png", optimize=True)


if __name__ == "__main__":
    main(sys.argv[1])
