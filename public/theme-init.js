// Apply the saved theme before first paint, so light-theme users don't see a
// dark flash while the app loads. Mirrors applyTheme() in
// src/themes/registry.ts; registry.test.ts keeps this map in step with it.
(function () {
  var themes = {
    dark: ['dark', '#0b0d0e'],
    light: ['light', '#fdfcfa'],
    midnight: ['dark', '#1b1f27'],
    paper: ['light', '#f8faff'],
    contrast: ['dark', '#000000'],
    solarized: ['light', '#fdf6e3'],
    dracula: ['dark', '#211927'],
    gruvbox: ['dark', '#211b16'],
    matrix: ['dark', '#101713']
  };
  try {
    var saved = JSON.parse(localStorage.getItem('codekin-settings') || '{}');
    var id = saved && Object.prototype.hasOwnProperty.call(themes, saved.theme) ? saved.theme : 'dark';
    var root = document.documentElement;
    root.dataset.theme = id;
    root.dataset.scheme = themes[id][0];
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themes[id][1]);
  } catch (e) {
    // Unreadable storage: keep the Dark defaults from index.html.
  }
})();
