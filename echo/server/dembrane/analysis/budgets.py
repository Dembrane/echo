"""Rendering budgets: how many nodes and visible edges a view may draw.

The defaults are starting points, not architectural maxima. A deployment may
set ceilings (`ANALYSIS_NODE_LIMIT_CEILING`, `ANALYSIS_EDGE_LIMIT_CEILING`, or
an `analysis` settings section with `node_limit_ceiling` and
`edge_limit_ceiling`); a host setting above a ceiling is rejected with the
reason, never silently clamped. Budgets affect display scope and layout only,
never extraction, persisted objects, evidence or revisions.

`edgeLimit >= nodeLimit - 1` always holds, so the admitted MST fits whole.
"""

from __future__ import annotations

import os
from typing import Any
from dataclasses import dataclass

DEFAULT_NODE_LIMIT = 150
DEFAULT_EDGE_LIMIT = 450

NODE_CEILING_ENV = "ANALYSIS_NODE_LIMIT_CEILING"
EDGE_CEILING_ENV = "ANALYSIS_EDGE_LIMIT_CEILING"


class BudgetError(ValueError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


@dataclass(frozen=True)
class Budgets:
    node_limit: int
    edge_limit: int

    def as_payload(self) -> dict[str, int]:
        return {"nodeLimit": self.node_limit, "edgeLimit": self.edge_limit}


@dataclass(frozen=True)
class Ceilings:
    node_limit: int | None = None
    edge_limit: int | None = None

    def as_payload(self) -> dict[str, int]:
        payload: dict[str, int] = {}
        if self.node_limit is not None:
            payload["nodeLimit"] = self.node_limit
        if self.edge_limit is not None:
            payload["edgeLimit"] = self.edge_limit
        return payload


@dataclass(frozen=True)
class ResolvedBudgets:
    budgets: Budgets
    defaults: Budgets
    ceilings: Ceilings
    # Plain sentences for the settings panel when a value was derived rather
    # than taken as given (an edge budget raised so the tree fits).
    adjustments: tuple[str, ...] = ()

    def as_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            **self.budgets.as_payload(),
            "defaults": self.defaults.as_payload(),
        }
        if self.ceilings.node_limit is not None or self.ceilings.edge_limit is not None:
            payload["ceilings"] = self.ceilings.as_payload()
        if self.adjustments:
            payload["adjustments"] = list(self.adjustments)
        return payload


def _positive_int(field: str, value: Any) -> int:
    # bool is an int in Python; a checkbox value is not a budget.
    if isinstance(value, bool) or not isinstance(value, int):
        raise BudgetError(field, f"{field} must be a positive whole number, got {value!r}")
    if value < 1:
        raise BudgetError(field, f"{field} must be a positive whole number, got {value}")
    return value


def _ceiling_value(raw: Any, field: str) -> int | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            raw = int(raw.strip())
        except ValueError:
            raise BudgetError(field, f"the {field} ceiling must be a whole number, got {raw!r}") from None
    return _positive_int(f"{field} ceiling", raw)


def configured_ceilings() -> Ceilings:
    """Ceilings from an `analysis` settings section when one exists, else the
    environment. None means no ceiling."""
    node: Any = None
    edge: Any = None
    try:
        from dembrane.settings import get_settings

        section = getattr(get_settings(), "analysis", None)
    except Exception:  # noqa: BLE001
        section = None
    if section is not None:
        node = getattr(section, "node_limit_ceiling", None)
        edge = getattr(section, "edge_limit_ceiling", None)
    if node is None:
        node = os.environ.get(NODE_CEILING_ENV)
    if edge is None:
        edge = os.environ.get(EDGE_CEILING_ENV)
    return Ceilings(_ceiling_value(node, "nodeLimit"), _ceiling_value(edge, "edgeLimit"))


def default_budgets(ceilings: Ceilings | None = None) -> Budgets:
    """The defaults, lowered to fit the ceilings while keeping the tree whole."""
    ceilings = ceilings or Ceilings()
    node = DEFAULT_NODE_LIMIT
    edge = DEFAULT_EDGE_LIMIT
    if ceilings.node_limit is not None:
        node = min(node, ceilings.node_limit)
    if ceilings.edge_limit is not None:
        edge = min(edge, ceilings.edge_limit)
        node = min(node, edge + 1)
    return Budgets(node_limit=node, edge_limit=max(edge, node - 1))


def validate_budgets(node_limit: Any, edge_limit: Any, ceilings: Ceilings | None = None) -> Budgets:
    """Both values given: check them as they are, adjusting nothing."""
    ceilings = ceilings or Ceilings()
    node = _positive_int("nodeLimit", node_limit)
    edge = _positive_int("edgeLimit", edge_limit)
    if ceilings.node_limit is not None and node > ceilings.node_limit:
        raise BudgetError(
            "nodeLimit",
            f"nodeLimit {node} is above this deployment's ceiling of {ceilings.node_limit} nodes",
        )
    if ceilings.edge_limit is not None and edge > ceilings.edge_limit:
        raise BudgetError(
            "edgeLimit",
            f"edgeLimit {edge} is above this deployment's ceiling of {ceilings.edge_limit} edges",
        )
    if edge < node - 1:
        raise BudgetError(
            "edgeLimit",
            f"edgeLimit must be at least nodeLimit - 1 ({node - 1}) so every tree edge fits, got {edge}",
        )
    return Budgets(node_limit=node, edge_limit=edge)


def resolve_budgets(
    node_limit: Any = None,
    edge_limit: Any = None,
    *,
    ceilings: Ceilings | None = None,
) -> ResolvedBudgets:
    """A host's saved settings (either may be missing) resolved into budgets.

    A missing node limit takes the default. A missing edge limit takes the
    default, raised to nodeLimit - 1 when that is larger, and says so. A value
    that was given is validated as given."""
    ceilings = ceilings if ceilings is not None else configured_ceilings()
    defaults = default_budgets(ceilings)
    adjustments: list[str] = []
    node = defaults.node_limit if node_limit is None else _positive_int("nodeLimit", node_limit)
    if edge_limit is None:
        edge = defaults.edge_limit
        if edge < node - 1:
            edge = node - 1
            adjustments.append(
                f"edgeLimit raised to {edge} so all {node - 1} tree edges of {node} nodes fit"
            )
    else:
        edge = _positive_int("edgeLimit", edge_limit)
    return ResolvedBudgets(
        budgets=validate_budgets(node, edge, ceilings),
        defaults=defaults,
        ceilings=ceilings,
        adjustments=tuple(adjustments),
    )
