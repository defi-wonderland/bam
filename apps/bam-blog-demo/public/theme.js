/**
 * Mirrors the upstream blog's color-scheme toggle:
 * `html.dark` class-toggle persisted in localStorage. The
 * pre-paint snippet that applies a saved choice before first
 * render lives inline in each post page's <head>; this file
 * wires the click handler.
 */

(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('#color-mode-switch button');
    if (!btn) return;
    var html = document.documentElement;

    var refreshLabel = function () {
      var explicit =
        html.classList.contains('dark') ||
        (!html.classList.contains('light') &&
          matchMedia('(prefers-color-scheme: dark)').matches);
      btn.textContent = explicit ? '☀ light' : '☾ dark';
      btn.setAttribute(
        'aria-label',
        explicit ? 'Switch to light mode' : 'Switch to dark mode'
      );
    };

    btn.addEventListener('click', function () {
      var sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
      var isDark =
        html.classList.contains('dark') ||
        (!html.classList.contains('light') && sysDark);
      html.classList.remove('dark');
      html.classList.remove('light');
      if (isDark) {
        html.classList.add('light');
        localStorage.setItem('colorScheme', 'light');
      } else {
        html.classList.add('dark');
        localStorage.setItem('colorScheme', 'dark');
      }
      refreshLabel();
    });

    refreshLabel();
  });
})();
