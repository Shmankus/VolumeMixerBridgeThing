# **Audio Panel Thing**

**Webapp for the Spotify Car Thing running [bridgething](https://bridgething.com).**

Description: This webapp allows for windows local audio reading and control. It will show the title and artist of the media playing along with the cover of the media.


## Installation
Clone the repository and install dependencies:
```sh
git clone https://github.com/Shmankus/VolumeMixerBridgeThing.git

cd MyProject

bun install

bun run build && bun run share

```
Then you have the zip file you can put into BridgeThing


## Develop

```sh
bun run dev            # develop the app against a connected bridgething instance
bun run dev:device     # show the dev server on the car thing screen
bun run push           # build and install to the device
bun run check          # ensure the catalog is valid
```

With more than one app in `apps/` your commands must specify which one: `bun run dev native-volume-mixer`.

Screenshot for the store listing:

```sh
bun run shot native-volume-mixer            # grabs what is on the screen
bun run shot native-volume-mixer --replace  # overwrite
```

Add another app

```sh
bun run new weather                 # a webapp
bun run new dashboard --extension   # a webapp plus a desktop-side Deno process
bun run new home --launcher         # a replacement home screen
bun run new hud --overlay           # a system overlay drawn over every webapp
```

Ship

```sh
bun run bump native-volume-mixer patch -m "Fix the wind direction arrow"
git commit -am "native-volume-mixer: fix the wind direction arrow" && git push
```

Pushing to main builds the apps and regenerates the catalog.

Agent skill

`.claude/skills/bridgething/` holds the `/bridgething` skill.

```sh
bun run skills           # refresh it from the published create-bridgething
bun run skills --check   # check whether it is behind
```
