// Applies the saved theme choice before the page paints. With no saved
// choice the attribute is left off and theme.css follows the system setting
// (dark unless the system prefers light). The browse page's theme switch
// stores the choice; every page that loads this file follows it.

(function () {
  var root = document.documentElement;

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  var saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (error) {
    // storage unavailable: fall back to the system setting
  }
  apply(saved);

  // Another page of the extension changed the theme
  window.addEventListener('storage', function (event) {
    if (event.key === 'theme') apply(event.newValue);
  });
})();
