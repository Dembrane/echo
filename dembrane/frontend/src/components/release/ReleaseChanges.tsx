import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useId } from "react";
import styles from "./ReleaseChanges.module.css";
import type { ReleaseChange } from "./releases";

export const ReleaseChanges = ({
	changes,
	compact = false,
}: {
	changes: ReleaseChange[];
	compact?: boolean;
}) => {
	useLingui();
	const id = useId();
	const groups = [
		{ label: t`New features`, type: "feature" },
		{ label: t`Improvements`, type: "improvement" },
		{ label: t`Bug fixes`, type: "fix" },
	] as const;
	return (
		<div className={styles.groups} data-compact={compact}>
			{groups.map(({ type, label }) => {
				const items = changes.filter((change) => change.type === type);
				if (!items.length) return null;
				const headingId = `${id}-${type}`;
				return (
					<div key={type}>
						<h4 id={headingId} className={styles.category}>
							{label}
						</h4>
						<ul className={styles.list} aria-labelledby={headingId}>
							{items.map((change) => (
								<li
									key={change.text}
									className={styles.item}
									data-change={type}
								>
									{change.text}
								</li>
							))}
						</ul>
					</div>
				);
			})}
		</div>
	);
};
