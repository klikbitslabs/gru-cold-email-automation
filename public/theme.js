// Applies the saved theme before the first paint (light by default). Loaded synchronously in <head>.
(function () {
  var theme = 'light';
  try {
    theme = localStorage.getItem('gru_theme') === 'dark' ? 'dark' : 'light';
  } catch (e) { /* storage unavailable: keep light */ }
  document.documentElement.setAttribute('data-theme', theme);
}());
