// Global state management for nuvu
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

// Dialog references
export let opennuvuDialog = null;
export let nuvuDialog = null;

// Authentication state
export let isAuthenticated = false;
export let currentUser = null;

// Update state
export let updateInProgress = false;

// License state
export let currentLicenseStatus = null;

// Workflows state + caching
const WORKFLOWS_CACHE_KEY = 'nuvu_cached_workflows';
const MODELS_CACHE_KEY = 'nuvu_cached_models';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_DEFAULT_MODE = 'full';
const VERSION_KEYS = [
    'dateUpdated',
    'updated_at',
    'updatedAt',
    'updated',
    'date_updated',
    'lastUpdated',
    'modifiedAt',
];

function readCacheRecord(key) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return null;
    }
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (error) {
        window.localStorage.removeItem(key);
        return null;
    }
}

function computeLatestTimestamp(list) {
    if (!Array.isArray(list)) {
        return null;
    }
    let latest = null;
    for (const item of list) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        for (const key of VERSION_KEYS) {
            const value = item[key];
            if (typeof value === 'string' && value.trim()) {
                const parsed = Date.parse(value);
                if (!Number.isNaN(parsed) && (latest === null || parsed > latest)) {
                    latest = parsed;
                }
            }
        }
    }
    return latest;
}

function buildCacheInfo(record) {
    const data = Array.isArray(record?.data) ? record.data : [];
    const version = typeof record?.version === 'number' ? record.version : null;
    const timestamp = typeof record?.timestamp === 'number' ? record.timestamp : 0;
    const mode = typeof record?.mode === 'string' ? record.mode : CACHE_DEFAULT_MODE;
    const authUser = typeof record?.authUser === 'string' ? record.authUser : null;
    const isExpired = !timestamp || (Date.now() - timestamp > CACHE_TTL_MS);
    return { data, version, timestamp, mode, authUser, isExpired };
}

function createInitialCacheInfo(key) {
    const record = readCacheRecord(key);
    if (record) {
        return buildCacheInfo(record);
    }
    return {
        data: [],
        version: null,
        timestamp: 0,
        mode: CACHE_DEFAULT_MODE,
        authUser: null,
        isExpired: true,
    };
}

function persistCache(key, info) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }
    try {
        const payload = {
            timestamp: info.timestamp || Date.now(),
            version: typeof info.version === 'number' ? info.version : null,
            mode: info.mode || CACHE_DEFAULT_MODE,
            authUser: typeof info.authUser === 'string' ? info.authUser : null,
            data: Array.isArray(info.data) ? info.data : [],
        };
        window.localStorage.setItem(key, JSON.stringify(payload));
    } catch (error) {
    }
}

let workflowsCacheInfo = createInitialCacheInfo(WORKFLOWS_CACHE_KEY);
let modelsCacheInfo = createInitialCacheInfo(MODELS_CACHE_KEY);

export let workflowsData = workflowsCacheInfo.data;
export let modelsData = modelsCacheInfo.data;
export let selectedWorkflows = new Set();
export let selectedModels = new Set();

// Operation state
export let ongoingWorkflowInstall = false;
export let ongoingModelDownload = false;

// Polling intervals
export let workflowPollInterval = null;
export let modelPollInterval = null;
export let pendingRefreshAfterRestart = false;
const pendingRefreshListeners = new Set();

