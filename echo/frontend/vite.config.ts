import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Babel plugin: inject __source into the props object of _jsx/_jsxs calls so
// Agentation can resolve element-to-source paths in production-mode builds.
//
// We can't put __source on the JSX itself: @babel/plugin-transform-react-jsx
// in automatic-runtime mode treats __source as reserved and strips it (or
// throws "Duplicate __source prop"). So we visit CallExpressions, which fire
// after the JSX transform replaces JSXElements with `_jsx(Foo, {…})` calls,
// and add `__source` directly onto the props object literal. Idempotent via a
// __injectedSource WeakSet so we don't re-process the same node twice.
// biome-ignore lint/suspicious/noExplicitAny: babel plugin types not worth importing here
const injectJsxSource = (babel: any) => {
	const { types: t } = babel;
	const JSX_CALLEES = new Set([
		"jsx",
		"jsxs",
		"jsxDEV",
		"_jsx",
		"_jsxs",
		"_jsxDEV",
	]);
	const seen = new WeakSet();
	return {
		name: "inject-jsx-source",
		visitor: {
			// biome-ignore lint/suspicious/noExplicitAny: see above
			CallExpression(p: any, state: any) {
				const node = p.node;
				if (seen.has(node)) return;
				const callee = node.callee;
				const name =
					callee.type === "Identifier"
						? callee.name
						: callee.type === "MemberExpression" &&
								callee.property.type === "Identifier"
							? callee.property.name
							: null;
				if (!name || !JSX_CALLEES.has(name)) return;
				const propsArg = node.arguments[1];
				if (!propsArg || propsArg.type !== "ObjectExpression") return;
				const loc = node.loc;
				if (!loc) return;
				const hasSource = propsArg.properties.some(
					// biome-ignore lint/suspicious/noExplicitAny: see above
					(prop: any) =>
						prop.type === "ObjectProperty" &&
						((prop.key.type === "Identifier" && prop.key.name === "__source") ||
							(prop.key.type === "StringLiteral" &&
								prop.key.value === "__source")),
				);
				if (hasSource) {
					seen.add(node);
					return;
				}
				const cwd = state.cwd || process.cwd();
				const filename = state.filename || "unknown";
				let rel = path.relative(cwd, filename);
				if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
					rel = filename;
				}
				rel = rel.split(path.sep).join("/");
				propsArg.properties.push(
					t.objectProperty(
						t.identifier("__source"),
						t.objectExpression([
							t.objectProperty(t.identifier("fileName"), t.stringLiteral(rel)),
							t.objectProperty(
								t.identifier("lineNumber"),
								t.numericLiteral(loc.start.line),
							),
							t.objectProperty(
								t.identifier("columnNumber"),
								t.numericLiteral(loc.start.column + 1),
							),
						]),
					),
				);
				seen.add(node);
			},
		},
	};
};

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	const isDev = mode === "development";
	const devApiProxyTarget =
		process.env.VITE_DEV_API_PROXY || "http://localhost:8000/";
	const devDirectusProxyTarget =
		process.env.VITE_DEV_DIRECTUS_PROXY || "http://directus:8055";
	// On by default in every build so no per-deploy env var is needed: whether
	// the agentation overlay actually renders is decided at runtime by
	// ENABLE_AGENTATION in src/config.ts (off in production). The cost of
	// always shipping the JSX __source metadata is a slightly larger bundle;
	// VITE_ENABLE_AGENTATION=0 is the escape hatch to build without it.
	const enableAgentation = isDev || process.env.VITE_ENABLE_AGENTATION !== "0";

	// biome-ignore lint/suspicious/noExplicitAny: babel plugin entries are heterogeneous
	const babelPlugins: any[] = ["macros", ["babel-plugin-react-compiler"]];
	// biome-ignore lint/suspicious/noExplicitAny: see above
	const babelPresets: any[] = [];

	if (enableAgentation) {
		// Take the JSX transform into Babel (instead of letting esbuild do it),
		// then inject __source into the resulting _jsx() props object. This is the
		// only path that survives esbuild's automatic-mode reserved-prop check
		// AND keeps __source on memoizedProps where Agentation can read it.
		babelPlugins.push([injectJsxSource]);
		babelPresets.push([
			"@babel/preset-react",
			{ development: false, runtime: "automatic" },
		]);
	}

	return {
		build: {
			rollupOptions: {
				output: {
					manualChunks: {
						ui: ["@mantine/core", "@mantine/hooks"],
						vendor: ["react", "react-dom", "react-router"],
					},
				},
			},
		},
		plugins: [
			react({
				babel: {
					plugins: babelPlugins,
					presets: babelPresets,
				},
			}),
			lingui(),
		],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src"),
				// reddit fix lol: https://www.reddit.com/r/reactjs/comments/1g3tsiy/trouble_with_vite_tablericons_5600_requests/
				"@tabler/icons-react": "@tabler/icons-react/dist/esm/icons/index.mjs",
			},
		},
		server: {
			proxy: {
				"/api": {
					changeOrigin: true,
					rewrite: (path) => {
						console.log("Proxying request to", path);
						return path;
					},
					target: devApiProxyTarget,
				},
				"/directus": {
					changeOrigin: true,
					rewrite: (path) => {
						const newPath = path.replace(/^\/directus/, "/");
						console.log("Proxying request to", newPath);
						return newPath;
					},
					target: devDirectusProxyTarget,
				},
			},
		},
	};
});
