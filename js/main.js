/*
 * main.js — Panel controller for True-Shape Nesting.
 * Flow: Illustrator selection -> getSelectedPathData() -> NestingEngine (NFP)
 *       -> canvas preview -> applyNesting() back in Illustrator.
 */
(function () {
    'use strict';

    var inCEP = typeof window.__adobe_cep__ !== 'undefined';
    var csInterface = inCEP ? new CSInterface() : null;
    var lastResult = null;
    var busy = false;

    var $ = function (id) { return document.getElementById(id); };

    /* ---------------- logging / progress ---------------- */

    function log(msg, cls) {
        var el = $('log');
        var line = document.createElement('div');
        var t = new Date();
        var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
        line.className = cls || 'info';
        line.textContent = '[' + ts + '] ' + msg;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    }

    function setProgress(frac, text) {
        $('progressBar').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
        if (text != null) $('progressText').textContent = text;
    }

    function setBusy(state) {
        busy = state;
        $('btnNest').disabled = state;
        $('btnPreview').disabled = state;
        $('btnArtboard').disabled = state;
        $('btnApply').disabled = state || !lastResult;
    }

    /* ---------------- host communication ---------------- */

    function evalHost(script) {
        return new Promise(function (resolve, reject) {
            if (!inCEP) { reject(new Error('Not running inside Illustrator (CEP not detected).')); return; }
            csInterface.evalScript(script, function (res) {
                if (res === 'EvalScript error.' || res == null) {
                    reject(new Error('ExtendScript error while running: ' + script.slice(0, 60)));
                } else if (typeof res === 'string' && res.indexOf('ERROR:') === 0) {
                    reject(new Error(res.substring(6).trim()));
                } else {
                    resolve(res);
                }
            });
        });
    }

    /** Make sure hostscript.jsx is loaded (manifest ScriptPath normally does it). */
    function ensureHostScript() {
        if (!inCEP) return Promise.resolve();
        return new Promise(function (resolve) {
            csInterface.evalScript('typeof tnPing === "function" ? tnPing() : "missing"', function (res) {
                if (res === 'pong') { resolve(); return; }
                var path = csInterface.getSystemPath(SystemPath.EXTENSION) + '/jsx/hostscript.jsx';
                path = path.replace(/\\/g, '/');
                csInterface.evalScript('$.evalFile("' + path + '")', function () { resolve(); });
            });
        });
    }

    /* ---------------- settings ---------------- */

    function readSettings() {
        var w = parseFloat($('binWidth').value), h = parseFloat($('binHeight').value);
        var sp = parseFloat($('spacing').value), tol = parseFloat($('tolerance').value);
        var extra = parseFloat($('extraStep').value) || 0;
        if (!(w > 0) || !(h > 0)) throw new Error('Sheet width and height must be positive numbers.');
        if (!(sp >= 0)) sp = 0;
        if (!(tol > 0)) tol = 0.2;

        var rots = [];
        var boxes = document.querySelectorAll('.rot');
        for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) rots.push(parseFloat(boxes[i].value));
        if (extra > 0 && extra < 360) {
            for (var a = extra; a < 360; a += extra) if (rots.indexOf(a) < 0) rots.push(Math.round(a * 1000) / 1000);
        }
        if (!rots.length) rots = [0];
        rots.sort(function (x, y) { return x - y; });

        return {
            binWidth: w,
            binHeight: h,
            spacing: sp / 10,          // mm -> cm
            curveTolerance: tol / 10,  // mm -> cm
            rotations: rots
        };
    }

    /* ---------------- preview ---------------- */

    var COLORS = ['#4fa3ff', '#6fcf7a', '#e8c15a', '#ff8a65', '#ba8cff', '#4dd0c8', '#f06292', '#a1c45a'];

    function drawPreview(result) {
        var cv = $('preview'), ctx = cv.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var cssW = 200, cssH = 200;
        cv.width = cssW * dpr; cv.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        if (!result) return;

        var pad = 8;
        var s = Math.min((cssW - 2 * pad) / result.binWidth, (cssH - 2 * pad) / result.binHeight);
        var ox = (cssW - result.binWidth * s) / 2, oy = (cssH - result.binHeight * s) / 2;

        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(ox, oy, result.binWidth * s, result.binHeight * s);
        ctx.strokeStyle = '#8a8a8a';
        ctx.lineWidth = 1;
        ctx.strokeRect(ox + 0.5, oy + 0.5, result.binWidth * s - 1, result.binHeight * s - 1);

        result.placements.forEach(function (pl, i) {
            var poly = pl.polygon;
            if (!poly || poly.length < 3) return;
            ctx.beginPath();
            ctx.moveTo(ox + poly[0].x * s, oy + poly[0].y * s);
            for (var k = 1; k < poly.length; k++) ctx.lineTo(ox + poly[k].x * s, oy + poly[k].y * s);
            ctx.closePath();
            var c = COLORS[i % COLORS.length];
            ctx.globalAlpha = 0.45;
            ctx.fillStyle = c;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = c;
            ctx.stroke();
        });
    }

    function showStats(result) {
        $('stats').textContent =
            result.placements.length + ' placed, ' + result.unplaced.length + ' unplaced · ' +
            (result.utilization * 100).toFixed(1) + '% used · ' + result.timeMs + ' ms';
    }

    /* ---------------- core actions ---------------- */

    function getShapes() {
        if (!inCEP) {
            log('CEP not detected — using built-in demo shapes.', 'warn');
            return Promise.resolve(demoShapes());
        }
        return ensureHostScript()
            .then(function () { return evalHost('getSelectedPathData()'); })
            .then(function (res) {
                var shapes;
                try { shapes = JSON.parse(res); } catch (e) { throw new Error('Could not parse shape data from Illustrator.'); }
                if (!shapes.length) throw new Error('No usable shapes in the selection.');
                return shapes;
            });
    }

    function runNesting() {
        var settings = readSettings();
        log('Sheet ' + settings.binWidth + '×' + settings.binHeight + ' cm, spacing ' +
            (settings.spacing * 10) + ' mm, rotations [' + settings.rotations.join(', ') + ']');
        setProgress(0, 'Reading selection…');

        return getShapes().then(function (shapes) {
            log('Received ' + shapes.length + ' shape(s).');
            var tooBig = shapes.filter(function (s) {
                var minSide = Math.min(s.width, s.height), maxSide = Math.max(s.width, s.height);
                return minSide > Math.min(settings.binWidth, settings.binHeight) || maxSide > Math.max(settings.binWidth, settings.binHeight) * 1.4143;
            });
            if (tooBig.length) log(tooBig.length + ' shape(s) look larger than the sheet and may stay unplaced.', 'warn');

            var engine = new NestingEngine(settings);
            return engine.nestAsync(shapes, function (done, total, name) {
                setProgress(total ? done / total : 1, done < total ? 'Nesting ' + (done + 1) + '/' + total + ': ' + name : 'Nesting done');
            });
        }).then(function (result) {
            lastResult = result;
            drawPreview(result);
            showStats(result);
            log('Nesting finished: ' + result.placements.length + ' placed, ' + result.unplaced.length +
                ' unplaced, ' + (result.utilization * 100).toFixed(1) + '% sheet utilization.', 'ok');
            if (result.unplaced.length) log('Unplaced (do not fit): ' + result.unplaced.length + ' item(s) — they were left untouched.', 'warn');
            return result;
        });
    }

    function applyResult(result) {
        if (!result || !result.placements.length) return Promise.reject(new Error('Nothing to apply.'));
        if (!inCEP) {
            log('Demo mode: result not applied (open the panel inside Illustrator).', 'warn');
            return Promise.resolve();
        }
        var payload = result.placements.map(function (p) {
            return { id: p.id, x: p.x, y: p.y, rotation: p.rotation };
        });
        setProgress(1, 'Applying to artboard…');
        // Double stringify -> passed to ExtendScript as a string literal argument.
        return ensureHostScript()
            .then(function () { return evalHost('applyNesting(' + JSON.stringify(JSON.stringify(payload)) + ')'); })
            .then(function (msg) {
                log(msg.replace(/^OK:\s*/, 'Applied: '), 'ok');
                setProgress(1, 'Done');
                // Rotations are baked into the artwork now; prevent double-applying.
                lastResult = null;
            });
    }

    function onError(err) {
        log(err && err.message ? err.message : String(err), 'err');
        setProgress(0, 'Error');
    }

    function onNest() {
        if (busy) return;
        setBusy(true);
        runNesting()
            .then(applyResult)
            .catch(onError)
            .then(function () { setBusy(false); });
    }

    function onPreview() {
        if (busy) return;
        setBusy(true);
        runNesting()
            .then(function () { log('Preview ready — click "Apply Last Result" to move the shapes.'); })
            .catch(onError)
            .then(function () { setBusy(false); });
    }

    function onApply() {
        if (busy || !lastResult) return;
        setBusy(true);
        applyResult(lastResult).catch(onError).then(function () { setBusy(false); });
    }

    function onArtboard() {
        if (busy) return;
        if (!inCEP) { log('CEP not detected — cannot read artboard.', 'warn'); return; }
        ensureHostScript()
            .then(function () { return evalHost('getDocInfo()'); })
            .then(function (res) {
                var info = JSON.parse(res);
                $('binWidth').value = (Math.round(info.width * 100) / 100).toString();
                $('binHeight').value = (Math.round(info.height * 100) / 100).toString();
                log('Artboard "' + info.name + '": ' + info.width.toFixed(2) + ' × ' + info.height.toFixed(2) + ' cm', 'ok');
            })
            .catch(onError);
    }

    /* ---------------- demo shapes (browser testing) ---------------- */

    function demoShapes() {
        var shapes = [], i;
        var L = [{x:0,y:0},{x:8,y:0},{x:8,y:2.5},{x:2.5,y:2.5},{x:2.5,y:8},{x:0,y:8}];
        var T = [{x:0,y:0},{x:7,y:0},{x:7,y:2.4},{x:4.7,y:2.4},{x:4.7,y:7},{x:2.3,y:7},{x:2.3,y:2.4},{x:0,y:2.4}];
        function star(r1, r2, n) {
            var p = [];
            for (var k = 0; k < 2 * n; k++) {
                var r = k % 2 ? r2 : r1, a = Math.PI * k / n;
                p.push({ x: r1 + r * Math.cos(a), y: r1 + r * Math.sin(a) });
            }
            return p;
        }
        function circle(r) {
            var p = [];
            for (var k = 0; k < 48; k++) p.push({ x: r + r * Math.cos(k / 48 * 2 * Math.PI), y: r + r * Math.sin(k / 48 * 2 * Math.PI) });
            return p;
        }
        for (i = 0; i < 6; i++) shapes.push({ id: 'L' + i, name: 'L ' + i, points: L, width: 8, height: 8 });
        for (i = 0; i < 5; i++) shapes.push({ id: 'T' + i, name: 'T ' + i, points: T, width: 7, height: 7 });
        for (i = 0; i < 4; i++) shapes.push({ id: 'S' + i, name: 'Star ' + i, points: star(3, 1.4, 5), width: 6, height: 6 });
        for (i = 0; i < 4; i++) shapes.push({ id: 'C' + i, name: 'Circle ' + i, points: circle(2.2), width: 4.4, height: 4.4 });
        return shapes;
    }

    /* ---------------- init ---------------- */

    function init() {
        $('btnNest').addEventListener('click', onNest);
        $('btnPreview').addEventListener('click', onPreview);
        $('btnApply').addEventListener('click', onApply);
        $('btnArtboard').addEventListener('click', onArtboard);
        $('clearLog').addEventListener('click', function (e) { e.preventDefault(); $('log').innerHTML = ''; });
        drawPreview({ binWidth: 30, binHeight: 30, placements: [] });

        if (inCEP) {
            var env = csInterface.getHostEnvironment();
            log('Connected to ' + env.appName + ' ' + env.appVersion + '.', 'ok');
            ensureHostScript().then(function () { log('Host script ready. Select shapes and click "Nest Shapes".'); });
        } else {
            log('Running outside Illustrator — demo mode (built-in shapes).', 'warn');
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
