// OAuth authentication flow
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { getOAuthConfig, getWebsiteBaseUrl } from '../core/config.js';
import { processWebsiteAuthSuccess, processPopupAuthSuccess } from './callbacks.js';

const OAUTH_STATE_STORAGE_KEY = 'oauth_state';

function base64UrlEncode(value) {
    return btoa(value)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 ? 4 - (normalized.length % 4) : 0;
    const padded = normalized + '='.repeat(padding);
    return atob(padded);
}

function buildAuthStatePayload() {
    const nonce = generateState();
    if (typeof window === 'undefined') {
        return { nonce };
    }
    return {
        nonce,
        origin: window.location.origin,
        path: window.location.pathname || '/',
        search: window.location.search || '',
        hash: window.location.hash || ''
    };
}

function encodeStatePayload(payload) {
    try {
        return base64UrlEncode(JSON.stringify(payload));
    } catch (error) {
        return generateState();
    }
}

function decodeStatePayload(stateParam) {
    if (!stateParam) {
        return null;
    }
    try {
        const json = base64UrlDecode(stateParam);
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch (error) {
        return null;
    }
}

function redirectToOriginalOrigin(statePayload, urlParams) {
    if (typeof window === 'undefined') {
        return false;
    }
    if (!statePayload || !statePayload.origin) {
        return false;
    }
    if (window.location.origin === statePayload.origin) {
        return false;
    }

    try {
        const path = typeof statePayload.path === 'string' && statePayload.path.length
            ? statePayload.path
            : '/';
        const targetUrl = new URL(path, statePayload.origin);

        const mergedParams = new URLSearchParams();
        if (typeof statePayload.search === 'string' && statePayload.search.length > 1) {
            const originalParams = new URLSearchParams(
                statePayload.search.startsWith('?') ? statePayload.search.slice(1) : statePayload.search
            );
            originalParams.forEach((value, key) => mergedParams.set(key, value));
        }
        if (urlParams) {
            urlParams.forEach((value, key) => mergedParams.set(key, value));
        }

        const searchString = mergedParams.toString();
        targetUrl.search = searchString ? `?${searchString}` : '';
        const hashValue = window.location.hash && window.location.hash !== '#'
            ? window.location.hash
            : (typeof statePayload.hash === 'string' ? statePayload.hash : '');
        targetUrl.hash = hashValue;

        window.location.replace(targetUrl.toString());
        return true;
    } catch (error) {
        return false;
    }
}

export function generateState() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode.apply(null, array))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

export async function loginWithWebsite() {
    try {
        const statePayload = buildAuthStatePayload();
        const stateParam = encodeStatePayload(statePayload);
        localStorage.setItem(OAUTH_STATE_STORAGE_KEY, stateParam);
        
        // Get OAuth config (uses current getWebsiteBaseUrl())
        const oauthConfig = getOAuthConfig();
        
        // Redirect to your website's auth route with callback URL
        const authUrl = `${oauthConfig.authUrl}?redirect=${encodeURIComponent(oauthConfig.callbackUrl)}&state=${encodeURIComponent(stateParam)}`;
        
        window.location.href = authUrl;
        return true;
        
    } catch (error) {
        return false;
    }
}

export function handleWebsiteCallbackFromUrl(updateDialogForAuthenticated) {
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.substr(1));
    
    
    // Check for tokens in URL parameters (from your website)
    const apiToken = urlParams.get('token') || hashParams.get('token');
    const userToken = urlParams.get('id_token') || hashParams.get('id_token');
    const error = urlParams.get('error') || hashParams.get('error');
    const error_description = urlParams.get('error_description') || hashParams.get('error_description');
    const stateParam = urlParams.get('state') || hashParams.get('state');
    
    if (error) {
        return false;
    }
    
    if (apiToken) {
        const decodedState = decodeStatePayload(stateParam);
        if (decodedState && redirectToOriginalOrigin(decodedState, urlParams)) {
            return false;
        }

        // Verify state parameter for security
        const storedState = localStorage.getItem(OAUTH_STATE_STORAGE_KEY);
        if (stateParam && storedState && stateParam !== storedState) {
            return false;
        }
        
        // Clear the state
        localStorage.removeItem(OAUTH_STATE_STORAGE_KEY);
        
        const authData = {
            api_token: apiToken, // This is the JWT access token with audience for API calls
            user_token: userToken, // This is the Auth0 ID token for user info calls
            user_info: null // Will be fetched from your API
        };
        
        processWebsiteAuthSuccess(authData).then(() => {
            updateDialogForAuthenticated();
            // Clean up URL
            window.history.replaceState({}, document.title, window.location.pathname);
            return true;
        }).catch(error => {
            return false;
        });
        
        return true;
    }
    
    return false;
}

export function handlePopupAuthResult(event, updateDialogForAuthenticated) {
    if (event.origin !== window.location.origin) {
        return;
    }
    
    if (event.data.type === 'nuvu_AUTH_SUCCESS') {
        if (window.nuvuAuthPopup && !window.nuvuAuthPopup.closed) {
            window.nuvuAuthPopup.close();
        }
        
        processPopupAuthSuccess(event.data).then(() => {
            updateDialogForAuthenticated();
            
            if (window.nuvuAuthResolve) {
                window.nuvuAuthResolve(true);
                window.nuvuAuthResolve = null;
                window.nuvuAuthReject = null;
            }
        }).catch(error => {
            if (window.nuvuAuthReject) {
                window.nuvuAuthReject(error);
                window.nuvuAuthResolve = null;
                window.nuvuAuthReject = null;
            }
        });
        
    } else if (event.data.type === 'nuvu_AUTH_ERROR') {
        
        if (window.nuvuAuthPopup && !window.nuvuAuthPopup.closed) {
            window.nuvuAuthPopup.close();
        }
        
        if (window.nuvuAuthReject) {
            window.nuvuAuthReject(new Error(event.data.error_description || event.data.error));
            window.nuvuAuthResolve = null;
            window.nuvuAuthReject = null;
        }
    }
}


