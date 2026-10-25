# RAW + JPEG stacker for Immich

An Immich workflow plugin that groups a RAW file with the JPEG/HEIC the camera wrote alongside it
(`DSC01234.ARW` + `DSC01234.JPG`) into a single **stack**. The timeline shows one photo (the JPEG by
default) with a stack badge; open it to get to the RAW.

Built for Immich **v3.3.x** (tested against the v3.3.5 plugin API).

## How it works

- Runs on the **Metadata extraction** trigger, so capture time and camera are known.
- For each new image whose extension is a RAW or JPEG/HEIC type, it searches your library for
  **unstacked images with the same file name stem**, then keeps only those that:
  - belong to the same user,
  - have the "other" kind of extension (RAW ↔ JPEG/HEIC; two JPEGs are never paired),
  - were taken within *Max time difference* seconds (default 2),
  - come from the same camera make/model (when both files have that info).
- If a RAW + JPEG/HEIC pair is found it creates a stack, cover first (JPEG/HEIC by default).
- Whichever file of the pair is processed second does the stacking, so upload order doesn't matter.
  If both are processed at the same moment, both runs build the same ordered list and Immich merges
  them into one stack.
- Files that are already in a stack, in the trash, videos, or other extensions are left alone.

> **Why an API key?** Immich's plugin host functions (v3.3) can manage albums and tags but not stacks
> or asset search. The plugin therefore calls Immich's own REST API (`/api/search/metadata` and
> `/api/stacks`) through the `httpRequest` host function, authenticated with an API key you put in
> the workflow step. The key is stored in the Immich database with the workflow config.

## Install

### 1. Copy the plugin to the server

The ready-to-use plugin folder is `release/raw-jpg-stacker/`:

```
release/raw-jpg-stacker/
├── manifest.json
└── dist/plugin.wasm
```

Copy it next to your `docker-compose.yml`, e.g. to `./plugins/raw-jpg-stacker/`.

### 2. Enable external plugins

In `docker-compose.yml`, on the **immich-server** service:

```yaml
services:
  immich-server:
    # ...
    environment:
      IMMICH_ALLOW_EXTERNAL_PLUGINS: "true"
      IMMICH_PLUGINS_INSTALL_FOLDER: /plugins
    volumes:
      # ...existing volumes...
      - ./plugins:/plugins:ro
```

(Or put the two variables in your `.env`.) Then `docker compose up -d`. The server log should show:

```
Imported plugin raw-jpg-stacker@0.1.0 (1 methods) from /plugins/raw-jpg-stacker
Loaded plugin with host functions: raw-jpg-stacker@0.1.0/worker
```

Plugins are imported only at startup, so restart the server after installing or upgrading.

### 3. Create an API key (each user)

**Account settings → API keys → New API key**, with at least these permissions:
`asset.read`, `asset.update`, `stack.create`.

### 4. Create the workflow (each user)

Workflows are per user. Each person who wants their RAW+JPEG pairs stacked does this once:

1. Open **Workflows** (`https://<your-immich>/workflows`) → **Use template** → **Stack RAW + JPEG**.
2. Open the *Stack RAW + JPEG* step and paste the API key.
3. Optionally change the cover (JPEG/HEIC or RAW), time tolerance, camera check or extension lists.
4. Save and enable the workflow. Turn on logging while testing so runs show up in the workflow.

> **The trigger must be "Metadata extraction" (`AssetMetadataExtraction`).** The template sets this
> for you. If you create the workflow by hand, the form starts on **Asset created**
> (`AssetCreate`): change it. `AssetCreate` fires at upload time, before EXIF is read (capture
> time and camera are not known yet), and it is **not** fired by re-running the metadata job, so
> existing photos would never be stacked.

Equivalent workflow JSON (Workflows → your workflow → JSON editor):

```json
{
  "name": "Stack RAW + JPEG",
  "enabled": true,
  "trigger": "AssetMetadataExtraction",
  "steps": [
    {
      "method": "raw-jpg-stacker#stackRawJpg",
      "config": { "apiKey": "YOUR_API_KEY", "primary": "JPEG/HEIC" },
      "enabled": true
    }
  ]
}
```

