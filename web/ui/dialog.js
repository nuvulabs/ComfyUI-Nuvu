// Main dialog creation and management
// Now uses Vue for UI rendering

import * as state from '../core/state.js';

// Derive the extension base URL dynamically so paths work regardless of folder name
const EXTENSION_BASE_URL = new URL('..', import.meta.url).href;

// Load Vue app CSS
try {
    const vueStyles = document.createElement('link');
    vueStyles.rel = 'stylesheet';
    vueStyles.href = new URL('vue/comfyui-nuvu.css', EXTENSION_BASE_URL).href;
    document.head.appendChild(vueStyles);
} catch (e) {
}

// Legacy imports - kept but not used, can be removed later
// import { createLoginForm } from './loginForm.js';
// import { createUpdateInterface } from './updateInterface.js';
// import { createCloseButton } from './components/CloseButton.js';
// import { cancelWorkflowsFetch } from '../workflows/api.js';
// import { cancelModelsFetch } from '../models/api.js';

// Vue app reference
let vueAppModule = null;
let vueCloseHandlerRegistered = false;
const DIALOG_ANIM_MS = 180;

function showDialogAnimated(dialog) {
    if (!dialog) return;
    dialog.style.display = 'flex';
    dialog.removeAttribute('aria-hidden');
    requestAnimationFrame(() => {
        try {
            dialog.classList.add('nuvu-open');
        } catch (e) {
        }
    });
}

function hideDialogAnimated(dialog) {
    if (!dialog) return;
    try {
        dialog.classList.remove('nuvu-open');
    } catch (e) {
    }
    dialog.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
        try {
            dialog.style.display = 'none';
        } catch (e) {
        }
    }, DIALOG_ANIM_MS);
}

async function loadVueApp() {
    if (!vueAppModule) {
        try {
            vueAppModule = await import('../vue/nuvu.js');
        } catch (error) {
            return null;
        }
    }
    return vueAppModule;
}

export function createSplashDialog() {
    const dialog = document.createElement("div");
    dialog.className = "nuvu-splash-dialog";
    dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.15);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.3s ease-out;
        pointer-events: auto;
    `;
    
    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        @keyframes slideIn {
            from { transform: scale(0.9) translateY(-20px); opacity: 0; }
            to { transform: scale(1) translateY(0); opacity: 1; }
        }
        /* Fun zoom in/out on show/hide (keeps Vue mounted) */
        .nuvu-splash-dialog {
            opacity: 0;
            transition: opacity ${DIALOG_ANIM_MS}ms ease;
        }
        .nuvu-splash-dialog.nuvu-open {
            opacity: 1;
        }
        .nuvu-splash-dialog .nuvu-modern-card {
            transform: scale(0.92) translateY(10px);
            transition: transform ${DIALOG_ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity ${DIALOG_ANIM_MS}ms ease;
        }
        .nuvu-splash-dialog.nuvu-open .nuvu-modern-card {
            transform: scale(1) translateY(0);
        }
        .nuvu-modern-card {
            background: #1a1a1a;
            border: 1px solid rgba(160, 187, 196, 0.2);
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(32, 44, 57, 0.3);
            transition: all 0.3s ease;
        }
        .nuvu-modern-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 25px 50px rgba(32, 44, 57, 0.4);
        }
        .nuvu-modern-button {
            background: #D14E72;
            border: none;
            border-radius: 8px;
            color: #F0F0F0;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-modern-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(209, 78, 114, 0.4);
        }
        .nuvu-modern-button:active {
            transform: translateY(0);
        }
        .nuvu-accent-button {
            background: #A0BBC4;
            border: none;
            border-radius: 8px;
            color: #202C39;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-accent-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(160, 187, 196, 0.4);
        }
        .nuvu-success-button {
            background: #D14E72;
            border: none;
            border-radius: 8px;
            color: #F0F0F0;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-success-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(209, 78, 114, 0.4);
        }
    `;
    document.head.appendChild(style);
    
    const content = document.createElement("div");
    content.className = "nuvu-modern-card";
    content.style.cssText = `
        background: #1a1a1a;
        border: 1px solid rgba(160, 187, 196, 0.2);
        border-radius: 16px;
        width: 95vw;
        height: 90vh;
        max-width: 1440px;
        max-height: 90vh;
        overflow: hidden;
        box-shadow: 0 20px 40px rgba(32, 44, 57, 0.5);
        display: flex;
        flex-direction: column;
        animation: slideIn 0.4s ease-out;
        position: relative;
    `;
    
    const body = document.createElement("div");
    body.id = "nuvu-dialog-body";
    body.style.cssText = `
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        align-items: stretch;
        justify-content: flex-start;
        min-height: 0;
        position: relative;
    `;
    
    content.appendChild(body);
    dialog.appendChild(content);
    
    const closeOverlay = () => {
        // Use the same close path as the Vue close button so the mini installer appears.
        try {
            window.dispatchEvent(new CustomEvent('nuvu-vue-close'));
        } catch (e) {
        }
    };
    
    // Close on background click
    dialog.onclick = (e) => {
        if (e.target === dialog) {
            closeOverlay();
        }
    };

    // Start visible (mount-time) with zoom.
    showDialogAnimated(dialog);
    
    return { dialog, body };
}

