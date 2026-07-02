import { useEffect, useRef, useState } from "react";
import {
	SIDEBAR_WIDTH_DEFAULT,
	SIDEBAR_WIDTH_MAX,
	SIDEBAR_WIDTH_MIN,
	useSidebarState,
} from "../hooks/useSidebarState";

// Invisible 4px-wide drag handle pinned to the right edge of the
// sidebar. Drag to set width, clamped by useSidebarState. Hover state
// gives a subtle Royal Blue accent so the affordance is discoverable
// without taking visual weight.
export const ResizeHandle = () => {
	const { width, setWidth } = useSidebarState();
	const [dragging, setDragging] = useState(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(width);

	useEffect(() => {
		if (!dragging) return;
		const onMove = (e: MouseEvent) => {
			const delta = e.clientX - startXRef.current;
			setWidth(startWidthRef.current + delta);
		};
		const onUp = () => setDragging(false);
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
	}, [dragging, setWidth]);

	const onMouseDown = (e: React.MouseEvent) => {
		startXRef.current = e.clientX;
		startWidthRef.current = width;
		setDragging(true);
	};

	const onDoubleClick = () => {
		setWidth(SIDEBAR_WIDTH_DEFAULT);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			setWidth(width - 12);
		}
		if (e.key === "ArrowRight") {
			e.preventDefault();
			setWidth(width + 12);
		}
		if (e.key === "Home") {
			e.preventDefault();
			setWidth(SIDEBAR_WIDTH_MIN);
		}
		if (e.key === "End") {
			e.preventDefault();
			setWidth(SIDEBAR_WIDTH_MAX);
		}
	};

	if (width === 0) return null;

	return (
		// biome-ignore lint/a11y/useSemanticElements: Resize grip needs pointer and keyboard handlers.
		<div
			onMouseDown={onMouseDown}
			onDoubleClick={onDoubleClick}
			onKeyDown={onKeyDown}
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize sidebar"
			aria-valuemax={SIDEBAR_WIDTH_MAX}
			aria-valuemin={SIDEBAR_WIDTH_MIN}
			aria-valuenow={width}
			tabIndex={0}
			className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors"
			style={{
				backgroundColor: dragging ? "rgba(65, 105, 225, 0.5)" : "transparent",
			}}
			onMouseEnter={(e) => {
				if (!dragging) {
					(e.currentTarget as HTMLDivElement).style.backgroundColor =
						"rgba(65, 105, 225, 0.2)";
				}
			}}
			onMouseLeave={(e) => {
				if (!dragging) {
					(e.currentTarget as HTMLDivElement).style.backgroundColor =
						"transparent";
				}
			}}
		/>
	);
};
