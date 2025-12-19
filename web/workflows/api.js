// Workflow API interactions
// Extracted from nuvu.js - DO NOT MODIFY BEHAVIOR

import * as state from '../core/state.js';
import { getWebsiteBaseUrl } from '../core/config.js';
import { loadModels } from '../models/api.js';
import { invalidateLocalSession } from '../auth/session.js';

// Caches to avoid re-fetching workflow/subgraph data and installed models
const workflowDetailsCache = new Map(); // workflowId -> workflow data (with dependencies)
const workflowModelCache = new Map(); // workflowId -> [{ id, name, size, url }]
let existingModelsCache = null; // array of installed model IDs
let existingModelsCacheTimestamp = 0;
const EXISTING_MODELS_CACHE_TTL_MS = 60 * 1000; // 1 minute
let workflowsFetchPromise = null;
let workflowsFetchController = null;
let workflowsFetchSilent = true;

export function cancelWorkflowsFetch() {
    if (workflowsFetchController) {
        workflowsFetchController.abort();
        workflowsFetchController = null;
    }
}

/**
 * Check if any cached workflow media URLs are expired or about to expire.
 * This helps detect when we need to rehydrate media even if metadata cache is valid.
 */
export function hasExpiredMedia() {
    if (!Array.isArray(state.workflowsData) || state.workflowsData.length === 0) {
        return false;
    }
    
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer
    
    for (const workflow of state.workflowsData) {
        if (!workflow || !Array.isArray(workflow.media)) {
            continue;
        }
        
        for (const mediaItem of workflow.media) {
            if (!mediaItem) continue;
            
            // Check explicit expiry field
            const expiresAt = mediaItem.fileUrlExpiresAt || mediaItem.file_url_expires_at;
            if (expiresAt) {
                const expiryTime = Date.parse(expiresAt);
                if (!Number.isNaN(expiryTime) && expiryTime < now + bufferMs) {
                    return true;
                }
            }
            
            // Check S3 presigned URL Expires parameter
            const source = mediaItem.fileUrl || mediaItem.file_url || mediaItem.url || '';
            if (source) {
                try {
                    const urlObj = new URL(source, 'http://dummy.com');
                    const expiresParam = urlObj.searchParams.get('Expires');
                    if (expiresParam) {
                        const expiryTimestamp = parseInt(expiresParam, 10) * 1000;
                        if (!Number.isNaN(expiryTimestamp) && expiryTimestamp < now + bufferMs) {
                            return true;
                        }
                    }
                } catch (e) {
                    // Ignore URL parsing errors
                }
            }
        }
    }
    
    return false;
}

const MEDIA_REFRESH_SAFETY_MS = 2 * 60 * 1000;
const MEDIA_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MEDIA_REFRESH_CONCURRENCY = 3;
let mediaRefreshTimer = null;
let mediaRefreshInFlight = false;

export function isWorkflowsFetchInFlight() {
    return workflowsFetchPromise !== null;
}

const WORKFLOW_VERSION_KEYS = [
    'updated_at',
    'updatedAt',
    'dateUpdated',
    'date_updated',
    'dateModified',
    'modified_at',
    'modifiedAt',
    'lastUpdated',
    'workflow_updated_at'
];

function getWorkflowTimestamp(workflow) {
    if (!workflow || typeof workflow !== 'object') return 0;
    let latest = 0;
    for (const key of WORKFLOW_VERSION_KEYS) {
        const value = workflow[key];
        if (typeof value === 'string' && value.trim()) {
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed) && parsed > latest) {
                latest = parsed;
            }
        } else if (typeof value === 'number' && Number.isFinite(value) && value > latest) {
            latest = value;
        }
    }
    return latest;
}

