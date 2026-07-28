import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";

import type {
	FunnelVisitor,
	MonitorConversation,
} from "@/hooks/useConversationMonitor";

// A particle funnel that scales to thousands of dots: three stage columns
// (Scanned -> Setting up -> Recording), each a bottom-packed pile like a
// gravity machine. Dots lerp toward their target slot, so a participant
// visibly flows to the next column when their stage changes. Drawing is
// batched by colour (one fill per colour per frame), so a few thousand dots
// stay smooth. Clicks hit-test to the nearest dot for the drilldown.

// Fallback hexes only kick in before the theme's CSS variables exist (SSR,
// or a stylesheet that hasn't loaded yet). Live colours are sourced from the
// Mantine theme so the funnel stays in sync with the rest of the monitor.
const FALLBACK_COLORS = {
	backgrounded: "#868e96",
	blocked: "#fa5252",
	recording: "#fa5252",
	scanned: "#adb5bd",
	setup: "#4169e1",
	stalled: "#e8590c",
};

let cachedColors: typeof FALLBACK_COLORS | null = null;

const readCssVar = (name: string, fallback: string): string => {
	if (typeof document === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
};

// Reads the Mantine theme's CSS variables once and caches the result, so we
// never touch getComputedStyle from the animation loop. Left uncached until
// `document` exists so SSR doesn't freeze the fallback hexes permanently.
const resolveColors = (): typeof FALLBACK_COLORS => {
	if (cachedColors) return cachedColors;
	if (typeof document === "undefined") return FALLBACK_COLORS;
	const colors = {
		backgrounded: readCssVar(
			"--mantine-color-gray-6",
			FALLBACK_COLORS.backgrounded,
		),
		blocked: readCssVar("--mantine-color-red-6", FALLBACK_COLORS.blocked),
		recording: readCssVar("--mantine-color-red-6", FALLBACK_COLORS.recording),
		scanned: readCssVar("--mantine-color-gray-5", FALLBACK_COLORS.scanned),
		setup: readCssVar("--mantine-color-primary-6", FALLBACK_COLORS.setup),
		stalled: readCssVar("--mantine-color-orange-7", FALLBACK_COLORS.stalled),
	};
	cachedColors = colors;
	return colors;
};

export type NodeDatum =
	| { kind: "visitor"; data: FunnelVisitor }
	| { kind: "conversation"; data: MonitorConversation };

type Particle = {
	id: string;
	kind: "visitor" | "conversation";
	col: number; // 0,1,2
	color: string;
	pulse: boolean;
	x: number;
	y: number;
	tx: number;
	ty: number;
	r: number;
	alpha: number;
	dead: boolean;
};

const columnOf = (node: NodeDatum): number => {
	if (node.kind === "conversation") return 2;
	return node.data.stage === "scanned" ? 0 : 1;
};

const colorOf = (node: NodeDatum): string => {
	const colors = resolveColors();
	if (node.kind === "conversation") {
		if (node.data.recording_health === "stalled") return colors.stalled;
		if (node.data.recording_health === "backgrounded")
			return colors.backgrounded;
		return colors.recording;
	}
	if (node.data.stage === "mic_blocked") return colors.blocked;
	if (node.data.stage === "scanned") return colors.scanned;
	return colors.setup;
};

export const FunnelCanvas = ({
	nodes,
	height = 150,
	weights = [1, 1, 1],
	onSelect,
	onHover,
}: {
	nodes: NodeDatum[];
	height?: number;
	/** Relative widths of the three columns, so empty stages shrink and the
	 * busy ones grow (e.g. only-recording -> ~25/25/50). */
	weights?: [number, number, number];
	onSelect: (node: NodeDatum) => void;
	onHover?: (node: NodeDatum | null) => void;
}) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const particles = useRef<Map<string, Particle>>(new Map());
	const nodesRef = useRef<NodeDatum[]>(nodes);
	const weightsRef = useRef<[number, number, number]>(weights);
	const sizeRef = useRef<{ w: number; h: number }>({ h: height, w: 0 });
	const lastHitTestRef = useRef(0);
	nodesRef.current = nodes;
	weightsRef.current = weights;

	// Reconcile particles from the latest nodes, then run one animation loop
	// for the component's lifetime.
	useEffect(() => {
		const canvas = canvasRef.current;
		const wrap = wrapRef.current;
		if (!canvas || !wrap) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let raf = 0;

		const resize = () => {
			const w = wrap.clientWidth;
			const h = height;
			sizeRef.current = { h, w };
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.floor(w * dpr);
			canvas.height = Math.floor(h * dpr);
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(wrap);

		const layout = () => {
			const { w, h } = sizeRef.current;
			// Weighted columns: empty stages shrink, busy ones grow.
			const wts = weightsRef.current;
			const wtTotal = wts[0] + wts[1] + wts[2] || 1;
			const colX = [
				0,
				(wts[0] / wtTotal) * w,
				((wts[0] + wts[1]) / wtTotal) * w,
			];
			const colWArr = wts.map((weight) => (weight / wtTotal) * w);
			// Group current nodes by column and assign a slot.
			const byCol: NodeDatum[][] = [[], [], []];
			for (const node of nodesRef.current) byCol[columnOf(node)].push(node);
			const live = new Set<string>();

			byCol.forEach((colNodes, col) => {
				const n = colNodes.length;
				if (n === 0) return;
				const colW = colWArr[col];
				const innerW = colW - 24;
				// Spacing that fits the pile into the column; clamped small so
				// thousands still fit, larger when there are only a few.
				const spacing = Math.max(
					5,
					Math.min(16, Math.sqrt((innerW * (h - 20)) / n)),
				);
				const perRow = Math.max(1, Math.floor(innerW / spacing));
				// Center the packed grid horizontally within the column, so a
				// single dot sits under its label instead of at the column's
				// left edge (which read as "between columns").
				const usedW = Math.min(n, perRow) * spacing;
				const x0 = colX[col] + (colW - usedW) / 2 + spacing / 2;
				// Center the pile vertically instead of piling from the bottom.
				const rows = Math.ceil(n / perRow);
				const top = Math.max(spacing / 2, (h - rows * spacing) / 2);
				const dotR = Math.max(2.5, Math.min(5, spacing * 0.4));
				colNodes.forEach((node, i) => {
					// Prefix with kind: visitors and conversations can share an
					// underlying id, and the map key must not collide between them.
					const id = `${node.kind}:${node.data.id}`;
					live.add(id);
					const row = Math.floor(i / perRow);
					const column = i % perRow;
					const tx = x0 + column * spacing;
					const ty = top + row * spacing + spacing / 2;
					const color = colorOf(node);
					let p = particles.current.get(id);
					if (!p) {
						// Spawn from the left edge of the column and glide into place.
						p = {
							alpha: 0,
							col,
							color,
							dead: false,
							id,
							kind: node.kind,
							pulse:
								node.kind === "conversation" &&
								node.data.recording_health === "receiving",
							r: dotR,
							tx,
							ty,
							x: colX[col] + 4,
							y: h / 2,
						};
						particles.current.set(id, p);
					}
					p.col = col;
					p.color = color;
					p.pulse =
						node.kind === "conversation" &&
						node.data.recording_health === "receiving";
					p.tx = tx;
					p.ty = ty;
					p.r = dotR;
					p.dead = false;
				});
			});

			// Fade out particles no longer present.
			for (const [id, p] of particles.current) {
				if (!live.has(id)) p.dead = true;
			}
		};

		// Layout only needs to rerun when its inputs actually change (a new
		// nodes/weights array from the data hook, or a resize) -- not on every
		// animation frame. `nodes`/`weights` are memoized upstream, so a
		// reference check is enough to catch real changes cheaply.
		let dirtyNodes: NodeDatum[] | null = null;
		let dirtyWeights: [number, number, number] | null = null;
		let dirtyW = -1;
		let dirtyH = -1;

		let last = 0;
		const frame = (time: number) => {
			const { w, h } = sizeRef.current;
			const currentNodes = nodesRef.current;
			const currentWeights = weightsRef.current;
			if (
				currentNodes !== dirtyNodes ||
				currentWeights !== dirtyWeights ||
				w !== dirtyW ||
				h !== dirtyH
			) {
				layout();
				dirtyNodes = currentNodes;
				dirtyWeights = currentWeights;
				dirtyW = w;
				dirtyH = h;
			}
			ctx.clearRect(0, 0, w, h);
			const dt = last ? Math.min((time - last) / 16.67, 3) : 1;
			last = time;

			// Group by colour so we can fill each colour in a single path.
			const byColor = new Map<string, Particle[]>();
			for (const [id, p] of particles.current) {
				// ease toward target
				p.x += (p.tx - p.x) * 0.18 * dt;
				p.y += (p.ty - p.y) * 0.18 * dt;
				p.alpha += ((p.dead ? 0 : 1) - p.alpha) * 0.2 * dt;
				if (p.dead && p.alpha < 0.03) {
					particles.current.delete(id);
					continue;
				}
				const bucket = byColor.get(p.color);
				if (bucket) bucket.push(p);
				else byColor.set(p.color, [p]);
			}

			const pulse = 0.5 + 0.5 * Math.sin(time / 400);
			for (const [color, group] of byColor) {
				ctx.fillStyle = color;
				for (const p of group) {
					ctx.globalAlpha = p.alpha * (p.pulse ? 0.75 + 0.25 * pulse : 1);
					const r = p.pulse ? p.r * (1 + 0.25 * pulse) : p.r;
					ctx.beginPath();
					ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);

		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
		};
	}, [height]);

	const [hover, setHover] = useState<{
		label: string;
		x: number;
		y: number;
	} | null>(null);

	const nearest = (mx: number, my: number): NodeDatum | null => {
		let best: { id: string; d: number } | null = null;
		for (const [id, p] of particles.current) {
			if (p.dead) continue;
			const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
			if (!best || d < best.d) best = { d, id };
		}
		// Generous radius so tiny dots are still easy to hit.
		if (!best || best.d > 18 * 18) return null;
		return (
			nodesRef.current.find((n) => `${n.kind}:${n.data.id}` === best?.id) ??
			null
		);
	};

	const labelFor = (node: NodeDatum): string => {
		if (node.kind === "conversation") {
			return node.data.label?.trim() || t`Recording`;
		}
		return node.data.name?.trim() || t`Anonymous`;
	};

	const mouseXY = (event: React.MouseEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};

	return (
		<div ref={wrapRef} className="relative w-full">
			<canvas
				ref={canvasRef}
				role="img"
				aria-label={t`Live participant funnel: scanned, setting up, and recording counts`}
				onClick={(event) => {
					const { x, y } = mouseXY(event);
					const node = nearest(x, y);
					if (node) onSelect(node);
				}}
				onMouseMove={(event) => {
					// Throttle the hit-test: it scans every live particle, so
					// running it on every native mousemove event is wasted work.
					const now = performance.now();
					if (now - lastHitTestRef.current < 40) return;
					lastHitTestRef.current = now;
					const { x, y } = mouseXY(event);
					const node = nearest(x, y);
					onHover?.(node);
					setHover(node ? { label: labelFor(node), x, y } : null);
				}}
				onMouseLeave={() => {
					onHover?.(null);
					setHover(null);
				}}
				className="w-full"
				style={{ cursor: hover ? "pointer" : "default", height }}
			/>
			{hover && (
				<div
					className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded bg-graphite px-2 py-1 text-xs text-parchment shadow"
					style={{ left: hover.x, top: hover.y - 6 }}
				>
					{hover.label}
				</div>
			)}
		</div>
	);
};
