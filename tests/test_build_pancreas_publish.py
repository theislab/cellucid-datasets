"""Failure-preservation tests for the Pancreas staged publisher."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

import build_pancreas as builder  # noqa: E402


class PancreasPublishTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".pancreas-publish-test-",
            dir=REPOSITORY_ROOT,
        )
        self.parent = Path(self.temporary.name)
        self.target = self.parent / "pancreas"
        self.target.mkdir()
        (self.target / "identity.json").write_bytes(b"old-generation")
        nested = self.target / "obs"
        nested.mkdir()
        (nested / "field.gz").write_bytes(b"old-payload")
        self.sidecars = {
            "default.cellucid-session": b"reviewed-session-bytes",
            "state-snapshots.json": (b'{ "states": ["default.cellucid-session"] }\n'),
        }
        for name, payload in self.sidecars.items():
            (self.target / name).write_bytes(payload)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _assert_old_generation_intact(self) -> None:
        self.assertEqual(
            (self.target / "identity.json").read_bytes(), b"old-generation"
        )
        self.assertEqual(
            (self.target / "obs" / "field.gz").read_bytes(), b"old-payload"
        )
        for name, payload in self.sidecars.items():
            self.assertEqual((self.target / name).read_bytes(), payload)
        self.assertEqual(
            [
                path.name
                for path in self.parent.iterdir()
                if path.name.startswith(".pancreas.")
            ],
            [],
        )

    @staticmethod
    def _write_candidate(stage: Path) -> None:
        (stage / "identity.json").write_bytes(b"new-generation")
        (stage / "vectors").mkdir()
        (stage / "vectors" / "velocity.bin.gz").write_bytes(b"new-payload")

    def test_validation_failure_preserves_prior_generation_and_cleans_stage(
        self,
    ) -> None:
        def reject_candidate(_stage: Path) -> None:
            raise ValueError("expected generation digest mismatch")

        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            builder._stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=reject_candidate,
            )
        self._assert_old_generation_intact()

    def test_publish_failure_rolls_back_and_cleans_stage_backup_and_lock(self) -> None:
        def fail_stage_swap(source: Path, destination: Path) -> None:
            if (
                source.name.startswith(".pancreas.stage-")
                and destination == self.target
            ):
                raise OSError("injected stage publication failure")
            os.replace(source, destination)

        with self.assertRaisesRegex(OSError, "injected stage publication failure"):
            builder._stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
                replace=fail_stage_swap,
            )
        self._assert_old_generation_intact()

    def test_success_replaces_generation_without_orphans(self) -> None:
        def validate_scientific_stage(stage: Path) -> None:
            for name in self.sidecars:
                self.assertFalse((stage / name).exists())

        builder._stage_validate_publish(
            self.target,
            force=True,
            writer=self._write_candidate,
            validator=validate_scientific_stage,
        )
        self.assertEqual(
            (self.target / "identity.json").read_bytes(), b"new-generation"
        )
        self.assertEqual(
            (self.target / "vectors" / "velocity.bin.gz").read_bytes(),
            b"new-payload",
        )
        for name, payload in self.sidecars.items():
            self.assertEqual((self.target / name).read_bytes(), payload)
        self.assertEqual(
            [
                path.name
                for path in self.parent.iterdir()
                if path.name.startswith(".pancreas.")
            ],
            [],
        )

    def test_post_commit_cleanup_failure_never_restores_partial_backup(self) -> None:
        original_remove = builder._safe_remove_sibling_tree
        injected = False

        def fail_backup_cleanup_once(
            path: Path,
            *,
            target: Path,
            role: str,
        ) -> None:
            nonlocal injected
            if role == "backup" and not injected:
                injected = True
                (path / "obs" / "field.gz").unlink()
                raise OSError("injected post-commit backup cleanup failure")
            original_remove(path, target=target, role=role)

        with (
            patch.object(
                builder,
                "_safe_remove_sibling_tree",
                side_effect=fail_backup_cleanup_once,
            ),
            self.assertRaisesRegex(
                OSError,
                "injected post-commit backup cleanup failure",
            ),
        ):
            builder._stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
            )

        self.assertEqual(
            (self.target / "identity.json").read_bytes(),
            b"new-generation",
        )
        self.assertEqual(
            (self.target / "vectors" / "velocity.bin.gz").read_bytes(),
            b"new-payload",
        )
        for name, payload in self.sidecars.items():
            self.assertEqual((self.target / name).read_bytes(), payload)
        self.assertFalse((self.target / "obs").exists())
        self.assertEqual(
            [
                path.name
                for path in self.parent.iterdir()
                if path.name.startswith(".pancreas.")
            ],
            [],
        )

    def test_symlink_and_broken_symlink_targets_are_rejected(self) -> None:
        real_target = self.parent / "real"
        real_target.mkdir()
        symlink_target = self.parent / "linked"
        symlink_target.symlink_to(real_target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
            builder._preflight_output(symlink_target, force=True)

        broken_target = self.parent / "broken"
        broken_target.symlink_to(self.parent / "missing", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
            builder._preflight_output(broken_target, force=True)

    def test_generation_digest_excludes_only_root_publication_sidecars(self) -> None:
        stage = self.parent / "digest"
        stage.mkdir()
        (stage / "dataset_identity.json").write_bytes(b"science")
        baseline = builder._generation_digest(stage)
        for name, payload in self.sidecars.items():
            (stage / name).write_bytes(payload)
        self.assertEqual(builder._generation_digest(stage), baseline)

        nested = stage / "nested"
        nested.mkdir()
        (nested / "default.cellucid-session").write_bytes(b"nested-science")
        nested_digest = builder._generation_digest(stage)
        self.assertEqual(nested_digest[1], baseline[1] + 1)
        self.assertEqual(
            nested_digest[2],
            baseline[2] + len(b"nested-science"),
        )

    def test_invalid_publication_sidecar_preserves_prior_generation(self) -> None:
        sidecar = self.target / "default.cellucid-session"
        sidecar.unlink()
        sidecar.symlink_to(self.target / "identity.json")
        with self.assertRaisesRegex(ValueError, "sidecar must be one regular file"):
            builder._stage_validate_publish(
                self.target,
                force=True,
                writer=self._write_candidate,
                validator=lambda _stage: None,
            )
        self.assertEqual(
            (self.target / "identity.json").read_bytes(),
            b"old-generation",
        )
        self.assertTrue(sidecar.is_symlink())


if __name__ == "__main__":
    unittest.main()
