# Cellucid demo datasets

This repository is the public demo-dataset extension of
[Cellucid](https://github.com/theislab/cellucid). It supplies the prepared
examples shown in Cellucid’s built-in sample picker; the viewer itself, data
preparation packages, and user documentation live in the linked ecosystem
repositories below.

## Explore the examples

Open [cellucid.com](https://www.cellucid.com), choose a sample, and start
exploring. The catalog includes:

- **Suo** — the default tour of the developing human immune system
- **Pancreas** — pancreatic endocrinogenesis with 1D, 2D, and 3D embeddings,
  gene expression, connectivities, and RNA-velocity overlays
- **Garcia, He, and Kanemaru** — prepared developmental and spatial atlases

These datasets are demonstrations, not templates for storing your own data in
this repository.

Each built-in catalog entry uses paired `state_manifest` and `state_sha256`
fields to advertise and verify one lightweight close-up state beside its
prepared generation: `cell_type` coloring, a static 3D Orbit view, and the
light grid background, with no camera animation or changed filters.

## Publish your own datasets

Start with
[cellucid-demo-custom-datasets](https://github.com/theislab/cellucid-demo-custom-datasets)
for three small, complete examples and a step-by-step guide to creating and
hosting your own dataset repository. For private data, large atlases, direct
AnnData loading, or server-based workflows, use the
[data-loading guide](https://cellucid.readthedocs.io/en/latest/user_guide/web_app/b_data_loading/index.html).

## Cellucid ecosystem

- [Web application](https://github.com/theislab/cellucid)
- [Documentation](https://cellucid.readthedocs.io/en/latest/)
- [Python package](https://github.com/theislab/cellucid-python)
- [R package](https://github.com/theislab/cellucid-r)
- [Community annotation repository](https://github.com/theislab/cellucid-annotation)
- [Custom dataset repository examples](https://github.com/theislab/cellucid-demo-custom-datasets)
