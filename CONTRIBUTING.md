# Contributing to the Cellucid demo datasets

Contributions are welcome — corrections to a published generation, catalog
metadata fixes, and issues about a sample that will not open.

This file focuses on `cellucid-datasets`, the prepared public atlases behind
Cellucid's built-in sample picker.

By participating, you agree to follow the project’s Code of Conduct:
- `CODE_OF_CONDUCT.md`

If you’re reporting a security issue, please follow:
- `SECURITY.md`

---

## Which repo should I contribute to?

Cellucid is split by responsibility:

| Repo | What it is | Contribute here when you… |
|---|---|---|
| `cellucid` | Web app (UI + state + WebGL rendering) | are fixing how the viewer draws, filters, or exports what it loaded |
| `cellucid-python` | Python package + CLI + Sphinx docs | are fixing `prepare`/`serve`, or any documentation page for any repository |
| `cellucid-r` | R package exporter | are changing `cellucid_prepare()` |
| `cellucid-datasets` (this repo) | The published demo catalog | are correcting a published generation, its catalog entry, or its session preset |
| `cellucid-annotation` | Reference layout for annotation repositories | are changing the annotation schema, validation, or workflows |
| `cellucid-demo-custom-datasets` | Worked example of publishing your own datasets | are changing that tutorial or its synthetic examples |

A sample that renders wrongly is usually a viewer issue, not a data issue.
Before opening one here, load the same generation from a local prepared folder:
if it is wrong there too, it is data; if it is only wrong in the app, it is the
app.

---

## What is authored here, and what is generated

Nothing under `exports-v3/` is written by hand. Every generation is produced by a
pinned build and replaced whole:

- `scripts/build_atlas.py --dataset <id>` builds Garcia, He, Kanemaru and Suo
  from their integrated source files, which are not redistributable and are
  never committed here. `--source-dir` names the directory that holds them.
- `scripts/build_pancreas.py` builds Pancreas end to end, downloading its
  commit-pinned public source.

Both run through `scripts/pinned_build.py`, which refuses to build unless the
interpreter, the exact package set in `requirements-build.lock`, the BLAS
runtime, and every Cellucid producer module the export path executes match
`sources/build-environment.json`. Each dataset's `sources/<id>.json` pins its
source file by size and SHA-256, every intermediate the build derives, and the
identity, payload digests and whole-generation digest of what it writes; the
staged generation is checked against all of them before it replaces
`exports-v3/<id>/`. Install the environment with CPython 3.12.13:

```bash
python -m pip install --requirement requirements-build.lock
python -m pip install --no-deps -e ../cellucid-python
python scripts/build_atlas.py --dataset he --source-dir ../.anndatas --force
```

The four `notebooks/<id>_1_prepare_anndata.ipynb` and
`<id>_2_export_cellucid.ipynb` pairs are the annotated recipe the atlas builder
transcribes. They write their own export outside every repository and never
replace a published generation.

So a fix to a published generation is a fix to the build that wrote it, plus
its repinned `sources/<id>.json` and the regenerated `exports-v3/` tree — never an
edit to a payload file or a manifest. A hand-edited export is invisible to
review, fails the generation digest, and vanishes at the next rebuild.

`exports-v3/datasets.json` lists each generation's id and directory and the digest
of its published starting view, which the preset publisher below repins.

The same rule covers each sample's published starting view. `scripts/publish_session_preset.mjs`
writes `exports-v3/<id>/default.cellucid-session` from a **Save State** file you
produce in the viewer:

```bash
node scripts/publish_session_preset.mjs --dataset suo \
    --from ~/Downloads/cellucid-session-2026-08-04.cellucid-session
```

Do not rename a save and commit it. A save differs from a published preset in
two ways, and the viewer refuses both while the file still looks perfectly
valid:

- **Chunks.** A save carries the whole static chunk registry, a published preset
  carries five. A recorded Camera Path is refused by name.
- **Identity.** You author a preset by serving the prepared generation locally,
  so the save records that serve — `local-user`, and an id the local source
  invented — while the catalog serves the same bytes as `local-demo` under the
  generation's own id. The viewer compares both before applying a published
  default, so a save committed as-is is refused on every open and the sample
  shows none of its view.

The script imports both rules from the viewer checkout rather than restating
them. It refuses to drop a chunk that still holds content; it restates the
identity only after re-deriving the generation's cell and gene counts from
`dataset_identity.json` and recomputing its cell-order digest from the
coordinates it ships, so a capture taken against different data is refused
instead of relabelled; and it reads its own output back through the reader
before writing.

It then repoints `exports-v3/datasets.json` at the new digest itself. That file is
served straight off the default branch, so a preset replaced without it is live
and broken the moment it is pushed — "does not match the advertised generation"
— and the contract suite can only report that afterwards. The artifact and its
advertisement now move together or not at all.

Two pins stay manual, and both are review records rather than artifacts: the
digest and the reviewed camera in `tests/catalog-contract.test.mjs` and
`tests/session-presets-contract.test.mjs`. The script prints what to put there.
Forgetting them fails CI; forgetting the catalog used to break the live site.

Because this repository is served straight off its default branch, a commit here
is live as soon as it is pushed. A hook checks the published states before the
commit exists rather than after it is public — it runs the preset contract, in
under a second, and only when a state or the catalog is staged. Install it once
per clone:

```bash
git config core.hooksPath .githooks
```

---

## Data terms

The prepared datasets in this repository are redistributed from published
third-party studies and stay under the terms of those studies. `LICENSE` sets
out the split between them and this repository's own material, and each
generation names its upstream in `exports-v3/<id>/dataset_identity.json` under
`source`. Do not add a dataset here without recording that block.

---

## Testing & validation

Node.js 20 or newer is required. From the repository root:

```bash
node --test tests/catalog-contract.test.mjs \
  tests/repository-organization-contract.test.mjs \
  tests/session-presets-contract.test.mjs
python -m unittest tests/test_pinned_build_publish.py
```

These are the same commands `.github/workflows/test.yml` runs, so a green local
run is the same check CI applies. `tests/repository-organization-contract.test.mjs`
also asserts that every suite in `tests/` is named by every workflow, so a new
suite has to be added to the workflow command in the same change.

The suites read the repository as it is on disk: they enumerate `exports-v3/`,
compare each catalog entry against the generation it advertises, and sweep every
text artifact for CRLF bytes and for prose describing paths this repository no
longer has. Adding a file at the root therefore puts it under those sweeps
immediately.

---

## PR guidelines

- Keep PRs small and focused (one generation, or one contract).
- Include what changed, why, and how to verify it in the viewer.
- Regenerate rather than patch: attach the build diff and the repinned
  `sources/<id>.json` alongside the changed `exports-v3/` tree.
- If a change alters what the catalog advertises, update `README.md` in the same
  change — a suite checks that the README names every catalogued sample.