function shouldRefreshWorkflows(cacheInfo, hasSubscription) {
    if (!cacheInfo) {
        return true;
    }
    if (!Array.isArray(cacheInfo.data) || cacheInfo.data.length === 0) {
        return true;
    }
    if (cacheInfo.isExpired) {
        return true;
    }
    if (hasSubscription && cacheInfo.mode === 'preview') {
        return true;
    }
    return false;
}

function clearWorkflowCaches() {
    workflowDetailsCache.clear();
    workflowModelCache.clear();
    existingModelsCache = null;
    existingModelsCacheTimestamp = 0;
    clearMediaRefreshTimer();
}

function seedWorkflowCache(workflows) {
    if (!Array.isArray(workflows)) return;
    workflows.forEach(workflow => {
        if (workflow && workflow.id) {
            workflowDetailsCache.set(workflow.id, workflow);
            cacheWorkflowModels(workflow);
        }
    });
}

function fetchWorkflowsErrorMessage() {
    return '<div class="nuvu-centered-placeholder" style="color:#ff7777;">Failed to load workflows, check that:<br>1. your premium subscription is active.<br>2. your device is registered in "User Configuration".</div>';
}

async function fetchAndPersistWorkflows(hasSubscription, { silent } = {}) {
    if (workflowsFetchPromise) {
        if (!silent) {
            workflowsFetchSilent = false;
        }
        return workflowsFetchPromise;
    }

    workflowsFetchSilent = silent;
    workflowsFetchPromise = (async () => {
        try {
            if (workflowsFetchController) {
                workflowsFetchController.abort();
            }
            workflowsFetchController = new AbortController();
            const signal = workflowsFetchController.signal;

            // Always use metadata endpoint for initial load to ensure fast response time
            // Full details (media, signed URLs, dependencies) will be hydrated lazily via IntersectionObserver
            const endpoint = '/nuvu/workflows-metadata';
            const previewMode = !hasSubscription;

            const response = await fetch(endpoint, {
                headers: {
                    'Authorization': `Bearer ${state.currentUser.apiToken}`,
                    'Content-Type': 'application/json',
                    'X-User-Email': state.currentUser.email,
                    'X-User-Id': state.currentUser.id,
                },
                signal,
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    invalidateLocalSession('workflows_unauthorized');
                    return false;
                }
                // Suppress rate limiting errors (429) — they usually just slow requests down.
                if (response.status === 429) {
                    return false;
                }
                throw new Error(`Failed to fetch workflows: ${response.status}`);
            }

            const data = await response.json();

            if (previewMode && Array.isArray(data)) {
                data.forEach((w) => (w._previewMode = true));
            }

            // SMART MERGE: Preserve hydrated details (media, dependencies) from current state if versions match.
            // This prevents the metadata-only fetch from overwriting valid, cached full details.
            if (Array.isArray(state.workflowsData) && state.workflowsData.length > 0) {
                const currentMap = new Map(state.workflowsData.map(w => [w.id, w]));
                data.forEach((newItem) => {
                    if (!newItem || !newItem.id) return;
                    const oldItem = currentMap.get(newItem.id);
                    if (oldItem) {
                        const newTime = getWorkflowTimestamp(newItem);
                        const oldTime = getWorkflowTimestamp(oldItem);
                        
                        // If timestamps match (and are valid), preserve heavy data
                        if (newTime > 0 && newTime === oldTime) {
                             if (Array.isArray(oldItem.media) && oldItem.media.length > 0) {
                                 const now = Date.now();
                                 const hasExpired = oldItem.media.some(m => {
                                     const exp = m.fileUrlExpiresAt || m.file_url_expires_at;
                                     // 5 minute buffer: if it expires within 5 mins (or is already expired), treat as expired
                                     return exp && (Date.parse(exp) < now + 5 * 60 * 1000); 
                                 });
                                 if (!hasExpired) {
                                    newItem.media = oldItem.media.map(m => ({...m}));
                                 }
                             }
                             if (oldItem.dependencies) {
                                 newItem.dependencies = oldItem.dependencies;
                             }
                             // Also preserve generated ID if present to avoid re-keying
                             if (oldItem.__workflowGeneratedId) {
                                 newItem.__workflowGeneratedId = oldItem.__workflowGeneratedId;
                             }
                        }
                    }
                });
            }

            const cacheInfo =
                typeof state.getWorkflowsCacheInfo === 'function' ? state.getWorkflowsCacheInfo() : null;
            const previousVersion = cacheInfo ? cacheInfo.version : null;
            const newVersion =
                typeof state.getLatestDataVersion === 'function' ? state.getLatestDataVersion(data) : null;
            const mode = previewMode ? 'preview' : 'full';
            const versionChanged =
                !previousVersion ||
                !newVersion ||
                previousVersion !== newVersion ||
                (cacheInfo && cacheInfo.mode !== mode) ||
                (cacheInfo && cacheInfo.isExpired) ||
                (() => {
                    const userId = state.currentUser?.id || state.currentUser?.email || null;
                    if (!userId) return false;
                    return cacheInfo?.authUser && cacheInfo.authUser !== userId;
                })();

            if (versionChanged) {
                clearWorkflowCaches();
                seedWorkflowCache(data);
                const userId = state.currentUser?.id || state.currentUser?.email || null;
                state.setWorkflowsData(data, { mode, user: userId });
            } else {
                const userId = state.currentUser?.id || state.currentUser?.email || null;
                state.setWorkflowsData(data, { mode, user: userId });
            }
            if (Array.isArray(state.workflowsData)) {
                state.workflowsData.forEach(cacheWorkflowModels);
            }
            scheduleMediaRefresh(state.workflowsData);
            loadModels({ backgroundRefresh: true }).catch(() => {});

            return true;
        } catch (error) {
            if (error.name === 'AbortError') {
                return false;
            }
            if (workflowsFetchSilent) {
            } else {
                const workflowsList = document.getElementById('nuvu-workflows-list');
                if (workflowsList) {
                    workflowsList.innerHTML = fetchWorkflowsErrorMessage();
                }
            }
            return false;
        } finally {
            workflowsFetchPromise = null;
            workflowsFetchController = null;
            workflowsFetchSilent = true;
        }
    })();

    return workflowsFetchPromise;
}

