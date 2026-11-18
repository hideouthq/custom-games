# Shattered Arena

[CosmicCapt](https://github.com/CosmicCapt) created [Shattered Arena](https://github.com/CosmicCapt/Shattered-Arena). Hideout builds the mode at the revision pinned by the `upstream` submodule using the same Modlock runtime as the other modes. The upstream MIT license ships in both the host and guest packages. Deadlock and its assets belong to Valve.

The 0.2.7 adapter places the newer root map and four source files at their import paths. It applies `scripts/native-rifts.patch` to draw each portal with the native-size effects in the player's Deadlock installation. Portal scoring uses the upstream rules. The approved listing and artwork live in `gameplay/`.

## Updating

Dependabot checks the submodule weekly and proposes a new commit for review. To check one manually, run `git submodule update --remote mods/arena-pit/upstream` from the repository root, then stage the gitlink. The build reads the staged pin. Review the upstream diff, license, manifest, file layout and portal patch. Update the listing and artwork if the rules or appearance change.

Run `python3 scripts/modes.py check`, build with `python3 scripts/modes.py build arena-pit`, then host the build and join from a clean guest installation. Commit the reviewed pin and integration changes. Use the repository's dry run and signed publish commands to release it. Merging a pin alone does not update the live feed. To roll back, restore the previous pin and integration from Git and publish a new feed sequence.
