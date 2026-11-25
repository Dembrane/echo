import { ActionIcon, Box, Group, Popover } from "@mantine/core";
import { Info } from "@phosphor-icons/react";
import {
	type LazyExoticComponent,
	lazy,
	type ReactElement,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import { testId } from "@/lib/testUtils";

// Each loop is its own chunk, loaded the first time someone hovers its title.
const loops = {
	anonymise: () => import("./anonymise").then((m) => m.anonymise),
	chat: () => import("./chat").then((m) => m.chat),
	explore: () => import("./explore").then((m) => m.explore),
	map: () => import("./map").then((m) => m.map),
	popcorn: () => import("./popcorn").then((m) => m.popcorn),
	report: () => import("./report").then((m) => m.report),
	verify: () => import("./verify").then((m) => m.verify),
};
type Name = keyof typeof loops;
const players = Object.fromEntries(
	Object.entries(loops).map(([name, load]) => [
		name,
		lazy(async () => {
			const [{ Player }, loop] = await Promise.all([import("./kit"), load()]);
			return { default: () => <Player loop={loop} /> };
		}),
	]),
) as Record<Name, LazyExoticComponent<() => ReactElement>>;

export type ExplainerName = Name;

// A short delay so passing the mouse over a title does not flash the loop open.
const OPEN_MS = 150;
const CLOSE_MS = 200;

/**
 * A feature's title with an "i" beside it. Hovering the title or the "i" plays a short loop of
 * what the feature does, to the right of the title; a tap or the keyboard opens it too.
 */
export function Explainer({
	name,
	label,
	children,
	inline,
}: {
	name: ExplainerName;
	/** What the "i" says to a screen reader, e.g. "How Verify works". */
	label: string;
	children: ReactNode;
	/** The title is running text that can wrap: the "i" follows its last word, in the line. */
	inline?: boolean;
}) {
	const [opened, setOpened] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const later = (next: boolean) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(
			() => setOpened(next),
			next ? OPEN_MS : CLOSE_MS,
		);
	};
	useEffect(() => () => clearTimeout(timer.current), []);
	const Player = players[name];
	const target = (
		<Popover.Target>
			<ActionIcon
				variant="subtle"
				color="gray"
				aria-label={label}
				// Back on where the title is not pressable (a stepper row draws its
				// title non-interactive, so only the "i" plays the loop).
				className="pointer-events-auto"
				style={
					inline
						? {
								display: "inline-flex",
								marginInlineStart: 4,
								verticalAlign: "middle",
							}
						: undefined
				}
				onFocus={() => setOpened(true)}
				onBlur={() => setOpened(false)}
				onClick={() => setOpened((o) => !o)}
				{...testId(`explainer-${name}`)}
			>
				<Info size={20} />
			</ActionIcon>
		</Popover.Target>
	);
	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			position="right"
			shadow="md"
			withArrow
		>
			{inline ? (
				<Box
					component="span"
					onMouseEnter={() => later(true)}
					onMouseLeave={() => later(false)}
				>
					{children}
					{target}
				</Box>
			) : (
				<Group
					gap={4}
					wrap="nowrap"
					onMouseEnter={() => later(true)}
					onMouseLeave={() => later(false)}
				>
					{children}
					{target}
				</Group>
			)}
			<Popover.Dropdown
				p="sm"
				w={380}
				onMouseEnter={() => later(true)}
				onMouseLeave={() => later(false)}
			>
				{opened && (
					<Suspense fallback={<div style={{ aspectRatio: "360 / 176" }} />}>
						<Player />
					</Suspense>
				)}
			</Popover.Dropdown>
		</Popover>
	);
}
