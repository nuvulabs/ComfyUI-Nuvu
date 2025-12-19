// System prompts for post-restart reconnection flow
// This modal appears OUTSIDE the Vue dialog when server reconnects after restart

import { Modal } from './components/Modal.js';
import { div } from './components/core.js';
import { Button } from './components/Button.js';
import * as state from '../core/state.js';

const MODAL_KEY = 'post-restart-refresh';
const SPLASH_FLAG_KEY = 'nuvu_show_splash_after_refresh';

function setSplashFlag() {
    try {
        window.localStorage.setItem(SPLASH_FLAG_KEY, 'true');
    } catch (error) {
    }
}

function modalExists(key) {
    return Boolean(document.querySelector(`[data-nuvu-modal="${key}"]`));
}

function mountModal(overlay, key) {
    overlay.dataset.nuvuModal = key;
    document.body.appendChild(overlay);
}

function removeModal(overlay) {
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

/**
 * Show post-restart refresh prompt
 * Called when server reconnects after a restart
 */
export function showPostRestartRefreshPrompt() {
    state.setPendingRefreshAfterRestart(false);

    if (modalExists(MODAL_KEY)) {
        return;
    }

    let overlay = null;
    const close = () => {
        removeModal(overlay);
        overlay = null;
    };

    const refreshButton = Button({
        text: 'Refresh Now',
        variant: 'secondary',
        id: 'nuvu-post-restart-refresh',
        onClick: () => {
            setSplashFlag();
            window.location.reload();
        }
    });

    const laterButton = Button({
        text: 'Later',
        variant: 'primary',
        id: 'nuvu-post-restart-refresh-later',
        onClick: close
    });

    overlay = Modal({
        title: 'Restart Complete',
        maxWidth: '520px',
        onClose: close,
        showCloseButton: false,
        children: [
            div(
                { className: 'nuvu-modal-message' },
                'ComfyUI is back online. Refresh this tab to continue.'
            ),
            div({ className: 'nuvu-modal-actions' }, laterButton, refreshButton)
        ]
    });

    mountModal(overlay, MODAL_KEY);
}

