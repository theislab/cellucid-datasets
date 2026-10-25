"""The pinned build every published sample dataset is produced by.

``build_pancreas.py`` and ``build_atlas.py`` differ only in how a source turns
into the arrays ``cellucid.prepare()`` receives. Everything a rebuild has to
prove regardless of the dataset lives here, once:

- the environment: the interpreter, the exact installed distribution set
  (``requirements-build.lock``), the BLAS runtime, the thread count, the hash
  seed, and the SHA-256 of every Cellucid producer module ``prepare()``
  executes, all read from ``sources/build-environment.json``;
- the input: the source file's size and SHA-256 from ``sources/<id>.json``;
- the output: a Cellucid-ready AnnData Zarr store written to a staged sibling,
  read back with anndata and checked element by element against what was
  written and against the pins in ``sources/<id>.json``, measured byte for byte
  against the recorded store digest, and only then swapped atomically into
  ``anndata/<id>.zarr``.

This module imports nothing outside the standard library at import time. The
publisher suite, ``tests/test_pinned_build_publish.py``, runs in CI with no
dependencies installed, and every numerical import below is function-local.
"""

from __future__ import annotations

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
import warnings
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCES_ROOT = REPOSITORY_ROOT / "sources"
ENVIRONMENT_PATH = SOURCES_ROOT / "build-environment.json"
ANNDATA_ROOT = REPOSITORY_ROOT / "anndata"
READ_CHUNK_BYTES = 1024 * 1024
EXACT_REQUIREMENT_RE = re.compile(r"^([A-Za-z0-9_.-]+)==([^;\s]+)$")
LOWER_HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ENVIRONMENT_SCHEMA_VERSION = 2
PROVENANCE_SCHEMA_VERSION = 4
STORE_SUFFIX = ".zarr"
# GitHub blocks a pushed file larger than 100 MiB (its hard per-file limit),
# so a store this repository could not publish is refused here, before it
# replaces anything.
GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024
# The keyword arguments the builders pass to cellucid.prepare(); a producer
# without one of them is not the producer these pins describe.
PREPARE_KEYWORDS = (
    "format",
    "embeddings",
    "dataset_id",
    "dataset_name",
    "obs",
    "var",
    "gene_expression",
    "connectivities",
    "vector_fields",
    "gene_identifiers",
    "dataset_description",
    "citation_text",
    "citation_url",
    "source_name",
    "source_url",
    "embedding_defaults",
    "latent_key",
    "obs_keys",
    "vector_field_default",
    "centroid_min_points",
    "zarr_format",
    "force",
)


# --------------------------------------------------------------------------
# Provenance records
# --------------------------------------------------------------------------


