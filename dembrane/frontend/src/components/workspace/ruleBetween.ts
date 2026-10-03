import type { CSSProperties } from "react";

/**
 * Rows listed inside one bordered container are divided by a single faint
 * rule, so a list reads as one card instead of a stack of cards whose rules
 * double up. Row `i` of `count` gets a rule below it unless it is the last.
 */
export const ruleBetween = (i: number, count: number): CSSProperties =>
	i < count - 1 ? { borderBottom: "1px solid var(--app-rule-color)" } : {};
