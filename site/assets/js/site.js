// Ruffle3D website: mobile menu, OS detection on the download page, docs nav highlighting.
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var mobile = document.getElementById('mobile-nav');
  if (toggle && mobile) {
    toggle.addEventListener('click', function () {
      var open = mobile.hasAttribute('hidden');
      if (open) mobile.removeAttribute('hidden'); else mobile.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // donate page: copy a wallet address
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      if (!el) return;
      var text = el.textContent.trim(), label = btn.textContent;
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = label; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { selectText(el); });
      else selectText(el);
    });
  });
  function selectText(el) { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }

  // download page: point visitors at their platform
  var ua = navigator.userAgent;
  var os = /Windows/i.test(ua) ? 'windows' : (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) ? 'mac' : (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) ? 'linux' : '';
  if (os) {
    document.querySelectorAll('[data-os="' + os + '"]').forEach(function (card) { card.classList.add('detected'); });
    var label = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }[os];
    document.querySelectorAll('[data-os-label]').forEach(function (el) {
      el.textContent = 'Download for ' + label;
      // on the download page the main button fetches this system's package directly
      var href = el.getAttribute('data-href-' + os);
      if (href) { el.setAttribute('href', href); el.setAttribute('download', ''); }
    });
  }

  // docs: highlight the section in view
  var links = document.querySelectorAll('.doc-nav a[href^="#"]');
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.removeAttribute('aria-current'); });
        var a = byId[e.target.id];
        if (a) a.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-90px 0px -70% 0px' });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
