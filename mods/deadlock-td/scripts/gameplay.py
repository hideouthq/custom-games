#!/usr/bin/env python3
"""Build Atharv24's Hidden King's Defense at the pinned upstream revision with Hideout's Modlock."""
from pathlib import Path
import subprocess
import sys

MODE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODE.parents[1] / "scripts"))
import community


def stage(folder: Path) -> Path:
    # Upstream reads and writes boards with Hyperline's synchronous score calls; the fork answers them on a later frame.
    subprocess.run(["git", "apply", str(MODE / "scripts/fork-scores.patch")], cwd=folder, check=True)
    return folder / "mods/deadlock_td"


if __name__ == "__main__":
    community.main(MODE, "Hidden King's Defense", stage)
