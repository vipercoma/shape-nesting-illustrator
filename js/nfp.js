/*
 * nfp.js — True-shape No-Fit-Polygon (NFP) nesting engine
 * -------------------------------------------------------
 * Pure JavaScript, no dependencies. All coordinates are in centimetres with
 * a screen-style frame: origin = top-left of the bin, x to the right, y down.
 *
 * Algorithm overview
 *  1. Every input polygon is cleaned (duplicates / collinear points removed)
 *     and simplified (Ramer–Douglas–Peucker) so curves sampled from Bézier
 *     paths stay tractable.
 *  2. Concave polygons are decomposed into convex pieces: ear-clipping
 *     triangulation followed by Hertel–Mehlhorn merging.
 *  3. The No-Fit Polygon of a stationary polygon A and an orbiting polygon B
 *     is NFP(A,B) = A ⊕ (−B) (Minkowski sum of A and B reflected through its
 *     reference point). For convex inputs this is computed exactly with the
 *     rotating-calipers edge-merge (edges of both polygons are merged in polar
 *     angle order — the orbital sliding path of B around A). For concave
 *     inputs the NFP is the UNION of the convex NFPs of every convex piece
 *     pair; the union is kept implicitly as a list of convex pieces, which is
 *     exact (no bounding boxes, no hull approximation).
 *  4. The Inner-Fit Rectangle (IFR) gives every reference-point position that
 *     keeps B inside the bin.
 *  5. Candidate positions = IFR corners + NFP vertices + all NFP/NFP and
 *     NFP/IFR edge intersections (the vertices of the true union boundary).
 *     A candidate is feasible if it is inside the IFR and not strictly inside
 *     any convex NFP piece. Candidates are evaluated in bottom-left order
 *     (lowest y, then lowest x) and the first feasible one is taken.
 *  6. Parts are placed largest-area first; every allowed rotation is tried
 *     and the best position over all rotations is kept.
 */
