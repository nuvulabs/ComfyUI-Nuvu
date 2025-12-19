// Workflow selection state management
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { calculateTotalWorkflowSize, checkWorkflowsForHFTokenRequirement, collectWorkflowInstallMessages } from './api.js';

let workflowButtonUpdateToken = 0;
let userConfigPrefetchPromise = null;
let hfTokenCache = null;
let hfTokenPrefetchPromise = null;

export function setWorkflowHfToken(token) {
    hfTokenCache = token && typeof token === 'string' ? token.trim() : '';
    const tokenInput = document.getElementById('nuvu-workflow-hf-token');
    if (tokenInput) {
        tokenInput.value = hfTokenCache || '';
    }
}

export function prefetchWorkflowHfToken() {
    if (hfTokenCache) return Promise.resolve(hfTokenCache);
    if (hfTokenPrefetchPromise) return hfTokenPrefetchPromise;
    hfTokenPrefetchPromise = fetch('/nuvu/user-config')
        .then(r => r.ok ? r.json() : null)
        .then(cfg => {
            const token = cfg && typeof cfg.huggingface_token === 'string'
                ? cfg.huggingface_token.trim()
                : '';
            if (token) {
                setWorkflowHfToken(token);
            }
            return hfTokenCache;
        })
        .catch(() => null)
        .finally(() => {
            hfTokenPrefetchPromise = null;
        });
    return hfTokenPrefetchPromise;
}

function hideWorkflowMessage() {
    const messageElement = document.getElementById('nuvu-workflow-install-message');
    if (messageElement) {
        messageElement.style.display = 'none';
        messageElement.innerHTML = '';
    }
}

function escapeHtml(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            case '\'':
                return '&#39;';
            default:
                return char;
        }
    });
}

function renderWorkflowMessage(messages) {
    const messageElement = document.getElementById('nuvu-workflow-install-message');
    if (!messageElement) {
        return;
    }

    if (!messages || !messages.length) {
        hideWorkflowMessage();
        return;
    }

    const entriesHtml = messages
        .map((entry) => {
            const title = escapeHtml(entry.name);
            const content = escapeHtml(entry.message);
            return `
                <div style="
                    margin-bottom:6px;
                    font-size:0.85em;
                    color:#fefefe;
                    line-height:1.4;
                    border-radius:8px;
                    padding:8px 10px;
                    background:rgba(37,99,235,0.15);
                    border:1px solid rgba(59,130,246,0.3);
                ">
                    <div style="font-weight:600; margin-bottom:2px;">${title}</div>
                    <div>${content}</div>
                </div>
            `;
        })
        .join('');

    messageElement.innerHTML = entriesHtml;
    messageElement.style.display = 'block';
}

function resetWorkflowLoadingState(button, container) {
    if (button) {
        button.classList.remove('nuvu-loading');
        button.removeAttribute('aria-busy');
        button.removeAttribute('data-loading-token');
    }
    if (container) {
        container.classList.remove('nuvu-loading');
        container.style.pointerEvents = '';
        container.style.opacity = '';
        container.removeAttribute('data-loading-token');
    }
}

function startWorkflowLoadingState(button, container, token) {
    if (button) {
        button.dataset.loadingToken = String(token);
        button.classList.add('nuvu-loading');
        button.setAttribute('aria-busy', 'true');
        button.disabled = true;
        button.textContent = 'Updating...';
    }
    if (container) {
        container.dataset.loadingToken = String(token);
        container.classList.add('nuvu-loading');
        if (container.style.display === 'none') {
            container.style.display = 'block';
        }
        container.style.pointerEvents = 'none';
        container.style.opacity = '0.6';
    }
}

function finishWorkflowLoadingState(button, container, token) {
    if (button && button.dataset.loadingToken === String(token)) {
        button.classList.remove('nuvu-loading');
        button.removeAttribute('aria-busy');
        button.removeAttribute('data-loading-token');
    }
    if (container && container.dataset.loadingToken === String(token)) {
        container.classList.remove('nuvu-loading');
        container.style.pointerEvents = '';
        container.style.opacity = '';
        container.removeAttribute('data-loading-token');
    }
}

