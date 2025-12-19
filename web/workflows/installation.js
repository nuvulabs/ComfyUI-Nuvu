// Workflow installation and polling
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { updateWorkflowInstallButton } from './selection.js';
import { ensureValidSessionOrLogout } from '../auth/session.js';
// Note: Restart prompt is now handled by Vue's InstallationSummaryModal

/**
 * Start workflow installation
 * @param {string[]} workflowIds - Array of workflow IDs to install
 * @param {Object} options - Options including hfToken
 * @returns {Promise<boolean>} - True if installation started successfully
 */
export async function startWorkflowInstall(workflowIds, options = {}) {
    if (!workflowIds || workflowIds.length === 0) {
        return false;
    }
    
    try {
        const sessionOk = await ensureValidSessionOrLogout();
        if (!sessionOk) {
            return false;
        }

        // Get access token from storage (same pattern as auth/session.js)
        const accessToken = localStorage.getItem('api_token');
        
        if (!accessToken) {
            return false;
        }
        
        // Mark as ongoing
        state.setOngoingWorkflowInstall(true);
        
        // Get user info from state
        const userId = state.currentUser?.id;
        const userEmail = state.currentUser?.email;
        
        if (!userId || !userEmail) {
            state.setOngoingWorkflowInstall(false);
            return false;
        }
        
        // Build request payload
        const payload = {
            workflow_ids: workflowIds,
            user_id: userId,
            user_email: userEmail
        };
        
        // Add HF token if provided
        if (options.hfToken) {
            payload.hf_token = options.hfToken;
        }
        
        // Call the server endpoint
        const response = await fetch('/nuvu/install/workflow', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            state.setOngoingWorkflowInstall(false);
            return false;
        }
        
        const result = await response.json();
        
        // Start polling for completion (headless - no button reference needed)
        pollForWorkflowCompletionHeadless();
        
        return true;
        
    } catch (error) {
        state.setOngoingWorkflowInstall(false);
        return false;
    }
}

/**
 * Poll for workflow completion without a button reference (for Vue components)
 */
function pollForWorkflowCompletionHeadless() {
    // Clear any existing polling
    if (state.workflowPollInterval) {
        clearInterval(state.workflowPollInterval);
    }
    
    state.setWorkflowPollInterval(setInterval(async () => {
        try {
            const response = await fetch('/nuvu/queue/status');
            if (response.ok) {
                const status = await response.json();
                
                // If queue is empty and no processing, installation is complete
                if (status.queue_size === 0 && !status.is_processing && status.in_progress_count === 0 && status.running_count === 0) {
                    clearInterval(state.workflowPollInterval);
                    state.setWorkflowPollInterval(null);
                    state.setOngoingWorkflowInstall(false);
                    
                    // Dispatch event for Vue components to listen to
                    // Vue's InstallationSummaryModal handles the restart prompt
                    window.dispatchEvent(new CustomEvent('nuvu-workflow-install-complete'));
                }
            }
        } catch (error) {
            clearInterval(state.workflowPollInterval);
            state.setWorkflowPollInterval(null);
            state.setOngoingWorkflowInstall(false);
            
            // Dispatch error event
            window.dispatchEvent(new CustomEvent('nuvu-workflow-install-error', { detail: error }));
        }
    }, 2000));
}

export async function pollForWorkflowCompletion(button, originalText) {
    // Clear any existing polling
    if (state.workflowPollInterval) {
        clearInterval(state.workflowPollInterval);
    }
    
    state.setWorkflowPollInterval(setInterval(async () => {
        try {
            const response = await fetch('/nuvu/queue/status');
            if (response.ok) {
                const status = await response.json();
                // Polling status logging removed to avoid console spam
                // If queue is empty and no processing and no running processes, installation is complete
                if (status.queue_size === 0 && !status.is_processing && status.in_progress_count === 0 && status.running_count === 0) {
                    clearInterval(state.workflowPollInterval);
                    state.setWorkflowPollInterval(null);
                    state.setOngoingWorkflowInstall(false);
                    button.textContent = "Installation Complete!";
                    button.style.background = "#28a745";
                    setTimeout(() => {
                        resetWorkflowInstallButton(button, originalText);
                    }, 3000);
                    // Note: Restart prompt is now handled by Vue's InstallationSummaryModal
                }
            }
        } catch (error) {
            clearInterval(state.workflowPollInterval);
            state.setWorkflowPollInterval(null);
            state.setOngoingWorkflowInstall(false);
            updateWorkflowInstallButton();
        }
    }, 2000)); // Poll every 2 seconds
    
}

export async function cancelWorkflowInstall() {
    try {
        const response = await fetch('/nuvu/queue/reset', {
            method: 'GET'
        });
        
        if (response.ok) {
            // Stop polling
        if (state.workflowPollInterval) {
            clearInterval(state.workflowPollInterval);
            state.setWorkflowPollInterval(null);
            }
            // Reset button state
            state.setOngoingWorkflowInstall(false);
            updateWorkflowInstallButton();
            if (typeof state.setPendingRefreshAfterRestart === 'function') {
                state.setPendingRefreshAfterRestart(false);
            }
        } else {
        }
    } catch (error) {
        // Stop polling even on error
        if (state.workflowPollInterval) {
            clearInterval(state.workflowPollInterval);
            state.setWorkflowPollInterval(null);
        }
        // Reset button state even on error
        state.setOngoingWorkflowInstall(false);
        updateWorkflowInstallButton();
        if (typeof state.setPendingRefreshAfterRestart === 'function') {
            state.setPendingRefreshAfterRestart(false);
        }
    }
}

export function resetWorkflowInstallButton(button, originalText) {
    button.disabled = false;
    button.textContent = originalText;
    button.style.background = "#0b0b0b";
    button.style.color = "#ffffff";
    button.style.border = "1px solid #ffffff";
}