(function (global) {
    'use strict';

    var EPS = 1e-9;
    var INSIDE_TOL = 1e-6; // cm — strict-interior tolerance (touching is allowed)

    /* ------------------------------------------------------------------ */
    /* Basic vector helpers                                                */
    /* ------------------------------------------------------------------ */

    function pt(x, y) { return { x: x, y: y }; }

    function cross(o, a, b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    }

    function cross2(ax, ay, bx, by) { return ax * by - ay * bx; }

    function dist2(a, b) {
        var dx = a.x - b.x, dy = a.y - b.y;
        return dx * dx + dy * dy;
    }

    function clonePolygon(poly) {
        var out = new Array(poly.length);
        for (var i = 0; i < poly.length; i++) out[i] = pt(+poly[i].x, +poly[i].y);
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* 1. Polygon utilities                                                */
    /* ------------------------------------------------------------------ */

    /** Signed area (shoelace). Positive = counter-clockwise in a math (y-up) frame. */
    function area(poly) {
        var s = 0, n = poly.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            s += (poly[j].x * poly[i].y) - (poly[i].x * poly[j].y);
        }
        return s / 2;
    }

    function isClockwise(poly) { return area(poly) < 0; }

    function reversePolygon(poly) { return poly.slice().reverse(); }

    /** Remove consecutive duplicates and collinear vertices. */
    function cleanPolygon(poly, tol) {
        tol = tol || 1e-7;
        var p = [], i;
        for (i = 0; i < poly.length; i++) {
            var q = poly[i];
            if (!isFinite(q.x) || !isFinite(q.y)) continue;
            if (p.length === 0 || dist2(p[p.length - 1], q) > tol * tol) p.push(pt(q.x, q.y));
        }
        if (p.length > 1 && dist2(p[0], p[p.length - 1]) <= tol * tol) p.pop();
        var changed = true;
        while (changed && p.length > 3) {
            changed = false;
            for (i = 0; i < p.length; i++) {
                var a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
                var len = Math.sqrt(dist2(a, c)) || 1;
                if (Math.abs(cross(a, b, c)) / len <= tol) {
                    p.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        return p;
    }

    /** Clean, and force positive (math CCW) orientation. */
    function normalizePolygon(poly) {
        var p = cleanPolygon(poly);
        if (p.length >= 3 && area(p) < 0) p.reverse();
        return p;
    }

    /** Ray-casting point-in-polygon. Points exactly on the boundary count as outside. */
    function pointInPolygon(point, poly) {
        var inside = false, n = poly.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            var a = poly[i], b = poly[j];
            if (onSegment(a, b, point, 1e-9)) return false;
            if (((a.y > point.y) !== (b.y > point.y)) &&
                (point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function onSegment(a, b, p, tol) {
        if (Math.abs(cross(a, b, p)) > tol * Math.max(1, Math.sqrt(dist2(a, b)))) return false;
        return p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol &&
               p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol;
    }

    /** Proper (crossing) intersection of segments ab and cd. */
    function segmentsCross(a, b, c, d) {
        var d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
        return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
               ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
    }

    /** Intersection point of segments ab and cd (inclusive), or null. */
    function segmentIntersection(a, b, c, d) {
        var rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
        var den = cross2(rx, ry, sx, sy);
        if (Math.abs(den) < 1e-14) return null;
        var qpx = c.x - a.x, qpy = c.y - a.y;
        var t = cross2(qpx, qpy, sx, sy) / den;
        var u = cross2(qpx, qpy, rx, ry) / den;
        if (t < -1e-10 || t > 1 + 1e-10 || u < -1e-10 || u > 1 + 1e-10) return null;
        return pt(a.x + t * rx, a.y + t * ry);
    }

    /** True when two simple polygons overlap with positive area (touching is not overlap). */
    function polygonsIntersect(A, B) {
        var ba = bounds(A), bb = bounds(B);
        if (ba.maxX <= bb.minX + EPS || bb.maxX <= ba.minX + EPS ||
            ba.maxY <= bb.minY + EPS || bb.maxY <= ba.minY + EPS) return false;
        var i, j;
        for (i = 0; i < A.length; i++) {
            var a1 = A[i], a2 = A[(i + 1) % A.length];
            for (j = 0; j < B.length; j++) {
                if (segmentsCross(a1, a2, B[j], B[(j + 1) % B.length])) return true;
            }
        }
        for (i = 0; i < A.length; i++) if (pointInPolygon(A[i], B)) return true;
        for (j = 0; j < B.length; j++) if (pointInPolygon(B[j], A)) return true;
        // Identical / fully coincident outlines: test edge midpoints & centroid.
        var cA = centroid(A);
        if (pointInPolygon(cA, B) && pointInPolygon(cA, A)) return true;
        return false;
    }

    function bounds(poly) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < poly.length; i++) {
            var p = poly[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
    }

    function centroid(poly) {
        var a = 0, cx = 0, cy = 0, n = poly.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            var f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
            a += f;
            cx += (poly[j].x + poly[i].x) * f;
            cy += (poly[j].y + poly[i].y) * f;
        }
        if (Math.abs(a) < EPS) {
            var b = bounds(poly);
            return pt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
        }
        a *= 0.5;
        return pt(cx / (6 * a), cy / (6 * a));
    }

    function translatePolygon(poly, dx, dy) {
        var out = new Array(poly.length);
        for (var i = 0; i < poly.length; i++) out[i] = pt(poly[i].x + dx, poly[i].y + dy);
        return out;
    }

    /**
     * Rotate every point around the polygon centroid by `degrees`.
     * In the y-down frame a positive angle appears CLOCKWISE on screen.
     */
    function rotatePolygon(poly, degrees) {
        var c = centroid(poly);
        var r = degrees * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
        // Snap exact right angles to avoid floating drift.
        if (degrees % 90 === 0) {
            cs = Math.round(cs);
            sn = Math.round(sn);
        }
        var out = new Array(poly.length);
        for (var i = 0; i < poly.length; i++) {
            var dx = poly[i].x - c.x, dy = poly[i].y - c.y;
            out[i] = pt(c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs);
        }
        return out;
    }

    /** Move polygon so its bounding box min corner sits at (0,0). */
    function toOrigin(poly) {
        var b = bounds(poly);
        return translatePolygon(poly, -b.minX, -b.minY);
    }

    /** Andrew's monotone chain convex hull (positive orientation). */
    function convexHull(points) {
        var p = points.map(function (q) { return pt(q.x, q.y); });
        p.sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
        if (p.length < 3) return p;
        var lower = [], upper = [], i;
        for (i = 0; i < p.length; i++) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= EPS) lower.pop();
            lower.push(p[i]);
        }
        for (i = p.length - 1; i >= 0; i--) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= EPS) upper.pop();
            upper.push(p[i]);
        }
        upper.pop();
        lower.pop();
        return lower.concat(upper);
    }

    function isConvex(poly) {
        var n = poly.length;
        if (n < 3) return false;
        for (var i = 0; i < n; i++) {
            if (cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]) < -1e-10) return false;
        }
        return true;
    }

    /** Ramer–Douglas–Peucker simplification for an open polyline. */
    function rdp(points, tol) {
        if (points.length < 3) return points.slice();
        var keep = new Array(points.length);
        keep[0] = keep[points.length - 1] = true;
        var stack = [[0, points.length - 1]];
        while (stack.length) {
            var seg = stack.pop(), s = seg[0], e = seg[1];
            var maxD = -1, idx = -1, a = points[s], b = points[e];
            var len = Math.sqrt(dist2(a, b));
            for (var i = s + 1; i < e; i++) {
                var d = len < EPS ? Math.sqrt(dist2(points[i], a)) : Math.abs(cross(a, b, points[i])) / len;
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (maxD > tol && idx > 0) {
                keep[idx] = true;
                stack.push([s, idx], [idx, e]);
            }
        }
        var out = [];
        for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
        return out;
    }

    /** Simplify a closed polygon with RDP, splitting at the two most distant vertices. */
    function simplifyPolygon(poly, tol, maxPoints) {
        var p = normalizePolygon(poly);
        if (p.length <= 4) return p;
        maxPoints = maxPoints || 60;
        var t = tol;
        var result = p;
        for (var iter = 0; iter < 12; iter++) {
            // split at vertex 0 and the vertex farthest from it
            var far = 0, best = -1;
            for (var i = 1; i < p.length; i++) {
                var d = dist2(p[0], p[i]);
                if (d > best) { best = d; far = i; }
            }
            var first = rdp(p.slice(0, far + 1), t);
            var second = rdp(p.slice(far).concat([p[0]]), t);
            var merged = first.slice(0, -1).concat(second.slice(0, -1));
            merged = normalizePolygon(merged);
            if (merged.length >= 3 && Math.abs(area(merged)) > 0.5 * Math.abs(area(p))) result = merged;
            if (result.length <= maxPoints) break;
            t *= 1.6;
        }
        return result;
    }

    /* ------------------------------------------------------------------ */
    /* Concave → convex decomposition                                       */
    /* ------------------------------------------------------------------ */

    function pointInTriangleStrict(p, a, b, c) {
        var d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
        return d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12;
    }

    function pointInTriangleInclusive(p, a, b, c) {
        var d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
        return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
    }

    /**
     * Ear-clipping triangulation of a simple, positively oriented polygon.
     * Returns an array of index triples, or null if the polygon is not simple.
     */
    function triangulate(poly) {
        var n = poly.length;
        if (n < 3) return null;
        var idx = [];
        for (var i = 0; i < n; i++) idx.push(i);
        var tris = [];
        var guard = 0;
        while (idx.length > 3 && guard++ < 10000) {
            var earFound = false;
            for (var k = 0; k < idx.length; k++) {
                var ia = idx[(k - 1 + idx.length) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
                var a = poly[ia], b = poly[ib], c = poly[ic];
                if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
                var ok = true;
                for (var m = 0; m < idx.length; m++) {
                    var im = idx[m];
                    if (im === ia || im === ib || im === ic) continue;
                    var q = poly[im];
                    // a vertex coincident with a triangle corner (pinch point) blocks the ear too
                    if (pointInTriangleStrict(q, a, b, c) ||
                        (pointInTriangleInclusive(q, a, b, c) && (dist2(q, a) < 1e-18 || dist2(q, c) < 1e-18))) {
                        ok = false;
                        break;
                    }
                }
                if (!ok) continue;
                tris.push([ia, ib, ic]);
                idx.splice(k, 1);
                earFound = true;
                break;
            }
            if (!earFound) {
                // Remove a degenerate (zero-area) vertex if any; otherwise give up.
                var removed = false;
                for (var z = 0; z < idx.length; z++) {
                    var za = poly[idx[(z - 1 + idx.length) % idx.length]], zb = poly[idx[z]], zc = poly[idx[(z + 1) % idx.length]];
                    if (Math.abs(cross(za, zb, zc)) <= 1e-12) { idx.splice(z, 1); removed = true; break; }
                }
                if (!removed) return null;
            }
        }
        if (idx.length === 3 && cross(poly[idx[0]], poly[idx[1]], poly[idx[2]]) > 1e-12) tris.push(idx.slice());
        return tris;
    }

    /**
     * Hertel–Mehlhorn: greedily remove triangulation diagonals while the merged
     * polygon remains convex. Produces at most 4x the optimal number of pieces.
     */
    function convexDecomposition(poly) {
        var p = normalizePolygon(poly);
        if (p.length < 3) return [];
        if (isConvex(p)) return [p];
        var tris = triangulate(p);
        if (!tris || tris.length === 0) return [convexHull(p)]; // non-simple input: safe fallback
        var parts = tris.map(function (t) { return t.slice(); });

        var merged = true;
        while (merged) {
            merged = false;
            outer:
            for (var i = 0; i < parts.length; i++) {
                for (var j = i + 1; j < parts.length; j++) {
                    var m = tryMerge(parts[i], parts[j], p);
                    if (m) {
                        parts[i] = m;
                        parts.splice(j, 1);
                        merged = true;
                        break outer;
                    }
                }
            }
        }
        return parts.map(function (ix) {
            return cleanPolygon(ix.map(function (k) { return pt(p[k].x, p[k].y); }));
        }).filter(function (q) { return q.length >= 3 && area(q) > EPS; });
    }

    function tryMerge(P, Q, verts) {
        for (var i = 0; i < P.length; i++) {
            var a = P[i], b = P[(i + 1) % P.length];
            for (var j = 0; j < Q.length; j++) {
                if (Q[j] === b && Q[(j + 1) % Q.length] === a) {
                    // P rotated to start at b and end at a; Q rotated to start at a and end at b
                    var pr = [], qr = [], k;
                    for (k = 0; k < P.length; k++) pr.push(P[(i + 1 + k) % P.length]);
                    for (k = 0; k < Q.length; k++) qr.push(Q[(j + 1 + k) % Q.length]);
                    var mergedIdx = pr.concat(qr.slice(1, -1));
                    var poly = mergedIdx.map(function (ix) { return verts[ix]; });
                    if (isConvex(poly)) return mergedIdx;
                    return null;
                }
            }
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 2. NFP computation                                                   */
    /* ------------------------------------------------------------------ */

    function reorderFromBottom(poly) {
        var k = 0;
        for (var i = 1; i < poly.length; i++) {
            if (poly[i].y < poly[k].y || (poly[i].y === poly[k].y && poly[i].x < poly[k].x)) k = i;
        }
        return poly.slice(k).concat(poly.slice(0, k));
    }

    /**
     * Minkowski sum of two convex, positively oriented polygons via the
     * rotating-calipers edge merge. O(n + m).
     */
    function minkowskiConvex(A, B) {
        var P = reorderFromBottom(A), Q = reorderFromBottom(B);
        var n = P.length, m = Q.length;
        P.push(P[0], P[1]);
        Q.push(Q[0], Q[1]);
        var res = [], i = 0, j = 0, guard = 0;
        while ((i < n || j < m) && guard++ < 4 * (n + m) + 8) {
            res.push(pt(P[i].x + Q[j].x, P[i].y + Q[j].y));
            var c = cross2(P[i + 1].x - P[i].x, P[i + 1].y - P[i].y, Q[j + 1].x - Q[j].x, Q[j + 1].y - Q[j].y);
            if (c >= 0 && i < n) i++;
            if (c <= 0 && j < m) j++;
        }
        return cleanPolygon(res, 1e-9);
    }

    function negatePolygon(poly) {
        return poly.map(function (q) { return pt(-q.x, -q.y); });
    }

    /**
     * Convex NFP: positions of B's reference point (its local origin) where B
     * touches but does not overlap convex A. Exactly A ⊕ (−B).
     */
    function noFitPolygonConvex(A, B) {
        return minkowskiConvex(normalizePolygon(A), normalizePolygon(negatePolygon(B)));
    }

    /**
     * General NFP (A and B may be concave).
     * Returns { pieces: [convex polygons], hull: outer convex hull }.
     * The true NFP is the union of `pieces`; a reference position t causes
     * overlap iff t is strictly inside at least one piece.
     */
    function noFitPolygon(A, B) {
        var aParts = convexDecomposition(A);
        var bParts = convexDecomposition(B).map(negatePolygon).map(normalizePolygon);
        var pieces = [];
        for (var i = 0; i < aParts.length; i++) {
            for (var j = 0; j < bParts.length; j++) {
                var s = minkowskiConvex(aParts[i], bParts[j]);
                if (s.length >= 3) pieces.push(s);
            }
        }
        var all = [];
        pieces.forEach(function (p) { all = all.concat(p); });
        return { pieces: pieces, hull: convexHull(all) };
    }

    /**
     * Inner-Fit Rectangle: the set of reference-point translations that keep
     * the polygon fully inside a binWidth × binHeight bin with origin (0,0).
     * Returns null if the polygon cannot fit.
     */
    function innerFitRectangle(polygon, binWidth, binHeight) {
        var b = bounds(polygon);
        var minX = -b.minX, minY = -b.minY;
        var maxX = binWidth - b.maxX, maxY = binHeight - b.maxY;
        if (maxX < minX - 1e-9 || maxY < minY - 1e-9) return null;
        maxX = Math.max(maxX, minX);
        maxY = Math.max(maxY, minY);
        return {
            minX: minX, minY: minY, maxX: maxX, maxY: maxY,
            polygon: [pt(minX, minY), pt(maxX, minY), pt(maxX, maxY), pt(minX, maxY)]
        };
    }

    /** Regular octagon (positive orientation) of circumradius r, used for spacing. */
    function octagon(r) {
        var o = [];
        var R = r / Math.cos(Math.PI / 8); // circumscribe so the inscribed circle has radius r
        for (var i = 0; i < 8; i++) {
            var ang = Math.PI / 8 + i * Math.PI / 4;
            o.push(pt(R * Math.cos(ang), R * Math.sin(ang)));
        }
        return o;
    }

    /** Strict interior test for a convex positively oriented polygon. */
    function strictlyInsideConvex(t, poly) {
        for (var i = 0, n = poly.length; i < n; i++) {
            var a = poly[i], b = poly[(i + 1) % n];
            var len = Math.sqrt(dist2(a, b));
            if (len < EPS) continue;
            if (cross(a, b, t) / len <= INSIDE_TOL) return false;
        }
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* 3. Nesting engine                                                   */
    /* ------------------------------------------------------------------ */

    function NestingEngine(options) {
        options = options || {};
        this.binWidth = +options.binWidth || 30;
        this.binHeight = +options.binHeight || 30;
        this.rotations = (options.rotations && options.rotations.length) ? options.rotations.map(Number) : [0, 90, 180, 270];
        this.spacing = options.spacing != null ? Math.max(0, +options.spacing) : 0.1;
        this.curveTolerance = options.curveTolerance || 0.02; // cm, RDP tolerance
        this.maxPoints = options.maxPoints || 60;
    }

    /** Prepare one shape: simplify, compute each rotation's geometry and convex pieces. */
    NestingEngine.prototype._prepare = function (shape, index) {
        var raw = clonePolygon(shape.points || []);
        var poly = simplifyPolygon(raw, this.curveTolerance, this.maxPoints);
        if (poly.length < 3) {
            var w = +shape.width || 0, h = +shape.height || 0;
            if (w <= 0 || h <= 0) return null;
            poly = [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)];
        }
        var self = this;
        var variants = [];
        var seen = {};
        this.rotations.forEach(function (rot) {
            var rp = toOrigin(rotatePolygon(poly, rot));
            rp = normalizePolygon(rp);
            var key = rp.map(function (q) { return q.x.toFixed(4) + ',' + q.y.toFixed(4); }).sort().join(';');
            if (seen[key]) return; // symmetric shape — rotation gives identical outline
            seen[key] = true;
            var parts = convexDecomposition(rp);
            variants.push({
                rotation: rot,
                polygon: rp,
                bounds: bounds(rp),
                parts: parts,
                negParts: parts.map(negatePolygon).map(normalizePolygon)
            });
        });
        return {
            id: shape.id != null ? shape.id : String(index),
            name: shape.name || ('Shape ' + (index + 1)),
            area: Math.abs(area(poly)),
            variants: variants,
            spacing: self.spacing
        };
    };

    /**
     * Find the best feasible reference position for one rotation variant
     * against the already placed parts. Returns {x, y} or null.
     */
    NestingEngine.prototype._findPosition = function (variant, placed) {
        var ifr = innerFitRectangle(variant.polygon, this.binWidth, this.binHeight);
        if (!ifr) return null;

        // Build all convex NFP pieces against every placed part.
        var pieces = [];
        for (var p = 0; p < placed.length; p++) {
            var pl = placed[p];
            for (var a = 0; a < pl.expandedParts.length; a++) {
                var A = pl.expandedParts[a];
                for (var b = 0; b < variant.negParts.length; b++) {
                    var nfp = minkowskiConvex(A, variant.negParts[b]);
                    if (nfp.length < 3) continue;
                    var bb = bounds(nfp);
                    // A piece entirely outside the IFR can neither block a candidate nor
                    // create a union-boundary vertex inside it — skip it.
                    if (bb.maxX < ifr.minX || bb.minX > ifr.maxX || bb.maxY < ifr.minY || bb.minY > ifr.maxY) continue;
                    pieces.push({ poly: nfp, bb: bb });
                }
            }
        }

        var cands = [];
        function addCand(x, y) {
            if (x < ifr.minX - 1e-7 || x > ifr.maxX + 1e-7 || y < ifr.minY - 1e-7 || y > ifr.maxY + 1e-7) return;
            cands.push(pt(Math.min(Math.max(x, ifr.minX), ifr.maxX), Math.min(Math.max(y, ifr.minY), ifr.maxY)));
        }

        // IFR corners
        ifr.polygon.forEach(function (q) { addCand(q.x, q.y); });

        if (pieces.length) {
            var edges = [];
            var i, k;
            for (i = 0; i < pieces.length; i++) {
                var poly = pieces[i].poly;
                for (k = 0; k < poly.length; k++) {
                    var e1 = poly[k], e2 = poly[(k + 1) % poly.length];
                    addCand(e1.x, e1.y);
                    edges.push({
                        a: e1, b: e2, owner: i,
                        minX: Math.min(e1.x, e2.x), maxX: Math.max(e1.x, e2.x),
                        minY: Math.min(e1.y, e2.y), maxY: Math.max(e1.y, e2.y)
                    });
                }
            }
            // NFP edges × IFR edges
            var ifrEdges = [];
            for (k = 0; k < 4; k++) ifrEdges.push([ifr.polygon[k], ifr.polygon[(k + 1) % 4]]);
            for (i = 0; i < edges.length; i++) {
                for (k = 0; k < 4; k++) {
                    var ip = segmentIntersection(edges[i].a, edges[i].b, ifrEdges[k][0], ifrEdges[k][1]);
                    if (ip) addCand(ip.x, ip.y);
                }
            }
            // NFP edges × NFP edges (sweep on x) → vertices of the union boundary
            edges.sort(function (e, f) { return e.minX - f.minX; });
            var active = [];
            for (i = 0; i < edges.length; i++) {
                var e = edges[i];
                var na = [];
                for (k = 0; k < active.length; k++) {
                    var f = active[k];
                    if (f.maxX < e.minX - 1e-9) continue;
                    na.push(f);
                    if (f.owner === e.owner) continue;
                    if (f.maxY < e.minY - 1e-9 || f.minY > e.maxY + 1e-9) continue;
                    var ix = segmentIntersection(e.a, e.b, f.a, f.b);
                    if (ix) addCand(ix.x, ix.y);
                }
                na.push(e);
                active = na;
            }
        }

        // Bottom-left ordering: lowest y first, then lowest x.
        cands.sort(function (u, v) {
            if (Math.abs(u.y - v.y) > 1e-7) return u.y - v.y;
            return u.x - v.x;
        });

        var last = null;
        for (var c = 0; c < cands.length; c++) {
            var t = cands[c];
            if (last && Math.abs(last.x - t.x) < 1e-9 && Math.abs(last.y - t.y) < 1e-9) continue;
            last = t;
            var blocked = false;
            for (var q = 0; q < pieces.length; q++) {
                var pb = pieces[q].bb;
                if (t.x <= pb.minX || t.x >= pb.maxX || t.y <= pb.minY || t.y >= pb.maxY) continue;
                if (strictlyInsideConvex(t, pieces[q].poly)) { blocked = true; break; }
            }
            if (!blocked) return { x: t.x, y: t.y };
        }
        return null;
    };

    /** Record a placed part with spacing-expanded convex pieces in bin coordinates. */
    NestingEngine.prototype._commit = function (part, variant, pos, placed, placements) {
        var self = this;
        var oct = this.spacing > 0 ? octagon(this.spacing) : null;
        var expanded = variant.parts.map(function (cp) {
            var moved = translatePolygon(cp, pos.x, pos.y);
            return oct ? minkowskiConvex(normalizePolygon(moved), oct) : normalizePolygon(moved);
        });
        var finalPoly = translatePolygon(variant.polygon, pos.x, pos.y);
        placed.push({ id: part.id, expandedParts: expanded, polygon: finalPoly });
        placements.push({
            id: part.id,
            name: part.name,
            x: +pos.x.toFixed(5),
            y: +pos.y.toFixed(5),
            rotation: variant.rotation,
            width: +variant.bounds.width.toFixed(5),
            height: +variant.bounds.height.toFixed(5),
            polygon: finalPoly
        });
        return self;
    };

    NestingEngine.prototype._placeOne = function (part, placed, placements) {
        var best = null;
        for (var v = 0; v < part.variants.length; v++) {
            var variant = part.variants[v];
            var pos = this._findPosition(variant, placed);
            if (!pos) continue;
            // score: bottom-left on the far edge of the part (y + height), then x + width
            var score = (pos.y + variant.bounds.height) * 1e3 + (pos.x + variant.bounds.width);
            if (!best || score < best.score - 1e-9) best = { variant: variant, pos: pos, score: score };
        }
        if (!best) return false;
        this._commit(part, best.variant, best.pos, placed, placements);
        return true;
    };

    NestingEngine.prototype._prepareAll = function (shapes) {
        var parts = [], invalid = [];
        for (var i = 0; i < shapes.length; i++) {
            var p = this._prepare(shapes[i], i);
            if (p && p.variants.length) parts.push(p);
            else invalid.push(shapes[i].id != null ? shapes[i].id : String(i));
        }
        parts.sort(function (a, b) { return b.area - a.area; });
        return { parts: parts, invalid: invalid };
    };

    NestingEngine.prototype._result = function (placements, unplaced, t0) {
        var used = 0;
        placements.forEach(function (pl) { used += Math.abs(area(pl.polygon)); });
        return {
            placements: placements,
            unplaced: unplaced,
            binWidth: this.binWidth,
            binHeight: this.binHeight,
            utilization: used / (this.binWidth * this.binHeight),
            timeMs: Date.now() - t0
        };
    };

    /**
     * Synchronous nesting.
     * @param shapes [{id, points:[{x,y}], width, height}]
     * @returns {placements:[{id,x,y,rotation,...}], unplaced:[id], utilization, timeMs}
     *   x, y = top-left of the ROTATED shape's bounding box inside the bin (cm).
     */
    NestingEngine.prototype.nest = function (shapes) {
        var t0 = Date.now();
        var prep = this._prepareAll(shapes || []);
        var placed = [], placements = [], unplaced = prep.invalid.slice();
        for (var i = 0; i < prep.parts.length; i++) {
            if (!this._placeOne(prep.parts[i], placed, placements)) unplaced.push(prep.parts[i].id);
        }
        return this._result(placements, unplaced, t0);
    };

    /**
     * Asynchronous nesting (yields to the UI between parts).
     * @param onProgress function(done, total, partName)
     * @returns Promise<result>
     */
    NestingEngine.prototype.nestAsync = function (shapes, onProgress) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var t0 = Date.now();
            var prep;
            try { prep = self._prepareAll(shapes || []); } catch (e) { reject(e); return; }
            var placed = [], placements = [], unplaced = prep.invalid.slice();
            var i = 0, total = prep.parts.length;
            function step() {
                try {
                    if (i >= total) {
                        if (onProgress) onProgress(total, total, '');
                        resolve(self._result(placements, unplaced, t0));
                        return;
                    }
                    var part = prep.parts[i];
                    if (onProgress) onProgress(i, total, part.name);
                    if (!self._placeOne(part, placed, placements)) unplaced.push(part.id);
                    i++;
                    setTimeout(step, 0);
                } catch (err) { reject(err); }
            }
            setTimeout(step, 0);
        });
    };

    /* Public geometry API (useful for debugging / tests) */
    NestingEngine.geometry = {
        area: area,
        isClockwise: isClockwise,
        reversePolygon: reversePolygon,
        normalizePolygon: normalizePolygon,
        cleanPolygon: cleanPolygon,
        pointInPolygon: pointInPolygon,
        polygonsIntersect: polygonsIntersect,
        bounds: bounds,
        centroid: centroid,
        rotatePolygon: rotatePolygon,
        translatePolygon: translatePolygon,
        convexHull: convexHull,
        simplifyPolygon: simplifyPolygon,
        triangulate: triangulate,
        convexDecomposition: convexDecomposition,
        minkowskiConvex: minkowskiConvex,
        noFitPolygonConvex: noFitPolygonConvex,
        noFitPolygon: noFitPolygon,
        innerFitRectangle: innerFitRectangle
    };

    global.NestingEngine = NestingEngine;
    if (typeof module !== 'undefined' && module.exports) module.exports = NestingEngine;
})(typeof window !== 'undefined' ? window : this);
