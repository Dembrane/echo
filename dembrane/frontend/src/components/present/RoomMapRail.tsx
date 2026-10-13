import { t } from "@lingui/core/macro";
import { ActionIcon, type FloatingPosition, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	CirclesThreeIcon,
	GearSixIcon,
	TreeStructureIcon,
} from "@phosphor-icons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";
import {
	type MapSettingsControl,
	MapSettingsMenu,
} from "@/components/map/panels/MapSettingsMenu";
import {
	DensityDial,
	type MapView,
	VIEWS,
	viewOf,
} from "@/components/map/panels/MapToolbar";
import { mapVars } from "@/components/map/panels/shared";
import type { MapSettings } from "@/components/map/state/settings";
import type { ColorBy } from "@/components/map/types";

type RailButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
	label: string;
	tooltipPosition: FloatingPosition;
	/** For a choice: whether it is the one in effect. */
	active?: boolean;
	children: ReactNode;
};

/**
 * A square white control with one 20px icon. It takes a ref and passes the
 * rest of its props to the button, so a menu can open from it. The colours
 * are the ones the room relights: white on a light room, the raised surface
 * on a dark one, and the map's blue for the choice in effect.
 */
const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(
	({ label, tooltipPosition, active, children, ...rest }, ref) => (
		<Tooltip label={label} position={tooltipPosition} openDelay={300}>
			<ActionIcon
				ref={ref}
				{...rest}
				variant="default"
				aria-label={label}
				aria-pressed={active}
				vars={() => ({
					root: {
						"--ai-bd": `1px solid ${active ? mapVars.accentText : "var(--app-control-rule)"}`,
						"--ai-bg": active
							? mapVars.accentSurface
							: "var(--mantine-color-default)",
						"--ai-color": active ? mapVars.accentText : mapVars.text,
						"--ai-hover": active
							? mapVars.accentSurface
							: "var(--mantine-color-default-hover)",
						"--ai-hover-color": active ? mapVars.accentText : mapVars.text,
					},
				})}
			>
				{children}
			</ActionIcon>
		</Tooltip>
	),
);
RailButton.displayName = "RailButton";

const ROOM_VIEWS: { view: Exclude<MapView, "split">; icon: ReactNode }[] = [
	{ icon: <CirclesThreeIcon size={20} />, view: "clusters" },
	{ icon: <TreeStructureIcon size={20} />, view: "tree" },
];

const viewLabel = (view: Exclude<MapView, "split">) =>
	view === "clusters" ? t`Cluster map` : t`Argument tree`;

/**
 * The room map's controls, in a rail on the map's right that runs its full
 * height: the clumpiness dial, clusters or tree, then the settings, which
 * hold the colours and the panels. Below 640px the rail becomes one row under
 * the map and its tooltips and menu open upwards.
 */
export const RoomMapRail = ({
	settings,
	menuSettings,
	onSettingsChange,
	onColorByChange,
	hide,
	count,
}: {
	/** The room's own settings: the density and the view live here. */
	settings: MapSettings;
	/** The settings as the menu shows them (the room's dark, no forces). */
	menuSettings: MapSettings;
	onSettingsChange: (patch: Partial<MapSettings>) => void;
	onColorByChange: (colorBy: ColorBy) => void;
	hide: ReadonlyArray<MapSettingsControl>;
	/** How much the map holds, for the menu's heading. */
	count: ReactNode;
}) => {
	const narrow = useMediaQuery("(max-width: 639px)") ?? false;
	const tooltipPosition: FloatingPosition = narrow ? "top" : "left";
	const view = viewOf(settings);
	return (
		<fieldset
			aria-label={t`Map display`}
			className="flex shrink-0 flex-row items-center justify-end gap-2 pt-2 sm:flex-col sm:items-center sm:justify-start sm:pl-2"
			style={{ color: mapVars.text }}
		>
			<DensityDial
				orientation={narrow ? "horizontal" : "vertical"}
				density={settings.clusterDensity}
				onChange={(clusterDensity) => onSettingsChange({ clusterDensity })}
			/>
			{ROOM_VIEWS.map(({ view: option, icon }) => (
				<RailButton
					key={option}
					label={viewLabel(option)}
					tooltipPosition={tooltipPosition}
					active={view === option}
					onClick={() => onSettingsChange(VIEWS[option])}
				>
					{icon}
				</RailButton>
			))}
			<MapSettingsMenu
				settings={menuSettings}
				onChange={onSettingsChange}
				colorBy={settings.colorBy}
				onColorByChange={onColorByChange}
				canFactCheck={false}
				hide={hide}
				withinPortal={false}
				position={narrow ? "top-end" : "left-start"}
				description={count}
				trigger={
					<RailButton label={t`Settings`} tooltipPosition={tooltipPosition}>
						<GearSixIcon size={20} />
					</RailButton>
				}
			/>
		</fieldset>
	);
};
