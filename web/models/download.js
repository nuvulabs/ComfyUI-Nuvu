// Model download and polling

import * as state from '../core/state.js';
import { updateModelDownloadButton } from './selection.js';
import { ensureValidSessionOrLogout } from '../auth/session.js';

/**
 * Start model download
 * @param {string[]} modelIds - Array of model IDs to download
 * @param {Object} options - Options including hfToken
 * @returns {Promise<boolean>} - True if download started successfully
 */
export async function startModelDownload(modelIds, options = {}) {
    if (!modelIds || modelIds.length === 0) {
        return false;
    }
    
    try {
        const sessionOk = await ensureValidSessionOrLogout();
        if (!sessionOk) {
            return false;
        }

        // Get access token from storage
        const accessToken = localStorage.getItem('api_token');
        
        if (!accessToken) {
            return false;
        }
        
        // Mark as ongoing
        state.setOngoingModelDownload(true);
        
        // Get user info from state
        const userId = state.currentUser?.id;
        const userEmail = state.currentUser?.email;
        
        if (!userId || !userEmail) {
            state.setOngoingModelDownload(false);
            return false;
        }
        
        // Build request payload
        const payload = {
            model_ids: modelIds,
            user_id: userId,
            user_email: userEmail
        };
        
        // Add HF token if provided
        if (options.hfToken) {
            payload.hf_token = options.hfToken;
        }
        
        // Call the server endpoint
        const response = await fetch('/nuvu/install/models', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            state.setOngoingModelDownload(false);
            return false;
        }
        
        const result = await response.json();
        
        // Start polling for completion (headless - for Vue components)
        pollForModelCompletionHeadless();
        
        return true;
        
    } catch (error) {
        state.setOngoingModelDownload(false);
        return false;
    }
}

/**
 * Poll for model completion without a button reference (for Vue components)
 */
function pollForModelCompletionHeadless() {
    // Clear any existing polling
    if (state.modelPollInterval) {
        clearInterval(state.modelPollInterval);
    }
    
    state.setModelPollInterval(setInterval(async () => {
        try {
            const response = await fetch('/nuvu/queue/status');
            if (response.ok) {
                const status = await response.json();
                
                // If queue is empty and no processing, download is complete
                if (status.queue_size === 0 && !status.is_processing && status.in_progress_count === 0 && status.running_count === 0) {
                    clearInterval(state.modelPollInterval);
                    state.setModelPollInterval(null);
                    state.setOngoingModelDownload(false);
                    
                    // Dispatch event for Vue components to listen to
                    window.dispatchEvent(new CustomEvent('nuvu-model-download-complete'));
                }
            }
        } catch (error) {
            clearInterval(state.modelPollInterval);
            state.setModelPollInterval(null);
            state.setOngoingModelDownload(false);
            
            // Dispatch error event
            window.dispatchEvent(new CustomEvent('nuvu-model-download-error', { detail: error }));
        }
    }, 2000));
}

export async function cancelModelDownload() {
    try {
        const response = await fetch('/nuvu/queue/reset', {
            method: 'GET'
        });
        
        if (response.ok) {
            // Stop polling
        if (state.modelPollInterval) {
            clearInterval(state.modelPollInterval);
            state.setModelPollInterval(null);
            }
            // Reset button state
            state.setOngoingModelDownload(false);
            updateModelDownloadButton();
        } else {
        }
    } catch (error) {
        // Stop polling even on error
        if (state.modelPollInterval) {
            clearInterval(state.modelPollInterval);
            state.setModelPollInterval(null);
        }
        // Reset button state even on error
        state.setOngoingModelDownload(false);
        updateModelDownloadButton();
    }
}







