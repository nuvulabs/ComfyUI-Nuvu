/**
 * Splash/Dialog opener
 * 
 * This module just opens the dialog - all initialization 
 * is handled by preload.js on ComfyUI startup.
 */

import * as state from '../core/state.js';
import { handleWebsiteCallbackFromUrl } from '../auth/oauth.js';
import { createSplashDialog, updateDialogForLogin, updateDialogForAuthenticated } from './dialog.js';

let currentDialogBuild = null;

export async function shownuvuSplash() {
    // Handle OAuth callback if present in URL
    if (window.location.search.includes('token=') || window.location.hash.includes('token=')) {
        try {
            handleWebsiteCallbackFromUrl(updateDialogForAuthenticated);
        } catch (error) {
        }
    }
    
    // If dialog already exists, just show it (keep Vue mounted).
    if (state.nuvuDialog) {
        try {
            state.nuvuDialog.style.display = 'flex';
            state.nuvuDialog.removeAttribute('aria-hidden');
            requestAnimationFrame(() => {
                try {
                    state.nuvuDialog.classList.add('nuvu-open');
                } catch (error) {
                }
            });
        } catch (error) {
        }
        try {
            window.dispatchEvent(new CustomEvent('nuvu-vue-open'));
        } catch (error) {
        }
        return;
    }

    // Wait for any previous dialog build
    if (currentDialogBuild) {
        try {
            await currentDialogBuild;
        } catch (error) {
        }
    }
    
    // Build and mount new dialog
    const buildPromise = buildAndMountDialog();
    currentDialogBuild = buildPromise;
    
    try {
        await buildPromise;
    } catch (error) {
        clearExistingDialog();
        throw error;
    } finally {
        if (currentDialogBuild === buildPromise) {
            currentDialogBuild = null;
        }
    }

    try {
        window.dispatchEvent(new CustomEvent('nuvu-vue-open'));
    } catch (error) {
    }
}

async function buildAndMountDialog() {
    // Another open call might have created it while we awaited.
    if (state.nuvuDialog) {
        try {
            state.nuvuDialog.style.display = 'flex';
            state.nuvuDialog.removeAttribute('aria-hidden');
        } catch (error) {
        }
        return;
    }
    const { dialog, body } = createSplashDialog();
    document.body.appendChild(dialog);
    state.setnuvuDialog(dialog);
    try {
        requestAnimationFrame(() => {
            try {
                dialog.classList.add('nuvu-open');
            } catch (error) {
            }
        });
    } catch (error) {
    }
    
    // Show appropriate view based on current auth state
    // Auth state was already set by preload.js on startup
    if (state.isAuthenticated) {
        await updateDialogForAuthenticated();
    } else {
        await updateDialogForLogin();
    }
}

function clearExistingDialog() {
    const existingDialogs = document.querySelectorAll('.nuvu-splash-dialog');
    existingDialogs.forEach(dialog => {
        // Keep the active dialog (if any) mounted; remove stray duplicates.
        if (state.nuvuDialog && dialog === state.nuvuDialog) {
            return;
        }
        try {
            if (dialog.parentElement) {
                dialog.parentElement.removeChild(dialog);
            } else {
                dialog.remove();
            }
        } catch (error) {
        }
    });
}

