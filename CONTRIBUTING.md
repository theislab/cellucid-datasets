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

Nothing under `exports/` is written by hand. Every generation is produced by a
writer and replaced whole:

- `notebooks/<id>_1_prepare_anndata.ipynb` builds the AnnData input, and
  `notebooks/<id>_2_export_cellucid.ipynb` calls `cellucid.prepare()` on it.
  These two are the source of the four human atlases.
- `scripts/build_pancreas.py` builds Pancreas end to end from the pinned source
  recorded in `sources/pancreas.json`, against the pinned environment in
  `requirements-pancreas.lock`.

So a fix to a published generation is a fix to the notebook or the script that
wrote it, plus the regenerated `exports/` tree — never an edit to a payload
file or a manifest. A hand-edited export is invisible to review and vanishes at
the next regeneration.

`exports/datasets.json` is likewise written by
`cellucid.prepare_data.generate_datasets_manifest()`.

The same rule covers each sample's published starting view. `scripts/publish_session_preset.mjs`
writes `exports/<id>/default.cellucid-session` from a **Save State** file you
produce in the viewer. Do not rename a save and commit it: a save carries the
whole static chunk registry, a published preset carries five, and the viewer
refuses the difference — a recorded Camera Path is refused by name. The script
imports that rule from the viewer checkout rather than restating it, refuses to
drop any chunk that still holds content, and reads its own output back through
the reader before writing. It prints the digest and the three files that pin it.

---

## Data terms

The prepared datasets in this repository are redistributed from published
third-party studies and stay under the terms of those studies. `LICENSE` sets
out the split between them and this repository's own material, and each
generation names its upstream in `exports/<id>/dataset_identity.json` under
`source`. Do not add a dataset here without recording that block.

---

## Testing & validation

Node.js 20 or newer is required. From the repository root:

```bash
node --test tests/catalog-contract.test.mjs \
  tests/repository-organization-contract.test.mjs \
  tests/session-presets-contract.test.mjs
python -m unittest tests/test_build_pancreas_publish.py
```

These are the same commands `.github/workflows/test.yml` runs, so a green local
run is the same check CI applies. `tests/repository-organization-contract.test.mjs`
also asserts that every suite in `tests/` is named by every workflow, so a new
suite has to be added to the workflow command in the same change.

The suites read the repository as it is on disk: they enumerate `exports/`,
compare each catalog entry against the generation it advertises, and sweep every
text artifact for CRLF bytes and for prose describing paths this repository no
longer has. Adding a file at the root therefore puts it under those sweeps
immediately.

---

## PR guidelines

- Keep PRs small and focused (one generation, or one contract).
- Include what changed, why, and how to verify it in the viewer.
- Regenerate rather than patch: attach the notebook or script diff alongside the
  changed `exports/` tree.
- If a change alters what the catalog advertises, update `README.md` in the same
  change — a suite checks that the README names every catalogued sample.