export async function updateDialogForLogin() {
    if (!state.nuvuDialog) return;
    const body = state.nuvuDialog.querySelector("#nuvu-dialog-body");
    // Ensure mount point exists once
    let vueMount = body.querySelector('#nuvu-vue-app');
    if (!vueMount) {
        body.innerHTML = "";
        body.style.cssText = `
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-height: 0;
            position: relative;
            width: 100%;
            height: 100%;
        `;
        vueMount = document.createElement('div');
        vueMount.id = 'nuvu-vue-app';
        vueMount.style.cssText = 'width: 100%; height: 100%;';
        body.appendChild(vueMount);
    }

    // Load and mount Vue app once; after that just switch view
    const vueApp = await loadVueApp();
    if (vueApp) {
        if (!vueApp.isNuvuAppMounted || !vueApp.isNuvuAppMounted()) {
            vueApp.mountNuvuApp('#nuvu-vue-app', { view: 'login' });
        } else if (vueApp.setNuvuView) {
            vueApp.setNuvuView('login');
        }
        setupVueCloseHandler();
    }
}

export async function updateDialogForAuthenticated() {
    if (!state.nuvuDialog) return;
    const body = state.nuvuDialog.querySelector("#nuvu-dialog-body");
    // Ensure mount point exists once
    let vueMount = body.querySelector('#nuvu-vue-app');
    if (!vueMount) {
        body.innerHTML = "";
        body.style.cssText = `
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-height: 0;
            position: relative;
            width: 100%;
            height: 100%;
        `;
        vueMount = document.createElement('div');
        vueMount.id = 'nuvu-vue-app';
        vueMount.style.cssText = 'width: 100%; height: 100%;';
        body.appendChild(vueMount);
    }

    const vueApp = await loadVueApp();
    if (vueApp) {
        if (!vueApp.isnuvuAppMounted || !vueApp.isnuvuAppMounted()) {
            vueApp.mountnuvuApp('#nuvu-vue-app', {
                view: 'dashboard',
                user: state.currentUser,
                licenseStatus: state.currentLicenseStatus
            });
        } else {
            // Keep app mounted; just ensure we're on the dashboard; do not reset app state.
            if (vueApp.setnuvuView) {
                vueApp.setnuvuView('dashboard');
            }
        }
        setupVueCloseHandler();
    }
}

function setupVueCloseHandler() {
    if (vueCloseHandlerRegistered) {
        return;
    }

    const closeHandler = () => {
        // Keep mounted; animate out then hide.
        hideDialogAnimated(state.nuvuDialog);
    };

    window.addEventListener('nuvu-vue-close', closeHandler);
    vueCloseHandlerRegistered = true;
}

// Legacy test functions removed - Vue is now the default