function extractDynamoValue(value) {
    if (!value) return null;
    if (value.S) return value.S;
    if (value.N) return parseFloat(value.N);
    if (value.L) return value.L.map(item => extractDynamoValue(item));
    if (value.M) {
        const result = {};
        for (const [key, val] of Object.entries(value.M)) {
            result[key] = extractDynamoValue(val);
        }
        return result;
    }
    return value;
}

function extractModelsFromDependencies(dependencies) {
    if (!dependencies || typeof dependencies !== 'object') {
        return [];
    }
    const models = Array.isArray(dependencies.models) ? dependencies.models : [];
    return models
        .map((model) => {
            if (!model || typeof model !== 'object' || !model.id) {
                return null;
            }
            const size = typeof model.size === 'number'
                ? model.size
                : (typeof model.fileSize === 'number' ? model.fileSize : 0);
            return {
                id: model.id,
                name: model.name || model.modelName || '',
                size,
                url: model.url || '',
                hfTokenRequired: model.hfTokenRequired === true || model.hf_token_required === true,
            };
        })
        .filter(Boolean);
}

function resolveWorkflowId(workflow) {
    if (!workflow || typeof workflow !== 'object') {
        return null;
    }
    const candidates = [
        workflow.id,
        workflow.workflowId,
        workflow.workflow_id,
        workflow.slug,
        workflow.__workflowGeneratedId,
    ];
    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null) {
            const value = String(candidate).trim();
            if (value) {
                return value;
            }
        }
    }
    return null;
}

function workflowMatchesId(workflow, workflowId) {
    const resolved = resolveWorkflowId(workflow);
    if (!resolved) {
        return false;
    }
    return String(resolved) === String(workflowId);
}

