import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Checkbox,
	Divider,
	Popover,
	Radio,
	Stack,
	Text,
} from "@mantine/core";
import { GearSixIcon } from "@phosphor-icons/react";
import type { MapSettings } from "../state/settings";
import type { ColorBy } from "../types";

type MapSettingsMenuProps = {
	settings: MapSettings;
	onChange: (patch: Partial<MapSettings>) => void;
	/** Idle and error claims a check may start. */
	pendingClaimCount: number;
	onFactCheckAll: () => void;
	/** False for read-only roles: no fact-check controls. */
	canFactCheck: boolean;
};

const PANEL_TOGGLES: { key: keyof MapSettings; label: () => string }[] = [
	{ key: "showExplore", label: () => t`Explore` },
	{ key: "showShowcase", label: () => t`Showcase` },
	{ key: "showSpotlight", label: () => t`Spotlight` },
	{ key: "showTree", label: () => t`Tree` },
	{ key: "showClusters", label: () => t`Clusters` },
	{ key: "showLegend", label: () => t`Legend` },
];

/** Panel visibility, colour mode, fact-check options and dark mode. */
export const MapSettingsMenu = ({
	settings,
	onChange,
	pendingClaimCount,
	onFactCheckAll,
	canFactCheck,
}: MapSettingsMenuProps) => (
	<Popover position="bottom-end" shadow="xl" width={260} withinPortal>
		<Popover.Target>
			<ActionIcon
				variant="subtle"
				size="lg"
				aria-label={t`Panel settings`}
				title={t`Panel settings`}
			>
				<GearSixIcon size={20} />
			</ActionIcon>
		</Popover.Target>
		<Popover.Dropdown>
			<Stack gap="sm">
				<Text size="sm" fw={600}>
					<Trans>Panel settings</Trans>
				</Text>

				<Stack gap="xs">
					{PANEL_TOGGLES.map(({ key, label }) => (
						<Checkbox
							key={key}
							size="sm"
							label={label()}
							checked={Boolean(settings[key])}
							onChange={(event) =>
								onChange({ [key]: event.currentTarget.checked })
							}
						/>
					))}
				</Stack>

				<Divider />

				<Radio.Group
					value={settings.colorBy}
					onChange={(value) => onChange({ colorBy: value as ColorBy })}
					label={
						<Text size="xs" className="uppercase tracking-widest">
							<Trans>Color nodes by</Trans>
						</Text>
					}
				>
					<Stack gap="xs" mt="xs">
						<Radio size="sm" value="none" label={t`None`} />
						<Radio size="sm" value="valence" label={t`Valence`} />
						<Radio size="sm" value="factCheck" label={t`Fact-check`} />
					</Stack>
				</Radio.Group>

				{settings.colorBy === "factCheck" && canFactCheck && (
					<>
						<Divider />
						<Checkbox
							size="sm"
							label={t`Auto fact-check new claims`}
							checked={settings.autoFactCheckClaims}
							onChange={(event) =>
								onChange({ autoFactCheckClaims: event.currentTarget.checked })
							}
						/>
						<Button
							size="sm"
							radius="xl"
							fullWidth
							disabled={pendingClaimCount === 0}
							onClick={onFactCheckAll}
						>
							{pendingClaimCount > 0 ? (
								<Trans>Fact check all ({pendingClaimCount})</Trans>
							) : (
								<Trans>Fact check all</Trans>
							)}
						</Button>
					</>
				)}

				<Divider />

				<Checkbox
					size="sm"
					label={t`Dark mode`}
					checked={settings.darkMode}
					onChange={(event) =>
						onChange({ darkMode: event.currentTarget.checked })
					}
				/>
			</Stack>
		</Popover.Dropdown>
	</Popover>
);
