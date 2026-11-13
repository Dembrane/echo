import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Checkbox, Group, Stack, Text } from "@mantine/core";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { fieldLabel, ValueText } from "@/components/common/settingChange";
import { testId } from "@/lib/testUtils";
import type { ProposedSetting } from "../setupSuggestions";

/** The tutorial slugs in the words the portal editor uses. */
const display = (field: string, value: boolean | string): boolean | string => {
	if (
		field !== "default_conversation_tutorial_slug" ||
		typeof value !== "string"
	)
		return value;
	const slug = value.toLowerCase();
	return slug === "advanced"
		? t`Advanced tutorial`
		: slug === "basic"
			? t`Basic tutorial`
			: t`No tutorial`;
};

interface SuggestedSettingsProps {
	settings: readonly ProposedSetting[];
	/** Ticked settings are sent with the create, over the template. */
	checked: Readonly<Record<string, boolean>>;
	onToggle: (field: string, checked: boolean) => void;
}

/**
 * Settings worth changing on top of the chosen template, each with the reason taken from
 * what the host wrote and the template's value next to the proposed one, marked the way
 * the assistant's proposal card marks them. Unticked until the host ticks one.
 */
export const SuggestedSettings = ({
	settings,
	checked,
	onToggle,
}: SuggestedSettingsProps) => (
	<Stack gap="sm" {...testId("setup-suggestions-settings")}>
		<Stack gap="xs">
			<Text size="sm" component="h4" m={0}>
				<Trans>Settings to change</Trans>
			</Text>
			<Text size="xs" c="dimmed">
				<Trans>
					Tick the ones you want. The rest stay as the template sets them.
				</Trans>
			</Text>
		</Stack>
		{settings.map((s) => (
			<Stack key={s.field} gap="xs">
				<Checkbox
					size="sm"
					checked={Boolean(checked[s.field])}
					onChange={(event) => onToggle(s.field, event.currentTarget.checked)}
					label={<Text size="sm">{fieldLabel(s.field)}</Text>}
					{...testId(`setup-suggestions-setting-${s.field}`)}
				/>
				<Stack gap="xs" className="pl-7">
					<Text size="sm">{s.reason}</Text>
					<Group
						gap="xs"
						wrap="wrap"
						role="group"
						aria-label={t`From the template to the suggestion`}
					>
						<ValueText value={display(s.field, s.current)} kind="old" />
						<ArrowRightIcon size={16} aria-hidden />
						<ValueText value={display(s.field, s.proposed)} kind="new" />
					</Group>
				</Stack>
			</Stack>
		))}
	</Stack>
);
