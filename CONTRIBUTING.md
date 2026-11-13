# Contributing to the Cellucid demo datasets

Contributions are welcome — corrections to a published dataset, catalog
metadata fixes, and issues about a sample that will not open.

This file focuses on `cellucid-datasets`, the public atlases behind Cellucid's
built-in sample picker, published as Cellucid-ready AnnData Zarr stores.

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
| `cellucid-r` | R package | are changing `cellucid_prepare()` |
| `cellucid-datasets` (this repo) | The published demo catalog | are correcting a published dataset, its catalog entry, or its starting view |
| `cellucid-annotation` | Reference layout for annotation repositories | are changing the annotation schema, validation, or workflows |
| `cellucid-demo-custom-datasets` | Worked example of publishing your own datasets | are changing that tutorial or its synthetic examples |

A sample that renders wrongly is usually a viewer issue, not a data issue.
Before opening one here, open the same store locally (the **Zarr folder**
button, or `cellucid serve anndata/<id>.zarr`) and read it with
`anndata.read_zarr`: if it is wrong there too, it is data; if it is only wrong
in the app, it is the app.

---

## What is authored here, and what is generated

Nothing under `anndata/` is written by hand. Every store is produced by a
pinned build and replaced whole:

- `scripts/build_atlas.py --dataset <id>` builds Garcia, He, Kanemaru and Suo
  from their integrated source files, which are not redistributable and are
  never committed here. `--source-dir` names the directory that holds them.
- `scripts/build_pancreas.py` builds Pancreas end to end, downloading its
  commit-pinned public source.

Both write `anndata/<id>.zarr` with `cellucid.prepare(format="zarr")` through
`scripts/pinned_build.py`, which refuses to build unless the interpreter, the
exact package set in `requirements-build.lock`, the BLAS runtime, and every
Cellucid producer module `prepare()` executes match
`sources/build-environment.json`. Each dataset's `sources/<id>.json` pins its
source file by size and SHA-256, every intermediate the build derives, the
`uns['cellucid']` the store carries, and the digest of every file it writes;
the staged store is read back with anndata and checked against all of them
before it replaces `anndata/<id>.zarr`. Install the environment with CPython
3.12.13:

```bash
python -m pip install --requirement requirements-build.lock
python -m pip install --no-deps -e ../cellucid-python
python scripts/build_atlas.py --dataset he --source-dir ../.anndatas --force
```

A build that changes a store on purpose runs once with `--record`, which
writes the new measurement into `sources/<id>.json`; a second run without it
must then reproduce the store byte for byte. After a deliberate change to the
producer, `python scripts/pinned_build.py repin-producer` pins the modules
`prepare()` now executes; rebuild every store without `--record` afterwards to
show the change did not reach the bytes.

So a fix to a published dataset is a fix to the build that wrote it, plus its
re-recorded `sources/<id>.json` and the regenerated store — never an edit to a
chunk or a metadata file. A hand-edited store is invisible to review, fails
the store digest, and vanishes at the next rebuild.

`anndata/datasets.json` is the catalog the app reads (schema 2): each
dataset's id, its store folder, and its starting view with the view's exact
byte length and SHA-256. A starting view is a session file (format 4) of one
tracker of one root: the state the sample opens in, with no step.
`scripts/publish_session_preset.mjs` writes `anndata/<id>.cellucid-session`
from a session file you **Save** in the viewer, and repins the catalog entry
beside it:

```bash
node scripts/publish_session_preset.mjs --dataset suo \
    --from ~/Downloads/cellucid-session-2026-11-03.cellucid-session
```

