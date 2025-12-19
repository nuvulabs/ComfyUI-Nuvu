import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { fetchConfig } from './core/config.js';
import * as state from './core/state.js';
import { handleWebsiteCallbackFromUrl, handlePopupAuthResult } from './auth/oauth.js';
// Dialog and splash - used for mounting Vue app
import { updateDialogForLogin, updateDialogForAuthenticated } from './ui/dialog.js';
import { shownuvuSplash } from './ui/splash.js';
import { showPostRestartRefreshPrompt } from './ui/systemPrompts.js';
import { initialize as initializePreload } from './core/preload.js';
import { initializeMiniQueueProgress } from './ui/miniQueueProgress.js';

// Derive the extension base URL dynamically so paths work regardless of folder name
const EXTENSION_BASE_URL = new URL('.', import.meta.url).href;

// Load CSS file
function loadnuvuCSS() {
    const cssPath = new URL('./nuvu.css', import.meta.url).href;
    
    // Check if already loaded
    if (!document.querySelector(`link[href="${cssPath}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = cssPath;
        document.head.appendChild(link);
    }
}

// Load CSS immediately
loadnuvuCSS();

// Mini floating queue progress overlay (shown only while hidden + active)
initializeMiniQueueProgress();

function handleApiReconnected() {
    if (state.pendingRefreshAfterRestart) {
        showPostRestartRefreshPrompt();
    }
}

if (api && typeof api.addEventListener === 'function') {
    api.addEventListener('reconnected', handleApiReconnected);
}

let fallbackReconnectInterval = null;
let fallbackReconnectStart = 0;
let fallbackReconnectSawFailure = false;

function stopFallbackReconnectWatcher() {
    if (fallbackReconnectInterval) {
        clearInterval(fallbackReconnectInterval);
        fallbackReconnectInterval = null;
    }
}

async function attemptServerReadyCheck() {
    if (!state.pendingRefreshAfterRestart) {
        stopFallbackReconnectWatcher();
        return;
    }

    try {
        const response = await fetch(`/nuvu/queue/status?ts=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Accept': 'application/json' }
        });

        if (response.ok) {
            const elapsed = Date.now() - fallbackReconnectStart;
            if (fallbackReconnectSawFailure || elapsed > 7000) {
                showPostRestartRefreshPrompt();
                stopFallbackReconnectWatcher();
            }
        } else {
            fallbackReconnectSawFailure = true;
        }
    } catch (error) {
        fallbackReconnectSawFailure = true;
    }
}

function startFallbackReconnectWatcher() {
    if (fallbackReconnectInterval) {
        return;
    }
    fallbackReconnectStart = Date.now();
    fallbackReconnectSawFailure = false;
    // run first check after short delay to give server time to go down
    setTimeout(attemptServerReadyCheck, 2500);
    fallbackReconnectInterval = setInterval(attemptServerReadyCheck, 4000);
}

if (typeof state.onPendingRefreshChange === 'function') {
    state.onPendingRefreshChange((value) => {
        if (value) {
            startFallbackReconnectWatcher();
        } else {
            stopFallbackReconnectWatcher();
        }
    });
}

if (state.pendingRefreshAfterRestart) {
    startFallbackReconnectWatcher();
}

