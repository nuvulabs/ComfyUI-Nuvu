import { ensureFreshAccessToken } from '../auth/session.js';
import {
    getActiveApiToken,
    getStoredUserId,
    getStoredUserEmail,
} from '../auth/storage.js';

let cachedIdentity = null;
let identityPromise = null;
let cachedRegistrations = null;
let cachedRegistrationsTimestamp = 0;
const REGISTRATIONS_CACHE_TTL_MS = 5 * 60 * 1000;
let registrationsPromise = null;

function buildAuthHeaders({ json = false } = {}) {
    const token = getActiveApiToken();
    if (!token) {
        return null;
    }

    const headers = {
        'Authorization': `Bearer ${token}`
    };

    const userId = getStoredUserId();
    const email = getStoredUserEmail();
    if (userId) {
        headers['X-User-Id'] = userId;
    }
    if (email) {
        headers['X-User-Email'] = email;
    }

    if (json) {
        headers['Content-Type'] = 'application/json';
    }

    return headers;
}

async function parseResponse(response) {
    const text = await response.text();
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return { message: text };
    }
}

export function invalidateDeviceIdentityCache() {
    cachedIdentity = null;
    identityPromise = null;
    cachedRegistrations = null;
    cachedRegistrationsTimestamp = 0;
    registrationsPromise = null;
}

function ensureDeviceRegistrationState() {
    if (!window.__nuvuDeviceRegistered) {
        window.__nuvuDeviceRegistered = {
            registered: null,
            timestamp: null
        };
    }
    return window.__nuvuDeviceRegistered;
}

export function setDeviceRegistrationState(isRegistered) {
    const state = ensureDeviceRegistrationState();
    state.registered = typeof isRegistered === 'boolean' ? isRegistered : null;
    state.timestamp = Date.now();
    cachedRegistrations = null;
    cachedRegistrationsTimestamp = 0;
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nuvu:device-registration-state-changed', {
            detail: { registered: state.registered }
        }));
    }
}

export function isCurrentDeviceRegistered() {
    const state = ensureDeviceRegistrationState();
    return state.registered;
}

export async function getDeviceIdentity(forceRefresh = false) {
    if (!forceRefresh && cachedIdentity) {
        return cachedIdentity;
    }

    if (!forceRefresh && identityPromise) {
        return identityPromise;
    }

    identityPromise = (async () => {
        const response = await fetch('/nuvu/device/identity');
        if (!response.ok) {
            throw new Error('Failed to collect device identity');
        }
    
        const data = await response.json();
        cachedIdentity = data;
        identityPromise = null;
        return data;
    })();

    return identityPromise;
}

export async function fetchRegisteredDevices(identityOverride = null, options = {}) {
    const { forceRefresh = false } = options;
    await ensureFreshAccessToken();
    const headers = buildAuthHeaders();
    if (!headers) {
        throw new Error('Authentication required');
    }

    const now = Date.now();
    if (!forceRefresh && cachedRegistrations && (now - cachedRegistrationsTimestamp) < REGISTRATIONS_CACHE_TTL_MS) {
        return cachedRegistrations;
    }

    if (!forceRefresh && registrationsPromise) {
        return registrationsPromise;
    }

    const identity = identityOverride || await getDeviceIdentity();

    const fetchPromise = (async () => {
        const response = await fetch('/nuvu/device/registrations', { headers });
        const data = await parseResponse(response);

        if (!response.ok) {
            const errorMessage = data?.error || 'Failed to load device registrations';
            throw new Error(errorMessage);
        }

        const devices = Array.isArray(data?.devices) ? data.devices : [];
        // Use the STORED fingerprint hash (from registration) if available,
        // falling back to the freshly collected one. This handles cases where
        // the system's MAC address or other identity components change between sessions.
        const storedHash = identity?.stored_device?.fingerprint_hash;
        const freshHash = identity?.fingerprint_hash || identity?.fingerprintHash;
        const currentHash = storedHash || freshHash;
        const currentDevice = devices.find(device =>
            currentHash && device.fingerprintHash && currentHash === device.fingerprintHash
        );
        const isRegistered = Boolean(currentDevice);
        setDeviceRegistrationState(isRegistered);

        if (!isRegistered) {
            const hasFreeSlot = typeof data?.maxSlots === 'number'
                ? devices.length < data.maxSlots
                : true;
            if (hasFreeSlot) {
                try {
                    await registerCurrentDevice({
                        mode: 'auto',
                        clientTimestamp: new Date().toISOString(),
                    });
                    invalidateDeviceIdentityCache();
                    return fetchRegisteredDevices(null, { forceRefresh: true });
                } catch (error) {
                }
            } else {
                setDeviceRegistrationState(false);
            }
        }

        cachedRegistrations = data;
        cachedRegistrationsTimestamp = Date.now();
        return data;
    })();

    registrationsPromise = fetchPromise.finally(() => {
        registrationsPromise = null;
    });

    return registrationsPromise;
}

export async function registerCurrentDevice({
    deviceLabel,
    replaceDeviceId = null,
    mode = 'manual',
    clientTimestamp = new Date().toISOString(),
} = {}) {
    await ensureFreshAccessToken();
    const headers = buildAuthHeaders({ json: true });
    if (!headers) {
        throw new Error('Authentication required');
    }

    const payload = {
        device_label: deviceLabel,
        replace_device_id: replaceDeviceId,
        mode,
        client_timestamp: clientTimestamp,
        source: 'comfyui-nuvu',
    };

    const response = await fetch('/nuvu/device/register', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    const data = await parseResponse(response);

    if (!response.ok) {
        const error = new Error(data?.error || 'Device registration failed');
        error.response = data;
        error.status = response.status;
        throw error;
    }

    invalidateDeviceIdentityCache();
    setDeviceRegistrationState(true);
    const event = new CustomEvent('nuvu:device-registered', {
        detail: {
            deviceLabel,
            replaceDeviceId,
            mode,
            timestamp: clientTimestamp,
        },
    });
    window.dispatchEvent(event);
    return data;
}

export async function autoSyncDeviceRegistration() {
    try {
        await ensureFreshAccessToken();
        await registerCurrentDevice({
            mode: 'auto',
            clientTimestamp: new Date().toISOString(),
        });
    } catch (error) {
        if (error?.status === 409) {
            return;
        }
    }
}

export async function sendLoginTelemetry(context = {}) {
    await ensureFreshAccessToken();
    const headers = buildAuthHeaders({ json: true });
    if (!headers) {
        return;
    }

    try {
        await fetch('/nuvu/telemetry/login', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                client_timestamp: new Date().toISOString(),
                source: 'comfyui-nuvu',
                context,
            }),
        });
    } catch (error) {
    }
}