A starting view is a capture of the viewer, so it is captured again whenever
the viewer's session format or a store changes. `scripts/capture_session_preset.mjs`
does that without anybody clicking: it serves the viewer checkout beside this
repository and this repository on loopback, opens the sample from the local
catalog in headless Chromium (which puts back the view the catalog names, as
the published site does, before the sample's history starts), and saves it
with the viewer's own **Save**:

```bash
node scripts/capture_session_preset.mjs --dataset pancreas \
    --enable X_pca:0,1 --out /tmp/pancreas.cellucid-session
node scripts/publish_session_preset.mjs --dataset pancreas \
    --from /tmp/pancreas.cellucid-session
```

`--enable <obsm key>:<columns>` adds a representation to the data mapping
before saving; the Pancreas view enables the first two components of its PCA,
which is its latent space and is not shown on its own. The publisher accepts a
capture in the store's default data mapping with, at most, further
representations enabled. `--action '{"type": …, "params": …}'` dispatches one
of the viewer's actions before saving (repeatable, in order), so a view can be
changed without clicking — `color.by` to color it, `camera.set` to frame it,
`setting.set` for a render setting:

```bash
node scripts/capture_session_preset.mjs --dataset he --out /tmp/he.cellucid-session \
    --action '{"type":"color.by","params":{"field":{"source":"obs","key":"cell_type"}}}'
```

Each action is a step of the saved history; publishing keeps the state they
lead to. To change the view by hand instead — the camera, the colored field —
open the sample in the app, frame it, choose **Save**, and publish that file.

Then check the whole catalog in the viewer, end to end:

```bash
node scripts/verify_catalog.mjs --screenshots /tmp/cellucid-catalog
```

It opens every sample through the sample picker against the local catalog
(`?sampleCatalog=`), checks the starting view (camera, data mapping, colored
field), colors by another field and by a gene, refuses any failure
notification or page error, and prints how long each step took. Both scripts
need the viewer checked out beside this repository with its dependencies
installed (`npm ci`). Every script here and the preset contract read the
viewer from `../cellucid`, or from the checkout `CELLUCID_WEB_ROOT`
names — a worktree of the viewer whose session format changes before it
lands, so the starting views are captured and checked against it in the same
change:

```bash
CELLUCID_WEB_ROOT=../cellucid/.claude/worktrees/<branch> \
    node --test tests/session-presets-contract.test.mjs
```

A test that needs the viewer or cellucid-python skips when that checkout is
absent, unless `CELLUCID_REQUIRE_SIBLINGS=1` is set, which makes its absence a
failure; CI sets it and checks both out at `main`.

Do not rename a save and commit it. A save differs from a published preset in
two ways, and the viewer refuses both while the file still looks perfectly
valid:

- **History.** A save holds the sample's history: its trackers and steps, the
  cells it was open on, the person's own layout (panels, sidebar, theme). A
  published preset is one tracker of one root, with no source, no cells and no
  layout. It keeps the page chrome the save carries beside its history (the
  selection tool the view was reviewed in, `chrome`), which the viewer puts
  back once the view is shown. Publishing makes the save's head that root; it refuses a capture
  whose steps made content — highlights, gene sets, a camera path, cells
  hidden by hand, renamed or user-made fields — naming it.
- **Identity.** A save records where it was taken (a local folder, a served
  copy) and the dataset id that source gave it, while the catalog serves the
  store under its own id. The viewer compares both before applying a published
  default, so a save committed as-is is refused on every open.

The script imports both rules from the viewer checkout rather than restating
them (`trimToPublishedDefault`, `assertPublishedDefaultProfile`). It restates
the identity only after re-deriving the store's cell and gene counts, the data
mapping the viewer opens it with, and the cell-order digest of the coordinates
it holds, so a capture taken against different data is refused instead of
relabeled; and it reads its own output back the way the viewer reads a
starting view before writing. The reviewed camera pinned in
`tests/session-presets-contract.test.mjs` stays a manual pin: it records that
somebody looked at the view.

Because this repository is served straight off its default branch, a commit here
is live as soon as it is pushed. A hook checks the published starting views
before the commit exists rather than after it is public — it runs the preset
contract and only when a view or the catalog is staged. Install it once per
clone:

```bash
git config core.hooksPath .githooks
```

---

## Data terms

The datasets in this repository are redistributed from published third-party
studies and stay under the terms of those studies. `LICENSE` sets out the split
between them and this repository's own material, and each store names its
upstream in `uns['cellucid']` under `source` and `citation`. Do not add a
dataset here without recording both.

---

## Testing & validation

Node.js 22 or newer is required (CI runs 22, 24 and 26). From the repository root:

```bash
node --test tests/catalog-contract.test.mjs \
  tests/repository-organization-contract.test.mjs \
  tests/session-presets-contract.test.mjs
python -m unittest tests/test_pinned_build_publish.py
python -m pip install anndata==0.12.19 zarr==3.1.4 numcodecs==0.16.3
python -m unittest tests/test_anndata_stores.py
```

These are the same commands `.github/workflows/test.yml` runs, so a green local
run is the same check CI applies. `tests/repository-organization-contract.test.mjs`
also asserts that every suite in `tests/` is named by every workflow, so a new
suite has to be added to the workflow command in the same change.

The suites read the repository as it is on disk: they open every store the
catalog lists, compare it byte for byte with the build record in `sources/`,
decode every starting view, and sweep every text artifact for CRLF bytes and
for prose describing paths this repository no longer has.

---

## Comments say what the code does

A comment in a script, a test or a workflow says what the code does and why it
must be so, in the present tense: the invariant it keeps, the failure it
prevents, the unit of a number. It holds no CI run number, no finding, audit or
plan id, no date of our own work, no story of what was tried, and no path into a
repository the reader cannot open. That history goes to the build record
(`sources/<id>.json`) or, for the contract itself, to the Cellucid-ready AnnData
specification in `cellucid-python/docs`, in plain words with its date.

---

## PR guidelines

- Keep PRs small and focused (one dataset, or one contract).
- Include what changed, why, and how to verify it in the viewer.
- Regenerate rather than patch: attach the build diff and the re-recorded
  `sources/<id>.json` alongside the changed store.
- If a change alters what the catalog advertises, update `README.md` in the same
  change — a suite checks that the README names every catalogued sample.
