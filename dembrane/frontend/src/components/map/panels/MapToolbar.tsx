import { t } from "@lingui/core/macro";
import { ActionIcon, Slider, Tooltip } from "@mantine/core";
import {
	CirclesThreeIcon,
	DotsNineIcon,
	GearSixIcon,
	PauseIcon,
	PlayIcon,
	SquareIcon,
	SquareSplitHorizontalIcon,
	TreeStructureIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	CLUSTER_DENSITY_MAX,
	CLUSTER_DENSITY_MIN,
	type MapSettings,
} from "../state/settings";
import { mapVars } from "./shared";

export type MapView = "clusters" | "tree" | "split";

/** The maps each view draws. */
export const VIEWS: Record<
	MapView,
	Pick<MapSettings, "showClusters" | "showTree">
> = {
	clusters: { showClusters: true, showTree: false },
	split: { showClusters: true, showTree: true },
	tree: { showClusters: false, showTree: true },
};

/** The view the saved panel switches describe; the cluster map when unclear. */
export const viewOf = (settings: {
	showTree: boolean;
	showClusters: boolean;
}): MapView =>
	settings.showTree && settings.showClusters
		? "split"
		: settings.showTree
			? "tree"
			: "clusters";

// The dial is logarithmic around the default: its left half runs down to
// 1/4 of the layout's repulsion, its right half up to 16x.
const LOW = Math.log(1 / CLUSTER_DENSITY_MIN);
const HIGH = Math.log(CLUSTER_DENSITY_MAX);
export const densityToDial = (density: number) => {
	const log = Math.log(density);
	return Math.round(50 + (log < 0 ? log / LOW : log / HIGH) * 50);
};
export const dialToDensity = (dial: number) => {
	const t = (dial - 50) / 50;
	const density = Math.exp(t * (t < 0 ? LOW : HIGH));
	return Math.min(CLUSTER_DENSITY_MAX, Math.max(CLUSTER_DENSITY_MIN, density));
};

const ToolButton = ({
	label,
	onClick,
	active = false,
	children,
}: {
	label: string;
	onClick: () => void;
	active?: boolean;
	children: ReactNode;
}) => (
	<Tooltip label={label} withArrow openDelay={300}>
		<ActionIcon
			variant="subtle"
			size={30}
			radius={0}
			onClick={onClick}
			aria-label={label}
			aria-pressed={active}
			vars={() => ({
				root: {
					"--ai-bg": active ? mapVars.accentSurface : "transparent",
					"--ai-color": active ? mapVars.accentText : mapVars.text,
					"--ai-hover": mapVars.accentSurface,
					"--ai-hover-color": mapVars.text,
				},
			})}
		>
			{children}
		</ActionIcon>
	</Tooltip>
);

const Rule = () => (
	<span
		aria-hidden
		className="mx-1 h-4 w-px shrink-0"
		style={{ backgroundColor: mapVars.border }}
	/>
);

/**
 * The cluster density dial, from clumped to spread out. Its own piece, so the
 * room's map can offer it without the rest of the toolbar: it changes only the
 * drawing on this screen and asks the server for nothing.
 */
export const DensityDial = ({
	density,
	onChange,
}: {
	density: number;
	onChange: (density: number) => void;
}) => (
	<div className="flex items-center gap-1.5 px-1" title={t`Cluster density`}>
		<CirclesThreeIcon size={16} aria-hidden style={{ opacity: 0.6 }} />
		<Slider
			thumbLabel={t`Cluster density: fewer or more clusters`}
			className="w-28"
			size="xs"
			min={0}
			max={100}
			step={1}
			value={densityToDial(density)}
			onChange={(dial) => onChange(dialToDensity(dial))}
			label={null}
			color="primary"
			thumbSize={12}
		/>
		<DotsNineIcon size={16} aria-hidden style={{ opacity: 0.6 }} />
	</div>
);

/**
 * The map's one row of controls, on the map itself: physics, the cluster
 * density dial and the force settings, then side by side or one at a time,
 * and which map shows when there is one. Ported from the toolbar on
 * map-dwell-groups (5e9c98f9).
 */
export const MapToolbar = ({
	view,
	onViewChange,
	paused,
	onTogglePaused,
	settingsOpen,
	onToggleSettings,
	density,
	onDensityChange,
	className,
}: {
	view: MapView;
	onViewChange: (view: MapView) => void;
	paused: boolean;
	onTogglePaused: () => void;
	settingsOpen: boolean;
	onToggleSettings: () => void;
	density: number;
	onDensityChange: (density: number) => void;
	className?: string;
}) => {
	const split = view === "split";
	return (
		<div
			role="toolbar"
			aria-label={t`Map controls`}
			className={cn("flex items-center gap-1", className)}
			style={{ color: mapVars.text }}
		>
			<ToolButton
				label={paused ? t`Resume physics` : t`Pause physics`}
				onClick={onTogglePaused}
				active={paused}
			>
				{paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
			</ToolButton>

			<DensityDial density={density} onChange={onDensityChange} />

			<ToolButton
				label={t`Force settings`}
				onClick={onToggleSettings}
				active={settingsOpen}
			>
				<GearSixIcon size={16} />
			</ToolButton>

			<Rule />

			<ToolButton
				label={split ? t`One at a time` : t`Side by side`}
				onClick={() => onViewChange(split ? "clusters" : "split")}
				active={split}
			>
				{split ? (
					<SquareIcon size={16} />
				) : (
					<SquareSplitHorizontalIcon size={16} />
				)}
			</ToolButton>

			{!split && (
				<>
					<ToolButton
						label={t`Cluster map`}
						onClick={() => onViewChange("clusters")}
						active={view === "clusters"}
					>
						<CirclesThreeIcon size={16} />
					</ToolButton>
					<ToolButton
						label={t`Argument tree`}
						onClick={() => onViewChange("tree")}
						active={view === "tree"}
					>
						<TreeStructureIcon size={16} />
					</ToolButton>
				</>
			)}
		</div>
	);
};
