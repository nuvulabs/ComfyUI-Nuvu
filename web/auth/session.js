// Session management and validation
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { getWebsiteBaseUrl } from '../core/config.js';
import {
    persistUserProfile,
    clearStoredUserProfile,
    hydrateUserFromStorage,
    decodeTokenExpiry,
    getActiveApiToken,
    getStoredUserId,
    getStoredUserEmail,
} from './storage.js';

const TOKEN_EXPIRY_LEEWAY_MS = 60 * 1000;

function dispatchAuthInvalidated(reason) {
    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('nuvu:auth-invalidated', { detail: { reason } }));
        }
    } catch (error) {
    }
}

function clearLocalSession(reason = 'invalid_session') {
    try {
        localStorage.removeItem('api_token');
        localStorage.removeItem('user_token');
        localStorage.removeItem('auth_access_token');
        localStorage.removeItem('auth_expires_at');
    } catch (error) {
    }
    clearStoredUserProfile();
    dispatchAuthInvalidated(reason);
}

async function refreshSessionFromWebsite() {
    try {
        const response = await fetch(`${getWebsiteBaseUrl()}/api/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
        });
        if (!response.ok) {
            return false;
        }
        const data = await response.json();
        if (!data?.api_token) {
            return false;
        }

        localStorage.setItem('api_token', data.api_token);
        if (data.user_token) {
            localStorage.setItem('user_token', data.user_token);
        }
        if (data.expires_at) {
            localStorage.setItem('auth_expires_at', String(data.expires_at));
        }

        persistUserProfile(
            {
                id: getStoredUserId(),
                email: getStoredUserEmail() || '',
                name: state.currentUser?.name || '',
                picture: state.currentUser?.picture || '',
            },
            {
                apiToken: data.api_token,
                accessToken: data.api_token,
                userToken: data.user_token || localStorage.getItem('user_token'),
            },
        );
        return true;
    } catch (error) {
        return false;
    }
}

export async function checkWebsiteSession({ allowRefreshRetry = true, skipApiCall = false } = {}) {
    try {
        const apiToken = localStorage.getItem('api_token');
        const userToken = localStorage.getItem('user_token');
        const expiresAt = localStorage.getItem('auth_expires_at');

        if (!apiToken) {
            return false;
        }

        if (expiresAt && Date.now() > parseInt(expiresAt)) {
            clearLocalSession('token_expired');
            return false;
        }

        // Fast path: If we already have cached user data and token is not expired, 
        // skip the slow API call
        if (skipApiCall) {
            // Just hydrate from storage and trust the token
            hydrateUserFromStorage();
            return state.isAuthenticated;
        }

        // Also skip if we already have authenticated state with user data
        if (state.isAuthenticated && state.currentUser && state.currentUser.id) {
            return true;
        }

        const userResponse = await fetch(getWebsiteBaseUrl() + '/api/user/info', {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (userResponse.ok) {
            const user = await userResponse.json();

            persistUserProfile(
                {
                    id: user.sub,
                    name: user.name,
                    email: user.email,
                    picture: user.picture,
                    email_verified: user.email_verified,
                },
                {
                    apiToken,
                    accessToken: apiToken,
                    userToken,
                },
            );
            const newExpiry = decodeTokenExpiry(apiToken);
            if (newExpiry) {
                localStorage.setItem('auth_expires_at', String(newExpiry));
            }

            return true;
        }

        if (userResponse.status === 401 && allowRefreshRetry) {
            const refreshed = await refreshSessionFromWebsite();
            if (refreshed) {
                return checkWebsiteSession({ allowRefreshRetry: false });
            }
            clearLocalSession('unauthorized');
            return false;
        }

        if (userResponse.status === 401 || userResponse.status === 403) {
            clearLocalSession(userResponse.status === 403 ? 'forbidden' : 'unauthorized');
            return false;
        }

        // Non-auth failures: keep local session as-is (avoid logging user out on transient issues)
        clearStoredUserProfile();
        return false;
    } catch (error) {
        // Network or parsing errors: avoid redirecting/logging out; just treat as invalid for now.
        clearStoredUserProfile();
        return false;
    }
}

export async function restoreSessionOnLoad() {
    try {
        hydrateUserFromStorage();
        const apiToken = localStorage.getItem('api_token');
        const expiresAt = localStorage.getItem('auth_expires_at');

        if (!apiToken || !expiresAt) {
            return false;
        }

        if (Date.now() > parseInt(expiresAt)) {
            clearLocalSession('token_expired');
            return false;
        }

        const sessionValid = await checkWebsiteSession();
        if (sessionValid) {
            return true;
        }

        return false;
    } catch (error) {
        return false;
    }
}

export async function ensureValidSessionOrLogout() {
    const valid = await checkWebsiteSession({ allowRefreshRetry: true, skipApiCall: false });
    if (valid) {
        return true;
    }
    // If checkWebsiteSession already decided to invalidate, it will have done so;
    // but in cases where it only cleared profile (transient failures), we still prefer
    // forcing a clean logout to avoid random 500s on protected operations.
    clearLocalSession('session_invalid');
    return false;
}

export function invalidateLocalSession(reason = 'session_invalid') {
    clearLocalSession(reason);
}

export async function ensureFreshAccessToken() {
    const expiresAtRaw = localStorage.getItem('auth_expires_at');
    if (!expiresAtRaw) {
        return Boolean(getActiveApiToken());
    }

    const expiresAt = parseInt(expiresAtRaw, 10);
    if (!Number.isFinite(expiresAt)) {
        return Boolean(getActiveApiToken());
    }

    if (Date.now() <= (expiresAt - TOKEN_EXPIRY_LEEWAY_MS)) {
        return Boolean(getActiveApiToken());
    }

    const refreshed = await refreshSessionFromWebsite();
    if (refreshed) {
        return true;
    }

    return checkWebsiteSession({ allowRefreshRetry: false });
}


