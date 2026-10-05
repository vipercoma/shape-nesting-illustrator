/*
 * hostscript.jsx — True-Shape Nesting, Illustrator side (ExtendScript / ES3)
 *
 * Coordinate contract with the panel:
 *   - Units: centimetres (1 pt = 0.0352778 cm).
 *   - Origin: top-left corner of the ACTIVE artboard, x to the right, y DOWN.
 *   - Shape outlines are sent as flattened polygons (Bézier segments sampled).
 *   - Placements {id, x, y, rotation}: x/y = top-left of the rotated shape's
 *     geometric bounds; rotation = clockwise degrees as seen on screen.
 */

var TN_PT_TO_CM = 0.0352778;
var TN_CM_TO_PT = 1 / TN_PT_TO_CM;
var TN_TAG_NAME = "truenest_id";
var TN_CURVE_STEPS = 12;

/* ---------------------------------------------------------------- */
/* Minimal JSON (older ExtendScript engines have no JSON object)     */
/* ---------------------------------------------------------------- */

function tnQuote(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i), code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === '\\') out += '\\\\';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (code < 32 || code > 126) {
            var h = code.toString(16);
            while (h.length < 4) h = "0" + h;
            out += "\\u" + h;
        } else out += c;
    }
    return out + '"';
}

function tnStringify(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return tnQuote(v);
    var parts = [], i, k;
    if (v instanceof Array) {
        for (i = 0; i < v.length; i++) parts.push(tnStringify(v[i]));
        return "[" + parts.join(",") + "]";
    }
    for (k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(tnQuote(k) + ":" + tnStringify(v[k]));
    }
    return "{" + parts.join(",") + "}";
}

function tnParse(str) {
    if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(str);
    return eval("(" + str + ")");
}

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

function tnArtboardRect(doc) {
    var idx = doc.artboards.getActiveArtboardIndex();
    return doc.artboards[idx].artboardRect; // [left, top, right, bottom] document coords, y up
}

function tnToCm(p, ab) {
    // Illustrator point (y up) -> cm relative to artboard top-left (y down)
    return { x: (p[0] - ab[0]) * TN_PT_TO_CM, y: (ab[1] - p[1]) * TN_PT_TO_CM };
}

function tnSamePt(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/** Flatten a PathItem's Bézier outline into a polygon of [x,y] points (document pt). */
function tnFlattenPath(path) {
    var pts = path.pathPoints, n = pts.length, out = [];
    if (n === 0) return out;
    var segs = path.closed ? n : n - 1;
    out.push([pts[0].anchor[0], pts[0].anchor[1]]);
    for (var i = 0; i < segs; i++) {
        var p0 = pts[i].anchor, p1 = pts[i].rightDirection;
        var nxt = pts[(i + 1) % n];
        var p2 = nxt.leftDirection, p3 = nxt.anchor;
        if (tnSamePt(p0, p1) && tnSamePt(p2, p3)) {
            out.push([p3[0], p3[1]]);
        } else {
            for (var s = 1; s <= TN_CURVE_STEPS; s++) {
                var t = s / TN_CURVE_STEPS, mt = 1 - t;
                var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
                out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                          a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
            }
        }
    }
    if (out.length > 1 && tnSamePt(out[0], out[out.length - 1])) out.pop();
    return out;
}

function tnPolyArea(poly) {
    var s = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    }
    return Math.abs(s / 2);
}

/** Raw Bézier point data (cm) for a path — anchor / leftDirection / rightDirection. */
function tnRawPoints(path, ab) {
    var res = [], pts = path.pathPoints;
    for (var i = 0; i < pts.length; i++) {
        res.push({
            anchor: tnToCm(pts[i].anchor, ab),
            leftDirection: tnToCm(pts[i].leftDirection, ab),
            rightDirection: tnToCm(pts[i].rightDirection, ab)
        });
    }
    return res;
}

