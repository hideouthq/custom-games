# Custom games

Deadlock custom game modes that Hideout hosts and joins, and the tools that publish them to Hideout's custom games feed.

| Mode | Gameplay |
| --- | --- |
| Bebop Wars (`mods/bebop-wars`) | Hook battles for 1v1, 2v2 and 3v3, with melee, rescues and native equipment |
| Rooftop Rally (`mods/rooftop-rally`) | A Yamato free-for-all with an accelerating orb, custom blocks and a choice of Power Slash, Blink or Time Freeze |
| Pillars (`mods/pillars`) | Last player standing on pillars over a void, with a random drop every few seconds and one life a round |

Each mode holds its gameplay, authored map and assets, tests and build scripts. All three run on one [Modlock](https://github.com/hideouthq/modlock) runtime, pinned in `runtime.json`, because a game session runs one runtime. `feed/` builds and signs the feed Hideout reads.

## Set up

You need Linux x86_64, `git`, Python 3.11 or newer and Node 22.6 or newer.

```sh
git clone --recurse-submodules https://github.com/hideouthq/custom-games.git
cd custom-games
python3 scripts/runtime.py install
```

`install` downloads the pinned Go, Zig and Bun into `.tools`, and clones the Modlock fork at the pinned commit into `.tools/modlock`. Each mode's asset SDK is a submodule at `mods/<mode>/tools/modlock-sdk`.

## Work on a mode

`scripts/modes.py` runs the same commands for every mode. With no mode, `test`, `ready` and `build` take all three.

```sh
python3 scripts/modes.py test [MODE...]    # unit tests and typecheck
python3 scripts/modes.py ready [MODE...]   # what this computer still lacks to build
python3 scripts/modes.py build [MODE...]   # mods/MODE/gameplay/build, with the listing and its art
python3 scripts/modes.py dev MODE          # a live session that reloads on save
python3 scripts/modes.py play MODE         # a session of the built mode
```

`dev` and `play` pass on the flags they don't know, such as `--no-game`, `--teams 1v1` or `--bots 3`. A build needs the mode's compiled map, and compiling a map needs the asset toolkit, Proton and a desktop session. Hideout's **Host mode folders** takes a build folder, so a second player can join it before it is published.

`python3 scripts/modes.py check` runs every check that needs no game. To run it before every push, run `git config core.hooksPath scripts/hooks`.

## Publish

`release.json` names the modes and upcoming modes the feed carries. The upcoming listings are in `upcoming/`.

```sh
python3 scripts/modes.py publish
```

Without a key this is a dry run. It builds every mode, writes the feed to `.local/publish/out` signed with a throwaway key, and prints what differs from the live feed. Nothing is uploaded.

```sh
python3 scripts/modes.py publish --key /path/to/feed-key.pem --upload
```

This signs with the feed's key and uploads the runtime files, packages and art first, then the feed and its signature. Then it reads the live feed back and checks it. Wrangler needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the site's account. To pass a mode built on another computer, use `--mode pillars=/path/to/build`.

## Move to a new runtime

```sh
python3 scripts/runtime.py pin    # or a branch, tag or commit of the fork
python3 scripts/runtime.py build
```

`pin` writes the commit to `runtime.json` and moves Hideout's link helper to the same commit in the Hideout checkout at `HIDEOUT_REPO`, else `../hideout`. Commit both. `build` builds the runtime files and records their digests. A published runtime's files are never replaced, so a rebuild that differs needs a new pin.

## License

The modes and scripts are free software under the [GNU General Public License v3.0](LICENSE). The Modlock SDK submodules keep their own license.
