/* ============================================================================
 * Pylex Extension: Themes
 * Lets the user customize panel colors and switch the File Manager editor between Monaco and Ace.
 * All settings persist in localStorage and are fully revertable.
 * ============================================================================ */
(function () {
  'use strict';

  const STORAGE_KEY = 'pylex_themes_extension_settings';
  const ACE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/ace.js';

  // Variables the user can tweak. label = shown in UI, css = CSS custom prop name.
  const COLOR_VARS = [
    { key: 'bg',          css: '--bg',          label: 'Background' },
    { key: 'surface',     css: '--surface',     label: 'Surface / Cards' },
    { key: 'text',        css: '--text',        label: 'Text' },
    { key: 'text2',       css: '--text-2',      label: 'Secondary Text' },
    { key: 'border',      css: '--border',      label: 'Border' },
    { key: 'orange',      css: '--orange',      label: 'Accent (Orange)' },
    { key: 'navBg',       css: '--nav-bg',      label: 'Top Nav Background' },
    { key: 'sidebarBg',   css: '--sidebar-bg',  label: 'Sidebar Background' },
    { key: 'green',       css: '--green',       label: 'Success / Green' },
    { key: 'red',         css: '--red',         label: 'Danger / Red' },
  ];

  const EDITOR_MODES = { monaco: 'Monaco (default)', ace: 'Ace' };

  // ── State ──────────────────────────────────────────────────────────────
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[Themes Extension] Failed to save settings:', e);
    }
  }

  let settings = loadSettings();

  // ── Apply colors ───────────────────────────────────────────────────────
  function applyColors() {
    const root = document.documentElement;
    COLOR_VARS.forEach(v => {
      const val = settings.colors && settings.colors[v.key];
      if (val) {
        root.style.setProperty(v.css, val, 'important');
      } else {
        root.style.removeProperty(v.css);
      }
    });
  }

  // ── Editor switching (Monaco <-> Ace) ─────────────────────────────────
  let _aceLoading = null;
  let _monacoShim = null; // saved reference to the original Monaco-backed shim

  function loadAceScript() {
    if (window.ace) return Promise.resolve();
    if (_aceLoading) return _aceLoading;
    _aceLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ACE_CDN;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load Ace from CDN'));
      document.head.appendChild(s);
    });
    return _aceLoading;
  }

  const MONACO_TO_ACE_MODE = {
    javascript: 'javascript', typescript: 'typescript', python: 'python',
    html: 'html', css: 'css', scss: 'scss', less: 'less', json: 'json',
    markdown: 'markdown', shell: 'sh', go: 'golang', ruby: 'ruby',
    php: 'php', rust: 'rust', java: 'java', kotlin: 'kotlin', swift: 'swift',
    yaml: 'yaml', xml: 'xml', sql: 'sql', plaintext: 'text', csharp: 'csharp',
    cpp: 'c_cpp', lua: 'lua', r: 'r', dockerfile: 'dockerfile', ini: 'ini',
    graphql: 'graphqlschema', proto: 'protobuf', makefile: 'makefile',
  };

  async function switchToAce() {
    const container = document.getElementById('fm-monaco-container');
    if (!container) return;

    await loadAceScript();

    // Save current value/mode from whatever editor is active so we can restore it
    let currentValue = '';
    try { currentValue = window._aceEditor ? window._aceEditor.getValue() : ''; } catch (e) {}

    // Hide Monaco's container content, but keep the DOM node Monaco created
    // (Monaco doesn't like being destroyed/recreated reliably across CDNs,
    // so we just visually hide it and place Ace in a sibling container).
    if (window._monacoEditor && window._monacoEditor.getDomNode) {
      const node = window._monacoEditor.getDomNode();
      if (node) node.style.display = 'none';
    }

    let aceHost = document.getElementById('themes-ext-ace-host');
    if (!aceHost) {
      aceHost = document.createElement('div');
      aceHost.id = 'themes-ext-ace-host';
      aceHost.style.cssText = 'position:absolute; inset:0;';
      container.style.position = 'relative';
      container.appendChild(aceHost);
    }
    aceHost.style.display = 'block';

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const editor = window._aceEditorInstance || ace.edit(aceHost);
    window._aceEditorInstance = editor;
    editor.setTheme(isDark ? 'ace/theme/one_dark' : 'ace/theme/github');
    editor.session.setOptions({ tabSize: 2, useSoftTabs: true });
    editor.setOptions({ fontSize: '13px', fontFamily: "'IBM Plex Mono', 'Courier New', monospace", showPrintMargin: false });
    editor.setValue(currentValue, -1);

    // Resize handling
    if (!editor._themesExtResizeObserver) {
      const ro = new ResizeObserver(() => editor.resize());
      ro.observe(container);
      editor._themesExtResizeObserver = ro;
    }

    // Ctrl+S -> save, same as Monaco binding
    editor.commands.addCommand({
      name: 'pylexSave',
      bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
      exec: function () { if (typeof window.fmSaveFile === 'function') window.fmSaveFile(); }
    });

    // Theme sync
    if (!editor._themesExtThemeObserver) {
      const observer = new MutationObserver(() => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        editor.setTheme(dark ? 'ace/theme/one_dark' : 'ace/theme/github');
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      editor._themesExtThemeObserver = observer;
    }

    // Replace window._aceEditor with a shim around the real Ace editor that
    // matches the same interface used elsewhere (getValue/setValue/session.setMode/etc).
    if (!_monacoShim) _monacoShim = window._aceEditor; // remember original Monaco-backed shim

    window._aceEditor = {
      getValue: () => editor.getValue(),
      setValue: (v) => { editor.setValue(v == null ? '' : v, -1); editor.clearSelection(); editor.focus(); },
      focus: () => editor.focus(),
      clearSelection: () => editor.clearSelection(),
      scrollToLine: () => editor.scrollToLine(0, false, false),
      session: {
        setMode: (aceMode) => {
          const m = aceMode.replace('ace/mode/', '');
          const mode = MONACO_TO_ACE_MODE[m] ? m : (Object.values(MONACO_TO_ACE_MODE).includes(m) ? m : m);
          try { editor.session.setMode('ace/mode/' + (mode || 'text')); }
          catch (e) { editor.session.setMode('ace/mode/text'); }
        }
      }
    };

    editor.resize();
  }

  function switchToMonaco() {
    const container = document.getElementById('fm-monaco-container');
    if (!container) return;

    const aceHost = document.getElementById('themes-ext-ace-host');
    let currentValue = '';
    try { currentValue = window._aceEditor ? window._aceEditor.getValue() : ''; } catch (e) {}

    if (aceHost) aceHost.style.display = 'none';

    if (window._monacoEditor && window._monacoEditor.getDomNode) {
      const node = window._monacoEditor.getDomNode();
      if (node) node.style.display = '';
      window._monacoEditor.layout();
    }

    // Restore the Monaco-backed shim (or rebuild a minimal one if missing)
    if (_monacoShim) {
      window._aceEditor = _monacoShim;
    }
    if (window._aceEditor && currentValue) {
      try { window._aceEditor.setValue(currentValue); } catch (e) {}
    }
  }

  function applyEditorMode() {
    const mode = settings.editor || 'monaco';
    // Wait until Monaco has finished initializing (window._monacoEditor exists)
    const tryApply = (attemptsLeft) => {
      if (mode === 'ace') {
        switchToAce().catch(e => console.warn('[Themes Extension] Ace load failed:', e));
      } else {
        if (window._monacoEditor) switchToMonaco();
      }
    };
    if (window._monacoEditor || mode === 'ace') {
      tryApply();
    } else {
      // Monaco might not be ready yet; poll briefly.
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (window._monacoEditor || tries > 50) {
          clearInterval(iv);
          tryApply();
        }
      }, 100);
    }
  }

  // ── Apply everything ──────────────────────────────────────────────────
  function applyAll() {
    applyColors();
    applyEditorMode();
  }

  // ── UI ─────────────────────────────────────────────────────────────────
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (document.getElementById('themes-ext-styles')) return;
    const style = document.createElement('style');
    style.id = 'themes-ext-styles';
    style.textContent = `
      #themes-ext-fab {
        position: fixed; bottom: 18px; right: 18px; z-index: 700;
        width: 46px; height: 46px; border-radius: 50%;
        background: var(--orange); color: #fff; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      #themes-ext-fab:hover { transform: scale(1.06); box-shadow: 0 8px 26px rgba(0,0,0,0.3); }
      #themes-ext-fab svg { width: 22px; height: 22px; }

      #themes-ext-overlay {
        position: fixed; inset: 0; z-index: 800;
        background: rgba(0,0,0,0.5); backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; visibility: hidden;
        transition: opacity 0.18s;
      }
      #themes-ext-overlay.open { opacity: 1; pointer-events: auto; visibility: visible; }

      #themes-ext-panel {
        background: var(--surface); color: var(--text);
        border: 1px solid var(--border); border-radius: 12px;
        width: min(520px, 92vw); max-height: 88vh; overflow-y: auto;
        padding: 0; transform: scale(0.96) translateY(8px);
        transition: transform 0.2s cubic-bezier(0.16,1,0.3,1);
        font-family: 'IBM Plex Sans', sans-serif;
      }
      #themes-ext-overlay.open #themes-ext-panel { transform: scale(1) translateY(0); }

      .te-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 20px; border-bottom: 1px solid var(--border);
        position: sticky; top: 0; background: var(--surface); z-index: 2;
      }
      .te-title { font-size: 1rem; font-weight: 700; }
      .te-sub { font-size: 0.74rem; color: var(--text-2); margin-top: 2px; }
      .te-close {
        width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border);
        background: transparent; color: var(--text-2); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .te-close:hover { color: var(--text); border-color: var(--text-2); }
      .te-close svg { width: 13px; height: 13px; }

      .te-body { padding: 18px 20px 8px; }
      .te-section { margin-bottom: 22px; }
      .te-section-title {
        font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--text-3); margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border);
      }

      .te-color-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 6px 0; font-size: 0.82rem;
      }
      .te-color-row label { color: var(--text-2); }
      .te-color-row .te-color-controls { display: flex; align-items: center; gap: 8px; }
      .te-color-row input[type="color"] {
        width: 32px; height: 28px; border-radius: 6px; border: 1px solid var(--border);
        background: none; cursor: pointer; padding: 0;
      }
      .te-color-row input[type="text"] {
        width: 90px; font-family: var(--mono); font-size: 0.74rem;
        padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text);
      }
      .te-reset-mini {
        background: none; border: none; cursor: pointer; color: var(--text-3);
        display: flex; align-items: center; padding: 2px;
      }
      .te-reset-mini:hover { color: var(--orange); }
      .te-reset-mini svg { width: 13px; height: 13px; }

      .te-field { margin-bottom: 12px; }
      .te-field label {
        display: block; font-size: 0.76rem; font-weight: 600; color: var(--text-2); margin-bottom: 6px;
      }
      .te-field input[type="text"], .te-field input[type="number"], .te-field select {
        width: 100%; box-sizing: border-box; padding: 8px 10px;
        border-radius: 6px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text); font-size: 0.8rem; font-family: var(--sans);
      }
      .te-range-row { display: flex; align-items: center; gap: 10px; }
      .te-range-row input[type="range"] { flex: 1; }
      .te-range-row span { font-family: var(--mono); font-size: 0.72rem; color: var(--text-3); width: 40px; text-align: right; flex-shrink: 0; }



      .te-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 8px 14px; border-radius: 6px; font-size: 0.78rem; font-weight: 600;
        border: 1px solid var(--border); background: var(--bg); color: var(--text-2);
        cursor: pointer; transition: all 0.15s; font-family: var(--sans);
      }
      .te-btn:hover { border-color: var(--orange); color: var(--orange); background: var(--orange-dim); }
      .te-btn svg { width: 13px; height: 13px; }
      .te-btn-primary { background: var(--orange); color: #fff; border-color: var(--orange); }
      .te-btn-primary:hover { background: var(--orange-hover); color: #fff; }
      .te-btn-danger { color: var(--red); }
      .te-btn-danger:hover { border-color: var(--red); background: var(--red-dim); color: var(--red); }

      .te-footer {
        display: flex; align-items: center; gap: 10px; padding: 14px 20px;
        border-top: 1px solid var(--border); position: sticky; bottom: 0;
        background: var(--surface);
      }
      .te-footer .spacer { flex: 1; }

      .te-toast {
        position: fixed; bottom: 76px; right: 18px; z-index: 900;
        background: var(--surface); color: var(--text); border: 1px solid var(--border);
        border-radius: 8px; padding: 9px 14px; font-size: 0.78rem;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        opacity: 0; transform: translateY(6px); transition: opacity 0.2s, transform 0.2s;
        pointer-events: none;
      }
      .te-toast.show { opacity: 1; transform: translateY(0); }

      @media (max-width: 480px) {
        #themes-ext-fab { bottom: 70px; right: 14px; }

      }
    `;
    document.head.appendChild(style);
  }

  function showToast(msg) {
    let toast = document.getElementById('themes-ext-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'themes-ext-toast';
      toast.className = 'te-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function colorRowHtml(v) {
    const current = (settings.colors && settings.colors[v.key]) || '';
    const computed = getComputedStyle(document.documentElement).getPropertyValue(v.css).trim() || '#000000';
    const swatchVal = current || (computed.startsWith('#') ? computed : '#000000');
    return `
      <div class="te-color-row" data-var="${v.key}">
        <label>${v.label}</label>
        <div class="te-color-controls">
          <input type="color" value="${escAttr(swatchVal)}" data-color-key="${v.key}" data-css-var="${v.css}"
            ${swatchVal.startsWith('#') ? '' : 'disabled'} />
          <input type="text" value="${escAttr(current)}" placeholder="${escAttr(computed)}" data-text-key="${v.key}" data-css-var="${v.css}" />
          <button class="te-reset-mini" data-reset-key="${v.key}" title="Reset to default">
            <svg viewBox="0 0 24 24" fill="none"><polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>`;
  }

  function buildPanelHtml() {
    const editorMode = settings.editor || 'monaco';

    return `
      <div class="te-header">
        <div>
          <div class="te-title">Themes</div>
          <div class="te-sub">Customize colors &amp; editor — saved to this browser</div>
        </div>
        <button class="te-close" id="te-close-btn">
          <svg viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="te-body">

        <div class="te-section">
          <div class="te-section-title">Panel Colors</div>
          ${COLOR_VARS.map(colorRowHtml).join('')}
        </div>

        <div class="te-section">
          <div class="te-section-title">Code Editor</div>
          <div class="te-field">
            <label>File Manager Editor</label>
            <select id="te-editor-select">
              ${Object.entries(EDITOR_MODES).map(([k, label]) =>
                `<option value="${k}" ${editorMode === k ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </div>
          <div style="font-size:0.72rem;color:var(--text-3);line-height:1.6;">
            Switches the editor used in the File Manager. Your file content is preserved when switching.
          </div>
        </div>

      </div>
      <div class="te-footer">
        <button class="te-btn te-btn-danger" id="te-revert-all-btn">
          <svg viewBox="0 0 24 24" fill="none"><polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Revert All
        </button>
        <div class="spacer"></div>
        <button class="te-btn te-btn-primary" id="te-apply-btn">
          <svg viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Apply &amp; Save
        </button>
      </div>
    `;
  }

  function readUIIntoSettings() {
    const panel = document.getElementById('themes-ext-panel');
    if (!panel) return;

    const colors = {};
    COLOR_VARS.forEach(v => {
      const input = panel.querySelector(`input[data-text-key="${v.key}"]`);
      const val = input ? input.value.trim() : '';
      if (val) colors[v.key] = val;
    });

    const editorMode = (panel.querySelector('#te-editor-select') || {}).value || 'monaco';

    settings = { colors, editor: editorMode };
  }

  function wirePanelEvents() {
    const panel = document.getElementById('themes-ext-panel');
    const overlay = document.getElementById('themes-ext-overlay');

    document.getElementById('te-close-btn').addEventListener('click', closeSettings);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });

    // Color inputs: sync color <-> text, live preview
    panel.querySelectorAll('input[type="color"]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.colorKey;
        const cssVar = inp.dataset.cssVar;
        const textInput = panel.querySelector(`input[data-text-key="${key}"]`);
        if (textInput) textInput.value = inp.value;
        document.documentElement.style.setProperty(cssVar, inp.value, 'important');
      });
    });
    panel.querySelectorAll('input[type="text"][data-text-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        const cssVar = inp.dataset.cssVar;
        const val = inp.value.trim();
        const colorInput = panel.querySelector(`input[type="color"][data-color-key="${inp.dataset.textKey}"]`);
        if (val) {
          document.documentElement.style.setProperty(cssVar, val, 'important');
          if (colorInput && /^#([0-9a-f]{3}){1,2}$/i.test(val)) {
            colorInput.value = val; colorInput.disabled = false;
          }
        } else {
          document.documentElement.style.removeProperty(cssVar);
        }
      });
    });
    panel.querySelectorAll('button[data-reset-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.resetKey;
        const v = COLOR_VARS.find(c => c.key === key);
        if (!v) return;
        document.documentElement.style.removeProperty(v.css);
        const textInput = panel.querySelector(`input[data-text-key="${key}"]`);
        if (textInput) textInput.value = '';
        const computed = getComputedStyle(document.documentElement).getPropertyValue(v.css).trim();
        const colorInput = panel.querySelector(`input[type="color"][data-color-key="${key}"]`);
        if (colorInput) {
          if (computed.startsWith('#')) { colorInput.value = computed; colorInput.disabled = false; }
          else { colorInput.disabled = true; }
        }
      });
    });

    // Editor select — live switch preview
    panel.querySelector('#te-editor-select').addEventListener('change', (e) => {
      const mode = e.target.value;
      const prev = settings;
      settings = { ...settings, editor: mode };
      applyEditorMode();
      settings = prev; // don't persist yet
    });

    // Footer buttons
    document.getElementById('te-apply-btn').addEventListener('click', () => {
      readUIIntoSettings();
      saveSettings(settings);
      applyAll();
      showToast('Theme settings saved');
      closeSettings();
    });

    document.getElementById('te-revert-all-btn').addEventListener('click', () => {
      settings = {};
      saveSettings(settings);
      // Clear all inline overrides
      COLOR_VARS.forEach(v => document.documentElement.style.removeProperty(v.css));
      applyEditorMode();
      showToast('Reverted to defaults');
      closeSettings();
    });
  }

  function openSettings() {
    let overlay = document.getElementById('themes-ext-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'themes-ext-overlay';
      overlay.innerHTML = `<div id="themes-ext-panel"></div>`;
      document.body.appendChild(overlay);
    }
    document.getElementById('themes-ext-panel').innerHTML = buildPanelHtml();
    wirePanelEvents();
    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  function closeSettings() {
    const overlay = document.getElementById('themes-ext-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    // Re-apply saved settings (discard any unsaved live-preview changes)
    applyAll();
  }

  function injectFab() {
    if (document.getElementById('themes-ext-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'themes-ext-fab';
    btn.title = 'Themes';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C22.013 6.012 17.461 2 12 2z"/></svg>`;
    btn.addEventListener('click', openSettings);
    document.body.appendChild(btn);
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    injectFab();
    applyAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