Settings left out of `config` use their defaults (see [Settings](#settings)).

### 5. Stack existing photos (optional)

The workflow fires whenever metadata is extracted, so to process your existing library go to
**Administration → Job queues → Extract metadata → All** (not *Missing*, which skips assets that
were already processed). This re-reads metadata for every asset (it can take a while on large
libraries) and the workflow stacks pairs as it goes. Only users whose workflow is already enabled
get their pairs stacked. It is safe to run again: files already in a stack are skipped.

## Viewing stacks

A stack shows in the timeline as a single thumbnail (the cover) with a stack icon. Open it, and
the other files of the stack (e.g. the CR2) appear as a strip of thumbnails at the bottom of the
viewer; click or tap one to switch to it, e.g. to download the RAW. From an open photo's ⋮ menu you
can make that file the cover or unstack the group.

## Settings

| Setting | Default | Notes |
|---|---|---|
| API key | (required) | Needs `asset.read`, `asset.update`, `stack.create` |
| Stack cover | `JPEG/HEIC` | Which file is shown in the timeline |
| Max time difference (seconds) | `2` | `0` = match on file name only |
| Require same camera | on | Ignored when either file has no make/model |
| RAW extensions | arw, cr2, cr3, nef, raf, orf, rw2, dng, … | Comma-separated |
| JPEG/HEIC extensions | jpg, jpeg, heic, heif, hif | Earlier entries are preferred as cover when there are several |
| Immich server URL | `http://localhost:2283` | How the plugin reaches the API from inside the container |

If you run a **separate microservices container**, set the server URL to the API container,
e.g. `http://immich-server:2283`. The allowed hostnames are `localhost`, `127.0.0.1` and
`immich-server`. For any other host, add it to `allowedHosts` in `manifest.json`, bump the
version, and restart.

## Troubleshooting

- **Nothing happens, and no `raw-jpg-stacker:` lines in the logs:** check the workflow trigger is
  **Metadata extraction** (`"trigger": "AssetMetadataExtraction"`), not *Asset created*. Then check
  the workflow is enabled, and that the logs show
  `Loaded plugin with host functions: raw-jpg-stacker@…/worker`.
- **Still nothing:** turn on workflow logging, then look at the `immich_server` logs. Lines starting with `raw-jpg-stacker:` show what was stacked; skipped files
  are logged at debug level (`IMMICH_LOG_LEVEL=debug`).
- **`POST /search/metadata failed with 401/403`:** wrong API key or missing permissions.
- **`Hostname did not match any listed in methods[].allowedHosts`:** the server URL host isn't in
  the manifest's `allowedHosts` (see above).
- **Plugin not updated after replacing the wasm:** Immich re-imports a plugin only when
  `manifest.json` changes. Bump `version` in the manifest.
- **A pair wasn't stacked:** make sure both files have the same stem (`DSC01234`) and similar
  capture times. Cameras with a separate RAW/JPEG time offset may need a larger tolerance.

## Development

Requirements: Node ≥ 22.6, plus `extism-js` and binaryen (`wasm-merge`, `wasm-opt`) on the
`PATH`. `mise install` provides them using the same versions Immich uses.

```sh
mise install          # node, extism-js, binaryen
npm install
npm test              # unit tests (node:test, no extra deps)
npm run typecheck
npm run package       # builds dist/plugin.wasm and release/raw-jpg-stacker/
```

Layout:

- `src/matching.ts`: pure matching and ordering logic (unit tested)
- `src/stacker.ts`: Immich API calls (search + create stack)
- `src/index.ts`: WASM entry point (`stackRawJpg`) and `httpRequest` host-function bridge
- `src/interface.d.ts`: Extism interface (imports/exports) for `extism-js`
- `manifest.json`: plugin manifest, method schema (workflow UI form) and template

## Future: no API key

A cleaner version would add `searchAssets` and `createStack` host functions to Immich's plugin SDK
(`packages/plugin-sdk/src/host-functions.ts` and `server/src/services/workflow-execution.service.ts`),
so the plugin uses the workflow's own auth token. That needs an upstream change, which fits the
maintainers' stated plan to make auto-stacking possible through workflows
([discussion #2479](https://github.com/immich-app/immich/discussions/2479)).

## License

AGPL-3.0, same as Immich.