def _validate_record_values(value: Any, *, label: str, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key.endswith("sha256"):
                if (
                    not isinstance(child, str)
                    or LOWER_HEX_SHA256_RE.fullmatch(child) is None
                ):
                    raise ValueError(
                        f"{label} {child_path} must be exactly 64 lowercase "
                        f"hexadecimal characters."
                    )
            _validate_record_values(child, label=label, path=child_path)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _validate_record_values(child, label=label, path=f"{path}[{index}]")
        return
    if isinstance(value, str) and "PENDING" in value:
        raise ValueError(f"{label} {path} contains a forbidden pending placeholder.")


def load_environment() -> dict[str, Any]:
    """Read the one build environment every sample generation is pinned to."""
    environment = json.loads(ENVIRONMENT_PATH.read_text(encoding="utf-8"))
    if environment.get("schema_version") != ENVIRONMENT_SCHEMA_VERSION:
        raise ValueError(
            f"sources/build-environment.json must use schema_version "
            f"{ENVIRONMENT_SCHEMA_VERSION}."
        )
    _validate_record_values(environment, label="sources/build-environment.json")
    return environment


def load_provenance(dataset_id: str) -> dict[str, Any]:
    """Read and shape-check ``sources/<dataset_id>.json``."""
    path = SOURCES_ROOT / f"{dataset_id}.json"
    label = f"sources/{dataset_id}.json"
    provenance = json.loads(path.read_text(encoding="utf-8"))
    if provenance.get("schema_version") != PROVENANCE_SCHEMA_VERSION:
        raise ValueError(
            f"{label} must use schema_version {PROVENANCE_SCHEMA_VERSION}."
        )
    if provenance.get("dataset_id") != dataset_id:
        raise ValueError(f"{label} must describe dataset_id {dataset_id!r}.")
    _validate_record_values(provenance, label=label)
    return provenance


# --------------------------------------------------------------------------
# Small exact helpers
# --------------------------------------------------------------------------


def hash_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(READ_CHUNK_BYTES):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def require_equal(label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise ValueError(f"{label} is {actual!r}; expected exactly {expected!r}.")


def hash_array(values: Any, dtype: str) -> str:
    import numpy as np

    array = np.ascontiguousarray(np.asarray(values, dtype=np.dtype(dtype)))
    return hashlib.sha256(array.tobytes(order="C")).hexdigest()


def hash_strings(values: Any) -> str:
    import numpy as np

    normalized: list[str | None] = []
    for value in values:
        is_missing_float = isinstance(value, (float, np.floating)) and bool(
            np.isnan(value)
        )
        normalized.append(None if value is None or is_missing_float else str(value))
    payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(f"{payload}\n".encode("utf-8")).hexdigest()


def canonical_sparse(values: Any) -> Any:
    import numpy as np
    from scipy import sparse

    matrix = sparse.csr_matrix(values, dtype=np.float32).copy()
    matrix.sum_duplicates()
    matrix.eliminate_zeros()
    matrix.sort_indices()
    return matrix


def hash_sparse(values: Any) -> tuple[str, int]:
    import numpy as np

    matrix = canonical_sparse(values)
    digest = hashlib.sha256()
    digest.update(np.asarray(matrix.shape, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.indptr, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.indices, dtype="<u8").tobytes())
    digest.update(np.asarray(matrix.data, dtype="<f4").tobytes())
    return digest.hexdigest(), int(matrix.nnz)


def require_finite(name: str, values: Any) -> None:
    import numpy as np

    array = values.data if hasattr(values, "data") else np.asarray(values)
    if not np.isfinite(array).all():
        raise ValueError(f"{name} must contain only finite values.")


def float_array_summary(values: Any) -> dict[str, Any]:
    """The exact statistics a pinned float32 array is recorded and checked by."""
    import numpy as np

    array = np.ascontiguousarray(np.asarray(values, dtype=np.float32))
    return {
        "shape": list(array.shape),
        "minimum": float(array.min()),
        "maximum": float(array.max()),
        "mean": float(array.mean()),
        "standard_deviation": float(array.std()),
        "f32_sha256": hash_array(array, "<f4"),
    }


def validate_float_array_contract(
    label: str,
    values: Any,
    contract: dict[str, Any],
) -> Any:
    import numpy as np

    array = np.ascontiguousarray(np.asarray(values, dtype=np.float32))
    require_equal(f"{label} shape", list(array.shape), contract["shape"])
    require_finite(label, array)
    require_equal(f"{label} minimum", float(array.min()), contract["minimum"])
    require_equal(f"{label} maximum", float(array.max()), contract["maximum"])
    require_equal(f"{label} mean", float(array.mean()), contract["mean"])
    require_equal(
        f"{label} standard deviation",
        float(array.std()),
        contract["standard_deviation"],
    )
    require_equal(
        f"{label} float32 digest", hash_array(array, "<f4"), contract["f32_sha256"]
    )
    if "nonzero_rows" in contract:
        nonzero_rows = int(np.count_nonzero(np.linalg.norm(array, axis=1) > 0))
        require_equal(f"{label} nonzero rows", nonzero_rows, contract["nonzero_rows"])
    return array


def verify_input_file(path: Path, contract: dict[str, Any], *, label: str) -> None:
    """Refuse a source file whose byte count or SHA-256 is not the pinned one."""
    if not path.is_file():
        raise FileNotFoundError(f"{label} is not a file: {path}")
    actual_hash, actual_size = hash_and_size(path)
    require_equal(f"{label} byte count", actual_size, contract["size_bytes"])
    require_equal(f"{label} SHA-256", actual_hash, contract["sha256"])


# --------------------------------------------------------------------------
# Environment and producer preflight
# --------------------------------------------------------------------------


def configure_process(environment: dict[str, Any]) -> None:
    """Re-exec under the pinned hash seed, then pin every thread pool to one."""
    expected_hash_seed = environment["python_hash_seed"]
    if os.environ.get("PYTHONHASHSEED") != expected_hash_seed:
        child = os.environ.copy()
        child["PYTHONHASHSEED"] = expected_hash_seed
        os.execve(sys.executable, [sys.executable, *sys.argv], child)
    for key, value in environment["thread_environment"].items():
        os.environ[key] = value
    # scanpy and scvelo draw tqdm bars; they carry no build information.
    os.environ["TQDM_DISABLE"] = "1"


def parse_requirements_lock(lock_path: Path) -> dict[str, str]:
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


def producer_manifest_sha256(
    repository: Path, source_files: list[dict[str, str]]
) -> str:
    """Verify every pinned producer file and return the manifest digest.

    The pinned set is one explicit path list rather than a directory pattern,
    so a producer file that is renamed or removed fails by name here instead of
    vanishing into an aggregate digest that reports only "something differs".
    """
    if not source_files:
        raise ValueError("Cellucid producer source_files must name the pinned modules.")
    relative_paths = [entry["path"] for entry in source_files]
    if relative_paths != sorted(relative_paths):
        raise ValueError(
            "Cellucid producer source_files must be sorted by repository-relative path."
        )
    if len(set(relative_paths)) != len(relative_paths):
        raise ValueError("Cellucid producer source_files names one path twice.")

    manifest = bytearray()
    for entry in source_files:
        relative = entry["path"]
        parts = PurePosixPath(relative).parts
        if relative != PurePosixPath(relative).as_posix() or parts[:2] != (
            "src",
            "cellucid",
        ):
            raise ValueError(
                f"Cellucid producer source_files entry must be one repository-relative "
                f"POSIX path below src/cellucid: {relative}"
            )
        path = repository / relative
        if not os.path.lexists(path):
            raise FileNotFoundError(
                f"Pinned Cellucid producer file no longer exists: {relative}. "
                f"sources/build-environment.json pins a producer tree {repository} "
                f"no longer has, so a generation cannot be attributed to the code "
                f"that produced it."
            )
        if path.is_symlink() or not path.is_file():
            raise ValueError(
                f"Pinned Cellucid producer file must be one regular file: {relative}"
            )
        file_hash, _ = hash_and_size(path)
        require_equal(f"Cellucid producer {relative} SHA-256", file_hash, entry["sha256"])
        manifest.extend(f"{file_hash}  {relative}\n".encode("utf-8"))
    return hashlib.sha256(manifest).hexdigest()


def executed_producer_modules(repository: Path) -> list[str]:
    """Every producer module the import of ``prepare`` left in ``sys.modules``."""
    repository_root = repository.resolve()
    executed: list[str] = []
    for name, module in sys.modules.items():
        if name != "cellucid" and not name.startswith("cellucid."):
            continue
        origin = getattr(module, "__file__", None)
        if origin is None:
            continue
        resolved = Path(origin).resolve()
        if not resolved.is_relative_to(repository_root):
            continue
        executed.append(resolved.relative_to(repository_root).as_posix())
    return sorted(executed)


def require_writer_within_manifest(
    repository: Path, source_files: list[dict[str, str]]
) -> None:
    """Refuse to build when ``prepare()`` runs producer code nothing pins.

    The pinned set is narrowed to the modules ``prepare()`` actually executes,
    which is only a stronger provenance claim while that set is measured rather
    than asserted. It is measured here, on every run.
    """
    pinned = {entry["path"] for entry in source_files}
    uncovered = [
        relative
        for relative in executed_producer_modules(repository)
        if relative not in pinned
    ]
    if uncovered:
        raise RuntimeError(
            "cellucid.prepare() executes producer modules that "
            "sources/build-environment.json does not pin: "
            + ", ".join(uncovered)
            + ". Add them to cellucid_producer.source_files so the recorded "
            "provenance covers the code that writes the store."
        )


def producer_repository() -> Path:
    """The source tree the imported Cellucid producer is installed from.

    The producer is pinned by the SHA-256 of every module ``prepare()``
    executes, so what matters is that the imported package *is* a source tree
    and that its files hash to the pins, not where that tree is checked out. The
    package must be an editable install of a ``src/cellucid`` layout: an
    installed wheel has no repository to hash.
    """
    import cellucid

    package = Path(inspect.getfile(cellucid)).resolve().parent
    repository = package.parents[1]
    if package != (repository / "src" / "cellucid").resolve():
        raise RuntimeError(
            f"The imported Cellucid producer is {package}, which is not the "
            f"src/cellucid package of a cellucid-python source tree. Install the "
            f"producer editable (pip install --no-deps -e <cellucid-python>) so "
            f"its modules can be hashed against the pins."
        )
    if not (repository / "pyproject.toml").is_file():
        raise RuntimeError(
            f"The imported Cellucid producer {package} has no pyproject.toml two "
            f"levels up, so {repository} is not a cellucid-python source tree."
        )
    return repository


def preflight_runtime(environment: dict[str, Any]) -> Any:
    """Fail before any source is read if the canonical runtime differs.

    Returns the ``cellucid`` module, whose ``prepare`` is the producer the pins
    describe.
    """
    producer = environment["cellucid_producer"]
    require_equal(
        "Python implementation",
        platform.python_implementation(),
        environment["implementation"],
    )
    require_equal("Python version", platform.python_version(), environment["python_version"])
    require_equal("platform system", platform.system(), environment["platform_system"])
    require_equal("platform machine", platform.machine(), environment["platform_machine"])
    require_equal(
        "zlib runtime version",
        zlib.ZLIB_RUNTIME_VERSION,
        environment["zlib_runtime_version"],
    )

    lock_path = REPOSITORY_ROOT / environment["requirements_lock"]
    lock_hash, _ = hash_and_size(lock_path)
    require_equal(
        "requirements lock SHA-256", lock_hash, environment["requirements_lock_sha256"]
    )
    requirements = parse_requirements_lock(lock_path)
    for normalized_name, expected_version in requirements.items():
        try:
            actual_version = importlib.metadata.version(normalized_name)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError(
                f"Canonical build package {normalized_name!r} is not installed."
            ) from error
        require_equal(
            f"installed {normalized_name} version", actual_version, expected_version
        )
    installed: set[str] = set()
    for distribution in importlib.metadata.distributions():
        distribution_name = distribution.metadata["Name"]
        if not isinstance(distribution_name, str) or not distribution_name:
            raise RuntimeError(
                "Canonical build environment contains an unnamed distribution."
            )
        installed.add(re.sub(r"[-_.]+", "-", distribution_name).lower())
    require_equal(
        "installed distribution inventory",
        sorted(installed),
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
        raise RuntimeError(f"Canonical build environment is inconsistent: {detail}")

    import numpy as np
    from threadpoolctl import threadpool_info

    # Importing Cellucid is intentionally part of the producer preflight.
    import cellucid
    from cellucid import prepare

    repository = producer_repository()
    source_files = producer["source_files"]
    require_equal(
        "Cellucid producer source-tree manifest SHA-256",
        producer_manifest_sha256(repository, source_files),
        producer["source_tree_manifest_sha256"],
    )
    require_writer_within_manifest(repository, source_files)

    require_equal(
        "NumPy byte order",
        np.dtype("<f4").byteorder,
        "=" if sys.byteorder == "little" else "<",
    )
    blas_contract = environment["blas"]
    matching_blas = [
        pool
        for pool in threadpool_info()
        if pool.get("internal_api") == blas_contract["internal_api"]
    ]
    if not matching_blas:
        raise RuntimeError("Canonical OpenBLAS runtime was not detected.")
    for pool in matching_blas:
        for key in ("version", "architecture", "threading_layer"):
            require_equal(f"BLAS {key}", pool.get(key), blas_contract[key])
        require_equal("BLAS thread count", pool.get("num_threads"), 1)

    signature = inspect.signature(inspect.unwrap(prepare))
    for keyword in PREPARE_KEYWORDS:
        parameter = signature.parameters.get(keyword)
        if parameter is None or parameter.kind is not inspect.Parameter.KEYWORD_ONLY:
            raise RuntimeError(
                f"cellucid.prepare() must take the keyword-only {keyword}= argument "
                f"the pinned build passes."
            )
    require_equal(
        "Cellucid producer version",
        importlib.metadata.version("cellucid"),
        producer["version"],
    )
    return cellucid


# --------------------------------------------------------------------------
# Staged publication
# --------------------------------------------------------------------------


def store_path(dataset_id: str) -> Path:
    """Where the published store of one dataset lives: ``anndata/<id>.zarr``."""
    return ANNDATA_ROOT / f"{dataset_id}{STORE_SUFFIX}"


def preflight_output(output_path: Path, *, force: bool) -> None:
    if not output_path.is_absolute():
        raise ValueError(f"Output must be an absolute lexical path: {output_path}")
    if not output_path.name.endswith(STORE_SUFFIX) or output_path.name == STORE_SUFFIX:
        raise ValueError(f"Output must be a Zarr store folder named <id>{STORE_SUFFIX}: {output_path}")
    parent = output_path.parent
    if not parent.exists() or parent.is_symlink() or not parent.is_dir():
        raise ValueError(
            f"Output parent must be an existing non-symlink directory: {parent}"
        )
    if hasattr(os, "getuid") and parent.stat(follow_symlinks=False).st_uid != os.getuid():
        raise PermissionError(f"Output parent is not owned by the current user: {parent}")

    current = Path(parent.anchor)
    for component in parent.parts[1:]:
        current /= component
        if current.is_symlink():
            raise ValueError(f"Output parent chain must not contain symlinks: {current}")

    if os.path.lexists(output_path) and output_path.is_symlink():
        raise ValueError(f"Output must not be a symlink: {output_path}")
    if not output_path.exists():
        return
    if not output_path.is_dir():
        raise ValueError(f"Output exists but is not a directory: {output_path}")
    if any(output_path.iterdir()) and not force:
        raise FileExistsError(
            f"Output is non-empty: {output_path}. Pass --force to replace it atomically."
        )


def stage_path(target: Path) -> Path:
    """Return the one fixed sibling a publication stages into.

    ``prepare()`` writes a Zarr store only to a path ending in ``.zarr``, so
    the stage keeps the target's name behind a fixed hidden prefix. The name
    carries no random suffix: a stage an interrupted run left behind is found
    by the next run, which refuses to publish into it, instead of accumulating
    beside the store under names nothing looks for.

    The set-aside backup keeps its random suffix by contrast, because it is
    created with ``os.replace(target, backup)`` -- a fixed name that an
    interrupted run left behind would make that rename fail against a non-empty
    directory -- and because nothing reuses it, so it cannot accumulate.
    """
    return target.parent / f".stage.{target.name}"


def safe_remove_sibling_tree(path: Path, *, target: Path, role: str) -> None:
    if role == "stage":
        recognized = path == stage_path(target)
    else:
        recognized = path.parent == target.parent and path.name.startswith(
            f".{target.name}.{role}-"
        )
    if not recognized:
        raise RuntimeError(f"Refusing to remove non-{role} path: {path}")
    if os.path.lexists(path):
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError(f"Refusing to remove invalid {role} path: {path}")
        shutil.rmtree(path)


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def exclusive_publish_lock(target: Path) -> Iterator[None]:
    lock_path = target.parent / f".{target.name}.publish.lock"
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise FileExistsError(
            f"Another publication owns the non-waiting lock: {lock_path}"
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
                raise RuntimeError(f"Publish lock changed ownership/type: {lock_path}")
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise RuntimeError(f"Publish lock changed filesystem owner: {lock_path}")
            lock_path.unlink()
            fsync_directory(target.parent)


def publish_validated_stage(
    stage: Path,
    target: Path,
    *,
    replace: Callable[[Path, Path], None] = os.replace,
) -> None:
    """Atomically swap one validated sibling stage with rollback on failure."""
    if stage != stage_path(target):
        raise ValueError(f"Stage is not an exact target sibling: {stage}")
    if stage.is_symlink() or not stage.is_dir():
        raise ValueError(f"Stage must be one real directory: {stage}")

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
        fsync_directory(target.parent)
        published = True
        if moved_target:
            safe_remove_sibling_tree(backup, target=target, role="backup")
            moved_target = False
        fsync_directory(target.parent)
    except BaseException:
        if not published:
            if moved_stage and target.exists():
                replace(target, stage)
                moved_stage = False
            if moved_target and backup.exists():
                replace(backup, target)
                moved_target = False
            fsync_directory(target.parent)
        raise
    finally:
        if os.path.lexists(stage):
            safe_remove_sibling_tree(stage, target=target, role="stage")
        if os.path.lexists(backup):
            safe_remove_sibling_tree(backup, target=target, role="backup")


def stage_validate_publish(
    target: Path,
    *,
    force: bool,
    writer: Callable[[Path], None],
    validator: Callable[[Path], Any],
    replace: Callable[[Path, Path], None] = os.replace,
) -> Any:
    """Write and validate a sibling stage before changing the final target.

    ``writer`` creates the stage itself (``prepare()`` refuses a path that
    exists); whatever ``validator`` returns is returned once the stage is
    published.
    """
    with exclusive_publish_lock(target):
        preflight_output(target, force=force)
        stage = stage_path(target)
        if os.path.lexists(stage):
            raise RuntimeError(
                f"A stage from an interrupted publication is still in place: "
                f"{stage}. Publishing into it would mix two stores. Remove it "
                f"once no build is running, then rerun."
            )
        try:
            writer(stage)
            if stage.is_symlink() or not stage.is_dir():
                raise RuntimeError(f"The writer did not create the stage store {stage}.")
            measured = validator(stage)
            publish_validated_stage(stage, target, replace=replace)
        finally:
            if os.path.lexists(stage):
                safe_remove_sibling_tree(stage, target=target, role="stage")
    return measured


# --------------------------------------------------------------------------
# Store measurement and validation
# --------------------------------------------------------------------------


def store_files(directory: Path) -> list[Path]:
    """Every file of a store, in repository-relative POSIX order; no symlinks."""
    files: list[Path] = []
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"A published store holds no symbolic link: {path}")
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda path: path.relative_to(directory).as_posix())


def store_digest(directory: Path) -> dict[str, Any]:
    """SHA-256 over every file of a store, its relative path and its size.

    A file larger than GitHub accepts is refused here, before a store this
    repository could not publish replaces anything.
    """
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    for path in store_files(directory):
        relative = path.relative_to(directory).as_posix()
        size = path.stat().st_size
        if size > GITHUB_MAX_FILE_BYTES:
            raise ValueError(
                f"{relative} is {size:,} bytes; GitHub refuses a file larger than "
                f"{GITHUB_MAX_FILE_BYTES:,} bytes (100 MiB), so this store cannot be "
                "published from this repository."
            )
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "little"))
        digest.update(encoded)
        digest.update(size.to_bytes(8, "little"))
        with path.open("rb") as source:
            while chunk := source.read(READ_CHUNK_BYTES):
                digest.update(chunk)
        file_count += 1
        total_bytes += size
    return {"file_count": file_count, "total_bytes": total_bytes, "sha256": digest.hexdigest()}


