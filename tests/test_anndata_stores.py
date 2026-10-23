"""Every published store, opened the way a user opens it: with anndata.

``catalog-contract.test.mjs`` reads the stores byte by byte with Node alone;
this suite reads them as AnnData, at the versions ``requirements-build.lock``
pins, and checks every element against the science ``sources/<id>.json``
pins: the published cells, genes and obs fields with their category order,
the expression the build recorded, every embedding and velocity projection by
digest, the neighbour graph, and ``uns['cellucid']`` with the latent-space
outlier quantiles the build recorded.

It needs ``anndata`` (with numpy, scipy and zarr) installed; CI's ``stores``
job installs them.
"""

from __future__ import annotations

import json
import sys
import unittest
import warnings
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

import pinned_build as pb  # noqa: E402

CATALOG = json.loads((REPOSITORY_ROOT / "anndata" / "datasets.json").read_text(encoding="utf-8"))
DATASET_IDS = [entry["id"] for entry in CATALOG["datasets"]]


def _provenance(dataset_id: str) -> dict:
    return json.loads((pb.SOURCES_ROOT / f"{dataset_id}.json").read_text(encoding="utf-8"))


class AnnDataStoreTests(unittest.TestCase):
    def _open(self, dataset_id: str):
        import anndata as ad

        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            adata = ad.read_zarr(pb.store_path(dataset_id))
        self.assertEqual(
            [f"{item.category.__name__}: {item.message}" for item in captured],
            [],
            f"anndata reads {dataset_id}.zarr without a warning",
        )
        return adata

    def test_catalog_lists_the_five_samples(self) -> None:
        self.assertEqual(DATASET_IDS, ["suo", "garcia", "he", "kanemaru", "pancreas"])

    def test_every_store_is_the_pinned_dataset(self) -> None:
        import numpy as np
        from scipy import sparse

        for dataset_id in DATASET_IDS:
            with self.subTest(dataset=dataset_id):
                provenance = _provenance(dataset_id)
                contract = provenance["anndata_contract"]
                adata = self._open(dataset_id)

                cellucid = dict(adata.uns["cellucid"])
                outlier_quantiles = cellucid.pop("outlierQuantiles", None)
                self.assertEqual(pb.plain(cellucid), contract["uns_cellucid"])
                self.assertEqual(pb.plain(adata.uns["title"]), contract["uns_cellucid"]["name"])
                self.assertEqual(
                    pb.validate_outlier_quantiles(
                        outlier_quantiles,
                        obs=adata.obs,
                        defaults=contract["uns_cellucid"].get("defaults", {}),
                    ),
                    contract["recorded"]["outlier_quantiles"],
                )

                self.assertIsInstance(adata.X, sparse.csc_matrix | sparse.csc_array)
                self.assertEqual(adata.X.dtype, np.float32)
                digest, nnz = pb.hash_sparse(adata.X)
                self.assertEqual(
                    {"shape": list(adata.shape), "nnz": nnz, "canonical_csr_sha256": digest},
                    contract["recorded"]["expression"],
                )
                self.assertTrue(adata.obs_names.is_unique and adata.var_names.is_unique)

                graph = adata.obsp["connectivities"]
                self.assertIsInstance(graph, sparse.csr_matrix | sparse.csr_array)
                self.assertEqual(graph.dtype, np.float32)
                self.assertEqual(abs(graph - graph.T).nnz, 0, "the neighbour graph is symmetric")
                self.assertEqual(float(graph.diagonal().sum()), 0.0)
                for key, values in adata.obsm.items():
                    self.assertEqual(values.dtype, np.float32, f"obsm[{key!r}]")
                    self.assertEqual(values.shape[0], adata.n_obs, f"obsm[{key!r}]")
                for element in ("layers", "varm", "varp"):
                    self.assertEqual(list(getattr(adata, element).keys()), [])

                if dataset_id == "pancreas":
                    self._check_pancreas(adata, provenance)
                else:
                    self._check_atlas(adata, provenance)

    def _check_atlas(self, adata, provenance: dict) -> None:
        analysis = provenance["analysis_contract"]
        obs_contract = provenance["obs_contract"]
        naming = provenance["gene_naming"]
        self.assertEqual(list(adata.obs.columns), obs_contract["published_fields"])
        self.assertEqual(pb.obs_frame_digests(adata.obs), obs_contract["published_digests"])
        self.assertEqual(pb.hash_strings(adata.var_names.tolist()), naming["published_names_json_sha256"])
        self.assertEqual(list(adata.var.columns), [naming["accession_name_column"]])
        self.assertEqual(
            pb.hash_sparse(adata.obsp["connectivities"])[0],
            analysis["neighbors"]["connectivities_canonical_csr_sha256"],
        )
        for dimension in (1, 2, 3):
            self.assertEqual(
                pb.hash_array(adata.obsm[f"X_umap_{dimension}d"], "<f4"),
                analysis["umap"]["embeddings"][f"{dimension}d"]["f32_sha256"],
            )
        obsm = provenance["anndata_contract"]["obsm"]
        self.assertEqual(sorted(adata.obsm.keys()), sorted(obsm))
        if provenance["selection"] is None:
            for key, spec in obsm.items():
                if spec["origin"] == "source" and spec["columns"] is None:
                    self.assertEqual(
                        pb.hash_array(adata.obsm[key], "<f4"),
                        provenance["input_contract"]["obsm"][spec["source_key"]]["f32_sha256"],
                    )
        self.assertEqual(adata.obsm["X_pca"].shape[1], 2, "the PCA view is its first two components")

    def _check_pancreas(self, adata, provenance: dict) -> None:
        import numpy as np

        contract = provenance["anndata_contract"]
        digests = provenance["input_contract"]["digests"]
        analysis = provenance["analysis_contract"]
        self.assertEqual(pb.hash_strings(adata.obs_names.tolist()), digests["obs_names_json_sha256"])
        self.assertEqual(
            pb.hash_strings(adata.var_names.tolist()),
            provenance["public_gene_contract"]["ordered_gene_ids_json_sha256"],
        )
        self.assertEqual(
            list(adata.obs.columns),
            [*provenance["input_contract"]["obs_fields"], *contract["derived_obs_fields"]],
        )
        for field in ("clusters_coarse", "clusters"):
            self.assertEqual(
                pb.hash_strings(adata.obs[field].cat.categories.tolist()),
                digests[f"{field}_categories_json_sha256"],
            )
            self.assertEqual(
                pb.hash_array(adata.obs[field].cat.codes, "<i4"), digests[f"{field}_codes_i32_sha256"]
            )
        self.assertTrue(
            np.array_equal(adata.obs["cell_type"].cat.codes, adata.obs["clusters"].cat.codes)
            and adata.obs["cell_type"].cat.categories.equals(adata.obs["clusters"].cat.categories),
            "cell_type is the published alias of clusters",
        )
        for field in ("S_score", "G2M_score"):
            self.assertEqual(pb.hash_array(adata.obs[field].to_numpy(), "<f8"), digests[f"{field}_f64_sha256"])
        self.assertEqual(
            pb.hash_sparse(adata.obsp["connectivities"])[0],
            digests["source_connectivity_canonical_csr_sha256"],
        )
        self.assertEqual(pb.hash_array(adata.obsm["X_pca"], "<f4"), digests["source_pca_f32_sha256"])
        for dimension, key in ((1, "X_umap_1d"), (2, "X_umap"), (3, "X_umap_3d")):
            self.assertEqual(
                pb.hash_array(adata.obsm[key], "<f4"),
                analysis["embeddings"][f"{dimension}d"]["f32_sha256"],
            )
        # scVelo's naming: the field velocity on X_<basis> is obsm['velocity_<basis>'].
        for embedding_key, analysis_key in contract["vector_field_bindings"].items():
            dimension = int(analysis_key[-2])
            self.assertEqual(
                pb.hash_array(adata.obsm[f"velocity_{embedding_key.removeprefix('X_')}"], "<f4"),
                analysis["velocity_vectors"][f"{dimension}d"]["f32_sha256"],
            )


if __name__ == "__main__":
    unittest.main()
