# Hidden King's Defense

[Atharv24](https://github.com/Atharv24) created [Hidden King's Defense](https://github.com/Atharv24/deadlock-tower-defense). Hideout builds the mode at the revision pinned by the `upstream` submodule using the same Modlock runtime as the other modes. The upstream MIT license ships in both the host and guest packages. Deadlock and its assets belong to Valve.

The adapter builds `mods/deadlock_td` and applies `scripts/fork-scores.patch`, which moves the leaderboard to the fork's score calls: writes and reads answer on a later frame, and a report names the enrolled connection. Hideout has no score backend, so boards read empty and reports are only logged. The listing lives in `gameplay/hideout.json`. `content/hideout` holds the banner layers and the explainer's source; `python3 scripts/community-art.py deadlock-td` exports and grades the listing art from them.

## Updating

Dependabot checks the submodule weekly and proposes a new commit for review. Review the upstream diff, license and manifest, and copy a changed manifest to `gameplay/mod.json`; the build refuses a staged manifest that differs from it. Run `python3 scripts/modes.py build deadlock-td`, host the build and join from a clean guest installation, then publish a new feed sequence. Merging a pin alone does not update the live feed.
