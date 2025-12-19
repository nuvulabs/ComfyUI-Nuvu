import * as state from '../core/state.js';

const PROFILE_KEY = 'nuvu_user_profile';
const USER_ID_KEY = 'nuvu_user_id';
const USER_EMAIL_KEY = 'nuvu_user_email';

function normalizeProfile(rawProfile = {}) {
    if (!rawProfile || typeof rawProfile !== 'object') {
        return null;
    }

    const apiToken = rawProfile.apiToken || rawProfile.accessToken || null;
    const profile = {
        id: rawProfile.id || rawProfile.sub || rawProfile.user_id || null,
        name: rawProfile.name || '',
        email: rawProfile.email || '',
        picture: rawProfile.picture || '',
        provider: rawProfile.provider || 'website',
        apiToken,
        accessToken: rawProfile.accessToken || apiToken,
        userToken: rawProfile.userToken || rawProfile.idToken || null,
    };

    if (!profile.apiToken && !profile.accessToken) {
        return null;
    }

    return profile;
}

export function decodeTokenExpiry(token) {
    if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
        return null;
    }
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload && typeof payload.exp === 'number') {
            return payload.exp * 1000;
        }
    } catch (error) {
    }
    return null;
}

export function persistUserProfile(user, tokens = {}) {
    const normalized = normalizeProfile({
        ...user,
        apiToken: tokens.apiToken || tokens.accessToken,
        accessToken: tokens.accessToken || tokens.apiToken,
        userToken: tokens.userToken,
    });

    if (!normalized) {
        return;
    }

    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(normalized));
        if (normalized.id) {
            localStorage.setItem(USER_ID_KEY, normalized.id);
        }
        if (normalized.email) {
            localStorage.setItem(USER_EMAIL_KEY, normalized.email);
        }
    } catch (error) {
    }

    state.setAuthenticated(true);
    state.setCurrentUser(normalized);
}

export function loadStoredUserProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (!raw) {
            return null;
        }
        return normalizeProfile(JSON.parse(raw));
    } catch (error) {
        localStorage.removeItem(PROFILE_KEY);
        return null;
    }
}

export function clearStoredUserProfile() {
    try {
        localStorage.removeItem(PROFILE_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(USER_EMAIL_KEY);
    } catch (error) {
    }
    state.setAuthenticated(false);
    state.setCurrentUser(null);
}

export function hydrateUserFromStorage() {
    const stored = loadStoredUserProfile();
    if (stored) {
        state.setAuthenticated(true);
        state.setCurrentUser(stored);
        return true;
    }
    return false;
}

export function getActiveApiToken() {
    return (
        state.currentUser?.apiToken ||
        state.currentUser?.accessToken ||
        localStorage.getItem('api_token') ||
        null
    );
}

export function getStoredUserId() {
    return state.currentUser?.id || localStorage.getItem(USER_ID_KEY) || null;
}

export function getStoredUserEmail() {
    return state.currentUser?.email || localStorage.getItem(USER_EMAIL_KEY) || null;
}


