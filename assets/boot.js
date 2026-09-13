// Runs in <head>, before first paint: applies persisted preferences so the UI
// never flashes the wrong theme or typography. Settings JSON arrives from the
// native shell via window.__MDV_BOOT (injected before document creation).
(function () {
  'use strict';

  var FONTS = {
    system: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    sans: 'Verdana, Arial, sans-serif',
    dyslexic: '"Comic Sans MS", Verdana, sans-serif'
  };
  var WIDTHS = { narrow: '62ch', normal: '78ch', wide: '100ch', full: '200rem' };

  var settings = null;
  try {
    if (window.__MDV_BOOT && window.__MDV_BOOT.settings)
      settings = JSON.parse(window.__MDV_BOOT.settings);
  } catch (e) { settings = null; }
  window.__MDV_SETTINGS = settings;

  function apply(s) {
    s = s || {};
    var de = document.documentElement;
    var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = s.theme || 'system';
    var dark = theme === 'dark' || (theme === 'system' && sysDark);
    de.dataset.theme = dark ? 'dark' : 'light';

    if (s.highContrast) de.dataset.contrast = 'high';
    else delete de.dataset.contrast;
    de.dataset.underline = s.underlineLinks === false ? '0' : '1';
    de.dataset.codewrap = s.codeWrap ? '1' : '0';

    var motion = s.motion || 'auto';
    var reduced = motion === 'off' ||
      (motion === 'auto' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    de.dataset.motion = reduced ? 'off' : 'on';

    var st = de.style;
    st.setProperty('--content-font', FONTS[s.font] || FONTS.system);
    st.setProperty('--content-size', String(s.fontSize || 100));
    st.setProperty('--content-lh', String(s.lineHeight || 1.6));
    st.setProperty('--content-ls', (s.letterSpacing || 0) + 'em');
    st.setProperty('--content-width', WIDTHS[s.contentWidth] || WIDTHS.normal);
    st.setProperty('--img-filter',
      dark && s.dimImages !== false ? 'brightness(0.87) contrast(1.03)' : 'none');
    return dark;
  }

  window.__mdvApplyPrefs = apply;
  apply(settings);
})();
