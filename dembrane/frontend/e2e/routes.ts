import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Every page the app can route to, read from src/Router.tsx with the TypeScript
// AST, so a route added there shows up here without anyone listing it. A page is
// a route with an element and no children (or an index route); layouts are
// walked through. Feature-flagged spreads (`...(FLAG ? [...] : [])`) count as on.
// The leading "/:language?" (dashboard) and "/:language?/:projectId" (portal)
// are dropped from the path; the portal keeps ":projectId" in front.

export type Router = "dashboard" | "portal";
export type RouterPath = {
	router: Router;
	/** e.g. "/w/:workspaceId/projects/:projectId/home" or "/:projectId/start" */
	path: string;
	/** The page component, the innermost JSX tag of the element. */
	element: string;
	/** The element is a <Navigate>: the route only sends you elsewhere. */
	redirect: boolean;
};

const ROUTER_FILE = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/Router.tsx",
);

export function routerPaths(file = ROUTER_FILE): RouterPath[] {
	const sf = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const consts = new Map<string, ts.Expression>();
	const routers: [Router, ts.Expression][] = [];
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const d of st.declarationList.declarations) {
			if (!ts.isIdentifier(d.name) || !d.initializer) continue;
			consts.set(d.name.text, d.initializer);
			const init = d.initializer;
			if (
				ts.isCallExpression(init) &&
				init.expression.getText(sf) === "createBrowserRouter"
			)
				routers.push([
					d.name.text === "participantRouter" ? "portal" : "dashboard",
					init.arguments[0],
				]);
		}
	}

	const unwrap = (e: ts.Expression): ts.Expression => {
		while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e))
			e = e.expression;
		if (ts.isIdentifier(e) && consts.has(e.text))
			return unwrap(consts.get(e.text) as ts.Expression);
		if (ts.isConditionalExpression(e)) return unwrap(e.whenTrue);
		return e;
	};
	// The innermost tag: <Protected><BaseLayout /></Protected> is BaseLayout.
	const tagOf = (e: ts.Expression | undefined): string => {
		if (!e) return "";
		const x = unwrap(e);
		if (ts.isJsxSelfClosingElement(x)) return x.tagName.getText(sf);
		if (ts.isJsxElement(x)) {
			const kids = x.children.filter(
				(c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c),
			);
			return kids.length === 1
				? tagOf(kids[0] as ts.Expression)
				: x.openingElement.tagName.getText(sf);
		}
		return "";
	};
	const join = (a: string, b: string) =>
		`/${[a, b].join("/").split("/").filter(Boolean).join("/")}`;
	const prop = (o: ts.ObjectLiteralExpression, name: string) => {
		const p = o.properties.find(
			(p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
		);
		return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
	};

	const out: RouterPath[] = [];
	const walk = (list: ts.Expression, prefix: string, router: Router) => {
		const arr = unwrap(list);
		if (!ts.isArrayLiteralExpression(arr)) return;
		for (const el of arr.elements) {
			if (ts.isSpreadElement(el)) {
				walk(el.expression, prefix, router);
				continue;
			}
			const o = unwrap(el);
			if (!ts.isObjectLiteralExpression(o)) continue;
			const p = prop(o, "path");
			const here =
				p && ts.isStringLiteral(p) ? join(prefix, p.text) : join(prefix, "");
			const children = prop(o, "children");
			if (children) {
				walk(children, here, router);
				continue;
			}
			const element = tagOf(prop(o, "element"));
			if (!element) continue;
			out.push({
				element,
				path: here,
				redirect: element === "Navigate",
				router,
			});
		}
	};
	for (const [router, list] of routers) walk(list, "", router);

	// Drop the language segment the whole tree hangs under.
	for (const r of out)
		r.path = r.path.replace(/^\/:language\?(?=\/|$)/, "") || "/";
	return out;
}
