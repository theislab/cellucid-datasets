"""The pinned build every published sample generation is produced by.

``build_pancreas.py`` and ``build_atlas.py`` differ only in how a source turns
into the arrays ``cellucid.prepare()`` receives. Everything a rebuild has to
prove regardless of the dataset lives here, once:

- the environment: the interpreter, the exact installed distribution set
  (``requirements-build.lock``), the BLAS runtime, the thread count, the hash
  seed, and the SHA-256 of every Cellucid producer module the export path
  executes, all read from ``sources/build-environment.json``;
- the input: the source file's size and SHA-256 from ``sources/<id>.json``;
- the output: a staged generation, validated against the identity, manifests,
  payload digests and whole-generation digest that ``sources/<id>.json`` pins,
  and only then swapped atomically into ``exports-v3/<id>/``.

This module imports nothing outside the standard library at import time. The
publisher suite, ``tests/test_pinned_build_publish.py``, runs in CI with no
dependencies installed, and every numerical import below is function-local.
"""

from __future__ import annotations

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
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCES_ROOT = REPOSITORY_ROOT / "sources"
ENVIRONMENT_PATH = SOURCES_ROOT / "build-environment.json"
EXPORTS_ROOT = REPOSITORY_ROOT / "exports-v3"
READ_CHUNK_BYTES = 1024 * 1024
EXACT_REQUIREMENT_RE = re.compile(r"^([A-Za-z0-9_.-]+)==([^;\s]+)$")
LOWER_HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PUBLICATION_SIDECAR_NAMES = frozenset(
    {"default.cellucid-session", "state-snapshots.json"}
)
ENVIRONMENT_SCHEMA_VERSION = 1
PROVENANCE_SCHEMA_VERSION = 3
IDENTITY_VERSION = 3
INDEXED_PAYLOAD_NAMES = {
    "embeddings": re.compile(r"^(?:0|[1-9][0-9]*)_[123]d\.bin(?:\.gz)?$"),
    "obs": re.compile(
        r"^(?:0|[1-9][0-9]*)\.(?:values\.(?:u8|u16|f32)|codes\.u(?:8|16|32)"
        r"|outliers\.(?:u8|u16|f32))(?:\.gz)?$"
    ),
    "var": re.compile(r"^(?:0|[1-9][0-9]*)\.values\.(?:u8|u16|f32)(?:\.gz)?$"),
    "vectors": re.compile(r"^(?:0|[1-9][0-9]*)_(?:0|[1-9][0-9]*)\.bin(?:\.gz)?$"),
}
CANONICAL_GZIP_HEADER = bytes.fromhex("1f8b08000000000000ff")
# GitHub blocks a pushed file larger than 100 MiB (its hard per-file limit),
# so a generation this repository could not publish is refused here, before
# it replaces anything.
GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024


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
    # The gene export loop draws a tqdm bar; it carries no build information.
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


def require_export_path_within_manifest(
    repository: Path, source_files: list[dict[str, str]]
) -> None:
    """Refuse to build when the export path runs producer code nothing pins.

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
            "The Cellucid export path executes producer modules that "
            "sources/build-environment.json does not pin: "
            + ", ".join(uncovered)
            + ". Add them to cellucid_producer.source_files so the recorded "
            "provenance covers the code that writes the export."
        )


def producer_repository() -> Path:
    """The source tree the imported Cellucid producer is installed from.

    The producer is pinned by the SHA-256 of every module the export path
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


