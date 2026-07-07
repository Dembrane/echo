import type {
	CanvasDetail,
	CanvasGeneration,
	CanvasGenerationStatus,
	CanvasListItem,
} from "./hooks";

const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60 * 1000).toISOString();

const wallHtml = `
<section class="canvas-section">
	<div class="canvas-stack">
		<span class="canvas-eyebrow">Live panel wall</span>
		<h1 class="canvas-title">Mobility themes are converging around safer routes and clearer bus access.</h1>
		<p class="canvas-body canvas-muted">Sample data for the fixture canvas. The layout stays stable while each refresh updates the content.</p>
	</div>
	<div class="canvas-grid">
		<article class="canvas-card canvas-card-accent canvas-stack">
			<span class="canvas-pill canvas-pill-blue">Most active</span>
			<h2 class="canvas-subheading">Safer crossings near schools</h2>
			<p class="canvas-body">Parents and older residents keep pointing to the same three junctions.</p>
		</article>
		<article class="canvas-card canvas-stack">
			<span class="canvas-pill canvas-pill-green">Growing</span>
			<h2 class="canvas-subheading">Bus route 12</h2>
			<p class="canvas-body">Several tables want a direct line to the station after 18:00.</p>
		</article>
		<article class="canvas-card canvas-stack">
			<span class="canvas-pill canvas-pill-amber">Watch</span>
			<h2 class="canvas-subheading">Bike parking</h2>
			<p class="canvas-body">The concern is less capacity and more lighting around the racks.</p>
		</article>
	</div>
	<div class="canvas-grid-2">
		<article class="canvas-card canvas-stack">
			<h2 class="canvas-heading">Theme mentions</h2>
			<div id="theme-bars" class="canvas-chart"></div>
		</article>
		<article class="canvas-card canvas-stack">
			<p class="canvas-metric">48</p>
			<p class="canvas-caption">voices heard across the fixture tables</p>
			<div class="canvas-divider"></div>
			<blockquote class="canvas-quote">"Make it simple to cross safely before we ask people to bike more."</blockquote>
		</article>
	</div>
</section>
<script>
(() => {
	const data = [
		{ label: "Crossings", value: 18 },
		{ label: "Bus route 12", value: 13 },
		{ label: "Bike parking", value: 9 },
		{ label: "Traffic speed", value: 8 }
	];
	const root = d3.select("#theme-bars");
	const width = 560;
	const height = 250;
	const margin = { top: 12, right: 18, bottom: 36, left: 112 };
	const svg = root.append("svg").attr("viewBox", [0, 0, width, height]).attr("role", "img");
	const x = d3.scaleLinear().domain([0, d3.max(data, d => d.value)]).range([margin.left, width - margin.right]);
	const y = d3.scaleBand().domain(data.map(d => d.label)).range([margin.top, height - margin.bottom]).padding(0.28);
	svg.append("g").selectAll("rect").data(data).join("rect")
		.attr("x", margin.left)
		.attr("y", d => y(d.label))
		.attr("width", d => x(d.value) - margin.left)
		.attr("height", y.bandwidth())
		.attr("rx", 8)
		.attr("fill", "#4169e1");
	svg.append("g").selectAll("text.label").data(data).join("text")
		.attr("x", 0)
		.attr("y", d => y(d.label) + y.bandwidth() / 2)
		.attr("dy", "0.35em")
		.attr("fill", "#2d2d2c")
		.attr("font-size", 16)
		.text(d => d.label);
	svg.append("g").selectAll("text.value").data(data).join("text")
		.attr("x", d => x(d.value) + 8)
		.attr("y", d => y(d.label) + y.bandwidth() / 2)
		.attr("dy", "0.35em")
		.attr("fill", "#2d2d2c")
		.attr("font-size", 16)
		.attr("font-weight", 700)
		.text(d => d.value);
})();
</script>`;

const noOpHtml = `
<section class="canvas-section">
	<article class="canvas-card canvas-stack canvas-center">
		<span class="canvas-pill">No new recordings</span>
		<h1 class="canvas-heading">The wall is unchanged for this run.</h1>
		<p class="canvas-body canvas-muted">The assistant checked the latest window and kept the previous version because there was no meaningful change.</p>
	</article>
</section>`;

export const fixtureCanvasGenerations: CanvasGeneration[] = [
	{
		config_revision_id: "fixture-revision-2",
		content_html: wallHtml,
		created_at: minutesAgo(4),
		id: "fixture-generation-live",
		report_id: "fixture-canvas",
		status: "ok" satisfies CanvasGenerationStatus,
		tick_kind: "scheduled",
	},
	{
		config_revision_id: "fixture-revision-2",
		content_html: noOpHtml,
		created_at: minutesAgo(11),
		id: "fixture-generation-no-op",
		report_id: "fixture-canvas",
		status: "no_op" satisfies CanvasGenerationStatus,
		tick_kind: "scheduled",
	},
	{
		config_revision_id: "fixture-revision-1",
		content_html: "",
		created_at: minutesAgo(18),
		id: "fixture-generation-error",
		report_id: "fixture-canvas",
		status: "error" satisfies CanvasGenerationStatus,
		tick_kind: "manual",
	},
];

export const createFixtureCanvas = (canvasId: string): CanvasDetail => ({
	id: canvasId,
	kind: "canvas",
	latest_generation: fixtureCanvasGenerations[0],
	loop: {
		cadence_minutes: 5,
		expires_at: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
		status: "active",
	},
	name: "Live panel wall",
	project_id: "fixture-project",
});

export const createFixtureProjectCanvases = (
	projectId: string,
): CanvasListItem[] => [
	{
		created_at: minutesAgo(72),
		id: "33333333-3333-3333-3333-333333333333",
		kind: "canvas",
		latest_generation_at: fixtureCanvasGenerations[0].created_at,
		loop: {
			cadence_minutes: 5,
			expires_at: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
			status: "active",
		},
		name: "Live panel wall",
		project_id: projectId,
	},
	{
		created_at: minutesAgo(180),
		id: "44444444-4444-4444-4444-444444444444",
		kind: "canvas",
		latest_generation_at: minutesAgo(35),
		loop: {
			cadence_minutes: 10,
			expires_at: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
			status: "paused",
		},
		name: "Questions to revisit",
		project_id: projectId,
	},
];
