#!/usr/bin/env python3
"""Build one pinned human developmental-atlas store for Cellucid.

Garcia, He, Kanemaru and Suo are four outputs of one scVI/scANVI integration
pipeline, and one recipe turns each of them into a published Cellucid-ready
AnnData Zarr store:

1. read the integration output, refusing any byte count or SHA-256 other than
   the one ``sources/<id>.json`` pins, and check every array the build reads
   against its recorded digest;
2. apply the published cell subset (Suo only: one lineage of five);
3. curate ``obs``: drop the scVI bookkeeping columns, prune categories the
   subset emptied, publish post-conception age as a continuous field, and trim
   whitespace-padded category labels when trimming merges nothing;
4. compute one kNN graph on the integrated latent space and lay it out as 1D,
   2D and 3D UMAPs, all from that one graph, single-threaded and seeded, so the
   coordinates are a pure function of the pinned inputs and environment;
5. name every gene through the pinned identifier frame and the pinned
   Ensembl-to-symbol table, publish only genes that resolve to a symbol (the
   ``var`` index), and carry the upstream Ensembl accession beside it as
   ``var['ensembl_gene_id']``;
6. call ``cellucid.prepare(format="zarr")`` and validate the staged store
   against every pin before it replaces ``anndata/<id>.zarr``.

The integration outputs themselves are not redistributable and are never
copied into this repository: ``--source-dir`` names the directory that holds
them.

    python scripts/build_atlas.py --dataset he --source-dir ../.anndatas --force

``--record`` writes the measured store into ``sources/<id>.json`` instead of
comparing it with the recorded one; a rebuild without it must then reproduce
the store byte for byte.
"""

from __future__ import annotations

import argparse
import os
import re
import warnings
from pathlib import Path
from typing import Any

import pinned_build as pb

ATLAS_DATASET_IDS = ("garcia", "he", "kanemaru", "suo")
# An Ensembl gene accession, with or without its annotation version.
ENSEMBL_ACCESSION = re.compile(r"^ENSG\d")
DEFAULT_SOURCE_DIR = pb.REPOSITORY_ROOT.parent / ".anndatas"


def _read_source(path: Path, contract: dict[str, Any]) -> dict[str, Any]:
    """Read exactly the elements the build uses, and nothing it does not."""
    import h5py
    from anndata.io import read_elem

    with h5py.File(path, "r") as handle:
        source = {
            "X": read_elem(handle["X"]),
            "obs": read_elem(handle["obs"]),
            "var": read_elem(handle["var"]),
            "obsm": {
                key: read_elem(handle["obsm"][key])
                for key in contract["obsm"]
            },
        }
    return source


def _validate_source(source: dict[str, Any], contract: dict[str, Any]) -> None:
    import numpy as np
    from scipy import sparse

    counts = source["X"]
    obs = source["obs"]
    var = source["var"]
    pb.require_equal("source shape", counts.shape, (contract["n_cells"], contract["n_genes"]))
    if not sparse.isspmatrix_csr(counts) and not isinstance(counts, sparse.csr_array):
        raise ValueError("Source X must be the pinned CSR count matrix.")
    if not np.all(counts.data == np.round(counts.data)):
        raise ValueError("Source X must hold integer counts.")
    digest, nnz = pb.hash_sparse(counts)
    pb.require_equal("source X canonical digest", digest, contract["X_canonical_csr_sha256"])
    pb.require_equal("source X nnz", nnz, contract["X_nnz"])

    pb.require_equal("source obs fields", list(obs.columns), contract["obs_fields"])
    if not obs.index.is_unique:
        raise ValueError("Source cell identifiers must be unique.")
    pb.require_equal(
        "source cell-identifier digest",
        pb.hash_strings(obs.index.tolist()),
        contract["obs_names_json_sha256"],
    )
    pb.require_equal("source obs column digests", pb.obs_frame_digests(obs), contract["obs_digests"])

    # The source carries no gene names: its var index is the positional matrix
    # column number and nothing else, so the identifier frame is aligned to it
    # positionally and that alignment is checked rather than trusted.
    pb.require_equal("source var columns", list(var.columns), [])
    pb.require_equal(
        "source var index",
        var.index.tolist(),
        [str(index) for index in range(contract["n_genes"])],
    )

    for key, expected in contract["obsm"].items():
        array = np.asarray(source["obsm"][key], dtype=np.float32)
        pb.require_equal(f"source obsm[{key!r}] shape", list(array.shape), expected["shape"])
        pb.require_equal(
            f"source obsm[{key!r}] digest", pb.hash_array(array, "<f4"), expected["f32_sha256"]
        )