def preflight_runtime(environment: dict[str, Any], *, data_version: str) -> Any:
    """Fail before any source is read if the canonical runtime differs.

    Returns the ``cellucid`` module, whose ``prepare`` and ``Embedding`` are the
    producer the pins describe.
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
    from cellucid import Embedding, prepare  # noqa: F401

    repository = producer_repository()
    source_files = producer["source_files"]
    require_equal(
        "Cellucid producer source-tree manifest SHA-256",
        producer_manifest_sha256(repository, source_files),
        producer["source_tree_manifest_sha256"],
    )
    require_export_path_within_manifest(repository, source_files)

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

    signature = inspect.signature(prepare)
    for keyword in ("created_at", "embeddings", "embedding_defaults", "var_gene_name_columns"):
        parameter = signature.parameters.get(keyword)
        if parameter is None or parameter.kind is not inspect.Parameter.KEYWORD_ONLY:
            raise RuntimeError(
                f"cellucid.prepare() must take the keyword-only {keyword}= argument "
                f"the pinned build passes."
            )
    require_equal(
        "Cellucid exporter version",
        importlib.metadata.version("cellucid"),
        producer["version"],
    )
    require_equal("Cellucid producer/export contract version", producer["version"], data_version)
    return cellucid


# --------------------------------------------------------------------------
# Staged publication
# --------------------------------------------------------------------------


def preflight_output(output_path: Path, *, force: bool) -> None:
    if not output_path.is_absolute():
        raise ValueError(f"Output must be an absolute lexical path: {output_path}")
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
    """Return the one fixed sibling directory a publication stages into.

    The name carries no random suffix, and that is the point. ``prepare()``
    holds its writer lock on ``<parent>/.<out_dir name>.cellucid.lock`` and
    deliberately never unlinks it: ``cellucid/prepare_data/_locking.py``
    explains that an unlink/create race can hand the same inode to two writers,
    so the file stays and its identity is re-validated instead. That bounds the
    number of lock files only while the locked name repeats. A stage under a
    fresh random name would lock a name that can never recur, and every run
    would strand one more zero-byte inode. A fixed stage name is reused on the
    next run, and two concurrent publications contend for one lock instead of
    each locking a name only itself knows.

    The set-aside backup keeps its random suffix by contrast, because it is
    created with ``os.replace(target, backup)`` -- a fixed name that an
    interrupted run left behind would make that rename fail against a non-empty
    directory -- and because nothing locks it, so it cannot accumulate.
    """
    return target.parent / f".{target.name}.stage"


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


def copy_publication_sidecars(source: Path, destination: Path) -> None:
    """Carry the reviewed publication sidecars over without adding them to science."""
    if not source.exists():
        return
    for name in sorted(PUBLICATION_SIDECAR_NAMES):
        source_path = source / name
        if not os.path.lexists(source_path):
            continue
        metadata = source_path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(
                f"Publication sidecar must be one regular file: {source_path}"
            )
        destination_path = destination / name
        if os.path.lexists(destination_path):
            raise RuntimeError(
                f"The scientific producer wrote the reserved publication sidecar "
                f"{destination_path}"
            )
        shutil.copyfile(source_path, destination_path)
        destination_path.chmod(0o644)


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
    validator: Callable[[Path], None],
    replace: Callable[[Path, Path], None] = os.replace,
) -> None:
    """Write and validate a sibling stage before changing the final target."""
    with exclusive_publish_lock(target):
        preflight_output(target, force=force)
        stage = stage_path(target)
        try:
            stage.mkdir(mode=0o700)
        except FileExistsError as error:
            raise RuntimeError(
                f"A stage from an interrupted publication is still in place: "
                f"{stage}. Publishing into it would mix two generations. Remove it "
                f"once no build is running, then rerun."
            ) from error
        try:
            writer(stage)
            validator(stage)
            copy_publication_sidecars(target, stage)
            publish_validated_stage(stage, target, replace=replace)
        finally:
            if os.path.lexists(stage):
                safe_remove_sibling_tree(stage, target=target, role="stage")


# --------------------------------------------------------------------------
# Generation measurement and validation
# --------------------------------------------------------------------------


def generation_digest(directory: Path) -> tuple[str, int, int]:
    """SHA-256 over every published file, its relative path and its size.

    The two root publication sidecars are excluded: they are reviewed artifacts
    captured against the application after a rebuild, not science the producer
    writes, so republishing a preset never moves a generation pin.
    """
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
        if size > GITHUB_MAX_FILE_BYTES:
            raise ValueError(
                f"{path.relative_to(directory).as_posix()} is {size:,} bytes; GitHub "
                f"refuses a file larger than {GITHUB_MAX_FILE_BYTES:,} bytes (100 MiB), "
                "so this generation cannot be published from this repository."
            )
        digest.update(len(relative).to_bytes(8, "little"))
        digest.update(relative)
        digest.update(size.to_bytes(8, "little"))
        with path.open("rb") as source:
            while chunk := source.read(READ_CHUNK_BYTES):
                digest.update(chunk)
        file_count += 1
        total_bytes += size
    return digest.hexdigest(), file_count, total_bytes


def semantic_payload_paths(identity: dict[str, Any]) -> dict[str, int]:
    """Every coordinate and vector payload, with the dimension it is laid out in."""
    items = identity["embeddings"]["items"]
    dimensions = {key: item["dimension"] for key, item in items.items()}
    payloads = {item["file"]: item["dimension"] for item in items.values()}
    for field in identity.get("vector_fields", {}).get("fields", {}).values():
        for embedding_id, relative in field["files"].items():
            payloads[relative] = dimensions[embedding_id]
    return dict(sorted(payloads.items()))


def measure_semantic_payloads(output_path: Path, identity: dict[str, Any]) -> dict[str, Any]:
    """Decompressed byte count, SHA-256 and row census of each float payload."""
    import numpy as np

    measured: dict[str, Any] = {}
    for relative, dimension in semantic_payload_paths(identity).items():
        raw = gzip.decompress((output_path / relative).read_bytes())
        values = np.frombuffer(raw, dtype="<f4").reshape((-1, dimension))
        entry: dict[str, Any] = {
            "raw_bytes": len(raw),
            "raw_sha256": hashlib.sha256(raw).hexdigest(),
        }
        if relative.startswith("vectors/"):
            entry["nonzero_rows"] = int(
                np.count_nonzero(np.linalg.norm(values, axis=1) > 0)
            )
        measured[relative] = entry
    return measured


def validate_generation(
    output_path: Path,
    provenance: dict[str, Any],
) -> dict[str, Any]:
    """Check one staged generation against everything ``sources/<id>.json`` pins.

    Returns the identity it read, so a builder can add checks of its own.
    """
    import numpy as np

    export = provenance["export_contract"]
    identity = json.loads((output_path / "dataset_identity.json").read_text(encoding="utf-8"))
    require_equal("generated identity version", identity["version"], IDENTITY_VERSION)
    for key in ("cellucid_data_version", "id", "name", "description", "created_at"):
        require_equal(f"generated identity {key}", identity[key], export["identity"][key])
    require_equal("generated identity stats", identity["stats"], export["identity"]["stats"])
    require_equal(
        "generated identity embeddings",
        identity["embeddings"],
        export["identity"]["embeddings"],
    )
    require_equal(
        "generated identity vector_fields",
        identity.get("vector_fields"),
        export["identity"]["vector_fields"],
    )
    require_equal("generated identity source", identity["source"], export["identity"]["source"])
    require_equal(
        "generated identity export_settings",
        identity["export_settings"],
        export["identity"]["export_settings"],
    )
    require_equal(
        "generated identity obs fields",
        identity["obs_fields"],
        export["identity"]["obs_fields"],
    )

    obs_manifest = json.loads((output_path / "obs_manifest.json").read_text(encoding="utf-8"))
    require_equal("generated obs manifest format", obs_manifest["_format"], "compact_v2")
    # A payload file is named by its integer index and never by its key, so a
    # manifest entry leads with that index. Both arrays write into obs/, so
    # they share one index space, and a repeated index would publish one
    # field's values under another field's entry.
    obs_indices = [
        entry[0]
        for entry in (*obs_manifest["_continuousFields"], *obs_manifest["_categoricalFields"])
    ]
    require_equal(
        "generated obs payload indices",
        sorted(obs_indices),
        list(range(len(obs_indices))),
    )
    for entry in obs_manifest["_categoricalFields"]:
        require_equal(
            f"generated centroid embeddings for obs[{entry[1]!r}]",
            sorted(entry[5]),
            sorted(identity["embeddings"]["items"]),
        )

    var_manifest = json.loads((output_path / "var_manifest.json").read_text(encoding="utf-8"))
    require_equal("generated var manifest format", var_manifest["_format"], "compact_v2")
    require_equal(
        "generated gene payload indices",
        [entry[0] for entry in var_manifest["fields"]],
        list(range(identity["stats"]["n_genes"])),
    )
    require_equal(
        "generated gene names digest",
        hash_strings([entry[1] for entry in var_manifest["fields"]]),
        export["gene_names_json_sha256"],
    )
    require_equal(
        "generated gene-name sets",
        [
            {key: value for key, value in entry.items() if key != "names"}
            for entry in var_manifest["gene_name_sets"]
        ],
        export["gene_name_sets"],
    )
    require_equal(
        "generated alternative gene-name digests",
        [
            hash_strings(
                [
                    default if name is None else name
                    for default, name in zip(
                        (entry[1] for entry in var_manifest["fields"]),
                        name_set["names"],
                        strict=True,
                    )
                ]
            )
            for name_set in var_manifest["gene_name_sets"][1:]
        ],
        export["alternative_gene_name_digests"],
    )

    for directory, pattern in INDEXED_PAYLOAD_NAMES.items():
        if not (output_path / directory).exists():
            continue
        offenders = sorted(
            path.name
            for path in (output_path / directory).iterdir()
            if pattern.fullmatch(path.name) is None
        )
        if offenders:
            raise ValueError(
                f"Generated {directory}/ names payload files after something other "
                f"than their integer index: {offenders[:5]}"
            )

    gzip_paths = sorted(output_path.rglob("*.gz"))
    if not gzip_paths:
        raise RuntimeError("Generated dataset must contain gzip artifacts.")
    for path in output_path.rglob("*"):
        if path.is_file():
            require_equal(
                f"published file mode for {path.relative_to(output_path)}",
                stat.S_IMODE(path.stat(follow_symlinks=False).st_mode),
                0o644,
            )
    for path in gzip_paths:
        with path.open("rb") as source:
            header = source.read(10)
        require_equal(
            f"canonical gzip header for {path.relative_to(output_path)}",
            header,
            CANONICAL_GZIP_HEADER,
        )

    measured = measure_semantic_payloads(output_path, identity)
    require_equal("semantic payload digests", measured, export["semantic_payloads"])
    for relative, dimension in semantic_payload_paths(identity).items():
        if not relative.startswith("embeddings/"):
            continue
        raw = gzip.decompress((output_path / relative).read_bytes())
        values = np.frombuffer(raw, dtype="<f4").reshape((-1, dimension))
        require_finite(f"semantic payload {relative}", values)
        if not bool(np.all((values >= -1) & (values <= 1))):
            raise ValueError(f"Embedding payload {relative} must remain within [-1, 1].")

    sha256, file_count, total_bytes = generation_digest(output_path)
    require_equal(
        "generation summary",
        {"file_count": file_count, "total_bytes": total_bytes, "sha256": sha256},
        {
            "file_count": export["expected_file_count"],
            "total_bytes": export["expected_total_bytes"],
            "sha256": export["generation_sha256"],
        },
    )
    print(
        f"Verified {file_count:,} deterministic artifacts "
        f"({total_bytes:,} bytes; SHA-256 {sha256})."
    )
    return identity
