(function () {
  'use strict';
  var system = window.matchMedia('(prefers-color-scheme: light)'), saved = null;
  try { saved = localStorage.getItem('image-spacer-theme'); } catch (e) {}
  var group = document.createElement('div');
  group.className = 'theme-picker';
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Background preference');
  var label = document.createElement('span'); label.textContent = 'Background'; group.appendChild(label);
  var buttons = [];
  function apply(theme) {
    document.body.setAttribute('data-theme', theme);
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.theme === theme)); });
    window.dispatchEvent(new Event('image-spacer-theme'));
  }
  ['dark', 'light'].forEach(function (theme) {
    var b = document.createElement('button'); b.type = 'button'; b.dataset.theme = theme;
    b.textContent = theme === 'dark' ? 'Black' : 'White';
    b.addEventListener('click', function () { saved = theme; try { localStorage.setItem('image-spacer-theme', theme); } catch (e) {} apply(theme); });
    buttons.push(b); group.appendChild(b);
  });
  document.body.appendChild(group);
  apply(saved === 'dark' || saved === 'light' ? saved : system.matches ? 'light' : 'dark');
  function followSystem() { if (!saved) apply(system.matches ? 'light' : 'dark'); }
  if (system.addEventListener) system.addEventListener('change', followSystem);
  else if (system.addListener) system.addListener(followSystem);
})();
