// chat-audit-pull, part 2 of 3: the triage page's stylesheet and client script, inlined into
// conversations.html by renderHtml. Plain strings with no interpolation. Moved verbatim from chat-audit-pull.ts.

  export const styles = `
    :root {
      --bg: #fafaf7;
      --text: #1a1a1a;
      --muted: #6b6b6b;
      --border: #e3e3df;
      --primary: #2b5fb0;
      --accent: #b06a2b;
      --success: #2f7a4d;
      --warn: #b07a1a;
      --fail: #a23b3b;
      --card-bg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text); background: var(--bg);
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
    h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
    .subtitle { color: var(--muted); margin: 0 0 24px; font-size: 13px; }

    .topbar {
      position: sticky; top: 0; z-index: 10;
      background: var(--bg);
      padding-bottom: 12px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .stats { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0 12px; font-size: 13px; color: var(--muted); }
    .stats strong { color: var(--text); font-weight: 600; }
    .triage-counter { font-weight: 600; color: var(--text); }
    .triage-counter .ok { color: var(--success); }
    .triage-counter .warn { color: var(--warn); }
    .triage-counter .fail { color: var(--fail); }

    .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .controls input[type="search"], .controls select {
      padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px;
      font: inherit; background: white;
    }
    .controls input[type="search"] { flex: 1; min-width: 200px; }
    .controls label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
    .export-btn {
      padding: 6px 12px; border: 1px solid var(--primary); background: white; color: var(--primary);
      border-radius: 6px; cursor: pointer; font: inherit;
    }
    .export-btn:hover { background: var(--primary); color: white; }

    .conv {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 4px solid var(--user-tint, transparent);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .conv-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; cursor: pointer; gap: 12px;
    }
    .conv-header:hover { background: rgba(0,0,0,0.02); }
    .conv-header:focus { outline: 2px solid var(--primary); outline-offset: -2px; }
    .conv-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
    .conv-header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .conv-num { color: var(--muted); font-weight: 600; font-size: 12px; }
    .platform-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
      white-space: nowrap;
    }
    .platform-shopify { background: #e8f4ff; color: #2b5fb0; }
    .platform-widget { background: #e6f7ee; color: #1e7a4a; }
    .platform-discord { background: #ecebff; color: #5865F2; }
    .platform-youtube { background: #ffeaea; color: #c4302b; }
    .conv-snippet {
      color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      flex: 1; min-width: 0;
    }
    .turn-count { font-size: 12px; }
    .router-err-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
      background: #ffe8e8; color: var(--fail); white-space: nowrap;
    }
    .fallback-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;
      background: var(--fail); color: white; white-space: nowrap; letter-spacing: 0.3px;
    }
    .router-skip-badge {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
      background: #fdf3e6; color: #b06a2b; white-space: nowrap;
    }
    .classifier-badge {
      display: inline-block; padding: 1px 6px; margin-right: 6px;
      border-radius: 3px; font-size: 10.5px; font-weight: 600;
      font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.2px;
    }
    .classifier-skip { background: #fdf3e6; color: #b06a2b; }
    .classifier-route { background: #eef4fc; color: var(--primary); }
    .conv-triage[data-conv-triage]:not(:empty) {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
    }
    .conv-toggle { color: var(--muted); transition: transform 150ms; }
    .conv[data-expanded="1"] .conv-toggle { transform: rotate(180deg); }

    .conv-body { padding: 0 16px 16px; border-top: 1px solid var(--border); background: var(--user-tint, transparent); }
    .conv-meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 12px 0; font-size: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }

    .turn { padding: 12px; margin: 0 0 8px; background: white; border-radius: 6px; }
    .turn-user { background: #f6f5f1; }
    .turn-assistant { background: white; }
    .turn-fallback { background: #fff2f2; border: 1px solid var(--fail); }
    .turn-header { display: flex; gap: 12px; font-size: 12px; margin-bottom: 6px; }
    .turn-role { font-weight: 600; color: var(--text); }
    .turn-time { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    .muted { color: var(--muted); }
    .router-meta { font-size: 12px; margin: 4px 0; }
    .handle {
      display: inline-block; padding: 1px 6px; margin: 0 2px; border-radius: 3px;
      background: #eef4fc; color: var(--primary); font-family: ui-monospace, monospace; font-size: 11px;
    }
    .handle.empty { background: #f0f0f0; color: var(--muted); }
    .router-error { color: var(--fail); margin-left: 8px; font-weight: 500; }
    .model-meta { font-size: 11px; margin: 2px 0 8px; font-family: ui-monospace, monospace; }
    .turn-content { font-size: 14px; line-height: 1.55; max-width: 75ch; }
    .turn-content p { margin: 0.6em 0; }
    .turn-content p:first-child { margin-top: 0; }
    .turn-content p:last-child { margin-bottom: 0; }
    .turn-content .msg-h { margin: 0.8em 0 0.3em; font-weight: 600; }
    .turn-content h3 { font-size: 16px; }
    .turn-content h4, .turn-content h5, .turn-content h6 { font-size: 14px; }
    .turn-content ul, .turn-content ol { margin: 0.5em 0; padding-left: 1.6em; }
    .turn-content li { margin: 0.15em 0; }
    .turn-content code {
      font: 12.5px ui-monospace, "SF Mono", Menlo, monospace;
      background: #f1efe9; padding: 1px 5px; border-radius: 3px;
    }
    .turn-content pre {
      background: #f1efe9; padding: 10px 12px; border-radius: 6px;
      overflow-x: auto; font-size: 12.5px;
    }
    .turn-content pre code { background: none; padding: 0; }
    .turn-content a { color: var(--primary); }

    .triage { display: flex; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); align-items: center; flex-wrap: wrap; }
    .triage-btn {
      width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border);
      background: white; cursor: pointer; font-weight: 700; font-size: 13px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .triage-btn:hover { transform: scale(1.05); }
    .triage-btn.clean { color: var(--success); }
    .triage-btn.warn { color: var(--warn); }
    .triage-btn.fail { color: var(--fail); }
    .triage-btn[aria-pressed="true"].clean { background: var(--success); color: white; border-color: var(--success); }
    .triage-btn[aria-pressed="true"].warn { background: var(--warn); color: white; border-color: var(--warn); }
    .triage-btn[aria-pressed="true"].fail { background: var(--fail); color: white; border-color: var(--fail); }
    .dim-select { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; background: white; }
    .dim-select:disabled { opacity: 0.4; }

    .conv-triage.t-clean { background: var(--success); color: white; }
    .conv-triage.t-warn { background: var(--warn); color: white; }
    .conv-triage.t-fail { background: var(--fail); color: white; }

    .hidden { display: none !important; }

    @media (max-width: 720px) {
      .container { padding: 16px 10px 60px; }
      .conv-header { flex-wrap: wrap; }
      .conv-snippet { width: 100%; flex: 0 0 auto; padding-top: 4px; }
      .turn-content { font-size: 13px; }
      .controls { flex-direction: column; align-items: stretch; }
      .controls input[type="search"] { width: 100%; }
    }
  `;

  export const script = `
    (function () {
      const STORAGE_KEY = 'chat-audit-triage-v1';
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const assistantTurns = document.querySelectorAll('.triage[data-msg-id]');
      const totalAssistant = assistantTurns.length;

      function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

      function updateCounter() {
        let c = 0, w = 0, f = 0;
        for (const id in state) {
          if (state[id].triage === 'clean') c++;
          else if (state[id].triage === 'warn') w++;
          else if (state[id].triage === 'fail') f++;
        }
        const reviewed = c + w + f;
        document.getElementById('counter').innerHTML =
          'Reviewed: <strong>' + reviewed + ' / ' + totalAssistant + '</strong>' +
          ' · <span class="ok">✓ ' + c + '</span>' +
          ' · <span class="warn">! ' + w + '</span>' +
          ' · <span class="fail">✗ ' + f + '</span>';
        document.querySelectorAll('.conv').forEach(updateConvBadge);
      }

      function updateConvBadge(conv) {
        const turns = conv.querySelectorAll('.triage[data-msg-id]');
        let worst = null;
        for (const t of turns) {
          const id = t.dataset.msgId;
          const s = state[id]?.triage;
          if (s === 'fail') { worst = 'fail'; break; }
          if (s === 'warn' && worst !== 'fail') worst = 'warn';
          if (s === 'clean' && !worst) worst = 'clean';
        }
        const badge = conv.querySelector('[data-conv-triage]');
        badge.className = 'conv-triage';
        if (worst === 'clean') { badge.classList.add('t-clean'); badge.textContent = '✓'; }
        else if (worst === 'warn') { badge.classList.add('t-warn'); badge.textContent = '!'; }
        else if (worst === 'fail') { badge.classList.add('t-fail'); badge.textContent = '✗'; }
        else { badge.textContent = ''; }
      }

      function applyState(triage) {
        const id = triage.dataset.msgId;
        const saved = state[id] || {};
        triage.querySelectorAll('.triage-btn').forEach(btn => {
          btn.setAttribute('aria-pressed', btn.dataset.state === saved.triage ? 'true' : 'false');
        });
        const sel = triage.querySelector('.dim-select');
        sel.value = saved.dimension || '';
        sel.disabled = saved.triage !== 'warn' && saved.triage !== 'fail';
      }

      assistantTurns.forEach(triage => {
        applyState(triage);
        triage.querySelectorAll('.triage-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = triage.dataset.msgId;
            const wantState = btn.dataset.state;
            const cur = state[id]?.triage;
            if (cur === wantState) { delete state[id]; }
            else { state[id] = { ...(state[id] || {}), triage: wantState }; }
            saveState();
            applyState(triage);
            updateCounter();
          });
        });
        triage.querySelector('.dim-select').addEventListener('change', e => {
          const id = triage.dataset.msgId;
          state[id] = { ...(state[id] || {}), dimension: e.target.value || undefined };
          if (!state[id].triage && !state[id].dimension) delete state[id];
          saveState();
        });
      });

      // Collapse / expand
      document.querySelectorAll('.conv-header').forEach(h => {
        const toggle = () => {
          const conv = h.closest('.conv');
          const body = conv.querySelector('.conv-body');
          const expanded = body.hidden === false;
          body.hidden = expanded;
          conv.dataset.expanded = expanded ? '0' : '1';
          h.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        };
        h.addEventListener('click', toggle);
        h.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });

      // Filters
      const searchInput = document.getElementById('search');
      const platformSel = document.getElementById('platform-filter');
      const triageSel = document.getElementById('triage-filter');
      const routerErrChk = document.getElementById('router-err-only');
      const fallbackChk = document.getElementById('fallback-only');
      const routerSkippedChk = document.getElementById('router-skipped-only');

      function applyFilters() {
        const q = searchInput.value.toLowerCase();
        const plat = platformSel.value;
        const triageF = triageSel.value;
        const errOnly = routerErrChk.checked;
        const fbOnly = fallbackChk.checked;
        const skipOnly = routerSkippedChk.checked;

        document.querySelectorAll('.conv').forEach(conv => {
          let show = true;
          if (plat !== 'all' && conv.dataset.platform !== plat) show = false;
          if (errOnly && conv.dataset.routerError !== '1') show = false;
          if (fbOnly && conv.dataset.fallback !== '1') show = false;
          if (skipOnly && conv.dataset.routerSkipped !== '1') show = false;
          if (q && !conv.textContent.toLowerCase().includes(q)) show = false;
          if (triageF !== 'all') {
            const turns = conv.querySelectorAll('.triage[data-msg-id]');
            const states = [...turns].map(t => state[t.dataset.msgId]?.triage || 'none');
            const has = (s) => states.includes(s);
            if (triageF === 'unreviewed' && !has('none')) show = false;
            if (triageF === 'clean' && !has('clean')) show = false;
            if (triageF === 'warn' && !has('warn')) show = false;
            if (triageF === 'fail' && !has('fail')) show = false;
          }
          conv.classList.toggle('hidden', !show);
        });
      }
      searchInput.addEventListener('input', applyFilters);
      platformSel.addEventListener('change', applyFilters);
      triageSel.addEventListener('change', applyFilters);
      routerErrChk.addEventListener('change', applyFilters);
      fallbackChk.addEventListener('change', applyFilters);
      routerSkippedChk.addEventListener('change', applyFilters);

      // Export
      document.getElementById('export-btn').addEventListener('click', () => {
        const lines = ['# Triage summary — ' + new Date().toISOString().slice(0, 10), ''];
        let c = 0, w = 0, f = 0;
        const fails = [];
        const warns = [];
        document.querySelectorAll('.triage[data-msg-id]').forEach(triage => {
          const id = triage.dataset.msgId;
          const s = state[id];
          if (!s?.triage) return;
          if (s.triage === 'clean') c++;
          else if (s.triage === 'warn') { w++; warns.push({ id, dim: s.dimension }); }
          else if (s.triage === 'fail') { f++; fails.push({ id, dim: s.dimension }); }
        });
        lines.push('**Counts:** ✓ ' + c + '  ·  ⚠ ' + w + '  ·  ✗ ' + f);
        lines.push('');
        if (fails.length) {
          lines.push('## ❌ Failures');
          fails.forEach(x => lines.push('- ' + x.id + (x.dim ? ' — ' + x.dim : '')));
          lines.push('');
        }
        if (warns.length) {
          lines.push('## ⚠️ Borderlines');
          warns.forEach(x => lines.push('- ' + x.id + (x.dim ? ' — ' + x.dim : '')));
        }
        const text = lines.join('\\n');
        navigator.clipboard.writeText(text).then(() => {
          const btn = document.getElementById('export-btn');
          const old = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = old; }, 1200);
        });
      });

      updateCounter();
    })();
  `;