// Register the extension with ComfyUI - following SubgraphSearch pattern exactly
app.registerExtension({
    name: "Comfy.AOLabs",
    // Add a command and keybinding so users can open the dialog without clicking the button
    commands: [
        {
            id: "Comfy.AOLabs.Open",
            label: "Open nuvu",
            function: () => {
                if (typeof state.opennuvuDialog === "function") {
                    state.opennuvuDialog();
                } else {
                }
            }
        }
    ],
    // Default shortcut: Ctrl+L for Labs
    keybindings: [
        {
            commandId: "Comfy.AOLabs.Open",
            combo: { ctrl: true, key: "l" }
        }
    ],

    async setup() {
        // Load configuration from backend first (single source of truth)
        await fetchConfig();
        
        // Initialize in background - restore session and fetch data
        // This runs before user clicks the button for faster load times
        initializePreload().catch(() => {});
        
        // Assign the dialog function early so it's available for auto-popup
        state.setOpennuvuDialog(shownuvuSplash);
        
        // Check for authentication callback and show splash screen if needed
        const hasAuthTokens = window.location.search.includes('token=') || window.location.hash.includes('token=');
        if (hasAuthTokens) {
            const success = handleWebsiteCallbackFromUrl(updateDialogForAuthenticated);
            if (success) {
                // Show splash screen after a brief delay to ensure authentication is complete
                // License status will be fetched when splash opens (after DOM creation)
                setTimeout(() => {
                    state.opennuvuDialog();
                }, 1000);
            }
        } else if (localStorage.getItem('nuvu_show_splash_after_refresh') === 'true') {
            // Show splash screen after refresh
            localStorage.removeItem('nuvu_show_splash_after_refresh');
            setTimeout(() => {
                state.opennuvuDialog();
            }, 500);
        }
        
        window.addEventListener('error', (event) => {
            if (event.error && event.error.message && 
                (event.error.message.includes('message channel closed') || 
                 event.error.message.includes('asynchronous response'))) {
                event.preventDefault();
                return;
            }
        });
        
        window.addEventListener('unhandledrejection', (event) => {
            if (event.reason && event.reason.message && 
                (event.reason.message.includes('message channel closed') || 
                 event.reason.message.includes('asynchronous response'))) {
                event.preventDefault();
                return;
            }
        });
        
        window.addEventListener('message', (event) => {
            try {
                handlePopupAuthResult(event, updateDialogForAuthenticated);
                // License status will be fetched when splash opens (after DOM creation)
            } catch (error) {
                if (error.message && error.message.includes('message channel closed')) {
                    return;
                }
            }
        }, false);
        
        window.testnuvu = () => {
            alert("nuvu test function works!");
        };
        
        const menu = document.querySelector(".comfy-menu");
        if (!menu) {
            return;
        }
        
        
        // Try multiple approaches to ensure button appears
        let buttonCreated = false;
        
        // Approach 1: Try ComfyUI Button components
        try {
            const Button = (await import("/scripts/ui/components/button.js")).ComfyButton;
            const ButtonGroup = (await import("/scripts/ui/components/buttonGroup.js")).ComfyButtonGroup;
            
            const nuvuBtn = new Button({
                icon: null,
                action: () => {
                    if (typeof state.opennuvuDialog === "function") {
                        state.opennuvuDialog();
                    }
                },
                tooltip: "Open nuvu Control Panel",
                content: "",
                classList: "comfyui-button comfyui-menu-mobile-collapse"
            });
            
            const logoSrc = new URL('images/nuvuNoOutline.png', EXTENSION_BASE_URL).href;
            
            const logoImg = document.createElement('img');
            logoImg.src = logoSrc;
            logoImg.alt = 'nuvu';
            logoImg.style.height = '40px';
            logoImg.style.display = 'block';
            
            nuvuBtn.element.innerHTML = '';
            nuvuBtn.element.appendChild(logoImg);
            nuvuBtn.element.style.background = '#ffffff';
            nuvuBtn.element.style.border = '0px solid #000000';
            nuvuBtn.element.style.borderRadius = '0px';
            nuvuBtn.element.style.padding = '0px 0px';
            nuvuBtn.element.style.display = 'flex';
            nuvuBtn.element.style.alignItems = 'center';
            nuvuBtn.element.style.justifyContent = 'center';
            nuvuBtn.element.style.minWidth = '95px';
            nuvuBtn.element.style.maxWidth = '100px';
            
            
            const group = new ButtonGroup(nuvuBtn.element);
            app.menu?.settingsGroup?.element?.before(group.element);
            buttonCreated = true;
        } catch (e) {
        }
        
        // Approach 2: Fallback button creation
        if (!buttonCreated) {
            try {
            const btn = document.createElement("button");
            btn.textContent = "nuvu";
            btn.onclick = () => {
                if (typeof state.opennuvuDialog === "function") {
                    state.opennuvuDialog();
                }
            };
            const fallbackLogo = document.createElement('img');
            fallbackLogo.src = new URL('images/nuvuNoOutline.png', EXTENSION_BASE_URL).href;
            fallbackLogo.alt = 'nuvu';
            fallbackLogo.style.height = '28px';
            fallbackLogo.style.display = 'block';
            
            btn.innerHTML = '';
            btn.appendChild(fallbackLogo);
            btn.style.background = '#ffffff';
            btn.style.border = '1px solid #000000';
            btn.style.borderRadius = '8px';
            btn.style.padding = '4px 12px';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.minWidth = '120px';
            btn.style.maxWidth = '160px';
            
            menu.append(btn);
                buttonCreated = true;
            } catch (e) {
            }
        }
        
        // Approach 3: Try to find existing button and ensure it's visible
        if (!buttonCreated) {
            setTimeout(() => {
                const existingBtn = document.querySelector('button[data-tooltip="nuvu - Authentication & Updates"]') || 
                                 document.querySelector('button[style*="background: #D14E72"]');
                if (existingBtn) {
                    existingBtn.style.display = "block";
                    existingBtn.style.visibility = "visible";
                    existingBtn.style.opacity = "1";
                }
            }, 1000);
        }
    }
});