function ensureWorkflowCachedFromState(workflowId) {
    if (workflowModelCache.has(workflowId)) {
        return;
    }
    if (!Array.isArray(state.workflowsData)) {
        return;
    }
    const workflow = state.workflowsData.find(w => workflowMatchesId(w, workflowId));
    if (workflow) {
        cacheWorkflowModels(workflow);
        const resolvedId = resolveWorkflowId(workflow) || workflowId;
        if (!workflowDetailsCache.has(resolvedId)) {
            workflowDetailsCache.set(resolvedId, workflow);
        }
    }
}

function cacheWorkflowModels(workflow) {
    const resolvedId = resolveWorkflowId(workflow);
    if (!resolvedId) {
        return;
    }
    if (!workflow.id) {
        workflow.id = resolvedId;
    }
    let dependencies = extractDynamoValue(workflow.dependencies);
    let models = [];
    if (Array.isArray(workflow.models)) {
        models = workflow.models
            .map(model => {
                if (!model || typeof model !== 'object' || !model.id) {
                    return null;
                }
                const size = typeof model.size === 'number'
                    ? model.size
                    : (typeof model.fileSize === 'number' ? model.fileSize : 0);
                return {
                    id: model.id,
                    name: model.name || model.modelName || '',
                    size,
                    url: model.url || '',
                    hfTokenRequired: model.hfTokenRequired === true || model.hf_token_required === true,
                };
            })
            .filter(Boolean);
    } else {
        models = extractModelsFromDependencies(dependencies);
    }
    // Enrich hfTokenRequired from global models metadata if missing/false
    const globalModels = Array.isArray(state.modelsData) ? state.modelsData : [];
    const mergedModels = models.map((model) => {
        if (model && model.hfTokenRequired === true) {
            return model;
        }
        const globalMatch = globalModels.find((gm) => gm && gm.id === model.id);
        if (globalMatch && globalMatch.hfTokenRequired === true) {
            return { ...model, hfTokenRequired: true };
        }
        return model;
    });
    workflowModelCache.set(resolvedId, mergedModels);
}

export async function fetchWorkflowDetails(workflowId, options = {}) {
    const { refresh = false, mediaOnly = false } = options;

    // Return cached workflow if we already have dependencies for it
    if (!refresh && workflowDetailsCache.has(workflowId)) {
        return workflowDetailsCache.get(workflowId);
    }

    // Try to find it in the workflows list loaded earlier
    if (!refresh) {
        ensureWorkflowCachedFromState(workflowId);
        const cached = workflowDetailsCache.get(workflowId);
        if (cached && (!mediaOnly || cached.dependencies)) {
            return cached;
        }
    }

    // Fallback to fetching from the local server
    try {
        const response = await fetch(`/nuvu/workflows/${workflowId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${state.currentUser.apiToken}`,
                'Content-Type': 'application/json',
                'X-User-Email': state.currentUser.email,
                'X-User-Id': state.currentUser.id,
            }
        });

        if (!response.ok) {
            return null;
        }

        const workflow = await response.json();
        const resolvedId = resolveWorkflowId(workflow) || workflowId;
        workflowDetailsCache.set(resolvedId, workflow);
        cacheWorkflowModels(workflow);
        return workflow;
    } catch (error) {
        return null;
    }
}

/**
 * Refresh a single workflow's media URLs by fetching fresh presigned URLs from the API.
 * Updates both the workflowDetailsCache and the workflowsData state.
 * 
 * @param {string} workflowId - The workflow ID to refresh
 * @returns {Object|null} The refreshed workflow or null if failed
 */
