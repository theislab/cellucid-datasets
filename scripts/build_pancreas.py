#!/usr/bin/env python3
"""Build the exact pinned scVelo Pancreas generation for Cellucid."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.metadata
import inspect
import json
import os
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import warnings
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PROVENANCE_PATH = REPOSITORY_ROOT / "sources" / "pancreas.json"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
EXACT_REQUIREMENT_RE = re.compile(r"^([A-Za-z0-9_.-]+)==([^;\s]+)$")
LOWER_HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PUBLICATION_SIDECAR_NAMES = frozenset(
    {"default.cellucid-session", "state-snapshots.json"}
)


def _load_provenance() -> dict[str, Any]:
    provenance = json.loads(PROVENANCE_PATH.read_text(encoding="utf-8"))
    if provenance.get("schema_version") != 2:
        raise ValueError("sources/pancreas.json must use schema_version 2.")
    if provenance.get("dataset_id") != "pancreas":
        raise ValueError("sources/pancreas.json must describe dataset_id 'pancreas'.")
    _validate_provenance_values(provenance)
    return provenance


def _validate_provenance_values(value: Any, *, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key.endswith("sha256"):
                if (
                    not isinstance(child, str)
                    or LOWER_HEX_SHA256_RE.fullmatch(child) is None
                ):
                    raise ValueError(
                        f"{child_path} must be exactly 64 lowercase hexadecimal characters."
                    )
            _validate_provenance_values(child, path=child_path)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _validate_provenance_values(child, path=f"{path}[{index}]")
        return
    if isinstance(value, str) and "PENDING" in value:
        raise ValueError(f"{path} contains a forbidden pending placeholder.")


def _hash_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(DOWNLOAD_CHUNK_BYTES):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _require_equal(label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise ValueError(f"{label} is {actual!r}; expected exactly {expected!r}.")


def _configure_process(provenance: dict[str, Any]) -> None:
    build = provenance["build_environment"]
    expected_hash_seed = build["python_hash_seed"]
    if os.environ.get("PYTHONHASHSEED") != expected_hash_seed:
        environment = os.environ.copy()
        environment["PYTHONHASHSEED"] = expected_hash_seed
        os.execve(sys.executable, [sys.executable, *sys.argv], environment)

    for key, value in build["thread_environment"].items():
        os.environ[key] = value


def _parse_requirements_lock(lock_path: Path) -> dict[str, str]:
    requirements: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        lock_path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = EXACT_REQUIREMENT_RE.fullmatch(line)
        if match is None:
            raise ValueError(
                f"{lock_path.name}:{line_number} must be one exact name==version pin."
            )
        name, version = match.groups()
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        if normalized in requirements:
            raise ValueError(f"{lock_path.name} repeats package {name!r}.")
        requirements[normalized] = version
    if not requirements:
        raise ValueError(f"{lock_path.name} must contain exact package pins.")
    return requirements


def _producer_manifest_sha256(repository: Path) -> str:
    paths = [repository / "MANIFEST.in", repository / "pyproject.toml"]
    source_root = repository / "src" / "cellucid"
    paths.extend(
        candidate
        for candidate in source_root.rglob("*")
        if candidate.is_file() and "__pycache__" not in candidate.parts
    )
    relative_paths = sorted(path.relative_to(repository) for path in paths)
    manifest = bytearray()
    for relative in relative_paths:
        path = repository / relative
        if path.is_symlink():
            raise ValueError(
                f"Cellucid producer manifest must not contain symlinks: {relative}"
            )
        file_hash, _ = _hash_and_size(path)
        manifest.extend(f"{file_hash}  {relative.as_posix()}\n".encode("utf-8"))
    return hashlib.sha256(manifest).hexdigest()


def _preflight_runtime(provenance: dict[str, Any]) -> Any:
    """Fail before download or output mutation if the canonical runtime differs."""
    build = provenance["build_environment"]
    producer = build["cellucid_producer"]
    _require_equal(
        "Python implementation",
        platform.python_implementation(),
        build["implementation"],
    )
    _require_equal("Python version", platform.python_version(), build["python_version"])
    _require_equal("platform system", platform.system(), build["platform_system"])
    _require_equal("platform machine", platform.machine(), build["platform_machine"])
    _require_equal(
        "zlib runtime version", zlib.ZLIB_RUNTIME_VERSION, build["zlib_runtime_version"]
    )

    lock_path = REPOSITORY_ROOT / build["requirements_lock"]
    lock_hash, _ = _hash_and_size(lock_path)
    _require_equal(
        "requirements lock SHA-256", lock_hash, build["requirements_lock_sha256"]
    )
    requirements = _parse_requirements_lock(lock_path)
    for normalized_name, expected_version in requirements.items():
        try:
            actual_version = importlib.metadata.version(normalized_name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError(
                f"Canonical Pancreas build package {normalized_name!r} is not installed."
            ) from error
        _require_equal(
            f"installed {normalized_name} version",
            actual_version,
            expected_version,
        )
    installed_distribution_names: set[str] = set()
    for distribution in importlib.metadata.distributions():
        distribution_name = distribution.metadata.get("Name")
        if not isinstance(distribution_name, str) or not distribution_name:
            raise RuntimeError(
                "Canonical Pancreas build environment contains an unnamed distribution."
            )
        normalized_name = re.sub(r"[-_.]+", "-", distribution_name).lower()
        installed_distribution_names.add(normalized_name)
    _require_equal(
        "installed distribution inventory",
        sorted(installed_distribution_names),
        sorted([*requirements, "cellucid"]),
    )

    pip_check = subprocess.run(
        [sys.executable, "-m", "pip", "check"],
        check=False,
        capture_output=True,
        text=True,
    )
    if pip_check.returncode != 0:
        detail = (pip_check.stdout + pip_check.stderr).strip()
        raise RuntimeError(
            f"Canonical Pancreas build environment is inconsistent: {detail}"
        )

    import numpy as np
    from threadpoolctl import threadpool_info

    # Importing Cellucid is intentionally part of the producer preflight.
    import cellucid
    from cellucid import prepare

    producer_repository = REPOSITORY_ROOT.parent / "cellucid-python"
    if producer_repository.is_symlink() or not producer_repository.is_dir():
        raise ValueError(
            f"Canonical Cellucid producer must be the real sibling repository: "
            f"{producer_repository}"
        )
    _require_equal(
        "Cellucid producer source-tree manifest SHA-256",
        _producer_manifest_sha256(producer_repository),
        producer["source_tree_manifest_sha256"],
    )
    for key_file in producer["key_files"]:
        actual_hash, _ = _hash_and_size(producer_repository / key_file["path"])
        _require_equal(
            f"Cellucid producer {key_file['path']} SHA-256",
            actual_hash,
            key_file["sha256"],
        )
    imported_cellucid = Path(inspect.getfile(cellucid)).resolve()
    expected_source_root = (producer_repository / "src" / "cellucid").resolve()
    if not imported_cellucid.is_relative_to(expected_source_root):
        raise RuntimeError(
            f"Imported Cellucid producer is {imported_cellucid}; "
            f"expected exact sibling source below {expected_source_root}."
        )

    _require_equal(
        "NumPy byte order",
        np.dtype("<f4").byteorder,
        "=" if sys.byteorder == "little" else "<",
    )
    blas_contract = build["blas"]
    matching_blas = [
        pool
        for pool in threadpool_info()
        if pool.get("internal_api") == blas_contract["internal_api"]
    ]
    if not matching_blas:
        raise RuntimeError("Canonical OpenBLAS runtime was not detected.")
    for pool in matching_blas:
        for key in ("version", "architecture", "threading_layer"):
            _require_equal(f"BLAS {key}", pool.get(key), blas_contract[key])
        _require_equal("BLAS thread count", pool.get("num_threads"), 1)

    signature = inspect.signature(prepare)
    if "created_at" not in signature.parameters:
        raise RuntimeError(
            "cellucid.prepare() must expose the deterministic created_at producer contract."
        )
    if signature.parameters["created_at"].kind is not inspect.Parameter.KEYWORD_ONLY:
        raise RuntimeError("cellucid.prepare(created_at=...) must remain keyword-only.")
    _require_equal(
        "Cellucid exporter version",
        importlib.metadata.version("cellucid"),
        producer["version"],
    )
    _require_equal(
        "Cellucid producer/export contract version",
        producer["version"],
        provenance["export_contract"]["cellucid_data_version"],
    )
    return prepare


def _preflight_output(output_path: Path, *, force: bool) -> None:
    if not output_path.is_absolute():
        raise ValueError(
            f"Pancreas output must be an absolute lexical path: {output_path}"
        )
    parent = output_path.parent
    if not parent.exists() or parent.is_symlink() or not parent.is_dir():
        raise ValueError(
            f"Pancreas output parent must be an existing non-symlink directory: {parent}"
        )
    if (
        hasattr(os, "getuid")
        and parent.stat(follow_symlinks=False).st_uid != os.getuid()
    ):
        raise PermissionError(
            f"Pancreas output parent is not owned by the current user: {parent}"
        )

    current = Path(parent.anchor)
    for component in parent.parts[1:]:
        current /= component
        if current.is_symlink():
            raise ValueError(
                f"Pancreas output parent chain must not contain symlinks: {current}"
            )

    if os.path.lexists(output_path) and output_path.is_symlink():
        raise ValueError(f"Pancreas output must not be a symlink: {output_path}")
    if not output_path.exists():
        return
    if not output_path.is_dir():
        raise ValueError(
            f"Pancreas output exists but is not a directory: {output_path}"
        )
    if any(output_path.iterdir()) and not force:
        raise FileExistsError(
            f"Pancreas output is non-empty: {output_path}. Pass --force to replace it atomically."
        )


def _safe_remove_sibling_tree(path: Path, *, target: Path, role: str) -> None:
    prefix = f".{target.name}.{role}-"
    if path.parent != target.parent or not path.name.startswith(prefix):
        raise RuntimeError(f"Refusing to remove non-{role} path: {path}")
    if os.path.lexists(path):
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError(f"Refusing to remove invalid {role} path: {path}")
        shutil.rmtree(path)


def _copy_publication_sidecars(source: Path, destination: Path) -> None:
    """Copy exact publication sidecars without adding them to generation science."""
    if not source.exists():
        return
    for name in sorted(PUBLICATION_SIDECAR_NAMES):
        source_path = source / name
        if not os.path.lexists(source_path):
            continue
        metadata = source_path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(
                f"Pancreas publication sidecar must be one regular file: {source_path}"
            )
        destination_path = destination / name
        if os.path.lexists(destination_path):
            raise RuntimeError(
                f"Pancreas scientific producer wrote reserved publication sidecar: "
                f"{destination_path}"
            )
        shutil.copyfile(source_path, destination_path)
        destination_path.chmod(0o644)


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def _exclusive_publish_lock(target: Path) -> Iterator[None]:
    lock_path = target.parent / f".{target.name}.publish.lock"
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise FileExistsError(
            f"Another Pancreas publication owns the non-waiting lock: {lock_path}"
        ) from error
    try:
        try:
            os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        yield
    finally:
        if os.path.lexists(lock_path):
            metadata = lock_path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise RuntimeError(
                    f"Pancreas publish lock changed ownership/type: {lock_path}"
                )
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise RuntimeError(
                    f"Pancreas publish lock changed filesystem owner: {lock_path}"
                )
            lock_path.unlink()
            _fsync_directory(target.parent)


def _publish_validated_stage(
    stage: Path,
    target: Path,
    *,
    replace: Callable[[Path, Path], None] = os.replace,
) -> None:
    """Atomically swap one validated sibling stage with rollback on failure."""
    if stage.parent != target.parent or not stage.name.startswith(
        f".{target.name}.stage-"
    ):
        raise ValueError(f"Pancreas stage is not an exact target sibling: {stage}")
    if stage.is_symlink() or not stage.is_dir():
        raise ValueError(f"Pancreas stage must be one real directory: {stage}")

    backup = target.parent / f".{target.name}.backup-{secrets.token_hex(12)}"
    had_target = target.exists()
    moved_stage = False
    moved_target = False
    published = False
    try:
        if had_target:
            replace(target, backup)
            moved_target = True
        replace(stage, target)
        moved_stage = True
        _fsync_directory(target.parent)
        published = True
        if moved_target:
            _safe_remove_sibling_tree(backup, target=target, role="backup")
            moved_target = False
        _fsync_directory(target.parent)
    except BaseException:
        if not published:
            if moved_stage and target.exists():
                replace(target, stage)
                moved_stage = False
            if moved_target and backup.exists():
                replace(backup, target)
                moved_target = False
            _fsync_directory(target.parent)
        raise
    finally:
        if os.path.lexists(stage):
            _safe_remove_sibling_tree(stage, target=target, role="stage")
        if os.path.lexists(backup):
            _safe_remove_sibling_tree(backup, target=target, role="backup")


def _stage_validate_publish(
    target: Path,
    *,
    force: bool,
    writer: Callable[[Path], None],
    validator: Callable[[Path], None],
    replace: Callable[[Path, Path], None] = os.replace,
) -> None:
    """Write and validate a sibling stage before changing the final target."""
    with _exclusive_publish_lock(target):
        _preflight_output(target, force=force)
        stage = Path(
            tempfile.mkdtemp(
                prefix=f".{target.name}.stage-",
                dir=target.parent,
            )
        )
        try:
            writer(stage)
            validator(stage)
            _copy_publication_sidecars(target, stage)
            _publish_validated_stage(stage, target, replace=replace)
        finally:
            if os.path.lexists(stage):
                _safe_remove_sibling_tree(stage, target=target, role="stage")


def _verify_source(path: Path, source_contract: dict[str, Any]) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Pancreas source is not a file: {path}")
    actual_hash, actual_size = _hash_and_size(path)
    _require_equal(
        "Pancreas source byte count", actual_size, source_contract["size_bytes"]
    )
    _require_equal("Pancreas source SHA-256", actual_hash, source_contract["sha256"])


def _download_source(destination: Path, source_contract: dict[str, Any]) -> None:
    request = urllib.request.Request(
        source_contract["url"],
        headers={"User-Agent": "cellucid-datasets-pancreas-builder/2"},
    )
    with (
        urllib.request.urlopen(request, timeout=120) as response,
        destination.open("wb") as target,
    ):
        while chunk := response.read(DOWNLOAD_CHUNK_BYTES):
            target.write(chunk)
        target.flush()
        os.fsync(target.fileno())


def _hash_array(values: Any, dtype: str) -> str:
    import numpy as np

    array = np.ascontiguousarray(np.asarray(values, dtype=np.dtype(dtype)))
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def _hash_strings(values: Any) -> str:
    import numpy as np

    normalized: list[str | None] = []
    for value in values:
        is_missing_float = isinstance(value, (float, np.floating)) and bool(
            np.isnan(value)
        )
        normalized.append(None if value is None or is_missing_float else str(value))
    payload = json.dumps(
        normalized,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(f"{payload}\n".encode("utf-8")).hexdigest()


def _canonical_sparse(values: Any) -> Any:
    import numpy as np
    from scipy import sparse

    matrix = sparse.csr_matrix(values, dtype=np.float32).copy()
    matrix.sum_duplicates()
    matrix.eliminate_zeros()
    matrix.sort_indices()
    return matrix


def _hash_sparse(values: Any) -> tuple[str, int]:
    import numpy as np

    matrix = _canonical_sparse(values)
    digest = hashlib.sha256()
    digest.update(np.asarray(matrix.shape, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.indptr, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.indices, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.data, dtype="<f4").tobytes())
    return digest.hexdigest(), int(matrix.nnz)


def _require_finite(name: str, values: Any) -> None:
    import numpy as np

    array = values.data if hasattr(values, "data") else np.asarray(values)
    if not np.isfinite(array).all():
        raise ValueError(f"{name} must contain only finite values.")


def _validate_warning(
    warning: warnings.WarningMessage,
    contract: dict[str, Any],
) -> None:
    _require_equal("warning category", warning.category.__name__, contract["category"])
    _require_equal("warning message", str(warning.message), contract["message"])
    normalized_filename = Path(warning.filename).as_posix()
    if not normalized_filename.endswith(contract["filename_suffix"]):
        raise ValueError(
            f"warning owner is {normalized_filename!r}; "
            f"expected suffix {contract['filename_suffix']!r}."
        )
    _require_equal("warning source line", warning.lineno, contract["line"])


def _read_source_warning_clean(source_path: Path, provenance: dict[str, Any]) -> Any:
    import anndata as ad
    from anndata._warnings import OldFormatWarning

    contract = provenance["warning_contract"]["legacy_h5ad_read"]
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        source = ad.read_h5ad(source_path)
    _require_equal("legacy H5AD warning count", len(captured), contract["count"])
    _require_equal(
        "legacy H5AD warning messages",
        [str(item.message) for item in captured],
        contract["messages_in_order"],
    )
    _require_equal(
        "legacy H5AD OldFormatWarning count",
        sum(item.category is OldFormatWarning for item in captured),
        contract["old_format_warning_count"],
    )
    _require_equal(
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
    _require_equal(
        "Pancreas AnnData shape",
        source.shape,
        (contract["n_cells"], contract["n_genes"]),
    )
    if not source.obs_names.is_unique or not source.var_names.is_unique:
        raise ValueError(
            "Pancreas observation and gene identifiers must both be unique."
        )
    _require_equal(
        "Pancreas obs fields", list(source.obs.columns), contract["obs_fields"]
    )
    _require_equal(
        "Pancreas var fields", list(source.var.columns), contract["var_fields"]
    )
    _require_equal(
        "Pancreas layers", list(source.layers.keys()), contract["layer_keys"]
    )
    if not sparse.issparse(source.X):
        raise ValueError("Pancreas X must remain the pinned sparse expression matrix.")

    _require_equal(
        "obs-name digest",
        _hash_strings(source.obs_names.tolist()),
        digests["obs_names_json_sha256"],
    )
    _require_equal(
        "var-name digest",
        _hash_strings(source.var_names.tolist()),
        digests["var_names_json_sha256"],
    )
    for field, expected_levels in contract["categorical_levels"].items():
        values = source.obs[field]
        if values.isna().any():
            raise ValueError(
                f"Pancreas obs[{field!r}] must not contain missing values."
            )
        actual_levels = [str(value) for value in values.cat.categories]
        _require_equal(
            f"Pancreas obs[{field!r}] levels", actual_levels, expected_levels
        )
        _require_equal(
            f"Pancreas obs[{field!r}] category digest",
            _hash_strings(values.cat.categories.tolist()),
            digests[f"{field}_categories_json_sha256"],
        )
        _require_equal(
            f"Pancreas obs[{field!r}] code digest",
            _hash_array(values.cat.codes, "<i4"),
            digests[f"{field}_codes_i32_sha256"],
        )
    for field in contract["continuous_fields"]:
        values = source.obs[field].to_numpy()
        _require_finite(f"Pancreas obs[{field!r}]", values)
        _require_equal(
            f"Pancreas obs[{field!r}] digest",
            _hash_array(values, "<f8"),
            digests[f"{field}_f64_sha256"],
        )

    marker_contract = contract["highly_variable_marker"]
    marker = source.var[marker_contract["field"]]
    _require_equal(
        "source var-marker digest",
        _hash_strings(marker.tolist()),
        digests["highly_variable_genes_json_sha256"],
    )
    source_marked = np.asarray(marker == marker_contract["selected_value"], dtype=bool)
    _require_equal(
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
    _require_equal(
        "public gene count", int(selected_indices.size), public_contract["n_genes"]
    )
    selected_expression = source.X[:, selected_indices]
    selected_var = source.var.iloc[selected_indices].copy()
    selected_genes = source.var_names[selected_indices].tolist()
    _require_equal(
        "ordered public gene-ID digest",
        _hash_strings(selected_genes),
        public_contract["ordered_gene_ids_json_sha256"],
    )
    _require_equal(
        "selected var digest",
        _hash_strings(selected_var[marker_contract["field"]].tolist()),
        public_contract["selected_var_json_sha256"],
    )
    expression_digest, expression_nnz = _hash_sparse(selected_expression)
    _require_equal(
        "public expression digest",
        expression_digest,
        public_contract["expression_canonical_csr_sha256"],
    )
    _require_equal(
        "public expression nnz", expression_nnz, public_contract["expression_nnz"]
    )

    source_x_digest, _ = _hash_sparse(source.X)
    _require_equal(
        "source X digest", source_x_digest, digests["source_X_canonical_csr_sha256"]
    )
    for layer in contract["layer_keys"]:
        layer_digest, _ = _hash_sparse(source.layers[layer])
        _require_equal(
            f"source {layer} digest",
            layer_digest,
            digests[f"{layer}_canonical_csr_sha256"],
        )

    embedding_contract = contract["source_embedding"]
    source_2d = np.asarray(source.obsm[embedding_contract["key"]], dtype=np.float32)
    _require_equal(
        "source 2D shape",
        source_2d.shape,
        (contract["n_cells"], embedding_contract["dimensions"]),
    )
    _require_finite("source 2D UMAP", source_2d)
    _require_equal(
        "source 2D digest",
        _hash_array(source_2d, "<f4"),
        digests["source_umap_2d_f32_sha256"],
    )

    latent_contract = contract["latent_space"]
    latent_space = np.asarray(source.obsm[latent_contract["key"]], dtype=np.float32)
    _require_equal(
        "source latent-space shape",
        latent_space.shape,
        (contract["n_cells"], latent_contract["dimensions"]),
    )
    _require_finite("source PCA latent space", latent_space)
    _require_equal(
        "source PCA digest",
        _hash_array(latent_space, "<f4"),
        digests["source_pca_f32_sha256"],
    )

    connectivity_key = contract["connectivity_key"]
    if connectivity_key not in source.obsp:
        raise ValueError(f"Pancreas source must expose obsp[{connectivity_key!r}].")
    source_connectivity = source.obsp[connectivity_key]
    connectivity_digest, _ = _hash_sparse(source_connectivity)
    _require_equal(
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
    _require_equal(
        "Pancreas derived obs field keys",
        list(derived_contracts),
        ["cell_type"],
    )

    contract = derived_contracts["cell_type"]
    _require_equal(
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
    _require_equal(
        "Pancreas source obs fields after alias derivation",
        list(source.obs.columns),
        input_contract["obs_fields"],
    )
    _require_equal(
        "Pancreas published obs fields",
        list(published_obs.columns),
        [*input_contract["obs_fields"], *derived_contracts],
    )

    source_values = source.obs[source_field]
    derived_values = published_obs["cell_type"]
    if derived_values.isna().any():
        raise ValueError("Pancreas derived obs['cell_type'] must not contain missing values.")
    _require_equal(
        "Pancreas derived cell_type category order",
        derived_values.cat.categories.tolist(),
        source_values.cat.categories.tolist(),
    )
    _require_equal(
        "Pancreas derived cell_type ordered flag",
        derived_values.cat.ordered,
        source_values.cat.ordered,
    )
    _require_equal(
        "Pancreas derived cell_type category digest",
        _hash_strings(derived_values.cat.categories.tolist()),
        contract["categories_json_sha256"],
    )
    _require_equal(
        "Pancreas derived cell_type category provenance",
        contract["categories_json_sha256"],
        input_contract["digests"][f"{source_field}_categories_json_sha256"],
    )
    _require_equal(
        "Pancreas derived cell_type code digest",
        _hash_array(derived_values.cat.codes, "<i4"),
        contract["codes_i32_sha256"],
    )
    _require_equal(
        "Pancreas derived cell_type code provenance",
        contract["codes_i32_sha256"],
        input_contract["digests"][f"{source_field}_codes_i32_sha256"],
    )
    return published_obs


def _validate_float_array_contract(
    label: str,
    values: Any,
    contract: dict[str, Any],
) -> Any:
    import numpy as np

    array = np.ascontiguousarray(np.asarray(values, dtype=np.float32))
    _require_equal(f"{label} shape", list(array.shape), contract["shape"])
    _require_finite(label, array)
    _require_equal(f"{label} minimum", float(array.min()), contract["minimum"])
    _require_equal(f"{label} maximum", float(array.max()), contract["maximum"])
    _require_equal(f"{label} mean", float(array.mean()), contract["mean"])
    _require_equal(
        f"{label} standard deviation",
        float(array.std()),
        contract["standard_deviation"],
    )
    _require_equal(
        f"{label} float32 digest",
        _hash_array(array, "<f4"),
        contract["f32_sha256"],
    )
    if "nonzero_rows" in contract:
        nonzero_rows = int(np.count_nonzero(np.linalg.norm(array, axis=1) > 0))
        _require_equal(f"{label} nonzero rows", nonzero_rows, contract["nonzero_rows"])
    return array


def _derive_analysis(
    source: Any, provenance: dict[str, Any]
) -> tuple[dict[int, Any], dict[str, Any]]:
    import numpy as np
    import scanpy as sc
    import scvelo as scv
    from threadpoolctl import threadpool_limits

    analysis_contract = provenance["analysis_contract"]
    warning_contract = provenance["warning_contract"]
    analysis = source.copy()
    np.random.seed(provenance["build_environment"]["root_random_seed"])
    sc.settings.n_jobs = 1

    with threadpool_limits(limits=1):
        preprocessing = analysis_contract["preprocessing"]
        scv.pp.filter_genes(analysis, min_shared_counts=20)
        _require_equal(
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
        _require_equal(
            "velocity analysis gene count",
            analysis.n_vars,
            preprocessing["analysis_genes"],
        )
        _require_equal(
            "velocity analysis gene-ID digest",
            _hash_strings(analysis.var_names.tolist()),
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
        _require_equal(
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
        _require_equal(
            "scVelo stochastic-fit warning count",
            len(captured),
            fit_warning_contract["count"],
        )
        for item in captured:
            _validate_warning(item, fit_warning_contract)
        velocity_gene_count = int(
            np.asarray(analysis.var["velocity_genes"], dtype=bool).sum()
        )
        _require_equal(
            "velocity-gene count", velocity_gene_count, velocity["velocity_genes"]
        )
        _require_equal(
            "stochastic warning-to-velocity-gene relationship",
            len(captured),
            velocity_gene_count,
        )
        gamma = np.asarray(analysis.var["velocity_gamma"], dtype=np.float32)
        velocity_matrix = np.asarray(analysis.layers["velocity"], dtype=np.float32)
        _require_finite("velocity gamma", gamma)
        _require_finite("velocity matrix", velocity_matrix)
        _require_equal(
            "velocity gamma digest",
            _hash_array(gamma, "<f4"),
            velocity["gamma_f32_sha256"],
        )
        _require_equal(
            "velocity matrix digest",
            _hash_array(velocity_matrix, "<f4"),
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
        _require_finite("velocity graph", velocity_graph)
        _require_equal("velocity graph nnz", int(velocity_graph.nnz), graph["nnz"])
        _require_equal(
            "velocity graph data digest",
            _hash_array(velocity_graph.data, "<f4"),
            graph["data_values_f32_sha256"],
        )
        velocity_graph_digest, _ = _hash_sparse(velocity_graph)
        _require_equal(
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
            embeddings[dimension] = _validate_float_array_contract(
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
            _require_equal(
                f"{dimension}D velocity-projection warning count",
                len(captured),
                projection_warning_contract["count_per_call"],
            )
            for item in captured:
                _validate_warning(item, projection_warning_contract)
            key = f"velocity_umap_{dimension}d"
            vectors[key] = _validate_float_array_contract(
                f"{dimension}D velocity",
                analysis.obsm[key],
                contract,
            )

    return embeddings, vectors


def _generation_digest(directory: Path) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    for path in sorted(
        (
            candidate
            for candidate in directory.rglob("*")
            if candidate.is_file()
            and not (
                candidate.parent == directory
                and candidate.name in PUBLICATION_SIDECAR_NAMES
            )
        ),
        key=lambda candidate: candidate.relative_to(directory).as_posix(),
    ):
        relative = path.relative_to(directory).as_posix().encode("utf-8")
        size = path.stat().st_size
        digest.update(len(relative).to_bytes(8, "little"))
        digest.update(relative)
        digest.update(size.to_bytes(8, "little"))
        with path.open("rb") as source:
            while chunk := source.read(DOWNLOAD_CHUNK_BYTES):
                digest.update(chunk)
        file_count += 1
        total_bytes += size
    return digest.hexdigest(), file_count, total_bytes


def _validate_generation(output_path: Path, provenance: dict[str, Any]) -> None:
    import numpy as np

    export = provenance["export_contract"]
    input_contract = provenance["input_contract"]
    public_contract = provenance["public_gene_contract"]
    identity = json.loads(
        (output_path / "dataset_identity.json").read_text(encoding="utf-8")
    )
    expected_identity = {
        "cellucid_data_version": export["cellucid_data_version"],
        "id": provenance["dataset_id"],
        "created_at": export["artifact_created_at"],
        "n_cells": input_contract["n_cells"],
        "n_genes": public_contract["n_genes"],
        "n_obs_fields": (
            len(input_contract["obs_fields"]) + len(export["derived_obs_fields"])
        ),
        "n_categorical_fields": (
            len(input_contract["categorical_levels"])
            + len(export["derived_obs_fields"])
        ),
        "n_continuous_fields": len(input_contract["continuous_fields"]),
        "available_dimensions": export["available_dimensions"],
        "default_dimension": export["default_dimension"],
        "default_vector_field": export["vector_field"],
        "vector_dimensions": export["available_dimensions"],
        "vector_default_dimension": export["vector_field_default_dimension"],
    }
    field = identity["vector_fields"]["fields"][export["vector_field"]]
    actual_identity = {
        "cellucid_data_version": identity["cellucid_data_version"],
        "id": identity["id"],
        "created_at": identity["created_at"],
        "n_cells": identity["stats"]["n_cells"],
        "n_genes": identity["stats"]["n_genes"],
        "n_obs_fields": identity["stats"]["n_obs_fields"],
        "n_categorical_fields": identity["stats"]["n_categorical_fields"],
        "n_continuous_fields": identity["stats"]["n_continuous_fields"],
        "available_dimensions": identity["embeddings"]["available_dimensions"],
        "default_dimension": identity["embeddings"]["default_dimension"],
        "default_vector_field": identity["vector_fields"]["default_field"],
        "vector_dimensions": field["available_dimensions"],
        "vector_default_dimension": field["default_dimension"],
    }
    _require_equal("generated Pancreas identity", actual_identity, expected_identity)

    obs_manifest = json.loads(
        (output_path / "obs_manifest.json").read_text(encoding="utf-8")
    )
    continuous_keys = [
        field[0] for field in obs_manifest["_continuousFields"]
    ]
    categorical_fields = {
        field[0]: field for field in obs_manifest["_categoricalFields"]
    }
    expected_categorical_keys = [
        *input_contract["categorical_levels"],
        *export["derived_obs_fields"],
    ]
    _require_equal(
        "generated Pancreas continuous obs fields",
        continuous_keys,
        input_contract["continuous_fields"],
    )
    _require_equal(
        "generated Pancreas categorical obs fields",
        list(categorical_fields),
        expected_categorical_keys,
    )
    _require_equal(
        "generated Pancreas identity obs fields",
        [field["key"] for field in identity["obs_fields"]],
        [*continuous_keys, *expected_categorical_keys],
    )
    alias_contract = export["derived_obs_fields"]["cell_type"]
    source_field = alias_contract["source_field"]
    _require_equal(
        "generated Pancreas cell_type categorical metadata",
        categorical_fields["cell_type"][1:],
        categorical_fields[source_field][1:],
    )
    for suffix in ("codes.u8.gz", "outliers.u8.gz"):
        _require_equal(
            f"generated Pancreas cell_type {suffix}",
            (output_path / "obs" / f"cell_type.{suffix}").read_bytes(),
            (output_path / "obs" / f"{source_field}.{suffix}").read_bytes(),
        )

    canonical_gzip_header = bytes.fromhex("1f8b08000000000000ff")
    gzip_paths = sorted(output_path.rglob("*.gz"))
    if not gzip_paths:
        raise RuntimeError("Generated Pancreas dataset must contain gzip artifacts.")
    for path in output_path.rglob("*"):
        if path.is_file():
            _require_equal(
                f"published file mode for {path.relative_to(output_path)}",
                stat.S_IMODE(path.stat(follow_symlinks=False).st_mode),
                0o644,
            )
    for path in gzip_paths:
        with path.open("rb") as source:
            header = source.read(10)
        _require_equal(
            f"canonical gzip header for {path.relative_to(output_path)}",
            header,
            canonical_gzip_header,
        )

    for relative, payload_contract in export["semantic_payloads"].items():
        compressed = (output_path / relative).read_bytes()
        raw = gzip.decompress(compressed)
        _require_equal(
            f"semantic byte count for {relative}",
            len(raw),
            payload_contract["raw_bytes"],
        )
        _require_equal(
            f"semantic SHA-256 for {relative}",
            hashlib.sha256(raw).hexdigest(),
            payload_contract["raw_sha256"],
        )
        dimension_match = re.search(r"_(\d)d\.bin\.gz$", relative)
        if dimension_match is None:
            raise ValueError(
                f"Semantic float payload has no exact dimension suffix: {relative}"
            )
        dimension = int(dimension_match.group(1))
        values = np.frombuffer(raw, dtype="<f4").reshape((-1, dimension))
        _require_finite(f"semantic payload {relative}", values)
        if relative.startswith("points_"):
            if not bool(np.all((values >= -1) & (values <= 1))):
                raise ValueError(
                    f"Point payload {relative} must remain within [-1, 1]."
                )
        if "nonzero_rows" in payload_contract:
            nonzero_rows = int(np.count_nonzero(np.linalg.norm(values, axis=1) > 0))
            _require_equal(
                f"semantic nonzero rows for {relative}",
                nonzero_rows,
                payload_contract["nonzero_rows"],
            )

    generation_sha256, file_count, total_bytes = _generation_digest(output_path)
    actual_generation = {
        "file_count": file_count,
        "total_bytes": total_bytes,
        "sha256": generation_sha256,
    }
    expected_generation = {
        "file_count": export["expected_file_count"],
        "total_bytes": export["expected_total_bytes"],
        "sha256": export["generation_sha256"],
    }
    _require_equal(
        "Pancreas generation summary", actual_generation, expected_generation
    )
    print(
        f"Verified {file_count:,} deterministic artifacts "
        f"({total_bytes:,} bytes; SHA-256 {generation_sha256})."
    )


def _build(
    source_path: Path,
    output_path: Path,
    *,
    force: bool,
    provenance: dict[str, Any],
    prepare: Any,
) -> None:
    _verify_source(source_path, provenance["source"])
    print(
        "Verified source "
        f"{provenance['source']['sha256']} ({provenance['source']['size_bytes']:,} bytes)."
    )
    warnings.simplefilter("error")
    source = _read_source_warning_clean(source_path, provenance)
    public = _validate_source(source, provenance)
    embeddings, vectors = _derive_analysis(source, provenance)

    # The source-owned payload is rechecked after all derivations to prove the
    # working copy did not redefine or reorder public expression/metadata.
    _require_equal(
        "post-analysis public gene-ID digest",
        _hash_strings(public["genes"]),
        provenance["public_gene_contract"]["ordered_gene_ids_json_sha256"],
    )
    post_expression_digest, _ = _hash_sparse(public["expression"])
    _require_equal(
        "post-analysis public expression digest",
        post_expression_digest,
        provenance["public_gene_contract"]["expression_canonical_csr_sha256"],
    )
    _require_equal(
        "post-analysis source 2D digest",
        _hash_array(public["source_2d"], "<f4"),
        provenance["input_contract"]["digests"]["source_umap_2d_f32_sha256"],
    )

    export = provenance["export_contract"]
    published_obs = _derive_public_obs(source, provenance)
    published_obs_keys = [
        *provenance["input_contract"]["obs_fields"],
        *export["derived_obs_fields"],
    ]

    def write_stage(stage: Path) -> None:
        prepare(
            latent_space=public["latent_space"],
            obs=published_obs,
            var=public["var"],
            gene_expression=public["expression"],
            gene_identifiers=public["genes"],
            connectivities=public["connectivity"],
            out_dir=stage,
            obs_keys=published_obs_keys,
            centroid_outlier_quantile=export["centroid_outlier_quantile"],
            centroid_min_points=export["centroid_min_points"],
            force=False,
            var_quantization=export["var_quantization"],
            obs_continuous_quantization=export["obs_continuous_quantization"],
            compression=export["compression"],
            obs_categorical_dtype=export["obs_categorical_dtype"],
            dataset_name=export["dataset_name"],
            dataset_id=provenance["dataset_id"],
            dataset_description=export["dataset_description"],
            source_name=export["source_name"],
            source_url=provenance["source"]["url"],
            source_citation=provenance["citation"]["text"],
            X_umap_1d=embeddings[1],
            X_umap_2d=embeddings[2],
            X_umap_3d=embeddings[3],
            vector_fields=vectors,
            vector_field_default=export["vector_field"],
            created_at=export["artifact_created_at"],
        )

    _stage_validate_publish(
        output_path,
        force=force,
        writer=write_stage,
        validator=lambda stage: _validate_generation(stage, provenance),
    )


def main() -> None:
    provenance = _load_provenance()
    _configure_process(provenance)
    parser = argparse.ArgumentParser(
        description=(
            "Build the exact pinned scVelo Pancreas source, deterministic 1D/2D/3D "
            "UMAPs, and dimension-matched velocity projections."
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
        default=REPOSITORY_ROOT / "exports" / "pancreas",
        help="Prepared output directory (default: exports/pancreas).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Atomically replace an existing complete Pancreas generation.",
    )
    args = parser.parse_args()
    output_path = Path(os.path.abspath(os.fspath(args.output)))

    # Producer/runtime preflights deliberately precede network and output writes.
    prepare = _preflight_runtime(provenance)
    _preflight_output(output_path, force=args.force)
    if args.source is not None:
        _build(
            args.source.resolve(),
            output_path,
            force=args.force,
            provenance=provenance,
            prepare=prepare,
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
            prepare=prepare,
        )


if __name__ == "__main__":
    main()
