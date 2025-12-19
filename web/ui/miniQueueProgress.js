import * as state from '../core/state.js';

const MINI_ID = 'nuvu-mini-queue-progress';
const POS_KEY = 'nuvu_mini_queue_pos_v1';

let overlayEl = null;
let pollTimer = null;
let idleTicks = 0;
let lastStatus = null;
let isDragging = false;
let activePointerId = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

async function cancelInstallFromMini() {
  const accessToken = window.localStorage.getItem('api_token');
  if (!accessToken) {
    throw new Error('api_token is required to cancel installs');
  }
  const email = state.currentUser?.email;
  if (!email) {
    throw new Error('user email is required to cancel installs');
  }

  const resp = await fetch('/nuvu/execute/cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ user_email: email })
  });

  if (!resp.ok) {
    throw new Error(`Cancel failed: ${resp.status}`);
  }
}

function isQueueActive(s) {
  if (!s) return false;
  return Boolean(
    s.is_processing ||
    (s.running_count || 0) > 0 ||
    (s.queue_size || 0) > 0 ||
    (s.in_progress_count || 0) > 0
  );
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadPosition() {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const left = Number(parsed.left);
    const top = Number(parsed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}

function savePosition(left, top) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // ignore
  }
}

function ensureOverlay() {
  if (overlayEl && document.getElementById(MINI_ID) === overlayEl) return overlayEl;

  overlayEl = document.getElementById(MINI_ID);
  if (overlayEl) return overlayEl;

  const el = document.createElement('div');
  el.id = MINI_ID;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `
    position: fixed;
    z-index: 10001;
    width: 360px;
    max-width: calc(100vw - 24px);
    background: #121212;
    border: 1px solid #272727;
    border-radius: 10px;
    color: #f5f5f5;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    display: none;
    user-select: none;
  `;

  el.innerHTML = `
    <div data-role="header" style="
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: move;
      border-bottom: 1px solid #272727;
      background: #0b0b0b;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
    ">
      <div style="font-weight: 700; font-size: 12px; letter-spacing: 0.08em; opacity: 0.9;">
        nuvu Installer
      </div>
      <button data-role="open" type="button" style="
        border: 1px solid #ffffff;
        background: #ffffff;
        color: #000000;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      ">Open</button>
    </div>
    <div data-role="body" style="padding: 10px 12px;">
      <div data-role="summary" style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">Working...</div>
      <div data-role="file" style="font-size: 12px; opacity: 0.8; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></div>
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="flex: 1; height: 8px; background: #050505; border-radius: 4px; overflow: hidden;">
          <div data-role="bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #22c55e, #4ade80); transition: width 0.3s ease;"></div>
        </div>
        <button data-role="cancel" type="button" title="Cancel install" aria-label="Cancel install" style="
          border: none;
          background: #d14e72;
          color: #ffffff;
          border-radius: 6px;
          width: 26px;
          height: 26px;
          line-height: 26px;
          font-size: 16px;
          font-weight: 900;
          cursor: pointer;
          padding: 0;
        ">×</button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  overlayEl = el;

  const openBtn = el.querySelector('[data-role="open"]');
  if (openBtn) {
    openBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    openBtn.addEventListener('click', () => {
      if (typeof state.opennuvuDialog === 'function') {
        state.opennuvuDialog();
      }
    });
  }

  const cancelBtn = el.querySelector('[data-role="cancel"]');
  if (cancelBtn) {
    cancelBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    cancelBtn.addEventListener('mouseenter', () => {
      try {
        cancelBtn.style.background = '#b53f60';
      } catch {
      }
    });
    cancelBtn.addEventListener('mouseleave', () => {
      try {
        cancelBtn.style.background = '#d14e72';
      } catch {
      }
    });
    cancelBtn.addEventListener('click', async () => {
      try {
        cancelBtn.disabled = true;
        cancelBtn.style.opacity = '0.7';
        await cancelInstallFromMini();
        // Force a refresh so UI responds quickly after cancel.
        await pollOnce();
      } catch {
        // ignore (user may not be authenticated or backend may reject)
      } finally {
        try {
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '1';
        } catch {
          // ignore
        }
      }
    });
  }

  const header = el.querySelector('[data-role="header"]');
  if (header) {
    header.addEventListener('pointerdown', (ev) => {
      if (!overlayEl) return;
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;

      ev.preventDefault();
      isDragging = true;
      activePointerId = ev.pointerId;
      try {
        header.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      const rect = overlayEl.getBoundingClientRect();
      dragOffsetX = ev.clientX - rect.left;
      dragOffsetY = ev.clientY - rect.top;
    });

    header.addEventListener('pointermove', (ev) => {
      if (!overlayEl || !isDragging) return;
      if (activePointerId !== ev.pointerId) return;
      const newLeft = Math.max(12, Math.min(window.innerWidth - overlayEl.offsetWidth - 12, ev.clientX - dragOffsetX));
      const newTop = Math.max(12, Math.min(window.innerHeight - overlayEl.offsetHeight - 12, ev.clientY - dragOffsetY));
      overlayEl.style.left = `${newLeft}px`;
      overlayEl.style.top = `${newTop}px`;
      overlayEl.style.right = 'auto';
      overlayEl.style.bottom = 'auto';
    });

    const stopDrag = () => {
      if (!overlayEl) return;
      isDragging = false;
      activePointerId = null;
      const rect = overlayEl.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    };

    header.addEventListener('pointerup', (ev) => {
      if (activePointerId !== ev.pointerId) return;
      stopDrag();
    });

    header.addEventListener('pointercancel', () => {
      isDragging = false;
      activePointerId = null;
    });

    // Fallback: if pointerup is missed, ensure we stop dragging.
    document.addEventListener('pointerup', () => {
      if (!isDragging) return;
      stopDrag();
    });
  }

  // Set initial position
  const pos = loadPosition();
  if (pos) {
    overlayEl.style.left = `${pos.left}px`;
    overlayEl.style.top = `${pos.top}px`;
    overlayEl.style.right = 'auto';
    overlayEl.style.bottom = 'auto';
  } else {
    // Default: bottom-right-ish
    overlayEl.style.right = '12px';
    overlayEl.style.bottom = '88px';
  }

  return overlayEl;
}

function setVisible(visible) {
  const el = ensureOverlay();
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function renderStatus(status) {
  const el = ensureOverlay();
  if (!el) return;

  const p = status?.download_progress || null;
  const summaryEl = el.querySelector('[data-role="summary"]');
  const fileEl = el.querySelector('[data-role="file"]');
  const barEl = el.querySelector('[data-role="bar"]');

  const summaryText = (() => {
    if (!p) return 'Working...';
    if (p.message) return p.message;
    if (p.current_phase) return `Working: ${p.current_phase}`;
    return 'Working...';
  })();

  const fileText = (() => {
    if (!p) return '';
    const fname = typeof p.filename === 'string' ? p.filename : '';
    if (!fname) return '';
    const raw = Number(p.percent || 0);
    if (Number.isFinite(raw) && raw > 0) {
      let t = `${fname}: ${Math.round(raw)}%`;
      if (p.downloaded && p.total) {
        t += ` (${p.downloaded}/${p.total})`;
      }
      return t;
    }
    return fname;
  })();

  const percent = (() => {
    if (!p) return 0;
    const raw = Number(p.percent || 0);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.max(0, Math.min(100, raw));
    }
    return 0;
  })();

  if (summaryEl) summaryEl.textContent = summaryText;
  if (fileEl) fileEl.textContent = fileText;
  if (barEl) barEl.style.width = `${percent}%`;
}

async function pollOnce() {
  const resp = await fetch('/nuvu/queue/status', { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`Queue status failed: ${resp.status}`);
  }
  lastStatus = await resp.json();
  renderStatus(lastStatus);
  return lastStatus;
}

function stopPolling() {
  idleTicks = 0;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPollingWhileHiddenIfActive() {
  // Only poll while hidden; this avoids any idle polling when dialog is open.
  if (pollTimer) return;

  idleTicks = 0;
  pollTimer = setInterval(async () => {
    try {
      const s = await pollOnce();
      if (isQueueActive(s)) {
        idleTicks = 0;
        setVisible(true);
      } else {
        idleTicks += 1;
        // Give it one extra cycle to allow summary to arrive.
        if (idleTicks >= 2) {
          setVisible(false);
          stopPolling();
        }
      }
    } catch {
      // If we can't poll, stop to avoid noisy loops.
      setVisible(false);
      stopPolling();
    }
  }, 1000);
}

async function onDialogClose() {
  // On hide, do a single poll and only start an interval if something is active.
  try {
    const s = await pollOnce();
    if (isQueueActive(s)) {
      setVisible(true);
      startPollingWhileHiddenIfActive();
    } else {
      setVisible(false);
      stopPolling();
    }
  } catch {
    setVisible(false);
    stopPolling();
  }
}

function onDialogOpen() {
  // When dialog is open, keep this overlay out of the way.
  isDragging = false;
  activePointerId = null;
  setVisible(false);
  stopPolling();
}

export function initializeMiniQueueProgress() {
  ensureOverlay();
  setVisible(false);

  window.addEventListener('nuvu-vue-close', onDialogClose);
  window.addEventListener('nuvu-vue-open', onDialogOpen);
}