export async function refreshWorkflowMedia(workflowId) {
    if (!workflowId) return null;
    
    try {
        // Force fetch from API to get fresh presigned URLs
        const response = await fetch(`/nuvu/workflows/${workflowId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${state.currentUser?.apiToken}`,
                'Content-Type': 'application/json',
                'X-User-Email': state.currentUser?.email,
                'X-User-Id': state.currentUser?.id,
            }
        });

        if (!response.ok) {
            return null;
        }

        const freshWorkflow = await response.json();
        const resolvedId = resolveWorkflowId(freshWorkflow) || workflowId;
        
        // Update the details cache
        workflowDetailsCache.set(resolvedId, freshWorkflow);
        
        // Update the workflow in state.workflowsData if it exists
        if (Array.isArray(state.workflowsData)) {
            const index = state.workflowsData.findIndex(w => workflowMatchesId(w, workflowId));
            if (index !== -1) {
                // Merge fresh media into existing workflow
                const existing = state.workflowsData[index];
                if (freshWorkflow.media) {
                    existing.media = freshWorkflow.media;
                }
                if (freshWorkflow.thumbnailUrl) {
                    existing.thumbnailUrl = freshWorkflow.thumbnailUrl;
                }
            }
        }
        
        return freshWorkflow;
    } catch (error) {
        return null;
    }
}

/**
 * Check if a specific workflow's media URLs are expired or about to expire.
 * 
 * @param {Object} workflow - The workflow object to check
 * @param {number} bufferMs - Buffer time before expiry (default 5 minutes)
 * @returns {boolean} True if any media is expired or expiring soon
 */
export function isWorkflowMediaExpired(workflow, bufferMs = 5 * 60 * 1000) {
    if (!workflow || !Array.isArray(workflow.media) || workflow.media.length === 0) {
        return false;
    }
    
    const now = Date.now();
    
    for (const mediaItem of workflow.media) {
        if (!mediaItem) continue;
        
        // Check explicit expiry field
        const expiresAt = mediaItem.fileUrlExpiresAt || mediaItem.file_url_expires_at;
        if (expiresAt) {
            const expiryTime = Date.parse(expiresAt);
            if (!Number.isNaN(expiryTime) && expiryTime < now + bufferMs) {
                return true;
            }
        }
        
        // Check S3 presigned URL Expires parameter
        const source = mediaItem.fileUrl || mediaItem.file_url || mediaItem.url || '';
        if (source) {
            try {
                const urlObj = new URL(source, 'http://dummy.com');
                const expiresParam = urlObj.searchParams.get('Expires');
                if (expiresParam) {
                    const expiryTimestamp = parseInt(expiresParam, 10) * 1000;
                    if (!Number.isNaN(expiryTimestamp) && expiryTimestamp < now + bufferMs) {
                        return true;
                    }
                }
            } catch (e) {
                // Ignore URL parsing errors
            }
        }
    }
    
    return false;
}

export async function loadWorkflows(options = {}) {
    const { backgroundRefresh = true, force = false, selectForWarmup = [] } = options;
    const cacheInfo = typeof state.getWorkflowsCacheInfo === 'function' ? state.getWorkflowsCacheInfo() : null;
    const hasCached = cacheInfo && Array.isArray(cacheInfo.data) && cacheInfo.data.length > 0;

    // Ensure license status is hydrated before deciding preview/full mode.
    if (!state.currentLicenseStatus) {
        try {
            const { fetchLicenseStatus } = await import('../license/status.js');
            await fetchLicenseStatus({ useCache: true, backgroundRefresh: true });
        } catch (e) {
            // Ignore; we'll fall back to preview mode below.
        }
    }

    const hasSubscription =
        state.currentLicenseStatus &&
        (state.currentLicenseStatus.has_paid_subscription || state.currentLicenseStatus.status === 'paid');

    const needsRefresh = force || shouldRefreshWorkflows(cacheInfo, hasSubscription);

    if (!state.currentUser || !state.currentUser.apiToken) {
        return hasCached;
    }

    if (!needsRefresh) {
        return true;
    }

    return fetchAndPersistWorkflows(hasSubscription, { silent: backgroundRefresh, selectForWarmup });
}

