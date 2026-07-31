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
- **Garcia, He, and Kanemaru** — prepared developmental atlases of the gonad,
  the fetal lung, and the heart

These datasets are demonstrations, not templates for storing your own data in
this repository.

## Gene names, and the genes these samples leave out

Cellucid publishes one name per gene and no second identifier, so the name in a
sample is the only way to reach that gene in the gene search, the legend, or an
analysis window.

The four human samples arrive from their integration pipeline carrying Ensembl
accessions rather than symbols, and their export notebooks translate those
accessions once, against a fixed symbol table, with no network lookup. **A gene
whose accession has no symbol is not published at all**, because an accession is
not a name a reader can type. That removes a large part of each gene axis:

| sample | genes in the source | published | left out |
| --- | --- | --- | --- |
| Suo | 8,192 | 5,103 | 3,089 |
| Garcia | 8,192 | 5,754 | 2,438 |
| He | 8,192 | 5,152 | 3,040 |
| Kanemaru | 8,192 | 3,691 | 4,501 |

Pancreas is mouse, arrives with MGI symbols, and publishes all 3,753 of its
genes under the names its source gave them.

Each sample's `<id>_2_export_cellucid.ipynb` prints the full breakdown of that
count, including how many accessions the symbol table resolves only to another
accession. Those count as unnamed and are left out with the rest.

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
