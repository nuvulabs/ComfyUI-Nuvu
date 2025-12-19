// Logout functionality
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { getWebsiteBaseUrl, getCallbackUrl } from '../core/config.js';

function clearLocalAuthStorage() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    const explicitKeys = [
        'api_token',
        'user_token',
        'auth_access_token',
        'auth_expires_at',
        'oauth_state',
        'nuvu_show_splash_after_refresh'
    ];

    const dynamicKeys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith('nuvu_')) {
            dynamicKeys.push(key);
        }
    }

    const keysToClear = Array.from(new Set([...explicitKeys, ...dynamicKeys]));
    keysToClear.forEach(key => {
        try {
            window.localStorage.removeItem(key);
        } catch (error) {
        }
    });

    if (typeof window.sessionStorage !== 'undefined') {
        try {
            const sessionKeys = [];
            for (let i = 0; i < window.sessionStorage.length; i++) {
                const key = window.sessionStorage.key(i);
                if (key && key.startsWith('nuvu_')) {
                    sessionKeys.push(key);
                }
            }
            sessionKeys.forEach(key => window.sessionStorage.removeItem(key));
        } catch (error) {
        }
    }
}

function buildLogoutUrl() {
    const baseUrl = getWebsiteBaseUrl();
    const callbackUrl = getCallbackUrl();
    if (!baseUrl || !callbackUrl) {
        return null;
    }
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const redirectParam = encodeURIComponent(callbackUrl);
    return `${normalizedBase}/api/auth/logout?redirect=${redirectParam}`;
}

export async function logoutWebsite() {
    clearLocalAuthStorage();

    const cookiesToClear = [
        'auth_access_token',
        'auth_expires_at',
        'oauth_state'
    ];

    cookiesToClear.forEach(cookieName => {
        document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=localhost;`;
        document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=;`;
    });

    state.setAuthenticated(false);
    state.setCurrentUser(null);
    state.setCurrentLicenseStatus(null);

    if (state.nuvuDialog) {
        // Keep dialog mounted; just hide it during logout.
        try {
            state.nuvuDialog.style.display = 'none';
            state.nuvuDialog.setAttribute('aria-hidden', 'true');
        } catch (error) {
        }
    }

    const logoutUrl = buildLogoutUrl();
    if (logoutUrl) {
        window.location.href = logoutUrl;
    } else {
        window.location.reload();
    }
}











