#!/usr/bin/env python3
"""Build sh3lk's Ability Draft at the pinned upstream revision with Hideout's Modlock."""
from pathlib import Path
import sys

MODE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODE.parents[1] / "scripts"))
import community

if __name__ == "__main__":
    community.main(MODE, "Ability Draft")
