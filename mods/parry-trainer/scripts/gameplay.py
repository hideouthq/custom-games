#!/usr/bin/env python3
"""Build mapleroyal's Parry Trainer at the pinned upstream revision with Hideout's Modlock."""
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
import sys

MODE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODE.parents[1] / "scripts"))
import community


def stage(folder: Path) -> Path:
    # Upstream's bin/hyperline assembles the project: the shared modules, the native menu, the
    # persistence schema and the quiet-melee definitions. Reuse its stage() and build with the fork.
    sys.path.insert(0, str(folder / "bin"))
    loader = SourceFileLoader("parry_hyperline", str(folder / "bin/hyperline"))
    hyperline = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(hyperline)
    project = folder.parent / "project"
    project.mkdir()
    hyperline.stage(project, None)
    return project


if __name__ == "__main__":
    community.main(MODE, "Parry Trainer", stage)
