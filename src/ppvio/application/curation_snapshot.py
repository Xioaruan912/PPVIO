"""Versioned curation state at the encrypted manifest boundary."""
from __future__ import annotations

from ppvio.domain.curation import validate_curation_snapshot


def read_curation_snapshot(manifest: dict) -> dict | None:
    # Legacy manifests did not know about this metadata and cannot erase it.
    if manifest["schema_version"] < 4:
        return None
    return validate_curation_snapshot(manifest.get("curation"))
