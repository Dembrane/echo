import { ActionIcon, Tooltip } from "@mantine/core";
import { InfoIcon } from "@phosphor-icons/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { testId } from "@/lib/testUtils";

interface InfoTipProps {
	/** What the "i" is called to a screen reader, e.g. "About the preview". */
	label: string;
	/** The explanation the tip shows. */
	children: ReactNode;
	testId?: string;
}

/**
 * An "i" beside a title or a button, with an explanation that would otherwise sit on the
 * page all the time. Hovering, focusing or tapping the "i" shows it; Escape or moving away
 * hides it. The "i" is a real button with a name, and the explanation stays in the page
 * (hidden while closed) as its description, so a screen reader reads it on focus.
 *
 * The same "i" as the feature explainers beside a title: one icon, one place, one way to
 * open it.
 */
export function InfoTip({ label, children, testId: id }: InfoTipProps) {
	const [opened, setOpened] = useState(false);
	const descriptionId = useId();
	// A tap toggles the tip; a mouse already opened it on hover, so its click keeps it open.
	const pointer = useRef<string>("mouse");
	return (
		<Tooltip
			label={<span id={descriptionId}>{children}</span>}
			opened={opened}
			keepMounted
			multiline
			w={280}
			position="bottom-start"
			{...(id ? testId(`${id}-tip`) : {})}
		>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				aria-label={label}
				aria-describedby={descriptionId}
				onPointerDown={(e) => {
					pointer.current = e.pointerType;
				}}
				onMouseEnter={() => setOpened(true)}
				onMouseLeave={() => setOpened(false)}
				onFocus={() => setOpened(true)}
				onBlur={() => setOpened(false)}
				onClick={() =>
					setOpened((o) => (pointer.current === "mouse" ? true : !o))
				}
				onKeyDown={(e) => {
					if (e.key === "Escape") setOpened(false);
				}}
				{...(id ? testId(id) : {})}
			>
				<InfoIcon size={16} aria-hidden />
			</ActionIcon>
		</Tooltip>
	);
}
