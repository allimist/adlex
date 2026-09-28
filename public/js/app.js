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

  // Source custom params t1…t20: rows past t5 are rendered hidden; "+ Add" reveals the next one, × clears and hides it.
  var tEditor = document.querySelector('.js-tparams');
  var syncTLimit = function () {};
  if (tEditor) {
    var hiddenRows = function () { return tEditor.querySelectorAll('.js-param-row[hidden]'); };
    var addBtn = tEditor.querySelector('.js-add-tparam');
    var limitHint = tEditor.querySelector('.js-tparam-limit');
    syncTLimit = function () {
      var full = hiddenRows().length === 0;
      addBtn.hidden = full;
      limitHint.hidden = !full;
    };
    tEditor.addEventListener('click', function (e) {
      if (e.target.closest('.js-add-tparam')) {
        var next = hiddenRows()[0];
        if (next) {
          next.hidden = false;
          next.querySelector('input').focus();
        }
        syncTLimit();
      }
      var rm = e.target.closest('.js-remove-tparam');
      if (rm) {
        var row = rm.closest('.js-param-row');
        row.querySelectorAll('input').forEach(function (i) { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
        row.hidden = true;
        syncTLimit();
      }
    });
    syncTLimit();
  }

  // Source presets: <select class="js-preset" data-presets='{...}'> fills inputs named param_name_<key> / param_token_<key>
  var presetSel = document.querySelector('.js-preset');
  if (presetSel) {
    presetSel.addEventListener('change', function () {
      var presets = JSON.parse(presetSel.getAttribute('data-presets'));
      var p = presets[presetSel.value];
      if (!p) return;
      Object.keys(p.params).forEach(function (k) {
        var n = document.querySelector('[name="param_name_' + k + '"]');
        var t = document.querySelector('[name="param_token_' + k + '"]');
        if (n) n.value = p.params[k].name || '';
        if (t) t.value = p.params[k].token || '';
        var h = document.querySelector('[name="param_hide_' + k + '"]');
        if (h) h.checked = !!p.params[k].hideInUrl;
        var row = n && n.closest('.js-param-row');
        if (row) row.hidden = false;
      });
      syncTLimit();
      var cm = document.querySelector('[name="costModel"]');
      if (cm && p.costModel) cm.value = p.costModel;
    });
  }

  // Export form: show the fields that apply to the chosen window type / platform
  var winType = document.querySelector('.js-window-type');
  if (winType) {
    var syncWin = function () {
      var monthly = winType.value === 'monthly';
      document.querySelectorAll('.js-window-rolling').forEach(function (el) { el.hidden = monthly; });
      document.querySelectorAll('.js-window-monthly').forEach(function (el) { el.hidden = !monthly; });
    };
    winType.addEventListener('change', syncWin);
    syncWin();
  }
  var platformSel = document.querySelector('.js-export-platform');
  var customBox = document.querySelector('.js-custom-columns');
  if (platformSel && customBox) {
    var syncPlatform = function () { customBox.hidden = platformSel.value !== 'custom'; };
    platformSel.addEventListener('change', syncPlatform);
    syncPlatform();
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
