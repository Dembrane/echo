import { useEffect, useRef } from "react";

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

const COLORS = {
	scanned: "#adb5bd",
	setup: "#4c6ef5",
	blocked: "#fa5252",
	recording: "#fa5252",
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
	if (node.kind === "conversation") return COLORS.recording;
	if (node.data.stage === "mic_blocked") return COLORS.blocked;
	if (node.data.stage === "scanned") return COLORS.scanned;
	return COLORS.setup;
};

export const FunnelCanvas = ({
	nodes,
	height = 150,
	onSelect,
	onHover,
}: {
	nodes: NodeDatum[];
	height?: number;
	onSelect: (node: NodeDatum) => void;
	onHover?: (node: NodeDatum | null) => void;
}) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const particles = useRef<Map<string, Particle>>(new Map());
	const nodesRef = useRef<NodeDatum[]>(nodes);
	const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: height });
	nodesRef.current = nodes;

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
			sizeRef.current = { w, h };
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
			const colW = w / 3;
			// Group current nodes by column and assign a bottom-packed slot.
			const byCol: NodeDatum[][] = [[], [], []];
			for (const node of nodesRef.current) byCol[columnOf(node)].push(node);
			const live = new Set<string>();

			byCol.forEach((colNodes, col) => {
				const n = colNodes.length;
				if (n === 0) return;
				const innerW = colW - 24;
				// Spacing that fits the pile into the column; clamped small so
				// thousands still fit, larger when there are only a few.
				const spacing = Math.max(
					5,
					Math.min(16, Math.sqrt((innerW * (h - 20)) / n)),
				);
				const perRow = Math.max(1, Math.floor(innerW / spacing));
				const x0 = col * colW + 12 + spacing / 2;
				colNodes.forEach((node, i) => {
					const id = node.data.id;
					live.add(id);
					const row = Math.floor(i / perRow);
					const column = i % perRow;
					const tx = x0 + column * spacing;
					const ty = h - 8 - (row * spacing + spacing / 2);
					const color = colorOf(node);
					let p = particles.current.get(id);
					if (!p) {
						// Spawn from the left edge of the column and rise into place.
						p = {
							alpha: 0,
							col,
							color,
							dead: false,
							id,
							kind: node.kind,
							pulse: node.kind === "conversation",
							r: Math.max(1.5, Math.min(4, spacing * 0.34)),
							tx,
							ty,
							x: col * colW + 4,
							y: h - 8,
						};
						particles.current.set(id, p);
					}
					p.col = col;
					p.color = color;
					p.pulse = node.kind === "conversation";
					p.tx = tx;
					p.ty = ty;
					p.r = Math.max(1.5, Math.min(4, spacing * 0.34));
					p.dead = false;
				});
			});

			// Fade out particles no longer present.
			for (const [id, p] of particles.current) {
				if (!live.has(id)) p.dead = true;
			}
		};

		let last = 0;
		const frame = (time: number) => {
			layout();
			const { w, h } = sizeRef.current;
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

	const nearest = (
		event: React.MouseEvent<HTMLCanvasElement>,
	): NodeDatum | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		let best: { id: string; d: number } | null = null;
		for (const [id, p] of particles.current) {
			if (p.dead) continue;
			const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
			if (!best || d < best.d) best = { d, id };
		}
		if (!best || best.d > 14 * 14) return null;
		return nodesRef.current.find((n) => n.data.id === best?.id) ?? null;
	};

	return (
		<div ref={wrapRef} className="w-full">
			<canvas
				ref={canvasRef}
				onClick={(event) => {
					const node = nearest(event);
					if (node) onSelect(node);
				}}
				onMouseMove={
					onHover ? (event) => onHover(nearest(event)) : undefined
				}
				onMouseLeave={onHover ? () => onHover(null) : undefined}
				className="w-full cursor-pointer"
				style={{ height }}
			/>
		</div>
	);
};
