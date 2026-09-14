(function () {
  // Confirm dialogs on forms/links with .js-confirm
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.classList && f.classList.contains('js-confirm')) {
      if (!window.confirm(f.getAttribute('data-confirm') || 'Are you sure?')) e.preventDefault();
    }
  });

  // Copy to clipboard: <button class="js-copy" data-target="#id">
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.js-copy');
    if (!btn) return;
    var el = document.querySelector(btn.getAttribute('data-target'));
    if (!el) return;
    var text = el.value !== undefined ? el.value : el.textContent;
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  });

  // Repeatable rows: container.rows-editor with <template> and .js-add / .js-remove
  document.addEventListener('click', function (e) {
    var add = e.target.closest('.js-add-row');
    if (add) {
      e.preventDefault();
      var editor = add.closest('.rows-editor');
      var tpl = editor.querySelector('template');
      var list = editor.querySelector('.rows');
      list.appendChild(tpl.content.cloneNode(true));
      return;
    }
    var rm = e.target.closest('.js-remove-row');
    if (rm) {
      e.preventDefault();
      rm.closest('.row-item').remove();
    }
  });

  // Source presets: <select class="js-preset" data-presets='{...}'> fills inputs named params[key][name|token]
  var presetSel = document.querySelector('.js-preset');
  if (presetSel) {
    presetSel.addEventListener('change', function () {
      var presets = JSON.parse(presetSel.getAttribute('data-presets'));
      var p = presets[presetSel.value];
      if (!p) return;
      Object.keys(p.params).forEach(function (k) {
        var n = document.querySelector('[name="params[' + k + '][name]"]');
        var t = document.querySelector('[name="params[' + k + '][token]"]');
        if (n) n.value = p.params[k].name || '';
        if (t) t.value = p.params[k].token || '';
      });
      var cm = document.querySelector('[name="costModel"]');
      if (cm && p.costModel) cm.value = p.costModel;
    });
  }

  // Trigger form: show body fields only for POST
  var method = document.querySelector('[name="method"]');
  var bodyBox = document.querySelector('.js-body-fields');
  if (method && bodyBox) {
    var sync = function () { bodyBox.style.display = method.value === 'POST' ? '' : 'none'; };
    method.addEventListener('change', sync);
    sync();
  }
})();
