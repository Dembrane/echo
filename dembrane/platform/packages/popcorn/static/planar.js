/* planar.js — certified crossing-minimal topology for the stakeholder map.
 *
 * Three pieces, no dependencies:
 *   1. checkPlanarity(nodes, edges) — Left-Right planarity test (Brandes 2009),
 *      returning a combinatorial embedding (rotation system) when planar.
 *   2. embeddingToPositions(embedding) — straight-line grid drawing of a planar
 *      embedding (Chrobak–Payne shift method, largest face as outer face).
 *   3. certifiedTopology(nodes, edges, opts) — exact crossing number by
 *      iterative deepening: cr(G) <= k iff some set of k independent edge
 *      pairs, replaced by degree-4 dummy vertices, planarizes the graph.
 *      The failed k-1 sweep is the minimality certificate.
 *
 * 1 and 2 are ports of NetworkX (BSD-3): networkx/algorithms/planarity.py and
 * planar_drawing.py, verified against networkx as an oracle in
 * tools/test-planar.mjs. Node ids are strings; ids must not contain "\x1f".
 */
(function (global) {
  "use strict";

  const SEP = "\x1f";
  const ek = (e) => e[0] + SEP + e[1];

  /* ---------- rotation system (PlanarEmbedding) ---------- */

  class Embedding {
    constructor() {
      this.succ = new Map(); // node -> Map(nbr -> {cw, ccw})
      this.leftmost = new Map(); // node -> first neighbor of the cw order
    }

    addNode(v) {
      if (!this.succ.has(v)) this.succ.set(v, new Map());
    }

    nodes() {
      return [...this.succ.keys()];
    }

    hasEdge(v, w) {
      const s = this.succ.get(v);
      return !!s && s.has(w);
    }

    // ref: {cw: node} | {ccw: node} | undefined (first edge out of v)
    addHalfEdge(v, w, ref) {
      this.addNode(v);
      this.addNode(w);
      const succs = this.succ.get(v);
      if (succs.size) {
        if (ref && ref.cw != null) {
          const c = succs.get(ref.cw);
          if (!c) throw new Error("invalid cw reference");
          const refCcw = c.ccw;
          succs.set(w, { cw: ref.cw, ccw: refCcw });
          succs.get(refCcw).cw = w;
          c.ccw = w;
          if (ref.cw === this.leftmost.get(v)) this.leftmost.set(v, w);
        } else if (ref && ref.ccw != null) {
          const c = succs.get(ref.ccw);
          if (!c) throw new Error("invalid ccw reference");
          const refCw = c.cw;
          succs.set(w, { cw: refCw, ccw: ref.ccw });
          succs.get(refCw).ccw = w;
          c.cw = w;
        } else {
          throw new Error("reference node required");
        }
      } else {
        if (ref && (ref.cw != null || ref.ccw != null))
          throw new Error("invalid reference node");
        succs.set(w, { cw: w, ccw: w });
        this.leftmost.set(v, w);
      }
    }

    // insert w as v's new leftmost neighbor
    addHalfEdgeFirst(v, w) {
      const succs = this.succ.get(v);
      if (succs && succs.size) this.addHalfEdge(v, w, { cw: this.leftmost.get(v) });
      else this.addHalfEdge(v, w);
    }

    cwNbr(v, w) {
      return this.succ.get(v).get(w).cw;
    }

    ccwNbr(v, w) {
      return this.succ.get(v).get(w).ccw;
    }

    // live walk: captures the start once, follows current cw pointers
    *neighborsCwOrder(v) {
      const succs = this.succ.get(v);
      if (!succs || !succs.size) return;
      const start = this.leftmost.get(v);
      yield start;
      let cur = succs.get(start).cw;
      while (cur !== start) {
        yield cur;
        cur = succs.get(cur).cw;
      }
    }

    nextFaceHalfEdge(v, w) {
      return [w, this.ccwNbr(w, v)];
    }

    // nodes of the face right of half-edge (v, w); marks its half-edges
    traverseFace(v, w, mark) {
      if (!mark) mark = new Set();
      const face = [v];
      mark.add(ek([v, w]));
      let prev = v;
      let cur = w;
      const incoming = this.cwNbr(v, w);
      while (cur !== v || prev !== incoming) {
        face.push(cur);
        const [p, c] = this.nextFaceHalfEdge(prev, cur);
        prev = p;
        cur = c;
        const key = ek([prev, cur]);
        if (mark.has(key)) throw new Error("bad embedding: impossible face");
        mark.add(key);
      }
      return face;
    }

    // v and w must be in different components
    connectComponents(v, w) {
      const sv = this.succ.get(v);
      if (sv && sv.size) this.addHalfEdge(v, w, { cw: this.leftmost.get(v) });
      else this.addHalfEdge(v, w);
      const sw = this.succ.get(w);
      if (sw && sw.size) this.addHalfEdge(w, v, { cw: this.leftmost.get(w) });
      else this.addHalfEdge(w, v);
    }

    copy() {
      const e = new Embedding();
      for (const [v, succs] of this.succ) {
        const m = new Map();
        for (const [w, p] of succs) m.set(w, { cw: p.cw, ccw: p.ccw });
        e.succ.set(v, m);
      }
      for (const [v, l] of this.leftmost) e.leftmost.set(v, l);
      return e;
    }

    connectedComponents() {
      const seen = new Set();
      const comps = [];
      for (const v of this.succ.keys()) {
        if (seen.has(v)) continue;
        const comp = [];
        const stack = [v];
        seen.add(v);
        while (stack.length) {
          const u = stack.pop();
          comp.push(u);
          for (const nbr of this.succ.get(u).keys())
            if (!seen.has(nbr)) {
              seen.add(nbr);
              stack.push(nbr);
            }
        }
        comps.push(comp);
      }
      return comps;
    }

    // validity check: mirrored half-edges + Euler's formula per component
    checkStructure() {
      for (const v of this.succ.keys()) {
        const walked = new Set(this.neighborsCwOrder(v));
        const stored = new Set(this.succ.get(v).keys());
        if (walked.size !== stored.size) throw new Error("orientation broken at " + v);
        for (const w of stored) {
          if (!walked.has(w)) throw new Error("orientation broken at " + v);
          if (!this.hasEdge(w, v)) throw new Error("missing opposite half-edge");
        }
      }
      const counted = new Set();
      for (const comp of this.connectedComponents()) {
        if (comp.length === 1) continue;
        let halfEdges = 0;
        let faces = 0;
        for (const v of comp)
          for (const w of this.neighborsCwOrder(v)) {
            halfEdges += 1;
            if (!counted.has(ek([v, w]))) {
              faces += 1;
              this.traverseFace(v, w, counted);
            }
          }
        const edges = halfEdges / 2;
        if (comp.length - edges + faces !== 2)
          throw new Error("embedding violates Euler's formula");
      }
    }
  }

  /* ---------- Left-Right planarity test ---------- */

  class Interval {
    constructor(low, high) {
      this.low = low === undefined ? null : low;
      this.high = high === undefined ? null : high;
    }
    empty() {
      return this.low === null && this.high === null;
    }
    copy() {
      return new Interval(this.low, this.high);
    }
  }

  class ConflictPair {
    constructor(left, right) {
      this.left = left || new Interval();
      this.right = right || new Interval();
    }
    swap() {
      const t = this.left;
      this.left = this.right;
      this.right = t;
    }
  }

  const top = (stack) => (stack.length ? stack[stack.length - 1] : null);

  function lrPlanarity(nodeIds, edgeList) {
    // simple graph: dedupe, drop self-loops
    const nodes = [...nodeIds];
    const nodeSet = new Set(nodes);
    const adj = new Map(nodes.map((v) => [v, []]));
    const edgeSet = new Set();
    let m = 0;
    for (const [u, v] of edgeList) {
      if (u === v || !nodeSet.has(u) || !nodeSet.has(v)) continue;
      const k1 = ek([u, v]);
      const k2 = ek([v, u]);
      if (edgeSet.has(k1) || edgeSet.has(k2)) continue;
      edgeSet.add(k1);
      adj.get(u).push(v);
      adj.get(v).push(u);
      m += 1;
    }
    const n = nodes.length;
    if (n > 2 && m > 3 * n - 6) return null;

    const height = new Map();
    const lowpt = new Map();
    const lowpt2 = new Map();
    const nestingDepth = new Map();
    const parentEdge = new Map(); // node -> [v, w] | undefined
    const roots = [];

    const dg = new Map(nodes.map((v) => [v, []])); // oriented DFS graph
    const dgEdges = new Set();
    const dgEdgeList = [];
    const dgAdd = (v, w) => {
      dg.get(v).push(w);
      dgEdges.add(ek([v, w]));
      dgEdgeList.push([v, w]);
    };

    /* orientation: DFS, lowpoints, nesting order (iterative) */
    const dfsOrientation = (root) => {
      const stack = [root];
      const ind = new Map();
      const skipInit = new Set();
      while (stack.length) {
        const v = stack.pop();
        const e = parentEdge.get(v) || null;
        const list = adj.get(v);
        let i = ind.get(v) || 0;
        for (; i < list.length; ) {
          const w = list[i];
          const vw = [v, w];
          const vwk = ek(vw);
          if (!skipInit.has(vwk)) {
            if (dgEdges.has(vwk) || dgEdges.has(ek([w, v]))) {
              i += 1;
              ind.set(v, i);
              continue; // already oriented
            }
            dgAdd(v, w);
            lowpt.set(vwk, height.get(v));
            lowpt2.set(vwk, height.get(v));
            if (height.get(w) === undefined) {
              // tree edge
              parentEdge.set(w, vw);
              height.set(w, height.get(v) + 1);
              stack.push(v); // revisit v after finishing w
              stack.push(w);
              skipInit.add(vwk);
              ind.set(v, i); // resume at the same edge
              break;
            } else {
              lowpt.set(vwk, height.get(w)); // back edge
            }
          }
          // nesting depth
          let nd = 2 * lowpt.get(vwk);
          if (lowpt2.get(vwk) < height.get(v)) nd += 1; // chordal
          nestingDepth.set(vwk, nd);
          // update lowpoints of parent edge
          if (e !== null) {
            const eKey = ek(e);
            if (lowpt.get(vwk) < lowpt.get(eKey)) {
              lowpt2.set(eKey, Math.min(lowpt.get(eKey), lowpt2.get(vwk)));
              lowpt.set(eKey, lowpt.get(vwk));
            } else if (lowpt.get(vwk) > lowpt.get(eKey)) {
              lowpt2.set(eKey, Math.min(lowpt2.get(eKey), lowpt.get(vwk)));
            } else {
              lowpt2.set(eKey, Math.min(lowpt2.get(eKey), lowpt2.get(vwk)));
            }
          }
          i += 1;
          ind.set(v, i);
        }
      }
    };

    for (const v of nodes) {
      if (height.get(v) === undefined) {
        height.set(v, 0);
        roots.push(v);
        dfsOrientation(v);
      }
    }

    /* testing: LR partition (iterative) */
    const orderedAdjs = new Map();
    for (const v of nodes) {
      orderedAdjs.set(
        v,
        [...dg.get(v)].sort((a, b) => nestingDepth.get(ek([v, a])) - nestingDepth.get(ek([v, b])))
      );
    }

    const S = [];
    const stackBottom = new Map();
    const lowptEdge = new Map();
    const ref = new Map(); // edge key -> edge | null
    const side = new Map(); // edge key -> 1 | -1 (default 1)
    const sideOf = (e) => (e === null ? 1 : side.has(ek(e)) ? side.get(ek(e)) : 1);
    const setSide = (e, s) => side.set(ek(e), s);
    const refOf = (e) => {
      const r = ref.get(ek(e));
      return r === undefined ? null : r;
    };

    const conflicting = (interval, b) =>
      !interval.empty() && lowpt.get(ek(interval.high)) > lowpt.get(ek(b));

    const lowest = (pair) => {
      if (pair.left.empty()) return lowpt.get(ek(pair.right.low));
      if (pair.right.empty()) return lowpt.get(ek(pair.left.low));
      return Math.min(lowpt.get(ek(pair.left.low)), lowpt.get(ek(pair.right.low)));
    };

    const addConstraints = (eiPair, e) => {
      const eiKey = ek(eiPair);
      const P = new ConflictPair();
      // merge return edges of e_i into P.right
      for (;;) {
        const Q = S.pop();
        if (!Q.left.empty()) Q.swap();
        if (!Q.left.empty()) return false; // not planar
        if (lowpt.get(ek(Q.right.low)) > lowpt.get(ek(e))) {
          if (P.right.empty()) P.right = Q.right.copy();
          else ref.set(ek(P.right.low), Q.right.high);
          P.right.low = Q.right.low;
        } else {
          ref.set(ek(Q.right.low), lowptEdge.get(ek(e)));
        }
        if (top(S) === (stackBottom.get(eiKey) ?? null)) break;
      }
      // merge conflicting return edges of e_1..e_{i-1} into P.left
      while (
        S.length &&
        (conflicting(top(S).left, eiPair) || conflicting(top(S).right, eiPair))
      ) {
        const Q = S.pop();
        if (conflicting(Q.right, eiPair)) Q.swap();
        if (conflicting(Q.right, eiPair)) return false; // not planar
        ref.set(ek(P.right.low), Q.right.high);
        if (Q.right.low !== null) P.right.low = Q.right.low;
        if (P.left.empty()) P.left = Q.left.copy();
        else ref.set(ek(P.left.low), Q.left.high);
        P.left.low = Q.left.low;
      }
      if (!(P.left.empty() && P.right.empty())) S.push(P);
      return true;
    };

    const removeBackEdges = (e) => {
      const u = e[0];
      // drop entire conflict pairs returning to parent
      while (S.length && lowest(top(S)) === height.get(u)) {
        const P = S.pop();
        if (P.left.low !== null) setSide(P.left.low, -1);
      }
      if (S.length) {
        const P = S.pop();
        while (P.left.high !== null && P.left.high[1] === u) P.left.high = refOf(P.left.high);
        if (P.left.high === null && P.left.low !== null) {
          ref.set(ek(P.left.low), P.right.low);
          setSide(P.left.low, -1);
          P.left.low = null;
        }
        while (P.right.high !== null && P.right.high[1] === u) P.right.high = refOf(P.right.high);
        if (P.right.high === null && P.right.low !== null) {
          ref.set(ek(P.right.low), P.left.low);
          setSide(P.right.low, -1);
          P.right.low = null;
        }
        S.push(P);
      }
      // side of e is the side of a highest return edge
      if (lowpt.get(ek(e)) < height.get(u)) {
        const hl = top(S).left.high;
        const hr = top(S).right.high;
        if (hl !== null && (hr === null || lowpt.get(ek(hl)) > lowpt.get(ek(hr))))
          ref.set(ek(e), hl);
        else ref.set(ek(e), hr);
      }
    };

    const dfsTesting = (root) => {
      const stack = [root];
      const ind = new Map();
      const skipInit = new Set();
      while (stack.length) {
        const v = stack.pop();
        const e = parentEdge.get(v) || null;
        const list = orderedAdjs.get(v);
        let skipFinal = false;
        let i = ind.get(v) || 0;
        for (; i < list.length; ) {
          const w = list[i];
          const eiPair = [v, w];
          const eiKey = ek(eiPair);
          if (!skipInit.has(eiKey)) {
            stackBottom.set(eiKey, top(S));
            const pe = parentEdge.get(w);
            if (pe && ek(pe) === eiKey) {
              // tree edge
              stack.push(v);
              stack.push(w);
              skipInit.add(eiKey);
              ind.set(v, i);
              skipFinal = true;
              break;
            } else {
              // back edge
              lowptEdge.set(eiKey, eiPair);
              S.push(new ConflictPair(undefined, new Interval(eiPair, eiPair)));
            }
          }
          if (lowpt.get(eiKey) < height.get(v)) {
            if (w === list[0]) {
              lowptEdge.set(ek(e), lowptEdge.get(eiKey));
            } else if (!addConstraints(eiPair, e)) {
              return false;
            }
          }
          i += 1;
          ind.set(v, i);
        }
        if (!skipFinal && e !== null) removeBackEdges(e);
      }
      return true;
    };

    for (const v of roots) if (!dfsTesting(v)) return null;

    /* resolve relative sides to absolute (iterative sign) */
    const sign = (e0) => {
      const oldRef = new Map(); // fresh per call, like the reference implementation
      const stack = [e0];
      while (stack.length) {
        const e = stack.pop();
        const eKey = ek(e);
        if (refOf(e) !== null) {
          stack.push(e);
          stack.push(refOf(e));
          oldRef.set(eKey, refOf(e));
          ref.set(eKey, null);
        } else {
          const o = oldRef.get(eKey);
          setSide(e, sideOf(e) * sideOf(o === undefined ? null : o));
        }
      }
      return sideOf(e0);
    };
    for (const e of dgEdgeList) nestingDepth.set(ek(e), sign(e) * nestingDepth.get(ek(e)));

    /* build the embedding */
    const embedding = new Embedding();
    for (const v of nodes) embedding.addNode(v);
    for (const v of nodes) {
      const sorted = [...dg.get(v)].sort(
        (a, b) => nestingDepth.get(ek([v, a])) - nestingDepth.get(ek([v, b]))
      );
      orderedAdjs.set(v, sorted);
      let prev = null;
      for (const w of sorted) {
        embedding.addHalfEdge(v, w, prev === null ? undefined : { ccw: prev });
        prev = w;
      }
    }

    const leftRef = new Map();
    const rightRef = new Map();
    const dfsEmbedding = (root) => {
      const stack = [root];
      const ind = new Map();
      while (stack.length) {
        const v = stack.pop();
        const list = orderedAdjs.get(v);
        let i = ind.get(v) || 0;
        for (; i < list.length; ) {
          const w = list[i];
          i += 1;
          ind.set(v, i);
          const eiPair = [v, w];
          const eiKey = ek(eiPair);
          const pe = parentEdge.get(w);
          if (pe && ek(pe) === eiKey) {
            // tree edge
            embedding.addHalfEdgeFirst(w, v);
            leftRef.set(v, w);
            rightRef.set(v, w);
            stack.push(v);
            stack.push(w);
            break;
          } else {
            // back edge
            if (sideOf(eiPair) === 1) {
              embedding.addHalfEdge(w, v, { ccw: rightRef.get(w) });
            } else {
              embedding.addHalfEdge(w, v, { cw: leftRef.get(w) });
              leftRef.set(w, v);
            }
          }
        }
      }
    };
    for (const v of roots) dfsEmbedding(v);

    return embedding;
  }

  function checkPlanarity(nodeIds, edgeList) {
    const embedding = lrPlanarity(nodeIds, edgeList);
    return { planar: embedding !== null, embedding };
  }

  /* ---------- planar straight-line drawing (Chrobak–Payne) ---------- */

  function makeBiConnected(embedding, startingNode, outgoingNode, edgesCounted) {
    if (edgesCounted.has(ek([startingNode, outgoingNode]))) return [];
    edgesCounted.add(ek([startingNode, outgoingNode]));
    let v1 = startingNode;
    let v2 = outgoingNode;
    const faceList = [startingNode];
    const faceSet = new Set(faceList);
    let v3 = embedding.nextFaceHalfEdge(v1, v2)[1];
    while (v2 !== startingNode || v3 !== outgoingNode) {
      if (v1 === v2) throw new Error("invalid half-edge");
      if (faceSet.has(v2)) {
        // v2 encountered twice: add an edge to ensure 2-connectedness
        embedding.addHalfEdge(v1, v3, { ccw: v2 });
        embedding.addHalfEdge(v3, v1, { cw: v2 });
        edgesCounted.add(ek([v2, v3]));
        edgesCounted.add(ek([v3, v1]));
        v2 = v1;
      } else {
        faceSet.add(v2);
        faceList.push(v2);
      }
      v1 = v2;
      const nxt = embedding.nextFaceHalfEdge(v2, v3);
      v2 = nxt[0];
      v3 = nxt[1];
      edgesCounted.add(ek([v1, v2]));
    }
    return faceList;
  }

  function triangulateFace(embedding, v1, v2) {
    let v3 = embedding.nextFaceHalfEdge(v1, v2)[1];
    let v4 = embedding.nextFaceHalfEdge(v2, v3)[1];
    if (v1 === v2 || v1 === v3) return; // component has < 3 nodes
    while (v1 !== v4) {
      if (embedding.hasEdge(v1, v3)) {
        // cannot triangulate at this position
        v1 = v2;
        v2 = v3;
        v3 = v4;
      } else {
        embedding.addHalfEdge(v1, v3, { ccw: v2 });
        embedding.addHalfEdge(v3, v1, { cw: v2 });
        v2 = v3;
        v3 = v4;
      }
      v4 = embedding.nextFaceHalfEdge(v2, v3)[1];
    }
  }

  // outerIndex selects which face is drawn as the outer one, by descending
  // face size (0 = largest, the classic choice). The embedding fixes the
  // topology but not the shape: each face turned inside-out is a different,
  // equally crossing-minimal drawing, so this is the knob worth searching.
  function triangulateEmbedding(embeddingIn, fullyTriangulate, outerIndex) {
    if (embeddingIn.nodes().length <= 1)
      return { embedding: embeddingIn, outerFace: embeddingIn.nodes() };
    const embedding = embeddingIn.copy();

    // 1. single component
    const componentNodes = embedding.connectedComponents().map((c) => c[0]);
    for (let i = 0; i < componentNodes.length - 1; i++)
      embedding.connectComponents(componentNodes[i], componentNodes[i + 1]);

    // 2. faces + 2-connectedness + outer face candidate
    let outerFace = [];
    const faceList = [];
    const edgesVisited = new Set();
    for (const v of embedding.nodes())
      for (const w of embedding.neighborsCwOrder(v)) {
        const newFace = makeBiConnected(embedding, v, w, edgesVisited);
        if (newFace.length) {
          faceList.push(newFace);
          if (newFace.length > outerFace.length) outerFace = newFace;
        }
      }
    if (outerIndex) {
      const ranked = faceList.filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
      if (ranked[outerIndex]) outerFace = ranked[outerIndex];
    }

    // 3. triangulate internal faces
    for (const face of faceList)
      if (face !== outerFace || fullyTriangulate) triangulateFace(embedding, face[0], face[1]);

    if (fullyTriangulate) {
      const v1 = outerFace[0];
      const v2 = outerFace[1];
      outerFace = [v1, v2, embedding.ccwNbr(v2, v1)];
    }
    return { embedding, outerFace };
  }

  function getCanonicalOrdering(embedding, outerFace) {
    const v1 = outerFace[0];
    const v2 = outerFace[1];
    const chords = new Map(); // node -> number of chords
    const chordsOf = (v) => chords.get(v) || 0;
    const marked = new Set();
    const readyToPick = new Set(outerFace);

    const outerCcwNbr = new Map(); // does not include v1 -> v2
    let prev = v2;
    for (let i = 2; i < outerFace.length; i++) {
      outerCcwNbr.set(prev, outerFace[i]);
      prev = outerFace[i];
    }
    outerCcwNbr.set(prev, v1);

    const outerCwNbr = new Map(); // does not include v2 -> v1
    prev = v1;
    for (let i = outerFace.length - 1; i > 0; i--) {
      outerCwNbr.set(prev, outerFace[i]);
      prev = outerFace[i];
    }

    const isOuterFaceNbr = (x, y) => {
      if (!outerCcwNbr.has(x)) return outerCwNbr.get(x) === y;
      if (!outerCwNbr.has(x)) return outerCcwNbr.get(x) === y;
      return outerCcwNbr.get(x) === y || outerCwNbr.get(x) === y;
    };
    const isOnOuterFace = (x) => !marked.has(x) && (outerCcwNbr.has(x) || x === v1);

    for (const v of outerFace)
      for (const nbr of embedding.neighborsCwOrder(v))
        if (isOnOuterFace(nbr) && !isOuterFaceNbr(v, nbr)) {
          chords.set(v, chordsOf(v) + 1);
          readyToPick.delete(v);
        }

    const n = embedding.nodes().length;
    const canonical = new Array(n).fill(null);
    canonical[0] = [v1, []];
    canonical[1] = [v2, []];
    readyToPick.delete(v1);
    readyToPick.delete(v2);

    for (let k = n - 1; k > 1; k--) {
      const v = readyToPick.values().next().value;
      readyToPick.delete(v);
      marked.add(v);

      let wp = null;
      let wq = null;
      for (const nbr of embedding.neighborsCwOrder(v)) {
        if (marked.has(nbr)) continue;
        if (isOnOuterFace(nbr)) {
          if (nbr === v1) wp = v1;
          else if (nbr === v2) wq = v2;
          else if (outerCwNbr.get(nbr) === v) wp = nbr;
          else wq = nbr;
        }
        if (wp !== null && wq !== null) break;
      }
      if (wp === null || wq === null) throw new Error("canonical ordering failed");

      const wpWq = [wp];
      let nbr = wp;
      while (nbr !== wq) {
        const nextNbr = embedding.ccwNbr(v, nbr);
        wpWq.push(nextNbr);
        outerCwNbr.set(nbr, nextNbr);
        outerCcwNbr.set(nextNbr, nbr);
        nbr = nextNbr;
      }

      if (wpWq.length === 2) {
        // chord between wp and wq disappears
        chords.set(wp, chordsOf(wp) - 1);
        if (chordsOf(wp) === 0) readyToPick.add(wp);
        chords.set(wq, chordsOf(wq) - 1);
        if (chordsOf(wq) === 0) readyToPick.add(wq);
      } else {
        const newFaceNodes = new Set(wpWq.slice(1, -1));
        for (const w of newFaceNodes) {
          readyToPick.add(w);
          for (const nb of embedding.neighborsCwOrder(w))
            if (isOnOuterFace(nb) && !isOuterFaceNbr(w, nb)) {
              chords.set(w, chordsOf(w) + 1);
              readyToPick.delete(w);
              if (!newFaceNodes.has(nb)) {
                chords.set(nb, chordsOf(nb) + 1);
                readyToPick.delete(nb);
              }
            }
        }
      }
      canonical[k] = [v, wpWq];
    }
    return canonical;
  }

  function embeddingToPositions(embeddingIn, fullyTriangulate, outerIndex) {
    const nodeList0 = embeddingIn.nodes();
    if (nodeList0.length < 4) {
      const defaults = [
        [0, 0],
        [2, 0],
        [1, 1],
      ];
      const pos = new Map();
      nodeList0.forEach((v, i) => pos.set(v, defaults[i]));
      return pos;
    }
    const { embedding, outerFace } = triangulateEmbedding(embeddingIn, !!fullyTriangulate, outerIndex);

    const leftTChild = new Map();
    const rightTChild = new Map();
    const deltaX = new Map();
    const yCoord = new Map();

    const nodeList = getCanonicalOrdering(embedding, outerFace);

    const v1 = nodeList[0][0];
    const v2 = nodeList[1][0];
    const v3 = nodeList[2][0];
    deltaX.set(v1, 0);
    yCoord.set(v1, 0);
    rightTChild.set(v1, v3);
    leftTChild.set(v1, null);
    deltaX.set(v2, 1);
    yCoord.set(v2, 0);
    rightTChild.set(v2, null);
    leftTChild.set(v2, null);
    deltaX.set(v3, 1);
    yCoord.set(v3, 1);
    rightTChild.set(v3, v2);
    leftTChild.set(v3, null);

    for (let k = 3; k < nodeList.length; k++) {
      const vk = nodeList[k][0];
      const contour = nodeList[k][1];
      const wp = contour[0];
      const wp1 = contour[1];
      const wq = contour[contour.length - 1];
      const wq1 = contour[contour.length - 2];
      const addsMultTri = contour.length > 2;

      deltaX.set(wp1, deltaX.get(wp1) + 1);
      deltaX.set(wq, deltaX.get(wq) + 1);

      let deltaXWpWq = 0;
      for (let i = 1; i < contour.length; i++) deltaXWpWq += deltaX.get(contour[i]);

      deltaX.set(vk, Math.floor((-yCoord.get(wp) + deltaXWpWq + yCoord.get(wq)) / 2));
      yCoord.set(vk, Math.floor((yCoord.get(wp) + deltaXWpWq + yCoord.get(wq)) / 2));
      deltaX.set(wq, deltaXWpWq - deltaX.get(vk));
      if (addsMultTri) deltaX.set(wp1, deltaX.get(wp1) - deltaX.get(vk));

      rightTChild.set(wp, vk);
      rightTChild.set(vk, wq);
      if (addsMultTri) {
        leftTChild.set(vk, wp1);
        rightTChild.set(wq1, null);
      } else {
        leftTChild.set(vk, null);
      }
    }

    const pos = new Map();
    pos.set(v1, [0, yCoord.get(v1)]);
    const remaining = [v1];
    const place = (parent, tree) => {
      const child = tree.get(parent);
      if (child !== null && child !== undefined) {
        pos.set(child, [pos.get(parent)[0] + deltaX.get(child), yCoord.get(child)]);
        remaining.push(child);
      }
    };
    while (remaining.length) {
      const parent = remaining.pop();
      place(parent, leftTChild);
      place(parent, rightTChild);
    }
    return pos;
  }

  // The faces of an embedding: the polygons the edges cut the plane into.
  // Returned as node-id rings, one per face, including the outer one (the
  // caller tells them apart by signed area once the drawing has coordinates).
  function facesOf(embedding) {
    const seen = new Set();
    const faces = [];
    for (const v of embedding.nodes())
      for (const w of embedding.neighborsCwOrder(v)) {
        if (seen.has(ek([v, w]))) continue;
        faces.push(embedding.traverseFace(v, w, seen));
      }
    return faces;
  }

  /* ---------- exact crossing number by iterative deepening ---------- */

  const DUMMY_PREFIX = "\x00x";
  const isDummy = (id) => typeof id === "string" && id.startsWith(DUMMY_PREFIX);

  // build the planarization for a candidate crossing set + per-edge order
  function buildPlanarization(nodeIds, edgeList, crossingSet, orders) {
    const nodes = [...nodeIds];
    const dummies = [];
    for (let c = 0; c < crossingSet.length; c++) {
      nodes.push(DUMMY_PREFIX + c);
      dummies.push(DUMMY_PREFIX + c);
    }
    const chains = edgeList.map((e, i) => {
      const cids = orders.get(i) || [];
      return [e[0], ...cids.map((c) => DUMMY_PREFIX + c), e[1]];
    });
    const segEdges = [];
    for (const chain of chains)
      for (let i = 0; i + 1 < chain.length; i++) segEdges.push([chain[i], chain[i + 1]]);
    return { nodes, segEdges, chains, dummies };
  }

  function* combinations(arr, k) {
    const idx = [];
    for (let i = 0; i < k; i++) idx.push(i);
    if (k > arr.length) return;
    for (;;) {
      yield idx.map((i) => arr[i]);
      let i = k - 1;
      while (i >= 0 && idx[i] === arr.length - k + i) i--;
      if (i < 0) return;
      idx[i] += 1;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }

  function* permutations(arr) {
    if (arr.length <= 1) {
      yield [...arr];
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) yield [arr[i], ...p];
    }
  }

  /* certifiedTopology(nodeIds, edgeList, opts)
   *   opts.kmax     — deepest crossing count to certify (default 3)
   *   opts.budgetMs — wall-clock budget; on exhaustion returns certified:false
   * Returns, when certified:
   *   { certified: true, k, crossings: [[edgeIdxA, edgeIdxB], ...],
   *     chains: per original edge an array of node ids (real + dummies),
   *     dummies: [dummyIds], nodes: planarized node list,
   *     pos: Map(id -> [gridX, gridY]) for every real + dummy node }
   */
  function certifiedTopology(nodeIds, edgeList, opts) {
    const kmax = (opts && opts.kmax) || 3;
    const budgetMs = (opts && opts.budgetMs) || 800;
    const t0 = Date.now();

    const finish = (crossingSet, orders, embedding) => {
      const { nodes, segEdges, chains, dummies } = buildPlanarization(
        nodeIds,
        edgeList,
        crossingSet,
        orders
      );
      // one drawing per candidate outer face; the caller runs its geometry
      // pass on each and keeps whichever scores best
      const variants = [];
      const want = (opts && opts.variants) || 1;
      for (let i = 0; i < want; i++) {
        try {
          const p = embeddingToPositions(embedding, false, i);
          if (p && p.size) variants.push(p);
        } catch { /* not a usable outer face: skip */ }
      }
      return {
        certified: true,
        k: crossingSet.length,
        crossings: crossingSet.map(([i, j]) => [i, j]),
        chains,
        dummies,
        nodes,
        segEdges,
        pos: variants[0],
        variants,
        faces: facesOf(embedding),
      };
    };

    // k = 0
    const base = checkPlanarity(nodeIds, edgeList);
    if (base.planar) return finish([], new Map(), base.embedding);

    // candidate crossings: unordered pairs of vertex-disjoint edges
    const pairs = [];
    for (let i = 0; i < edgeList.length; i++)
      for (let j = i + 1; j < edgeList.length; j++) {
        const a = edgeList[i];
        const b = edgeList[j];
        if (a[0] !== b[0] && a[0] !== b[1] && a[1] !== b[0] && a[1] !== b[1])
          pairs.push([i, j]);
      }

    for (let k = 1; k <= kmax; k++) {
      let tried = 0;
      for (const crossingSet of combinations(pairs, k)) {
        tried += 1;
        if ((tried & 63) === 0 && Date.now() - t0 > budgetMs)
          return { certified: false, reason: "budget", k: null };
        // same pair of edges never crosses twice in an optimal drawing
        const seen = new Set();
        let dup = false;
        for (const [i, j] of crossingSet) {
          const key = i + "," + j;
          if (seen.has(key)) {
            dup = true;
            break;
          }
          seen.add(key);
        }
        if (dup) continue;
        // which crossings sit on which edge
        const perEdge = new Map();
        crossingSet.forEach(([i, j], cid) => {
          if (!perEdge.has(i)) perEdge.set(i, []);
          if (!perEdge.has(j)) perEdge.set(j, []);
          perEdge.get(i).push(cid);
          perEdge.get(j).push(cid);
        });
        // enumerate crossing orders along multi-crossed edges
        const multi = [...perEdge.keys()].filter((e) => perEdge.get(e).length > 1);
        const orderings = multi.length
          ? multi.reduce(
              (acc, e) => {
                const next = [];
                for (const partial of acc)
                  for (const perm of permutations(perEdge.get(e)))
                    next.push([...partial, [e, perm]]);
                return next;
              },
              [[]]
            )
          : [[]];
        for (const combo of orderings) {
          const orders = new Map();
          for (const [e, cids] of perEdge) if (cids.length === 1) orders.set(e, [...cids]);
          for (const [e, perm] of combo) orders.set(e, [...perm]);
          const { nodes, segEdges } = buildPlanarization(nodeIds, edgeList, crossingSet, orders);
          const res = checkPlanarity(nodes, segEdges);
          if (res.planar) return finish(crossingSet, orders, res.embedding);
        }
      }
    }
    return { certified: false, reason: "kmax", k: null };
  }

  const API = { checkPlanarity, embeddingToPositions, certifiedTopology, facesOf, isDummy, Embedding };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.PopcornPlanar = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