export async function updateWorkflowInstallButton() {
    const installBtn = document.getElementById('nuvu-install-workflows-btn');
    const hfTokenContainer = document.getElementById('nuvu-workflow-hf-token-container');
    const updateToken = ++workflowButtonUpdateToken;
    hideWorkflowMessage();
    
    if (!installBtn) {
        return;
    }
    
    resetWorkflowLoadingState(installBtn, hfTokenContainer);
    
    // Ensure HF token is prefetched and applied if available
    const tokenInput = document.getElementById('nuvu-workflow-hf-token');
    if (tokenInput && !tokenInput.value.trim()) {
        if (hfTokenCache) {
            tokenInput.value = hfTokenCache;
        } else {
            prefetchWorkflowHfToken();
        }
    }

    // Don't disable button if installation is ongoing (for cancel functionality)
    installBtn.disabled = state.selectedWorkflows.size === 0 && !state.ongoingWorkflowInstall;
    
    if (state.ongoingWorkflowInstall) {
        installBtn.textContent = 'Cancel Install';
        installBtn.style.background = '#dc3545'; // Red for cancel
        if (hfTokenContainer) {
            hfTokenContainer.style.display = 'none';
            const hfTokenInput = document.getElementById('nuvu-workflow-hf-token');
            if (hfTokenInput) hfTokenInput.value = '';
            hideWorkflowMessage();
        }
        return;
    }
    
    if (state.selectedWorkflows.size === 0) {
        installBtn.textContent = 'Select Workflows to Install';
        installBtn.style.background = '#0b0b0b'; // Reset to monochrome color
        if (hfTokenContainer) {
            hfTokenContainer.style.display = 'none';
            const hfTokenInput = document.getElementById('nuvu-workflow-hf-token');
            if (hfTokenInput) hfTokenInput.value = '';
            hideWorkflowMessage();
        }
        return;
    }
    
    startWorkflowLoadingState(installBtn, hfTokenContainer, updateToken);
    
    let sizeInfo;
    let requiresHFToken = false;
    let workflowMessages = [];
    
    try {
        sizeInfo = await calculateTotalWorkflowSize(Array.from(state.selectedWorkflows));
        if (workflowButtonUpdateToken !== updateToken) {
            return;
        }
        
        requiresHFToken = await checkWorkflowsForHFTokenRequirement();
        if (workflowButtonUpdateToken !== updateToken) {
            return;
        }

        workflowMessages = await collectWorkflowInstallMessages(Array.from(state.selectedWorkflows));
        if (workflowButtonUpdateToken !== updateToken) {
            return;
        }
    } catch (error) {
        installBtn.disabled = true;
        installBtn.textContent = 'Unable to update selection';
        installBtn.style.background = '#555555';
        if (hfTokenContainer) {
            hfTokenContainer.style.display = 'none';
        }
        hideWorkflowMessage();
        return;
    } finally {
        finishWorkflowLoadingState(installBtn, hfTokenContainer, updateToken);
    }
    
    if (workflowButtonUpdateToken !== updateToken) {
        return;
    }
    
    const totalSizeGB = sizeInfo.totalSize > 0 ? sizeInfo.totalSize.toFixed(1) : 0;
    
    let buttonText = `Install ${state.selectedWorkflows.size} Workflow${state.selectedWorkflows.size === 1 ? '' : 's'}`;
    if (totalSizeGB > 0) {
        buttonText += ` (${totalSizeGB} GB`;
        if (sizeInfo.uniqueModelsCount > 0) {
            buttonText += `, ${sizeInfo.uniqueModelsCount} model${sizeInfo.uniqueModelsCount === 1 ? '' : 's'}`;
        }
        buttonText += ')';
    }
    
    installBtn.textContent = buttonText;
    installBtn.style.background = '#0b0b0b'; // Reset to monochrome color
    installBtn.disabled = false;
    
    if (hfTokenContainer) {
        hfTokenContainer.style.display = 'block';
        const prefixElement = document.getElementById('nuvu-workflow-hf-token-prefix');
        if (prefixElement) {
            if (requiresHFToken) {
                prefixElement.textContent = 'Required:';
                prefixElement.style.color = '#ef4444'; // Red color
            } else {
                prefixElement.textContent = 'Optional:';
                prefixElement.style.color = '#4ade80'; // Green color
            }
        }
        const helpElement = document.getElementById('nuvu-workflow-hf-token-help');
        if (helpElement) {
            if (requiresHFToken) {
                helpElement.innerHTML = 'A HuggingFace token is required for some models in the selected workflows. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
            } else {
                helpElement.innerHTML = 'Enter your HuggingFace token for faster downloads and access to private models. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
            }
        }
        
        const toggleBtn = document.getElementById('nuvu-workflow-hf-token-toggle');
        if (toggleBtn) {
            toggleBtn.onclick = () => {
                const tokenInput = document.getElementById('nuvu-workflow-hf-token');
                if (tokenInput) {
                    if (tokenInput.type === 'password') {
                        tokenInput.type = 'text';
                        toggleBtn.textContent = 'Hide';
                        toggleBtn.title = 'Hide password';
                    } else {
                        tokenInput.type = 'password';
                        toggleBtn.textContent = 'Show';
                        toggleBtn.title = 'Show password';
                    }
                }
            };
        }
        
        const tokenInput = document.getElementById('nuvu-workflow-hf-token');
        if (tokenInput && !tokenInput.value.trim()) {
            fetch('/nuvu/user-config')
                .then(r => r.ok ? r.json() : null)
                .then(cfg => {
                    if (cfg && cfg.huggingface_token && typeof cfg.huggingface_token === 'string' && cfg.huggingface_token.trim()) {
                        tokenInput.value = cfg.huggingface_token;
                    }
                })
                .catch(() => {});
        }

        if (workflowMessages.length) {
            renderWorkflowMessage(workflowMessages);
        } else {
            hideWorkflowMessage();
        }
    }
}











