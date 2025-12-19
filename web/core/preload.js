/**
 * Centralized initialization
 * 
 * This module ONLY handles session restoration from localStorage.
 * Data fetching happens when the dialog opens (in App.vue).
 */

import * as state from './state.js';
import { hydrateUserFromStorage } from '../auth/storage.js';

// Initialization state
let initComplete = false;

/**
 * Initialize - just restore user session from localStorage
 * NO data fetching here - that happens when dialog opens
 */
export async function initialize() {
    if (initComplete) return { authenticated: state.isAuthenticated };
    
    try {
        // Hydrate data caches from localStorage (instant)
        state.hydrateWorkflowsFromCache();
        state.hydrateModelsFromCache();
        
        // Check for stored auth token
        const storedApiToken = localStorage.getItem('api_token');
        if (!storedApiToken) {
            initComplete = true;
            return { authenticated: false, reason: 'no_token' };
        }
        
        // Check if token is expired
        const expiresAt = localStorage.getItem('auth_expires_at');
        if (expiresAt && Date.now() > parseInt(expiresAt)) {
            localStorage.removeItem('api_token');
            localStorage.removeItem('user_token');
            localStorage.removeItem('auth_expires_at');
            initComplete = true;
            return { authenticated: false, reason: 'token_expired' };
        }
        
        // Hydrate user from storage (instant, sets isAuthenticated)
        hydrateUserFromStorage();
        
        initComplete = true;
        return { authenticated: state.isAuthenticated };
        
    } catch (error) {
        initComplete = true;
        return { authenticated: false, reason: 'error', error };
    }
}

/**
 * Check if initialization is complete
 */
export function isInitComplete() {
    return initComplete;
}

/**
 * Get current status
 */
export function getStatus() {
    return {
        initComplete,
        isAuthenticated: state.isAuthenticated,
        hasWorkflowsCache: Array.isArray(state.workflowsData) && state.workflowsData.length > 0,
        hasModelsCache: Array.isArray(state.modelsData) && state.modelsData.length > 0,
        user: state.currentUser,
        licenseStatus: state.currentLicenseStatus
    };
}

/**
 * Wait for initialization to complete
 */
export async function waitForInit() {
    if (!initComplete) {
        await initialize();
    }
    return getStatus();
}

// Legacy export for backwards compatibility
export const startEarlyPreload = initialize;

