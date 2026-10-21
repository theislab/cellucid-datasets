#!/usr/bin/env python3
"""Build the exact pinned scVelo Pancreas generation for Cellucid.

The source is the commit-pinned scVelo notebook file, downloaded when
``--source`` is omitted. What is derived from it - the 1D and 3D UMAPs, the
stochastic velocity fit and its projections onto the 1D, 2D and 3D layouts -
is recomputed single-threaded and seeded, and every intermediate is checked
against ``sources/pancreas.json``. The environment, the producer pins, the
staged publication and the generation checks shared with the atlas builder
live in ``pinned_build.py``.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import urllib.request
import warnings
from pathlib import Path
from typing import Any

import pinned_build as pb

DATASET_ID = "pancreas"

def _download_source(destination: Path, source_contract: dict[str, Any]) -> None:
    request = urllib.request.Request(
        source_contract["url"],
        headers={"User-Agent": "cellucid-datasets-pancreas-builder/2"},
    )
    with (
        urllib.request.urlopen(request, timeout=120) as response,
        destination.open("wb") as target,
    ):
        while chunk := response.read(pb.READ_CHUNK_BYTES):
            target.write(chunk)
        target.flush()
        os.fsync(target.fileno())


def _validate_warning(
    warning: warnings.WarningMessage,
    contract: dict[str, Any],
) -> None:
    pb.require_equal("warning category", warning.category.__name__, contract["category"])
    pb.require_equal("warning message", str(warning.message), contract["message"])
    normalized_filename = Path(warning.filename).as_posix()
    if not normalized_filename.endswith(contract["filename_suffix"]):
        raise ValueError(
            f"warning owner is {normalized_filename!r}; "
            f"expected suffix {contract['filename_suffix']!r}."
        )
    pb.require_equal("warning source line", warning.lineno, contract["line"])


def _read_source_warning_clean(source_path: Path, provenance: dict[str, Any]) -> Any:
    import anndata as ad
    from anndata._warnings import OldFormatWarning

    contract = provenance["warning_contract"]["legacy_h5ad_read"]
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        source = ad.read_h5ad(source_path)
    pb.require_equal("legacy H5AD warning count", len(captured), contract["count"])
    pb.require_equal(
        "legacy H5AD warning messages",
        [str(item.message) for item in captured],
        contract["messages_in_order"],
    )
    pb.require_equal(
        "legacy H5AD OldFormatWarning count",
        sum(item.category is OldFormatWarning for item in captured),
        contract["old_format_warning_count"],
    )
    pb.require_equal(
        "legacy H5AD FutureWarning count",
        sum(item.category is FutureWarning for item in captured),
        contract["future_warning_count"],
    )
    return source


def _validate_source(source: Any, provenance: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    from scipy import sparse

    contract = provenance["input_contract"]
    digests = contract["digests"]
    pb.require_equal(
        "Pancreas AnnData shape",
        source.shape,
        (contract["n_cells"], contract["n_genes"]),
    )
    if not source.obs_names.is_unique or not source.var_names.is_unique:
        raise ValueError(
            "Pancreas observation and gene identifiers must both be unique."
        )
    pb.require_equal(
        "Pancreas obs fields", list(source.obs.columns), contract["obs_fields"]
    )
    pb.require_equal(
        "Pancreas var fields", list(source.var.columns), contract["var_fields"]
    )
    pb.require_equal(
        "Pancreas layers", list(source.layers.keys()), contract["layer_keys"]
    )
    if not sparse.issparse(source.X):
        raise ValueError("Pancreas X must remain the pinned sparse expression matrix.")

    pb.require_equal(
        "obs-name digest",
        pb.hash_strings(source.obs_names.tolist()),
        digests["obs_names_json_sha256"],
    )
    pb.require_equal(
        "var-name digest",
        pb.hash_strings(source.var_names.tolist()),
        digests["var_names_json_sha256"],
    )
    for field, expected_levels in contract["categorical_levels"].items():
        values = source.obs[field]
        if values.isna().any():
            raise ValueError(
                f"Pancreas obs[{field!r}] must not contain missing values."
            )
        actual_levels = [str(value) for value in values.cat.categories]
        pb.require_equal(
            f"Pancreas obs[{field!r}] levels", actual_levels, expected_levels
        )
        pb.require_equal(
            f"Pancreas obs[{field!r}] category digest",
            pb.hash_strings(values.cat.categories.tolist()),
            digests[f"{field}_categories_json_sha256"],
        )
        pb.require_equal(
            f"Pancreas obs[{field!r}] code digest",
            pb.hash_array(values.cat.codes, "<i4"),
            digests[f"{field}_codes_i32_sha256"],
        )
    for field in contract["continuous_fields"]:
        values = source.obs[field].to_numpy()
        pb.require_finite(f"Pancreas obs[{field!r}]", values)
        pb.require_equal(
            f"Pancreas obs[{field!r}] digest",
            pb.hash_array(values, "<f8"),
            digests[f"{field}_f64_sha256"],
        )

    marker_contract = contract["highly_variable_marker"]
    marker = source.var[marker_contract["field"]]
    pb.require_equal(
        "source var-marker digest",
        pb.hash_strings(marker.tolist()),
        digests["highly_variable_genes_json_sha256"],
    )
    source_marked = np.asarray(marker == marker_contract["selected_value"], dtype=bool)
    pb.require_equal(
        "source-marked gene count",
        int(source_marked.sum()),
        marker_contract["marked_genes"],
    )
    marked_indices = np.flatnonzero(source_marked)
    marked_expression = source.X[:, marked_indices]
    minima = np.asarray(marked_expression.min(axis=0).toarray()).ravel()
    maxima = np.asarray(marked_expression.max(axis=0).toarray()).ravel()
    selected_indices = marked_indices[maxima > minima]
    public_contract = provenance["public_gene_contract"]
    pb.require_equal(
        "public gene count", int(selected_indices.size), public_contract["n_genes"]
    )
    selected_expression = source.X[:, selected_indices]
    selected_var = source.var.iloc[selected_indices].copy()
    selected_genes = source.var_names[selected_indices].tolist()
    pb.require_equal(
        "ordered public gene-ID digest",
        pb.hash_strings(selected_genes),
        public_contract["ordered_gene_ids_json_sha256"],
    )
    pb.require_equal(
        "selected var digest",
        pb.hash_strings(selected_var[marker_contract["field"]].tolist()),
        public_contract["selected_var_json_sha256"],
    )
    expression_digest, expression_nnz = pb.hash_sparse(selected_expression)
    pb.require_equal(
        "public expression digest",
        expression_digest,
        public_contract["expression_canonical_csr_sha256"],
    )
    pb.require_equal(
        "public expression nnz", expression_nnz, public_contract["expression_nnz"]
    )

    source_x_digest, _ = pb.hash_sparse(source.X)
    pb.require_equal(
        "source X digest", source_x_digest, digests["source_X_canonical_csr_sha256"]
    )
    for layer in contract["layer_keys"]:
        layer_digest, _ = pb.hash_sparse(source.layers[layer])
        pb.require_equal(
            f"source {layer} digest",
            layer_digest,
            digests[f"{layer}_canonical_csr_sha256"],
        )

    embedding_contract = contract["source_embedding"]
    source_2d = np.asarray(source.obsm[embedding_contract["key"]], dtype=np.float32)
    pb.require_equal(
        "source 2D shape",
        source_2d.shape,
        (contract["n_cells"], embedding_contract["dimensions"]),
    )
    pb.require_finite("source 2D UMAP", source_2d)
    pb.require_equal(
        "source 2D digest",
        pb.hash_array(source_2d, "<f4"),
        digests["source_umap_2d_f32_sha256"],
    )

    latent_contract = contract["latent_space"]
    latent_space = np.asarray(source.obsm[latent_contract["key"]], dtype=np.float32)
    pb.require_equal(
        "source latent-space shape",
        latent_space.shape,
        (contract["n_cells"], latent_contract["dimensions"]),
    )
    pb.require_finite("source PCA latent space", latent_space)
    pb.require_equal(
        "source PCA digest",
        pb.hash_array(latent_space, "<f4"),
        digests["source_pca_f32_sha256"],
    )

    connectivity_key = contract["connectivity_key"]
    if connectivity_key not in source.obsp:
        raise ValueError(f"Pancreas source must expose obsp[{connectivity_key!r}].")
    source_connectivity = source.obsp[connectivity_key]
    connectivity_digest, _ = pb.hash_sparse(source_connectivity)
    pb.require_equal(
        "source connectivity digest",
        connectivity_digest,
        digests["source_connectivity_canonical_csr_sha256"],
    )
    return {
        "expression": selected_expression,
        "var": selected_var,
        "genes": selected_genes,
        "source_2d": source_2d.copy(),
        "latent_space": latent_space.copy(),
        "connectivity": source_connectivity,
    }


def _derive_public_obs(source: Any, provenance: dict[str, Any]) -> Any:
    input_contract = provenance["input_contract"]
    derived_contracts = provenance["export_contract"]["derived_obs_fields"]
    pb.require_equal(
        "Pancreas derived obs field keys",
        list(derived_contracts),
        ["cell_type"],
    )

    contract = derived_contracts["cell_type"]
    pb.require_equal(
        "Pancreas cell_type ownership",
        contract["ownership"],
        "derived convenience alias",
    )
    source_field = contract["source_field"]
    if source_field not in input_contract["categorical_levels"]:
        raise ValueError(
            "Pancreas derived cell_type must reference one source-owned "
            "categorical obs field."
        )
    if "cell_type" in source.obs.columns:
        raise ValueError(
            "Pancreas source unexpectedly contains obs['cell_type']; the public "
            "field must remain an explicitly derived alias."
        )

    published_obs = source.obs.copy(deep=True)
    published_obs["cell_type"] = source.obs[source_field].copy(deep=True)
    pb.require_equal(
        "Pancreas source obs fields after alias derivation",
        list(source.obs.columns),
        input_contract["obs_fields"],
    )
    pb.require_equal(
        "Pancreas published obs fields",
        list(published_obs.columns),
        [*input_contract["obs_fields"], *derived_contracts],
    )

    source_values = source.obs[source_field]
    derived_values = published_obs["cell_type"]
    if derived_values.isna().any():
        raise ValueError(
            "Pancreas derived obs['cell_type'] must not contain missing values."
        )
    pb.require_equal(
        "Pancreas derived cell_type category order",
        derived_values.cat.categories.tolist(),
        source_values.cat.categories.tolist(),
    )
    pb.require_equal(
        "Pancreas derived cell_type ordered flag",
        derived_values.cat.ordered,
        source_values.cat.ordered,
    )
    pb.require_equal(
        "Pancreas derived cell_type category digest",
        pb.hash_strings(derived_values.cat.categories.tolist()),
        contract["categories_json_sha256"],
    )
    pb.require_equal(
        "Pancreas derived cell_type category provenance",
        contract["categories_json_sha256"],
        input_contract["digests"][f"{source_field}_categories_json_sha256"],
    )
    pb.require_equal(
        "Pancreas derived cell_type code digest",
        pb.hash_array(derived_values.cat.codes, "<i4"),
        contract["codes_i32_sha256"],
    )
    pb.require_equal(
        "Pancreas derived cell_type code provenance",
        contract["codes_i32_sha256"],
        input_contract["digests"][f"{source_field}_codes_i32_sha256"],
    )
    return published_obs


def _derive_analysis(
    source: Any, provenance: dict[str, Any], *, root_random_seed: int
) -> tuple[dict[int, Any], dict[str, Any]]:
    import numpy as np
    import scanpy as sc
    import scvelo as scv
    from threadpoolctl import threadpool_limits

    analysis_contract = provenance["analysis_contract"]
    warning_contract = provenance["warning_contract"]
    analysis = source.copy()
    np.random.seed(root_random_seed)
    sc.settings.n_jobs = 1

    with threadpool_limits(limits=1):
        preprocessing = analysis_contract["preprocessing"]
        scv.pp.filter_genes(analysis, min_shared_counts=20)
        pb.require_equal(
            "shared-count-filtered gene count",
            analysis.n_vars,
            preprocessing["genes_after_shared_count_filter"],
        )
        scv.pp.normalize_per_cell(analysis, layers=None)
        # Scanpy's current Seurat implementation accepts log1p values and reverses
        # them internally. This is the exact current-API expansion of the removed
        # scVelo n_top_genes convenience path; the working copy alone is modified.
        sc.pp.log1p(analysis)
        sc.pp.highly_variable_genes(
            analysis,
            n_top_genes=preprocessing["analysis_genes"],
            flavor="seurat",
            subset=True,
            check_values=True,
        )
        pb.require_equal(
            "velocity analysis gene count",
            analysis.n_vars,
            preprocessing["analysis_genes"],
        )
        pb.require_equal(
            "velocity analysis gene-ID digest",
            pb.hash_strings(analysis.var_names.tolist()),
            preprocessing["analysis_gene_ids_json_sha256"],
        )

        neighbors = analysis_contract["neighbors_and_moments"]
        sc.pp.neighbors(
            analysis,
            n_neighbors=neighbors["n_neighbors"],
            n_pcs=neighbors["n_pcs"],
            use_rep=neighbors["use_rep"],
            knn=neighbors["knn"],
            method=neighbors["method"],
            transformer=neighbors["transformer"],
            metric=neighbors["metric"],
            random_state=neighbors["random_state"],
        )
        pb.require_equal(
            "analysis connectivity nnz",
            int(analysis.obsp["connectivities"].nnz),
            neighbors["connectivities_nnz"],
        )
        scv.pp.moments(
            analysis,
            n_pcs=neighbors["n_pcs"],
            n_neighbors=neighbors["n_neighbors"],
            mode=neighbors["moments_mode"],
            method=neighbors["method"],
            use_rep=neighbors["use_rep"],
            use_highly_variable=True,
        )

        velocity = analysis_contract["velocity"]
        fit_warning_contract = warning_contract["scvelo_stochastic_fit"]
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            scv.tl.velocity(
                analysis,
                vkey=velocity["vkey"],
                mode=velocity["mode"],
                fit_offset=velocity["fit_offset"],
                fit_offset2=velocity["fit_offset2"],
                filter_genes=velocity["filter_genes"],
                use_raw=velocity["use_raw"],
                perc=velocity["percentiles"],
                min_r2=velocity["min_r2"],
                min_likelihood=velocity["min_likelihood"],
                use_highly_variable=velocity["use_highly_variable"],
            )
        pb.require_equal(
            "scVelo stochastic-fit warning count",
            len(captured),
            fit_warning_contract["count"],
        )
        for item in captured:
            _validate_warning(item, fit_warning_contract)
        velocity_gene_count = int(
            np.asarray(analysis.var["velocity_genes"], dtype=bool).sum()
        )
        pb.require_equal(
            "velocity-gene count", velocity_gene_count, velocity["velocity_genes"]
        )
        pb.require_equal(
            "stochastic warning-to-velocity-gene relationship",
            len(captured),
            velocity_gene_count,
        )
        gamma = np.asarray(analysis.var["velocity_gamma"], dtype=np.float32)
        velocity_matrix = np.asarray(analysis.layers["velocity"], dtype=np.float32)
        pb.require_finite("velocity gamma", gamma)
        pb.require_finite("velocity matrix", velocity_matrix)
        pb.require_equal(
            "velocity gamma digest",
            pb.hash_array(gamma, "<f4"),
            velocity["gamma_f32_sha256"],
        )
        pb.require_equal(
            "velocity matrix digest",
            pb.hash_array(velocity_matrix, "<f4"),
            velocity["velocity_matrix_f32_sha256"],
        )

        graph = analysis_contract["velocity_graph"]
        scv.tl.velocity_graph(
            analysis,
            vkey=velocity["vkey"],
            xkey=graph["xkey"],
            n_neighbors=None,
            n_recurse_neighbors=graph["n_recurse_neighbors"],
            random_neighbors_at_max=None,
            sqrt_transform=graph["sqrt_transform"],
            variance_stabilization=graph["variance_stabilization"],
            compute_uncertainties=graph["compute_uncertainties"],
            approx=graph["approx"],
            mode_neighbors=graph["mode_neighbors"],
            n_jobs=graph["n_jobs"],
            backend=graph["backend"],
            show_progress_bar=False,
        )
        velocity_graph = analysis.uns["velocity_graph"]
        pb.require_finite("velocity graph", velocity_graph)
        pb.require_equal("velocity graph nnz", int(velocity_graph.nnz), graph["nnz"])
        pb.require_equal(
            "velocity graph data digest",
            pb.hash_array(velocity_graph.data, "<f4"),
            graph["data_values_f32_sha256"],
        )
        velocity_graph_digest, _ = pb.hash_sparse(velocity_graph)
        pb.require_equal(
            "velocity graph canonical CSR digest",
            velocity_graph_digest,
            graph["canonical_csr_sha256"],
        )

        embedding_contracts = analysis_contract["embeddings"]
        for dimension in (1, 3):
            contract = embedding_contracts[f"{dimension}d"]
            sc.tl.umap(
                analysis,
                min_dist=contract["min_dist"],
                spread=contract["spread"],
                n_components=contract["n_components"],
                maxiter=contract["maxiter"],
                alpha=contract["alpha"],
                gamma=contract["gamma"],
                negative_sample_rate=contract["negative_sample_rate"],
                init_pos=contract["init_pos"],
                random_state=contract["random_state"],
                method="umap",
                key_added=f"X_umap_{dimension}d",
                neighbors_key="neighbors",
            )
        analysis.obsm["X_umap_2d"] = np.asarray(
            source.obsm["X_umap"], dtype=np.float32
        ).copy()

        embeddings: dict[int, Any] = {}
        for dimension in (1, 2, 3):
            embeddings[dimension] = pb.validate_float_array_contract(
                f"{dimension}D UMAP",
                analysis.obsm[f"X_umap_{dimension}d"],
                embedding_contracts[f"{dimension}d"],
            )

        common = analysis_contract["velocity_embedding_common"]
        vector_contracts = analysis_contract["velocity_vectors"]
        projection_warning_contract = warning_contract["scvelo_velocity_embedding"]
        vectors: dict[str, Any] = {}
        for dimension in (1, 2, 3):
            contract = vector_contracts[f"{dimension}d"]
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter("always")
                scv.tl.velocity_embedding(
                    analysis,
                    basis=contract["basis"],
                    vkey=velocity["vkey"],
                    scale=common["scale"],
                    self_transitions=common["self_transitions"],
                    use_negative_cosines=common["use_negative_cosines"],
                    direct_pca_projection=common["direct_pca_projection"],
                    retain_scale=common["retain_scale"],
                    autoscale=contract["autoscale"],
                    all_comps=common["all_comps"],
                    T=None,
                )
            pb.require_equal(
                f"{dimension}D velocity-projection warning count",
                len(captured),
                projection_warning_contract["count_per_call"],
            )
            for item in captured:
                _validate_warning(item, projection_warning_contract)
            key = f"velocity_umap_{dimension}d"
            vectors[key] = pb.validate_float_array_contract(
                f"{dimension}D velocity",
                analysis.obsm[key],
                contract,
            )

    return embeddings, vectors


def _validate_generation(output_path: Path, provenance: dict[str, Any]) -> None:
    """The shared generation checks, plus the one Pancreas-only invariant.

    ``cell_type`` is a published convenience alias of ``clusters``. Element 0
    of a categorical entry is the payload index and element 1 the key, and the
    alias differs from its source in both; every element from 2 on - the
    categories, the code width, the missing code, the centroids and the outlier
    bounds - and both payload files must be identical to the field it copies.
    """
    pb.validate_generation(output_path, provenance)
    alias = provenance["export_contract"]["derived_obs_fields"]["cell_type"]
    obs_manifest = json.loads(
        (output_path / "obs_manifest.json").read_text(encoding="utf-8")
    )
    categorical = {entry[1]: entry for entry in obs_manifest["_categoricalFields"]}
    source_field = alias["source_field"]
    pb.require_equal(
        "generated Pancreas cell_type categorical metadata",
        categorical["cell_type"][2:],
        categorical[source_field][2:],
    )
    for suffix in ("codes.u8.gz", "outliers.u8.gz"):
        pb.require_equal(
            f"generated Pancreas cell_type {suffix}",
            (output_path / "obs" / f"{categorical['cell_type'][0]}.{suffix}").read_bytes(),
            (output_path / "obs" / f"{categorical[source_field][0]}.{suffix}").read_bytes(),
        )


def _build(
    source_path: Path,
    output_path: Path,
    *,
    force: bool,
    provenance: dict[str, Any],
    environment: dict[str, Any],
    cellucid: Any,
) -> None:
    import numpy as np

    pb.verify_input_file(source_path, provenance["source"], label="Pancreas source")
    print(
        "Verified source "
        f"{provenance['source']['sha256']} ({provenance['source']['size_bytes']:,} bytes)."
    )
    warnings.simplefilter("error")
    source = _read_source_warning_clean(source_path, provenance)
    public = _validate_source(source, provenance)
    embeddings, vectors = _derive_analysis(
        source, provenance, root_random_seed=environment["root_random_seed"]
    )

    # The source-owned payload is rechecked after all derivations to prove the
    # working copy did not redefine or reorder public expression/metadata.
    pb.require_equal(
        "post-analysis public gene-ID digest",
        pb.hash_strings(public["genes"]),
        provenance["public_gene_contract"]["ordered_gene_ids_json_sha256"],
    )
    post_expression_digest, _ = pb.hash_sparse(public["expression"])
    pb.require_equal(
        "post-analysis public expression digest",
        post_expression_digest,
        provenance["public_gene_contract"]["expression_canonical_csr_sha256"],
    )
    pb.require_equal(
        "post-analysis source 2D digest",
        pb.hash_array(public["source_2d"], "<f4"),
        provenance["input_contract"]["digests"]["source_umap_2d_f32_sha256"],
    )

    export = provenance["export_contract"]
    identity = export["identity"]
    # One default name per gene, in a var column of its own, so that every
    # generation in the catalog declares its gene identity the same way. The
    # names are the source's own MGI symbols and are not translated, looked up
    # or altered; the source carries no second identifier to offer beside them.
    public["var"] = public["var"].assign(gene_name=public["genes"])
    pb.require_equal(
        "Pancreas gene-name column",
        public["var"]["gene_name"].tolist(),
        public["genes"],
    )
    published_obs = _derive_public_obs(source, provenance)
    published_obs_keys = [
        *provenance["input_contract"]["obs_fields"],
        *export["derived_obs_fields"],
    ]

    arrays = {
        "derived_umap_1d": embeddings[1],
        "source_umap_2d": embeddings[2],
        "derived_umap_3d": embeddings[3],
        "source_pca": public["latent_space"],
    }
    export_embeddings = {
        embedding_id: cellucid.Embedding(
            arrays[spec["array"]],
            columns=spec["columns"],
            label=spec["label"],
            source_key=spec["source_key"],
        )
        for embedding_id, spec in export["embeddings"].items()
    }
    vector_fields = {
        export["vector_field"]: {
            embedding_id: vectors[analysis_key]
            for embedding_id, analysis_key in export["vector_field_bindings"].items()
        }
    }
    settings = identity["export_settings"]

    def write_stage(stage: Path) -> None:
        cellucid.prepare(
            latent_space=public["latent_space"],
            obs=published_obs,
            var=public["var"],
            gene_expression=public["expression"],
            var_gene_id_column="gene_name",
            gene_identifiers=public["genes"],
            connectivities=public["connectivity"],
            out_dir=stage,
            obs_keys=published_obs_keys,
            centroid_outlier_quantile=export["centroid_outlier_quantile"],
            centroid_min_points=export["centroid_min_points"],
            force=False,
            var_quantization=settings["var_quantization"],
            obs_continuous_quantization=settings["obs_continuous_quantization"],
            compression=settings["compression"],
            obs_categorical_dtype=settings["obs_categorical_dtype"],
            dataset_name=identity["name"],
            dataset_id=provenance["dataset_id"],
            dataset_description=identity["description"],
            source_name=identity["source"]["name"],
            source_url=provenance["source"]["url"],
            source_citation=provenance["citation"]["text"],
            embeddings=export_embeddings,
            embedding_defaults=export["embedding_defaults"],
            vector_fields=vector_fields,
            vector_field_default=export["vector_field"],
            created_at=identity["created_at"],
        )

    pb.stage_validate_publish(
        output_path,
        force=force,
        writer=write_stage,
        validator=lambda stage: _validate_generation(stage, provenance),
    )


def main() -> None:
    environment = pb.load_environment()
    pb.configure_process(environment)
    parser = argparse.ArgumentParser(
        description=(
            "Build the exact pinned scVelo Pancreas source, deterministic 1D/2D/3D "
            "UMAPs, a PCA view, and embedding-bound velocity projections."
        )
    )
    parser.add_argument(
        "--source",
        type=Path,
        help=(
            "Existing endocrinogenesis_day15.h5ad path. The script downloads the "
            "commit-pinned source when omitted."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=pb.EXPORTS_ROOT / DATASET_ID,
        help="Prepared output directory (default: exports-v3/pancreas).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Atomically replace an existing complete Pancreas generation.",
    )
    args = parser.parse_args()
    provenance = pb.load_provenance(DATASET_ID)
    output_path = Path(os.path.abspath(os.fspath(args.output)))

    # Producer/runtime preflights deliberately precede network and output writes.
    cellucid = pb.preflight_runtime(
        environment,
        data_version=provenance["export_contract"]["identity"]["cellucid_data_version"],
    )
    pb.preflight_output(output_path, force=args.force)
    if args.source is not None:
        _build(
            args.source.resolve(),
            output_path,
            force=args.force,
            provenance=provenance,
            environment=environment,
            cellucid=cellucid,
        )
        return

    with tempfile.TemporaryDirectory(prefix="cellucid-pancreas-") as temporary:
        source_path = Path(temporary) / "endocrinogenesis_day15.h5ad"
        _download_source(source_path, provenance["source"])
        _build(
            source_path,
            output_path,
            force=args.force,
            provenance=provenance,
            environment=environment,
            cellucid=cellucid,
        )


if __name__ == "__main__":
    main()