ZARR_METADATA_NAMES = (".zgroup", ".zarray", ".zattrs")


def require_consolidated_metadata(directory: Path) -> None:
    """``.zmetadata`` must describe every metadata document of the store, exactly.

    A browser cannot list a folder: the web app learns every group and array
    of a store from ``.zmetadata`` alone, so a document it omits, or states
    differently from the file beside it, is data the viewer never sees.
    """
    consolidated = json.loads((directory / ".zmetadata").read_text(encoding="utf-8"))
    require_equal("consolidated metadata format", consolidated.get("zarr_consolidated_format"), 1)
    on_disk: dict[str, Any] = {}
    for path in store_files(directory):
        if path.name in ZARR_METADATA_NAMES:
            on_disk[path.relative_to(directory).as_posix()] = json.loads(
                path.read_text(encoding="utf-8")
            )
    if ".zgroup" not in on_disk:
        raise ValueError(f"{directory} is not a Zarr v2 store: it has no root .zgroup.")
    require_equal(
        "consolidated metadata documents",
        sorted(consolidated["metadata"]),
        sorted(on_disk),
    )
    for key, document in on_disk.items():
        stated = dict(consolidated["metadata"][key])
        if key.endswith(".zgroup"):
            # zarr-python 3 states each group's own (empty) nested consolidation
            # in the copy it consolidates; readers ignore it.
            stated.pop("consolidated_metadata", None)
        require_equal(f"consolidated {key}", stated, document)