// Setters (to maintain encapsulation for future)
export function setOpennuvuDialog(value) { opennuvuDialog = value; }
export function setnuvuDialog(dialog) { nuvuDialog = dialog; }
export function setAuthenticated(value) { isAuthenticated = value; }
export function setCurrentUser(user) { currentUser = user; }
export function setUpdateInProgress(value) { updateInProgress = value; }
export function setCurrentLicenseStatus(status) { currentLicenseStatus = status; }
export function setWorkflowsData(data, options = {}) {
    workflowsData = Array.isArray(data) ? data : [];
    const version = computeLatestTimestamp(workflowsData);
    const timestamp = Date.now();
    const mode = options.mode === 'preview' ? 'preview' : CACHE_DEFAULT_MODE;
    const authUser = typeof options.user === 'string' ? options.user : null;
    workflowsCacheInfo = {
        data: workflowsData,
        version,
        timestamp,
        mode,
        authUser,
        isExpired: false,
    };
    persistCache(WORKFLOWS_CACHE_KEY, workflowsCacheInfo);
}
export function setModelsData(data, options = {}) {
    modelsData = Array.isArray(data) ? data : [];
    const version = computeLatestTimestamp(modelsData);
    const timestamp = Date.now();
    const mode = options.mode === 'preview' ? 'preview' : CACHE_DEFAULT_MODE;
    modelsCacheInfo = {
        data: modelsData,
        version,
        timestamp,
        mode,
        isExpired: false,
    };
    persistCache(MODELS_CACHE_KEY, modelsCacheInfo);
}
export function setOngoingWorkflowInstall(value) { ongoingWorkflowInstall = value; }
export function setOngoingModelDownload(value) { ongoingModelDownload = value; }

// Selection setters - update the Sets in place
export function updateSelectedWorkflows(ids) {
    selectedWorkflows.clear();
    if (ids && typeof ids[Symbol.iterator] === 'function') {
        for (const id of ids) {
            selectedWorkflows.add(id);
        }
    }
}
export function updateSelectedModels(ids) {
    selectedModels.clear();
    if (ids && typeof ids[Symbol.iterator] === 'function') {
        for (const id of ids) {
            selectedModels.add(id);
        }
    }
}
export function setWorkflowPollInterval(interval) { workflowPollInterval = interval; }
export function setModelPollInterval(interval) { modelPollInterval = interval; }
export function setPendingRefreshAfterRestart(value) {
    pendingRefreshAfterRestart = value;
    pendingRefreshListeners.forEach(listener => {
        try {
            listener(value);
        } catch (error) {
        }
    });
}

export function onPendingRefreshChange(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    pendingRefreshListeners.add(listener);
    return () => pendingRefreshListeners.delete(listener);
}

export function getWorkflowsCacheInfo() {
    return { ...workflowsCacheInfo };
}

export function getModelsCacheInfo() {
    return { ...modelsCacheInfo };
}

export function getLatestDataVersion(list) {
    return computeLatestTimestamp(list);
}

export function hydrateWorkflowsFromCache() {
    if (Array.isArray(workflowsData) && workflowsData.length > 0) {
        return false;
    }
    const record = readCacheRecord(WORKFLOWS_CACHE_KEY);
    if (!record || !Array.isArray(record.data) || record.data.length === 0) {
        return false;
    }
    workflowsCacheInfo = buildCacheInfo(record);
    workflowsData = Array.isArray(workflowsCacheInfo.data) ? workflowsCacheInfo.data : [];
    return workflowsData.length > 0;
}

export function hydrateModelsFromCache() {
    if (Array.isArray(modelsData) && modelsData.length > 0) {
        return false;
    }
    const record = readCacheRecord(MODELS_CACHE_KEY);
    if (!record || !Array.isArray(record.data) || record.data.length === 0) {
        return false;
    }
    modelsCacheInfo = buildCacheInfo(record);
    modelsData = Array.isArray(modelsCacheInfo.data) ? modelsCacheInfo.data : [];
    return modelsData.length > 0;
}

// HuggingFace token management (localStorage only - never sent to server)
const HF_TOKEN_KEY = 'nuvu_hf_token';

/**
 * Get the stored HuggingFace token from localStorage
 * @returns {string} The stored token or empty string if not set
 */
export function getHfToken() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return '';
    }
    try {
        return window.localStorage.getItem(HF_TOKEN_KEY) || '';
    } catch (error) {
        return '';
    }
}

/**
 * Store the HuggingFace token in localStorage
 * @param {string} token - The token to store (empty string or null to clear)
 */
export function setHfToken(token) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }
    try {
        if (token && typeof token === 'string' && token.trim()) {
            window.localStorage.setItem(HF_TOKEN_KEY, token.trim());
        } else {
            window.localStorage.removeItem(HF_TOKEN_KEY);
        }
    } catch (error) {
    }
}

/**
 * Check if a HuggingFace token is stored
 * @returns {boolean} True if a token is stored
 */
export function hasHfToken() {
    return getHfToken().length > 0;
}