/** Monotone-chain convex hull of [x,y] points. */
function tnHull(points) {
    var p = points.slice(0);
    p.sort(function (a, b) { return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]; });
    if (p.length < 3) return p;
    function cr(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
        while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
        lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
        upper.push(p[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
}

/** Collect every PathItem inside a container (group / compound). */
function tnCollectPaths(item, list) {
    var i;
    if (item.typename === "PathItem") { list.push(item); return; }
    if (item.typename === "CompoundPathItem") {
        for (i = 0; i < item.pathItems.length; i++) list.push(item.pathItems[i]);
        return;
    }
    if (item.typename === "GroupItem") {
        for (i = 0; i < item.pageItems.length; i++) tnCollectPaths(item.pageItems[i], list);
    }
}

function tnGetTagId(item) {
    try {
        for (var i = 0; i < item.tags.length; i++) {
            if (item.tags[i].name === TN_TAG_NAME) return item.tags[i].value;
        }
    } catch (e) {}
    return null;
}

function tnSetTagId(item, id) {
    try {
        for (var i = 0; i < item.tags.length; i++) {
            if (item.tags[i].name === TN_TAG_NAME) { item.tags[i].value = id; return; }
        }
        var tag = item.tags.add();
        tag.name = TN_TAG_NAME;
        tag.value = id;
    } catch (e) {}
}

/** Build the outline polygon (document pt) for any supported item. */
function tnOutline(item) {
    var t = item.typename, poly = [], i;
    if (t === "PathItem") {
        poly = tnFlattenPath(item);
    } else if (t === "CompoundPathItem") {
        // Outer boundary = the sub-path with the largest area (falls back to the first sub-path).
        var best = null, bestA = -1;
        for (i = 0; i < item.pathItems.length; i++) {
            var fp = tnFlattenPath(item.pathItems[i]);
            var a = tnPolyArea(fp);
            if (a > bestA) { bestA = a; best = fp; }
        }
        poly = best || [];
    } else if (t === "GroupItem") {
        var paths = [], pts = [];
        tnCollectPaths(item, paths);
        if (paths.length === 1) {
            poly = tnFlattenPath(paths[0]);
        } else {
            for (i = 0; i < paths.length; i++) pts = pts.concat(tnFlattenPath(paths[i]));
            poly = tnHull(pts);
        }
    }
    if (poly.length < 3) {
        var gb = item.geometricBounds; // [left, top, right, bottom]
        poly = [[gb[0], gb[1]], [gb[2], gb[1]], [gb[2], gb[3]], [gb[0], gb[3]]];
    }
    return poly;
}

/* ---------------------------------------------------------------- */
/* Public API (called from the panel via evalScript)                 */
/* ---------------------------------------------------------------- */

/**
 * Returns a JSON array of shapes for every selected top-level item:
 * [{id, name, type, points:[{x,y}], pathPoints:[...], width, height, left, top}]
 * All measurements in cm relative to the active artboard's top-left.
 */
function getSelectedPathData() {
    var oldCS;
    try {
        if (app.documents.length === 0) return "ERROR: No document is open.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === undefined || sel.length === 0) return "ERROR: Nothing is selected. Select the shapes to nest.";

        oldCS = app.coordinateSystem;
        app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;

        var ab = tnArtboardRect(doc);
        var stamp = String(new Date().getTime());
        var shapes = [];
        for (var i = 0; i < sel.length; i++) {
            var item = sel[i];
            if (item.locked || item.hidden) continue;
            var poly = tnOutline(item);
            var cmPts = [];
            for (var k = 0; k < poly.length; k++) cmPts.push(tnToCm(poly[k], ab));

            var id = "tn_" + stamp + "_" + i;
            tnSetTagId(item, id);

            var gb = item.geometricBounds;
            var raw = [];
            if (item.typename === "PathItem") raw = tnRawPoints(item, ab);
            else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) raw = tnRawPoints(item.pathItems[0], ab);

            shapes.push({
                id: id,
                name: item.name ? item.name : (item.typename + " " + (i + 1)),
                type: item.typename,
                points: cmPts,
                pathPoints: raw,
                width: (gb[2] - gb[0]) * TN_PT_TO_CM,
                height: (gb[1] - gb[3]) * TN_PT_TO_CM,
                left: (gb[0] - ab[0]) * TN_PT_TO_CM,
                top: (ab[1] - gb[1]) * TN_PT_TO_CM
            });
        }
        app.coordinateSystem = oldCS;
        if (shapes.length === 0) return "ERROR: No unlocked, visible items in the selection.";
        return tnStringify(shapes);
    } catch (e) {
        try { if (oldCS !== undefined) app.coordinateSystem = oldCS; } catch (e2) {}
        return "ERROR: getSelectedPathData failed: " + e.message + (e.line ? " (line " + e.line + ")" : "");
    }
}

/** Active artboard info in cm: {name, index, width, height, left, top}. */
function getDocInfo() {
    try {
        if (app.documents.length === 0) return "ERROR: No document is open.";
        var doc = app.activeDocument;
        var idx = doc.artboards.getActiveArtboardIndex();
        var r = doc.artboards[idx].artboardRect;
        return tnStringify({
            name: doc.artboards[idx].name,
            index: idx,
            width: (r[2] - r[0]) * TN_PT_TO_CM,
            height: (r[1] - r[3]) * TN_PT_TO_CM,
            left: r[0] * TN_PT_TO_CM,
            top: r[1] * TN_PT_TO_CM,
            documentName: doc.name
        });
    } catch (e) {
        return "ERROR: getDocInfo failed: " + e.message;
    }
}

/** Locate items by their nesting tag (selection first, then whole document). */
function tnFindItems(doc, ids) {
    var map = {}, want = {}, remaining = 0, i, id;
    for (i = 0; i < ids.length; i++) { want[ids[i]] = true; remaining++; }
    var sel = doc.selection;
    if (sel && sel.length) {
        for (i = 0; i < sel.length && remaining > 0; i++) {
            id = tnGetTagId(sel[i]);
            if (id && want[id] && !map[id]) { map[id] = sel[i]; remaining--; }
        }
    }
    if (remaining > 0) {
        var all = doc.pageItems;
        for (i = 0; i < all.length && remaining > 0; i++) {
            id = tnGetTagId(all[i]);
            if (id && want[id] && !map[id]) { map[id] = all[i]; remaining--; }
        }
    }
    return map;
}

/**
 * Apply placements. jsonStr = '[{"id":"tn_..","x":1.2,"y":3.4,"rotation":90}, ...]'
 * Returns "OK: n moved" or an error string.
 */
function applyNesting(jsonStr) {
    var oldCS;
    try {
        if (app.documents.length === 0) return "ERROR: No document is open.";
        var doc = app.activeDocument;
        var placements = typeof jsonStr === "string" ? tnParse(jsonStr) : jsonStr;
        if (!placements || !placements.length) return "ERROR: No placements received.";

        oldCS = app.coordinateSystem;
        app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
        var ab = tnArtboardRect(doc);

        var ids = [], i;
        for (i = 0; i < placements.length; i++) ids.push(placements[i].id);
        var items = tnFindItems(doc, ids);

        var moved = 0, missing = [];
        for (i = 0; i < placements.length; i++) {
            var pl = placements[i];
            var item = items[pl.id];
            if (!item) { missing.push(pl.id); continue; }

            var rot = Number(pl.rotation) || 0;
            if (rot % 360 !== 0) {
                // Panel rotation is clockwise on screen; Illustrator's positive angle is counter-clockwise.
                item.rotate(-rot, true, true, true, true, Transformation.CENTER);
            }
            var gb = item.geometricBounds; // after rotation
            var targetLeft = ab[0] + Number(pl.x) * TN_CM_TO_PT;
            var targetTop = ab[1] - Number(pl.y) * TN_CM_TO_PT;
            item.translate(targetLeft - gb[0], targetTop - gb[1]);
            moved++;
        }
        app.coordinateSystem = oldCS;
        app.redraw();
        var msg = "OK: " + moved + " item(s) moved";
        if (missing.length) msg += "; " + missing.length + " item(s) not found";
        return msg;
    } catch (e) {
        try { if (oldCS !== undefined) app.coordinateSystem = oldCS; } catch (e2) {}
        return "ERROR: applyNesting failed: " + e.message + (e.line ? " (line " + e.line + ")" : "");
    }
}

/** Health check used by the panel to verify the host script is loaded. */
function tnPing() {
    return "pong";
}
