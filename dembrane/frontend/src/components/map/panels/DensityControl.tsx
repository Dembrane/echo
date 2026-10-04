import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Input, Slider, Text } from "@mantine/core";
import { type CSSProperties, useId } from "react";
import { CLUSTER_DENSITY_MAX, CLUSTER_DENSITY_MIN } from "../state/settings";

// The dial is logarithmic around the default: its left half runs down to
// 1/4 of the layout's repulsion, its right half up to 16x.
const DENSITY_LOW = Math.log(1 / CLUSTER_DENSITY_MIN);
const DENSITY_HIGH = Math.log(CLUSTER_DENSITY_MAX);
export const densityToDial = (density: number) => {
	const log = Math.log(density);
	return Math.round(
		50 + (log < 0 ? log / DENSITY_LOW : log / DENSITY_HIGH) * 50,
	);
};
export const dialToDensity = (dial: number) => {
	const t = (dial - 50) / 50;
	const density = Math.exp(t * (t < 0 ? DENSITY_LOW : DENSITY_HIGH));
	return Math.min(CLUSTER_DENSITY_MAX, Math.max(CLUSTER_DENSITY_MIN, density));
};

/**
 * The map's one main control: how clumped or spread out the clusters are. It
 * drives the cluster map and the tree alike, so it stays one control whatever
 * layout is showing. A control you set, so it is white with the control line
 * and shows its state in blue; words at the ends, no numbers. The row never
 * wraps: on a phone the track shortens and the words keep their place.
 */
export const DensityControl = ({
	density,
	onChange,
}: {
	density: number;
	onChange: (density: number) => void;
}) => {
	const labelId = useId();
	return (
		<Input.Wrapper
			label={<Trans>Cluster density</Trans>}
			labelProps={{ id: labelId }}
			className="w-full max-w-md"
			data-testid="density-control"
		>
			<Group gap="sm" wrap="nowrap" align="center">
				<Text size="sm" className="shrink-0 whitespace-nowrap">
					<Trans>Clumped</Trans>
				</Text>
				<Slider
					aria-labelledby={labelId}
					thumbLabel={t`Cluster density: fewer or more clusters`}
					className="min-w-0 flex-1"
					min={0}
					max={100}
					step={1}
					marks={[{ value: 50 }]}
					value={densityToDial(density)}
					onChange={(dial) => onChange(dialToDensity(dial))}
					label={null}
					radius={0}
					style={
						{
							// The empty track is a white control with the control line.
							"--slider-track-bg": "var(--app-surface)",
						} as CSSProperties
					}
					styles={{
						bar: { backgroundColor: "var(--app-action)" },
						mark: {
							backgroundColor: "var(--app-surface)",
							borderColor: "var(--app-control-rule)",
						},
						thumb: {
							backgroundColor: "var(--app-surface)",
							borderColor: "var(--app-action)",
						},
						track: { boxShadow: "0 0 0 1px var(--app-control-rule)" },
					}}
				/>
				<Text size="sm" className="shrink-0 whitespace-nowrap">
					<Trans>Spread out</Trans>
				</Text>
			</Group>
		</Input.Wrapper>
	);
};