def _select_cells(source: dict[str, Any], selection: dict[str, Any] | None) -> dict[str, Any]:
    """Apply the published cell subset before anything is computed from the cells."""
    import numpy as np

    if selection is None:
        return source
    lineage = source["obs"][selection["field"]]
    selected = (lineage == selection["value"]).to_numpy()
    pb.require_equal("selected cell count", int(selected.sum()), selection["n_cells"])
    return {
        "X": source["X"][selected],
        "obs": source["obs"][selected].copy(),
        "var": source["var"],
        "obsm": {
            key: np.asarray(values[selected]) for key, values in source["obsm"].items()
        },
    }


def _curate_obs(obs: Any, contract: dict[str, Any]) -> Any:
    import numpy as np
    import pandas as pd

    obs = obs.drop(columns=contract["dropped_fields"])

    pruned: dict[str, list[int]] = {}
    for column in [c for c in obs.columns if isinstance(obs[c].dtype, pd.CategoricalDtype)]:
        before = int(obs[column].cat.categories.size)
        obs[column] = obs[column].cat.remove_unused_categories()
        after = int(obs[column].cat.categories.size)
        if before != after:
            pruned[column] = [before, after]
    pb.require_equal("categories emptied by the subset", pruned, contract["pruned_categories"])

    # Post-conception weeks are an ordered quantity stored as a categorical of
    # numeric strings; left categorical, week 10 would sort before week 6.
    for column in contract["continuous_from_categorical"]:
        obs[column] = obs[column].astype(str).astype(np.float64)
        if not obs[column].notna().all():
            raise ValueError(f"obs[{column!r}] must convert cleanly to a number.")

    # A padded label has no glyph the legend can draw, and trimming is only
    # honest when it merges nothing: categories are renamed, never re-coded.
    trimmed: dict[str, int] = {}
    for column in [c for c in obs.columns if isinstance(obs[c].dtype, pd.CategoricalDtype)]:
        labels = obs[column].cat.categories.tolist()
        padded = [label for label in labels if isinstance(label, str) and label != label.strip()]
        if not padded:
            continue
        stripped = [label.strip() for label in labels]
        if len(set(stripped)) != len(set(labels)):
            raise ValueError(f"Trimming obs[{column!r}] would merge categories.")
        codes_before = obs[column].cat.codes.to_numpy().copy()
        obs[column] = obs[column].cat.rename_categories(stripped)
        if not np.array_equal(obs[column].cat.codes.to_numpy(), codes_before):
            raise ValueError(f"Trimming obs[{column!r}] moved cells between categories.")
        trimmed[column] = len(padded)
    pb.require_equal("trimmed category labels", trimmed, contract["trimmed_labels"])
    pb.require_equal("published obs fields", list(obs.columns), contract["published_fields"])
    pb.require_equal(
        "published obs column digests", pb.obs_frame_digests(obs), contract["published_digests"]
    )
    return obs


def _derive_layout(
    obs: Any,
    latent: Any,
    contract: dict[str, Any],
) -> tuple[Any, dict[int, Any]]:
    """One shared kNN graph and its 1D, 2D and 3D UMAP layouts."""
    import anndata as ad
    import numpy as np
    import pandas as pd
    import scanpy as sc
    from threadpoolctl import threadpool_limits

    graph = contract["neighbors"]
    layout = contract["umap"]
    sc.settings.n_jobs = 1
    host = ad.AnnData(
        obs=pd.DataFrame(index=obs.index.copy()),
        obsm={graph["use_rep"]: latent},
    )
    with threadpool_limits(limits=1):
        sc.pp.neighbors(
            host,
            n_neighbors=graph["n_neighbors"],
            use_rep=graph["use_rep"],
            random_state=graph["random_state"],
        )
        connectivities = host.obsp["connectivities"].tocsr()
        connectivities.eliminate_zeros()
        if (abs(connectivities - connectivities.T) > 0).nnz != 0:
            raise ValueError("The kNN graph must be symmetric.")
        if connectivities.diagonal().sum() != 0:
            raise ValueError("The kNN graph must have a zero diagonal.")
        if not connectivities.data.min() > 0:
            raise ValueError("The kNN graph must not store zero weights.")
        digest, nnz = pb.hash_sparse(connectivities)
        pb.require_equal("kNN graph nnz", nnz, graph["connectivities_nnz"])
        pb.require_equal("kNN graph canonical digest", digest, graph["connectivities_canonical_csr_sha256"])

        embeddings: dict[int, Any] = {}
        for dimension in (1, 2, 3):
            # Each layout runs on a throwaway AnnData carrying the same graph,
            # so sc.tl.umap never rebuilds it and the three stay consistent.
            scratch = ad.AnnData(
                obs=pd.DataFrame(index=obs.index.copy()),
                obsp={
                    "connectivities": host.obsp["connectivities"],
                    "distances": host.obsp["distances"],
                },
                obsm={graph["use_rep"]: latent},
                uns={"neighbors": dict(host.uns["neighbors"])},
            )
            sc.tl.umap(
                scratch,
                n_components=dimension,
                min_dist=layout["min_dist"],
                random_state=layout["random_state"],
            )
            embeddings[dimension] = pb.validate_float_array_contract(
                f"{dimension}D UMAP",
                np.asarray(scratch.obsm["X_umap"], dtype=np.float32),
                layout["embeddings"][f"{dimension}d"],
            )
            del scratch
    return connectivities, embeddings