export async function ensureWorkflowsDataReady(options = {}) {
    const { force = false } = options;
    if (!force && Array.isArray(state.workflowsData) && state.workflowsData.length > 0) {
        return true;
    }
    if (workflowsFetchPromise) {
        try {
            await workflowsFetchPromise;
        } catch (error) {
        }
        return Array.isArray(state.workflowsData) && state.workflowsData.length > 0;
    }
    await loadWorkflows({ backgroundRefresh: false, force: true });
    return Array.isArray(state.workflowsData) && state.workflowsData.length > 0;
}

export async function getExistingModels() {
    const now = Date.now();
    if (existingModelsCache && (now - existingModelsCacheTimestamp) < EXISTING_MODELS_CACHE_TTL_MS) {
        return new Set(existingModelsCache);
    }

    try {
        const response = await fetch('/nuvu/models/check-existing', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${state.currentUser.apiToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const models = data.existingModels || [];
            existingModelsCache = Array.from(models);
            existingModelsCacheTimestamp = now;
            return new Set(models);
        }
    } catch (error) {
    }
    
    return new Set(); // Return empty set if check fails
}

export async function calculateTotalWorkflowSize(selectedWorkflowIds, options = {}) {
    const { forceRefreshCache = false } = options;
    let totalSize = 0;
    const uniqueModels = new Map(); // model_id -> model_data
    const existingModels = await getExistingModels();
    if (forceRefreshCache) {
        const hydrationPromises = [];
        for (const workflowId of selectedWorkflowIds) {
            if (!workflowModelCache.has(workflowId)) {
                hydrationPromises.push(fetchWorkflowDetails(workflowId));
                    }
                }
        if (hydrationPromises.length) {
            await Promise.allSettled(hydrationPromises);
                    }
                }
    
    for (const workflowId of selectedWorkflowIds) {
        if (!workflowModelCache.has(workflowId)) {
            if (!forceRefreshCache) {
                ensureWorkflowCachedFromState(workflowId);
                if (!workflowModelCache.has(workflowId)) {
                    continue;
                }
            } else {
        const workflow = await fetchWorkflowDetails(workflowId);
        if (!workflow) {
            continue;
        }
            }
        }
        const models = workflowModelCache.get(workflowId) || [];
        models.forEach(model => {
            if (!model || !model.id) {
                return;
            }
            if (existingModels.has(model.id) || uniqueModels.has(model.id)) {
                return;
            }
            uniqueModels.set(model.id, {
                id: model.id,
                name: model.name || '',
                size: typeof model.size === 'number' ? model.size : 0,
                url: model.url || ''
            });
        if (model.size && model.size > 0) {
            totalSize += model.size;
        }
    });
    }
    
    return {
        totalSize: totalSize,
        uniqueModelsCount: uniqueModels.size,
        uniqueModels: Array.from(uniqueModels.values())
    };
}

export async function checkWorkflowsForHFTokenRequirement(options = {}) {
    const { forceRefreshCache = false } = options;
    let requiresHFToken = false;
    
    for (const workflowId of state.selectedWorkflows) {
        if (!workflowModelCache.has(workflowId)) {
            if (forceRefreshCache) {
        const workflow = await fetchWorkflowDetails(workflowId);
        if (!workflow) {
            continue;
        }
            } else {
                ensureWorkflowCachedFromState(workflowId);
                if (!workflowModelCache.has(workflowId)) {
                    continue;
                }
            }
        }
        const models = workflowModelCache.get(workflowId) || [];
        if (models.some(model => model && model.hfTokenRequired === true)) {
                    requiresHFToken = true;
                    break;
                }
    }
    
    return requiresHFToken;
}

function extractWorkflowInstallMessage(workflow) {
    if (!workflow || typeof workflow !== 'object') {
        return null;
    }

    const candidateKeys = [
        'workflowInstallMessage',
        'installMessage',
        'install_message',
        'workflow_message',
        'workflow_install_message',
    ];

    for (const key of candidateKeys) {
        const value = workflow[key];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }

    return null;
}

export async function collectWorkflowInstallMessages(workflowIds) {
    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
        return [];
    }

    const buildEntry = (workflow) => {
            if (!workflow) {
                return null;
            }
            const message = extractWorkflowInstallMessage(workflow);
            if (!message) {
                return null;
            }
            const name = workflow.name || workflow.workflowName || 'Workflow';
        const id = workflow.id || workflow.workflowId || workflow.workflow_id;
        return id ? { id, name, message } : null;
    };

    const entries = [];

    workflowIds.forEach((workflowId) => {
        const cached = Array.isArray(state.workflowsData)
            ? state.workflowsData.find(w => w && (w.id === workflowId || w.workflowId === workflowId || w.workflow_id === workflowId))
            : null;
        if (cached) {
            const entry = buildEntry(cached);
            if (entry) {
                entries.push(entry);
            }
        }
    });

    return entries;
}

