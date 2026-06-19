/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Pylex Extension — Timeline
 *  Stores a snapshot of a file's OLD content every time you hit Save,
 *  lets you browse snapshots from a sidebar panel, preview them, and restore.
 *
 *  Storage key schema (localStorage):
 *    plx_timeline_<appName>_snapshots
 *      → JSON array of { id, filePath, savedAt (ISO), content (old content) }
 *
 *  Virtual FS path convention (for display only — data stays in localStorage):
 *    .pylex/extensions/timeline/<filePath>-<timestamp>
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Guard: only run once ─────────────────────────────────────────────── */
  if (window.__plxTimelineLoaded) return;
  window.__plxTimelineLoaded = true;

  /* ── Wait for the page to be fully ready ─────────────────────────────── */
  function whenReady(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn);
  }

  whenReady(init);

  /* ══════════════════════════════════════════════════════════════════════════
   *  HELPERS
   * ══════════════════════════════════════════════════════════════════════════ */

  function getAppName() {
    try {
      return window.appName
        || new URLSearchParams(location.search).get('app')
        || 'unknown';
    } catch (_) { return 'unknown'; }
  }

  /**
   * username, password, and appName are all declared with `const`/`let` at
   * the top of the host page's script, so (like fmCurrentFile) they never
   * become window properties. But they're trivially re-derivable: username
   * and password live in localStorage, appName lives in the URL — the host
   * page just reads them from there too, so we do the same instead of
   * depending on window.*.
   */
  function getUsername() {
    return window.username || localStorage.getItem('username') || '';
  }

  function getPassword() {
    return window.password || localStorage.getItem('password') || '';
  }

  /**
   * appPass is NOT derivable locally — the host page only gets it from a
   * POST /api/get-app call (see loadAppData() in the page script), which
   * resolves data.apps[appName].appPass. We replicate that call ourselves
   * and cache the result so we're not hitting the endpoint on every save.
   */
  let _cachedAppPass = null;

  async function getAppPass() {
    if (window.appPass) return window.appPass; // in case the host page ever fixes this
    if (_cachedAppPass) return _cachedAppPass;

    const res = await fetch('/api/get-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: getUsername(), password: getPassword() }),
    });
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message);
    const app = data.apps[getAppName()];
    if (!app) throw new Error('App not found');
    _cachedAppPass = app.appPass;
    return _cachedAppPass;
  }

  function storageKey() {
    return 'plx_timeline_' + getAppName() + '_snapshots';
  }

  function loadSnapshots() {
    try { return JSON.parse(localStorage.getItem(storageKey()) || '[]'); }
    catch (_) { return []; }
  }

  function saveSnapshots(arr) {
    localStorage.setItem(storageKey(), JSON.stringify(arr));
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) { return iso; }
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  SNAPSHOT LOGIC
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Capture the CURRENT editor content as "old content" before a save
   * overwrites it on the server. Called just before the actual write.
   */
  function captureSnapshot(filePath, oldContent) {
    const snap = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      filePath,
      savedAt: new Date().toISOString(),
      content: oldContent,
    };
    const arr = loadSnapshots();
    arr.unshift(snap); // newest first
    // Keep at most 200 snapshots total
    if (arr.length > 200) arr.length = 200;
    saveSnapshots(arr);
    return snap;
  }

  function deleteSnapshot(id) {
    const arr = loadSnapshots().filter(s => s.id !== id);
    saveSnapshots(arr);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  INTERCEPT THE SAVE BUTTON
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * The host page keeps the active file path in a top-level `let fmCurrentFile`,
   * which never becomes a `window` property (only `var` does that). So instead
   * of relying on window.fmCurrentFile (always undefined from here), we read
   * the path straight from the DOM, which the page keeps in sync whenever a
   * file is selected (see fm-current-path.textContent = filePath).
   */
  function getCurrentFilePath() {
    if (window.fmCurrentFile) return window.fmCurrentFile; // in case the host page ever fixes this
    const el = document.getElementById('fm-current-path');
    const text = el ? el.textContent.trim() : '';
    return text || null;
  }

  function hookSaveButton() {
    const origBtn = document.getElementById('fm-save-btn');
    if (!origBtn) {
      // File manager section may not have rendered yet; retry briefly
      setTimeout(hookSaveButton, 400);
      return;
    }
    if (origBtn.dataset.timelineHooked) return;
    origBtn.dataset.timelineHooked = '1';

    /* Clone the original button so we inherit its exact markup/theme/icon,
       instead of trying to intercept the original's click behavior. */
    const tlBtn = origBtn.cloneNode(true);
    tlBtn.id = 'tl-save-btn';
    tlBtn.removeAttribute('onclick');
    tlBtn.dataset.timelineHooked = '1';

    /* Hide the original (don't remove — other page code may reference its id)
       and place our clone right in its spot. */
    origBtn.style.display = 'none';
    origBtn.insertAdjacentElement('afterend', tlBtn);

    tlBtn.addEventListener('click', timelineSave);
  }

  /**
   * Our replacement save handler:
   * 1. Read current editor content (what's ABOUT to be saved)
   * 2. Read what's currently ON the server (the "old" content)  ← snapshot this
   * 3. Write the new content to the server
   * 4. Refresh the timeline panel
   */
  async function timelineSave() {
    const fmCurrentFile = getCurrentFilePath();
    if (!fmCurrentFile) return;

    const newContent = window._aceEditor ? window._aceEditor.getValue() : '';
    const btn = document.getElementById('tl-save-btn');
    if (btn) btn.disabled = true;

    try {
      const username = getUsername();
      const password = getPassword();
      const appName = getAppName();
      const appPassword = await getAppPass();

      /* ── Step 1: read old content from server ─────────────────────────── */
      let oldContent = '';
      try {
        const readRes = await fetch('/api/fs/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password,
            appName,
            appPassword,
            filePath: fmCurrentFile,
          }),
        });
        const readData = await readRes.json();
        if (readData.status === 'success') oldContent = readData.content || '';
      } catch (_) {
        // If we can't read the old content, we skip the snapshot rather than
        // blocking the save entirely.
      }

      /* ── Step 2: snapshot the old content ─────────────────────────────── */
      if (oldContent !== '' && oldContent !== newContent) {
        captureSnapshot(fmCurrentFile, oldContent);
        renderTimelinePanel(); // refresh list
      }

      /* ── Step 3: write new content ─────────────────────────────────────── */
      const saveRes = await fetch('/api/fs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          appName,
          appPassword,
          filePath: fmCurrentFile,
          content: newContent,
        }),
      });
      const saveData = await saveRes.json();
      if (saveData.status !== 'success') throw new Error(saveData.message);

      if (typeof window.showMsg === 'function') window.showMsg('msg-fm', 'Saved.', 'ok');

    } catch (e) {
      if (typeof window.showMsg === 'function') window.showMsg('msg-fm', e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  STYLES
   * ══════════════════════════════════════════════════════════════════════════ */

  function injectStyles() {
    if (document.getElementById('plx-timeline-styles')) return;
    const style = document.createElement('style');
    style.id = 'plx-timeline-styles';
    style.textContent = `
      /* ── Sidebar button ── */
      #sb-timeline-ext {
        width: 38px; height: 38px; border-radius: 6px;
        background: transparent; border: 1px solid transparent;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; color: rgba(255,255,255,0.35);
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        position: relative;
      }
      #sb-timeline-ext svg { width: 17px; height: 17px; }
      #sb-timeline-ext:hover { color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.06); }
      #sb-timeline-ext.active { color: #f38020; background: rgba(243,128,32,0.12); border-color: rgba(243,128,32,0.2); }
      #sb-timeline-ext .sb-tooltip {
        position: absolute; left: calc(100% + 12px); top: 50%;
        transform: translateY(-50%);
        background: #1b1b1f; color: #e8e8f0;
        font-size: 0.72rem; font-family: var(--sans, sans-serif); font-weight: 500;
        padding: 5px 10px; border-radius: 6px;
        white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity 0.15s; z-index: 100;
        border: 1px solid rgba(255,255,255,0.1);
      }
      #sb-timeline-ext:hover .sb-tooltip { opacity: 1; }

      /* ── Section ── */
      #section-timeline-ext {
        display: none; flex-direction: column; flex: 1;
        padding: 28px 28px 40px;
      }
      #section-timeline-ext.active { display: flex; }

      /* ── File group header ── */
      .tl-file-group {
        margin-bottom: 20px;
      }
      .tl-file-label {
        font-family: var(--mono, monospace);
        font-size: 0.72rem; font-weight: 600;
        color: var(--text-2, #8888a0);
        text-transform: uppercase; letter-spacing: 0.05em;
        padding: 6px 0 8px;
        border-bottom: 1px solid var(--border, #2a2d3a);
        margin-bottom: 8px;
        display: flex; align-items: center; gap: 8px;
      }
      .tl-file-label svg { width: 13px; height: 13px; color: var(--orange, #f38020); }

      /* ── Snapshot card ── */
      .tl-card {
        background: var(--surface, #1a1d27);
        border: 1px solid var(--border, #2a2d3a);
        border-radius: 8px;
        padding: 12px 14px;
        margin-bottom: 8px;
        display: flex; align-items: flex-start; gap: 12px;
        transition: border-color 0.15s;
      }
      .tl-card:hover { border-color: rgba(243,128,32,0.3); }

      .tl-card-icon {
        width: 32px; height: 32px; border-radius: 6px;
        background: var(--orange-dim, rgba(243,128,32,0.1));
        border: 1px solid rgba(243,128,32,0.2);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; color: var(--orange, #f38020);
      }
      .tl-card-icon svg { width: 14px; height: 14px; }

      .tl-card-info { flex: 1; min-width: 0; }
      .tl-card-path {
        font-family: var(--mono, monospace); font-size: 0.78rem;
        font-weight: 600; color: var(--text, #e8e8f0);
        margin-bottom: 3px; word-break: break-all;
      }
      .tl-card-date {
        font-size: 0.7rem; color: var(--text-3, #55556a);
        font-family: var(--mono, monospace);
      }
      .tl-card-virtual {
        font-size: 0.64rem; color: var(--text-3, #55556a);
        font-family: var(--mono, monospace);
        margin-top: 2px; word-break: break-all;
      }

      .tl-card-actions {
        display: flex; gap: 6px; flex-shrink: 0; align-items: center;
        flex-wrap: wrap;
      }

      .tl-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 5px 10px; border-radius: 6px;
        font-size: 0.73rem; font-weight: 600;
        font-family: var(--sans, sans-serif);
        border: none; cursor: pointer;
        transition: background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .tl-btn svg { width: 12px; height: 12px; }

      .tl-btn-preview {
        background: var(--blue-dim, rgba(0,81,195,0.08));
        color: var(--blue, #0051c3);
        border: 1px solid rgba(0,81,195,0.18);
      }
      .tl-btn-preview:hover {
        background: var(--blue, #0051c3); color: #fff;
      }

      .tl-btn-restore {
        background: var(--green-dim, rgba(0,184,148,0.1));
        color: var(--green, #00b894);
        border: 1px solid rgba(0,184,148,0.22);
      }
      .tl-btn-restore:hover { background: var(--green, #00b894); color: #fff; }

      .tl-btn-del {
        background: transparent;
        color: var(--text-3, #55556a);
        border: 1px solid var(--border, #2a2d3a);
      }
      .tl-btn-del:hover {
        background: var(--red-dim, rgba(229,62,62,0.08));
        color: var(--red, #e53e3e);
        border-color: rgba(229,62,62,0.3);
      }

      /* ── Empty state ── */
      .tl-empty {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 12px; padding: 60px 20px;
        color: var(--text-3, #55556a); text-align: center;
        border: 1px dashed var(--border, #2a2d3a); border-radius: 10px;
      }
      .tl-empty svg { width: 32px; height: 32px; opacity: 0.35; }
      .tl-empty p { font-size: 0.82rem; }

      /* ── Preview modal ── */
      #tl-preview-overlay {
        position: fixed; inset: 0; z-index: 800;
        background: rgba(0,0,0,0.65);
        display: none; align-items: center; justify-content: center;
      }
      #tl-preview-overlay.open { display: flex; }

      #tl-preview-modal {
        background: var(--surface, #1a1d27);
        border: 1px solid var(--border, #2a2d3a);
        border-radius: 12px;
        width: 90vw; max-width: 820px;
        max-height: 88vh;
        display: flex; flex-direction: column;
        overflow: hidden;
        box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      }

      .tl-pm-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border, #2a2d3a);
        display: flex; align-items: center; gap: 12px; flex-shrink: 0;
      }
      .tl-pm-title { flex: 1; min-width: 0; }
      .tl-pm-file {
        font-family: var(--mono, monospace); font-size: 0.82rem;
        font-weight: 600; color: var(--text, #e8e8f0);
        word-break: break-all;
      }
      .tl-pm-date {
        font-size: 0.7rem; color: var(--text-3, #55556a);
        font-family: var(--mono, monospace); margin-top: 3px;
      }

      .tl-pm-close {
        width: 32px; height: 32px; border-radius: 50%;
        background: transparent; border: 1px solid var(--border, #2a2d3a);
        cursor: pointer; display: flex; align-items: center;
        justify-content: center; color: var(--text-3, #55556a);
        transition: all 0.15s; flex-shrink: 0;
      }
      .tl-pm-close:hover { border-color: var(--text-2, #8888a0); color: var(--text, #e8e8f0); }
      .tl-pm-close svg { width: 14px; height: 14px; }

      .tl-pm-body {
        flex: 1; overflow: auto; padding: 0;
        background: #0d0e14;
      }
      .tl-pm-pre {
        font-family: var(--mono, monospace); font-size: 0.76rem;
        line-height: 1.65; color: #c9d1d9;
        padding: 20px; margin: 0;
        white-space: pre-wrap; word-break: break-all;
      }

      .tl-pm-footer {
        padding: 12px 20px;
        border-top: 1px solid var(--border, #2a2d3a);
        display: flex; align-items: center; justify-content: flex-end;
        gap: 8px; flex-shrink: 0;
      }

      /* ── Restore confirm modal ── */
      #tl-restore-overlay {
        position: fixed; inset: 0; z-index: 900;
        background: rgba(0,0,0,0.65);
        display: none; align-items: center; justify-content: center;
      }
      #tl-restore-overlay.open { display: flex; }

      #tl-restore-modal {
        background: var(--surface, #1a1d27);
        border: 1px solid var(--border, #2a2d3a);
        border-radius: 12px;
        width: 90vw; max-width: 440px;
        padding: 24px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      }
      .tl-rm-title {
        font-size: 1rem; font-weight: 700; color: var(--text, #e8e8f0);
        margin-bottom: 8px;
      }
      .tl-rm-sub {
        font-size: 0.8rem; color: var(--text-2, #8888a0);
        line-height: 1.6; margin-bottom: 20px;
      }
      .tl-rm-actions { display: flex; gap: 8px; justify-content: flex-end; }

      .tl-btn-cancel {
        background: var(--surface, #1a1d27);
        color: var(--text-2, #8888a0);
        border: 1px solid var(--border, #2a2d3a);
      }
      .tl-btn-cancel:hover { border-color: var(--text-2, #8888a0); color: var(--text, #e8e8f0); }

      /* ── Inline notice ── */
      #tl-notice {
        font-size: 0.76rem; padding: 8px 12px;
        border-radius: 6px; margin-bottom: 16px;
        display: none;
      }
      #tl-notice.ok { background: var(--green-dim, rgba(0,184,148,0.1)); color: var(--green, #00b894); }
      #tl-notice.err { background: var(--red-dim, rgba(229,62,62,0.08)); color: var(--red, #e53e3e); }
    `;
    document.head.appendChild(style);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  SIDEBAR BUTTON
   * ══════════════════════════════════════════════════════════════════════════ */

  function injectSidebarButton() {
    if (document.getElementById('sb-timeline-ext')) return;
    const sidebar = document.querySelector('aside.sidebar');
    if (!sidebar) { setTimeout(injectSidebarButton, 300); return; }

    const spacer = sidebar.querySelector('.sb-spacer');

    const btn = document.createElement('button');
    btn.className = 'sb-btn';
    btn.id = 'sb-timeline-ext';
    btn.title = 'Timeline';
    btn.innerHTML = `
      <!-- Clock / history icon -->
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="12 7 12 12 15 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="sb-tooltip">Timeline</span>
    `;
    btn.addEventListener('click', () => switchToTimeline());

    // Insert before the spacer (so it sits with the normal nav items)
    if (spacer) sidebar.insertBefore(btn, spacer);
    else sidebar.appendChild(btn);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  SECTION
   * ══════════════════════════════════════════════════════════════════════════ */

  function injectSection() {
    if (document.getElementById('section-timeline-ext')) return;
    const main = document.querySelector('main.main');
    if (!main) { setTimeout(injectSection, 300); return; }

    const sec = document.createElement('section');
    sec.className = 'section';
    sec.id = 'section-timeline-ext';
    sec.innerHTML = `
      <div class="section-header" style="margin-bottom:20px;">
        <div class="section-title">Timeline</div>
        <div class="section-sub">Every file save creates a snapshot. Browse, preview and restore previous versions.</div>
      </div>
      <div id="tl-notice"></div>
      <div id="tl-list-wrap"></div>
    `;
    main.appendChild(sec);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  RENDER PANEL
   * ══════════════════════════════════════════════════════════════════════════ */

  function renderTimelinePanel() {
    const wrap = document.getElementById('tl-list-wrap');
    if (!wrap) return;

    const snaps = loadSnapshots();
    if (!snaps.length) {
      wrap.innerHTML = `
        <div class="tl-empty">
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/>
            <polyline points="12 7 12 12 15 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
          <p>No snapshots yet. Open the <strong>File Manager</strong>, edit a file and save it — a snapshot of the previous version will appear here.</p>
        </div>`;
      return;
    }

    // Group by file path
    const groups = {};
    for (const snap of snaps) {
      if (!groups[snap.filePath]) groups[snap.filePath] = [];
      groups[snap.filePath].push(snap);
    }

    let html = '';
    for (const [filePath, list] of Object.entries(groups)) {
      html += `<div class="tl-file-group">
        <div class="tl-file-label">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.7"/>
            <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="1.7"/>
          </svg>
          ${escHtml(filePath)}
          <span style="font-size:0.62rem;opacity:0.55;font-weight:400;">(${list.length} snapshot${list.length !== 1 ? 's' : ''})</span>
        </div>`;

      for (const snap of list) {
        const virtualPath = `.pylex/extensions/timeline/${snap.filePath}-${new Date(snap.savedAt).getTime()}`;
        html += `
        <div class="tl-card" id="tl-card-${escHtml(snap.id)}">
          <div class="tl-card-icon">
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/>
              <polyline points="12 7 12 12 15 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="tl-card-info">
            <div class="tl-card-path">${escHtml(snap.filePath.split('/').pop())}</div>
            <div class="tl-card-date">${escHtml(fmtDate(snap.savedAt))}</div>
            <div class="tl-card-virtual">${escHtml(virtualPath)}</div>
          </div>
          <div class="tl-card-actions">
            <button class="tl-btn tl-btn-preview" onclick="window.__plxTimeline.openPreview('${escHtml(snap.id)}')">
              <svg viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/></svg>
              Preview
            </button>
            <button class="tl-btn tl-btn-restore" onclick="window.__plxTimeline.confirmRestore('${escHtml(snap.id)}')">
              <svg viewBox="0 0 24 24" fill="none"><polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Restore
            </button>
            <button class="tl-btn tl-btn-del" onclick="window.__plxTimeline.deleteSnap('${escHtml(snap.id)}')">
              <svg viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>`;
      }

      html += `</div>`;
    }

    wrap.innerHTML = html;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  PREVIEW MODAL
   * ══════════════════════════════════════════════════════════════════════════ */

  function injectPreviewModal() {
    if (document.getElementById('tl-preview-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tl-preview-overlay';
    el.innerHTML = `
      <div id="tl-preview-modal">
        <div class="tl-pm-header">
          <div class="tl-pm-title">
            <div class="tl-pm-file" id="tl-pm-file">—</div>
            <div class="tl-pm-date" id="tl-pm-date">—</div>
          </div>
          <button class="tl-pm-close" onclick="window.__plxTimeline.closePreview()">
            <svg viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="tl-pm-body">
          <pre class="tl-pm-pre" id="tl-pm-content"></pre>
        </div>
        <div class="tl-pm-footer">
          <button class="tl-btn tl-btn-restore" id="tl-pm-restore-btn" onclick="">
            <svg viewBox="0 0 24 24" fill="none"><polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Restore this version
          </button>
          <button class="tl-btn tl-btn-cancel" onclick="window.__plxTimeline.closePreview()">Close</button>
        </div>
      </div>`;
    el.addEventListener('click', function (e) {
      if (e.target === this) window.__plxTimeline.closePreview();
    });
    document.body.appendChild(el);
  }

  function openPreview(id) {
    const snap = loadSnapshots().find(s => s.id === id);
    if (!snap) return;
    document.getElementById('tl-pm-file').textContent = snap.filePath;
    document.getElementById('tl-pm-date').textContent = fmtDate(snap.savedAt);
    document.getElementById('tl-pm-content').textContent = snap.content;
    const restoreBtn = document.getElementById('tl-pm-restore-btn');
    restoreBtn.onclick = () => { closePreview(); confirmRestore(id); };
    document.getElementById('tl-preview-overlay').classList.add('open');
  }

  function closePreview() {
    document.getElementById('tl-preview-overlay').classList.remove('open');
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  RESTORE CONFIRM MODAL
   * ══════════════════════════════════════════════════════════════════════════ */

  function injectRestoreModal() {
    if (document.getElementById('tl-restore-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tl-restore-overlay';
    el.innerHTML = `
      <div id="tl-restore-modal">
        <div class="tl-rm-title">Restore snapshot?</div>
        <div class="tl-rm-sub" id="tl-rm-sub">
          This will overwrite the current file with the snapshot content and then
          <strong>delete the snapshot</strong> from Timeline.
        </div>
        <div class="tl-rm-actions">
          <button class="tl-btn tl-btn-cancel" onclick="window.__plxTimeline.closeRestore()">Cancel</button>
          <button class="tl-btn tl-btn-restore" id="tl-rm-confirm-btn">
            <svg viewBox="0 0 24 24" fill="none"><polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 .49-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Yes, restore
          </button>
        </div>
      </div>`;
    el.addEventListener('click', function (e) {
      if (e.target === this) closeRestore();
    });
    document.body.appendChild(el);
  }

  function confirmRestore(id) {
    const snap = loadSnapshots().find(s => s.id === id);
    if (!snap) return;
    document.getElementById('tl-rm-sub').innerHTML =
      `Overwrite <code style="font-family:var(--mono,monospace);background:var(--border,#2a2d3a);padding:1px 5px;border-radius:3px;">${escHtml(snap.filePath)}</code> with the snapshot from <strong>${escHtml(fmtDate(snap.savedAt))}</strong>? The snapshot will be removed from Timeline.`;
    const btn = document.getElementById('tl-rm-confirm-btn');
    btn.onclick = () => doRestore(id);
    document.getElementById('tl-restore-overlay').classList.add('open');
  }

  function closeRestore() {
    document.getElementById('tl-restore-overlay').classList.remove('open');
  }

  async function doRestore(id) {
    const snap = loadSnapshots().find(s => s.id === id);
    if (!snap) { closeRestore(); return; }

    const btn = document.getElementById('tl-rm-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }

    try {
      /* Write snapshot content back to the original file */
      const res = await fetch('/api/fs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: getUsername(),
          password: getPassword(),
          appName: getAppName(),
          appPassword: await getAppPass(),
          filePath: snap.filePath,
          content: snap.content,
        }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);

      /* Delete this snapshot */
      deleteSnapshot(id);

      /* If the editor currently has this file open, reload it */
      if (window.fmCurrentFile === snap.filePath && window._aceEditor) {
        window._aceEditor.setValue(snap.content, -1);
        window._aceEditor.scrollToLine(0, false, false);
        window._aceEditor.clearSelection();
      }

      closeRestore();
      renderTimelinePanel();
      tlNotice('Restored — ' + snap.filePath + ' has been reverted.', 'ok');

    } catch (e) {
      tlNotice('Restore failed: ' + e.message, 'err');
      closeRestore();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Yes, restore'; }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  DELETE SNAPSHOT
   * ══════════════════════════════════════════════════════════════════════════ */

  function deleteSnap(id) {
    deleteSnapshot(id);
    renderTimelinePanel();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  NOTICE BAR
   * ══════════════════════════════════════════════════════════════════════════ */

  function tlNotice(msg, type) {
    const el = document.getElementById('tl-notice');
    if (!el) return;
    el.textContent = msg;
    el.className = type;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  SECTION SWITCHING
   * ══════════════════════════════════════════════════════════════════════════ */

  function switchToTimeline() {
    /* Deactivate all existing sections via the native switchSection if it exists */
    if (typeof window.switchSection === 'function') {
      /* Call with a dummy name — this deactivates the current section */
      /* We then manually activate ours */
      try {
        // Deactivate the current active section & sidebar btn
        document.querySelectorAll('.section.active').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
      } catch (_) {}
    } else {
      document.querySelectorAll('.section.active').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
    }

    document.getElementById('section-timeline-ext').classList.add('active');
    document.getElementById('sb-timeline-ext').classList.add('active');
    renderTimelinePanel();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  PATCH native switchSection so clicking other sidebar items deactivates ours
   * ══════════════════════════════════════════════════════════════════════════ */

  function patchSwitchSection() {
    const orig = window.switchSection;
    if (!orig || orig.__tlPatched) return;
    window.switchSection = function (name) {
      const tlSection = document.getElementById('section-timeline-ext');
      const tlBtn = document.getElementById('sb-timeline-ext');
      if (tlSection) tlSection.classList.remove('active');
      if (tlBtn) tlBtn.classList.remove('active');
      return orig.apply(this, arguments);
    };
    window.switchSection.__tlPatched = true;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  PUBLIC API (exposed for onclick handlers in injected HTML)
   * ══════════════════════════════════════════════════════════════════════════ */

  window.__plxTimeline = {
    openPreview,
    closePreview,
    confirmRestore,
    closeRestore,
    deleteSnap,
  };

  /* ══════════════════════════════════════════════════════════════════════════
   *  INIT
   * ══════════════════════════════════════════════════════════════════════════ */

  function init() {
    injectStyles();
    injectSidebarButton();
    injectSection();
    injectPreviewModal();
    injectRestoreModal();
    patchSwitchSection();

    // Hook the save button — retry if the file manager section isn't open yet
    hookSaveButton();

    // Re-hook whenever the user switches to the Files section
    // (the button gets re-rendered sometimes)
    const observer = new MutationObserver(() => {
      const btn = document.getElementById('fm-save-btn');
      if (btn && !btn.dataset.timelineHooked) hookSaveButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[Pylex Timeline] Extension loaded ✓');
  }

})();
