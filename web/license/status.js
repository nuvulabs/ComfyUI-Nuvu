// License status management
// Provides license fetching and formatting for Vue app

import * as state from '../core/state.js';
import { getActiveApiToken, getStoredUserId } from '../auth/storage.js';
import { invalidateLocalSession } from '../auth/session.js';

const LICENSE_CACHE_KEY = 'nuvu_license_cache';
const LICENSE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached license status if still valid
 * @returns {Object|null} Cached license status or null if expired/missing
 */
function getCachedLicenseStatus() {
    try {
        const raw = localStorage.getItem(LICENSE_CACHE_KEY);
        if (!raw) return null;
        
        const cached = JSON.parse(raw);
        if (!cached || typeof cached !== 'object') return null;
        
        const age = Date.now() - (cached.timestamp || 0);
        if (age > LICENSE_CACHE_TTL_MS) {
            localStorage.removeItem(LICENSE_CACHE_KEY);
            return null;
        }
        
        return cached.data;
    } catch (error) {
        return null;
    }
}

/**
 * Cache license status
 * @param {Object} status - License status to cache
 */
function cacheLicenseStatus(status) {
    try {
        localStorage.setItem(LICENSE_CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
            data: status
        }));
    } catch (error) {
    }
}

/**
 * Fetch license status from backend
 * @param {Object} options - Options
 * @param {boolean} options.useCache - Whether to use cached value if available
 * @param {boolean} options.backgroundRefresh - Whether to refresh in background even if cache hit
 * @returns {Promise<Object>} License status object
 */
export async function fetchLicenseStatus(options = {}) {
    const { useCache = true, backgroundRefresh = false } = options;
    
    // Check cache first
    if (useCache) {
        const cached = getCachedLicenseStatus();
        if (cached) {
            state.setCurrentLicenseStatus(cached);
            
            // Optionally refresh in background
            if (backgroundRefresh) {
                fetchLicenseStatus({ useCache: false }).catch(() => {});
            }
            
            return cached;
        }
    }

    const apiToken = getActiveApiToken();
    const userId = getStoredUserId();
    
    if (!apiToken) {
        const noAuthStatus = {
            has_paid_subscription: false,
            subscription_status: 'none',
            message: 'Not authenticated'
        };
        state.setCurrentLicenseStatus(noAuthStatus);
        return noAuthStatus;
    }
    
    try {
        const response = await fetch('/nuvu/auth/subscription-check', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify({ userId })
        });

        if (response.status === 401 || response.status === 403) {
            invalidateLocalSession('license_check_unauthorized');
            throw new Error(`License check unauthorized: ${response.status}`);
        }
        
        if (!response.ok) {
            throw new Error(`License check failed: ${response.status}`);
            }

        const status = await response.json();
        
        // Cache and store
        cacheLicenseStatus(status);
        state.setCurrentLicenseStatus(status);
        
        return status;
    } catch (error) {
        // Return cached status if available, otherwise default
        const cached = getCachedLicenseStatus();
    if (cached) {
            state.setCurrentLicenseStatus(cached);
            return cached;
        }
        
        const errorStatus = {
            has_paid_subscription: false,
            subscription_status: 'error',
            message: 'Failed to check license status'
        };
        state.setCurrentLicenseStatus(errorStatus);
        return errorStatus;
    }
}

/**
 * Format license status for display
 * @param {Object} status - Raw license status object
 * @returns {Object} Formatted license status with display properties
 */
const ACTIVE_STYLE = [
    'color: #35ffb5',
    'border-color: #35ffb5',
    'background: rgba(53, 255, 181, 0.12)',
    'box-shadow: 0 0 14px rgba(53, 255, 181, 0.35)'
].join('; ');

const INACTIVE_STYLE = [
    'color: #ff5a71',
    'border-color: #ff5a71',
    'background: rgba(255, 90, 113, 0.12)',
    'box-shadow: 0 0 16px rgba(255, 90, 113, 0.4)'
].join('; ');

export function formatLicenseStatus(status) {
    if (!status) {
        return {
            isActive: false,
            statusText: 'Unknown',
            statusClass: 'unknown',
            message: 'License status unknown',
            showPurchaseLink: false,
            style: INACTIVE_STYLE
        };
    }
    
    const hasPaid = status.has_paid_subscription === true;
    const subscriptionStatus = status.subscription_status || 'none';
    const baseMessage = status.message;
    
    if (hasPaid) {
        return {
            isActive: true,
            statusText: 'Active',
            statusClass: 'active',
            message: baseMessage || 'Your subscription is active',
            plan: status.plan || status.subscription_plan || 'Pro',
            expiresAt: status.expires_at || status.expiresAt || null,
            showPurchaseLink: false,
            style: ACTIVE_STYLE
        };
    }
    
    // Handle various inactive states
    switch (subscriptionStatus) {
        case 'trial':
            return {
                isActive: true,
                statusText: 'Trial',
                statusClass: 'trial',
                message: baseMessage || 'You are on a trial',
                trialEndsAt: status.trial_ends_at || status.trialEndsAt || null,
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
        case 'expired':
            return {
                isActive: false,
                statusText: 'Expired',
                statusClass: 'expired',
                message: baseMessage || 'Your subscription has expired',
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
        case 'cancelled':
            return {
                isActive: false,
                statusText: 'Cancelled',
                statusClass: 'cancelled',
                message: baseMessage || 'Your subscription was cancelled',
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
        case 'error':
            return {
                isActive: false,
                statusText: 'Error',
                statusClass: 'error',
                message: baseMessage || 'Unable to verify license',
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
        case 'free':
            return {
                isActive: false,
                statusText: 'Free Plan',
                statusClass: 'free',
                message: baseMessage || 'You are on the free plan',
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
        default:
            return {
                isActive: false,
                statusText: 'None',
                statusClass: 'none',
                message: baseMessage || 'No active subscription',
                showPurchaseLink: true,
                style: INACTIVE_STYLE
            };
    }
}

/**
 * Initialize license status (called on app load)
 * Fetches fresh status if not cached, otherwise uses cache
 */
export async function initializeLicenseStatus() {
    return fetchLicenseStatus({ useCache: true, backgroundRefresh: true });
}