def _name_genes(
    n_vars: int,
    identifier_path: Path,
    symbol_table_path: Path,
    contract: dict[str, Any],
) -> tuple[Any, list[int]]:
    """Resolve one symbol per gene; a gene with no symbol is not published.

    Returns the published genes' ``var`` -- indexed by symbol, with the
    upstream accession as a column -- and their source column positions.
    """
    import pandas as pd

    identifier_frame = pd.read_pickle(identifier_path)
    pb.require_equal("identifier frame columns", list(identifier_frame.columns), [])
    pb.require_equal("identifier count", len(identifier_frame), n_vars)
    if not identifier_frame.index.is_unique:
        raise ValueError("Upstream gene identifiers must be unique.")
    upstream = [str(identifier) for identifier in identifier_frame.index]
    pb.require_equal(
        "upstream identifier digest", pb.hash_strings(upstream), contract["upstream_ids_json_sha256"]
    )
    symbol_by_accession = pd.read_pickle(symbol_table_path)
    if not isinstance(symbol_by_accession, dict):
        raise TypeError("The symbol table must be one dict.")

    def resolve(identifier: str) -> str | None:
        if not ENSEMBL_ACCESSION.match(identifier):
            # Already a symbol. Looking it up could only replace a real name.
            return identifier
        if identifier in symbol_by_accession:
            return symbol_by_accession[identifier]
        return symbol_by_accession.get(identifier.split(".")[0])

    resolved = [resolve(identifier) for identifier in upstream]
    # A lookup can succeed and still yield an accession; that is no name.
    named = [value is not None and not ENSEMBL_ACCESSION.match(value) for value in resolved]
    gene_names = [
        value if keep else identifier
        for identifier, value, keep in zip(upstream, resolved, named, strict=True)
    ]
    exported = [name for name, keep in zip(gene_names, named, strict=True) if keep]
    if len(set(gene_names)) != len(gene_names):
        raise ValueError("gene_name must be unique over var.")
    passthrough = sum(
        1
        for identifier, keep in zip(upstream, named, strict=True)
        if keep and not ENSEMBL_ACCESSION.match(identifier)
    )
    census = {
        "upstream_identifiers": len(upstream),
        "passed_through": passthrough,
        "translated": len(exported) - passthrough,
        "still_accession": sum(
            1 for value, keep in zip(resolved, named, strict=True) if not keep and value is not None
        ),
        "absent_from_symbol_table": sum(1 for value in resolved if value is None),
        "published": len(exported),
    }
    pb.require_equal("gene naming census", census, contract["census"])
    pb.require_equal(
        "published gene-name digest", pb.hash_strings(exported), contract["published_names_json_sha256"]
    )
    keep = [index for index, flag in enumerate(named) if flag]
    var = pd.DataFrame(
        {contract["accession_name_column"]: [upstream[index] for index in keep]},
        index=pd.Index(exported),
    )
    return var, keep


