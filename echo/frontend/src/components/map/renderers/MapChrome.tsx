import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Loader, Paper, Text } from "@mantine/core";
import { type CSSProperties, type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

// Chrome colours follow CSS variables a parent sets on the map root for light
// and dark; the fallbacks follow the app theme.
const MAP_TEXT = "var(--map-text, var(--app-text))";
const MAP_MUTED = "var(--map-muted, var(--mantine-color-dimmed))";
const MAP_BORDER = "var(--map-border, var(--mantine-color-default-border))";
const MAP_SURFACE = "var(--map-surface, var(--app-background))";
const MAP_SURFACE_RAISED = "var(--map-surface-raised, var(--app-background))";

const mutedStyle: CSSProperties = { color: MAP_MUTED };

/** Semi-transparent surface with a centred loading card. */
export const MapLoadingOverlay = ({
	label,
	passThrough = false,
}: {
	label: ReactNode;
	/** Let pointer events reach the map underneath. */
	passThrough?: boolean;
}) => (
	<div
		className={cn(
			"absolute inset-0 z-20 flex items-center justify-center",
			passThrough && "pointer-events-none",
		)}
		style={{
			backgroundColor: `color-mix(in srgb, ${MAP_SURFACE} 80%, transparent)`,
		}}
	>
		<div className="bg-graphite p-6 shadow-xl">
			<div className="flex items-center gap-3">
				<Loader color="primary" size={32} />
				<Text size="md" className="text-parchment">
					{label}
				</Text>
			</div>
		</div>
	</div>
);

/** Icon button pinned to a top corner of the map. */
export const MapChromeButton = ({
	label,
	onClick,
	className,
	children,
}: {
	label: string;
	onClick: () => void;
	/** Horizontal placement, e.g. "right-4" or "left-4". */
	className: string;
	children: ReactNode;
}) => (
	<div className={cn("absolute top-4 z-10", className)}>
		<ActionIcon
			variant="subtle"
			size={42}
			radius={0}
			onClick={onClick}
			title={label}
			aria-label={label}
			className="shadow-lg transition-colors"
			vars={() => ({
				root: {
					"--ai-bd": `1px solid ${MAP_BORDER}`,
					"--ai-bg": MAP_SURFACE_RAISED,
					"--ai-color": MAP_TEXT,
					"--ai-hover": MAP_SURFACE,
					"--ai-hover-color": MAP_TEXT,
				},
			})}
		>
			{children}
		</ActionIcon>
	</div>
);

/**
 * Floating parameter panel below the settings button. Fits a narrow map
 * column and scrolls inside when it is taller than the map.
 */
export const MapSettingsPanel = ({
	title,
	onReset,
	children,
}: {
	title: ReactNode;
	onReset: () => void;
	children: ReactNode;
}) => (
	<div
		data-testid="map-settings-panel"
		className="absolute right-4 top-16 z-10 max-h-[calc(100%-5rem)] w-80 max-w-[calc(100%-2rem)] overflow-y-auto"
	>
		<Paper
			shadow="xl"
			radius={0}
			p="md"
			style={{
				backgroundColor: MAP_SURFACE_RAISED,
				border: `1px solid ${MAP_BORDER}`,
				color: MAP_TEXT,
			}}
		>
			<div className="mb-4 flex items-center justify-between">
				<Text component="h3" size="md" fw={600}>
					{title}
				</Text>
				<Button size="compact-sm" variant="subtle" radius={0} onClick={onReset}>
					<Trans>Reset</Trans>
				</Button>
			</div>
			<div className="space-y-4">{children}</div>
		</Paper>
	</div>
);

/** Small divider heading inside a settings panel. */
export const MapSettingsSection = ({
	children,
	first = false,
}: {
	children: ReactNode;
	first?: boolean;
}) => (
	<p
		className={cn("border-b pb-2 text-xs", !first && "pt-2")}
		style={{ ...mutedStyle, borderColor: MAP_BORDER }}
	>
		{children}
	</p>
);

/** Labelled native range input; hands the raw string to the caller to parse. */
export const RangeSetting = ({
	label,
	description,
	min,
	max,
	step,
	value,
	onChange,
}: {
	label: ReactNode;
	description?: ReactNode;
	min: number;
	max: number;
	step: number;
	value: number;
	onChange: (value: string) => void;
}) => {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-xs font-medium">
				{label}
			</label>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				className="w-full accent-primary"
			/>
			{description && (
				<p className="mt-1 text-xs" style={mutedStyle}>
					{description}
				</p>
			)}
		</div>
	);
};
