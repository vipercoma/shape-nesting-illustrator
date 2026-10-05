(function () {
  'use strict';
  var canvas = document.createElement('canvas');
  canvas.id = 'dot-background'; canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext('2d'), w = 0, h = 0, frame = null;
  var pointer = { x: -1000, y: -1000 }, reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function draw() {
    ctx.clearRect(0, 0, w, h);
    var style = getComputedStyle(document.body);
    function token(name, fallback) { var n = parseFloat(style.getPropertyValue(name)); return isFinite(n) ? n : fallback; }
    var spacing = Math.max(4, token('--vc-dot-spacing', 20));
    var reach = Math.max(1, token('--vc-dot-reach', 130));
    var rgb = style.getPropertyValue('--vc-dot-rgb').trim() || '215,215,215';
    for (var y = spacing / 2; y < h; y += spacing) for (var x = spacing / 2; x < w; x += spacing) {
      var dx = x - pointer.x, dy = y - pointer.y, distance = Math.sqrt(dx * dx + dy * dy);
      var force = reduced.matches ? 0 : Math.max(0, 1 - distance / reach);
      var offset = force * force * token('--vc-dot-displacement', 12);
      ctx.beginPath(); ctx.arc(x + dx / (distance || 1) * offset, y + dy / (distance || 1) * offset, Math.max(.1, token('--vc-dot-radius', 1)) + force * 1.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + rgb + ',' + (token('--vc-dot-opacity', .23) + force * token('--vc-dot-gain', .45)) + ')'; ctx.fill();
    }
    frame = null;
  }
  function schedule() { if (frame === null) frame = requestAnimationFrame(draw); }
  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); schedule();
  }
  window.addEventListener('pointermove', function (e) { pointer.x = e.clientX; pointer.y = e.clientY; schedule(); });
  document.documentElement.addEventListener('pointerleave', function () { pointer.x = pointer.y = -1000; schedule(); });
  window.addEventListener('blur', function () { pointer.x = pointer.y = -1000; schedule(); });
  window.addEventListener('resize', resize);
  window.addEventListener('image-spacer-theme', schedule);
  if (reduced.addEventListener) reduced.addEventListener('change', schedule);
  else if (reduced.addListener) reduced.addListener(schedule);
  resize();
})();