def _build(
    dataset_id: str,
    source_dir: Path,
    output_path: Path,
    *,
    force: bool,
    record: bool,
    provenance: dict[str, Any],
    cellucid: Any,
) -> None:
    import numpy as np

    inputs = provenance["source"]
    source_path = source_dir / inputs["file"]
    identifier_path = source_dir / provenance["gene_naming"]["identifiers"]["file"]
    symbol_table_path = source_dir / provenance["gene_naming"]["symbol_table"]["file"]
    pb.verify_input_file(source_path, inputs, label=f"{dataset_id} source")
    pb.verify_input_file(
        identifier_path, provenance["gene_naming"]["identifiers"], label="identifier frame"
    )
    pb.verify_input_file(
        symbol_table_path, provenance["gene_naming"]["symbol_table"], label="symbol table"
    )
    print(f"Verified source {inputs['sha256']} ({inputs['size_bytes']:,} bytes).")

    input_contract = provenance["input_contract"]
    analysis = provenance["analysis_contract"]
    contract = provenance["anndata_contract"]
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        source = _read_source(source_path, input_contract)
        _validate_source(source, input_contract)
        source = _select_cells(source, provenance["selection"])
        obs = _curate_obs(source["obs"], provenance["obs_contract"])
        latent = np.asarray(source["obsm"][analysis["neighbors"]["use_rep"]], dtype=np.float32)
        connectivities, umaps = _derive_layout(obs, latent, analysis)
        var, published_columns = _name_genes(
            source["X"].shape[1], identifier_path, symbol_table_path, provenance["gene_naming"]
        )
    pb.require_equal(
        "warnings emitted while deriving",
        sorted({f"{item.category.__name__}: {item.message}" for item in captured}),
        provenance["warning_contract"],
    )

    expression = source["X"].tocsc()[:, published_columns]
    del source["X"]
    obsm: dict[str, Any] = {}
    for key, spec in contract["obsm"].items():
        if spec["origin"] == "umap":
            values = umaps[spec["dimension"]]
        else:
            values = np.asarray(source["obsm"][spec["source_key"]], dtype=np.float32)
            if spec["columns"] is not None:
                values = np.ascontiguousarray(values[:, spec["columns"]])
        obsm[key] = values
    uns = contract["uns_cellucid"]
    defaults = uns["defaults"]
    pb.require_equal(
        "latent space of the neighbour graph",
        defaults["latentKey"],
        analysis["neighbors"]["use_rep"],
    )

    def write_stage(stage: Path) -> None:
        cellucid.prepare(
            stage,
            format="zarr",
            zarr_format=contract["zarr_format"],
            embeddings=obsm,
            dataset_id=uns["id"],
            dataset_name=uns["name"],
            dataset_description=uns["description"],
            citation_text=uns["citation"]["text"],
            citation_url=uns["citation"].get("url"),
            source_name=uns["source"]["name"],
            source_url=uns["source"].get("url"),
            obs=obs,
            var=var,
            gene_expression=expression,
            connectivities=connectivities,
            embedding_defaults={
                f"{dimension}d": defaults[f"embedding{dimension}d"] for dimension in (1, 2, 3)
            },
            latent_key=defaults["latentKey"],
            centroid_min_points=defaults["centroidMinPoints"],
            force=False,
        )

    expected = {
        "obs_names": obs.index.tolist(),
        "var_names": var.index.tolist(),
        "obs": obs,
        "var_columns": {column: var[column].tolist() for column in var.columns},
        "X": expression,
        "obsm": obsm,
        "connectivities": connectivities,
    }

    def validate(stage: Path) -> dict[str, Any]:
        measured = pb.validate_store(stage, contract=contract, expected=expected)
        if not record:
            pb.require_recorded(dataset_id, contract, measured)
        return measured

    measured = pb.stage_validate_publish(
        output_path, force=force, writer=write_stage, validator=validate
    )
    if record:
        pb.record_measurement(dataset_id, measured)


def main() -> None:
    environment = pb.load_environment()
    pb.configure_process(environment)
    parser = argparse.ArgumentParser(
        description=(
            "Rebuild one pinned human developmental-atlas store from its "
            "pinned integration output."
        )
    )
    parser.add_argument("--dataset", required=True, choices=ATLAS_DATASET_IDS)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=Path(os.environ.get("CELLUCID_ANNDATA_DIR", DEFAULT_SOURCE_DIR)),
        help=(
            "Directory holding the pinned integration outputs, varnames/ and "
            "ensembl_to_hgnc.pickle (default: $CELLUCID_ANNDATA_DIR, else "
            "../.anndatas beside this repository)."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Zarr store folder to write (default: anndata/<dataset>.zarr).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Atomically replace an existing store.",
    )
    parser.add_argument(
        "--record",
        action="store_true",
        help=(
            "Record the measured store in sources/<dataset>.json instead of "
            "requiring the recorded one."
        ),
    )
    args = parser.parse_args()
    provenance = pb.load_provenance(args.dataset)
    output = args.output if args.output is not None else pb.store_path(args.dataset)
    output_path = Path(os.path.abspath(os.fspath(output)))

    # Producer and runtime preflights deliberately precede any read or write.
    cellucid = pb.preflight_runtime(environment)
    pb.preflight_output(output_path, force=args.force)
    _build(
        args.dataset,
        args.source_dir.resolve(),
        output_path,
        force=args.force,
        record=args.record,
        provenance=provenance,
        cellucid=cellucid,
    )


if __name__ == "__main__":
    main()
