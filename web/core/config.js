// Configuration management
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

// Configuration - fetched from backend (single source of truth)
let WEBSITE_BASE_URL = null; // No fallback - must be fetched from backend

export function setWebsiteBaseUrl(url) {
    WEBSITE_BASE_URL = url;
}

export function getWebsiteBaseUrl() {
    return WEBSITE_BASE_URL;
}

// Fetch configuration from backend
export async function fetchConfig() {
    try {
        const response = await fetch('/nuvu/config');
        
        if (response.ok) {
            const config = await response.json();
            WEBSITE_BASE_URL = config.websiteBaseUrl;
        } else {
            throw new Error(`Config fetch failed with status: ${response.status}`);
        }
    } catch (error) {
        throw new Error(`Cannot proceed without config: ${error.message}`);
    }
}

// Function to get the correct callback URL for any ComfyUI setup
export function getCallbackUrl() {
    const currentOrigin = window.location.origin;
    const currentPath = window.location.pathname;
    
    const callbackUrl = currentOrigin + currentPath;
    return callbackUrl;
}

// OAuth flow configuration - redirect to your website for authentication
export function getOAuthConfig() {
    return {
        // Your website's auth endpoint
        authUrl: WEBSITE_BASE_URL + '/api/auth/login',
        // Your website will redirect back to ComfyUI with the token
        callbackUrl: getCallbackUrl()
    };
}


