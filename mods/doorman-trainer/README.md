# Doorman Trainer

[BeeeFX](https://github.com/BeeeFX) created [Doorman Trainer](https://github.com/BeeeFX/DoormanTrainer). Hideout builds the mode at the revision pinned by the `upstream` submodule using the same Modlock runtime as the other modes. The upstream MIT license ships in both the host and guest packages. Deadlock and its assets belong to Valve.

The adapter builds the upstream project unchanged. Its Windows launcher and installer are not used. The listing lives in `gameplay/hideout.json`. `content/hideout` holds the banner layers and the explainer's source; `python3 scripts/community-art.py doorman-trainer` exports and grades the listing art from them.

## Updating

Dependabot checks the submodule weekly and proposes a new commit for review. Review the upstream diff, license and manifest, and copy a changed manifest to `gameplay/mod.json`; the build refuses a staged manifest that differs from it. Run `python3 scripts/modes.py build doorman-trainer`, host the build and join from a clean guest installation, then publish a new feed sequence. Merging a pin alone does not update the live feed.
