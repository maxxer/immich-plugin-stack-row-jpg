#!/bin/sh
# Assemble the folder Immich loads: <IMMICH_PLUGINS_INSTALL_FOLDER>/raw-jpg-stacker/{manifest.json,dist/plugin.wasm}
set -e
cd "$(dirname "$0")/.."
rm -rf release
mkdir -p release/raw-jpg-stacker/dist
cp manifest.json release/raw-jpg-stacker/
cp dist/plugin.wasm release/raw-jpg-stacker/dist/
echo "Plugin folder ready: release/raw-jpg-stacker"
