import { Tooltip } from "@mantine/core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

// Width of the collapsed sidebar: room for a 44px touch target plus a 4px
// gutter either side.
export const RAIL_WIDTH = 52;

// How long a finger rests on an icon before its name shows. Shorter than the
// ~500ms at which phones raise their own long-press menus.
const HOLD_MS = 400;
// How long the name stays up after the finger lifts, so it can be read.
const HOLD_LINGER_MS = 1500;

const RailContext = createContext(false);

export const RailProvider = ({
	inRail,
	children,
}: {
	inRail: boolean;
	children: ReactNode;
}) => <RailContext.Provider value={inRail}>{children}</RailContext.Provider>;

/** True inside the collapsed sidebar, where rows render as icons only. */
export const useInRail = () => useContext(RailContext);

/** Renders its children only in the full sidebar. For lists of things
 * (projects, workspaces, organisations) that would be a column of identical
 * icons in the rail. */
export const FullOnly = ({ children }: { children: ReactNode }) =>
	useInRail() ? null : children;

/** Visible icon-only row classes, shared by every rail item. 40px with a
 * mouse, 44px under a finger. */
export const RAIL_ITEM_CLASS =
	"relative flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-md transition-colors [-webkit-touch-callout:none] select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";

/** The item's name, beside it: on hover, on keyboard focus, and when a
 * finger holds it. A held item does not activate when the finger lifts; a
 * tap does. Escape closes the name. */
export const RailTip = ({
	label,
	children,
}: {
	label: ReactNode;
	children: ReactNode;
}) => {
	const [opened, setOpened] = useState(false);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const lingerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const held = useRef(false);
	// Phones follow a tap with emulated mouse events; without this, a tap
	// would leave the name stuck open with no mouseleave to close it.
	const lastTouch = useRef(0);

	const clearTimers = useCallback(() => {
		clearTimeout(holdTimer.current);
		clearTimeout(lingerTimer.current);
	}, []);
	useEffect(() => clearTimers, [clearTimers]);

	const onTouchStart = () => {
		clearTimers();
		lastTouch.current = Date.now();
		held.current = false;
		holdTimer.current = setTimeout(() => {
			held.current = true;
			setOpened(true);
		}, HOLD_MS);
	};
	const onTouchMove = () => {
		clearTimeout(holdTimer.current);
	};
	const onTouchEnd = () => {
		clearTimeout(holdTimer.current);
		lastTouch.current = Date.now();
		if (held.current) {
			lingerTimer.current = setTimeout(() => setOpened(false), HOLD_LINGER_MS);
		}
	};
	const onClickCapture = (e: React.MouseEvent) => {
		if (!held.current) return;
		held.current = false;
		e.preventDefault();
		e.stopPropagation();
	};

	return (
		<Tooltip
			label={label}
			opened={opened}
			position="right"
			offset={8}
			withArrow
			// The name reads over the page beside the rail, so it sits above
			// anything the page lays over itself while it loads.
			zIndex={1000}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pass-through wrapper; the link or button inside is the interactive element */}
			<span
				className="flex self-center"
				onMouseEnter={() => {
					if (Date.now() - lastTouch.current > 800) setOpened(true);
				}}
				onMouseLeave={() => setOpened(false)}
				onFocus={() => setOpened(true)}
				onBlur={() => setOpened(false)}
				onKeyDown={(e) => {
					if (e.key === "Escape") setOpened(false);
				}}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={onTouchMove}
				onClickCapture={onClickCapture}
				onContextMenu={(e) => e.preventDefault()}
			>
				{children}
			</span>
		</Tooltip>
	);
};