def require_published_file_modes(directory: Path) -> None:
    for path in store_files(directory):
        require_equal(
            f"published file mode for {path.relative_to(directory).as_posix()}",
            stat.S_IMODE(path.stat(follow_symlinks=False).st_mode),
            0o644,
        )


def plain(value: Any) -> Any:
    """A value read back from ``uns`` as the JSON it was written from."""
    import numpy as np

    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, np.ndarray):
        return [plain(item) for item in value.tolist()]
    if isinstance(value, list):
        return [plain(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def obs_frame_digests(frame: Any) -> dict[str, dict[str, str]]:
    """Category and code digests of categorical columns, value digests of the rest."""
    import pandas as pd

    digests: dict[str, dict[str, str]] = {}
    for column in frame.columns:
        values = frame[column]
        if isinstance(values.dtype, pd.CategoricalDtype):
            digests[column] = {
                "categories_json_sha256": hash_strings(values.cat.categories.tolist()),
                "codes_i32_sha256": hash_array(values.cat.codes, "<i4"),
            }
        else:
            digests[column] = {"f64_sha256": hash_array(values.to_numpy(), "<f8")}
    return digests


def validate_outlier_quantiles(
    stored: Any,
    *,
    obs: Any,
    defaults: dict[str, Any],
) -> dict[str, dict[str, str]]:
    """Check ``uns['cellucid']['outlierQuantiles']`` and return its field digests.

    ``prepare()`` stores it whenever it is given a latent space, measured with
    the ``latentKey`` and ``centroidMinPoints`` the store's defaults name: one
    float32 quantile per cell for every categorical obs field with at least
    one category of ``minPoints`` cells. A quantile is the share of the cell's
    category at its distance from the centre or closer, so it is NaN exactly
    where a cell has no category or one under ``minPoints``, lies in (0, 1]
    everywhere else, and is 1 for the farthest cell of every scored category.
    The quantities themselves are pinned by their float32 digests, which the
    build records with the store.
    """
    import numpy as np
    import pandas as pd

    if "latentKey" not in defaults:
        require_equal("uns['cellucid']['outlierQuantiles']", stored, None)
        return {}
    if not isinstance(stored, dict):
        raise ValueError("uns['cellucid']['outlierQuantiles'] must be stored with the latent space.")
    require_equal("outlierQuantiles keys", sorted(stored), ["fields", "latentKey", "minPoints"])
    require_equal("outlierQuantiles latentKey", plain(stored["latentKey"]), defaults["latentKey"])
    min_points = defaults["centroidMinPoints"]
    require_equal("outlierQuantiles minPoints", plain(stored["minPoints"]), min_points)

    expected_fields: dict[str, Any] = {}
    for column in obs.columns:
        if not isinstance(obs[column].dtype, pd.CategoricalDtype):
            continue
        codes = obs[column].cat.codes.to_numpy().astype(np.int64)
        counts = np.bincount(codes[codes >= 0], minlength=len(obs[column].cat.categories))
        if (counts >= min_points).any():
            expected_fields[column] = (codes, counts)
    fields = stored["fields"]
    require_equal("outlierQuantiles fields", sorted(fields), sorted(expected_fields))

    digests: dict[str, dict[str, str]] = {}
    for column, (codes, counts) in expected_fields.items():
        values = fields[column]
        label = f"outlierQuantiles[{column!r}]"
        if not isinstance(values, np.ndarray):
            raise TypeError(f"{label} must be an array.")
        require_equal(f"{label} dtype", str(values.dtype), "float32")
        require_equal(f"{label} shape", list(values.shape), [len(codes)])
        scored = (codes >= 0) & (counts[np.maximum(codes, 0)] >= min_points)
        if not np.array_equal(np.isnan(values), ~scored):
            raise ValueError(f"{label} must be NaN exactly where a cell has no scored category.")
        kept = values[scored]
        if not ((kept > 0) & (kept <= 1)).all():
            raise ValueError(f"{label} must lie in (0, 1] for every scored cell.")
        farthest = np.full(len(counts), -np.inf, dtype=np.float32)
        np.maximum.at(farthest, codes[scored], kept)
        if not (farthest[counts >= min_points] == 1).all():
            raise ValueError(f"{label} must be 1 for the farthest cell of every scored category.")
        digests[column] = {"f32_sha256": hash_array(values, "<f4")}
    return digests


def validate_store(
    stage: Path,
    *,
    contract: dict[str, Any],
    expected: dict[str, Any],
) -> dict[str, Any]:
    """Read one staged store back off disk and check it against what was written.

    ``expected`` holds what the builder handed ``prepare()``: the cell and
    gene names, the obs frame, the var columns, the expression matrix, every
    obsm array and the neighbour graph. Each is compared with the element
    anndata reads back, exactly; ``uns['cellucid']`` is compared with the
    contract it was written from, and its ``outlierQuantiles`` with the rule
    ``validate_outlier_quantiles`` checks. Returns the measurement the contract
    records: the published expression, the outlier-quantile digests and the
    store's byte summary.
    """
    import anndata as ad
    import numpy as np
    import pandas as pd
    from scipy import sparse

    require_consolidated_metadata(stage)
    require_published_file_modes(stage)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        adata = ad.read_zarr(stage)
    require_equal(
        "warnings reading the store",
        [f"{item.category.__name__}: {item.message}" for item in captured],
        [],
    )

    require_equal("obs names", adata.obs_names.tolist(), list(expected["obs_names"]))
    require_equal("var names", adata.var_names.tolist(), list(expected["var_names"]))
    obs = adata.obs
    require_equal("obs columns", list(obs.columns), list(expected["obs"].columns))
    for column in obs.columns:
        written = expected["obs"][column]
        read = obs[column]
        require_equal(f"obs[{column!r}] dtype", str(read.dtype), str(written.dtype))
        if isinstance(read.dtype, pd.CategoricalDtype):
            require_equal(
                f"obs[{column!r}] categories",
                read.cat.categories.tolist(),
                written.cat.categories.tolist(),
            )
            require_equal(f"obs[{column!r}] ordered", read.cat.ordered, written.cat.ordered)
            if not np.array_equal(read.cat.codes.to_numpy(), written.cat.codes.to_numpy()):
                raise ValueError(f"obs[{column!r}] codes differ from the ones written.")
        elif not np.array_equal(read.to_numpy(), written.to_numpy(), equal_nan=True):
            raise ValueError(f"obs[{column!r}] values differ from the ones written.")
    require_equal(
        "var columns", list(adata.var.columns), list(expected["var_columns"])
    )
    for column, values in expected["var_columns"].items():
        require_equal(f"var[{column!r}]", adata.var[column].tolist(), list(values))

    if not isinstance(adata.X, sparse.csc_matrix | sparse.csc_array):
        raise TypeError("X must be stored gene-major (csc_matrix).")
    require_equal("X dtype", str(adata.X.dtype), "float32")
    expression_digest, expression_nnz = hash_sparse(adata.X)
    require_equal(
        "X canonical digest", expression_digest, hash_sparse(expected["X"])[0]
    )

    require_equal("obsm keys", sorted(adata.obsm.keys()), sorted(expected["obsm"]))
    for key, values in expected["obsm"].items():
        read = adata.obsm[key]
        require_equal(f"obsm[{key!r}] dtype", str(read.dtype), "float32")
        if not np.array_equal(read, np.asarray(values, dtype=np.float32)):
            raise ValueError(f"obsm[{key!r}] differs from the array written.")

    require_equal("obsp keys", sorted(adata.obsp.keys()), ["connectivities"])
    graph = adata.obsp["connectivities"]
    if not isinstance(graph, sparse.csr_matrix | sparse.csr_array):
        raise TypeError("obsp['connectivities'] must be stored as csr_matrix.")
    require_equal(
        "connectivities canonical digest",
        hash_sparse(graph)[0],
        hash_sparse(expected["connectivities"])[0],
    )
    for element in ("layers", "varm", "varp"):
        require_equal(f"{element} keys", list(getattr(adata, element).keys()), [])
    require_equal("uns keys", sorted(adata.uns.keys()), ["cellucid", "title"])
    require_equal("uns['title']", plain(adata.uns["title"]), contract["uns_cellucid"]["name"])
    cellucid = dict(adata.uns["cellucid"])
    outlier_quantiles = cellucid.pop("outlierQuantiles", None)
    require_equal("uns['cellucid']", plain(cellucid), contract["uns_cellucid"])
    outlier_digests = validate_outlier_quantiles(
        outlier_quantiles,
        obs=expected["obs"],
        defaults=contract["uns_cellucid"].get("defaults", {}),
    )

    measured = {
        "expression": {
            "shape": [int(adata.n_obs), int(adata.n_vars)],
            "nnz": expression_nnz,
            "canonical_csr_sha256": expression_digest,
        },
        "outlier_quantiles": outlier_digests,
        "store": store_digest(stage),
    }
    print(
        f"Verified {measured['store']['file_count']:,} store files "
        f"({measured['store']['total_bytes']:,} bytes; "
        f"SHA-256 {measured['store']['sha256']})."
    )
    return measured


def require_recorded(dataset_id: str, contract: dict[str, Any], measured: dict[str, Any]) -> None:
    """A rebuild must reproduce the recorded store byte for byte."""
    recorded = contract.get("recorded")
    if recorded is None:
        raise ValueError(
            f"sources/{dataset_id}.json records no store yet; build it once with "
            "--record, review the result, and rebuild without it to prove it reproduces."
        )
    require_equal(f"{dataset_id} store measurement", measured, recorded)


def record_measurement(dataset_id: str, measured: dict[str, Any]) -> None:
    """Write a published store's measurement into ``sources/<id>.json``."""
    path = SOURCES_ROOT / f"{dataset_id}.json"
    provenance = json.loads(path.read_text(encoding="utf-8"))
    provenance["anndata_contract"]["recorded"] = measured
    path.write_text(json.dumps(provenance, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Recorded the store measurement in sources/{dataset_id}.json.")


# --------------------------------------------------------------------------
# Repinning the producer
# --------------------------------------------------------------------------


def repin_producer() -> dict[str, Any]:
    """Pin the producer modules ``prepare()`` executes, as they are now.

    Run after a deliberate change to the cellucid-python producer, then
    rebuild every store without ``--record``: a store that comes out byte for
    byte the same proves the change did not reach the bytes; one that does not
    must be rebuilt with ``--record`` and reviewed. The executed set is the one
    ``require_writer_within_manifest`` measures on every build.
    """
    from cellucid import prepare  # noqa: F401

    repository = producer_repository()
    paths = executed_producer_modules(repository)
    source_files = [
        {"path": relative, "sha256": hash_and_size(repository / relative)[0]}
        for relative in paths
    ]
    environment = json.loads(ENVIRONMENT_PATH.read_text(encoding="utf-8"))
    producer = environment["cellucid_producer"]
    producer["version"] = importlib.metadata.version("cellucid")
    producer["source_files"] = source_files
    producer["source_tree_manifest_sha256"] = producer_manifest_sha256(repository, source_files)
    ENVIRONMENT_PATH.write_text(
        json.dumps(environment, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return producer


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Maintain the pinned build environment.")
    parser.add_argument(
        "command",
        choices=["repin-producer"],
        help="repin-producer: pin the cellucid modules prepare() executes, as they are now.",
    )
    parser.parse_args()
    pinned = repin_producer()
    print(
        f"Pinned cellucid {pinned['version']}: {len(pinned['source_files'])} modules, "
        f"manifest {pinned['source_tree_manifest_sha256']}."
    )
