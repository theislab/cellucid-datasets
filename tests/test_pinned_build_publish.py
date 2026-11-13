"""Failure-preservation tests for the staged publisher every sample build uses."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

import pinned_build as builder  # noqa: E402


class PinnedPublishTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".pinned-publish-test-",
            dir=REPOSITORY_ROOT,
        )
        self.parent = Path(self.temporary.name)
        self.target = self.parent / "pancreas.zarr"
        self.target.mkdir()
        (self.target / ".zgroup").write_bytes(b"old-store")
        nested = self.target / "obs"
        nested.mkdir()
        (nested / "0").write_bytes(b"old-chunk")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _assert_no_sidecar_survives(self) -> None:
        """No hidden sibling of the published store may outlive a publication.

        The assertion covers every hidden entry rather than one known name
        shape: a stage, a set-aside store, a publication lock, and the
        ``.<name>.<pid>.partial`` that ``cellucid.prepare()`` writes before it
        moves a store into place.
        """
        self.assertEqual(
            sorted(path.name for path in self.parent.iterdir() if path.name.startswith(".")),
            [],
        )

    def _assert_old_store_intact(self) -> None:
        self.assertEqual((self.target / ".zgroup").read_bytes(), b"old-store")
        self.assertEqual((self.target / "obs" / "0").read_bytes(), b"old-chunk")
        self._assert_no_sidecar_survives()

    @staticmethod
    def _write_candidate(stage: Path) -> None:
        # prepare() creates the store itself and refuses a path that exists.
        stage.mkdir()
        (stage / ".zgroup").write_bytes(b"new-store")
        (stage / "obsm").mkdir()
        (stage / "obsm" / "0.0").write_bytes(b"new-chunk")

    def test_validation_failure_preserves_prior_store_and_cleans_stage(self) -> None:
        def reject_candidate(_stage: Path) -> None:
            raise ValueError("expected store digest mismatch")

        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=reject_candidate,
            )
        self._assert_old_store_intact()

    def test_writer_failure_preserves_prior_store_and_cleans_stage(self) -> None:
        def fail_half_way(stage: Path) -> None:
            stage.mkdir()
            (stage / ".zgroup").write_bytes(b"half-written")
            raise RuntimeError("injected writer failure")

        with self.assertRaisesRegex(RuntimeError, "injected writer failure"):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=fail_half_way,
                validator=lambda _stage: None,
            )
        self._assert_old_store_intact()

    def test_a_writer_that_creates_no_stage_publishes_nothing(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "did not create the stage"):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=lambda _stage: None,
                validator=lambda _stage: None,
            )
        self._assert_old_store_intact()

    def test_publish_failure_rolls_back_and_cleans_stage_backup_and_lock(self) -> None:
        def fail_stage_swap(source: Path, destination: Path) -> None:
            if source == builder.stage_path(self.target) and destination == self.target:
                raise OSError("injected stage publication failure")
            os.replace(source, destination)

        with self.assertRaisesRegex(OSError, "injected stage publication failure"):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
                replace=fail_stage_swap,
            )
        self._assert_old_store_intact()

    def test_success_replaces_store_and_returns_the_measurement(self) -> None:
        measured = builder.stage_validate_publish(
            self.target,
            force=True,
            writer=self._write_candidate,
            validator=lambda stage: builder.store_digest(stage),
        )
        self.assertEqual((self.target / ".zgroup").read_bytes(), b"new-store")
        self.assertEqual((self.target / "obsm" / "0.0").read_bytes(), b"new-chunk")
        self.assertFalse((self.target / "obs").exists())
        self.assertEqual(measured, builder.store_digest(self.target))
        self._assert_no_sidecar_survives()

    def test_repeated_publications_stage_under_one_reused_name(self) -> None:
        """Every publication stages under the same fixed sibling name.

        A stage under a fresh random name would leave one more hidden tree
        beside the stores for every run that crashed, under a name nothing
        looks for; a fixed name is found, and refused, by the next run.
        """
        staged: list[Path] = []

        def record_stage(stage: Path) -> None:
            staged.append(stage)
            self._write_candidate(stage)

        for _ in range(3):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=record_stage,
                validator=lambda _stage: None,
            )

        expected = self.parent / ".stage.pancreas.zarr"
        self.assertEqual(staged, [expected, expected, expected])
        self.assertEqual(builder.stage_path(self.target), expected)
        self.assertTrue(expected.name.endswith(builder.STORE_SUFFIX))
        self._assert_no_sidecar_survives()

    def test_interrupted_stage_blocks_the_next_publication(self) -> None:
        """A stage left behind is reported, never published into or discarded."""
        abandoned = builder.stage_path(self.target)
        abandoned.mkdir()
        (abandoned / "half-written").write_bytes(b"interrupted")

        with self.assertRaisesRegex(RuntimeError, "interrupted publication"):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
            )

        self.assertEqual((abandoned / "half-written").read_bytes(), b"interrupted")
        self.assertEqual((self.target / ".zgroup").read_bytes(), b"old-store")

    def test_post_commit_cleanup_failure_never_restores_partial_backup(self) -> None:
        original_remove = builder.safe_remove_sibling_tree
        injected = False

        def fail_backup_cleanup_once(path: Path, *, target: Path, role: str) -> None:
            nonlocal injected
            if role == "backup" and not injected:
                injected = True
                (path / "obs" / "0").unlink()
                raise OSError("injected post-commit backup cleanup failure")
            original_remove(path, target=target, role=role)

        with (
            patch.object(builder, "safe_remove_sibling_tree", side_effect=fail_backup_cleanup_once),
            self.assertRaisesRegex(OSError, "injected post-commit backup cleanup failure"),
        ):
            builder.stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
            )

        self.assertEqual((self.target / ".zgroup").read_bytes(), b"new-store")
        self.assertEqual((self.target / "obsm" / "0.0").read_bytes(), b"new-chunk")
        self.assertFalse((self.target / "obs").exists())
        self._assert_no_sidecar_survives()

    def test_symlink_and_broken_symlink_targets_are_rejected(self) -> None:
        real_target = self.parent / "real.zarr"
        real_target.mkdir()
        symlink_target = self.parent / "linked.zarr"
        symlink_target.symlink_to(real_target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
            builder.preflight_output(symlink_target, force=True)

        broken_target = self.parent / "broken.zarr"
        broken_target.symlink_to(self.parent / "missing", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
            builder.preflight_output(broken_target, force=True)

    def test_output_must_be_a_zarr_store_folder(self) -> None:
        with self.assertRaisesRegex(ValueError, "Zarr store folder"):
            builder.preflight_output(self.parent / "pancreas", force=True)
        with self.assertRaisesRegex(ValueError, "Zarr store folder"):
            builder.preflight_output(self.parent / ".zarr", force=True)

    def test_store_digest_covers_every_file_path_and_size(self) -> None:
        baseline = builder.store_digest(self.target)
        self.assertEqual(baseline["file_count"], 2)
        self.assertEqual(baseline["total_bytes"], len(b"old-store") + len(b"old-chunk"))
        (self.target / "obs" / "0").rename(self.target / "obs" / "1")
        renamed = builder.store_digest(self.target)
        self.assertEqual(renamed["total_bytes"], baseline["total_bytes"])
        self.assertNotEqual(renamed["sha256"], baseline["sha256"])

    def test_store_digest_refuses_a_file_github_cannot_hold(self) -> None:
        with (self.target / "obs" / "0").open("wb") as handle:
            handle.truncate(builder.GITHUB_MAX_FILE_BYTES)
        builder.store_digest(self.target)
        with (self.target / "obs" / "0").open("wb") as handle:
            handle.truncate(builder.GITHUB_MAX_FILE_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "GitHub refuses a file larger than"):
            builder.store_digest(self.target)

    def test_store_digest_refuses_a_symbolic_link(self) -> None:
        (self.target / "linked").symlink_to(self.target / ".zgroup")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            builder.store_digest(self.target)

    def test_consolidated_metadata_must_state_every_document(self) -> None:
        store = self.parent / "consolidated.zarr"
        (store / "obs").mkdir(parents=True)
        documents = {
            ".zgroup": {"zarr_format": 2},
            ".zattrs": {"encoding-type": "anndata", "encoding-version": "0.1.0"},
            "obs/.zgroup": {"zarr_format": 2},
        }
        for relative, document in documents.items():
            (store / relative).write_text(json.dumps(document), encoding="utf-8")

        def consolidate(metadata: dict) -> None:
            (store / ".zmetadata").write_text(
                json.dumps({"zarr_consolidated_format": 1, "metadata": metadata}), encoding="utf-8"
            )

        consolidate(documents)
        builder.require_consolidated_metadata(store)
        consolidate({key: value for key, value in documents.items() if key != "obs/.zgroup"})
        with self.assertRaisesRegex(ValueError, "consolidated metadata documents"):
            builder.require_consolidated_metadata(store)
        consolidate({**documents, ".zattrs": {"encoding-type": "anndata"}})
        with self.assertRaisesRegex(ValueError, "consolidated .zattrs"):
            builder.require_consolidated_metadata(store)

    def test_record_measurement_is_only_ever_compared_once_recorded(self) -> None:
        with self.assertRaisesRegex(ValueError, "records no store yet"):
            builder.require_recorded("pancreas", {"recorded": None}, {"store": {}})
        builder.require_recorded("pancreas", {"recorded": {"store": {"a": 1}}}, {"store": {"a": 1}})
        with self.assertRaisesRegex(ValueError, "store measurement"):
            builder.require_recorded("pancreas", {"recorded": {"store": {"a": 1}}}, {"store": {"a": 2}})


if __name__ == "__main__":
    unittest.main()
