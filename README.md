# KeywordCal Shipping Guide

This repository ships two Thunderbird add-ons:

- `keywordcal.xpi`: the KeywordCal extension.
- `calendar-bridge.xpi`: the companion calendar bridge.

Both versions currently live in their respective `manifest.json` files and must match the release tag. For example, version `1.4.0` is released with the tag `v1.4.0`.

## Release Process

1. Set the same valid version in `keywordcal/manifest.json` and `calendar-bridge/manifest.json`.
2. Run the local checks and package build below.
3. Commit and push the version changes.
4. Create and push the matching tag:

   ```sh
   git tag v1.4.0
   git push origin v1.4.0
   ```

5. GitHub Actions validates the source, builds both XPIs, verifies their contents, and creates a GitHub Release with generated notes. The release contains two separate downloads.

Pushes, pull requests, and manual workflow runs build the packages and upload a workflow artifact. Only a `v*` tag creates a GitHub Release.

## Local Build And Verification

Run from the repository root. This matches the workflow's checks and writes the two packages to `dist/`.

```sh
set -eu

find keywordcal calendar-bridge -name '*.js' -print0 | xargs -0 -n1 node --check

python - <<'PY'
import json
import pathlib

for path in (
    pathlib.Path('keywordcal/manifest.json'),
    pathlib.Path('calendar-bridge/manifest.json'),
    pathlib.Path('calendar-bridge/schema.json'),
):
    with path.open() as source:
        json.load(source)

main = json.loads(pathlib.Path('keywordcal/manifest.json').read_text())
bridge = json.loads(pathlib.Path('calendar-bridge/manifest.json').read_text())
if main['version'] != bridge['version']:
    raise SystemExit(f"Add-on versions differ: {main['version']} != {bridge['version']}")
print(f"Source checks passed for version {main['version']}.")
PY

mkdir -p dist
(cd keywordcal && zip -qr ../dist/keywordcal.xpi .)
(cd calendar-bridge && zip -qr ../dist/calendar-bridge.xpi .)

python - <<'PY'
import zipfile

packages = {
    'dist/keywordcal.xpi': {'manifest.json', '_locales/en/messages.json'},
    'dist/calendar-bridge.xpi': {'manifest.json', 'api.js', 'schema.json'},
}
for path, required in packages.items():
    with zipfile.ZipFile(path) as package:
        missing = required - set(package.namelist())
        if missing:
            raise SystemExit(f"{path} is missing: {sorted(missing)}")
print('Both XPIs contain their required files.')
PY
```

## GitHub Actions Workflow

The executable workflow is `.github/workflows/build-extensions.yml`. Its full contents are below.

```yaml
name: Build Thunderbird Extensions

on:
  push:
    branches: [main, master]
    tags: ['v*']
  pull_request:
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Validate manifests
        run: |
          python - <<'PY'
          import json, os, pathlib

          manifests = [
            pathlib.Path('keywordcal/manifest.json'),
            pathlib.Path('calendar-bridge/manifest.json'),
          ]
          versions = []
          for path in manifests:
            with path.open() as f:
              manifest = json.load(f)
            versions.append(manifest['version'])

          if os.environ.get('GITHUB_REF_TYPE') == 'tag':
            expected = f"v{versions[0]}"
            if any(version != versions[0] for version in versions) or os.environ['GITHUB_REF_NAME'] != expected:
              raise SystemExit(f"Release tag must be {expected} and match both add-on versions: {versions}")

          with pathlib.Path('calendar-bridge/schema.json').open() as f:
            json.load(f)
          print(f"manifests and schema valid; versions: {versions}")
          PY

      - name: Check JavaScript syntax
        run: find keywordcal calendar-bridge -name '*.js' -print0 | xargs -0 -n1 node --check

      - name: Build extension packages
        run: |
          mkdir -p dist
          (cd keywordcal && zip -qr ../dist/keywordcal.xpi .)
          (cd calendar-bridge && zip -qr ../dist/calendar-bridge.xpi .)
          ls -l dist

      - name: Verify extension packages
        run: |
          python - <<'PY'
          import zipfile

          packages = {
              'dist/keywordcal.xpi': {'manifest.json', '_locales/en/messages.json'},
              'dist/calendar-bridge.xpi': {'manifest.json', 'api.js', 'schema.json'},
          }
          for path, required in packages.items():
              with zipfile.ZipFile(path) as package:
                  missing = required - set(package.namelist())
                  if missing:
                      raise SystemExit(f"{path} is missing: {sorted(missing)}")
          print('both XPI packages contain required files')
          PY

      - name: Upload as workflow artifacts
        uses: actions/upload-artifact@v4
        with:
          name: thunderbird-extensions
          path: dist/*.xpi
          if-no-files-found: error

      - name: Publish GitHub release assets
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/keywordcal.xpi
            dist/calendar-bridge.xpi
          generate_release_notes: true
```
