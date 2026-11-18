# Shattered Arena artwork

Shattered Arena by CosmicCapt. The banner scene and how-to-play map use the arena geometry from [upstream revision 3c1d32d](https://github.com/CosmicCapt/Shattered-Arena/tree/3c1d32d4fc77acd3b80a9f9ea67e6609b6d73e24). See [CosmicCapt’s MIT license](LICENSE-Shattered-Arena). Deadlock, its characters and its game assets belong to Valve.

The editable arena backdrop is in `banner/shattered-arena.blend`. Abrams uses his melee hit animation and Warden uses his airborne stun animation. The backdrop places five Amber lane troopers in front of the portal. The troopers use three poses from the game’s forward run cycle. Their linked Blender collection is in `.local/arena-pit-art/amber-lane-troopers.blend`, alongside the local hero rigs.

| Listing art slot | File under gameplay/art |
| --- | --- |
| backdrop | banner-background@2x.jpg |
| card | card-background@2x.jpg |
| render | abrams-render@2x.png |
| overlay | warden-render@2x.png |
| tile | abrams-thumb@2x.png |
| explainer | how-to-play-map@2x.png |

The backdrop uses the Deadlock brick wall, marble trim and cobblestone color textures. The scene resolves these relative to the repo at `.local/arena-pit-art/surfaces/`. The local JPGs use the RGB channels of the corresponding Source 2 color textures. The portal, its trails, debris, lighting and camera are editable in the Blender scene.

## Gallery order

1. `arena-shot-ringout.jpg` — Warden is airborne beside the pit after Abrams’ heavy melee. The frame follows the impact flash so the knockback is visible.
2. `arena-shot-rift-wave.jpg` — Five Rift Troopers emerge from the Hidden King portal as Warden meets Calico at the gate. Ten enemy hero deaths trigger the wave. Each Rift Trooper that reaches the opposite portal costs its defenders two tickets.
3. `arena-shot-bonus-round.jpg` — Ivy and Abrams face Seven and Warden on the raised platform at the start of the optional last-team-standing bonus round.

Captured in local Shattered Arena 0.2.7 matches with the Hideout Modlock runtime. The ring-out and bonus-round frames were captured at native 1920×1080. The Rift wave was staged in the earlier ultrawide session. The capture setup positioned players and chose the bonus-round camera.
