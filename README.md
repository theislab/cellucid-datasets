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

Cellucid publishes one name per gene and no second identifier, so that name is
the only way to reach a gene in the gene search, the legend, or an analysis
window. Every sample publishes fewer genes than its source file holds:

| sample | genes in the source | published | left out |
| --- | --- | --- | --- |
| Suo | 8,192 | 5,103 | 3,089 |
| Garcia | 8,192 | 5,754 | 2,438 |
| He | 8,192 | 5,152 | 3,040 |
| Kanemaru | 8,192 | 3,691 | 4,501 |
| Pancreas | 27,998 | 3,753 | 24,245 |

The four human sources are integrated files already cut to 8,192 features
upstream, and they name genes by Ensembl accession, not symbol. Their export
notebooks translate those accessions against a fixed symbol table, with no
network lookup. **A gene whose accession has no symbol is not published at
all**, because an accession is not a name a reader would type. Each
`<id>_2_export_cellucid.ipynb` prints that breakdown, including accessions the
table resolves only to another accession, which count as unnamed too.

Pancreas is mouse and arrives with MGI symbols, so no translation applies. Its
pinned build script publishes only the genes its source marks
`highly_variable_genes == "True"` that are also nonconstant.

Each built-in catalog entry uses paired `state_manifest` and `state_sha256`
fields to advertise and verify one lightweight close-up state beside its
prepared generation: `cell_type` coloring, a static 3D Orbit view, and the
light grid background, with no camera animation or changed filters.

## How reproducible each sample is

The five do not carry the same guarantee. **Pancreas** is rebuilt by a pinned
script that verifies its source, its environment, the exporter's own code, and a
digest of all it writes, so a rebuild that differed would stop rather than
publish. The other four come from the notebooks in `notebooks/`, which pin no
version and take no checksum, and read source data this repository does not
hold. `sources/unpinned-generations.json` records what can still be checked
about them, and says plainly what that does not prove.

## Publish your own datasets

Start with
[cellucid-demo-custom-datasets](https://github.com/theislab/cellucid-demo-custom-datasets)
for three small, complete examples and a step-by-step guide to creating and
hosting your own dataset repository. For private data, large atlases, direct
AnnData loading, or server-based workflows, use the
[data-loading guide](https://cellucid.readthedocs.io/en/latest/user_guide/web_app/b_data_loading/index.html).

## Licensing and data terms

`LICENSE` covers this repository's own material — the export notebooks, the
build script, the test suites, and the catalog metadata — under BSD 3-Clause.

The prepared datasets under `exports/` are not covered by it. They are
redistributed from published third-party studies and stay under the terms of
those studies. Each generation names its upstream in
`exports/<id>/dataset_identity.json` under `source`, with the study name, its
URL, and the citation to use. Read those terms at the study before reusing a
dataset, and cite the study rather than this repository.

## Cellucid ecosystem

- [Web application](https://github.com/theislab/cellucid)
- [Documentation](https://cellucid.readthedocs.io/en/latest/)
- [Python package](https://github.com/theislab/cellucid-python)
- [R package](https://github.com/theislab/cellucid-r)
- [Community annotation repository](https://github.com/theislab/cellucid-annotation)
- [Custom dataset repository examples](https://github.com/theislab/cellucid-demo-custom-datasets)