function clearMediaRefreshTimer() {
    if (mediaRefreshTimer) {
        clearTimeout(mediaRefreshTimer);
        mediaRefreshTimer = null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshExpiringWorkflowMedia(workflows) {
    if (mediaRefreshInFlight) {
        return;
    }

    if (!state.currentUser || !state.currentUser.apiToken) {
        return;
    }

    if (!Array.isArray(workflows) || workflows.length === 0) {
        return;
    }

    const workflowIds = [];
    for (const workflow of workflows) {
        if (!workflow) continue;
        if (!isWorkflowMediaExpired(workflow, MEDIA_REFRESH_BUFFER_MS)) continue;
        const workflowId = resolveWorkflowId(workflow);
        if (workflowId) {
            workflowIds.push(workflowId);
        }
    }

    const uniqueWorkflowIds = Array.from(new Set(workflowIds));
    if (uniqueWorkflowIds.length === 0) {
        return;
    }

    mediaRefreshInFlight = true;
    try {
        let index = 0;
        const workerCount = Math.min(MEDIA_REFRESH_CONCURRENCY, uniqueWorkflowIds.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (index < uniqueWorkflowIds.length) {
                const workflowId = uniqueWorkflowIds[index];
                index += 1;

                try {
                    await refreshWorkflowMedia(workflowId);
                } catch (e) {
                    // ignore single-workflow refresh failures
                }

                // Yield to keep UI responsive when many workflows refresh at once.
                await sleep(0);
            }
        });

        await Promise.allSettled(workers);
    } finally {
        mediaRefreshInFlight = false;
        scheduleMediaRefresh(state.workflowsData);
    }
}

function scheduleMediaRefresh(workflows) {
    clearMediaRefreshTimer();
    if (!Array.isArray(workflows) || workflows.length === 0) {
        return;
    }

    let soonestExpiry = null;
    workflows.forEach((workflow) => {
        if (!workflow || !Array.isArray(workflow.media)) {
            return;
        }
        workflow.media.forEach((mediaItem) => {
            if (!mediaItem) {
                return;
            }
            const expiresAt = mediaItem.fileUrlExpiresAt || mediaItem.file_url_expires_at;
            if (!expiresAt) {
                return;
            }
            const timestamp = Date.parse(expiresAt);
            if (Number.isNaN(timestamp)) {
                return;
            }
            if (soonestExpiry === null || timestamp < soonestExpiry) {
                soonestExpiry = timestamp;
            }
        });
    });

    if (!soonestExpiry) {
        return;
    }

    const delay = Math.max(0, soonestExpiry - MEDIA_REFRESH_SAFETY_MS - Date.now());
    mediaRefreshTimer = setTimeout(() => {
        mediaRefreshTimer = null;
        refreshExpiringWorkflowMedia(state.workflowsData).catch(() => {});
    }, delay);
}











