"""Shared lifecycle for typed, revisioned analysis objects produced by recipes.

A recipe declares what analysis happens and what it produces; one executor
runs every recipe through the same request, lease, checkpoint, validation and
publication path, and one revision service writes every object revision.
Views read immutable snapshots. See
`docs/superpowers/specs/2026-09-15-analysis-objects-and-mixed-map.md`.

Importing this package is cheap on purpose: `dembrane.map.store` imports its
connection helper from `dembrane.analysis.db`.
"""
