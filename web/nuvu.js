import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
let WEBSITE_BASE_URL = null;
function getWebsiteBaseUrl() {
  return WEBSITE_BASE_URL;
}
async function fetchConfig() {
  try {
    const response = await fetch("/nuvu/config");
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
function getCallbackUrl() {
  const currentOrigin = window.location.origin;
  const currentPath = window.location.pathname;
  return currentOrigin + currentPath;
}
function getOAuthConfig() {
  return {
    // Your website's auth endpoint
    authUrl: WEBSITE_BASE_URL + "/api/auth/login",
    // Your website will redirect back to ComfyUI with the token
    callbackUrl: getCallbackUrl()
  };
}
let opennuvuDialog = null;
let nuvuDialog = null;
let isAuthenticated = false;
let currentUser = null;
let currentLicenseStatus = null;
let floatingSession = null;
const WORKFLOWS_CACHE_KEY = "nuvu_cached_workflows";
const MODELS_CACHE_KEY = "nuvu_cached_models";
const CACHE_TTL_MS = 30 * 60 * 1e3;
const CACHE_DEFAULT_MODE = "full";
let workflowsPaginationCursor = null;
const VERSION_KEYS = [
  "dateUpdated",
  "updated_at",
  "updatedAt",
  "updated",
  "date_updated",
  "lastUpdated",
  "modifiedAt"
];
function readCacheRecord(key) {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
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
    if (!item || typeof item !== "object") {
      continue;
    }
    for (const key of VERSION_KEYS) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) {
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
  const version2 = typeof record?.version === "number" ? record.version : null;
  const timestamp = typeof record?.timestamp === "number" ? record.timestamp : 0;
  const mode = typeof record?.mode === "string" ? record.mode : CACHE_DEFAULT_MODE;
  const authUser = typeof record?.authUser === "string" ? record.authUser : null;
  const isExpired = !timestamp || Date.now() - timestamp > CACHE_TTL_MS;
  const nextCursor = record?.nextCursor ?? null;
  return { data, version: version2, timestamp, mode, authUser, isExpired, nextCursor };
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
    isExpired: true
  };
}
function persistCache(key, info) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const payload = {
      timestamp: info.timestamp || Date.now(),
      version: typeof info.version === "number" ? info.version : null,
      mode: info.mode || CACHE_DEFAULT_MODE,
      authUser: typeof info.authUser === "string" ? info.authUser : null,
      data: Array.isArray(info.data) ? info.data : [],
      nextCursor: info.nextCursor ?? null
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
  }
}
let workflowsCacheInfo = createInitialCacheInfo(WORKFLOWS_CACHE_KEY);
let modelsCacheInfo = createInitialCacheInfo(MODELS_CACHE_KEY);
let workflowsData = workflowsCacheInfo.data;
let modelsData = modelsCacheInfo.data;
workflowsPaginationCursor = workflowsCacheInfo.nextCursor;
let selectedWorkflows = /* @__PURE__ */ new Set();
let selectedModels = /* @__PURE__ */ new Set();
let ongoingWorkflowInstall = false;
let ongoingModelDownload = false;
let workflowPollInterval = null;
let modelPollInterval = null;
let pendingRefreshAfterRestart = false;
const pendingRefreshListeners = /* @__PURE__ */ new Set();
function setOpennuvuDialog(value) {
  opennuvuDialog = value;
}
function setnuvuDialog(dialog) {
  nuvuDialog = dialog;
}
function setAuthenticated(value) {
  isAuthenticated = value;
}
function setCurrentUser(user) {
  currentUser = user;
}
function setCurrentLicenseStatus(status) {
  currentLicenseStatus = status;
}
function getGlobalState(key) {
  return floatingSession;
}
function setGlobalState(key, value) {
  {
    floatingSession = value;
    return;
  }
}
function setWorkflowsData(data, options = {}) {
  workflowsData = Array.isArray(data) ? data : [];
  const version2 = computeLatestTimestamp(workflowsData);
  const timestamp = Date.now();
  const validModes = ["preview", "paginated", "full"];
  const mode = validModes.includes(options.mode) ? options.mode : CACHE_DEFAULT_MODE;
  const authUser = typeof options.user === "string" ? options.user : null;
  const cursor = "nextCursor" in options ? options.nextCursor : workflowsPaginationCursor;
  if ("nextCursor" in options) {
    workflowsPaginationCursor = options.nextCursor;
  }
  workflowsCacheInfo = {
    data: workflowsData,
    version: version2,
    timestamp,
    mode,
    authUser,
    isExpired: false,
    nextCursor: cursor
  };
  persistCache(WORKFLOWS_CACHE_KEY, workflowsCacheInfo);
}
function setModelsData(data, options = {}) {
  modelsData = Array.isArray(data) ? data : [];
  const version2 = computeLatestTimestamp(modelsData);
  const timestamp = Date.now();
  const mode = options.mode === "preview" ? "preview" : CACHE_DEFAULT_MODE;
  modelsCacheInfo = {
    data: modelsData,
    version: version2,
    timestamp,
    mode,
    isExpired: false
  };
  persistCache(MODELS_CACHE_KEY, modelsCacheInfo);
}
function setOngoingWorkflowInstall(value) {
  ongoingWorkflowInstall = value;
}
function setOngoingModelDownload(value) {
  ongoingModelDownload = value;
}
function updateSelectedWorkflows(ids) {
  selectedWorkflows.clear();
  if (ids && typeof ids[Symbol.iterator] === "function") {
    for (const id of ids) {
      selectedWorkflows.add(id);
    }
  }
}
function updateSelectedModels(ids) {
  selectedModels.clear();
  if (ids && typeof ids[Symbol.iterator] === "function") {
    for (const id of ids) {
      selectedModels.add(id);
    }
  }
}
function setWorkflowPollInterval(interval) {
  workflowPollInterval = interval;
}
function setModelPollInterval(interval) {
  modelPollInterval = interval;
}
function setPendingRefreshAfterRestart(value) {
  pendingRefreshAfterRestart = value;
  pendingRefreshListeners.forEach((listener) => {
    try {
      listener(value);
    } catch (error) {
    }
  });
}
function onPendingRefreshChange(listener) {
  if (typeof listener !== "function") {
    return () => {
    };
  }
  pendingRefreshListeners.add(listener);
  return () => pendingRefreshListeners.delete(listener);
}
function getWorkflowsCacheInfo() {
  return { ...workflowsCacheInfo };
}
function getModelsCacheInfo() {
  return { ...modelsCacheInfo };
}
function getLatestDataVersion(list) {
  return computeLatestTimestamp(list);
}
function hydrateWorkflowsFromCache() {
  if (Array.isArray(workflowsData) && workflowsData.length > 0) {
    return false;
  }
  const record = readCacheRecord(WORKFLOWS_CACHE_KEY);
  if (!record || !Array.isArray(record.data) || record.data.length === 0) {
    return false;
  }
  workflowsCacheInfo = buildCacheInfo(record);
  workflowsData = Array.isArray(workflowsCacheInfo.data) ? workflowsCacheInfo.data : [];
  workflowsPaginationCursor = record.nextCursor ?? null;
  return workflowsData.length > 0;
}
function hydrateModelsFromCache() {
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
const HF_TOKEN_KEY = "nuvu_hf_token";
function setHfToken(token) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    if (token && typeof token === "string" && token.trim()) {
      window.localStorage.setItem(HF_TOKEN_KEY, token.trim());
    } else {
      window.localStorage.removeItem(HF_TOKEN_KEY);
    }
  } catch (error) {
  }
}
const PROFILE_KEY = "nuvu_user_profile";
const USER_ID_KEY = "nuvu_user_id";
const USER_EMAIL_KEY = "nuvu_user_email";
const REFRESH_TOKEN_KEY = "nuvu_refresh_token";
function normalizeProfile(rawProfile = {}) {
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }
  const apiToken = rawProfile.apiToken || rawProfile.accessToken || null;
  const profile = {
    id: rawProfile.id || rawProfile.sub || rawProfile.user_id || null,
    name: rawProfile.name || "",
    email: rawProfile.email || "",
    picture: rawProfile.picture || "",
    provider: rawProfile.provider || "website",
    apiToken,
    accessToken: rawProfile.accessToken || apiToken,
    userToken: rawProfile.userToken || rawProfile.idToken || null
  };
  if (!profile.apiToken && !profile.accessToken) {
    return null;
  }
  return profile;
}
function decodeTokenExpiry(token) {
  if (!token || typeof token !== "string" || token.split(".").length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload && typeof payload.exp === "number") {
      return payload.exp * 1e3;
    }
  } catch (error) {
  }
  return null;
}
function persistUserProfile(user, tokens = {}) {
  const normalized = normalizeProfile({
    ...user,
    apiToken: tokens.apiToken || tokens.accessToken,
    accessToken: tokens.accessToken || tokens.apiToken,
    userToken: tokens.userToken
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
  setAuthenticated(true);
  setCurrentUser(normalized);
}
function loadStoredUserProfile() {
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
function clearStoredUserProfile() {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(USER_EMAIL_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch (error) {
  }
  setAuthenticated(false);
  setCurrentUser(null);
}
function hydrateUserFromStorage() {
  const stored = loadStoredUserProfile();
  if (stored) {
    setAuthenticated(true);
    setCurrentUser(stored);
    return true;
  }
  return false;
}
function getActiveApiToken() {
  return currentUser?.apiToken || currentUser?.accessToken || localStorage.getItem("api_token") || null;
}
function getStoredUserId() {
  return currentUser?.id || localStorage.getItem(USER_ID_KEY) || null;
}
function getStoredUserEmail() {
  return currentUser?.email || localStorage.getItem(USER_EMAIL_KEY) || null;
}
function getUserProfile() {
  return currentUser || loadStoredUserProfile();
}
function storeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  try {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch (error) {
  }
}
function getRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY) || null;
  } catch (error) {
    return null;
  }
}
function updateTokens(apiToken, userToken, refreshToken, expiresAt) {
  try {
    if (apiToken) {
      localStorage.setItem("api_token", apiToken);
    }
    if (userToken) {
      localStorage.setItem("user_token", userToken);
    }
    if (refreshToken) {
      storeRefreshToken(refreshToken);
    }
    if (expiresAt) {
      localStorage.setItem("auth_expires_at", String(expiresAt));
    }
    if (currentUser) {
      setCurrentUser({
        ...currentUser,
        apiToken: apiToken || currentUser.apiToken,
        accessToken: apiToken || currentUser.accessToken,
        userToken: userToken || currentUser.userToken
      });
    }
  } catch (error) {
  }
}
const TOKEN_EXPIRY_LEEWAY_MS = 60 * 1e3;
const PROACTIVE_REFRESH_MS = 5 * 60 * 1e3;
function dispatchAuthInvalidated(reason) {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("nuvu:auth-invalidated", { detail: { reason } }));
    }
  } catch (error) {
  }
}
function clearLocalSession(reason = "invalid_session") {
  try {
    localStorage.removeItem("api_token");
    localStorage.removeItem("user_token");
    localStorage.removeItem("auth_access_token");
    localStorage.removeItem("auth_expires_at");
    localStorage.removeItem("nuvu_refresh_token");
  } catch (error) {
  }
  clearStoredUserProfile();
  dispatchAuthInvalidated(reason);
}
async function refreshSessionFromWebsite() {
  try {
    const refreshToken = getRefreshToken();
    const apiToken = getActiveApiToken();
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    };
    if (refreshToken && apiToken) {
      requestOptions.headers["Authorization"] = `Bearer ${apiToken}`;
      requestOptions.body = JSON.stringify({ refresh_token: refreshToken });
    } else {
      requestOptions.credentials = "include";
    }
    const response = await fetch(`${getWebsiteBaseUrl()}/api/auth/refresh`, requestOptions);
    if (!response.ok) {
      return false;
    }
    const data = await response.json();
    if (!data?.api_token) {
      return false;
    }
    updateTokens(data.api_token, data.user_token, data.refresh_token, data.expires_at);
    persistUserProfile(
      {
        id: getStoredUserId(),
        email: getStoredUserEmail() || "",
        name: currentUser?.name || "",
        picture: currentUser?.picture || ""
      },
      {
        apiToken: data.api_token,
        accessToken: data.api_token,
        userToken: data.user_token || localStorage.getItem("user_token")
      }
    );
    console.log("[AUTH] Token refreshed successfully");
    return true;
  } catch (error) {
    console.error("[AUTH] Token refresh failed:", error);
    return false;
  }
}
async function checkWebsiteSession({ allowRefreshRetry = true, skipApiCall = false } = {}) {
  try {
    const apiToken = localStorage.getItem("api_token");
    const userToken = localStorage.getItem("user_token");
    const expiresAt = localStorage.getItem("auth_expires_at");
    if (!apiToken) {
      return false;
    }
    if (expiresAt && Date.now() > parseInt(expiresAt)) {
      clearLocalSession("token_expired");
      return false;
    }
    if (skipApiCall) {
      hydrateUserFromStorage();
      return isAuthenticated;
    }
    if (isAuthenticated && currentUser && currentUser.id) {
      return true;
    }
    const userResponse = await fetch(getWebsiteBaseUrl() + "/api/user/info", {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
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
          email_verified: user.email_verified
        },
        {
          apiToken,
          accessToken: apiToken,
          userToken
        }
      );
      const newExpiry = decodeTokenExpiry(apiToken);
      if (newExpiry) {
        localStorage.setItem("auth_expires_at", String(newExpiry));
      }
      return true;
    }
    if (userResponse.status === 401 && allowRefreshRetry) {
      const refreshed = await refreshSessionFromWebsite();
      if (refreshed) {
        return checkWebsiteSession({ allowRefreshRetry: false });
      }
      clearLocalSession("unauthorized");
      return false;
    }
    if (userResponse.status === 401 || userResponse.status === 403) {
      clearLocalSession(userResponse.status === 403 ? "forbidden" : "unauthorized");
      return false;
    }
    clearStoredUserProfile();
    return false;
  } catch (error) {
    clearStoredUserProfile();
    return false;
  }
}
async function ensureValidSessionOrLogout() {
  const valid = await checkWebsiteSession({ allowRefreshRetry: true, skipApiCall: false });
  if (valid) {
    return true;
  }
  clearLocalSession("session_invalid");
  return false;
}
function invalidateLocalSession(reason = "session_invalid") {
  clearLocalSession(reason);
}
async function ensureFreshAccessToken() {
  const expiresAtRaw = localStorage.getItem("auth_expires_at");
  if (!expiresAtRaw) {
    return Boolean(getActiveApiToken());
  }
  const expiresAt = parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt)) {
    return Boolean(getActiveApiToken());
  }
  if (Date.now() <= expiresAt - TOKEN_EXPIRY_LEEWAY_MS) {
    return Boolean(getActiveApiToken());
  }
  const refreshed = await refreshSessionFromWebsite();
  if (refreshed) {
    return true;
  }
  return checkWebsiteSession({ allowRefreshRetry: false });
}
function needsProactiveRefresh() {
  const expiresAtRaw = localStorage.getItem("auth_expires_at");
  if (!expiresAtRaw) {
    return false;
  }
  const expiresAt = parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return Date.now() > expiresAt - PROACTIVE_REFRESH_MS;
}
async function proactivelyRefreshIfNeeded() {
  if (!needsProactiveRefresh()) {
    return true;
  }
  console.log("[AUTH] Proactive token refresh triggered");
  const refreshed = await refreshSessionFromWebsite();
  if (!refreshed) {
    console.warn("[AUTH] Proactive refresh failed, token may expire soon");
  }
  return refreshed;
}
function buildAuthHeaders({ json = false } = {}) {
  const token = getActiveApiToken();
  if (!token) {
    return null;
  }
  const headers = {
    "Authorization": `Bearer ${token}`
  };
  const userId = getStoredUserId();
  const email = getStoredUserEmail();
  if (userId) {
    headers["X-User-Id"] = userId;
  }
  if (email) {
    headers["X-User-Email"] = email;
  }
  if (json) {
    headers["Content-Type"] = "application/json";
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
function ensureDeviceRegistrationState() {
  if (!window.__nuvuDeviceRegistered) {
    window.__nuvuDeviceRegistered = {
      registered: null,
      timestamp: null
    };
  }
  return window.__nuvuDeviceRegistered;
}
function setDeviceRegistrationState(isRegistered) {
  const state2 = ensureDeviceRegistrationState();
  state2.registered = isRegistered;
  state2.timestamp = Date.now();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nuvu:device-registration-state-changed", {
      detail: { registered: state2.registered }
    }));
  }
}
async function registerCurrentDevice({
  deviceLabel,
  replaceDeviceId = null,
  mode = "manual",
  clientTimestamp = (/* @__PURE__ */ new Date()).toISOString()
} = {}) {
  await ensureFreshAccessToken();
  const headers = buildAuthHeaders({ json: true });
  if (!headers) {
    throw new Error("Authentication required");
  }
  const payload = {
    device_label: deviceLabel,
    replace_device_id: replaceDeviceId,
    mode,
    client_timestamp: clientTimestamp,
    source: "comfyui-nuvu"
  };
  const response = await fetch("/nuvu/device/register", {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    const error = new Error(data?.error || "Device registration failed");
    error.response = data;
    error.status = response.status;
    throw error;
  }
  setDeviceRegistrationState(true);
  const event = new CustomEvent("nuvu:device-registered", {
    detail: {
      deviceLabel,
      replaceDeviceId,
      mode,
      timestamp: clientTimestamp
    }
  });
  window.dispatchEvent(event);
  return data;
}
async function autoSyncDeviceRegistration() {
  try {
    await ensureFreshAccessToken();
    await registerCurrentDevice({
      mode: "auto",
      clientTimestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (error) {
    if (error?.status === 409) {
      return;
    }
  }
}
async function sendLoginTelemetry(context = {}) {
  await ensureFreshAccessToken();
  const headers = buildAuthHeaders({ json: true });
  if (!headers) {
    return;
  }
  try {
    await fetch("/nuvu/telemetry/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        source: "comfyui-nuvu",
        context
      })
    });
  } catch (error) {
  }
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
async function runPostLoginEffects() {
  try {
    await autoSyncDeviceRegistration();
  } catch (error) {
  }
  await sendLoginTelemetry();
}
function clearStoredSession() {
  try {
    localStorage.removeItem("api_token");
    localStorage.removeItem("user_token");
    localStorage.removeItem("auth_access_token");
    localStorage.removeItem("auth_expires_at");
    localStorage.removeItem("nuvu_refresh_token");
  } catch (storageError) {
  }
  clearStoredUserProfile();
}
async function processWebsiteAuthSuccess(authData) {
  try {
    localStorage.setItem("api_token", authData.api_token);
    if (authData.user_token) {
      localStorage.setItem("user_token", authData.user_token);
    }
    if (authData.refresh_token) {
      storeRefreshToken(authData.refresh_token);
    }
    const expiryTime = decodeTokenExpiry(authData.api_token) ?? Date.now() + SESSION_TTL_MS;
    localStorage.setItem("auth_expires_at", String(expiryTime));
    if (!authData.api_token) {
      throw new Error("No API token provided");
    }
    let userInfo = null;
    const tokenToDecodeForUser = authData.user_token || authData.api_token;
    if (tokenToDecodeForUser && tokenToDecodeForUser.includes(".")) {
      try {
        const tokenParts = tokenToDecodeForUser.split(".");
        if (tokenParts.length === 3) {
          const payload = JSON.parse(atob(tokenParts[1]));
          userInfo = {
            id: payload.sub || payload.user_id,
            name: payload.name || payload.nickname || payload.username || "",
            email: payload.email || "",
            picture: payload.picture || payload.avatar || "",
            email_verified: payload.email_verified || false
          };
        }
      } catch (jwtError) {
      }
    }
    if (userInfo && userInfo.id) {
      persistUserProfile(
        userInfo,
        {
          apiToken: authData.api_token,
          accessToken: authData.api_token,
          userToken: authData.user_token
        }
      );
      runPostLoginEffects().catch(() => {
      });
      return true;
    }
    const userResponse = await fetch(getWebsiteBaseUrl() + "/api/user/info", {
      headers: {
        "Authorization": `Bearer ${authData.api_token}`,
        "Content-Type": "application/json"
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
          email_verified: user.email_verified
        },
        {
          apiToken: authData.api_token,
          accessToken: authData.api_token,
          userToken: authData.user_token
        }
      );
      runPostLoginEffects().catch(() => {
      });
      return true;
    } else {
      throw new Error(`Failed to fetch user info: ${userResponse.status}`);
    }
  } catch (error) {
    clearStoredSession();
    throw error;
  }
}
async function processPopupAuthSuccess(authData) {
  try {
    localStorage.setItem("auth_access_token", authData.access_token);
    const expiryTime = decodeTokenExpiry(authData.access_token) ?? Date.now() + SESSION_TTL_MS;
    localStorage.setItem("auth_expires_at", String(expiryTime));
    if (authData.user_info) {
      persistUserProfile(
        {
          id: authData.user_info.sub,
          name: authData.user_info.name,
          email: authData.user_info.email,
          picture: authData.user_info.picture,
          provider: authData.user_info.provider
        },
        {
          accessToken: authData.access_token,
          apiToken: authData.access_token,
          userToken: authData.user_info.id_token
        }
      );
      await runPostLoginEffects();
      return true;
    } else if (authData.access_token && authData.access_token.includes(".")) {
      try {
        const tokenParts = authData.access_token.split(".");
        if (tokenParts.length === 3) {
          const payload = JSON.parse(atob(tokenParts[1]));
          setAuthenticated(true);
          persistUserProfile(
            {
              id: payload.sub || payload.user_id,
              name: payload.name || payload.username,
              email: payload.email,
              picture: payload.picture || payload.avatar
            },
            {
              accessToken: authData.access_token,
              apiToken: authData.access_token,
              userToken: authData.id_token
            }
          );
          await runPostLoginEffects();
          return true;
        }
      } catch (jwtError) {
      }
    }
    clearStoredSession();
    throw new Error("Unable to determine authenticated user from the provided token.");
  } catch (error) {
    clearStoredSession();
    throw error;
  }
}
const OAUTH_STATE_STORAGE_KEY = "oauth_state";
function base64UrlEncode(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 ? 4 - normalized.length % 4 : 0;
  const padded = normalized + "=".repeat(padding);
  return atob(padded);
}
function buildAuthStatePayload() {
  const nonce = generateState();
  if (typeof window === "undefined") {
    return { nonce };
  }
  return {
    nonce,
    origin: window.location.origin,
    path: window.location.pathname || "/",
    search: window.location.search || "",
    hash: window.location.hash || ""
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
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch (error) {
    return null;
  }
}
function redirectToOriginalOrigin(statePayload, urlParams) {
  if (typeof window === "undefined") {
    return false;
  }
  if (!statePayload || !statePayload.origin) {
    return false;
  }
  if (window.location.origin === statePayload.origin) {
    return false;
  }
  try {
    const path = typeof statePayload.path === "string" && statePayload.path.length ? statePayload.path : "/";
    const targetUrl = new URL(path, statePayload.origin);
    const mergedParams = new URLSearchParams();
    if (typeof statePayload.search === "string" && statePayload.search.length > 1) {
      const originalParams = new URLSearchParams(
        statePayload.search.startsWith("?") ? statePayload.search.slice(1) : statePayload.search
      );
      originalParams.forEach((value, key) => mergedParams.set(key, value));
    }
    if (urlParams) {
      urlParams.forEach((value, key) => mergedParams.set(key, value));
    }
    const searchString = mergedParams.toString();
    targetUrl.search = searchString ? `?${searchString}` : "";
    const hashValue = window.location.hash && window.location.hash !== "#" ? window.location.hash : typeof statePayload.hash === "string" ? statePayload.hash : "";
    targetUrl.hash = hashValue;
    window.location.replace(targetUrl.toString());
    return true;
  } catch (error) {
    return false;
  }
}
function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function loginWithWebsite() {
  try {
    const statePayload = buildAuthStatePayload();
    const stateParam = encodeStatePayload(statePayload);
    localStorage.setItem(OAUTH_STATE_STORAGE_KEY, stateParam);
    const oauthConfig = getOAuthConfig();
    const authUrl = `${oauthConfig.authUrl}?redirect=${encodeURIComponent(oauthConfig.callbackUrl)}&state=${encodeURIComponent(stateParam)}`;
    window.location.href = authUrl;
    return true;
  } catch (error) {
    return false;
  }
}
function handleWebsiteCallbackFromUrl(updateDialogForAuthenticated2) {
  const urlParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.substr(1));
  const apiToken = urlParams.get("token") || hashParams.get("token");
  const userToken = urlParams.get("id_token") || hashParams.get("id_token");
  const error = urlParams.get("error") || hashParams.get("error");
  urlParams.get("error_description") || hashParams.get("error_description");
  const stateParam = urlParams.get("state") || hashParams.get("state");
  if (error) {
    return false;
  }
  if (apiToken) {
    const decodedState = decodeStatePayload(stateParam);
    if (decodedState && redirectToOriginalOrigin(decodedState, urlParams)) {
      return false;
    }
    const storedState = localStorage.getItem(OAUTH_STATE_STORAGE_KEY);
    if (stateParam && storedState && stateParam !== storedState) {
      return false;
    }
    localStorage.removeItem(OAUTH_STATE_STORAGE_KEY);
    const authData = {
      api_token: apiToken,
      // This is the JWT access token with audience for API calls
      user_token: userToken,
      // This is the Auth0 ID token for user info calls
      user_info: null
      // Will be fetched from your API
    };
    processWebsiteAuthSuccess(authData).then(() => {
      updateDialogForAuthenticated2();
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    }).catch((error2) => {
      return false;
    });
    return true;
  }
  return false;
}
function handlePopupAuthResult(event, updateDialogForAuthenticated2) {
  if (event.origin !== window.location.origin) {
    return;
  }
  if (event.data.type === "nuvu_AUTH_SUCCESS") {
    if (window.nuvuAuthPopup && !window.nuvuAuthPopup.closed) {
      window.nuvuAuthPopup.close();
    }
    processPopupAuthSuccess(event.data).then(() => {
      updateDialogForAuthenticated2();
      if (window.nuvuAuthResolve) {
        window.nuvuAuthResolve(true);
        window.nuvuAuthResolve = null;
        window.nuvuAuthReject = null;
      }
    }).catch((error) => {
      if (window.nuvuAuthReject) {
        window.nuvuAuthReject(error);
        window.nuvuAuthResolve = null;
        window.nuvuAuthReject = null;
      }
    });
  } else if (event.data.type === "nuvu_AUTH_ERROR") {
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
// @__NO_SIDE_EFFECTS__
function makeMap(str) {
  const map = /* @__PURE__ */ Object.create(null);
  for (const key of str.split(",")) map[key] = 1;
  return (val) => val in map;
}
const EMPTY_OBJ = {};
const EMPTY_ARR = [];
const NOOP = () => {
};
const NO = () => false;
const isOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // uppercase letter
(key.charCodeAt(2) > 122 || key.charCodeAt(2) < 97);
const isModelListener = (key) => key.startsWith("onUpdate:");
const extend = Object.assign;
const remove = (arr, el) => {
  const i = arr.indexOf(el);
  if (i > -1) {
    arr.splice(i, 1);
  }
};
const hasOwnProperty$1 = Object.prototype.hasOwnProperty;
const hasOwn = (val, key) => hasOwnProperty$1.call(val, key);
const isArray = Array.isArray;
const isMap = (val) => toTypeString(val) === "[object Map]";
const isSet = (val) => toTypeString(val) === "[object Set]";
const isDate = (val) => toTypeString(val) === "[object Date]";
const isFunction = (val) => typeof val === "function";
const isString = (val) => typeof val === "string";
const isSymbol = (val) => typeof val === "symbol";
const isObject = (val) => val !== null && typeof val === "object";
const isPromise = (val) => {
  return (isObject(val) || isFunction(val)) && isFunction(val.then) && isFunction(val.catch);
};
const objectToString = Object.prototype.toString;
const toTypeString = (value) => objectToString.call(value);
const toRawType = (value) => {
  return toTypeString(value).slice(8, -1);
};
const isPlainObject = (val) => toTypeString(val) === "[object Object]";
const isIntegerKey = (key) => isString(key) && key !== "NaN" && key[0] !== "-" && "" + parseInt(key, 10) === key;
const isReservedProp = /* @__PURE__ */ makeMap(
  // the leading comma is intentional so empty string "" is also included
  ",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"
);
const cacheStringFunction = (fn) => {
  const cache = /* @__PURE__ */ Object.create(null);
  return ((str) => {
    const hit = cache[str];
    return hit || (cache[str] = fn(str));
  });
};
const camelizeRE = /-\w/g;
const camelize = cacheStringFunction(
  (str) => {
    return str.replace(camelizeRE, (c) => c.slice(1).toUpperCase());
  }
);
const hyphenateRE = /\B([A-Z])/g;
const hyphenate = cacheStringFunction(
  (str) => str.replace(hyphenateRE, "-$1").toLowerCase()
);
const capitalize = cacheStringFunction((str) => {
  return str.charAt(0).toUpperCase() + str.slice(1);
});
const toHandlerKey = cacheStringFunction(
  (str) => {
    const s = str ? `on${capitalize(str)}` : ``;
    return s;
  }
);
const hasChanged = (value, oldValue) => !Object.is(value, oldValue);
const invokeArrayFns = (fns, ...arg) => {
  for (let i = 0; i < fns.length; i++) {
    fns[i](...arg);
  }
};
const def = (obj, key, value, writable = false) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: false,
    writable,
    value
  });
};
const looseToNumber = (val) => {
  const n = parseFloat(val);
  return isNaN(n) ? val : n;
};
const toNumber = (val) => {
  const n = isString(val) ? Number(val) : NaN;
  return isNaN(n) ? val : n;
};
let _globalThis;
const getGlobalThis = () => {
  return _globalThis || (_globalThis = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
};
function normalizeStyle(value) {
  if (isArray(value)) {
    const res = {};
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const normalized = isString(item) ? parseStringStyle(item) : normalizeStyle(item);
      if (normalized) {
        for (const key in normalized) {
          res[key] = normalized[key];
        }
      }
    }
    return res;
  } else if (isString(value) || isObject(value)) {
    return value;
  }
}
const listDelimiterRE = /;(?![^(]*\))/g;
const propertyDelimiterRE = /:([^]+)/;
const styleCommentRE = /"(?:[^"\\]|\\[^])*"|'(?:[^'\\]|\\[^])*'|\\[^]|\/\*[^]*?\*\//g;
function parseStringStyle(cssText) {
  const ret = {};
  cssText.replace(styleCommentRE, (match) => match.startsWith("/*") ? "" : match).split(listDelimiterRE).forEach((item) => {
    if (item) {
      const tmp = item.split(propertyDelimiterRE);
      tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim());
    }
  });
  return ret;
}
function normalizeClass(value) {
  let res = "";
  if (isString(value)) {
    res = value;
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeClass(value[i]);
      if (normalized) {
        res += normalized + " ";
      }
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) {
        res += name + " ";
      }
    }
  }
  return res.trim();
}
const specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,playsinline,readonly`;
const isSpecialBooleanAttr = /* @__PURE__ */ makeMap(specialBooleanAttrs);
function includeBooleanAttr(value) {
  return !!value || value === "";
}
function looseCompareArrays(a, b, seen) {
  if (a.length !== b.length) return false;
  let equal = true;
  for (let i = 0; equal && i < a.length; i++) {
    equal = looseEqual(a[i], b[i], seen);
  }
  return equal;
}
function looseCompareCollections(a, b, seen) {
  if (a.size !== b.size) return false;
  const candidates = Array.from(b);
  const matched = new Uint8Array(candidates.length);
  for (const item of a) {
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (!matched[i] && looseEqual(item, candidates[i], seen)) {
        index = i;
        break;
      }
    }
    if (index < 0) return false;
    matched[index] = 1;
  }
  return true;
}
function looseCompareObjects(a, b, seen) {
  let aValidType = isMap(a);
  let bValidType = isMap(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareCollections(a, b, seen) : false;
  }
  aValidType = isSet(a);
  bValidType = isSet(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareCollections(a, b, seen) : false;
  }
  const aKeysCount = Object.keys(a).length;
  const bKeysCount = Object.keys(b).length;
  if (aKeysCount !== bKeysCount) {
    return false;
  }
  for (const key in a) {
    const aHasKey = a.hasOwnProperty(key);
    const bHasKey = b.hasOwnProperty(key);
    if (aHasKey && !bHasKey || !aHasKey && bHasKey || !looseEqual(a[key], b[key], seen)) {
      return false;
    }
  }
  return String(a) === String(b);
}
function looseCompareNested(a, b, seen, compare) {
  if (!seen) {
    seen = [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()];
  }
  const [seenA, seenB] = seen;
  if (seenA.has(a) || seenB.has(b)) {
    return seenA.get(a) === b && seenB.get(b) === a;
  }
  seenA.set(a, b);
  seenB.set(b, a);
  const equal = compare(a, b, seen);
  seenA.delete(a);
  seenB.delete(b);
  return equal;
}
function looseEqual(a, b, seen) {
  if (a === b) return true;
  let aValidType = isDate(a);
  let bValidType = isDate(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? a.getTime() === b.getTime() : false;
  }
  aValidType = isSymbol(a);
  bValidType = isSymbol(b);
  if (aValidType || bValidType) {
    return a === b;
  }
  aValidType = isArray(a);
  bValidType = isArray(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareNested(a, b, seen, looseCompareArrays) : false;
  }
  aValidType = isObject(a);
  bValidType = isObject(b);
  if (aValidType || bValidType) {
    if (!aValidType || !bValidType) {
      return false;
    }
    return looseCompareNested(a, b, seen, looseCompareObjects);
  }
  return String(a) === String(b);
}
function looseIndexOf(arr, val) {
  return arr.findIndex((item) => looseEqual(item, val));
}
const isRef$1 = (val) => {
  return !!(val && val["__v_isRef"] === true);
};
const toDisplayString = (val) => {
  return isString(val) ? val : val == null ? "" : isArray(val) || isObject(val) && (val.toString === objectToString || !isFunction(val.toString)) ? isRef$1(val) ? toDisplayString(val.value) : JSON.stringify(val, replacer, 2) : String(val);
};
const replacer = (_key, val) => {
  if (isRef$1(val)) {
    return replacer(_key, val.value);
  } else if (isMap(val)) {
    return {
      [`Map(${val.size})`]: [...val.entries()].reduce(
        (entries, [key, val2], i) => {
          entries[stringifySymbol(key, i) + " =>"] = val2;
          return entries;
        },
        {}
      )
    };
  } else if (isSet(val)) {
    return {
      [`Set(${val.size})`]: [...val.values()].map((v) => stringifySymbol(v))
    };
  } else if (isSymbol(val)) {
    return stringifySymbol(val);
  } else if (isObject(val) && !isArray(val) && !isPlainObject(val)) {
    return String(val);
  }
  return val;
};
const stringifySymbol = (v, i = "") => {
  var _a;
  return (
    // Symbol.description in es2019+ so we need to cast here to pass
    // the lib: es2016 check
    isSymbol(v) ? `Symbol(${(_a = v.description) != null ? _a : i})` : v
  );
};
let activeEffectScope;
class EffectScope {
  // TODO isolatedDeclarations "__v_skip"
  constructor(detached = false) {
    this.detached = detached;
    this._active = true;
    this._on = 0;
    this.effects = [];
    this.cleanups = [];
    this._isPaused = false;
    this._warnOnRun = true;
    this.__v_skip = true;
    if (!detached && activeEffectScope) {
      if (activeEffectScope.active) {
        this.parent = activeEffectScope;
        this.index = (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this
        ) - 1;
      } else {
        this._active = false;
        this._warnOnRun = false;
      }
    }
  }
  get active() {
    return this._active;
  }
  pause() {
    if (this._active) {
      this._isPaused = true;
      let i, l;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].pause();
        }
      }
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause();
      }
    }
  }
  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume() {
    if (this._active) {
      if (this._isPaused) {
        this._isPaused = false;
        let i, l;
        if (this.scopes) {
          const scopes = this.scopes.slice();
          for (i = 0, l = scopes.length; i < l; i++) {
            scopes[i].resume();
          }
        }
        const effects = this.effects.slice();
        for (i = 0, l = effects.length; i < l; i++) {
          effects[i].resume();
        }
      }
    }
  }
  run(fn) {
    if (this._active) {
      const currentEffectScope = activeEffectScope;
      try {
        activeEffectScope = this;
        return fn();
      } finally {
        activeEffectScope = currentEffectScope;
      }
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  on() {
    if (++this._on === 1) {
      this.prevScope = activeEffectScope;
      activeEffectScope = this;
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  off() {
    if (this._on > 0 && --this._on === 0) {
      if (activeEffectScope === this) {
        activeEffectScope = this.prevScope;
      } else {
        let current = activeEffectScope;
        while (current) {
          if (current.prevScope === this) {
            current.prevScope = this.prevScope;
            break;
          }
          current = current.prevScope;
        }
      }
      this.prevScope = void 0;
    }
  }
  stop(fromParent) {
    if (this._active) {
      this._active = false;
      let i, l;
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop();
      }
      this.effects.length = 0;
      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]();
      }
      this.cleanups.length = 0;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].stop(true);
        }
        this.scopes.length = 0;
      }
      if (!this.detached && this.parent && !fromParent) {
        const last = this.parent.scopes.pop();
        if (last && last !== this) {
          this.parent.scopes[this.index] = last;
          last.index = this.index;
        }
      }
      this.parent = void 0;
    }
  }
}
function getCurrentScope() {
  return activeEffectScope;
}
let activeSub;
const pausedQueueEffects = /* @__PURE__ */ new WeakSet();
class ReactiveEffect {
  constructor(fn) {
    this.fn = fn;
    this.deps = void 0;
    this.depsTail = void 0;
    this.flags = 1 | 4;
    this.next = void 0;
    this.cleanup = void 0;
    this.scheduler = void 0;
    if (activeEffectScope) {
      if (activeEffectScope.active) {
        activeEffectScope.effects.push(this);
      } else {
        this.flags &= -2;
      }
    }
  }
  pause() {
    this.flags |= 64;
  }
  resume() {
    if (this.flags & 64) {
      this.flags &= -65;
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this);
        this.trigger();
      }
    }
  }
  /**
   * @internal
   */
  notify() {
    if (this.flags & 2 && !(this.flags & 32)) {
      return;
    }
    if (!(this.flags & 8)) {
      batch(this);
    }
  }
  run() {
    if (!(this.flags & 1)) {
      return this.fn();
    }
    this.flags |= 2;
    cleanupEffect(this);
    prepareDeps(this);
    const prevEffect = activeSub;
    const prevShouldTrack = shouldTrack;
    activeSub = this;
    shouldTrack = true;
    try {
      return this.fn();
    } finally {
      cleanupDeps(this);
      activeSub = prevEffect;
      shouldTrack = prevShouldTrack;
      this.flags &= -3;
    }
  }
  stop() {
    if (this.flags & 1) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link);
      }
      this.deps = this.depsTail = void 0;
      cleanupEffect(this);
      this.onStop && this.onStop();
      this.flags &= -2;
    }
  }
  trigger() {
    if (this.flags & 64) {
      pausedQueueEffects.add(this);
    } else if (this.scheduler) {
      this.scheduler();
    } else {
      this.runIfDirty();
    }
  }
  /**
   * @internal
   */
  runIfDirty() {
    if (isDirty(this)) {
      this.run();
    }
  }
  get dirty() {
    return isDirty(this);
  }
}
let batchDepth = 0;
let batchedSub;
let batchedComputed;
function batch(sub, isComputed = false) {
  sub.flags |= 8;
  if (isComputed) {
    sub.next = batchedComputed;
    batchedComputed = sub;
    return;
  }
  sub.next = batchedSub;
  batchedSub = sub;
}
function startBatch() {
  batchDepth++;
}
function endBatch() {
  if (--batchDepth > 0) {
    return;
  }
  if (batchedComputed) {
    let e = batchedComputed;
    batchedComputed = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      e = next;
    }
  }
  let error;
  while (batchedSub) {
    let e = batchedSub;
    batchedSub = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      if (e.flags & 1) {
        try {
          ;
          e.trigger();
        } catch (err) {
          if (!error) error = err;
        }
      }
      e = next;
    }
  }
  if (error) throw error;
}
function prepareDeps(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    link.version = -1;
    link.prevActiveLink = link.dep.activeLink;
    link.dep.activeLink = link;
  }
}
function cleanupDeps(sub) {
  let head;
  let tail = sub.depsTail;
  let link = tail;
  while (link) {
    const prev = link.prevDep;
    if (link.version === -1) {
      if (link === tail) tail = prev;
      removeSub(link);
      removeDep(link);
    } else {
      head = link;
    }
    link.dep.activeLink = link.prevActiveLink;
    link.prevActiveLink = void 0;
    link = prev;
  }
  sub.deps = head;
  sub.depsTail = tail;
}
function isDirty(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (link.dep.version !== link.version || link.dep.computed && (refreshComputed(link.dep.computed) || link.dep.version !== link.version)) {
      return true;
    }
  }
  if (sub._dirty) {
    return true;
  }
  return false;
}
function refreshComputed(computed2) {
  if (computed2.flags & 4 && !(computed2.flags & 16)) {
    return;
  }
  computed2.flags &= -17;
  if (computed2.globalVersion === globalVersion) {
    return;
  }
  computed2.globalVersion = globalVersion;
  if (!computed2.isSSR && computed2.flags & 128 && (!computed2.deps && !computed2._dirty || !isDirty(computed2))) {
    return;
  }
  computed2.flags |= 2;
  const dep = computed2.dep;
  const prevSub = activeSub;
  const prevShouldTrack = shouldTrack;
  activeSub = computed2;
  shouldTrack = true;
  try {
    prepareDeps(computed2);
    const value = computed2.fn(computed2._value);
    if (dep.version === 0 || hasChanged(value, computed2._value)) {
      computed2.flags |= 128;
      computed2._value = value;
      dep.version++;
    }
  } catch (err) {
    dep.version++;
    throw err;
  } finally {
    activeSub = prevSub;
    shouldTrack = prevShouldTrack;
    cleanupDeps(computed2);
    computed2.flags &= -3;
  }
}
function removeSub(link, soft = false) {
  const { dep, prevSub, nextSub } = link;
  if (prevSub) {
    prevSub.nextSub = nextSub;
    link.prevSub = void 0;
  }
  if (nextSub) {
    nextSub.prevSub = prevSub;
    link.nextSub = void 0;
  }
  if (dep.subs === link) {
    dep.subs = prevSub;
    if (!prevSub && dep.computed) {
      dep.computed.flags &= -5;
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        removeSub(l, true);
      }
    }
  }
  if (!soft && !--dep.sc && dep.map) {
    dep.map.delete(dep.key);
  }
}
function removeDep(link) {
  const { prevDep, nextDep } = link;
  if (prevDep) {
    prevDep.nextDep = nextDep;
    link.prevDep = void 0;
  }
  if (nextDep) {
    nextDep.prevDep = prevDep;
    link.nextDep = void 0;
  }
}
let shouldTrack = true;
const trackStack = [];
function pauseTracking() {
  trackStack.push(shouldTrack);
  shouldTrack = false;
}
function resetTracking() {
  const last = trackStack.pop();
  shouldTrack = last === void 0 ? true : last;
}
function cleanupEffect(e) {
  const { cleanup } = e;
  e.cleanup = void 0;
  if (cleanup) {
    const prevSub = activeSub;
    activeSub = void 0;
    try {
      cleanup();
    } finally {
      activeSub = prevSub;
    }
  }
}
let globalVersion = 0;
class Link {
  constructor(sub, dep) {
    this.sub = sub;
    this.dep = dep;
    this.version = dep.version;
    this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0;
  }
}
class Dep {
  // TODO isolatedDeclarations "__v_skip"
  constructor(computed2) {
    this.computed = computed2;
    this.version = 0;
    this.activeLink = void 0;
    this.subs = void 0;
    this.map = void 0;
    this.key = void 0;
    this.sc = 0;
    this.__v_skip = true;
  }
  track(debugInfo) {
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return;
    }
    let link = this.activeLink;
    if (link === void 0 || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this);
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link;
      } else {
        link.prevDep = activeSub.depsTail;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
      }
      addSub(link);
    } else if (link.version === -1) {
      link.version = this.version;
      if (link.nextDep) {
        const next = link.nextDep;
        next.prevDep = link.prevDep;
        if (link.prevDep) {
          link.prevDep.nextDep = next;
        }
        link.prevDep = activeSub.depsTail;
        link.nextDep = void 0;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
        if (activeSub.deps === link) {
          activeSub.deps = next;
        }
      }
    }
    return link;
  }
  trigger(debugInfo) {
    this.version++;
    globalVersion++;
    this.notify(debugInfo);
  }
  notify(debugInfo) {
    startBatch();
    try {
      if (false) ;
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          ;
          link.sub.dep.notify();
        }
      }
    } finally {
      endBatch();
    }
  }
}
function addSub(link) {
  link.dep.sc++;
  if (link.sub.flags & 4) {
    const computed2 = link.dep.computed;
    if (computed2 && !link.dep.subs) {
      computed2.flags |= 4 | 16;
      for (let l = computed2.deps; l; l = l.nextDep) {
        addSub(l);
      }
    }
    const currentTail = link.dep.subs;
    if (currentTail !== link) {
      link.prevSub = currentTail;
      if (currentTail) currentTail.nextSub = link;
    }
    link.dep.subs = link;
  }
}
const targetMap = /* @__PURE__ */ new WeakMap();
const ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const MAP_KEY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const ARRAY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
function track(target, type, key) {
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target);
    if (!depsMap) {
      targetMap.set(target, depsMap = /* @__PURE__ */ new Map());
    }
    let dep = depsMap.get(key);
    if (!dep) {
      depsMap.set(key, dep = new Dep());
      dep.map = depsMap;
      dep.key = key;
    }
    {
      dep.track();
    }
  }
}
function trigger(target, type, key, newValue, oldValue, oldTarget) {
  const depsMap = targetMap.get(target);
  if (!depsMap) {
    globalVersion++;
    return;
  }
  const run = (dep) => {
    if (dep) {
      {
        dep.trigger();
      }
    }
  };
  startBatch();
  if (type === "clear") {
    depsMap.forEach(run);
  } else {
    const targetIsArray = isArray(target);
    const isArrayIndex = targetIsArray && isIntegerKey(key);
    if (targetIsArray && key === "length") {
      const newLength = Number(newValue);
      depsMap.forEach((dep, key2) => {
        if (key2 === "length" || key2 === ARRAY_ITERATE_KEY || !isSymbol(key2) && key2 >= newLength) {
          run(dep);
        }
      });
    } else {
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key));
      }
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY));
      }
      switch (type) {
        case "add":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          } else if (isArrayIndex) {
            run(depsMap.get("length"));
          }
          break;
        case "delete":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          }
          break;
        case "set":
          if (isMap(target)) {
            run(depsMap.get(ITERATE_KEY));
          }
          break;
      }
    }
  }
  endBatch();
}
function reactiveReadArray(array) {
  const raw = /* @__PURE__ */ toRaw(array);
  if (raw === array) return raw;
  track(raw, "iterate", ARRAY_ITERATE_KEY);
  if (/* @__PURE__ */ isShallow(array)) return raw;
  if (!/* @__PURE__ */ isReadonly(array)) return raw.map(toReactive);
  return /* @__PURE__ */ isReactive(array) ? raw.map((item) => toReadonly(toReactive(item))) : raw.map(toReadonly);
}
function shallowReadArray(arr) {
  track(arr = /* @__PURE__ */ toRaw(arr), "iterate", ARRAY_ITERATE_KEY);
  return arr;
}
function toWrapped(target, item) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return /* @__PURE__ */ isReactive(target) ? toReadonly(toReactive(item)) : toReadonly(item);
  }
  return toReactive(item);
}
const arrayInstrumentations = {
  __proto__: null,
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, (item) => toWrapped(this, item));
  },
  concat(...args) {
    return reactiveReadArray(this).concat(
      ...args.map((x) => isArray(x) ? reactiveReadArray(x) : x)
    );
  },
  entries() {
    return iterator(this, "entries", (value) => {
      value[1] = toWrapped(this, value[1]);
      return value;
    });
  },
  every(fn, thisArg) {
    return apply(this, "every", fn, thisArg, void 0, arguments);
  },
  filter(fn, thisArg) {
    return apply(
      this,
      "filter",
      fn,
      thisArg,
      (v) => v.map((item) => toWrapped(this, item)),
      arguments
    );
  },
  find(fn, thisArg) {
    return apply(
      this,
      "find",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findIndex(fn, thisArg) {
    return apply(this, "findIndex", fn, thisArg, void 0, arguments);
  },
  findLast(fn, thisArg) {
    return apply(
      this,
      "findLast",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findLastIndex(fn, thisArg) {
    return apply(this, "findLastIndex", fn, thisArg, void 0, arguments);
  },
  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement
  forEach(fn, thisArg) {
    return apply(this, "forEach", fn, thisArg, void 0, arguments);
  },
  includes(...args) {
    return searchProxy(this, "includes", args);
  },
  indexOf(...args) {
    return searchProxy(this, "indexOf", args);
  },
  join(separator) {
    return reactiveReadArray(this).join(separator);
  },
  // keys() iterator only reads `length`, no optimization required
  lastIndexOf(...args) {
    return searchProxy(this, "lastIndexOf", args);
  },
  map(fn, thisArg) {
    return apply(this, "map", fn, thisArg, void 0, arguments);
  },
  pop() {
    return noTracking(this, "pop");
  },
  push(...args) {
    return noTracking(this, "push", args);
  },
  reduce(fn, ...args) {
    return reduce(this, "reduce", fn, args);
  },
  reduceRight(fn, ...args) {
    return reduce(this, "reduceRight", fn, args);
  },
  shift() {
    return noTracking(this, "shift");
  },
  // slice could use ARRAY_ITERATE but also seems to beg for range tracking
  some(fn, thisArg) {
    return apply(this, "some", fn, thisArg, void 0, arguments);
  },
  splice(...args) {
    return noTracking(this, "splice", args);
  },
  toReversed() {
    return reactiveReadArray(this).toReversed();
  },
  toSorted(comparer) {
    return reactiveReadArray(this).toSorted(comparer);
  },
  toSpliced(...args) {
    return reactiveReadArray(this).toSpliced(...args);
  },
  unshift(...args) {
    return noTracking(this, "unshift", args);
  },
  values() {
    return iterator(this, "values", (item) => toWrapped(this, item));
  }
};
function iterator(self2, method, wrapValue) {
  const arr = shallowReadArray(self2);
  const methodFn = arr[method];
  const iter = methodFn.call(arr);
  if (arr !== self2 && !/* @__PURE__ */ isShallow(self2)) {
    if (iter[Symbol.toStringTag] === "Array Iterator") {
      const wrapped = Object.create(Object.getPrototypeOf(iter));
      wrapped.next = () => wrapResult(iter.next(), wrapValue);
      if (methodFn !== arrayProto[method]) {
        Object.defineProperties(wrapped, {
          return: {
            get() {
              const fn = iter.return;
              return typeof fn === "function" ? fn.bind(iter) : fn;
            }
          },
          throw: {
            get() {
              const fn = iter.throw;
              return typeof fn === "function" ? fn.bind(iter) : fn;
            }
          }
        });
      }
      return wrapped;
    }
    iter._next = iter.next;
    iter.next = () => wrapResult(iter._next(), wrapValue);
  }
  return iter;
}
function wrapResult(result, wrapValue) {
  if (!result.done) {
    result.value = wrapValue(result.value);
  }
  return result;
}
const arrayProto = Array.prototype;
function apply(self2, method, fn, thisArg, wrappedRetFn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  const methodFn = arr[method];
  if (methodFn !== arrayProto[method]) {
    const result2 = methodFn.apply(self2, args);
    return needsWrap ? toReactive(result2) : result2;
  }
  let wrappedFn = fn;
  if (arr !== self2) {
    if (needsWrap) {
      wrappedFn = function(item, index) {
        return fn.call(this, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 2) {
      wrappedFn = function(item, index) {
        return fn.call(this, item, index, self2);
      };
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg);
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result;
}
function reduce(self2, method, fn, args) {
  const arr = shallowReadArray(self2);
  const needsWrap = arr !== self2 && !/* @__PURE__ */ isShallow(self2);
  let wrappedFn = fn;
  let wrapInitialAccumulator = false;
  if (arr !== self2) {
    if (needsWrap) {
      wrapInitialAccumulator = args.length === 0;
      wrappedFn = function(acc, item, index) {
        if (wrapInitialAccumulator) {
          wrapInitialAccumulator = false;
          acc = toWrapped(self2, acc);
        }
        return fn.call(this, acc, toWrapped(self2, item), index, self2);
      };
    } else if (fn.length > 3) {
      wrappedFn = function(acc, item, index) {
        return fn.call(this, acc, item, index, self2);
      };
    }
  }
  const result = arr[method](wrappedFn, ...args);
  return wrapInitialAccumulator ? toWrapped(self2, result) : result;
}
function searchProxy(self2, method, args) {
  const arr = /* @__PURE__ */ toRaw(self2);
  track(arr, "iterate", ARRAY_ITERATE_KEY);
  const res = arr[method](...args);
  if ((res === -1 || res === false) && /* @__PURE__ */ isProxy(args[0])) {
    args[0] = /* @__PURE__ */ toRaw(args[0]);
    return arr[method](...args);
  }
  return res;
}
function noTracking(self2, method, args = []) {
  pauseTracking();
  startBatch();
  const res = (/* @__PURE__ */ toRaw(self2))[method].apply(self2, args);
  endBatch();
  resetTracking();
  return res;
}
const isNonTrackableKeys = /* @__PURE__ */ makeMap(`__proto__,__v_isRef,__isVue`);
const builtInSymbols = new Set(
  /* @__PURE__ */ Object.getOwnPropertyNames(Symbol).filter((key) => key !== "arguments" && key !== "caller").map((key) => Symbol[key]).filter(isSymbol)
);
function hasOwnProperty(key) {
  if (!isSymbol(key)) key = String(key);
  const obj = /* @__PURE__ */ toRaw(this);
  track(obj, "has", key);
  return obj.hasOwnProperty(key);
}
class BaseReactiveHandler {
  constructor(_isReadonly = false, _isShallow = false) {
    this._isReadonly = _isReadonly;
    this._isShallow = _isShallow;
  }
  get(target, key, receiver) {
    if (key === "__v_skip") return target["__v_skip"];
    const isReadonly2 = this._isReadonly, isShallow2 = this._isShallow;
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return isShallow2;
    } else if (key === "__v_raw") {
      if (receiver === (isReadonly2 ? isShallow2 ? shallowReadonlyMap : readonlyMap : isShallow2 ? shallowReactiveMap : reactiveMap).get(target) || // receiver is not the reactive proxy, but has the same prototype
      // this means the receiver is a user proxy of the reactive proxy
      Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)) {
        return target;
      }
      return;
    }
    const targetIsArray = isArray(target);
    if (!isReadonly2) {
      let fn;
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn;
      }
      if (key === "hasOwnProperty") {
        return hasOwnProperty;
      }
    }
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res;
    }
    if (!isReadonly2) {
      track(target, "get", key);
    }
    if (isShallow2) {
      return res;
    }
    if (/* @__PURE__ */ isRef(res)) {
      const value = targetIsArray && isIntegerKey(key) ? res : res.value;
      return isReadonly2 && isObject(value) ? /* @__PURE__ */ readonly(value) : value;
    }
    if (isObject(res)) {
      return isReadonly2 ? /* @__PURE__ */ readonly(res) : /* @__PURE__ */ reactive(res);
    }
    return res;
  }
}
class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(false, isShallow2);
  }
  set(target, key, value, receiver) {
    let oldValue = target[key];
    const isArrayWithIntegerKey = isArray(target) && isIntegerKey(key);
    if (!this._isShallow) {
      const isOldValueReadonly = /* @__PURE__ */ isReadonly(oldValue);
      if (!/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
        oldValue = /* @__PURE__ */ toRaw(oldValue);
        value = /* @__PURE__ */ toRaw(value);
      }
      if (!isArrayWithIntegerKey && /* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
        if (isOldValueReadonly) {
          return true;
        } else {
          oldValue.value = value;
          return true;
        }
      }
    }
    const hadKey = isArrayWithIntegerKey ? Number(key) < target.length : hasOwn(target, key);
    const result = Reflect.set(
      target,
      key,
      value,
      /* @__PURE__ */ isRef(target) ? target : receiver
    );
    if (target === /* @__PURE__ */ toRaw(receiver) && result) {
      if (!hadKey) {
        trigger(target, "add", key, value);
      } else if (hasChanged(value, oldValue)) {
        trigger(target, "set", key, value);
      }
    }
    return result;
  }
  deleteProperty(target, key) {
    const hadKey = hasOwn(target, key);
    target[key];
    const result = Reflect.deleteProperty(target, key);
    if (result && hadKey) {
      trigger(target, "delete", key, void 0);
    }
    return result;
  }
  has(target, key) {
    const result = Reflect.has(target, key);
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, "has", key);
    }
    return result;
  }
  ownKeys(target) {
    track(
      target,
      "iterate",
      isArray(target) ? "length" : ITERATE_KEY
    );
    return Reflect.ownKeys(target);
  }
}
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(true, isShallow2);
  }
  set(target, key) {
    return true;
  }
  deleteProperty(target, key) {
    return true;
  }
}
const mutableHandlers = /* @__PURE__ */ new MutableReactiveHandler();
const readonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler();
const shallowReactiveHandlers = /* @__PURE__ */ new MutableReactiveHandler(true);
const shallowReadonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler(true);
const toShallow = (value) => value;
const getProto = (v) => Reflect.getPrototypeOf(v);
function createIterableMethod(method, isReadonly2, isShallow2) {
  return function(...args) {
    const target = this["__v_raw"];
    const rawTarget = /* @__PURE__ */ toRaw(target);
    const targetIsMap = isMap(rawTarget);
    const isPair = method === "entries" || method === Symbol.iterator && targetIsMap;
    const isKeyOnly = method === "keys" && targetIsMap;
    const innerIterator = target[method](...args);
    const wrap = isShallow2 ? toShallow : isReadonly2 ? toReadonly : toReactive;
    !isReadonly2 && track(
      rawTarget,
      "iterate",
      isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
    );
    return extend(
      // inheriting all iterator properties
      Object.create(innerIterator),
      {
        // iterator protocol
        next() {
          const { value, done } = innerIterator.next();
          return done ? { value, done } : {
            value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
            done
          };
        }
      }
    );
  };
}
function createReadonlyMethod(type) {
  return function(...args) {
    return type === "delete" ? false : type === "clear" ? void 0 : this;
  };
}
function createInstrumentations(readonly2, shallow) {
  const instrumentations = {
    get(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "get", key);
        }
        track(rawTarget, "get", rawKey);
      }
      const { has } = getProto(rawTarget);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key));
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey));
      } else if (target !== rawTarget) {
        target.get(key);
      }
    },
    get size() {
      const target = this["__v_raw"];
      !readonly2 && track(/* @__PURE__ */ toRaw(target), "iterate", ITERATE_KEY);
      return target.size;
    },
    has(key) {
      const target = this["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const rawKey = /* @__PURE__ */ toRaw(key);
      if (!readonly2) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "has", key);
        }
        track(rawTarget, "has", rawKey);
      }
      return key === rawKey ? target.has(key) : target.has(key) || target.has(rawKey);
    },
    forEach(callback, thisArg) {
      const observed = this;
      const target = observed["__v_raw"];
      const rawTarget = /* @__PURE__ */ toRaw(target);
      const wrap = shallow ? toShallow : readonly2 ? toReadonly : toReactive;
      !readonly2 && track(rawTarget, "iterate", ITERATE_KEY);
      return target.forEach((value, key) => {
        return callback.call(thisArg, wrap(value), wrap(key), observed);
      });
    }
  };
  extend(
    instrumentations,
    readonly2 ? {
      add: createReadonlyMethod("add"),
      set: createReadonlyMethod("set"),
      delete: createReadonlyMethod("delete"),
      clear: createReadonlyMethod("clear")
    } : {
      add(value) {
        const target = /* @__PURE__ */ toRaw(this);
        const proto = getProto(target);
        const rawValue = /* @__PURE__ */ toRaw(value);
        const valueToAdd = !shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value) ? rawValue : value;
        const hadKey = proto.has.call(target, valueToAdd) || hasChanged(value, valueToAdd) && proto.has.call(target, value) || hasChanged(rawValue, valueToAdd) && proto.has.call(target, rawValue);
        if (!hadKey) {
          target.add(valueToAdd);
          trigger(target, "add", valueToAdd, valueToAdd);
        }
        return this;
      },
      set(key, value) {
        if (!shallow && !/* @__PURE__ */ isShallow(value) && !/* @__PURE__ */ isReadonly(value)) {
          value = /* @__PURE__ */ toRaw(value);
        }
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        }
        const oldValue = get.call(target, key);
        target.set(key, value);
        if (!hadKey) {
          trigger(target, "add", key, value);
        } else if (hasChanged(value, oldValue)) {
          trigger(target, "set", key, value);
        }
        return this;
      },
      delete(key) {
        const target = /* @__PURE__ */ toRaw(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = /* @__PURE__ */ toRaw(key);
          hadKey = has.call(target, key);
        }
        get ? get.call(target, key) : void 0;
        const result = target.delete(key);
        if (hadKey) {
          trigger(target, "delete", key, void 0);
        }
        return result;
      },
      clear() {
        const target = /* @__PURE__ */ toRaw(this);
        const hadItems = target.size !== 0;
        const result = target.clear();
        if (hadItems) {
          trigger(
            target,
            "clear",
            void 0,
            void 0
          );
        }
        return result;
      }
    }
  );
  const iteratorMethods = [
    "keys",
    "values",
    "entries",
    Symbol.iterator
  ];
  iteratorMethods.forEach((method) => {
    instrumentations[method] = createIterableMethod(method, readonly2, shallow);
  });
  return instrumentations;
}
function createInstrumentationGetter(isReadonly2, shallow) {
  const instrumentations = createInstrumentations(isReadonly2, shallow);
  return (target, key, receiver) => {
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return shallow;
    } else if (key === "__v_raw") {
      return target;
    }
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target ? instrumentations : target,
      key,
      receiver
    );
  };
}
const mutableCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, false)
};
const shallowCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, true)
};
const readonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, false)
};
const shallowReadonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, true)
};
const reactiveMap = /* @__PURE__ */ new WeakMap();
const shallowReactiveMap = /* @__PURE__ */ new WeakMap();
const readonlyMap = /* @__PURE__ */ new WeakMap();
const shallowReadonlyMap = /* @__PURE__ */ new WeakMap();
function targetTypeMap(rawType) {
  switch (rawType) {
    case "Object":
    case "Array":
      return 1;
    case "Map":
    case "Set":
    case "WeakMap":
    case "WeakSet":
      return 2;
    default:
      return 0;
  }
}
// @__NO_SIDE_EFFECTS__
function reactive(target) {
  if (/* @__PURE__ */ isReadonly(target)) {
    return target;
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,
    mutableCollectionHandlers,
    reactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReactive(target) {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function readonly(target) {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReadonly(target) {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  );
}
function createReactiveObject(target, isReadonly2, baseHandlers, collectionHandlers, proxyMap) {
  if (!isObject(target)) {
    return target;
  }
  if (target["__v_raw"] && !(isReadonly2 && target["__v_isReactive"])) {
    return target;
  }
  if (target["__v_skip"] || !Object.isExtensible(target)) {
    return target;
  }
  const existingProxy = proxyMap.get(target);
  if (existingProxy) {
    return existingProxy;
  }
  const targetType = targetTypeMap(toRawType(target));
  if (targetType === 0) {
    return target;
  }
  const proxy = new Proxy(
    target,
    targetType === 2 ? collectionHandlers : baseHandlers
  );
  proxyMap.set(target, proxy);
  return proxy;
}
// @__NO_SIDE_EFFECTS__
function isReactive(value) {
  if (/* @__PURE__ */ isReadonly(value)) {
    return /* @__PURE__ */ isReactive(value["__v_raw"]);
  }
  return !!(value && value["__v_isReactive"]);
}
// @__NO_SIDE_EFFECTS__
function isReadonly(value) {
  return !!(value && value["__v_isReadonly"]);
}
// @__NO_SIDE_EFFECTS__
function isShallow(value) {
  return !!(value && value["__v_isShallow"]);
}
// @__NO_SIDE_EFFECTS__
function isProxy(value) {
  return value ? !!value["__v_raw"] : false;
}
// @__NO_SIDE_EFFECTS__
function toRaw(observed) {
  const raw = observed && observed["__v_raw"];
  return raw ? /* @__PURE__ */ toRaw(raw) : observed;
}
function markRaw(value) {
  if (!hasOwn(value, "__v_skip") && Object.isExtensible(value)) {
    def(value, "__v_skip", true);
  }
  return value;
}
const toReactive = (value) => isObject(value) ? /* @__PURE__ */ reactive(value) : value;
const toReadonly = (value) => isObject(value) ? /* @__PURE__ */ readonly(value) : value;
// @__NO_SIDE_EFFECTS__
function isRef(r) {
  return r ? r["__v_isRef"] === true : false;
}
// @__NO_SIDE_EFFECTS__
function ref(value) {
  return createRef(value, false);
}
// @__NO_SIDE_EFFECTS__
function shallowRef(value) {
  return createRef(value, true);
}
function createRef(rawValue, shallow) {
  if (/* @__PURE__ */ isRef(rawValue)) {
    return rawValue;
  }
  return new RefImpl(rawValue, shallow);
}
class RefImpl {
  constructor(value, isShallow2) {
    this.dep = new Dep();
    this["__v_isRef"] = true;
    this["__v_isShallow"] = false;
    this._rawValue = isShallow2 ? value : /* @__PURE__ */ toRaw(value);
    this._value = isShallow2 ? value : toReactive(value);
    this["__v_isShallow"] = isShallow2;
  }
  get value() {
    {
      this.dep.track();
    }
    return this._value;
  }
  set value(newValue) {
    const oldValue = this._rawValue;
    const useDirectValue = this["__v_isShallow"] || /* @__PURE__ */ isShallow(newValue) || /* @__PURE__ */ isReadonly(newValue);
    newValue = useDirectValue ? newValue : /* @__PURE__ */ toRaw(newValue);
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue;
      this._value = useDirectValue ? newValue : toReactive(newValue);
      {
        this.dep.trigger();
      }
    }
  }
}
function unref(ref2) {
  return /* @__PURE__ */ isRef(ref2) ? ref2.value : ref2;
}
const shallowUnwrapHandlers = {
  get: (target, key, receiver) => key === "__v_raw" ? target : unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key];
    if (/* @__PURE__ */ isRef(oldValue) && !/* @__PURE__ */ isRef(value)) {
      oldValue.value = value;
      return true;
    } else {
      return Reflect.set(target, key, value, receiver);
    }
  }
};
function proxyRefs(objectWithRefs) {
  return /* @__PURE__ */ isReactive(objectWithRefs) ? objectWithRefs : new Proxy(objectWithRefs, shallowUnwrapHandlers);
}
class ComputedRefImpl {
  constructor(fn, setter, isSSR) {
    this.fn = fn;
    this.setter = setter;
    this._value = void 0;
    this.dep = new Dep(this);
    this.__v_isRef = true;
    this.deps = void 0;
    this.depsTail = void 0;
    this.flags = 16;
    this.globalVersion = globalVersion - 1;
    this.next = void 0;
    this.effect = this;
    this["__v_isReadonly"] = !setter;
    this.isSSR = isSSR;
  }
  /**
   * @internal
   */
  notify() {
    this.flags |= 16;
    if (!(this.flags & 8) && // avoid infinite self recursion
    activeSub !== this) {
      batch(this, true);
      return true;
    }
  }
  get value() {
    const link = this.dep.track();
    refreshComputed(this);
    if (link) {
      link.version = this.dep.version;
    }
    return this._value;
  }
  set value(newValue) {
    if (this.setter) {
      this.setter(newValue);
    }
  }
}
// @__NO_SIDE_EFFECTS__
function computed$1(getterOrOptions, debugOptions, isSSR = false) {
  let getter;
  let setter;
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions;
  } else {
    getter = getterOrOptions.get;
    setter = getterOrOptions.set;
  }
  const cRef = new ComputedRefImpl(getter, setter, isSSR);
  return cRef;
}
const INITIAL_WATCHER_VALUE = {};
const cleanupMap = /* @__PURE__ */ new WeakMap();
let activeWatcher = void 0;
function onWatcherCleanup(cleanupFn, failSilently = false, owner = activeWatcher) {
  if (owner) {
    let cleanups = cleanupMap.get(owner);
    if (!cleanups) cleanupMap.set(owner, cleanups = []);
    cleanups.push(cleanupFn);
  }
}
function watch$1(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, once, scheduler, augmentJob, call } = options;
  const reactiveGetter = (source2) => {
    if (deep) return source2;
    if (/* @__PURE__ */ isShallow(source2) || deep === false || deep === 0)
      return traverse(source2, 1);
    return traverse(source2);
  };
  let effect2;
  let getter;
  let cleanup;
  let boundCleanup;
  let forceTrigger = false;
  let isMultiSource = false;
  if (/* @__PURE__ */ isRef(source)) {
    getter = () => source.value;
    forceTrigger = /* @__PURE__ */ isShallow(source);
  } else if (/* @__PURE__ */ isReactive(source)) {
    getter = () => reactiveGetter(source);
    forceTrigger = true;
  } else if (isArray(source)) {
    isMultiSource = true;
    forceTrigger = source.some((s) => /* @__PURE__ */ isReactive(s) || /* @__PURE__ */ isShallow(s));
    getter = () => source.map((s) => {
      if (/* @__PURE__ */ isRef(s)) {
        return s.value;
      } else if (/* @__PURE__ */ isReactive(s)) {
        return reactiveGetter(s);
      } else if (isFunction(s)) {
        return call ? call(s, 2) : s();
      } else ;
    });
  } else if (isFunction(source)) {
    if (cb) {
      getter = call ? () => call(source, 2) : source;
    } else {
      getter = () => {
        if (cleanup) {
          pauseTracking();
          try {
            cleanup();
          } finally {
            resetTracking();
          }
        }
        const currentEffect = activeWatcher;
        activeWatcher = effect2;
        try {
          return call ? call(source, 3, [boundCleanup]) : source(boundCleanup);
        } finally {
          activeWatcher = currentEffect;
        }
      };
    }
  } else {
    getter = NOOP;
  }
  if (cb && deep) {
    const baseGetter = getter;
    const depth = deep === true ? Infinity : deep;
    getter = () => traverse(baseGetter(), depth);
  }
  const scope = getCurrentScope();
  const watchHandle = () => {
    effect2.stop();
    if (scope && scope.active) {
      remove(scope.effects, effect2);
    }
  };
  if (once && cb) {
    const _cb = cb;
    cb = (...args) => {
      try {
        return _cb(...args);
      } finally {
        watchHandle();
      }
    };
  }
  let oldValue = isMultiSource ? new Array(source.length).fill(INITIAL_WATCHER_VALUE) : INITIAL_WATCHER_VALUE;
  const job = (immediateFirstRun) => {
    if (!(effect2.flags & 1) || !effect2.dirty && !immediateFirstRun) {
      return;
    }
    if (cb) {
      const newValue = effect2.run();
      if (immediateFirstRun || deep || forceTrigger || (isMultiSource ? newValue.some((v, i) => hasChanged(v, oldValue[i])) : hasChanged(newValue, oldValue))) {
        const currentWatcher = activeWatcher;
        pauseTracking();
        try {
          if (cleanup) {
            cleanup();
          }
          activeWatcher = effect2;
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            oldValue === INITIAL_WATCHER_VALUE ? void 0 : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE ? [] : oldValue,
            boundCleanup
          ];
          oldValue = newValue;
          call ? call(cb, 3, args) : (
            // @ts-expect-error
            cb(...args)
          );
        } finally {
          activeWatcher = currentWatcher;
          resetTracking();
        }
      }
    } else {
      effect2.run();
    }
  };
  if (augmentJob) {
    augmentJob(job);
  }
  effect2 = new ReactiveEffect(getter);
  effect2.scheduler = scheduler ? () => scheduler(job, false) : job;
  boundCleanup = (fn) => onWatcherCleanup(fn, false, effect2);
  cleanup = effect2.onStop = () => {
    const cleanups = cleanupMap.get(effect2);
    if (cleanups) {
      if (call) {
        call(cleanups, 4);
      } else {
        for (const cleanup2 of cleanups) cleanup2();
      }
      cleanupMap.delete(effect2);
    }
  };
  if (cb) {
    if (immediate) {
      job(true);
    } else {
      oldValue = effect2.run();
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true);
  } else {
    effect2.run();
  }
  watchHandle.pause = effect2.pause.bind(effect2);
  watchHandle.resume = effect2.resume.bind(effect2);
  watchHandle.stop = watchHandle;
  return watchHandle;
}
function traverse(value, depth = Infinity, seen) {
  if (depth <= 0 || !isObject(value) || value["__v_skip"]) {
    return value;
  }
  seen = seen || /* @__PURE__ */ new Map();
  if ((seen.get(value) || 0) >= depth) {
    return value;
  }
  seen.set(value, depth);
  depth--;
  if (/* @__PURE__ */ isRef(value)) {
    traverse(value.value, depth, seen);
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen);
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v) => {
      traverse(v, depth, seen);
    });
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], depth, seen);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key], depth, seen);
      }
    }
  }
  return value;
}
const stack = [];
let isWarning = false;
function warn$1(msg, ...args) {
  if (isWarning) return;
  isWarning = true;
  pauseTracking();
  const instance = stack.length ? stack[stack.length - 1].component : null;
  const appWarnHandler = instance && instance.appContext.config.warnHandler;
  const trace = getComponentTrace();
  if (appWarnHandler) {
    callWithErrorHandling(
      appWarnHandler,
      instance,
      11,
      [
        // eslint-disable-next-line no-restricted-syntax
        msg + args.map((a) => {
          var _a, _b;
          return (_b = (_a = a.toString) == null ? void 0 : _a.call(a)) != null ? _b : JSON.stringify(a);
        }).join(""),
        instance && instance.proxy,
        trace.map(
          ({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`
        ).join("\n"),
        trace
      ]
    );
  } else {
    const warnArgs = [`[Vue warn]: ${msg}`, ...args];
    if (trace.length && // avoid spamming console during tests
    true) {
      warnArgs.push(`
`, ...formatTrace(trace));
    }
    console.warn(...warnArgs);
  }
  resetTracking();
  isWarning = false;
}
function getComponentTrace() {
  let currentVNode = stack[stack.length - 1];
  if (!currentVNode) {
    return [];
  }
  const normalizedStack = [];
  while (currentVNode) {
    const last = normalizedStack[0];
    if (last && last.vnode === currentVNode) {
      last.recurseCount++;
    } else {
      normalizedStack.push({
        vnode: currentVNode,
        recurseCount: 0
      });
    }
    const parentInstance = currentVNode.component && currentVNode.component.parent;
    currentVNode = parentInstance && parentInstance.vnode;
  }
  return normalizedStack;
}
function formatTrace(trace) {
  const logs = [];
  trace.forEach((entry, i) => {
    logs.push(...i === 0 ? [] : [`
`], ...formatTraceEntry(entry));
  });
  return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
  const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
  const isRoot = vnode.component ? vnode.component.parent == null : false;
  const open = ` at <${formatComponentName(
    vnode.component,
    vnode.type,
    isRoot
  )}`;
  const close = `>` + postfix;
  return vnode.props ? [open, ...formatProps(vnode.props), close] : [open + close];
}
function formatProps(props) {
  const res = [];
  const keys = Object.keys(props);
  keys.slice(0, 3).forEach((key) => {
    res.push(...formatProp(key, props[key]));
  });
  if (keys.length > 3) {
    res.push(` ...`);
  }
  return res;
}
function formatProp(key, value, raw) {
  if (isString(value)) {
    value = JSON.stringify(value);
    return raw ? value : [`${key}=${value}`];
  } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return raw ? value : [`${key}=${value}`];
  } else if (/* @__PURE__ */ isRef(value)) {
    value = formatProp(key, /* @__PURE__ */ toRaw(value.value), true);
    return raw ? value : [`${key}=Ref<`, value, `>`];
  } else if (isFunction(value)) {
    return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
  } else {
    value = /* @__PURE__ */ toRaw(value);
    return raw ? value : [`${key}=`, value];
  }
}
function callWithErrorHandling(fn, instance, type, args) {
  try {
    return args ? fn(...args) : fn();
  } catch (err) {
    handleError(err, instance, type);
  }
}
function callWithAsyncErrorHandling(fn, instance, type, args) {
  if (isFunction(fn)) {
    const res = callWithErrorHandling(fn, instance, type, args);
    if (res && isPromise(res)) {
      res.catch((err) => {
        handleError(err, instance, type);
      });
    }
    return res;
  }
  if (isArray(fn)) {
    const values = [];
    for (let i = 0; i < fn.length; i++) {
      values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
    }
    return values;
  }
}
function handleError(err, instance, type, throwInDev = true) {
  const contextVNode = instance ? instance.vnode : null;
  const { errorHandler, throwUnhandledErrorInProduction } = instance && instance.appContext.config || EMPTY_OBJ;
  if (instance) {
    let cur = instance.parent;
    const exposedInstance = instance.proxy;
    const errorInfo = `https://vuejs.org/error-reference/#runtime-${type}`;
    while (cur) {
      const errorCapturedHooks = cur.ec;
      if (errorCapturedHooks) {
        for (let i = 0; i < errorCapturedHooks.length; i++) {
          if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
            return;
          }
        }
      }
      cur = cur.parent;
    }
    if (errorHandler) {
      pauseTracking();
      callWithErrorHandling(errorHandler, null, 10, [
        err,
        exposedInstance,
        errorInfo
      ]);
      resetTracking();
      return;
    }
  }
  logError(err, type, contextVNode, throwInDev, throwUnhandledErrorInProduction);
}
function logError(err, type, contextVNode, throwInDev = true, throwInProd = false) {
  if (throwInProd) {
    throw err;
  } else {
    console.error(err);
  }
}
const queue = [];
let flushIndex = -1;
const pendingPostFlushCbs = [];
let activePostFlushCbs = null;
let postFlushIndex = 0;
const resolvedPromise = /* @__PURE__ */ Promise.resolve();
let currentFlushPromise = null;
function nextTick(fn) {
  const p2 = currentFlushPromise || resolvedPromise;
  return fn ? p2.then(this ? fn.bind(this) : fn) : p2;
}
function findInsertionIndex(id) {
  let start = flushIndex + 1;
  let end = queue.length;
  while (start < end) {
    const middle = start + end >>> 1;
    const middleJob = queue[middle];
    const middleJobId = getId(middleJob);
    if (middleJobId < id || middleJobId === id && middleJob.flags & 2) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}
function queueJob(job) {
  if (!(job.flags & 1)) {
    const jobId = getId(job);
    const lastJob = queue[queue.length - 1];
    if (!lastJob || // fast path when the job id is larger than the tail
    !(job.flags & 2) && jobId >= getId(lastJob)) {
      queue.push(job);
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job);
    }
    job.flags |= 1;
    queueFlush();
  }
}
function queueFlush() {
  if (!currentFlushPromise) {
    currentFlushPromise = resolvedPromise.then(flushJobs);
  }
}
function queuePostFlushCb(cb) {
  if (!isArray(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb);
    } else if (!(cb.flags & 1)) {
      pendingPostFlushCbs.push(cb);
      cb.flags |= 1;
    }
  } else {
    for (let i = 0; i < cb.length; i++) {
      pendingPostFlushCbs.push(cb[i]);
    }
  }
  queueFlush();
}
function flushPreFlushCbs(instance, minUid, seen, i = flushIndex + 1) {
  for (; i < queue.length; i++) {
    const cb = queue[i];
    if (cb && cb.flags & 2) {
      if (instance && cb.id !== instance.uid || minUid !== void 0 && !(cb.id >= minUid)) {
        continue;
      }
      queue.splice(i, 1);
      i = instance ? i - 1 : flushIndex;
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      cb();
      if (!(cb.flags & 4)) {
        cb.flags &= -2;
      }
    }
  }
}
function flushPostFlushCbs(seen, skip, minUid = 0) {
  if (pendingPostFlushCbs.length) {
    let cbs = pendingPostFlushCbs;
    let kept = 0;
    if (skip) {
      cbs = [];
      for (let i = 0; i < pendingPostFlushCbs.length; i++) {
        const cb = pendingPostFlushCbs[i];
        if (cb.i !== void 0 ? !cb.i || cb.i.uid < minUid : skip.has(cb)) {
          pendingPostFlushCbs[kept++] = cb;
        } else {
          cbs.push(cb);
        }
      }
    }
    const deduped = [...new Set(cbs)].sort((a, b) => getId(a) - getId(b));
    pendingPostFlushCbs.length = kept;
    if (activePostFlushCbs) {
      for (let i = 0; i < deduped.length; i++) {
        activePostFlushCbs.push(deduped[i]);
      }
      return;
    }
    activePostFlushCbs = deduped;
    for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
      const cb = activePostFlushCbs[postFlushIndex];
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      if (!(cb.flags & 8)) cb();
      cb.flags &= -2;
    }
    activePostFlushCbs = null;
    postFlushIndex = 0;
  }
}
let isFlushing = false;
function flushOnAppMount(fn, minUid) {
  if (isFlushing) {
    fn();
    return;
  }
  const queued = minUid === void 0 ? void 0 : new Set(pendingPostFlushCbs);
  fn();
  isFlushing = true;
  try {
    flushPreFlushCbs(void 0, minUid);
    flushPostFlushCbs(void 0, queued, minUid);
  } finally {
    isFlushing = false;
  }
}
const getId = (job) => job.id == null ? job.flags & 2 ? -1 : Infinity : job.id;
function flushJobs(seen) {
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job && !(job.flags & 8)) {
        if (false) ;
        if (job.flags & 4) {
          job.flags &= ~1;
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? 15 : 14
        );
        if (!(job.flags & 4)) {
          job.flags &= ~1;
        }
      }
    }
  } finally {
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job) {
        job.flags &= -2;
      }
    }
    flushIndex = -1;
    queue.length = 0;
    flushPostFlushCbs();
    currentFlushPromise = null;
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs();
    }
  }
}
let currentRenderingInstance = null;
let currentScopeId = null;
function setCurrentRenderingInstance(instance) {
  const prev = currentRenderingInstance;
  currentRenderingInstance = instance;
  currentScopeId = instance && instance.type.__scopeId || null;
  return prev;
}
function withCtx(fn, ctx = currentRenderingInstance, isNonScopedSlot) {
  if (!ctx) return fn;
  if (fn._n) {
    return fn;
  }
  const renderFnWithContext = (...args) => {
    if (renderFnWithContext._d) {
      setBlockTracking(-1);
    }
    const prevInstance = setCurrentRenderingInstance(ctx);
    const prevStackSize = blockStack.length;
    let res;
    try {
      res = fn(...args);
    } finally {
      for (let i = blockStack.length; i > prevStackSize; i--) closeBlock();
      setCurrentRenderingInstance(prevInstance);
      if (renderFnWithContext._d) {
        setBlockTracking(1);
      }
    }
    return res;
  };
  renderFnWithContext._n = true;
  renderFnWithContext._c = true;
  renderFnWithContext._d = true;
  return renderFnWithContext;
}
function withDirectives(vnode, directives) {
  if (currentRenderingInstance === null) {
    return vnode;
  }
  const instance = getComponentPublicInstance(currentRenderingInstance);
  const bindings = vnode.dirs || (vnode.dirs = []);
  for (let i = 0; i < directives.length; i++) {
    let [dir, value, arg, modifiers = EMPTY_OBJ] = directives[i];
    if (dir) {
      if (isFunction(dir)) {
        dir = {
          mounted: dir,
          updated: dir
        };
      }
      if (dir.deep) {
        traverse(value);
      }
      bindings.push({
        dir,
        instance,
        value,
        oldValue: void 0,
        arg,
        modifiers
      });
    }
  }
  return vnode;
}
function invokeDirectiveHook(vnode, prevVNode, instance, name) {
  const bindings = vnode.dirs;
  const oldBindings = prevVNode && prevVNode.dirs;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (oldBindings) {
      binding.oldValue = oldBindings[i].value;
    }
    let hook = binding.dir[name];
    if (hook) {
      pauseTracking();
      callWithAsyncErrorHandling(hook, instance, 8, [
        vnode.el,
        binding,
        vnode,
        prevVNode
      ]);
      resetTracking();
    }
  }
}
function provide(key, value) {
  if (currentInstance) {
    let provides = currentInstance.provides;
    const parentProvides = currentInstance.parent && currentInstance.parent.provides;
    if (parentProvides === provides) {
      provides = currentInstance.provides = Object.create(parentProvides);
    }
    provides[key] = value;
  }
}
function inject(key, defaultValue, treatDefaultAsFactory = false) {
  const instance = getCurrentInstance();
  if (instance || currentApp) {
    let provides = currentApp ? currentApp._context.provides : instance ? instance.parent == null || instance.ce ? instance.vnode.appContext && instance.vnode.appContext.provides : instance.parent.provides : void 0;
    if (provides && key in provides) {
      return provides[key];
    } else if (arguments.length > 1) {
      return treatDefaultAsFactory && isFunction(defaultValue) ? defaultValue.call(instance && instance.proxy) : defaultValue;
    } else ;
  }
}
const ssrContextKey = /* @__PURE__ */ Symbol.for("v-scx");
const useSSRContext = () => {
  {
    const ctx = inject(ssrContextKey);
    return ctx;
  }
};
function watch(source, cb, options) {
  return doWatch(source, cb, options);
}
function doWatch(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, flush, once } = options;
  const baseWatchOptions = extend({}, options);
  const runsImmediately = cb && immediate || !cb && flush !== "post";
  let ssrCleanup;
  if (isInSSRComponentSetup) {
    if (flush === "sync") {
      const ctx = useSSRContext();
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = []);
    } else if (!runsImmediately) {
      const watchStopHandle = () => {
      };
      watchStopHandle.stop = NOOP;
      watchStopHandle.resume = NOOP;
      watchStopHandle.pause = NOOP;
      return watchStopHandle;
    }
  }
  const instance = currentInstance;
  baseWatchOptions.call = (fn, type, args) => callWithAsyncErrorHandling(fn, instance, type, args);
  let isPre = false;
  if (flush === "post") {
    baseWatchOptions.scheduler = (job) => {
      job.i = instance;
      queuePostRenderEffect(job, instance && instance.suspense);
    };
  } else if (flush !== "sync") {
    isPre = true;
    baseWatchOptions.scheduler = (job, isFirstRun) => {
      if (isFirstRun) {
        job();
      } else {
        queueJob(job);
      }
    };
  }
  baseWatchOptions.augmentJob = (job) => {
    if (cb) {
      job.flags |= 4;
    }
    if (isPre) {
      job.flags |= 2;
      if (instance) {
        job.id = instance.uid;
        job.i = instance;
      }
    }
  };
  const watchHandle = watch$1(source, cb, baseWatchOptions);
  if (isInSSRComponentSetup) {
    if (ssrCleanup) {
      ssrCleanup.push(watchHandle);
    } else if (runsImmediately) {
      watchHandle();
    }
  }
  return watchHandle;
}
function instanceWatch(source, value, options) {
  const publicThis = this.proxy;
  const getter = isString(source) ? source.includes(".") ? createPathGetter(publicThis, source) : () => publicThis[source] : source.bind(publicThis, publicThis);
  let cb;
  if (isFunction(value)) {
    cb = value;
  } else {
    cb = value.handler;
    options = value;
  }
  const reset = setCurrentInstance(this);
  const res = doWatch(getter, cb.bind(publicThis), options);
  reset();
  return res;
}
function createPathGetter(ctx, path) {
  const segments = path.split(".");
  return () => {
    let cur = ctx;
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]];
    }
    return cur;
  };
}
const pendingMounts = /* @__PURE__ */ new WeakMap();
const TeleportEndKey = /* @__PURE__ */ Symbol("_vte");
const isTeleport = (type) => type.__isTeleport;
const isTeleportDisabled = (props) => props && (props.disabled || props.disabled === "");
const isTeleportDeferred = (props) => props && (props.defer || props.defer === "");
const isTargetSVG = (target) => typeof SVGElement !== "undefined" && target instanceof SVGElement;
const isTargetMathML = (target) => typeof MathMLElement === "function" && target instanceof MathMLElement;
const resolveTarget = (props, select) => {
  const targetSelector = props && props.to;
  if (isString(targetSelector)) {
    if (!select) {
      return null;
    } else {
      const target = select(targetSelector);
      return target;
    }
  } else {
    return targetSelector;
  }
};
const TeleportImpl = {
  name: "Teleport",
  __isTeleport: true,
  process(n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized, internals) {
    const {
      mc: mountChildren,
      pc: patchChildren,
      pbc: patchBlockChildren,
      o: { insert, querySelector, createText, createComment, parentNode }
    } = internals;
    const disabled = isTeleportDisabled(n2.props);
    let { dynamicChildren } = n2;
    const mount = (vnode, container2, anchor2) => {
      if (vnode.shapeFlag & 16) {
        mountChildren(
          vnode.children,
          container2,
          anchor2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      }
    };
    const mountToTarget = (vnode = n2) => {
      const disabled2 = isTeleportDisabled(vnode.props);
      const target = vnode.target = resolveTarget(vnode.props, querySelector);
      const targetAnchor = prepareAnchor(target, vnode, createText, insert);
      if (target) {
        if (namespace !== "svg" && isTargetSVG(target)) {
          namespace = "svg";
        } else if (namespace !== "mathml" && isTargetMathML(target)) {
          namespace = "mathml";
        }
        if (parentComponent && parentComponent.isCE) {
          (parentComponent.ce._teleportTargets || (parentComponent.ce._teleportTargets = /* @__PURE__ */ new Set())).add(target);
        }
        if (!disabled2) {
          mount(vnode, target, targetAnchor);
          updateCssVars(vnode, false);
        }
      }
    };
    const queuePendingMount = (vnode) => {
      const mountJob = () => {
        if (pendingMounts.get(vnode) !== mountJob) return;
        pendingMounts.delete(vnode);
        if (isTeleportDisabled(vnode.props)) {
          const mountContainer = parentNode(vnode.el) || container;
          mount(vnode, mountContainer, vnode.anchor);
          updateCssVars(vnode, true);
        }
        mountToTarget(vnode);
      };
      pendingMounts.set(vnode, mountJob);
      queuePostRenderEffect(mountJob, parentSuspense);
    };
    if (n1 == null) {
      const placeholder = n2.el = createText("");
      const mainAnchor = n2.anchor = createText("");
      insert(placeholder, container, anchor);
      insert(mainAnchor, container, anchor);
      if (isTeleportDeferred(n2.props) || parentSuspense && parentSuspense.pendingBranch) {
        queuePendingMount(n2);
        return;
      }
      if (disabled) {
        mount(n2, container, mainAnchor);
        updateCssVars(n2, true);
      }
      mountToTarget();
    } else {
      n2.el = n1.el;
      const mainAnchor = n2.anchor = n1.anchor;
      const pendingMount = pendingMounts.get(n1);
      if (pendingMount) {
        pendingMount.flags |= 8;
        pendingMounts.delete(n1);
        queuePendingMount(n2);
        return;
      }
      n2.targetStart = n1.targetStart;
      const target = n2.target = n1.target;
      const targetAnchor = n2.targetAnchor = n1.targetAnchor;
      const wasDisabled = isTeleportDisabled(n1.props);
      const currentContainer = wasDisabled ? container : target;
      const currentAnchor = wasDisabled ? mainAnchor : targetAnchor;
      if (namespace === "svg" || isTargetSVG(target)) {
        namespace = "svg";
      } else if (namespace === "mathml" || isTargetMathML(target)) {
        namespace = "mathml";
      }
      if (dynamicChildren) {
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          currentContainer,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds
        );
        traverseStaticChildren(n1, n2, true);
      } else if (!optimized) {
        patchChildren(
          n1,
          n2,
          currentContainer,
          currentAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          false
        );
      }
      if (disabled) {
        if (!wasDisabled) {
          moveTeleport(
            n2,
            container,
            mainAnchor,
            internals,
            1
          );
        } else {
          if (n2.props && n1.props && n2.props.to !== n1.props.to) {
            n2.props.to = n1.props.to;
          }
        }
      } else {
        if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
          const nextTarget = resolveTarget(n2.props, querySelector);
          if (nextTarget) {
            n2.target = nextTarget;
            moveTeleport(
              n2,
              nextTarget,
              null,
              internals,
              0
            );
          }
        } else if (wasDisabled) {
          moveTeleport(
            n2,
            target,
            targetAnchor,
            internals,
            1
          );
        }
      }
      updateCssVars(n2, disabled);
    }
  },
  remove(vnode, parentComponent, parentSuspense, { um: unmount, o: { remove: hostRemove } }, doRemove) {
    const {
      shapeFlag,
      children,
      anchor,
      targetStart,
      targetAnchor,
      target,
      props
    } = vnode;
    const disabled = isTeleportDisabled(props);
    const shouldRemove = doRemove || !disabled;
    const pendingMount = pendingMounts.get(vnode);
    if (pendingMount) {
      pendingMount.flags |= 8;
      pendingMounts.delete(vnode);
    }
    if (target) {
      hostRemove(targetStart);
      hostRemove(targetAnchor);
    }
    doRemove && hostRemove(anchor);
    if (!pendingMount && (disabled || target) && shapeFlag & 16) {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        unmount(
          child,
          parentComponent,
          parentSuspense,
          shouldRemove,
          !!child.dynamicChildren
        );
      }
    }
  },
  move: moveTeleport,
  hydrate: hydrateTeleport
};
function moveTeleport(vnode, container, parentAnchor, { o: { insert }, m: move }, moveType = 2) {
  if (moveType === 0) {
    if (vnode.targetStart) {
      insert(vnode.targetStart, container, parentAnchor);
    }
    insert(vnode.targetAnchor, container, parentAnchor);
    parentAnchor = vnode.targetAnchor;
  }
  const { el, anchor, shapeFlag, children, props } = vnode;
  const isReorder = moveType === 2;
  if (isReorder) {
    insert(el, container, parentAnchor);
  }
  if (!pendingMounts.has(vnode) && (!isReorder || isTeleportDisabled(props))) {
    if (shapeFlag & 16) {
      for (let i = 0; i < children.length; i++) {
        move(
          children[i],
          container,
          parentAnchor,
          2
        );
      }
    }
  }
  if (isReorder) {
    insert(anchor, container, parentAnchor);
  }
}
function hydrateTeleport(node, vnode, parentComponent, parentSuspense, slotScopeIds, optimized, {
  o: { nextSibling, parentNode, querySelector, insert, createText }
}, hydrateChildren) {
  function hydrateAnchor(target2, targetNode) {
    let targetAnchor = targetNode;
    while (targetAnchor) {
      if (targetAnchor && targetAnchor.nodeType === 8) {
        if (targetAnchor.data === "teleport start anchor") {
          vnode.targetStart = targetAnchor;
        } else if (targetAnchor.data === "teleport anchor") {
          vnode.targetAnchor = targetAnchor;
          target2._lpa = vnode.targetAnchor && nextSibling(vnode.targetAnchor);
          break;
        }
      }
      targetAnchor = nextSibling(targetAnchor);
    }
  }
  function hydrateDisabledTeleport(node2, vnode2) {
    vnode2.anchor = hydrateChildren(
      nextSibling(node2),
      vnode2,
      parentNode(node2),
      parentComponent,
      parentSuspense,
      slotScopeIds,
      optimized
    );
  }
  const target = vnode.target = resolveTarget(
    vnode.props,
    querySelector
  );
  const disabled = isTeleportDisabled(vnode.props);
  if (target) {
    const targetNode = target._lpa || target.firstChild;
    if (vnode.shapeFlag & 16) {
      if (disabled) {
        hydrateDisabledTeleport(node, vnode);
        hydrateAnchor(target, targetNode);
        if (!vnode.targetAnchor) {
          prepareAnchor(
            target,
            vnode,
            createText,
            insert,
            // if target is the same as the main view, insert anchors before current node
            // to avoid hydrating mismatch
            parentNode(node) === target ? node : null
          );
        }
      } else {
        vnode.anchor = nextSibling(node);
        hydrateAnchor(target, targetNode);
        if (!vnode.targetAnchor) {
          prepareAnchor(target, vnode, createText, insert);
        }
        hydrateChildren(
          targetNode && nextSibling(targetNode),
          vnode,
          target,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        );
      }
    }
    updateCssVars(vnode, disabled);
  } else if (disabled) {
    if (vnode.shapeFlag & 16) {
      hydrateDisabledTeleport(node, vnode);
      vnode.targetStart = node;
      vnode.targetAnchor = nextSibling(node);
    }
  }
  return vnode.anchor && nextSibling(vnode.anchor);
}
const Teleport = TeleportImpl;
function updateCssVars(vnode, isDisabled) {
  const ctx = vnode.ctx;
  if (ctx && ctx.ut) {
    let node, anchor;
    if (isDisabled) {
      node = vnode.el;
      anchor = vnode.anchor;
    } else {
      node = vnode.targetStart;
      anchor = vnode.targetAnchor;
    }
    while (node && node !== anchor) {
      if (node.nodeType === 1) node.setAttribute("data-v-owner", ctx.uid);
      node = node.nextSibling;
    }
    ctx.ut();
  }
}
function prepareAnchor(target, vnode, createText, insert, anchor = null) {
  const targetStart = vnode.targetStart = createText("");
  const targetAnchor = vnode.targetAnchor = createText("");
  targetStart[TeleportEndKey] = targetAnchor;
  if (target) {
    insert(targetStart, target, anchor);
    insert(targetAnchor, target, anchor);
  }
  return targetAnchor;
}
const leaveCbKey = /* @__PURE__ */ Symbol("_leaveCb");
const enterCbKey = /* @__PURE__ */ Symbol("_enterCb");
function useTransitionState() {
  const state2 = {
    isMounted: false,
    isLeaving: false,
    isUnmounting: false,
    leavingVNodes: /* @__PURE__ */ new Map()
  };
  onMounted(() => {
    state2.isMounted = true;
  });
  onBeforeUnmount(() => {
    state2.isUnmounting = true;
  });
  return state2;
}
const TransitionHookValidator = [Function, Array];
const BaseTransitionPropsValidators = {
  mode: String,
  appear: Boolean,
  persisted: Boolean,
  // enter
  onBeforeEnter: TransitionHookValidator,
  onEnter: TransitionHookValidator,
  onAfterEnter: TransitionHookValidator,
  onEnterCancelled: TransitionHookValidator,
  // leave
  onBeforeLeave: TransitionHookValidator,
  onLeave: TransitionHookValidator,
  onAfterLeave: TransitionHookValidator,
  onLeaveCancelled: TransitionHookValidator,
  // appear
  onBeforeAppear: TransitionHookValidator,
  onAppear: TransitionHookValidator,
  onAfterAppear: TransitionHookValidator,
  onAppearCancelled: TransitionHookValidator
};
const BaseTransitionImpl = {
  name: `BaseTransition`,
  props: BaseTransitionPropsValidators,
  setup(props, { slots }) {
    const instance = getCurrentInstance();
    const state2 = useTransitionState();
    return () => {
      const children = slots.default && getTransitionRawChildren(slots.default(), true);
      const child = children && children.length ? findNonCommentChild(children) : (
        // Keep explicit default-slot conditionals on the same transition path
        // as regular v-if branches, which render a comment placeholder.
        instance.subTree ? createCommentVNode() : void 0
      );
      if (!child) {
        return;
      }
      const rawProps = /* @__PURE__ */ toRaw(props);
      const { mode } = rawProps;
      if (state2.isLeaving) {
        return emptyPlaceholder(child);
      }
      const innerChild = getInnerChild$1(child);
      if (!innerChild) {
        return emptyPlaceholder(child);
      }
      let enterHooks = resolveTransitionHooks(
        innerChild,
        rawProps,
        state2,
        instance,
        // #11061, ensure enterHooks is fresh after clone
        (hooks) => enterHooks = hooks
      );
      if (innerChild.type !== Comment) {
        setTransitionHooks(innerChild, enterHooks);
      }
      let oldInnerChild = instance.subTree && getInnerChild$1(instance.subTree);
      if (oldInnerChild && oldInnerChild.type !== Comment && !isSameVNodeType(oldInnerChild, innerChild) && getTransitionRoot(instance.subTree)) {
        let leavingHooks = resolveTransitionHooks(
          oldInnerChild,
          rawProps,
          state2,
          instance
        );
        setTransitionHooks(oldInnerChild, leavingHooks);
        if (mode === "out-in" && innerChild.type !== Comment) {
          state2.isLeaving = true;
          leavingHooks.afterLeave = () => {
            state2.isLeaving = false;
            if (!(instance.job.flags & 8)) {
              instance.update();
            }
            delete leavingHooks.afterLeave;
            oldInnerChild = void 0;
          };
          return emptyPlaceholder(child);
        } else if (mode === "in-out" && innerChild.type !== Comment) {
          leavingHooks.delayLeave = (el, earlyRemove, delayedLeave) => {
            const leavingVNodesCache = getLeavingNodesForType(
              state2,
              oldInnerChild
            );
            leavingVNodesCache[String(oldInnerChild.key)] = oldInnerChild;
            el[leaveCbKey] = () => {
              earlyRemove();
              el[leaveCbKey] = void 0;
              delete enterHooks.delayedLeave;
              oldInnerChild = void 0;
            };
            enterHooks.delayedLeave = () => {
              delayedLeave();
              delete enterHooks.delayedLeave;
              oldInnerChild = void 0;
            };
          };
        } else {
          oldInnerChild = void 0;
        }
      } else if (oldInnerChild) {
        oldInnerChild = void 0;
      }
      return child;
    };
  }
};
function findNonCommentChild(children) {
  let child = children[0];
  if (children.length > 1) {
    for (const c of children) {
      if (c.type !== Comment) {
        child = c;
        break;
      }
    }
  }
  return child;
}
const BaseTransition = BaseTransitionImpl;
function getLeavingNodesForType(state2, vnode) {
  const { leavingVNodes } = state2;
  let leavingVNodesCache = leavingVNodes.get(vnode.type);
  if (!leavingVNodesCache) {
    leavingVNodesCache = /* @__PURE__ */ Object.create(null);
    leavingVNodes.set(vnode.type, leavingVNodesCache);
  }
  return leavingVNodesCache;
}
function resolveTransitionHooks(vnode, props, state2, instance, postClone) {
  const {
    appear,
    mode,
    persisted = false,
    onBeforeEnter,
    onEnter,
    onAfterEnter,
    onEnterCancelled,
    onBeforeLeave,
    onLeave,
    onAfterLeave,
    onLeaveCancelled,
    onBeforeAppear,
    onAppear,
    onAfterAppear,
    onAppearCancelled
  } = props;
  const key = String(vnode.key);
  const leavingVNodesCache = getLeavingNodesForType(state2, vnode);
  const callHook2 = (hook, args) => {
    hook && callWithAsyncErrorHandling(
      hook,
      instance,
      9,
      args
    );
  };
  const callAsyncHook = (hook, args) => {
    const done = args[1];
    callHook2(hook, args);
    if (isArray(hook)) {
      if (hook.every((hook2) => hook2.length <= 1)) done();
    } else if (hook.length <= 1) {
      done();
    }
  };
  const hooks = {
    mode,
    persisted,
    beforeEnter(el) {
      let hook = onBeforeEnter;
      if (!state2.isMounted) {
        if (appear) {
          hook = onBeforeAppear || onBeforeEnter;
        } else {
          return;
        }
      }
      if (el[leaveCbKey]) {
        el[leaveCbKey](
          true
          /* cancelled */
        );
      }
      const leavingVNode = leavingVNodesCache[key];
      if (leavingVNode && isSameVNodeType(vnode, leavingVNode)) {
        let leavingCb = leavingVNode.el[leaveCbKey];
        if (!leavingCb) {
          const leavingRoot = getTransitionRoot(leavingVNode);
          leavingCb = leavingRoot && leavingRoot.el[leaveCbKey];
        }
        if (leavingCb) {
          leavingCb();
        }
      }
      callHook2(hook, [el]);
    },
    enter(el) {
      if (leavingVNodesCache[key] === vnode) return;
      let hook = onEnter;
      let afterHook = onAfterEnter;
      let cancelHook = onEnterCancelled;
      if (!state2.isMounted) {
        if (appear) {
          hook = onAppear || onEnter;
          afterHook = onAfterAppear || onAfterEnter;
          cancelHook = onAppearCancelled || onEnterCancelled;
        } else {
          return;
        }
      }
      let called = false;
      el[enterCbKey] = (cancelled) => {
        if (called) return;
        called = true;
        if (cancelled) {
          callHook2(cancelHook, [el]);
        } else {
          callHook2(afterHook, [el]);
        }
        if (hooks.delayedLeave) {
          hooks.delayedLeave();
        }
        el[enterCbKey] = void 0;
      };
      const done = el[enterCbKey].bind(null, false);
      if (hook) {
        callAsyncHook(hook, [el, done]);
      } else {
        done();
      }
    },
    leave(el, remove2) {
      const key2 = String(vnode.key);
      if (el[enterCbKey]) {
        el[enterCbKey](
          true
          /* cancelled */
        );
      }
      if (state2.isUnmounting) {
        return remove2();
      }
      callHook2(onBeforeLeave, [el]);
      let called = false;
      el[leaveCbKey] = (cancelled) => {
        if (called) return;
        called = true;
        remove2();
        if (cancelled) {
          callHook2(onLeaveCancelled, [el]);
        } else {
          callHook2(onAfterLeave, [el]);
        }
        el[leaveCbKey] = void 0;
        if (leavingVNodesCache[key2] === vnode) {
          delete leavingVNodesCache[key2];
        }
      };
      const done = el[leaveCbKey].bind(null, false);
      leavingVNodesCache[key2] = vnode;
      if (onLeave) {
        callAsyncHook(onLeave, [el, done]);
      } else {
        done();
      }
    },
    clone(vnode2) {
      const hooks2 = resolveTransitionHooks(
        vnode2,
        props,
        state2,
        instance,
        postClone
      );
      if (postClone) postClone(hooks2);
      return hooks2;
    }
  };
  return hooks;
}
function emptyPlaceholder(vnode) {
  if (isKeepAlive(vnode)) {
    vnode = cloneVNode(vnode);
    vnode.children = null;
    return vnode;
  }
}
function getInnerChild$1(vnode) {
  if (!isKeepAlive(vnode)) {
    if (isTeleport(vnode.type) && vnode.children) {
      return findNonCommentChild(vnode.children);
    }
    return vnode;
  }
  if (vnode.component) {
    return vnode.component.subTree;
  }
  const { shapeFlag, children } = vnode;
  if (children) {
    if (shapeFlag & 16) {
      return children[0];
    }
    if (shapeFlag & 32 && isFunction(children.default)) {
      return children.default();
    }
  }
}
function setTransitionHooks(vnode, hooks) {
  if (vnode.shapeFlag & 6 && vnode.component) {
    vnode.transition = hooks;
    const subTree = vnode.component.subTree;
    setTransitionHooks(
      isTeleport(subTree.type) ? getInnerChild$1(subTree) || subTree : subTree,
      hooks
    );
  } else if (vnode.shapeFlag & 128) {
    vnode.ssContent.transition = hooks.clone(vnode.ssContent);
    vnode.ssFallback.transition = hooks.clone(vnode.ssFallback);
  } else {
    vnode.transition = hooks;
    if (vnode.type === Fragment && isArray(vnode.children)) {
      const child = filterSingleRoot(vnode.children, false);
      if (child) {
        setTransitionHooks(child, hooks);
      }
    }
  }
}
function getTransitionRawChildren(children, keepComment = false, parentKey) {
  let ret = [];
  let keyedFragmentCount = 0;
  for (let i = 0; i < children.length; i++) {
    let child = children[i];
    const key = parentKey == null ? child.key : String(parentKey) + String(child.key != null ? child.key : i);
    if (child.type === Fragment) {
      if (child.patchFlag & 128) keyedFragmentCount++;
      ret = ret.concat(
        getTransitionRawChildren(child.children, keepComment, key)
      );
    } else if (keepComment || child.type !== Comment) {
      ret.push(key != null ? cloneVNode(child, { key }) : child);
    }
  }
  if (keyedFragmentCount > 1) {
    for (let i = 0; i < ret.length; i++) {
      ret[i].patchFlag = -2;
    }
  }
  return ret;
}
function getTransitionRoot(vnode) {
  if (vnode.component) {
    return getTransitionRoot(vnode.component.subTree);
  }
  if (vnode.type === Fragment) {
    const child = isArray(vnode.children) && filterSingleRoot(vnode.children, false);
    return child ? getTransitionRoot(child) : void 0;
  }
  if (vnode.type !== Comment) {
    return vnode;
  }
}
function markAsyncBoundary(instance) {
  instance.ids = [instance.ids[0] + instance.ids[2]++ + "-", 0, 0];
}
function isTemplateRefKey(refs, key) {
  let desc;
  return !!((desc = Object.getOwnPropertyDescriptor(refs, key)) && !desc.configurable);
}
const pendingSetRefMap = /* @__PURE__ */ new WeakMap();
function setRef(rawRef, oldRawRef, parentSuspense, vnode, isUnmount = false) {
  if (isArray(rawRef)) {
    rawRef.forEach(
      (r, i) => setRef(
        r,
        oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef),
        parentSuspense,
        vnode,
        isUnmount
      )
    );
    return;
  }
  if (isAsyncWrapper(vnode) && !isUnmount) {
    if (vnode.shapeFlag & 512 && vnode.type.__asyncResolved && vnode.component.subTree.component) {
      setRef(rawRef, oldRawRef, parentSuspense, vnode.component.subTree);
    }
    return;
  }
  const refValue = vnode.shapeFlag & 4 ? getComponentPublicInstance(vnode.component) : vnode.el;
  const value = isUnmount ? null : refValue;
  const { i: owner, r: ref3 } = rawRef;
  const oldRef = oldRawRef && oldRawRef.r;
  const refs = owner.refs === EMPTY_OBJ ? owner.refs = {} : owner.refs;
  const setupState = owner.setupState;
  const rawSetupState = /* @__PURE__ */ toRaw(setupState);
  const canSetSetupRef = setupState === EMPTY_OBJ ? NO : (key) => {
    if (isTemplateRefKey(refs, key)) {
      return false;
    }
    return hasOwn(rawSetupState, key);
  };
  const canSetRef = (ref22, key) => {
    if (key && isTemplateRefKey(refs, key)) {
      return false;
    }
    return true;
  };
  if (oldRef != null && oldRef !== ref3) {
    invalidatePendingSetRef(oldRawRef);
    if (isString(oldRef)) {
      refs[oldRef] = null;
      if (canSetSetupRef(oldRef)) {
        setupState[oldRef] = null;
      }
    } else if (/* @__PURE__ */ isRef(oldRef)) {
      const oldRawRefAtom = oldRawRef;
      if (canSetRef(oldRef, oldRawRefAtom.k)) {
        oldRef.value = null;
      }
      if (oldRawRefAtom.k) refs[oldRawRefAtom.k] = null;
    }
  }
  if (isFunction(ref3)) {
    callWithErrorHandling(ref3, owner, 12, [value, refs]);
  } else {
    const _isString = isString(ref3);
    const _isRef = /* @__PURE__ */ isRef(ref3);
    if (_isString || _isRef) {
      const doSet = () => {
        if (rawRef.f) {
          const existing = _isString ? canSetSetupRef(ref3) ? setupState[ref3] : refs[ref3] : canSetRef() || !rawRef.k ? ref3.value : refs[rawRef.k];
          if (isUnmount) {
            isArray(existing) && remove(existing, refValue);
          } else {
            if (!isArray(existing)) {
              if (_isString) {
                refs[ref3] = [refValue];
                if (canSetSetupRef(ref3)) {
                  setupState[ref3] = refs[ref3];
                }
              } else {
                const newVal = [refValue];
                if (canSetRef(ref3, rawRef.k)) {
                  ref3.value = newVal;
                }
                if (rawRef.k) refs[rawRef.k] = newVal;
              }
            } else if (!existing.includes(refValue)) {
              existing.push(refValue);
            }
          }
        } else if (_isString) {
          refs[ref3] = value;
          if (canSetSetupRef(ref3)) {
            setupState[ref3] = value;
          }
        } else if (_isRef) {
          if (canSetRef(ref3, rawRef.k)) {
            ref3.value = value;
          }
          if (rawRef.k) refs[rawRef.k] = value;
        } else ;
      };
      if (value) {
        const job = () => {
          doSet();
          pendingSetRefMap.delete(rawRef);
        };
        job.id = -1;
        pendingSetRefMap.set(rawRef, job);
        queuePostRenderEffect(job, parentSuspense);
      } else {
        invalidatePendingSetRef(rawRef);
        doSet();
      }
    }
  }
}
function invalidatePendingSetRef(rawRef) {
  const pendingSetRef = pendingSetRefMap.get(rawRef);
  if (pendingSetRef) {
    pendingSetRef.flags |= 8;
    pendingSetRefMap.delete(rawRef);
  }
}
getGlobalThis().requestIdleCallback || ((cb) => setTimeout(cb, 1));
getGlobalThis().cancelIdleCallback || ((id) => clearTimeout(id));
const isAsyncWrapper = (i) => !!i.type.__asyncLoader;
const isKeepAlive = (vnode) => vnode.type.__isKeepAlive;
function onActivated(hook, target) {
  registerKeepAliveHook(hook, "a", target);
}
function onDeactivated(hook, target) {
  registerKeepAliveHook(hook, "da", target);
}
function registerKeepAliveHook(hook, type, target = currentInstance) {
  const wrappedHook = hook.__wdc || (hook.__wdc = () => {
    let current = target;
    while (current) {
      if (current.isDeactivated) {
        return;
      }
      current = current.parent;
    }
    return hook();
  });
  injectHook(type, wrappedHook, target);
  if (target) {
    let current = target.parent;
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current);
      }
      current = current.parent;
    }
  }
}
function injectToKeepAliveRoot(hook, type, target, keepAliveRoot) {
  const injected = injectHook(
    type,
    hook,
    keepAliveRoot,
    true
    /* prepend */
  );
  onUnmounted(() => {
    remove(keepAliveRoot[type], injected);
  }, target);
}
function injectHook(type, hook, target = currentInstance, prepend = false) {
  if (target) {
    const hooks = target[type] || (target[type] = []);
    const wrappedHook = hook.__weh || (hook.__weh = (...args) => {
      pauseTracking();
      const reset = setCurrentInstance(target);
      const res = callWithAsyncErrorHandling(hook, target, type, args);
      reset();
      resetTracking();
      return res;
    });
    if (prepend) {
      hooks.unshift(wrappedHook);
    } else {
      hooks.push(wrappedHook);
    }
    return wrappedHook;
  }
}
const createHook = (lifecycle) => (hook, target = currentInstance) => {
  if (!isInSSRComponentSetup || lifecycle === "sp") {
    injectHook(lifecycle, (...args) => hook(...args), target);
  }
};
const onBeforeMount = createHook("bm");
const onMounted = createHook("m");
const onBeforeUpdate = createHook(
  "bu"
);
const onUpdated = createHook("u");
const onBeforeUnmount = createHook(
  "bum"
);
const onUnmounted = createHook("um");
const onServerPrefetch = createHook(
  "sp"
);
const onRenderTriggered = createHook("rtg");
const onRenderTracked = createHook("rtc");
function onErrorCaptured(hook, target = currentInstance) {
  injectHook("ec", hook, target);
}
const NULL_DYNAMIC_COMPONENT = /* @__PURE__ */ Symbol.for("v-ndc");
function renderList(source, renderItem, cache, index) {
  let ret;
  const cached = cache;
  const sourceIsArray = isArray(source);
  if (sourceIsArray || isString(source)) {
    const sourceIsReactiveArray = sourceIsArray && /* @__PURE__ */ isReactive(source);
    let needsWrap = false;
    let isReadonlySource = false;
    if (sourceIsReactiveArray) {
      needsWrap = !/* @__PURE__ */ isShallow(source);
      isReadonlySource = /* @__PURE__ */ isReadonly(source);
      source = shallowReadArray(source);
    }
    ret = new Array(source.length);
    for (let i = 0, l = source.length; i < l; i++) {
      ret[i] = renderItem(
        needsWrap ? isReadonlySource ? toReadonly(toReactive(source[i])) : toReactive(source[i]) : source[i],
        i,
        void 0,
        cached
      );
    }
  } else if (typeof source === "number") {
    if (!Number.isInteger(source) || source < 0) {
      ret = [];
    } else {
      ret = new Array(source);
      for (let i = 0; i < source; i++) {
        ret[i] = renderItem(i + 1, i, void 0, cached);
      }
    }
  } else if (isObject(source)) {
    if (source[Symbol.iterator]) {
      ret = Array.from(
        source,
        (item, i) => renderItem(item, i, void 0, cached)
      );
    } else {
      const keys = Object.keys(source);
      ret = new Array(keys.length);
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i];
        ret[i] = renderItem(source[key], key, i, cached);
      }
    }
  } else {
    ret = [];
  }
  return ret;
}
function renderSlot(slots, name, props, fallback, noSlotted, branchKey) {
  if (props == null) props = {};
  if (currentRenderingInstance.ce || currentRenderingInstance.parent && isAsyncWrapper(currentRenderingInstance.parent) && currentRenderingInstance.parent.ce) {
    const slotProps = props;
    const hasProps = Object.keys(slotProps).length > 0;
    if (name !== "default") slotProps.name = name;
    return openBlock(), createBlock(
      Fragment,
      null,
      [createVNode("slot", slotProps, fallback)],
      hasProps ? -2 : 64
    );
  }
  let slot = slots[name];
  if (slot && slot._c) {
    slot._d = false;
  }
  const prevStackSize = blockStack.length;
  openBlock();
  let rendered;
  try {
    const validSlotContent = slot && ensureValidVNode(slot(props));
    const slotKey = props.key || branchKey || // slot content array of a dynamic conditional slot may have a branch
    // key attached in the `createSlots` helper, respect that
    validSlotContent && validSlotContent.key;
    rendered = createBlock(
      Fragment,
      {
        key: (slotKey && !isSymbol(slotKey) ? slotKey : `_${name}`) + // #7256 force differentiate fallback content from actual content
        (!validSlotContent && fallback ? "_fb" : "")
      },
      validSlotContent || (fallback ? fallback() : []),
      validSlotContent && slots._ === 1 ? 64 : -2
    );
  } catch (err) {
    for (let i = blockStack.length; i > prevStackSize; i--) closeBlock();
    throw err;
  } finally {
    if (slot && slot._c) {
      slot._d = true;
    }
  }
  if (!noSlotted && rendered.scopeId) {
    rendered.slotScopeIds = [rendered.scopeId + "-s"];
  }
  return rendered;
}
function ensureValidVNode(vnodes) {
  return vnodes.some((child) => {
    if (!isVNode(child)) return true;
    if (child.type === Comment) return false;
    if (child.type === Fragment && !ensureValidVNode(child.children))
      return false;
    return true;
  }) ? vnodes : null;
}
const getPublicInstance = (i) => {
  if (!i) return null;
  if (isStatefulComponent(i)) return getComponentPublicInstance(i);
  return getPublicInstance(i.parent);
};
const publicPropertiesMap = (
  // Move PURE marker to new line to workaround compiler discarding it
  // due to type annotation
  /* @__PURE__ */ extend(/* @__PURE__ */ Object.create(null), {
    $: (i) => i,
    $el: (i) => i.vnode.el,
    $data: (i) => i.data,
    $props: (i) => i.props,
    $attrs: (i) => i.attrs,
    $slots: (i) => i.slots,
    $refs: (i) => i.refs,
    $parent: (i) => getPublicInstance(i.parent),
    $root: (i) => getPublicInstance(i.root),
    $host: (i) => i.ce,
    $emit: (i) => i.emit,
    $options: (i) => resolveMergedOptions(i),
    $forceUpdate: (i) => i.f || (i.f = () => {
      queueJob(i.update);
    }),
    $nextTick: (i) => i.n || (i.n = nextTick.bind(i.proxy)),
    $watch: (i) => instanceWatch.bind(i)
  })
);
const hasSetupBinding = (state2, key) => state2 !== EMPTY_OBJ && !state2.__isScriptSetup && hasOwn(state2, key);
const PublicInstanceProxyHandlers = {
  get({ _: instance }, key) {
    if (key === "__v_skip") {
      return true;
    }
    const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
    if (key[0] !== "$") {
      const n = accessCache[key];
      if (n !== void 0) {
        switch (n) {
          case 1:
            return setupState[key];
          case 2:
            return data[key];
          case 4:
            return ctx[key];
          case 3:
            return props[key];
        }
      } else if (hasSetupBinding(setupState, key)) {
        accessCache[key] = 1;
        return setupState[key];
      } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
        accessCache[key] = 2;
        return data[key];
      } else if (hasOwn(props, key)) {
        accessCache[key] = 3;
        return props[key];
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        accessCache[key] = 4;
        return ctx[key];
      } else if (shouldCacheAccess) {
        accessCache[key] = 0;
      }
    }
    const publicGetter = publicPropertiesMap[key];
    let cssModule, globalProperties;
    if (publicGetter) {
      if (key === "$attrs") {
        track(instance.attrs, "get", "");
      }
      return publicGetter(instance);
    } else if (
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) && (cssModule = cssModule[key])
    ) {
      return cssModule;
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      accessCache[key] = 4;
      return ctx[key];
    } else if (
      // global properties
      globalProperties = appContext.config.globalProperties, hasOwn(globalProperties, key)
    ) {
      {
        return globalProperties[key];
      }
    } else ;
  },
  set({ _: instance }, key, value) {
    const { data, setupState, ctx } = instance;
    if (hasSetupBinding(setupState, key)) {
      setupState[key] = value;
      return true;
    } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
      data[key] = value;
      return true;
    } else if (hasOwn(instance.props, key)) {
      return false;
    }
    if (key[0] === "$" && key.slice(1) in instance) {
      return false;
    } else {
      {
        ctx[key] = value;
      }
    }
    return true;
  },
  has({
    _: { data, setupState, accessCache, ctx, appContext, props, type }
  }, key) {
    let cssModules;
    return !!(accessCache[key] || data !== EMPTY_OBJ && key[0] !== "$" && hasOwn(data, key) || hasSetupBinding(setupState, key) || hasOwn(props, key) || hasOwn(ctx, key) || hasOwn(publicPropertiesMap, key) || hasOwn(appContext.config.globalProperties, key) || (cssModules = type.__cssModules) && cssModules[key]);
  },
  defineProperty(target, key, descriptor) {
    if (descriptor.get != null) {
      target._.accessCache[key] = 0;
    } else if (hasOwn(descriptor, "value")) {
      this.set(target, key, descriptor.value, null);
    }
    return Reflect.defineProperty(target, key, descriptor);
  }
};
function normalizePropsOrEmits(props) {
  return isArray(props) ? props.reduce(
    (normalized, p2) => (normalized[p2] = null, normalized),
    {}
  ) : props;
}
let shouldCacheAccess = true;
function applyOptions(instance) {
  const options = resolveMergedOptions(instance);
  const publicThis = instance.proxy;
  const ctx = instance.ctx;
  shouldCacheAccess = false;
  if (options.beforeCreate) {
    callHook$1(options.beforeCreate, instance, "bc");
  }
  const {
    // state
    data: dataOptions,
    computed: computedOptions,
    methods,
    watch: watchOptions,
    provide: provideOptions,
    inject: injectOptions,
    // lifecycle
    created,
    beforeMount,
    mounted,
    beforeUpdate,
    updated,
    activated,
    deactivated,
    beforeDestroy,
    beforeUnmount,
    destroyed,
    unmounted,
    render,
    renderTracked,
    renderTriggered,
    errorCaptured,
    serverPrefetch,
    // public API
    expose,
    inheritAttrs,
    // assets
    components,
    directives,
    filters
  } = options;
  const checkDuplicateProperties = null;
  if (injectOptions) {
    resolveInjections(injectOptions, ctx, checkDuplicateProperties);
  }
  if (methods) {
    for (const key in methods) {
      const methodHandler = methods[key];
      if (isFunction(methodHandler)) {
        {
          ctx[key] = methodHandler.bind(publicThis);
        }
      }
    }
  }
  if (dataOptions) {
    const data = dataOptions.call(publicThis, publicThis);
    if (!isObject(data)) ;
    else {
      instance.data = /* @__PURE__ */ reactive(data);
    }
  }
  shouldCacheAccess = true;
  if (computedOptions) {
    for (const key in computedOptions) {
      const opt = computedOptions[key];
      const get = isFunction(opt) ? opt.bind(publicThis, publicThis) : isFunction(opt.get) ? opt.get.bind(publicThis, publicThis) : NOOP;
      const set = !isFunction(opt) && isFunction(opt.set) ? opt.set.bind(publicThis) : NOOP;
      const c = computed({
        get,
        set
      });
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => c.value,
        set: (v) => c.value = v
      });
    }
  }
  if (watchOptions) {
    for (const key in watchOptions) {
      createWatcher(watchOptions[key], ctx, publicThis, key);
    }
  }
  if (provideOptions) {
    const provides = isFunction(provideOptions) ? provideOptions.call(publicThis) : provideOptions;
    Reflect.ownKeys(provides).forEach((key) => {
      provide(key, provides[key]);
    });
  }
  if (created) {
    callHook$1(created, instance, "c");
  }
  function registerLifecycleHook(register, hook) {
    if (isArray(hook)) {
      hook.forEach((_hook) => register(_hook.bind(publicThis)));
    } else if (hook) {
      register(hook.bind(publicThis));
    }
  }
  registerLifecycleHook(onBeforeMount, beforeMount);
  registerLifecycleHook(onMounted, mounted);
  registerLifecycleHook(onBeforeUpdate, beforeUpdate);
  registerLifecycleHook(onUpdated, updated);
  registerLifecycleHook(onActivated, activated);
  registerLifecycleHook(onDeactivated, deactivated);
  registerLifecycleHook(onErrorCaptured, errorCaptured);
  registerLifecycleHook(onRenderTracked, renderTracked);
  registerLifecycleHook(onRenderTriggered, renderTriggered);
  registerLifecycleHook(onBeforeUnmount, beforeUnmount);
  registerLifecycleHook(onUnmounted, unmounted);
  registerLifecycleHook(onServerPrefetch, serverPrefetch);
  if (isArray(expose)) {
    if (expose.length) {
      const exposed = instance.exposed || (instance.exposed = {});
      expose.forEach((key) => {
        Object.defineProperty(exposed, key, {
          get: () => publicThis[key],
          set: (val) => publicThis[key] = val,
          enumerable: true
        });
      });
    } else if (!instance.exposed) {
      instance.exposed = {};
    }
  }
  if (render && instance.render === NOOP) {
    instance.render = render;
  }
  if (inheritAttrs != null) {
    instance.inheritAttrs = inheritAttrs;
  }
  if (components) instance.components = components;
  if (directives) instance.directives = directives;
  if (serverPrefetch) {
    markAsyncBoundary(instance);
  }
}
function resolveInjections(injectOptions, ctx, checkDuplicateProperties = NOOP) {
  if (isArray(injectOptions)) {
    injectOptions = normalizeInject(injectOptions);
  }
  for (const key in injectOptions) {
    const opt = injectOptions[key];
    let injected;
    if (isObject(opt)) {
      if ("default" in opt) {
        injected = inject(
          opt.from || key,
          opt.default,
          true
        );
      } else {
        injected = inject(opt.from || key);
      }
    } else {
      injected = inject(opt);
    }
    if (/* @__PURE__ */ isRef(injected)) {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => injected.value,
        set: (v) => injected.value = v
      });
    } else {
      ctx[key] = injected;
    }
  }
}
function callHook$1(hook, instance, type) {
  callWithAsyncErrorHandling(
    isArray(hook) ? hook.map((h2) => h2.bind(instance.proxy)) : hook.bind(instance.proxy),
    instance,
    type
  );
}
function createWatcher(raw, ctx, publicThis, key) {
  let getter = key.includes(".") ? createPathGetter(publicThis, key) : () => publicThis[key];
  if (isString(raw)) {
    const handler = ctx[raw];
    if (isFunction(handler)) {
      {
        watch(getter, handler);
      }
    }
  } else if (isFunction(raw)) {
    {
      watch(getter, raw.bind(publicThis));
    }
  } else if (isObject(raw)) {
    if (isArray(raw)) {
      raw.forEach((r) => createWatcher(r, ctx, publicThis, key));
    } else {
      const handler = isFunction(raw.handler) ? raw.handler.bind(publicThis) : ctx[raw.handler];
      if (isFunction(handler)) {
        watch(getter, handler, raw);
      }
    }
  } else ;
}
function resolveMergedOptions(instance) {
  const base = instance.type;
  const { mixins, extends: extendsOptions } = base;
  const {
    mixins: globalMixins,
    optionsCache: cache,
    config: { optionMergeStrategies }
  } = instance.appContext;
  const cached = cache.get(base);
  let resolved;
  if (cached) {
    resolved = cached;
  } else if (!globalMixins.length && !mixins && !extendsOptions) {
    {
      resolved = base;
    }
  } else {
    resolved = {};
    if (globalMixins.length) {
      globalMixins.forEach(
        (m) => mergeOptions(resolved, m, optionMergeStrategies, true)
      );
    }
    mergeOptions(resolved, base, optionMergeStrategies);
  }
  if (isObject(base)) {
    cache.set(base, resolved);
  }
  return resolved;
}
function mergeOptions(to, from, strats, asMixin = false) {
  const { mixins, extends: extendsOptions } = from;
  if (extendsOptions) {
    mergeOptions(to, extendsOptions, strats, true);
  }
  if (mixins) {
    mixins.forEach(
      (m) => mergeOptions(to, m, strats, true)
    );
  }
  for (const key in from) {
    if (asMixin && key === "expose") ;
    else {
      const strat = internalOptionMergeStrats[key] || strats && strats[key];
      to[key] = strat ? strat(to[key], from[key]) : from[key];
    }
  }
  return to;
}
const internalOptionMergeStrats = {
  data: mergeDataFn,
  props: mergeEmitsOrPropsOptions,
  emits: mergeEmitsOrPropsOptions,
  // objects
  methods: mergeObjectOptions,
  computed: mergeObjectOptions,
  // lifecycle
  beforeCreate: mergeAsArray,
  created: mergeAsArray,
  beforeMount: mergeAsArray,
  mounted: mergeAsArray,
  beforeUpdate: mergeAsArray,
  updated: mergeAsArray,
  beforeDestroy: mergeAsArray,
  beforeUnmount: mergeAsArray,
  destroyed: mergeAsArray,
  unmounted: mergeAsArray,
  activated: mergeAsArray,
  deactivated: mergeAsArray,
  errorCaptured: mergeAsArray,
  serverPrefetch: mergeAsArray,
  // assets
  components: mergeObjectOptions,
  directives: mergeObjectOptions,
  // watch
  watch: mergeWatchOptions,
  // provide / inject
  provide: mergeDataFn,
  inject: mergeInject
};
function mergeDataFn(to, from) {
  if (!from) {
    return to;
  }
  if (!to) {
    return from;
  }
  return function mergedDataFn() {
    return extend(
      isFunction(to) ? to.call(this, this) : to,
      isFunction(from) ? from.call(this, this) : from
    );
  };
}
function mergeInject(to, from) {
  return mergeObjectOptions(normalizeInject(to), normalizeInject(from));
}
function normalizeInject(raw) {
  if (isArray(raw)) {
    const res = {};
    for (let i = 0; i < raw.length; i++) {
      res[raw[i]] = raw[i];
    }
    return res;
  }
  return raw;
}
function mergeAsArray(to, from) {
  return to ? [...new Set([].concat(to, from))] : from;
}
function mergeObjectOptions(to, from) {
  return to ? extend(/* @__PURE__ */ Object.create(null), to, from) : from;
}
function mergeEmitsOrPropsOptions(to, from) {
  if (to) {
    if (isArray(to) && isArray(from)) {
      return [.../* @__PURE__ */ new Set([...to, ...from])];
    }
    return extend(
      /* @__PURE__ */ Object.create(null),
      normalizePropsOrEmits(to),
      normalizePropsOrEmits(from != null ? from : {})
    );
  } else {
    return from;
  }
}
function mergeWatchOptions(to, from) {
  if (!to) return from;
  if (!from) return to;
  const merged = extend(/* @__PURE__ */ Object.create(null), to);
  for (const key in from) {
    merged[key] = mergeAsArray(to[key], from[key]);
  }
  return merged;
}
function createAppContext() {
  return {
    app: null,
    config: {
      isNativeTag: NO,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: void 0,
      warnHandler: void 0,
      compilerOptions: {}
    },
    mixins: [],
    components: {},
    directives: {},
    provides: /* @__PURE__ */ Object.create(null),
    optionsCache: /* @__PURE__ */ new WeakMap(),
    propsCache: /* @__PURE__ */ new WeakMap(),
    emitsCache: /* @__PURE__ */ new WeakMap()
  };
}
let uid$1 = 0;
function createAppAPI(render, hydrate) {
  return function createApp2(rootComponent, rootProps = null) {
    if (!isFunction(rootComponent)) {
      rootComponent = extend({}, rootComponent);
    }
    if (rootProps != null && !isObject(rootProps)) {
      rootProps = null;
    }
    const context = createAppContext();
    const installedPlugins = /* @__PURE__ */ new WeakSet();
    const pluginCleanupFns = [];
    let isMounted = false;
    const app2 = context.app = {
      _uid: uid$1++,
      _component: rootComponent,
      _props: rootProps,
      _container: null,
      _context: context,
      _instance: null,
      version,
      get config() {
        return context.config;
      },
      set config(v) {
      },
      use(plugin, ...options) {
        if (installedPlugins.has(plugin)) ;
        else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin);
          plugin.install(app2, ...options);
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin);
          plugin(app2, ...options);
        } else ;
        return app2;
      },
      mixin(mixin) {
        {
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin);
          }
        }
        return app2;
      },
      component(name, component) {
        if (!component) {
          return context.components[name];
        }
        context.components[name] = component;
        return app2;
      },
      directive(name, directive) {
        if (!directive) {
          return context.directives[name];
        }
        context.directives[name] = directive;
        return app2;
      },
      mount(rootContainer, isHydrate, namespace) {
        if (!isMounted) {
          const vnode = app2._ceVNode || createVNode(rootComponent, rootProps);
          vnode.appContext = context;
          if (namespace === true) {
            namespace = "svg";
          } else if (namespace === false) {
            namespace = void 0;
          }
          {
            render(vnode, rootContainer, namespace);
          }
          isMounted = true;
          app2._container = rootContainer;
          rootContainer.__vue_app__ = app2;
          return getComponentPublicInstance(vnode.component);
        }
      },
      onUnmount(cleanupFn) {
        pluginCleanupFns.push(cleanupFn);
      },
      unmount() {
        if (isMounted) {
          callWithAsyncErrorHandling(
            pluginCleanupFns,
            app2._instance,
            16
          );
          render(null, app2._container);
          delete app2._container.__vue_app__;
        }
      },
      provide(key, value) {
        context.provides[key] = value;
        return app2;
      },
      runWithContext(fn) {
        const lastApp = currentApp;
        currentApp = app2;
        try {
          return fn();
        } finally {
          currentApp = lastApp;
        }
      }
    };
    return app2;
  };
}
let currentApp = null;
const getModelModifiers = (props, modelName) => {
  return modelName === "modelValue" || modelName === "model-value" ? props.modelModifiers : props[`${modelName}Modifiers`] || props[`${camelize(modelName)}Modifiers`] || props[`${hyphenate(modelName)}Modifiers`];
};
function emit(instance, event, ...rawArgs) {
  if (instance.isUnmounted) return;
  const props = instance.vnode.props || EMPTY_OBJ;
  let args = rawArgs;
  const isModelListener2 = event.startsWith("update:");
  const modifiers = isModelListener2 && getModelModifiers(props, event.slice(7));
  if (modifiers) {
    if (modifiers.trim) {
      args = rawArgs.map((a) => isString(a) ? a.trim() : a);
    }
    if (modifiers.number) {
      args = args.map(looseToNumber);
    }
  }
  let handlerName;
  let handler = props[handlerName = toHandlerKey(event)] || // also try camelCase event handler (#2249)
  props[handlerName = toHandlerKey(camelize(event))];
  if (!handler && isModelListener2) {
    handler = props[handlerName = toHandlerKey(hyphenate(event))];
  }
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      6,
      args
    );
  }
  const onceHandler = props[handlerName + `Once`];
  if (onceHandler) {
    if (!instance.emitted) {
      instance.emitted = {};
    } else if (instance.emitted[handlerName]) {
      return;
    }
    instance.emitted[handlerName] = true;
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      6,
      args
    );
  }
}
const mixinEmitsCache = /* @__PURE__ */ new WeakMap();
function normalizeEmitsOptions(comp, appContext, asMixin = false) {
  const cache = asMixin ? mixinEmitsCache : appContext.emitsCache;
  const cached = cache.get(comp);
  if (cached !== void 0) {
    return cached;
  }
  const raw = comp.emits;
  let normalized = {};
  let hasExtends = false;
  if (!isFunction(comp)) {
    const extendEmits = (raw2) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw2, appContext, true);
      if (normalizedFromExtend) {
        hasExtends = true;
        extend(normalized, normalizedFromExtend);
      }
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits);
    }
    if (comp.extends) {
      extendEmits(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, null);
    }
    return null;
  }
  if (isArray(raw)) {
    raw.forEach((key) => normalized[key] = null);
  } else {
    extend(normalized, raw);
  }
  if (isObject(comp)) {
    cache.set(comp, normalized);
  }
  return normalized;
}
function isEmitListener(options, key) {
  if (!options || !isOn(key)) {
    return false;
  }
  key = key.slice(2);
  key = key === "Once" ? key : key.replace(/Once$/, "");
  return hasOwn(options, key[0].toLowerCase() + key.slice(1)) || hasOwn(options, hyphenate(key)) || hasOwn(options, key);
}
function markAttrsAccessed() {
}
function renderComponentRoot(instance) {
  const {
    type: Component,
    vnode,
    proxy,
    withProxy,
    propsOptions: [propsOptions],
    slots,
    attrs,
    emit: emit2,
    render,
    renderCache,
    props,
    data,
    setupState,
    ctx,
    inheritAttrs
  } = instance;
  const prev = setCurrentRenderingInstance(instance);
  let result;
  let fallthroughAttrs;
  try {
    if (vnode.shapeFlag & 4) {
      const proxyToUse = withProxy || proxy;
      const thisProxy = false ? new Proxy(proxyToUse, {
        get(target, key, receiver) {
          warn$1(
            `Property '${String(
              key
            )}' was accessed via 'this'. Avoid using 'this' in templates.`
          );
          return Reflect.get(target, key, receiver);
        }
      }) : proxyToUse;
      result = normalizeVNode(
        render.call(
          thisProxy,
          proxyToUse,
          renderCache,
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          setupState,
          data,
          ctx
        )
      );
      fallthroughAttrs = attrs;
    } else {
      const render2 = Component;
      if (false) ;
      result = normalizeVNode(
        render2.length > 1 ? render2(
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          false ? {
            get attrs() {
              markAttrsAccessed();
              return /* @__PURE__ */ shallowReadonly(attrs);
            },
            slots,
            emit: emit2
          } : { attrs, slots, emit: emit2 }
        ) : render2(
          false ? /* @__PURE__ */ shallowReadonly(props) : props,
          null
        )
      );
      fallthroughAttrs = Component.props ? attrs : getFunctionalFallthrough(attrs);
    }
  } catch (err) {
    blockStack.length = 0;
    handleError(err, instance, 1);
    result = createVNode(Comment);
  }
  let root = result;
  if (fallthroughAttrs && inheritAttrs !== false) {
    const keys = Object.keys(fallthroughAttrs);
    const { shapeFlag } = root;
    if (keys.length) {
      if (shapeFlag & (1 | 6)) {
        if (propsOptions && keys.some(isModelListener)) {
          fallthroughAttrs = filterModelListeners(
            fallthroughAttrs,
            propsOptions
          );
        }
        root = cloneVNode(root, fallthroughAttrs, false, true);
      }
    }
  }
  if (vnode.dirs) {
    root = cloneVNode(root, null, false, true);
    root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs;
  }
  if (vnode.transition) {
    const child = isTeleport(root.type) ? getInnerChild$1(root) || root : root;
    setTransitionHooks(child, vnode.transition);
  }
  {
    result = root;
  }
  setCurrentRenderingInstance(prev);
  return result;
}
function filterSingleRoot(children, recurse = true) {
  let singleRoot;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isVNode(child)) {
      if (child.type !== Comment || child.children === "v-if") {
        if (singleRoot) {
          return;
        } else {
          singleRoot = child;
        }
      }
    } else {
      return;
    }
  }
  return singleRoot;
}
const getFunctionalFallthrough = (attrs) => {
  let res;
  for (const key in attrs) {
    if (key === "class" || key === "style" || isOn(key)) {
      (res || (res = {}))[key] = attrs[key];
    }
  }
  return res;
};
const filterModelListeners = (attrs, props) => {
  const res = {};
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key];
    }
  }
  return res;
};
function shouldUpdateComponent(prevVNode, nextVNode, optimized) {
  const { props: prevProps, children: prevChildren, component } = prevVNode;
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode;
  const emits = component.emitsOptions;
  if (nextVNode.dirs || nextVNode.transition) {
    return true;
  }
  if (optimized && patchFlag >= 0) {
    if (patchFlag & 1024) {
      return true;
    }
    if (patchFlag & 16) {
      if (!prevProps) {
        return !!nextProps;
      }
      return hasPropsChanged(prevProps, nextProps, emits);
    } else if (patchFlag & 8) {
      const dynamicProps = nextVNode.dynamicProps;
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i];
        if (hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emits, key)) {
          return true;
        }
      }
    }
  } else {
    if (prevChildren || nextChildren) {
      if (!nextChildren || !nextChildren.$stable) {
        return true;
      }
    }
    if (prevProps === nextProps) {
      return false;
    }
    if (!prevProps) {
      return !!nextProps;
    }
    if (!nextProps) {
      return true;
    }
    return hasPropsChanged(prevProps, nextProps, emits);
  }
  return false;
}
function hasPropsChanged(prevProps, nextProps, emitsOptions) {
  const nextKeys = Object.keys(nextProps);
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true;
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i];
    if (!hasOwn(prevProps, key) || hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emitsOptions, key)) {
      return true;
    }
  }
  return false;
}
function hasPropValueChanged(nextProps, prevProps, key) {
  const nextProp = nextProps[key];
  const prevProp = prevProps[key];
  if (key === "style" && isObject(nextProp) && isObject(prevProp)) {
    return !looseEqual(nextProp, prevProp);
  }
  return nextProp !== prevProp;
}
function updateHOCHostEl({ vnode, parent, suspense }, el) {
  while (parent) {
    const root = parent.subTree;
    if (root.suspense && root.suspense.activeBranch === vnode) {
      root.suspense.vnode.el = root.el = el;
      vnode = root;
    }
    if (root === vnode) {
      (vnode = parent.vnode).el = el;
      parent = parent.parent;
    } else {
      break;
    }
  }
  if (suspense && suspense.activeBranch === vnode) {
    suspense.vnode.el = el;
  }
}
const internalObjectProto = {};
const createInternalObject = () => Object.create(internalObjectProto);
const isInternalObject = (obj) => Object.getPrototypeOf(obj) === internalObjectProto;
function initProps(instance, rawProps, isStateful, isSSR = false) {
  const props = {};
  const attrs = createInternalObject();
  instance.propsDefaults = /* @__PURE__ */ Object.create(null);
  setFullProps(instance, rawProps, props, attrs);
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = void 0;
    }
  }
  if (isStateful) {
    instance.props = isSSR ? props : /* @__PURE__ */ shallowReactive(props);
  } else {
    if (!instance.type.props) {
      instance.props = attrs;
    } else {
      instance.props = props;
    }
  }
  instance.attrs = attrs;
}
function updateProps(instance, rawProps, rawPrevProps, optimized) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance;
  const rawCurrentProps = /* @__PURE__ */ toRaw(props);
  const [options] = instance.propsOptions;
  let hasAttrsChanged = false;
  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    (optimized || patchFlag > 0) && !(patchFlag & 16)
  ) {
    if (patchFlag & 8) {
      const propsToUpdate = instance.vnode.dynamicProps;
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i];
        if (isEmitListener(instance.emitsOptions, key)) {
          continue;
        }
        const value = rawProps[key];
        if (options) {
          if (hasOwn(attrs, key)) {
            if (value !== attrs[key]) {
              attrs[key] = value;
              hasAttrsChanged = true;
            }
          } else {
            const camelizedKey = camelize(key);
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false
            );
          }
        } else {
          if (value !== attrs[key]) {
            attrs[key] = value;
            hasAttrsChanged = true;
          }
        }
      }
    }
  } else {
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true;
    }
    let kebabKey;
    for (const key in rawCurrentProps) {
      if (!rawProps || // for camelCase
      !hasOwn(rawProps, key) && // it's possible the original props was passed in as kebab-case
      // and converted to camelCase (#955)
      ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey))) {
        if (options) {
          if (rawPrevProps && // for camelCase
          (rawPrevProps[key] !== void 0 || // for kebab-case
          rawPrevProps[kebabKey] !== void 0)) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              void 0,
              instance,
              true
            );
          }
        } else {
          delete props[key];
        }
      }
    }
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key) && true) {
          delete attrs[key];
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (hasAttrsChanged) {
    trigger(instance.attrs, "set", "");
  }
}
function setFullProps(instance, rawProps, props, attrs) {
  const [options, needCastKeys] = instance.propsOptions;
  let hasAttrsChanged = false;
  let rawCastValues;
  if (rawProps) {
    for (let key in rawProps) {
      if (isReservedProp(key)) {
        continue;
      }
      const value = rawProps[key];
      let camelKey;
      if (options && hasOwn(options, camelKey = camelize(key))) {
        if (!needCastKeys || !needCastKeys.includes(camelKey)) {
          props[camelKey] = value;
        } else {
          (rawCastValues || (rawCastValues = {}))[camelKey] = value;
        }
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        if (!(key in attrs) || value !== attrs[key]) {
          attrs[key] = value;
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (needCastKeys) {
    const rawCurrentProps = /* @__PURE__ */ toRaw(props);
    const castValues = rawCastValues || EMPTY_OBJ;
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i];
      props[key] = resolvePropValue(
        options,
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      );
    }
  }
  return hasAttrsChanged;
}
function resolvePropValue(options, props, key, value, instance, isAbsent) {
  const opt = options[key];
  if (opt != null) {
    const hasDefault = hasOwn(opt, "default");
    if (hasDefault && value === void 0) {
      const defaultValue = opt.default;
      if (opt.type !== Function && !opt.skipFactory && isFunction(defaultValue)) {
        const { propsDefaults } = instance;
        if (key in propsDefaults) {
          value = propsDefaults[key];
        } else {
          const reset = setCurrentInstance(instance);
          value = propsDefaults[key] = defaultValue.call(
            null,
            props
          );
          reset();
        }
      } else {
        value = defaultValue;
      }
      if (instance.ce) {
        instance.ce._setProp(key, value);
      }
    }
    if (opt[
      0
      /* shouldCast */
    ]) {
      if (isAbsent && !hasDefault) {
        value = false;
      } else if (opt[
        1
        /* shouldCastTrue */
      ] && (value === "" || value === hyphenate(key))) {
        value = true;
      }
    }
  }
  return value;
}
const mixinPropsCache = /* @__PURE__ */ new WeakMap();
function normalizePropsOptions(comp, appContext, asMixin = false) {
  const cache = asMixin ? mixinPropsCache : appContext.propsCache;
  const cached = cache.get(comp);
  if (cached) {
    return cached;
  }
  const raw = comp.props;
  const normalized = {};
  const needCastKeys = [];
  let hasExtends = false;
  if (!isFunction(comp)) {
    const extendProps = (raw2) => {
      hasExtends = true;
      const [props, keys] = normalizePropsOptions(raw2, appContext, true);
      extend(normalized, props);
      if (keys) needCastKeys.push(...keys);
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps);
    }
    if (comp.extends) {
      extendProps(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, EMPTY_ARR);
    }
    return EMPTY_ARR;
  }
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const normalizedKey = camelize(raw[i]);
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ;
      }
    }
  } else if (raw) {
    for (const key in raw) {
      const normalizedKey = camelize(key);
      if (validatePropName(normalizedKey)) {
        const opt = raw[key];
        const prop = normalized[normalizedKey] = isArray(opt) || isFunction(opt) ? { type: opt } : extend({}, opt);
        const propType = prop.type;
        let shouldCast = false;
        let shouldCastTrue = true;
        if (isArray(propType)) {
          for (let index = 0; index < propType.length; ++index) {
            const type = propType[index];
            const typeName = isFunction(type) && type.name;
            if (typeName === "Boolean") {
              shouldCast = true;
              break;
            } else if (typeName === "String") {
              shouldCastTrue = false;
            }
          }
        } else {
          shouldCast = isFunction(propType) && propType.name === "Boolean";
        }
        prop[
          0
          /* shouldCast */
        ] = shouldCast;
        prop[
          1
          /* shouldCastTrue */
        ] = shouldCastTrue;
        if (shouldCast || hasOwn(prop, "default")) {
          needCastKeys.push(normalizedKey);
        }
      }
    }
  }
  const res = [normalized, needCastKeys];
  if (isObject(comp)) {
    cache.set(comp, res);
  }
  return res;
}
function validatePropName(key) {
  if (key[0] !== "$" && !isReservedProp(key)) {
    return true;
  }
  return false;
}
const isInternalKey = (key) => key === "_" || key === "_ctx" || key === "$stable";
const normalizeSlotValue = (value) => isArray(value) ? value.map(normalizeVNode) : [normalizeVNode(value)];
const normalizeSlot = (key, rawSlot, ctx) => {
  if (rawSlot._n) {
    return rawSlot;
  }
  const normalized = withCtx((...args) => {
    if (false) ;
    return normalizeSlotValue(rawSlot(...args));
  }, ctx);
  normalized._c = false;
  return normalized;
};
const normalizeObjectSlots = (rawSlots, slots, instance) => {
  const ctx = rawSlots._ctx;
  for (const key in rawSlots) {
    if (isInternalKey(key)) continue;
    const value = rawSlots[key];
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx);
    } else if (value != null) {
      const normalized = normalizeSlotValue(value);
      slots[key] = () => normalized;
    }
  }
};
const normalizeVNodeSlots = (instance, children) => {
  const normalized = normalizeSlotValue(children);
  instance.slots.default = () => normalized;
};
const assignSlots = (slots, children, optimized) => {
  for (const key in children) {
    if (optimized || !isInternalKey(key)) {
      slots[key] = children[key];
    }
  }
};
const initSlots = (instance, children, optimized) => {
  const slots = instance.slots = createInternalObject();
  if (instance.vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      assignSlots(slots, children, optimized);
      if (optimized) {
        def(slots, "_", type, true);
      }
    } else {
      normalizeObjectSlots(children, slots);
    }
  } else if (children) {
    normalizeVNodeSlots(instance, children);
  }
};
const updateSlots = (instance, children, optimized) => {
  const { vnode, slots } = instance;
  let needDeletionCheck = true;
  let deletionComparisonTarget = EMPTY_OBJ;
  if (vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      if (optimized && type === 1) {
        needDeletionCheck = false;
      } else {
        assignSlots(slots, children, optimized);
      }
    } else {
      needDeletionCheck = !children.$stable;
      normalizeObjectSlots(children, slots);
    }
    deletionComparisonTarget = children;
  } else if (children) {
    normalizeVNodeSlots(instance, children);
    deletionComparisonTarget = { default: 1 };
  }
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && deletionComparisonTarget[key] == null) {
        delete slots[key];
      }
    }
  }
};
const queuePostRenderEffect = queueEffectWithSuspense;
function createRenderer(options) {
  return baseCreateRenderer(options);
}
function baseCreateRenderer(options, createHydrationFns) {
  const target = getGlobalThis();
  target.__VUE__ = true;
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    insertStaticContent: hostInsertStaticContent
  } = options;
  const patch = (n1, n2, container, anchor = null, parentComponent = null, parentSuspense = null, namespace = void 0, slotScopeIds = null, optimized = !!n2.dynamicChildren) => {
    if (n1 === n2) {
      return;
    }
    if (n1 && !isSameVNodeType(n1, n2)) {
      anchor = getNextHostNode(n1);
      unmount(n1, parentComponent, parentSuspense, true);
      n1 = null;
    }
    if (n2.patchFlag === -2) {
      optimized = false;
      n2.dynamicChildren = null;
    }
    if (n2.dynamicChildren && n1 && n1.dynamicChildren && n1.dynamicChildren.hasOnce) {
      if (n2.dynamicChildren === EMPTY_ARR) {
        n2.dynamicChildren = [];
      }
      n2.dynamicChildren.hasOnce = true;
    }
    const { type, ref: ref3, shapeFlag } = n2;
    switch (type) {
      case Text:
        processText(n1, n2, container, anchor);
        break;
      case Comment:
        processCommentNode(n1, n2, container, anchor);
        break;
      case Static:
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, namespace);
        }
        break;
      case Fragment:
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        break;
      default:
        if (shapeFlag & 1) {
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 6) {
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 64) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else if (shapeFlag & 128) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else ;
    }
    if (ref3 != null && parentComponent) {
      setRef(ref3, n1 && n1.ref, parentSuspense, n2 || n1, !n2);
    } else if (ref3 == null && n1 && n1.ref != null) {
      setRef(n1.ref, null, parentSuspense, n1, true);
    }
  };
  const processText = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateText(n2.children),
        container,
        anchor
      );
    } else {
      const el = n2.el = n1.el;
      if (n2.children !== n1.children) {
        hostSetText(el, n2.children);
      }
    }
  };
  const processCommentNode = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateComment(n2.children || ""),
        container,
        anchor
      );
    } else {
      n2.el = n1.el;
    }
  };
  const mountStaticNode = (n2, container, anchor, namespace) => {
    [n2.el, n2.anchor] = hostInsertStaticContent(
      n2.children,
      container,
      anchor,
      namespace,
      n2.el,
      n2.anchor
    );
  };
  const moveStaticNode = ({ el, anchor }, container, nextSibling) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostInsert(el, container, nextSibling);
      el = next;
    }
    hostInsert(anchor, container, nextSibling);
  };
  const removeStaticNode = ({ el, anchor }) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostRemove(el);
      el = next;
    }
    hostRemove(anchor);
  };
  const processElement = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    if (n2.type === "svg") {
      namespace = "svg";
    } else if (n2.type === "math") {
      namespace = "mathml";
    }
    if (n1 == null) {
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      const customElement = n1.el && n1.el._isVueCE ? n1.el : null;
      try {
        if (customElement) {
          customElement._beginPatch();
        }
        patchElement(
          n1,
          n2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } finally {
        if (customElement) {
          customElement._endPatch();
        }
      }
    }
  };
  const mountElement = (vnode, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let el;
    let vnodeHook;
    const { props, shapeFlag, transition, dirs } = vnode;
    el = vnode.el = hostCreateElement(
      vnode.type,
      namespace,
      props && props.is,
      props
    );
    if (shapeFlag & 8) {
      hostSetElementText(el, vnode.children);
    } else if (shapeFlag & 16) {
      mountChildren(
        vnode.children,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(vnode, namespace),
        slotScopeIds,
        optimized
      );
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "created");
    }
    setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent);
    if (props) {
      for (const key in props) {
        if (key !== "value" && !isReservedProp(key)) {
          hostPatchProp(el, key, null, props[key], namespace, parentComponent);
        }
      }
      if ("value" in props) {
        hostPatchProp(el, "value", null, props.value, namespace);
      }
      if (vnodeHook = props.onVnodeBeforeMount) {
        invokeVNodeHook(vnodeHook, parentComponent, vnode);
      }
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "beforeMount");
    }
    const needCallTransitionHooks = needTransition(parentSuspense, transition);
    if (needCallTransitionHooks) {
      transition.beforeEnter(el);
    }
    hostInsert(el, container, anchor);
    if ((vnodeHook = props && props.onVnodeMounted) || needCallTransitionHooks || dirs) {
      queuePostRenderEffect(() => {
        try {
          vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
          needCallTransitionHooks && transition.enter(el);
          dirs && invokeDirectiveHook(vnode, null, parentComponent, "mounted");
        } finally {
        }
      }, parentSuspense);
    }
  };
  const setScopeId = (el, vnode, scopeId, slotScopeIds, parentComponent) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId);
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i]);
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree;
      if (vnode === subTree || isSuspense(subTree.type) && (subTree.ssContent === vnode || subTree.ssFallback === vnode)) {
        const parentVNode = parentComponent.vnode;
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent
        );
      }
    }
  };
  const mountChildren = (children, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized, start = 0) => {
    for (let i = start; i < children.length; i++) {
      const child = children[i] = optimized ? cloneIfMounted(children[i]) : normalizeVNode(children[i]);
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
  };
  const patchElement = (n1, n2, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const el = n2.el = n1.el;
    let { patchFlag, dynamicChildren, dirs } = n2;
    patchFlag |= n1.patchFlag & 16;
    const oldProps = n1.props || EMPTY_OBJ;
    const newProps = n2.props || EMPTY_OBJ;
    let vnodeHook;
    parentComponent && toggleRecurse(parentComponent, false);
    if (vnodeHook = newProps.onVnodeBeforeUpdate) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
    }
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, "beforeUpdate");
    }
    parentComponent && toggleRecurse(parentComponent, true);
    if (
      // #6385 the old vnode may be a user-wrapped non-isomorphic block
      // Force full diff when block metadata is unstable.
      dynamicChildren && (!n1.dynamicChildren || n1.dynamicChildren.length !== dynamicChildren.length)
    ) {
      patchFlag = 0;
      optimized = false;
      dynamicChildren = null;
    }
    if (oldProps.innerHTML && newProps.innerHTML == null || oldProps.textContent && newProps.textContent == null) {
      hostSetElementText(el, "");
    }
    if (dynamicChildren) {
      patchBlockChildren(
        n1.dynamicChildren,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds
      );
    } else if (!optimized) {
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
        false
      );
    }
    if (patchFlag > 0) {
      if (patchFlag & 16) {
        patchProps(el, oldProps, newProps, parentComponent, namespace);
      } else {
        if (patchFlag & 2) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, "class", null, newProps.class, namespace);
          }
        }
        if (patchFlag & 4) {
          hostPatchProp(el, "style", oldProps.style, newProps.style, namespace);
        }
        if (patchFlag & 8) {
          const propsToUpdate = n2.dynamicProps;
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i];
            const prev = oldProps[key];
            const next = newProps[key];
            if (next !== prev || key === "value") {
              hostPatchProp(el, key, prev, next, namespace, parentComponent);
            }
          }
        }
      }
      if (patchFlag & 1) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children);
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      patchProps(el, oldProps, newProps, parentComponent, namespace);
    }
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
        dirs && invokeDirectiveHook(n2, n1, parentComponent, "updated");
      }, parentSuspense);
    }
  };
  const patchBlockChildren = (oldChildren, newChildren, fallbackContainer, parentComponent, parentSuspense, namespace, slotScopeIds) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i];
      const newVNode = newChildren[i];
      const oldEl = oldVNode.el || resolveAsyncComponentPlaceholder(oldVNode);
      const container = (
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldEl && // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        (oldVNode.type === Fragment || // - In the case of different nodes, there is going to be a replacement
        // which also requires the correct parent container
        !isSameVNodeType(oldVNode, newVNode) || // - In the case of a component, it could contain anything.
        oldVNode.shapeFlag & (6 | 64 | 128)) ? hostParentNode(oldEl) : (
          // In other cases, the parent container is not actually used so we
          // just pass the block element here to avoid a DOM parentNode call.
          fallbackContainer
        )
      );
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        true
      );
    }
  };
  const patchProps = (el, oldProps, newProps, parentComponent, namespace) => {
    if (oldProps !== newProps) {
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              namespace,
              parentComponent
            );
          }
        }
      }
      for (const key in newProps) {
        if (isReservedProp(key)) continue;
        const next = newProps[key];
        const prev = oldProps[key];
        if (next !== prev && key !== "value") {
          hostPatchProp(el, key, prev, next, namespace, parentComponent);
        }
      }
      if ("value" in newProps) {
        hostPatchProp(el, "value", oldProps.value, newProps.value, namespace);
      }
    }
  };
  const processFragment = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const fragmentStartAnchor = n2.el = n1 ? n1.el : hostCreateText("");
    const fragmentEndAnchor = n2.anchor = n1 ? n1.anchor : hostCreateText("");
    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2;
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds ? slotScopeIds.concat(fragmentSlotScopeIds) : fragmentSlotScopeIds;
    }
    if (n1 == null) {
      hostInsert(fragmentStartAnchor, container, anchor);
      hostInsert(fragmentEndAnchor, container, anchor);
      mountChildren(
        // #10007
        // such fragment like `<></>` will be compiled into
        // a fragment which doesn't have a children.
        // In this case fallback to an empty array
        n2.children || [],
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      if (patchFlag > 0 && patchFlag & 64 && dynamicChildren && // #2715 the previous fragment could've been a BAILed one as a result
      // of renderSlot() with no valid children
      n1.dynamicChildren && n1.dynamicChildren.length === dynamicChildren.length) {
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds
        );
        if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null || parentComponent && n2 === parentComponent.subTree
        ) {
          traverseStaticChildren(
            n1,
            n2,
            true
            /* shallow */
          );
        }
      } else {
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      }
    }
  };
  const processComponent = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    n2.slotScopeIds = slotScopeIds;
    if (n1 == null) {
      if (n2.shapeFlag & 512) {
        parentComponent.ctx.activate(
          n2,
          container,
          anchor,
          namespace,
          optimized
        );
      } else {
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          optimized
        );
      }
    } else {
      updateComponent(n1, n2, optimized);
    }
  };
  const mountComponent = (initialVNode, container, anchor, parentComponent, parentSuspense, namespace, optimized) => {
    const instance = initialVNode.component = createComponentInstance(
      initialVNode,
      parentComponent,
      parentSuspense
    );
    if (isKeepAlive(initialVNode)) {
      instance.ctx.renderer = internals;
    }
    {
      setupComponent(instance, false, optimized);
    }
    if (instance.asyncDep) {
      parentSuspense && parentSuspense.registerDep(
        instance,
        setupRenderEffect,
        optimized,
        namespace
      );
      if (!initialVNode.el) {
        const placeholder = instance.subTree = createVNode(Comment);
        processCommentNode(null, placeholder, container, anchor);
        initialVNode.placeholder = placeholder.el;
      }
    } else {
      setupRenderEffect(
        instance,
        initialVNode,
        container,
        anchor,
        parentSuspense,
        namespace,
        optimized
      );
    }
  };
  const updateComponent = (n1, n2, optimized) => {
    const instance = n2.component = n1.component;
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (instance.asyncDep && !instance.asyncResolved) {
        n2.el = n1.el;
        n2.placeholder = n1.placeholder;
        updateComponentPreRender(instance, n2, optimized);
        return;
      } else {
        instance.next = n2;
        instance.update();
      }
    } else {
      n2.el = n1.el;
      n2.placeholder = n1.placeholder;
      instance.vnode = n2;
    }
  };
  const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, namespace, optimized) => {
    const componentUpdateFn = () => {
      if (!instance.isMounted) {
        let vnodeHook;
        const { el, props } = initialVNode;
        const { bm, m, parent, root, type } = instance;
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode);
        toggleRecurse(instance, false);
        if (bm) {
          invokeArrayFns(bm);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parent, initialVNode);
        }
        toggleRecurse(instance, true);
        {
          if (root.ce && root.ce._hasShadowRoot()) {
            root.ce._injectChildStyle(
              type,
              instance.parent ? instance.parent.type : void 0
            );
          }
          const subTree = instance.subTree = renderComponentRoot(instance);
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            namespace
          );
          initialVNode.el = subTree.el;
        }
        if (m) {
          queuePostRenderEffect(m, parentSuspense);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeMounted)) {
          const scopedInitialVNode = initialVNode;
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, scopedInitialVNode),
            parentSuspense
          );
        }
        if (initialVNode.shapeFlag & 256 || parent && isAsyncWrapper(parent.vnode) && parent.vnode.shapeFlag & 256) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense);
        }
        instance.isMounted = true;
        initialVNode = container = anchor = null;
      } else {
        let { next, bu, u, parent, vnode } = instance;
        {
          const nonHydratedAsyncRoot = locateNonHydratedAsyncRoot(instance);
          if (nonHydratedAsyncRoot) {
            if (next) {
              next.el = vnode.el;
              updateComponentPreRender(instance, next, optimized);
            }
            nonHydratedAsyncRoot.asyncDep.then(() => {
              queuePostRenderEffect(() => {
                if (!instance.isUnmounted) update();
              }, parentSuspense);
            });
            return;
          }
        }
        let originNext = next;
        let vnodeHook;
        toggleRecurse(instance, false);
        if (next) {
          next.el = vnode.el;
          updateComponentPreRender(instance, next, optimized);
        } else {
          next = vnode;
        }
        if (bu) {
          invokeArrayFns(bu);
        }
        if (vnodeHook = next.props && next.props.onVnodeBeforeUpdate) {
          invokeVNodeHook(vnodeHook, parent, next, vnode);
        }
        toggleRecurse(instance, true);
        const nextTree = renderComponentRoot(instance);
        const prevTree = instance.subTree;
        instance.subTree = nextTree;
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          hostParentNode(prevTree.el),
          // anchor may have changed if it's in a fragment
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          namespace
        );
        next.el = nextTree.el;
        if (originNext === null) {
          updateHOCHostEl(instance, nextTree.el);
        }
        if (u) {
          queuePostRenderEffect(u, parentSuspense);
        }
        if (vnodeHook = next.props && next.props.onVnodeUpdated) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, next, vnode),
            parentSuspense
          );
        }
      }
    };
    instance.scope.on();
    const effect2 = instance.effect = new ReactiveEffect(componentUpdateFn);
    instance.scope.off();
    const update = instance.update = effect2.run.bind(effect2);
    const job = instance.job = effect2.runIfDirty.bind(effect2);
    job.i = instance;
    job.id = instance.uid;
    effect2.scheduler = () => queueJob(job);
    toggleRecurse(instance, true);
    update();
  };
  const updateComponentPreRender = (instance, nextVNode, optimized) => {
    nextVNode.component = instance;
    const prevProps = instance.vnode.props;
    instance.vnode = nextVNode;
    instance.next = null;
    updateProps(instance, nextVNode.props, prevProps, optimized);
    updateSlots(instance, nextVNode.children, optimized);
    pauseTracking();
    flushPreFlushCbs(instance);
    resetTracking();
  };
  const patchChildren = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized = false) => {
    const c1 = n1 && n1.children;
    const prevShapeFlag = n1 ? n1.shapeFlag : 0;
    const c2 = n2.children;
    const { patchFlag, shapeFlag } = n2;
    if (patchFlag > 0) {
      if (patchFlag & 128) {
        patchKeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      } else if (patchFlag & 256) {
        patchUnkeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      }
    }
    if (shapeFlag & 8) {
      if (prevShapeFlag & 16) {
        unmountChildren(c1, parentComponent, parentSuspense);
      }
      if (c2 !== c1) {
        hostSetElementText(container, c2);
      }
    } else {
      if (prevShapeFlag & 16) {
        if (shapeFlag & 16) {
          patchKeyedChildren(
            c1,
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else {
          unmountChildren(c1, parentComponent, parentSuspense, true);
        }
      } else {
        if (prevShapeFlag & 8) {
          hostSetElementText(container, "");
        }
        if (shapeFlag & 16) {
          mountChildren(
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        }
      }
    }
  };
  const patchUnkeyedChildren = (c1, c2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    c1 = c1 || EMPTY_ARR;
    c2 = c2 || EMPTY_ARR;
    const oldLength = c1.length;
    const newLength = c2.length;
    const commonLength = Math.min(oldLength, newLength);
    let i;
    for (i = 0; i < commonLength; i++) {
      const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
    if (oldLength > newLength) {
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength
      );
    } else {
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        commonLength
      );
    }
  };
  const patchKeyedChildren = (c1, c2, container, parentAnchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let i = 0;
    const l2 = c2.length;
    let e1 = c1.length - 1;
    let e2 = l2 - 1;
    while (i <= e1 && i <= e2) {
      const n1 = c1[i];
      const n2 = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      i++;
    }
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1];
      const n2 = c2[e2] = optimized ? cloneIfMounted(c2[e2]) : normalizeVNode(c2[e2]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      e1--;
      e2--;
    }
    if (i > e1) {
      if (i <= e2) {
        const nextPos = e2 + 1;
        const anchor = nextPos < l2 ? c2[nextPos].el : parentAnchor;
        while (i <= e2) {
          patch(
            null,
            c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          i++;
        }
      }
    } else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true);
        i++;
      }
    } else {
      const s1 = i;
      const s2 = i;
      const keyToNewIndexMap = /* @__PURE__ */ new Map();
      for (i = s2; i <= e2; i++) {
        const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
        if (nextChild.key != null) {
          keyToNewIndexMap.set(nextChild.key, i);
        }
      }
      let j;
      let patched = 0;
      const toBePatched = e2 - s2 + 1;
      let moved = false;
      let maxNewIndexSoFar = 0;
      const newIndexToOldIndexMap = new Array(toBePatched);
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0;
      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i];
        if (patched >= toBePatched) {
          unmount(prevChild, parentComponent, parentSuspense, true);
          continue;
        }
        let newIndex;
        if (prevChild.key != null) {
          newIndex = keyToNewIndexMap.get(prevChild.key);
        } else {
          for (j = s2; j <= e2; j++) {
            if (newIndexToOldIndexMap[j - s2] === 0 && isSameVNodeType(prevChild, c2[j])) {
              newIndex = j;
              break;
            }
          }
        }
        if (newIndex === void 0) {
          unmount(prevChild, parentComponent, parentSuspense, true);
        } else {
          newIndexToOldIndexMap[newIndex - s2] = i + 1;
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex;
          } else {
            moved = true;
          }
          patch(
            prevChild,
            c2[newIndex],
            container,
            null,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          patched++;
        }
      }
      const increasingNewIndexSequence = moved ? getSequence(newIndexToOldIndexMap) : EMPTY_ARR;
      j = increasingNewIndexSequence.length - 1;
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i;
        const nextChild = c2[nextIndex];
        const anchorVNode = c2[nextIndex + 1];
        const anchor = nextIndex + 1 < l2 ? (
          // #13559, #14173 fallback to el placeholder for unresolved async component
          anchorVNode.el || resolveAsyncComponentPlaceholder(anchorVNode)
        ) : parentAnchor;
        if (newIndexToOldIndexMap[i] === 0) {
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (moved) {
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            move(nextChild, container, anchor, 2);
          } else {
            j--;
          }
        }
      }
    }
  };
  const move = (vnode, container, anchor, moveType, parentSuspense = null) => {
    const { el, type, transition, children, shapeFlag } = vnode;
    if (shapeFlag & 6) {
      move(vnode.component.subTree, container, anchor, moveType);
      return;
    }
    if (shapeFlag & 128) {
      vnode.suspense.move(container, anchor, moveType);
      return;
    }
    if (shapeFlag & 64) {
      type.move(vnode, container, anchor, internals);
      return;
    }
    if (type === Fragment) {
      hostInsert(el, container, anchor);
      for (let i = 0; i < children.length; i++) {
        move(children[i], container, anchor, moveType);
      }
      hostInsert(vnode.anchor, container, anchor);
      return;
    }
    if (type === Static) {
      moveStaticNode(vnode, container, anchor);
      return;
    }
    const needTransition2 = moveType !== 2 && shapeFlag & 1 && transition;
    if (needTransition2) {
      if (moveType === 0) {
        if (transition.persisted && !el[leaveCbKey]) {
          hostInsert(el, container, anchor);
        } else {
          transition.beforeEnter(el);
          hostInsert(el, container, anchor);
          queuePostRenderEffect(() => transition.enter(el), parentSuspense);
        }
      } else {
        const { leave, delayLeave, afterLeave } = transition;
        const remove22 = () => {
          if (vnode.ctx.isUnmounted) {
            hostRemove(el);
          } else {
            hostInsert(el, container, anchor);
          }
        };
        const performLeave = () => {
          const wasLeaving = el._isLeaving || !!el[leaveCbKey];
          if (el._isLeaving) {
            el[leaveCbKey](
              true
              /* cancelled */
            );
          }
          if (transition.persisted && !wasLeaving) {
            remove22();
          } else {
            leave(el, () => {
              remove22();
              afterLeave && afterLeave();
            });
          }
        };
        if (delayLeave) {
          delayLeave(el, remove22, performLeave);
        } else {
          performLeave();
        }
      }
    } else {
      hostInsert(el, container, anchor);
    }
  };
  const unmount = (vnode, parentComponent, parentSuspense, doRemove = false, optimized = false) => {
    const {
      type,
      props,
      ref: ref3,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs,
      cacheIndex,
      memo
    } = vnode;
    if (patchFlag === -2 || dynamicChildren && dynamicChildren.hasOnce) {
      optimized = false;
    }
    if (ref3 != null) {
      pauseTracking();
      setRef(ref3, null, parentSuspense, vnode, true);
      resetTracking();
    }
    if (cacheIndex != null && (!vnode.ctx || vnode.ctx === parentComponent)) {
      parentComponent.renderCache[cacheIndex] = void 0;
    }
    if (shapeFlag & 256) {
      parentComponent.ctx.deactivate(vnode);
      return;
    }
    const shouldInvokeDirs = shapeFlag & 1 && dirs;
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode);
    let vnodeHook;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeBeforeUnmount)) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode);
    }
    if (shapeFlag & 6) {
      unmountComponent(vnode.component, parentSuspense, doRemove);
    } else {
      if (shapeFlag & 128) {
        vnode.suspense.unmount(parentSuspense, doRemove);
        return;
      }
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, "beforeUnmount");
      }
      if (shapeFlag & 64) {
        vnode.type.remove(
          vnode,
          parentComponent,
          parentSuspense,
          internals,
          doRemove
        );
      } else if (dynamicChildren && // #5154
      // when v-once is used inside a block, setBlockTracking(-1) marks the
      // parent block with hasOnce: true
      // so that it doesn't take the fast path during unmount - otherwise
      // components nested in v-once are never unmounted.
      !dynamicChildren.hasOnce && // #1153: fast path should not be taken for non-stable (v-for) fragments
      (type !== Fragment || patchFlag > 0 && patchFlag & 64)) {
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true
        );
      } else if (type === Fragment && patchFlag & (128 | 256) || !optimized && shapeFlag & 16) {
        unmountChildren(children, parentComponent, parentSuspense);
      }
      if (doRemove) {
        remove2(vnode);
      }
    }
    const shouldInvalidateMemo = memo != null && cacheIndex == null;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs || shouldInvalidateMemo) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
        shouldInvokeDirs && invokeDirectiveHook(vnode, null, parentComponent, "unmounted");
        if (shouldInvalidateMemo) {
          vnode.el = null;
        }
      }, parentSuspense);
    }
  };
  const remove2 = (vnode) => {
    const { type, el, anchor, transition } = vnode;
    const isFragment = type === Fragment;
    if (isFragment && !transition) {
      removeFragment(el, anchor);
      return;
    }
    if (type === Static) {
      removeStaticNode(vnode);
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave();
      }
      return;
    }
    const leavingNode = isFragment ? getTransitionRoot(vnode) : vnode;
    const performRemove = () => {
      if (isFragment) {
        if (hostParentNode(el)) {
          removeFragment(el, anchor);
        }
      } else {
        hostRemove(el);
      }
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave();
      }
    };
    if (leavingNode && leavingNode.shapeFlag & 1 && transition && !transition.persisted) {
      const { leave, delayLeave } = transition;
      const leavingEl = leavingNode.el;
      const performLeave = () => leave(leavingEl, performRemove);
      if (delayLeave) {
        delayLeave(leavingEl, performRemove, performLeave);
      } else {
        performLeave();
      }
    } else {
      performRemove();
    }
  };
  const removeFragment = (cur, end) => {
    let next;
    while (cur !== end) {
      next = hostNextSibling(cur);
      hostRemove(cur);
      cur = next;
    }
    hostRemove(end);
  };
  const unmountComponent = (instance, parentSuspense, doRemove) => {
    const { bum, scope, job, subTree, um, m, a } = instance;
    invalidateMount(m);
    invalidateMount(a);
    if (bum) {
      invokeArrayFns(bum);
    }
    scope.stop();
    if (job) {
      job.flags |= 8;
      unmount(subTree, instance, parentSuspense, doRemove);
    } else if (instance.vnode.el && subTree) {
      subTree.transition = instance.vnode.transition;
      unmount(subTree, instance, parentSuspense, doRemove);
    }
    if (um) {
      queuePostRenderEffect(um, parentSuspense);
    }
    queuePostRenderEffect(() => {
      instance.isUnmounted = true;
    }, parentSuspense);
  };
  const unmountChildren = (children, parentComponent, parentSuspense, doRemove = false, optimized = false, start = 0) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized);
    }
  };
  const getNextHostNode = (vnode) => {
    if (vnode.shapeFlag & 6) {
      return getNextHostNode(vnode.component.subTree);
    }
    if (vnode.shapeFlag & 128) {
      return vnode.suspense.next();
    }
    const el = hostNextSibling(vnode.anchor || vnode.el);
    const teleportEnd = el && el[TeleportEndKey];
    return teleportEnd ? hostNextSibling(teleportEnd) : el;
  };
  const render = (vnode, container, namespace) => {
    const minUid = vnode && container._vnode ? void 0 : vnode && vnode.component ? vnode.component.uid : getNextUid();
    flushOnAppMount(() => {
      if (vnode == null) {
        if (container._vnode) {
          unmount(container._vnode, null, null, true);
        }
      } else {
        patch(
          container._vnode || null,
          vnode,
          container,
          null,
          null,
          null,
          namespace
        );
      }
      container._vnode = vnode;
    }, minUid);
  };
  const internals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove2,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  };
  let hydrate;
  return {
    render,
    hydrate,
    createApp: createAppAPI(render)
  };
}
function resolveChildrenNamespace({ type, props }, currentNamespace) {
  return currentNamespace === "svg" && type === "foreignObject" || currentNamespace === "mathml" && type === "annotation-xml" && props && props.encoding && props.encoding.includes("html") ? void 0 : currentNamespace;
}
function toggleRecurse({ effect: effect2, job }, allowed) {
  if (allowed) {
    effect2.flags |= 32;
    job.flags |= 4;
  } else {
    effect2.flags &= -33;
    job.flags &= -5;
  }
}
function needTransition(parentSuspense, transition) {
  return (!parentSuspense || parentSuspense && !parentSuspense.pendingBranch) && transition && !transition.persisted;
}
function traverseStaticChildren(n1, n2, shallow = false) {
  const ch1 = n1.children;
  const ch2 = n2.children;
  if (isArray(ch1) && isArray(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      const c1 = ch1[i];
      let c2 = ch2[i];
      if (c2.shapeFlag & 1 && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === 32) {
          c2 = ch2[i] = cloneIfMounted(ch2[i]);
          c2.el = c1.el;
        }
        if (!shallow && c2.patchFlag !== -2)
          traverseStaticChildren(c1, c2);
      }
      if (c2.type === Text) {
        if (c2.patchFlag === -1) {
          c2 = ch2[i] = cloneIfMounted(c2);
        }
        c2.el = c1.el;
      }
      if (c2.type === Comment && !c2.el) {
        c2.el = c1.el;
      }
    }
  }
}
function getSequence(arr) {
  const p2 = arr.slice();
  const result = [0];
  let i, j, u, v, c;
  const len = arr.length;
  for (i = 0; i < len; i++) {
    const arrI = arr[i];
    if (arrI !== 0) {
      j = result[result.length - 1];
      if (arr[j] < arrI) {
        p2[i] = j;
        result.push(i);
        continue;
      }
      u = 0;
      v = result.length - 1;
      while (u < v) {
        c = u + v >> 1;
        if (arr[result[c]] < arrI) {
          u = c + 1;
        } else {
          v = c;
        }
      }
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p2[i] = result[u - 1];
        }
        result[u] = i;
      }
    }
  }
  u = result.length;
  v = result[u - 1];
  while (u-- > 0) {
    result[u] = v;
    v = p2[v];
  }
  return result;
}
function locateNonHydratedAsyncRoot(instance) {
  const subComponent = instance.subTree.component;
  if (subComponent) {
    if (subComponent.asyncDep && !subComponent.asyncResolved) {
      return subComponent;
    } else {
      return locateNonHydratedAsyncRoot(subComponent);
    }
  }
}
function invalidateMount(hooks) {
  if (hooks) {
    for (let i = 0; i < hooks.length; i++)
      hooks[i].flags |= 8;
  }
}
function resolveAsyncComponentPlaceholder(anchorVnode) {
  if (anchorVnode.placeholder) {
    return anchorVnode.placeholder;
  }
  const instance = anchorVnode.component;
  if (instance) {
    return resolveAsyncComponentPlaceholder(instance.subTree);
  }
  return null;
}
const isSuspense = (type) => type.__isSuspense;
function queueEffectWithSuspense(fn, suspense) {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn);
    } else {
      suspense.effects.push(fn);
    }
  } else {
    queuePostFlushCb(fn);
  }
}
const Fragment = /* @__PURE__ */ Symbol.for("v-fgt");
const Text = /* @__PURE__ */ Symbol.for("v-txt");
const Comment = /* @__PURE__ */ Symbol.for("v-cmt");
const Static = /* @__PURE__ */ Symbol.for("v-stc");
const blockStack = [];
let currentBlock = null;
function openBlock(disableTracking = false) {
  blockStack.push(currentBlock = disableTracking ? null : []);
}
function closeBlock() {
  blockStack.pop();
  currentBlock = blockStack[blockStack.length - 1] || null;
}
let isBlockTreeEnabled = 1;
function setBlockTracking(value, inVOnce = false) {
  isBlockTreeEnabled += value;
  if (value < 0 && currentBlock && inVOnce) {
    currentBlock.hasOnce = true;
  }
}
function setupBlock(vnode) {
  vnode.dynamicChildren = isBlockTreeEnabled > 0 ? currentBlock || EMPTY_ARR : null;
  closeBlock();
  if (isBlockTreeEnabled > 0 && currentBlock) {
    currentBlock.push(vnode);
  }
  return vnode;
}
function createElementBlock(type, props, children, patchFlag, dynamicProps, shapeFlag) {
  return setupBlock(
    createBaseVNode(
      type,
      props,
      children,
      patchFlag,
      dynamicProps,
      shapeFlag,
      true
    )
  );
}
function createBlock(type, props, children, patchFlag, dynamicProps) {
  return setupBlock(
    createVNode(
      type,
      props,
      children,
      patchFlag,
      dynamicProps,
      true
    )
  );
}
function isVNode(value) {
  return value ? value.__v_isVNode === true : false;
}
function isSameVNodeType(n1, n2) {
  return n1.type === n2.type && n1.key === n2.key;
}
const normalizeKey = ({ key }) => key != null ? key : null;
const normalizeRef = ({
  ref: ref3,
  ref_key,
  ref_for
}) => {
  if (typeof ref3 === "number") {
    ref3 = "" + ref3;
  }
  return ref3 != null ? isString(ref3) || /* @__PURE__ */ isRef(ref3) || isFunction(ref3) ? { i: currentRenderingInstance, r: ref3, k: ref_key, f: !!ref_for } : ref3 : null;
};
function createBaseVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, shapeFlag = type === Fragment ? 0 : 1, isBlockNode = false, needFullChildrenNormalization = false) {
  const vnode = {
    __v_isVNode: true,
    __v_skip: true,
    type,
    props,
    key: props && normalizeKey(props),
    ref: props && normalizeRef(props),
    scopeId: currentScopeId,
    slotScopeIds: null,
    children,
    component: null,
    suspense: null,
    ssContent: null,
    ssFallback: null,
    dirs: null,
    transition: null,
    el: null,
    anchor: null,
    target: null,
    targetStart: null,
    targetAnchor: null,
    staticCount: 0,
    shapeFlag,
    patchFlag,
    dynamicProps,
    dynamicChildren: null,
    appContext: null,
    ctx: currentRenderingInstance
  };
  if (needFullChildrenNormalization) {
    normalizeChildren(vnode, children);
    if (shapeFlag & 128) {
      type.normalize(vnode);
    }
  } else if (children) {
    vnode.shapeFlag |= isString(children) ? 8 : 16;
  }
  if (isBlockTreeEnabled > 0 && // avoid a block node from tracking itself
  !isBlockNode && // has current parent block
  currentBlock && // presence of a patch flag indicates this node needs patching on updates.
  // component nodes also should always be patched, because even if the
  // component doesn't need to update, it needs to persist the instance on to
  // the next vnode so that it can be properly unmounted later.
  (vnode.patchFlag > 0 || shapeFlag & 6) && // the EVENTS flag is only for hydration and if it is the only flag, the
  // vnode should not be considered dynamic due to handler caching.
  vnode.patchFlag !== 32) {
    currentBlock.push(vnode);
  }
  return vnode;
}
const createVNode = _createVNode;
function _createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
  if (!type || type === NULL_DYNAMIC_COMPONENT) {
    type = Comment;
  }
  if (isVNode(type)) {
    const cloned = cloneVNode(
      type,
      props,
      true
      /* mergeRef: true */
    );
    if (children) {
      normalizeChildren(cloned, children);
    }
    if (isBlockTreeEnabled > 0 && !isBlockNode && currentBlock) {
      if (cloned.shapeFlag & 6) {
        currentBlock[currentBlock.indexOf(type)] = cloned;
      } else {
        currentBlock.push(cloned);
      }
    }
    cloned.patchFlag = -2;
    return cloned;
  }
  if (isClassComponent(type)) {
    type = type.__vccOpts;
  }
  if (props) {
    props = guardReactiveProps(props);
    let { class: klass, style } = props;
    if (klass && !isString(klass)) {
      props.class = normalizeClass(klass);
    }
    if (isObject(style)) {
      if (/* @__PURE__ */ isProxy(style) && !isArray(style)) {
        style = extend({}, style);
      }
      props.style = normalizeStyle(style);
    }
  }
  const shapeFlag = isString(type) ? 1 : isSuspense(type) ? 128 : isTeleport(type) ? 64 : isObject(type) ? 4 : isFunction(type) ? 2 : 0;
  return createBaseVNode(
    type,
    props,
    children,
    patchFlag,
    dynamicProps,
    shapeFlag,
    isBlockNode,
    true
  );
}
function guardReactiveProps(props) {
  if (!props) return null;
  return /* @__PURE__ */ isProxy(props) || isInternalObject(props) ? extend({}, props) : props;
}
function cloneVNode(vnode, extraProps, mergeRef = false, cloneTransition = false) {
  const { props, ref: ref3, patchFlag, children, transition } = vnode;
  const mergedProps = extraProps ? mergeProps(props || {}, extraProps) : props;
  const cloned = {
    __v_isVNode: true,
    __v_skip: true,
    type: vnode.type,
    props: mergedProps,
    key: mergedProps && normalizeKey(mergedProps),
    ref: extraProps && extraProps.ref ? (
      // #2078 in the case of <component :is="vnode" ref="extra"/>
      // if the vnode itself already has a ref, cloneVNode will need to merge
      // the refs so the single vnode can be set on multiple refs
      mergeRef && ref3 ? isArray(ref3) ? ref3.concat(normalizeRef(extraProps)) : [ref3, normalizeRef(extraProps)] : normalizeRef(extraProps)
    ) : ref3,
    scopeId: vnode.scopeId,
    slotScopeIds: vnode.slotScopeIds,
    children,
    target: vnode.target,
    targetStart: vnode.targetStart,
    targetAnchor: vnode.targetAnchor,
    staticCount: vnode.staticCount,
    shapeFlag: vnode.shapeFlag,
    // if the vnode is cloned with extra props, we can no longer assume its
    // existing patch flag to be reliable and need to add the FULL_PROPS flag.
    // note: preserve flag for fragments since they use the flag for children
    // fast paths only.
    patchFlag: extraProps && vnode.type !== Fragment ? patchFlag === -1 ? 16 : patchFlag | 16 : patchFlag,
    dynamicProps: vnode.dynamicProps,
    dynamicChildren: vnode.dynamicChildren,
    appContext: vnode.appContext,
    dirs: vnode.dirs,
    transition,
    // These should technically only be non-null on mounted VNodes. However,
    // they *should* be copied for kept-alive vnodes. So we just always copy
    // them since them being non-null during a mount doesn't affect the logic as
    // they will simply be overwritten.
    component: vnode.component,
    suspense: vnode.suspense,
    ssContent: vnode.ssContent && cloneVNode(vnode.ssContent),
    ssFallback: vnode.ssFallback && cloneVNode(vnode.ssFallback),
    placeholder: vnode.placeholder,
    el: vnode.el,
    anchor: vnode.anchor,
    ctx: vnode.ctx,
    ce: vnode.ce,
    cacheIndex: vnode.cacheIndex
  };
  if (transition && cloneTransition) {
    setTransitionHooks(
      cloned,
      transition.clone(cloned)
    );
  }
  return cloned;
}
function createTextVNode(text = " ", flag = 0) {
  return createVNode(Text, null, text, flag);
}
function createStaticVNode(content, numberOfNodes) {
  const vnode = createVNode(Static, null, content);
  vnode.staticCount = numberOfNodes;
  return vnode;
}
function createCommentVNode(text = "", asBlock = false) {
  return asBlock ? (openBlock(), createBlock(Comment, null, text)) : createVNode(Comment, null, text);
}
function normalizeVNode(child) {
  if (child == null || typeof child === "boolean") {
    return createVNode(Comment);
  } else if (isArray(child)) {
    return createVNode(
      Fragment,
      null,
      // #3666, avoid reference pollution when reusing vnode
      child.slice()
    );
  } else if (isVNode(child)) {
    return cloneIfMounted(child);
  } else {
    return createVNode(Text, null, String(child));
  }
}
function cloneIfMounted(child) {
  return child.el === null && child.patchFlag !== -1 || child.memo ? child : cloneVNode(child);
}
function normalizeChildren(vnode, children) {
  let type = 0;
  const { shapeFlag } = vnode;
  if (children == null) {
    children = null;
  } else if (isArray(children)) {
    type = 16;
  } else if (typeof children === "object") {
    if (shapeFlag & (1 | 64)) {
      const slot = children.default;
      if (slot) {
        slot._c && (slot._d = false);
        normalizeChildren(vnode, slot());
        slot._c && (slot._d = true);
      }
      return;
    } else {
      type = 32;
      const slotFlag = children._;
      if (!slotFlag && !isInternalObject(children)) {
        children._ctx = currentRenderingInstance;
      } else if (slotFlag === 3 && currentRenderingInstance) {
        if (currentRenderingInstance.slots._ === 1) {
          children._ = 1;
        } else {
          children._ = 2;
          vnode.patchFlag |= 1024;
        }
      }
    }
  } else if (isFunction(children)) {
    if (shapeFlag & (1 | 64)) {
      normalizeChildren(vnode, { default: children });
      return;
    }
    children = { default: children, _ctx: currentRenderingInstance };
    type = 32;
  } else {
    children = String(children);
    if (shapeFlag & 64) {
      type = 16;
      children = [createTextVNode(children)];
    } else {
      type = 8;
    }
  }
  vnode.children = children;
  vnode.shapeFlag |= type;
}
function mergeProps(...args) {
  const ret = {};
  for (let i = 0; i < args.length; i++) {
    const toMerge = args[i];
    for (const key in toMerge) {
      if (key === "class") {
        if (ret.class !== toMerge.class) {
          ret.class = normalizeClass([ret.class, toMerge.class]);
        }
      } else if (key === "style") {
        ret.style = normalizeStyle([ret.style, toMerge.style]);
      } else if (isOn(key)) {
        const existing = ret[key];
        const incoming = toMerge[key];
        if (incoming && existing !== incoming && !(isArray(existing) && existing.includes(incoming))) {
          ret[key] = existing ? [].concat(existing, incoming) : incoming;
        } else if (incoming == null && existing == null && // mergeProps({ 'onUpdate:modelValue': undefined }) should not retain
        // the model listener.
        !isModelListener(key)) {
          ret[key] = incoming;
        }
      } else if (key !== "") {
        ret[key] = toMerge[key];
      }
    }
  }
  return ret;
}
function invokeVNodeHook(hook, instance, vnode, prevVNode = null) {
  callWithAsyncErrorHandling(hook, instance, 7, [
    vnode,
    prevVNode
  ]);
}
const emptyAppContext = createAppContext();
let uid = 0;
function getNextUid() {
  return uid;
}
function createComponentInstance(vnode, parent, suspense) {
  const type = vnode.type;
  const appContext = (parent ? parent.appContext : vnode.appContext) || emptyAppContext;
  const instance = {
    uid: uid++,
    vnode,
    type,
    parent,
    appContext,
    root: null,
    // to be immediately set
    next: null,
    subTree: null,
    // will be set synchronously right after creation
    effect: null,
    update: null,
    // will be set synchronously right after creation
    job: null,
    scope: new EffectScope(
      true
      /* detached */
    ),
    render: null,
    proxy: null,
    exposed: null,
    exposeProxy: null,
    withProxy: null,
    provides: parent ? parent.provides : Object.create(appContext.provides),
    ids: parent ? parent.ids : ["", 0, 0],
    accessCache: null,
    renderCache: [],
    // local resolved assets
    components: null,
    directives: null,
    // resolved props and emits options
    propsOptions: normalizePropsOptions(type, appContext),
    emitsOptions: normalizeEmitsOptions(type, appContext),
    // emit
    emit: null,
    // to be set immediately
    emitted: null,
    // props default value
    propsDefaults: EMPTY_OBJ,
    // inheritAttrs
    inheritAttrs: type.inheritAttrs,
    // state
    ctx: EMPTY_OBJ,
    data: EMPTY_OBJ,
    props: EMPTY_OBJ,
    attrs: EMPTY_OBJ,
    slots: EMPTY_OBJ,
    refs: EMPTY_OBJ,
    setupState: EMPTY_OBJ,
    setupContext: null,
    // suspense related
    suspense,
    suspenseId: suspense ? suspense.pendingId : 0,
    asyncDep: null,
    asyncResolved: false,
    // lifecycle hooks
    // not using enums here because it results in computed properties
    isMounted: false,
    isUnmounted: false,
    isDeactivated: false,
    bc: null,
    c: null,
    bm: null,
    m: null,
    bu: null,
    u: null,
    um: null,
    bum: null,
    da: null,
    a: null,
    rtg: null,
    rtc: null,
    ec: null,
    sp: null
  };
  {
    instance.ctx = { _: instance };
  }
  instance.root = parent ? parent.root : instance;
  instance.emit = emit.bind(null, instance);
  if (vnode.ce) {
    vnode.ce(instance);
  }
  return instance;
}
let currentInstance = null;
const getCurrentInstance = () => currentInstance || currentRenderingInstance;
let internalSetCurrentInstance;
let setInSSRSetupState;
{
  const g = getGlobalThis();
  const registerGlobalSetter = (key, setter) => {
    let setters;
    if (!(setters = g[key])) setters = g[key] = [];
    setters.push(setter);
    return (v) => {
      if (setters.length > 1) setters.forEach((set) => set(v));
      else setters[0](v);
    };
  };
  internalSetCurrentInstance = registerGlobalSetter(
    `__VUE_INSTANCE_SETTERS__`,
    (v) => currentInstance = v
  );
  setInSSRSetupState = registerGlobalSetter(
    `__VUE_SSR_SETTERS__`,
    (v) => isInSSRComponentSetup = v
  );
}
const setCurrentInstance = (instance) => {
  const prev = currentInstance;
  internalSetCurrentInstance(instance);
  instance.scope.on();
  return () => {
    instance.scope.off();
    internalSetCurrentInstance(prev);
  };
};
const unsetCurrentInstance = () => {
  currentInstance && currentInstance.scope.off();
  internalSetCurrentInstance(null);
};
function isStatefulComponent(instance) {
  return instance.vnode.shapeFlag & 4;
}
let isInSSRComponentSetup = false;
function setupComponent(instance, isSSR = false, optimized = false) {
  isSSR && setInSSRSetupState(isSSR);
  const { props, children } = instance.vnode;
  const isStateful = isStatefulComponent(instance);
  initProps(instance, props, isStateful, isSSR);
  initSlots(instance, children, optimized || isSSR);
  const setupResult = isStateful ? setupStatefulComponent(instance, isSSR) : void 0;
  isSSR && setInSSRSetupState(false);
  return setupResult;
}
function setupStatefulComponent(instance, isSSR) {
  const Component = instance.type;
  instance.accessCache = /* @__PURE__ */ Object.create(null);
  instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers);
  const { setup } = Component;
  if (setup) {
    pauseTracking();
    const setupContext = instance.setupContext = setup.length > 1 ? createSetupContext(instance) : null;
    const reset = setCurrentInstance(instance);
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      0,
      [
        instance.props,
        setupContext
      ]
    );
    const isAsyncSetup = isPromise(setupResult);
    resetTracking();
    reset();
    if ((isAsyncSetup || instance.sp) && !isAsyncWrapper(instance)) {
      markAsyncBoundary(instance);
    }
    if (isAsyncSetup) {
      setupResult.then(unsetCurrentInstance, unsetCurrentInstance);
      if (isSSR) {
        return setupResult.then((resolvedResult) => {
          setInSSRSetupState(true);
          try {
            handleSetupResult(instance, resolvedResult, isSSR);
          } finally {
            setInSSRSetupState(false);
          }
        }).catch((e) => {
          handleError(e, instance, 0);
        });
      } else {
        instance.asyncDep = setupResult;
      }
    } else {
      handleSetupResult(instance, setupResult);
    }
  } else {
    finishComponentSetup(instance);
  }
}
function handleSetupResult(instance, setupResult, isSSR) {
  if (isFunction(setupResult)) {
    if (instance.type.__ssrInlineRender) {
      instance.ssrRender = setupResult;
    } else {
      instance.render = setupResult;
    }
  } else if (isObject(setupResult)) {
    instance.setupState = proxyRefs(setupResult);
  } else ;
  finishComponentSetup(instance);
}
function finishComponentSetup(instance, isSSR, skipOptions) {
  const Component = instance.type;
  if (!instance.render) {
    instance.render = Component.render || NOOP;
  }
  {
    const reset = setCurrentInstance(instance);
    pauseTracking();
    try {
      applyOptions(instance);
    } finally {
      resetTracking();
      reset();
    }
  }
}
const attrsProxyHandlers = {
  get(target, key) {
    track(target, "get", "");
    return target[key];
  }
};
function createSetupContext(instance) {
  const expose = (exposed) => {
    instance.exposed = exposed || {};
  };
  {
    return {
      attrs: new Proxy(instance.attrs, attrsProxyHandlers),
      slots: instance.slots,
      emit: instance.emit,
      expose
    };
  }
}
function getComponentPublicInstance(instance) {
  if (instance.exposed) {
    return instance.exposeProxy || (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
      get(target, key) {
        if (key in target) {
          return target[key];
        } else if (key in publicPropertiesMap) {
          return publicPropertiesMap[key](instance);
        }
      },
      has(target, key) {
        return key in target || key in publicPropertiesMap;
      }
    }));
  } else {
    return instance.proxy;
  }
}
const classifyRE = /(?:^|[-_])\w/g;
const classify = (str) => str.replace(classifyRE, (c) => c.toUpperCase()).replace(/[-_]/g, "");
function getComponentName(Component, includeInferred = true) {
  return isFunction(Component) ? Component.displayName || Component.name : Component.name || includeInferred && Component.__name;
}
function formatComponentName(instance, Component, isRoot = false) {
  let name = getComponentName(Component);
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/);
    if (match) {
      name = match[1];
    }
  }
  if (!name && instance) {
    const inferFromRegistry = (registry) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key;
        }
      }
    };
    name = inferFromRegistry(instance.components) || instance.parent && inferFromRegistry(
      instance.parent.type.components
    ) || inferFromRegistry(instance.appContext.components);
  }
  return name ? classify(name) : isRoot ? `App` : `Anonymous`;
}
function isClassComponent(value) {
  return isFunction(value) && "__vccOpts" in value;
}
const computed = (getterOrOptions, debugOptions) => {
  const c = /* @__PURE__ */ computed$1(getterOrOptions, debugOptions, isInSSRComponentSetup);
  return c;
};
function h(type, propsOrChildren, children) {
  try {
    setBlockTracking(-1);
    const l = arguments.length;
    if (l === 2) {
      if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
        if (isVNode(propsOrChildren)) {
          return createVNode(type, null, [propsOrChildren]);
        }
        return createVNode(type, propsOrChildren);
      } else {
        return createVNode(type, null, propsOrChildren);
      }
    } else {
      if (l > 3) {
        children = Array.prototype.slice.call(arguments, 2);
      } else if (l === 3 && isVNode(children)) {
        children = [children];
      }
      return createVNode(type, propsOrChildren, children);
    }
  } finally {
    setBlockTracking(1);
  }
}
const version = "3.5.44";
let policy = void 0;
const tt = typeof window !== "undefined" && window.trustedTypes;
if (tt) {
  try {
    policy = /* @__PURE__ */ tt.createPolicy("vue", {
      createHTML: (val) => val
    });
  } catch (e) {
  }
}
const unsafeToTrustedHTML = policy ? (val) => policy.createHTML(val) : (val) => val;
const svgNS = "http://www.w3.org/2000/svg";
const mathmlNS = "http://www.w3.org/1998/Math/MathML";
const doc = typeof document !== "undefined" ? document : null;
const templateContainer = doc && /* @__PURE__ */ doc.createElement("template");
const nodeOps = {
  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null);
  },
  remove: (child) => {
    const parent = child.parentNode;
    if (parent) {
      parent.removeChild(child);
    }
  },
  createElement: (tag, namespace, is, props) => {
    const el = namespace === "svg" ? doc.createElementNS(svgNS, tag) : namespace === "mathml" ? doc.createElementNS(mathmlNS, tag) : is ? doc.createElement(tag, { is }) : doc.createElement(tag);
    if (tag === "select" && props && props.multiple != null) {
      el.setAttribute("multiple", props.multiple);
    }
    return el;
  },
  createText: (text) => doc.createTextNode(text),
  createComment: (text) => doc.createComment(text),
  setText: (node, text) => {
    node.nodeValue = text;
  },
  setElementText: (el, text) => {
    el.textContent = text;
  },
  parentNode: (node) => node.parentNode,
  nextSibling: (node) => node.nextSibling,
  querySelector: (selector) => doc.querySelector(selector),
  setScopeId(el, id) {
    el.setAttribute(id, "");
  },
  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    const before = anchor ? anchor.previousSibling : parent.lastChild;
    if (start && (start === end || start.nextSibling)) {
      while (true) {
        parent.insertBefore(start.cloneNode(true), anchor);
        if (start === end || !(start = start.nextSibling)) break;
      }
    } else {
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === "svg" ? `<svg>${content}</svg>` : namespace === "mathml" ? `<math>${content}</math>` : content
      );
      const template = templateContainer.content;
      if (namespace === "svg" || namespace === "mathml") {
        const wrapper = template.firstChild;
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild);
        }
        template.removeChild(wrapper);
      }
      parent.insertBefore(template, anchor);
    }
    return [
      // first
      before ? before.nextSibling : parent.firstChild,
      // last
      anchor ? anchor.previousSibling : parent.lastChild
    ];
  }
};
const TRANSITION = "transition";
const ANIMATION = "animation";
const vtcKey = /* @__PURE__ */ Symbol("_vtc");
const DOMTransitionPropsValidators = {
  name: String,
  type: String,
  css: {
    type: Boolean,
    default: true
  },
  duration: [String, Number, Object],
  enterFromClass: String,
  enterActiveClass: String,
  enterToClass: String,
  appearFromClass: String,
  appearActiveClass: String,
  appearToClass: String,
  leaveFromClass: String,
  leaveActiveClass: String,
  leaveToClass: String
};
const TransitionPropsValidators = /* @__PURE__ */ extend(
  {},
  BaseTransitionPropsValidators,
  DOMTransitionPropsValidators
);
const decorate$1 = (t) => {
  t.displayName = "Transition";
  t.props = TransitionPropsValidators;
  return t;
};
const Transition = /* @__PURE__ */ decorate$1(
  (props, { slots }) => h(BaseTransition, resolveTransitionProps(props), slots)
);
const callHook = (hook, args = []) => {
  if (isArray(hook)) {
    hook.forEach((h2) => h2(...args));
  } else if (hook) {
    hook(...args);
  }
};
const hasExplicitCallback = (hook) => {
  return hook ? isArray(hook) ? hook.some((h2) => h2.length > 1) : hook.length > 1 : false;
};
function resolveTransitionProps(rawProps) {
  const baseProps = {};
  for (const key in rawProps) {
    if (!(key in DOMTransitionPropsValidators)) {
      baseProps[key] = rawProps[key];
    }
  }
  if (rawProps.css === false) {
    return baseProps;
  }
  const {
    name = "v",
    type,
    duration,
    enterFromClass = `${name}-enter-from`,
    enterActiveClass = `${name}-enter-active`,
    enterToClass = `${name}-enter-to`,
    appearFromClass = enterFromClass,
    appearActiveClass = enterActiveClass,
    appearToClass = enterToClass,
    leaveFromClass = `${name}-leave-from`,
    leaveActiveClass = `${name}-leave-active`,
    leaveToClass = `${name}-leave-to`
  } = rawProps;
  const durations = normalizeDuration(duration);
  const enterDuration = durations && durations[0];
  const leaveDuration = durations && durations[1];
  const {
    onBeforeEnter,
    onEnter,
    onEnterCancelled,
    onLeave,
    onLeaveCancelled,
    onBeforeAppear = onBeforeEnter,
    onAppear = onEnter,
    onAppearCancelled = onEnterCancelled
  } = baseProps;
  const finishEnter = (el, isAppear, done, isCancelled) => {
    el._enterCancelled = isCancelled;
    removeTransitionClass(el, isAppear ? appearToClass : enterToClass);
    removeTransitionClass(el, isAppear ? appearActiveClass : enterActiveClass);
    done && done();
  };
  const finishLeave = (el, done) => {
    el._isLeaving = false;
    removeTransitionClass(el, leaveFromClass);
    removeTransitionClass(el, leaveToClass);
    removeTransitionClass(el, leaveActiveClass);
    done && done();
  };
  const makeEnterHook = (isAppear) => {
    return (el, done) => {
      const hook = isAppear ? onAppear : onEnter;
      const resolve = () => finishEnter(el, isAppear, done);
      callHook(hook, [el, resolve]);
      nextFrame(() => {
        removeTransitionClass(el, isAppear ? appearFromClass : enterFromClass);
        addTransitionClass(el, isAppear ? appearToClass : enterToClass);
        if (!hasExplicitCallback(hook)) {
          whenTransitionEnds(el, type, enterDuration, resolve);
        }
      });
    };
  };
  return extend(baseProps, {
    onBeforeEnter(el) {
      callHook(onBeforeEnter, [el]);
      addTransitionClass(el, enterFromClass);
      addTransitionClass(el, enterActiveClass);
    },
    onBeforeAppear(el) {
      callHook(onBeforeAppear, [el]);
      addTransitionClass(el, appearFromClass);
      addTransitionClass(el, appearActiveClass);
    },
    onEnter: makeEnterHook(false),
    onAppear: makeEnterHook(true),
    onLeave(el, done) {
      el._isLeaving = true;
      const resolve = () => finishLeave(el, done);
      addTransitionClass(el, leaveFromClass);
      if (!el._enterCancelled) {
        forceReflow(el);
        addTransitionClass(el, leaveActiveClass);
      } else {
        addTransitionClass(el, leaveActiveClass);
        forceReflow(el);
      }
      nextFrame(() => {
        if (!el._isLeaving) {
          return;
        }
        removeTransitionClass(el, leaveFromClass);
        addTransitionClass(el, leaveToClass);
        if (!hasExplicitCallback(onLeave)) {
          whenTransitionEnds(el, type, leaveDuration, resolve);
        }
      });
      callHook(onLeave, [el, resolve]);
    },
    onEnterCancelled(el) {
      finishEnter(el, false, void 0, true);
      callHook(onEnterCancelled, [el]);
    },
    onAppearCancelled(el) {
      finishEnter(el, true, void 0, true);
      callHook(onAppearCancelled, [el]);
    },
    onLeaveCancelled(el) {
      finishLeave(el);
      callHook(onLeaveCancelled, [el]);
    }
  });
}
function normalizeDuration(duration) {
  if (duration == null) {
    return null;
  } else if (isObject(duration)) {
    return [NumberOf(duration.enter), NumberOf(duration.leave)];
  } else {
    const n = NumberOf(duration);
    return [n, n];
  }
}
function NumberOf(val) {
  const res = toNumber(val);
  return res;
}
function addTransitionClass(el, cls) {
  cls.split(/\s+/).forEach((c) => c && el.classList.add(c));
  (el[vtcKey] || (el[vtcKey] = /* @__PURE__ */ new Set())).add(cls);
}
function removeTransitionClass(el, cls) {
  cls.split(/\s+/).forEach((c) => c && el.classList.remove(c));
  const _vtc = el[vtcKey];
  if (_vtc) {
    _vtc.delete(cls);
    if (!_vtc.size) {
      el[vtcKey] = void 0;
    }
  }
}
function nextFrame(cb) {
  requestAnimationFrame(() => {
    requestAnimationFrame(cb);
  });
}
let endId = 0;
function whenTransitionEnds(el, expectedType, explicitTimeout, resolve) {
  const id = el._endId = ++endId;
  const resolveIfNotStale = () => {
    if (id === el._endId) {
      resolve();
    }
  };
  if (explicitTimeout != null) {
    return setTimeout(resolveIfNotStale, explicitTimeout);
  }
  const { type, timeout, propCount } = getTransitionInfo(el, expectedType);
  if (!type) {
    return resolve();
  }
  const endEvent = type + "end";
  let ended = 0;
  const end = () => {
    el.removeEventListener(endEvent, onEnd);
    resolveIfNotStale();
  };
  const onEnd = (e) => {
    if (e.target === el && ++ended >= propCount) {
      end();
    }
  };
  setTimeout(() => {
    if (ended < propCount) {
      end();
    }
  }, timeout + 1);
  el.addEventListener(endEvent, onEnd);
}
function getTransitionInfo(el, expectedType) {
  const styles = window.getComputedStyle(el);
  const getStyleProperties = (key) => (styles[key] || "").split(", ");
  const transitionDelays = getStyleProperties(`${TRANSITION}Delay`);
  const transitionDurations = getStyleProperties(`${TRANSITION}Duration`);
  const transitionTimeout = getTimeout(transitionDelays, transitionDurations);
  const animationDelays = getStyleProperties(`${ANIMATION}Delay`);
  const animationDurations = getStyleProperties(`${ANIMATION}Duration`);
  const animationTimeout = getTimeout(animationDelays, animationDurations);
  let type = null;
  let timeout = 0;
  let propCount = 0;
  if (expectedType === TRANSITION) {
    if (transitionTimeout > 0) {
      type = TRANSITION;
      timeout = transitionTimeout;
      propCount = transitionDurations.length;
    }
  } else if (expectedType === ANIMATION) {
    if (animationTimeout > 0) {
      type = ANIMATION;
      timeout = animationTimeout;
      propCount = animationDurations.length;
    }
  } else {
    timeout = Math.max(transitionTimeout, animationTimeout);
    type = timeout > 0 ? transitionTimeout > animationTimeout ? TRANSITION : ANIMATION : null;
    propCount = type ? type === TRANSITION ? transitionDurations.length : animationDurations.length : 0;
  }
  const hasTransform = type === TRANSITION && /\b(?:transform|all)(?:,|$)/.test(
    getStyleProperties(`${TRANSITION}Property`).toString()
  );
  return {
    type,
    timeout,
    propCount,
    hasTransform
  };
}
function getTimeout(delays, durations) {
  while (delays.length < durations.length) {
    delays = delays.concat(delays);
  }
  return Math.max(...durations.map((d, i) => toMs(d) + toMs(delays[i])));
}
function toMs(s) {
  if (s === "auto") return 0;
  return Number(s.slice(0, -1).replace(",", ".")) * 1e3;
}
function forceReflow(el) {
  const targetDocument = el ? el.ownerDocument : document;
  return targetDocument.body.offsetHeight;
}
function patchClass(el, value, isSVG) {
  const transitionClasses = el[vtcKey];
  if (transitionClasses) {
    value = (value ? [value, ...transitionClasses] : [...transitionClasses]).join(" ");
  }
  if (value == null) {
    el.removeAttribute("class");
  } else if (isSVG) {
    el.setAttribute("class", value);
  } else {
    el.className = value;
  }
}
const vShowOriginalDisplay = /* @__PURE__ */ Symbol("_vod");
const vShowHidden = /* @__PURE__ */ Symbol("_vsh");
const vShow = {
  // used for prop mismatch check during hydration
  name: "show",
  beforeMount(el, { value }, { transition }) {
    el[vShowOriginalDisplay] = el.style.display === "none" ? "" : el.style.display;
    if (transition && value) {
      transition.beforeEnter(el);
    } else {
      setDisplay(el, value);
    }
  },
  mounted(el, { value }, { transition }) {
    if (transition && value) {
      transition.enter(el);
    }
  },
  updated(el, { value, oldValue }, { transition }) {
    if (!value === !oldValue) return;
    if (transition) {
      if (value) {
        transition.beforeEnter(el);
        setDisplay(el, true);
        transition.enter(el);
      } else {
        transition.leave(el, () => {
          setDisplay(el, false);
        });
      }
    } else {
      setDisplay(el, value);
    }
  },
  beforeUnmount(el, { value }) {
    setDisplay(el, value);
  }
};
function setDisplay(el, value) {
  el.style.display = value ? el[vShowOriginalDisplay] : "none";
  el[vShowHidden] = !value;
}
const CSS_VAR_TEXT = /* @__PURE__ */ Symbol("");
const displayRE = /(?:^|;)\s*display\s*:/;
function patchStyle(el, prev, next) {
  const style = el.style;
  const isCssString = isString(next);
  let hasControlledDisplay = false;
  if (next && !isCssString) {
    if (prev) {
      if (!isString(prev)) {
        for (const key in prev) {
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      } else {
        for (const prevStyle of prev.split(";")) {
          const key = prevStyle.slice(0, prevStyle.indexOf(":")).trim();
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      }
    }
    for (const key in next) {
      if (key === "display") {
        hasControlledDisplay = true;
      }
      const value = next[key];
      if (value != null) {
        if (!shouldPreserveTextareaResizeStyle(
          el,
          key,
          !isString(prev) && prev ? prev[key] : void 0,
          value
        )) {
          setStyle(style, key, value);
        }
      } else {
        setStyle(style, key, "");
      }
    }
  } else {
    if (isCssString) {
      if (prev !== next) {
        const cssVarText = style[CSS_VAR_TEXT];
        if (cssVarText) {
          next += ";" + cssVarText;
        }
        style.cssText = next;
        hasControlledDisplay = displayRE.test(next);
      }
    } else if (prev) {
      el.removeAttribute("style");
    }
  }
  if (vShowOriginalDisplay in el) {
    if (!isCssString || prev !== next) {
      el[vShowOriginalDisplay] = hasControlledDisplay ? style.display : "";
    }
    if (el[vShowHidden]) {
      style.display = "none";
    }
  }
}
const importantRE = /\s*!important$/;
function setStyle(style, name, val) {
  if (isArray(val)) {
    val.forEach((v) => setStyle(style, name, v));
  } else {
    if (val == null) val = "";
    if (name.startsWith("--")) {
      if (importantRE.test(val)) {
        style.setProperty(name, val.replace(importantRE, ""), "important");
      } else {
        style.setProperty(name, val);
      }
    } else {
      const prefixed = autoPrefix(style, name);
      if (importantRE.test(val)) {
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ""),
          "important"
        );
      } else {
        style[prefixed] = val;
      }
    }
  }
}
const prefixes = ["Webkit", "Moz", "ms"];
const prefixCache = {};
function autoPrefix(style, rawName) {
  const cached = prefixCache[rawName];
  if (cached) {
    return cached;
  }
  let name = camelize(rawName);
  if (name !== "filter" && name in style) {
    return prefixCache[rawName] = name;
  }
  name = capitalize(name);
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name;
    if (prefixed in style) {
      return prefixCache[rawName] = prefixed;
    }
  }
  return rawName;
}
function shouldPreserveTextareaResizeStyle(el, key, prev, next) {
  return el.tagName === "TEXTAREA" && (key === "width" || key === "height") && isString(next) && prev === next;
}
const xlinkNS = "http://www.w3.org/1999/xlink";
function patchAttr(el, key, value, isSVG, instance, isBoolean = isSpecialBooleanAttr(key)) {
  if (isSVG && key.startsWith("xlink:")) {
    if (value == null) {
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length));
    } else {
      el.setAttributeNS(xlinkNS, key, value);
    }
  } else {
    if (value == null || isBoolean && !includeBooleanAttr(value)) {
      el.removeAttribute(key);
    } else {
      el.setAttribute(
        key,
        isBoolean ? "" : isSymbol(value) ? String(value) : value
      );
    }
  }
}
function patchDOMProp(el, key, value, parentComponent, attrName) {
  if (key === "innerHTML" || key === "textContent") {
    if (value != null) {
      el[key] = key === "innerHTML" ? unsafeToTrustedHTML(value) : value;
    }
    return;
  }
  const tag = el.tagName;
  if (key === "value" && tag !== "PROGRESS" && // custom elements may use _value internally
  !tag.includes("-")) {
    const oldValue = tag === "OPTION" ? el.getAttribute("value") || "" : el.value;
    const newValue = value == null ? (
      // #11647: value should be set as empty string for null and undefined,
      // but <input type="checkbox"> should be set as 'on'.
      el.type === "checkbox" ? "on" : ""
    ) : String(value);
    if (oldValue !== newValue || !("_value" in el)) {
      el.value = newValue;
    }
    if (value == null) {
      el.removeAttribute(key);
    }
    el._value = value;
    return;
  }
  let needRemove = false;
  if (value === "" || value == null) {
    const type = typeof el[key];
    if (type === "boolean") {
      value = includeBooleanAttr(value);
    } else if (value == null && type === "string") {
      value = "";
      needRemove = true;
    } else if (type === "number") {
      value = 0;
      needRemove = true;
    }
  }
  try {
    el[key] = value;
  } catch (e) {
  }
  needRemove && el.removeAttribute(attrName || key);
}
function addEventListener(el, event, handler, options) {
  el.addEventListener(event, handler, options);
}
function removeEventListener(el, event, handler, options) {
  el.removeEventListener(event, handler, options);
}
const veiKey = /* @__PURE__ */ Symbol("_vei");
function patchEvent(el, rawName, prevValue, nextValue, instance = null) {
  const invokers = el[veiKey] || (el[veiKey] = {});
  const existingInvoker = invokers[rawName];
  if (nextValue && existingInvoker) {
    existingInvoker.value = nextValue;
  } else {
    const [name, options] = parseName(rawName);
    if (nextValue) {
      const invoker = invokers[rawName] = createInvoker(
        nextValue,
        instance
      );
      addEventListener(el, name, invoker, options);
    } else if (existingInvoker) {
      removeEventListener(el, name, existingInvoker, options);
      invokers[rawName] = void 0;
    }
  }
}
const optionsModifierRE = /(Once|Passive|Capture)$/;
const optionsModifierEventRE = /^on:?(?:Once|Passive|Capture)$/;
function parseName(name) {
  let options;
  let m;
  while ((m = name.match(optionsModifierRE)) && !optionsModifierEventRE.test(name)) {
    if (!options) options = {};
    name = name.slice(0, name.length - m[1].length);
    options[m[1].toLowerCase()] = true;
  }
  const event = name[2] === ":" ? name.slice(3) : hyphenate(name.slice(2));
  return [event, options];
}
let cachedNow = 0;
const p = /* @__PURE__ */ Promise.resolve();
const getNow = () => cachedNow || (p.then(() => cachedNow = 0), cachedNow = Date.now());
function createInvoker(initialValue, instance) {
  const invoker = (e) => {
    if (!e._vts) {
      e._vts = Date.now();
    } else if (e._vts <= invoker.attached) {
      return;
    }
    const value = invoker.value;
    if (isArray(value)) {
      const originalStop = e.stopImmediatePropagation;
      e.stopImmediatePropagation = () => {
        originalStop.call(e);
        e._stopped = true;
      };
      const handlers = value.slice();
      const args = [e];
      for (let i = 0; i < handlers.length; i++) {
        if (e._stopped) {
          break;
        }
        const handler = handlers[i];
        if (handler) {
          callWithAsyncErrorHandling(
            handler,
            instance,
            5,
            args
          );
        }
      }
    } else {
      callWithAsyncErrorHandling(
        value,
        instance,
        5,
        [e]
      );
    }
  };
  invoker.value = initialValue;
  invoker.attached = getNow();
  return invoker;
}
const isNativeOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // lowercase letter
key.charCodeAt(2) > 96 && key.charCodeAt(2) < 123;
const patchProp = (el, key, prevValue, nextValue, namespace, parentComponent) => {
  const isSVG = namespace === "svg";
  if (key === "class") {
    patchClass(el, nextValue, isSVG);
  } else if (key === "style") {
    patchStyle(el, prevValue, nextValue);
  } else if (isOn(key)) {
    if (!isModelListener(key)) {
      patchEvent(el, key, prevValue, nextValue, parentComponent);
    }
  } else if (key[0] === "." ? (key = key.slice(1), true) : key[0] === "^" ? (key = key.slice(1), false) : shouldSetAsProp(el, key, nextValue, isSVG)) {
    patchDOMProp(el, key, nextValue);
    if (!el.tagName.includes("-") && (key === "value" || key === "checked" || key === "selected")) {
      patchAttr(el, key, nextValue, isSVG, parentComponent, key !== "value");
    }
  } else if (
    // #11081 force set props for possible async custom element
    el._isVueCE && // #12408 check if it's declared prop or it's async custom element
    (shouldSetAsPropForVueCE(el, key) || // @ts-expect-error _def is private
    el._def.__asyncLoader && (/[A-Z]/.test(key) || !isString(nextValue)))
  ) {
    patchDOMProp(el, camelize(key), nextValue, parentComponent, key);
  } else {
    if (key === "true-value") {
      el._trueValue = nextValue;
    } else if (key === "false-value") {
      el._falseValue = nextValue;
    }
    patchAttr(el, key, nextValue, isSVG);
  }
};
function shouldSetAsProp(el, key, value, isSVG) {
  if (isSVG) {
    if (key === "innerHTML" || key === "textContent") {
      return true;
    }
    if (key in el && isNativeOn(key) && isFunction(value)) {
      return true;
    }
    return false;
  }
  if (key === "spellcheck" || key === "draggable" || key === "translate" || key === "autocorrect") {
    return false;
  }
  if (key === "sandbox" && el.tagName === "IFRAME") {
    return false;
  }
  if (key === "form") {
    return false;
  }
  if (key === "list" && el.tagName === "INPUT") {
    return false;
  }
  if (key === "type" && el.tagName === "TEXTAREA") {
    return false;
  }
  if (key === "width" || key === "height") {
    const tag = el.tagName;
    if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "SOURCE") {
      return false;
    }
  }
  if (isNativeOn(key) && isString(value)) {
    return false;
  }
  return key in el;
}
function shouldSetAsPropForVueCE(el, key) {
  const props = (
    // @ts-expect-error _def is private
    el._def.props
  );
  if (!props) {
    return false;
  }
  const camelKey = camelize(key);
  return Array.isArray(props) ? props.some((prop) => camelize(prop) === camelKey) : Object.keys(props).some((prop) => camelize(prop) === camelKey);
}
const getModelAssigner = (vnode) => {
  const fn = vnode.props["onUpdate:modelValue"] || false;
  return isArray(fn) ? (value) => invokeArrayFns(fn, value) : fn;
};
function onCompositionStart(e) {
  e.target.composing = true;
}
function onCompositionEnd(e) {
  const target = e.target;
  if (target.composing) {
    target.composing = false;
    target.dispatchEvent(new Event("input"));
  }
}
const assignKey = /* @__PURE__ */ Symbol("_assign");
const initialValueKey = /* @__PURE__ */ Symbol("_initialValue");
function castValue(value, trim, number) {
  if (trim) value = value.trim();
  if (number) value = looseToNumber(value);
  return value;
}
const vModelText = {
  created(el, { modifiers: { lazy, trim, number } }, vnode) {
    if (el.parentNode) {
      if (el.type === "text") {
        el[initialValueKey] = el.defaultValue.replace(/[\r\n]/g, "");
      } else if (el.type === "textarea") {
        el[initialValueKey] = el.defaultValue.replace(/\r\n?/g, "\n");
      }
    }
    el[assignKey] = getModelAssigner(vnode);
    const castToNumber = number || vnode.props && vnode.props.type === "number";
    addEventListener(el, lazy ? "change" : "input", (e) => {
      if (e.target.composing) return;
      el[assignKey](castValue(el.value, trim, castToNumber));
    });
    if (trim || castToNumber) {
      addEventListener(el, "change", () => {
        el.value = castValue(el.value, trim, castToNumber);
      });
    }
    if (!lazy) {
      addEventListener(el, "compositionstart", onCompositionStart);
      addEventListener(el, "compositionend", onCompositionEnd);
      addEventListener(el, "change", onCompositionEnd);
    }
  },
  // set value on mounted so it's after min/max for type="range"
  mounted(el, { value, modifiers: { trim, number } }) {
    const newValue = value == null ? "" : value;
    const initialValue = el[initialValueKey];
    delete el[initialValueKey];
    if (initialValue !== void 0 && (el.type === "text" || el.type === "textarea") && el.value !== initialValue) {
      el[assignKey](castValue(el.value, trim, number));
    } else {
      el.value = newValue;
    }
  },
  beforeUpdate(el, { value, oldValue, modifiers: { lazy, trim, number } }, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    if (el.composing) return;
    const elValue = (number || el.type === "number") && !/^0\d/.test(el.value) ? looseToNumber(el.value) : el.value;
    const newValue = value == null ? "" : value;
    if (elValue === newValue) {
      return;
    }
    const rootNode = el.getRootNode();
    if ((rootNode instanceof Document || rootNode instanceof ShadowRoot) && rootNode.activeElement === el && el.type !== "range") {
      if (lazy && value === oldValue) {
        return;
      }
      if (trim && el.value.trim() === newValue) {
        return;
      }
    }
    el.value = newValue;
  }
};
const vModelCheckbox = {
  // #4096 array checkboxes need to be deep traversed
  deep: true,
  created(el, _, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    addEventListener(el, "change", () => {
      const modelValue = el._modelValue;
      const elementValue = getValue(el);
      const checked = el.checked;
      const assign = el[assignKey];
      if (isArray(modelValue)) {
        const index = looseIndexOf(modelValue, elementValue);
        const found = index !== -1;
        if (checked && !found) {
          assign(modelValue.concat(elementValue));
        } else if (!checked && found) {
          const filtered = [...modelValue];
          filtered.splice(index, 1);
          assign(filtered);
        }
      } else if (isSet(modelValue)) {
        const cloned = new Set(modelValue);
        if (checked) {
          cloned.add(elementValue);
        } else {
          cloned.delete(elementValue);
        }
        assign(cloned);
      } else {
        assign(getCheckboxValue(el, checked));
      }
    });
  },
  // set initial checked on mount to wait for true-value/false-value
  mounted: setChecked,
  beforeUpdate(el, binding, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    setChecked(el, binding, vnode);
  }
};
function setChecked(el, { value, oldValue }, vnode) {
  el._modelValue = value;
  let checked;
  if (isArray(value)) {
    checked = looseIndexOf(value, vnode.props.value) > -1;
  } else if (isSet(value)) {
    checked = value.has(vnode.props.value);
  } else {
    if (value === oldValue) return;
    checked = looseEqual(value, getCheckboxValue(el, true));
  }
  if (el.checked !== checked) {
    el.checked = checked;
  }
}
const vModelRadio = {
  created(el, { value }, vnode) {
    el.checked = looseEqual(value, vnode.props.value);
    el[assignKey] = getModelAssigner(vnode);
    addEventListener(el, "change", () => {
      el[assignKey](getValue(el));
    });
  },
  beforeUpdate(el, { value, oldValue }, vnode) {
    el[assignKey] = getModelAssigner(vnode);
    if (value !== oldValue) {
      el.checked = looseEqual(value, vnode.props.value);
    }
  }
};
const vModelSelect = {
  // <select multiple> value need to be deep traversed
  deep: true,
  created(el, { value, modifiers: { number } }, vnode) {
    el._modelValue = value;
    addEventListener(el, "change", () => {
      const selectedVal = Array.prototype.filter.call(el.options, (o) => o.selected).map(
        (o) => number ? looseToNumber(getValue(o)) : getValue(o)
      );
      const multiple = el.multiple;
      const assignedValue = multiple ? isSet(el._modelValue) ? new Set(selectedVal) : selectedVal : selectedVal[0];
      const pending = el._pendingValue = [
        multiple,
        multiple ? isArray(assignedValue) ? selectedVal.slice() : selectedVal : assignedValue
      ];
      try {
        el[assignKey](assignedValue);
      } finally {
        nextTick(() => {
          if (el._pendingValue === pending) {
            el._pendingValue = void 0;
          }
        });
      }
    });
    el[assignKey] = getModelAssigner(vnode);
  },
  // set value in mounted & updated because <select> relies on its children
  // <option>s.
  mounted(el, { value }) {
    setSelected(el, value);
  },
  beforeUpdate(el, { value }, vnode) {
    el._modelValue = value;
    el[assignKey] = getModelAssigner(vnode);
  },
  updated(el, { value }) {
    const pending = el._pendingValue;
    el._pendingValue = void 0;
    if (!pending || pending[0] !== el.multiple || !isSameSelectValue(value, pending[1], pending[0])) {
      setSelected(el, value);
    }
  }
};
function isSameSelectValue(value, assignedValue, multiple) {
  if (!multiple) return looseEqual(value, assignedValue);
  if (isArray(value)) return looseEqual(value, assignedValue);
  if (isSet(value)) {
    if (value.size !== assignedValue.length) return false;
    for (const item of assignedValue) {
      if (!value.has(item)) return false;
    }
    return true;
  }
  return false;
}
function setSelected(el, value) {
  const isMultiple = el.multiple;
  const isArrayValue = isArray(value);
  if (isMultiple && !isArrayValue && !isSet(value)) {
    return;
  }
  for (let i = 0, l = el.options.length; i < l; i++) {
    const option = el.options[i];
    const optionValue = getValue(option);
    if (isMultiple) {
      if (isArrayValue) {
        const optionType = typeof optionValue;
        if (optionType === "string" || optionType === "number") {
          option.selected = value.some((v) => String(v) === String(optionValue));
        } else {
          option.selected = looseIndexOf(value, optionValue) > -1;
        }
      } else {
        option.selected = value.has(optionValue);
      }
    } else if (looseEqual(getValue(option), value)) {
      if (el.selectedIndex !== i) el.selectedIndex = i;
      return;
    }
  }
  if (!isMultiple && el.selectedIndex !== -1) {
    el.selectedIndex = -1;
  }
}
function getValue(el) {
  return "_value" in el ? el._value : el.value;
}
function getCheckboxValue(el, checked) {
  const key = checked ? "_trueValue" : "_falseValue";
  return key in el ? el[key] : checked;
}
const vModelDynamic = {
  created(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, "created");
  },
  mounted(el, binding, vnode) {
    callModelHook(el, binding, vnode, null, "mounted");
  },
  beforeUpdate(el, binding, vnode, prevVNode) {
    callModelHook(el, binding, vnode, prevVNode, "beforeUpdate");
  },
  updated(el, binding, vnode, prevVNode) {
    callModelHook(el, binding, vnode, prevVNode, "updated");
  }
};
function resolveDynamicModel(tagName, type) {
  switch (tagName) {
    case "SELECT":
      return vModelSelect;
    case "TEXTAREA":
      return vModelText;
    default:
      switch (type) {
        case "checkbox":
          return vModelCheckbox;
        case "radio":
          return vModelRadio;
        default:
          return vModelText;
      }
  }
}
function callModelHook(el, binding, vnode, prevVNode, hook) {
  const modelToUse = resolveDynamicModel(
    el.tagName,
    vnode.props && vnode.props.type
  );
  const fn = modelToUse[hook];
  fn && fn(el, binding, vnode, prevVNode);
}
const systemModifiers = ["ctrl", "shift", "alt", "meta"];
const modifierGuards = {
  stop: (e) => e.stopPropagation(),
  prevent: (e) => e.preventDefault(),
  self: (e) => e.target !== e.currentTarget,
  ctrl: (e) => !e.ctrlKey,
  shift: (e) => !e.shiftKey,
  alt: (e) => !e.altKey,
  meta: (e) => !e.metaKey,
  left: (e) => "button" in e && e.button !== 0,
  middle: (e) => "button" in e && e.button !== 1,
  right: (e) => "button" in e && e.button !== 2,
  exact: (e, modifiers) => systemModifiers.some((m) => e[`${m}Key`] && !modifiers.includes(m))
};
const withModifiers = (fn, modifiers) => {
  if (!fn) return fn;
  const cache = fn._withMods || (fn._withMods = {});
  const cacheKey = modifiers.join(".");
  return cache[cacheKey] || (cache[cacheKey] = ((event, ...args) => {
    for (let i = 0; i < modifiers.length; i++) {
      const guard = modifierGuards[modifiers[i]];
      if (guard && guard(event, modifiers)) return;
    }
    return fn(event, ...args);
  }));
};
const keyNames = {
  esc: "escape",
  space: " ",
  up: "arrow-up",
  left: "arrow-left",
  right: "arrow-right",
  down: "arrow-down",
  delete: "backspace"
};
const withKeys = (fn, modifiers) => {
  const cache = fn._withKeys || (fn._withKeys = {});
  const cacheKey = modifiers.join(".");
  return cache[cacheKey] || (cache[cacheKey] = ((event) => {
    if (!("key" in event)) {
      return;
    }
    const eventKey = hyphenate(event.key);
    if (modifiers.some(
      (k) => k === eventKey || keyNames[k] === eventKey
    )) {
      return fn(event);
    }
  }));
};
const rendererOptions = /* @__PURE__ */ extend({ patchProp }, nodeOps);
let renderer;
function ensureRenderer() {
  return renderer || (renderer = createRenderer(rendererOptions));
}
const createApp = ((...args) => {
  const app2 = ensureRenderer().createApp(...args);
  const { mount } = app2;
  app2.mount = (containerOrSelector) => {
    const container = normalizeContainer(containerOrSelector);
    if (!container) return;
    const component = app2._component;
    if (!isFunction(component) && !component.render && !component.template) {
      component.template = container.innerHTML;
    }
    if (container.nodeType === 1) {
      container.textContent = "";
    }
    const proxy = mount(container, false, resolveRootNamespace(container));
    if (container instanceof Element) {
      container.removeAttribute("v-cloak");
      container.setAttribute("data-v-app", "");
    }
    return proxy;
  };
  return app2;
});
function resolveRootNamespace(container) {
  if (container instanceof SVGElement) {
    return "svg";
  }
  if (typeof MathMLElement === "function" && container instanceof MathMLElement) {
    return "mathml";
  }
}
function normalizeContainer(container) {
  if (isString(container)) {
    const res = document.querySelector(container);
    return res;
  }
  return container;
}
function getExtensionBasePath() {
  const scriptUrl = (
    /* @vite-ignore */
    import.meta.url
  );
  const url = new URL(".", scriptUrl);
  return url.pathname.replace(/\/$/, "");
}
let _cachedBasePath = null;
function getExtensionPath() {
  if (_cachedBasePath === null) {
    _cachedBasePath = getExtensionBasePath();
  }
  return _cachedBasePath;
}
function extensionUrl(relativePath) {
  const basePath = getExtensionPath();
  const cleanPath = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return `${basePath}/${cleanPath}`;
}
const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};
const _hoisted_1$k = { class: "login-form" };
const _hoisted_2$k = { class: "login-header" };
const _hoisted_3$j = {
  href: "https://www.nuvulabs.ai/",
  target: "_blank",
  rel: "noopener noreferrer",
  class: "logo-link"
};
const _hoisted_4$j = ["src"];
const _hoisted_5$i = ["disabled"];
const _sfc_main$l = {
  __name: "LoginForm",
  props: {
    logoUrl: {
      type: String,
      default: null
      // Will use dynamic path
    }
  },
  emits: ["login-success", "login-error", "close"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const computedLogoUrl = props.logoUrl || extensionUrl("images/HorizontalNuvuBlack.png");
    const emit2 = __emit;
    function handleClose() {
      window.dispatchEvent(new CustomEvent("nuvu-vue-close"));
    }
    const status = /* @__PURE__ */ ref("");
    const statusType = /* @__PURE__ */ ref("");
    const isLoading = /* @__PURE__ */ ref(false);
    async function handleLogin() {
      isLoading.value = true;
      status.value = "Redirecting to authentication...";
      statusType.value = "info";
      try {
        const result = await loginWithWebsite();
        if (result) {
          status.value = "Redirecting to authentication...";
          statusType.value = "success";
          emit2("login-success");
        } else {
          throw new Error("Login initiation failed");
        }
      } catch (error) {
        console.error("nuvu: Login error:", error);
        status.value = `Authentication failed: ${error.message}`;
        statusType.value = "error";
        isLoading.value = false;
        emit2("login-error", error);
      }
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$k, [
        createBaseVNode("button", {
          class: "close-btn",
          onClick: handleClose,
          title: "Close"
        }, [..._cache[0] || (_cache[0] = [
          createBaseVNode("svg", {
            width: "24",
            height: "24",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2"
          }, [
            createBaseVNode("path", { d: "M18 6L6 18M6 6l12 12" })
          ], -1)
        ])]),
        createBaseVNode("div", _hoisted_2$k, [
          _cache[1] || (_cache[1] = createBaseVNode("span", { class: "welcome-text" }, "Welcome to", -1)),
          createBaseVNode("a", _hoisted_3$j, [
            createBaseVNode("img", {
              src: unref(computedLogoUrl),
              alt: "Nuvu",
              class: "login-logo"
            }, null, 8, _hoisted_4$j)
          ])
        ]),
        createBaseVNode("button", {
          class: "login-btn nuvu-btn nuvu-btn-primary nuvu-btn-large",
          disabled: isLoading.value,
          onClick: handleLogin
        }, [
          _cache[2] || (_cache[2] = createBaseVNode("svg", {
            width: "20",
            height: "20",
            viewBox: "0 0 24 24",
            fill: "currentColor"
          }, [
            createBaseVNode("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" })
          ], -1)),
          createBaseVNode("span", null, toDisplayString(isLoading.value ? "Redirecting..." : "Continue with Login"), 1)
        ], 8, _hoisted_5$i),
        _cache[3] || (_cache[3] = createBaseVNode("p", { class: "auth-note" }, " Authentication handled securely by Auth0 ", -1)),
        createVNode(Transition, { name: "fade" }, {
          default: withCtx(() => [
            status.value ? (openBlock(), createElementBlock("div", {
              key: 0,
              class: normalizeClass(["status-message", statusType.value])
            }, toDisplayString(status.value), 3)) : createCommentVNode("", true)
          ]),
          _: 1
        }),
        _cache[4] || (_cache[4] = createBaseVNode("p", { class: "visit-link" }, [
          createTextVNode(" Visit us and watch the demo at "),
          createBaseVNode("a", {
            href: "https://www.nuvulabs.ai/comfyui",
            target: "_blank",
            rel: "noopener noreferrer"
          }, "nuvulabs.ai")
        ], -1))
      ]);
    };
  }
};
const LoginForm = /* @__PURE__ */ _export_sfc(_sfc_main$l, [["__scopeId", "data-v-c179b86c"]]);
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1e3;
const HEARTBEAT_MAX_RETRIES = 3;
const HEARTBEAT_RETRY_DELAYS = [1e3, 3e3, 5e3];
let heartbeatIntervalId = null;
let currentSessionId = null;
let sessionAcquired = false;
let heartbeatRetryCount = 0;
async function acquireFloatingSession(orgId, userId, email) {
  const apiToken = getActiveApiToken();
  if (!apiToken) {
    return { success: false, error: "Not authenticated" };
  }
  try {
    const response = await fetch("/nuvu/auth/floating-session", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        organizationId: orgId,
        userId,
        email
      })
    });
    if (!response.ok) {
      const data2 = await response.json().catch(() => ({}));
      const errorMsg = data2.error || "Failed to acquire floating license";
      if (response.status === 403) {
        return {
          success: false,
          error: "All floating licenses are currently in use. Please try again later.",
          allInUse: true
        };
      }
      return { success: false, error: errorMsg };
    }
    const data = await response.json();
    if (data.success && data.session_id) {
      currentSessionId = data.session_id;
      sessionAcquired = true;
      startHeartbeat();
      setGlobalState("floatingSession", {
        sessionId: data.session_id,
        expiresAt: data.expires_at,
        acquiredAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      console.log("[FLOATING] Session acquired:", data.session_id);
      return {
        success: true,
        session_id: data.session_id,
        expires_at: data.expires_at,
        refreshed: data.refreshed || false
      };
    }
    return { success: false, error: "Invalid response from server" };
  } catch (error) {
    console.error("[FLOATING] Error acquiring session:", error);
    return { success: false, error: error.message || "Network error" };
  }
}
function startHeartbeat() {
  stopHeartbeat();
  heartbeatIntervalId = setInterval(async () => {
    if (currentSessionId) {
      await sendHeartbeat(currentSessionId);
    }
  }, HEARTBEAT_INTERVAL_MS);
  console.log("[FLOATING] Heartbeat started");
}
function stopHeartbeat() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
    console.log("[FLOATING] Heartbeat stopped");
  }
}
async function sendHeartbeat(sessionId, retryAttempt = 0) {
  await proactivelyRefreshIfNeeded();
  const apiToken = getActiveApiToken();
  if (!apiToken) {
    console.warn("[FLOATING] No API token, skipping heartbeat");
    return false;
  }
  try {
    const response = await fetch("/nuvu/auth/floating-heartbeat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId })
    });
    if (!response.ok) {
      console.error("[FLOATING] Heartbeat failed:", response.status);
      if (response.status === 404 || response.status === 403) {
        handleSessionExpired();
        return false;
      }
      if (response.status >= 500 && retryAttempt < HEARTBEAT_MAX_RETRIES) {
        const delay = HEARTBEAT_RETRY_DELAYS[retryAttempt] || HEARTBEAT_RETRY_DELAYS[HEARTBEAT_RETRY_DELAYS.length - 1];
        console.log(`[FLOATING] Retrying heartbeat in ${delay}ms (attempt ${retryAttempt + 1}/${HEARTBEAT_MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return sendHeartbeat(sessionId, retryAttempt + 1);
      }
      if (response.status >= 500) {
        console.error("[FLOATING] Heartbeat failed after all retries");
      }
      return false;
    }
    const data = await response.json();
    heartbeatRetryCount = 0;
    if (data.expires_at) {
      const floatingSession2 = getGlobalState("floatingSession") || {};
      setGlobalState("floatingSession", {
        ...floatingSession2,
        expiresAt: data.expires_at
      });
    }
    console.log("[FLOATING] Heartbeat sent successfully");
    return true;
  } catch (error) {
    console.error("[FLOATING] Heartbeat error:", error);
    if (retryAttempt < HEARTBEAT_MAX_RETRIES) {
      const delay = HEARTBEAT_RETRY_DELAYS[retryAttempt] || HEARTBEAT_RETRY_DELAYS[HEARTBEAT_RETRY_DELAYS.length - 1];
      console.log(`[FLOATING] Retrying heartbeat in ${delay}ms after network error (attempt ${retryAttempt + 1}/${HEARTBEAT_MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return sendHeartbeat(sessionId, retryAttempt + 1);
    }
    console.error("[FLOATING] Heartbeat failed after all retries due to network error");
    return false;
  }
}
async function releaseFloatingSession() {
  if (!currentSessionId) {
    console.log("[FLOATING] No session to release");
    return true;
  }
  const sessionId = currentSessionId;
  stopHeartbeat();
  currentSessionId = null;
  sessionAcquired = false;
  setGlobalState("floatingSession", null);
  const apiToken = getActiveApiToken();
  if (!apiToken) {
    console.warn("[FLOATING] No API token, session will expire naturally");
    return true;
  }
  try {
    const response = await fetch(`/nuvu/auth/floating-session/${sessionId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      }
    });
    if (response.ok) {
      console.log("[FLOATING] Session released:", sessionId);
      return true;
    } else {
      console.warn("[FLOATING] Failed to release session:", response.status);
      return false;
    }
  } catch (error) {
    console.error("[FLOATING] Error releasing session:", error);
    return false;
  }
}
function handleSessionExpired() {
  console.warn("[FLOATING] Session expired");
  stopHeartbeat();
  currentSessionId = null;
  sessionAcquired = false;
  setGlobalState("floatingSession", null);
  window.dispatchEvent(new CustomEvent("nuvu:floating-session-expired"));
}
function hasActiveFloatingSession() {
  return sessionAcquired && currentSessionId !== null;
}
async function restoreFloatingSession() {
  const storedSession = getGlobalState();
  if (!storedSession || !storedSession.sessionId) {
    return false;
  }
  const expiresAt = new Date(storedSession.expiresAt);
  if (expiresAt <= /* @__PURE__ */ new Date()) {
    setGlobalState("floatingSession", null);
    return false;
  }
  currentSessionId = storedSession.sessionId;
  sessionAcquired = true;
  const heartbeatSuccess = await sendHeartbeat(currentSessionId);
  if (heartbeatSuccess) {
    startHeartbeat();
    console.log("[FLOATING] Session restored:", currentSessionId);
    return true;
  } else {
    currentSessionId = null;
    sessionAcquired = false;
    setGlobalState("floatingSession", null);
    return false;
  }
}
function setupWindowCloseHandler() {
  window.addEventListener("beforeunload", () => {
    if (currentSessionId) {
      const apiToken = getActiveApiToken();
      if (apiToken) {
        try {
          fetch(`/nuvu/auth/floating-session/${currentSessionId}`, {
            method: "DELETE",
            keepalive: true,
            headers: {
              "Authorization": `Bearer ${apiToken}`,
              "Content-Type": "application/json"
            }
          }).catch(() => {
          });
        } catch {
          const blob = new Blob([JSON.stringify({ token: apiToken })], { type: "application/json" });
          navigator.sendBeacon(`/nuvu/auth/floating-session/${currentSessionId}/release`, blob);
        }
      }
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentSessionId) {
      const floatingSession2 = getGlobalState();
      if (floatingSession2 && floatingSession2.expiresAt) {
        const expiresAt = new Date(floatingSession2.expiresAt);
        if (expiresAt > /* @__PURE__ */ new Date()) {
          sendHeartbeat(currentSessionId);
        } else {
          handleSessionExpired();
        }
      } else {
        sendHeartbeat(currentSessionId);
      }
    }
  });
}
setupWindowCloseHandler();
function clearLocalAuthStorage() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  const explicitKeys = [
    "api_token",
    "user_token",
    "auth_access_token",
    "auth_expires_at",
    "oauth_state",
    "nuvu_show_splash_after_refresh"
  ];
  const dynamicKeys = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith("nuvu_")) {
      dynamicKeys.push(key);
    }
  }
  const keysToClear = Array.from(/* @__PURE__ */ new Set([...explicitKeys, ...dynamicKeys]));
  keysToClear.forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
    }
  });
  if (typeof window.sessionStorage !== "undefined") {
    try {
      const sessionKeys = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && key.startsWith("nuvu_")) {
          sessionKeys.push(key);
        }
      }
      sessionKeys.forEach((key) => window.sessionStorage.removeItem(key));
    } catch (error) {
    }
  }
}
async function buildLogoutUrl() {
  const baseUrl = getWebsiteBaseUrl();
  const callbackUrl = getCallbackUrl();
  if (!baseUrl || !callbackUrl) {
    return null;
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const redirectParam = encodeURIComponent(callbackUrl);
  return `${normalizedBase}/api/auth/logout?redirect=${redirectParam}`;
}
async function logoutWebsite() {
  if (hasActiveFloatingSession()) {
    try {
      await releaseFloatingSession();
      console.log("[nuvu] Released floating license session on logout");
    } catch (error) {
      console.warn("[nuvu] Failed to release floating session on logout:", error);
    }
  }
  clearLocalAuthStorage();
  const cookiesToClear = [
    "auth_access_token",
    "auth_expires_at",
    "oauth_state"
  ];
  cookiesToClear.forEach((cookieName) => {
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=localhost;`;
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=;`;
  });
  setAuthenticated(false);
  setCurrentUser(null);
  setCurrentLicenseStatus(null);
  if (nuvuDialog) {
    try {
      nuvuDialog.style.display = "none";
      nuvuDialog.setAttribute("aria-hidden", "true");
    } catch (error) {
    }
  }
  const logoutUrl = await buildLogoutUrl();
  if (logoutUrl) {
    window.location.href = logoutUrl;
  } else {
    window.location.reload();
  }
}
async function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${currentUser?.apiToken || ""}`
  };
}
async function getApiToken() {
  return currentUser?.apiToken || null;
}
async function logout() {
  await logoutWebsite();
}
const _hoisted_1$j = { class: "user-section" };
const _hoisted_2$j = ["src"];
const _hoisted_3$i = { class: "welcome" };
const _hoisted_4$i = { class: "user-name" };
const _hoisted_5$h = ["title"];
const _hoisted_6$g = {
  key: 0,
  class: "organization-name"
};
const _hoisted_7$g = {
  key: 1,
  class: "floating-unavailable-warning"
};
const _hoisted_8$g = { class: "warning-text" };
const _hoisted_9$f = {
  key: 2,
  class: "device-warning"
};
const _hoisted_10$e = { class: "tab-nav" };
const _hoisted_11$e = ["onClick"];
const _hoisted_12$d = { class: "tab-label" };
const _hoisted_13$c = {
  key: 0,
  class: "update-badge",
  title: "Update available"
};
const _hoisted_14$c = { class: "utility-btns" };
const websiteUrl = "https://nuvulabs.ai";
const pricingUrl = "https://app.nuvulabs.ai/#pricing";
const _sfc_main$k = {
  __name: "Sidebar",
  props: {
    tabs: {
      type: Array,
      required: true
    },
    activeTab: {
      type: String,
      required: true
    },
    user: {
      type: Object,
      default: () => ({})
    },
    licenseStatus: {
      type: Object,
      default: null
    },
    nuvuUpdateAvailable: {
      type: Boolean,
      default: false
    },
    deviceRegistered: {
      type: Boolean,
      default: true
    }
  },
  emits: ["tab-change", "logout", "restart", "refresh"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const sidebarRef = /* @__PURE__ */ ref(null);
    const sidebarScale = /* @__PURE__ */ ref(1);
    let resizeObserver = null;
    let mutationObserver = null;
    const userName = computed(() => {
      return props.user?.name || props.user?.username || "User";
    });
    const licenseMessage = computed(() => props.licenseStatus?.message || "");
    const licenseBadgeText = computed(() => {
      if (!props.licenseStatus) return "Checking subscription...";
      if (props.licenseStatus.statusClass === "floating-unavailable") {
        return "No License Available";
      }
      if (props.licenseStatus.isActive && props.licenseStatus.licenseType) {
        const type = props.licenseStatus.licenseType;
        if (type === "named") return "Enterprise (Named)";
        if (type === "floating") return "Enterprise (Floating)";
        if (type === "enterprise") return "Enterprise";
      }
      return props.licenseStatus.isActive ? "Premium Subscription" : "No Subscription";
    });
    const organizationName = computed(() => {
      return props.licenseStatus?.organization || null;
    });
    const showFloatingUnavailable = computed(() => {
      return props.licenseStatus?.statusClass === "floating-unavailable";
    });
    const showRetryButton = computed(() => {
      return props.licenseStatus?.showRetryButton || false;
    });
    const licenseStyle = computed(() => {
      if (!props.licenseStatus?.style) return {};
      const styleStr = props.licenseStatus.style;
      const styleObj = {};
      styleStr.split(";").forEach((pair) => {
        const [key, value] = pair.split(":").map((s) => s?.trim());
        if (key && value) {
          const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          styleObj[camelKey] = value;
        }
      });
      return styleObj;
    });
    const showPurchaseLink = computed(() => {
      return props.licenseStatus?.showPurchaseLink || false;
    });
    const logoUrl = extensionUrl("images/NuvuLogo.png");
    const sidebarInnerStyle = computed(() => {
      const scale = sidebarScale.value;
      if (Math.abs(scale - 1) < 1e-3) {
        return {};
      }
      return {
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width: `${(100 / scale).toFixed(3)}%`
      };
    });
    function recalcSidebarScale() {
      const el = sidebarRef.value;
      if (!el) return;
      const { clientHeight, scrollHeight } = el;
      if (!clientHeight) {
        sidebarScale.value = 1;
        return;
      }
      if (scrollHeight > clientHeight + 1) {
        const nextScale = Math.max(clientHeight / scrollHeight, 0.75);
        sidebarScale.value = Number(nextScale.toFixed(4));
      } else {
        sidebarScale.value = 1;
      }
    }
    function observeSidebar() {
      if (!sidebarRef.value) return;
      resizeObserver = new ResizeObserver(() => recalcSidebarScale());
      resizeObserver.observe(sidebarRef.value);
      mutationObserver = new MutationObserver(() => nextTick(() => recalcSidebarScale()));
      mutationObserver.observe(sidebarRef.value, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    onMounted(() => {
      nextTick(() => {
        recalcSidebarScale();
        observeSidebar();
      });
    });
    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    });
    watch(
      () => [props.licenseStatus, props.user, props.tabs, props.activeTab],
      () => nextTick(() => recalcSidebarScale()),
      { deep: true }
    );
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("aside", {
        class: "sidebar",
        ref_key: "sidebarRef",
        ref: sidebarRef
      }, [
        createBaseVNode("div", {
          class: "sidebar-inner",
          style: normalizeStyle(sidebarInnerStyle.value)
        }, [
          createBaseVNode("div", _hoisted_1$j, [
            createBaseVNode("a", {
              href: websiteUrl,
              target: "_blank",
              rel: "noopener noreferrer",
              class: "logo-link"
            }, [
              createBaseVNode("img", {
                src: unref(logoUrl),
                alt: "Nuvu",
                class: "logo"
              }, null, 8, _hoisted_2$j)
            ]),
            createBaseVNode("div", _hoisted_3$i, [
              _cache[4] || (_cache[4] = createBaseVNode("h2", null, "Welcome back!", -1)),
              createBaseVNode("p", _hoisted_4$i, toDisplayString(userName.value), 1)
            ]),
            createBaseVNode("div", {
              class: "license-status",
              style: normalizeStyle(licenseStyle.value),
              title: licenseMessage.value
            }, toDisplayString(licenseBadgeText.value), 13, _hoisted_5$h),
            organizationName.value ? (openBlock(), createElementBlock("div", _hoisted_6$g, toDisplayString(organizationName.value), 1)) : createCommentVNode("", true),
            showFloatingUnavailable.value ? (openBlock(), createElementBlock("div", _hoisted_7$g, [
              _cache[5] || (_cache[5] = createBaseVNode("div", { class: "warning-icon" }, "!", -1)),
              createBaseVNode("div", _hoisted_8$g, toDisplayString(licenseMessage.value), 1),
              showRetryButton.value ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "retry-btn",
                onClick: _cache[0] || (_cache[0] = ($event) => emit2("refresh"))
              }, " Retry ")) : createCommentVNode("", true)
            ])) : createCommentVNode("", true),
            !__props.deviceRegistered ? (openBlock(), createElementBlock("div", _hoisted_9$f, " Device not registered ")) : createCommentVNode("", true),
            showPurchaseLink.value ? (openBlock(), createElementBlock("a", {
              key: 3,
              href: pricingUrl,
              target: "_blank",
              class: "purchase-btn"
            }, " Purchase License ")) : createCommentVNode("", true)
          ]),
          createBaseVNode("nav", _hoisted_10$e, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(__props.tabs, (tab) => {
              return openBlock(), createElementBlock("button", {
                key: tab.id,
                class: normalizeClass(["tab-btn", {
                  active: __props.activeTab === tab.id,
                  "has-update": tab.id === "optimizer" && __props.nuvuUpdateAvailable
                }]),
                onClick: ($event) => emit2("tab-change", tab.id)
              }, [
                createBaseVNode("span", _hoisted_12$d, toDisplayString(tab.label), 1),
                tab.id === "optimizer" && __props.nuvuUpdateAvailable ? (openBlock(), createElementBlock("span", _hoisted_13$c, [..._cache[6] || (_cache[6] = [
                  createBaseVNode("svg", {
                    class: "update-arrow-icon",
                    width: "12",
                    height: "12",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "3"
                  }, [
                    createBaseVNode("path", { d: "M12 19V5M5 12l7-7 7 7" })
                  ], -1)
                ])])) : createCommentVNode("", true)
              ], 10, _hoisted_11$e);
            }), 128)),
            createBaseVNode("button", {
              class: "tab-btn logout-btn",
              onClick: _cache[1] || (_cache[1] = ($event) => emit2("logout"))
            }, " Logout ")
          ]),
          createBaseVNode("div", _hoisted_14$c, [
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              onClick: _cache[2] || (_cache[2] = ($event) => emit2("restart"))
            }, " Restart ComfyUI "),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              onClick: _cache[3] || (_cache[3] = ($event) => emit2("refresh"))
            }, " Refresh Page ")
          ])
        ], 4)
      ], 512);
    };
  }
};
const Sidebar = /* @__PURE__ */ _export_sfc(_sfc_main$k, [["__scopeId", "data-v-76815f6f"]]);
const _hoisted_1$i = { class: "card-media" };
const _hoisted_2$i = {
  key: 0,
  class: "media-placeholder"
};
const _hoisted_3$h = ["data-workflow-video", "src"];
const _hoisted_4$h = ["src"];
const _hoisted_5$g = ["data-workflow-video", "data-workflow-video-primary", "src"];
const _hoisted_6$f = ["src"];
const _hoisted_7$f = ["value"];
const _hoisted_8$f = {
  key: 2,
  class: "media-single"
};
const _hoisted_9$e = ["data-workflow-video", "data-workflow-video-primary", "src"];
const _hoisted_10$d = ["src"];
const _hoisted_11$d = { class: "card-content" };
const _hoisted_12$c = ["checked", "disabled"];
const _hoisted_13$b = { class: "workflow-name" };
const _hoisted_14$b = {
  key: 0,
  class: "lock-icon"
};
const _hoisted_15$a = { class: "workflow-description" };
const _hoisted_16$a = {
  key: 0,
  class: "preview-note"
};
const _sfc_main$j = {
  __name: "WorkflowCard",
  props: {
    workflow: {
      type: Object,
      required: true
    },
    isSelected: {
      type: Boolean,
      default: false
    },
    playVideoSound: {
      type: Boolean,
      default: false
    }
  },
  emits: ["toggle", "media-expired"],
  setup(__props, { emit: __emit }) {
    const nuvuVersions = inject("nuvuVersions", null);
    const licenseStatus = inject("licenseStatus", null);
    const props = __props;
    const emit2 = __emit;
    const sliderValue = /* @__PURE__ */ ref(50);
    const isHovering = /* @__PURE__ */ ref(false);
    const mediaCompareRef = /* @__PURE__ */ ref(null);
    const hasAttemptedRefreshOnError = /* @__PURE__ */ ref(false);
    const effectiveMedia = computed(() => {
      return props.workflow.media || [];
    });
    function isMediaExpired(mediaItem) {
      if (!mediaItem || typeof mediaItem !== "object") return true;
      const explicitExpires = mediaItem.fileUrlExpiresAt || mediaItem.file_url_expires_at;
      if (explicitExpires) {
        const expiryTime = new Date(explicitExpires).getTime();
        if (!isNaN(expiryTime) && expiryTime < Date.now()) {
          return true;
        }
      }
      const source = mediaItem.fileUrl || mediaItem.file_url || mediaItem.proxyUrl || mediaItem.proxy_url || mediaItem.url || mediaItem.file || "";
      if (!source) return true;
      try {
        const urlObj = new URL(source, "http://dummy.com");
        const expiresParam = urlObj.searchParams.get("Expires");
        if (expiresParam) {
          const expiryTimestamp = parseInt(expiresParam, 10) * 1e3;
          if (!isNaN(expiryTimestamp) && expiryTimestamp < Date.now() + 1e4) {
            return true;
          }
        }
      } catch (e) {
      }
      return false;
    }
    function getMediaSource(mediaItem) {
      if (!mediaItem || typeof mediaItem !== "object") return "";
      if (isMediaExpired(mediaItem)) return "";
      return mediaItem.fileUrl || mediaItem.file_url || mediaItem.proxyUrl || mediaItem.proxy_url || mediaItem.url || mediaItem.file || "";
    }
    function checkAndRefreshExpiredMedia() {
      const media = effectiveMedia.value;
      if (!Array.isArray(media) || media.length === 0) return;
      const hasExpired = media.some((item) => isMediaExpired(item));
      if (hasExpired && !hasAttemptedRefreshOnError.value) {
        hasAttemptedRefreshOnError.value = true;
        emit2("media-expired", { workflowId: workflowId.value });
      }
    }
    const validMediaItems = computed(() => {
      if (!Array.isArray(effectiveMedia.value)) return [];
      return effectiveMedia.value.filter((item) => item && getMediaSource(item));
    });
    const hasComparison = computed(() => validMediaItems.value.length >= 2);
    const primaryMedia = computed(() => validMediaItems.value[0] || null);
    const secondaryMedia = computed(() => validMediaItems.value[1] || null);
    const isPreview = computed(() => props.workflow._previewMode);
    const workflowId = computed(() => props.workflow.id || props.workflow.__workflowGeneratedId);
    function calculateWorkflowModelSizeGB(workflow) {
      if (!workflow) return 0;
      if (typeof workflow.totalModelSizeGB === "number" && workflow.totalModelSizeGB > 0) {
        return workflow.totalModelSizeGB;
      }
      let modelRefs = [];
      if (Array.isArray(workflow.models)) {
        modelRefs = workflow.models;
      } else if (workflow.dependencies) {
        const deps = workflow.dependencies;
        if (deps.M?.models?.L) {
          modelRefs = deps.M.models.L.map((item) => item.M || item);
        } else if (Array.isArray(deps.models)) {
          modelRefs = deps.models;
        }
      }
      if (modelRefs.length === 0) return 0;
      const modelsLibrary = state.modelsData || [];
      if (modelsLibrary.length === 0) return 0;
      const libraryByName = /* @__PURE__ */ new Map();
      const libraryById = /* @__PURE__ */ new Map();
      for (const m of modelsLibrary) {
        if (!m) continue;
        if (m.id) libraryById.set(m.id, m);
        const name = (m.modelName || m.name || "").toLowerCase();
        if (name) libraryByName.set(name, m);
      }
      let totalSizeGB = 0;
      const countedIds = /* @__PURE__ */ new Set();
      for (const ref2 of modelRefs) {
        if (!ref2) continue;
        let libraryModel = null;
        const refId = ref2.id || ref2.libraryId;
        if (refId && libraryById.has(refId)) {
          libraryModel = libraryById.get(refId);
        }
        if (!libraryModel) {
          const refName = (ref2.name || ref2.modelName || ref2.filename || "").toLowerCase();
          if (refName && libraryByName.has(refName)) {
            libraryModel = libraryByName.get(refName);
          }
        }
        if (libraryModel && libraryModel.size && !countedIds.has(libraryModel.id)) {
          countedIds.add(libraryModel.id);
          totalSizeGB += libraryModel.size;
        }
      }
      return totalSizeGB;
    }
    const vramCompatibilityClass = computed(() => {
      if (!licenseStatus?.isActive) return "";
      const vramGB = nuvuVersions?.value?.gpu?.vram_gb;
      if (!vramGB || vramGB <= 0) return "";
      const modelSizeGB = calculateWorkflowModelSizeGB(props.workflow);
      if (modelSizeGB <= 0) return "vram-compatible";
      const ratio = modelSizeGB / vramGB;
      if (ratio >= 3) return "vram-incompatible";
      if (ratio >= 2) return "vram-warning";
      return "vram-compatible";
    });
    function isVideo(mediaItem) {
      return mediaItem?.type === "video";
    }
    function handleCardClick() {
      if (!isPreview.value) {
        emit2("toggle", workflowId.value);
      }
    }
    function handleCheckboxChange(event) {
      event.stopPropagation();
      emit2("toggle", workflowId.value);
    }
    function handleSliderInput(event) {
      sliderValue.value = parseFloat(event.target.value);
    }
    function handleMouseMove(event) {
      if (!mediaCompareRef.value) return;
      const rect = mediaCompareRef.value.getBoundingClientRect();
      if (!rect.width) return;
      const percent = (event.clientX - rect.left) / rect.width * 100;
      sliderValue.value = Math.max(0, Math.min(100, percent));
    }
    function handleTouchMove(event) {
      if (!mediaCompareRef.value) return;
      event.preventDefault();
      const touch = event.touches[0];
      if (!touch) return;
      const rect = mediaCompareRef.value.getBoundingClientRect();
      if (!rect.width) return;
      const percent = (touch.clientX - rect.left) / rect.width * 100;
      sliderValue.value = Math.max(0, Math.min(100, percent));
    }
    function handleMouseEnter() {
      isHovering.value = true;
      playVideos();
    }
    function handleMouseLeave() {
      isHovering.value = false;
      pauseVideos();
    }
    function playVideos() {
      const videos = document.querySelectorAll(`[data-workflow-video="${workflowId.value}"]`);
      const primaryVideoEl = document.querySelector(`[data-workflow-video-primary="${workflowId.value}"]`);
      videos.forEach((video) => {
        if (video && video.paused) {
          video.play().catch(() => {
          });
        }
      });
      if (props.playVideoSound && primaryVideoEl) {
        primaryVideoEl.muted = false;
      }
    }
    function pauseVideos() {
      const videos = document.querySelectorAll(`[data-workflow-video="${workflowId.value}"]`);
      videos.forEach((video) => {
        if (video && !video.paused) {
          video.pause();
          video.currentTime = 0;
        }
        if (video) {
          video.muted = true;
        }
      });
    }
    function handleMediaError(event) {
      if (hasAttemptedRefreshOnError.value) return;
      hasAttemptedRefreshOnError.value = true;
      emit2("media-expired", { workflowId: workflowId.value });
    }
    const overlayClipStyle = computed(() => ({
      clipPath: `inset(0 ${100 - sliderValue.value}% 0 0)`
    }));
    const sliderLineStyle = computed(() => ({
      "--slider-position": `${sliderValue.value}%`
    }));
    onMounted(() => {
      checkAndRefreshExpiredMedia();
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", {
        class: normalizeClass(["workflow-card", [
          vramCompatibilityClass.value,
          {
            selected: __props.isSelected,
            preview: isPreview.value
          }
        ]]),
        onClick: handleCardClick,
        onMouseenter: handleMouseEnter,
        onMouseleave: handleMouseLeave
      }, [
        createBaseVNode("div", _hoisted_1$i, [
          validMediaItems.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_2$i)) : hasComparison.value ? (openBlock(), createElementBlock("div", {
            key: 1,
            ref_key: "mediaCompareRef",
            ref: mediaCompareRef,
            class: "media-compare",
            onMousemove: handleMouseMove,
            onTouchmove: handleTouchMove,
            onTouchstart: handleTouchMove
          }, [
            isVideo(secondaryMedia.value) ? (openBlock(), createElementBlock("video", {
              key: 0,
              class: "media-layer",
              "data-workflow-video": workflowId.value,
              src: getMediaSource(secondaryMedia.value),
              muted: "",
              playsinline: "",
              loop: "",
              onError: handleMediaError
            }, null, 40, _hoisted_3$h)) : (openBlock(), createElementBlock("img", {
              key: 1,
              class: "media-layer",
              src: getMediaSource(secondaryMedia.value),
              alt: "Workflow media",
              loading: "lazy",
              onError: handleMediaError
            }, null, 40, _hoisted_4$h)),
            isVideo(primaryMedia.value) ? (openBlock(), createElementBlock("video", {
              key: 2,
              class: "media-layer compare-overlay",
              "data-workflow-video": workflowId.value,
              "data-workflow-video-primary": workflowId.value,
              src: getMediaSource(primaryMedia.value),
              style: normalizeStyle(overlayClipStyle.value),
              muted: "",
              playsinline: "",
              loop: "",
              onError: handleMediaError
            }, null, 44, _hoisted_5$g)) : (openBlock(), createElementBlock("img", {
              key: 3,
              class: "media-layer compare-overlay",
              src: getMediaSource(primaryMedia.value),
              style: normalizeStyle(overlayClipStyle.value),
              alt: "Workflow media",
              loading: "lazy",
              onError: handleMediaError
            }, null, 44, _hoisted_6$f)),
            createBaseVNode("div", {
              class: "slider-visual",
              style: normalizeStyle(sliderLineStyle.value)
            }, [..._cache[1] || (_cache[1] = [
              createBaseVNode("div", { class: "slider-line" }, null, -1)
            ])], 4),
            createBaseVNode("input", {
              type: "range",
              min: "0",
              max: "100",
              value: sliderValue.value,
              class: "slider-input",
              onInput: handleSliderInput,
              "aria-label": "Compare workflow media"
            }, null, 40, _hoisted_7$f)
          ], 544)) : (openBlock(), createElementBlock("div", _hoisted_8$f, [
            isVideo(primaryMedia.value) ? (openBlock(), createElementBlock("video", {
              key: 0,
              class: "media-layer",
              "data-workflow-video": workflowId.value,
              "data-workflow-video-primary": workflowId.value,
              src: getMediaSource(primaryMedia.value),
              muted: "",
              playsinline: "",
              loop: "",
              onError: handleMediaError
            }, null, 40, _hoisted_9$e)) : (openBlock(), createElementBlock("img", {
              key: 1,
              class: "media-layer",
              src: getMediaSource(primaryMedia.value),
              alt: "Workflow media",
              loading: "lazy",
              onError: handleMediaError
            }, null, 40, _hoisted_10$d))
          ]))
        ]),
        createBaseVNode("div", _hoisted_11$d, [
          createBaseVNode("label", {
            class: "card-header",
            onClick: _cache[0] || (_cache[0] = withModifiers(() => {
            }, ["stop"]))
          }, [
            createBaseVNode("input", {
              type: "checkbox",
              checked: __props.isSelected,
              disabled: isPreview.value,
              onChange: handleCheckboxChange
            }, null, 40, _hoisted_12$c),
            createBaseVNode("span", _hoisted_13$b, [
              createTextVNode(toDisplayString(__props.workflow.name || "Unnamed Workflow") + " ", 1),
              isPreview.value ? (openBlock(), createElementBlock("span", _hoisted_14$b, "🔒")) : createCommentVNode("", true)
            ])
          ]),
          createBaseVNode("p", _hoisted_15$a, toDisplayString(__props.workflow.description || "No description available"), 1),
          isPreview.value ? (openBlock(), createElementBlock("p", _hoisted_16$a, " Subscribe to download ")) : createCommentVNode("", true)
        ])
      ], 34);
    };
  }
};
const WorkflowCard = /* @__PURE__ */ _export_sfc(_sfc_main$j, [["__scopeId", "data-v-c59e4f0a"]]);
const QUEUE_PROGRESS_KEY = /* @__PURE__ */ Symbol("nuvu:queue-progress");
function useQueueProgress() {
  const ctx = inject(QUEUE_PROGRESS_KEY, null);
  if (!ctx) {
    throw new Error("useQueueProgress() must be used within <QueueProgressProvider>");
  }
  return ctx;
}
const _hoisted_1$h = {
  key: 0,
  class: "progress-container"
};
const _hoisted_2$h = {
  key: 0,
  class: "progress-title"
};
const _hoisted_3$g = { class: "progress-summary" };
const _hoisted_4$g = {
  key: 1,
  class: "progress-file"
};
const _hoisted_5$f = { class: "progress-bar-track" };
const _sfc_main$i = {
  __name: "QueueProgress",
  props: {
    phases: {
      type: Array,
      default: () => []
    },
    title: {
      type: String,
      default: ""
    },
    alwaysShowWhileActive: {
      type: Boolean,
      default: true
    }
  },
  setup(__props) {
    const props = __props;
    const { isActive, downloadProgress } = useQueueProgress();
    const normalizedPhases = computed(() => {
      return (Array.isArray(props.phases) ? props.phases : []).map((p2) => typeof p2 === "string" ? p2.trim() : "").filter(Boolean);
    });
    function phaseObj(p2, key) {
      const obj = p2?.[key];
      if (!obj || typeof obj !== "object") return null;
      const total = Number(obj.total || 0);
      const current = Number(obj.current || 0);
      if (!Number.isFinite(total) || !Number.isFinite(current) || total <= 0) return null;
      return { current, total };
    }
    const hasRelevantWork = computed(() => {
      const p2 = downloadProgress.value;
      if (!p2) return false;
      for (const key of normalizedPhases.value) {
        if (phaseObj(p2, key)) return true;
      }
      if (normalizedPhases.value.includes(p2?.current_phase)) return true;
      return false;
    });
    const visible = computed(() => {
      if (!isActive.value) return false;
      if (!props.alwaysShowWhileActive) return hasRelevantWork.value;
      return normalizedPhases.value.length === 0 ? true : hasRelevantWork.value;
    });
    const percent = computed(() => {
      const p2 = downloadProgress.value;
      if (!p2) return 0;
      const raw = Number(p2.percent || 0);
      if (Number.isFinite(raw) && raw > 0) {
        return Math.max(0, Math.min(100, raw));
      }
      const fracs = [];
      for (const key of normalizedPhases.value) {
        const obj = phaseObj(p2, key);
        if (!obj) continue;
        fracs.push(Math.max(0, Math.min(1, obj.current / obj.total)));
      }
      if (fracs.length === 0) return 0;
      return Math.round(fracs.reduce((a, b) => a + b, 0) / fracs.length * 100);
    });
    const summaryText = computed(() => {
      const p2 = downloadProgress.value;
      if (!p2) return "Working...";
      const labelMap = {
        workflows: "Workflows",
        subgraphs: "Subgraphs",
        custom_nodes: "Custom Nodes",
        models: "Models"
      };
      const parts = [];
      const keys = normalizedPhases.value.length > 0 ? normalizedPhases.value : Object.keys(labelMap);
      for (const key of keys) {
        const obj = phaseObj(p2, key);
        if (!obj) continue;
        const done = obj.current >= obj.total;
        parts.push(`${labelMap[key] || key}: ${done ? "✓" : `${obj.current}/${obj.total}`}`);
      }
      if (parts.length > 0) return parts.join(" | ");
      if (p2.message) return p2.message;
      return "Working...";
    });
    const fileText = computed(() => {
      const p2 = downloadProgress.value;
      if (!p2) return "";
      if (normalizedPhases.value.length > 0 && !normalizedPhases.value.includes(p2.current_phase)) {
        return "";
      }
      const fname = typeof p2.filename === "string" ? p2.filename : "";
      const raw = Number(p2.percent || 0);
      if (!fname) return "";
      if (raw > 0) {
        let t = `${fname}: ${Math.round(raw)}%`;
        if (p2.downloaded && p2.total) {
          t += ` (${p2.downloaded}/${p2.total})`;
        }
        return t;
      }
      return fname;
    });
    return (_ctx, _cache) => {
      return visible.value ? (openBlock(), createElementBlock("div", _hoisted_1$h, [
        __props.title ? (openBlock(), createElementBlock("div", _hoisted_2$h, toDisplayString(__props.title), 1)) : createCommentVNode("", true),
        createBaseVNode("div", _hoisted_3$g, toDisplayString(summaryText.value), 1),
        fileText.value ? (openBlock(), createElementBlock("div", _hoisted_4$g, toDisplayString(fileText.value), 1)) : createCommentVNode("", true),
        createBaseVNode("div", _hoisted_5$f, [
          createBaseVNode("div", {
            class: "progress-bar-fill",
            style: normalizeStyle({ width: `${percent.value}%` })
          }, null, 4)
        ])
      ])) : createCommentVNode("", true);
    };
  }
};
const QueueProgress = /* @__PURE__ */ _export_sfc(_sfc_main$i, [["__scopeId", "data-v-99120855"]]);
const _hoisted_1$g = { class: "modal-content" };
const _hoisted_2$g = { class: "modal-title" };
const _hoisted_3$f = { class: "modal-message" };
const _hoisted_4$f = { class: "modal-actions" };
const _sfc_main$h = {
  __name: "ConfirmDialog",
  props: {
    title: {
      type: String,
      default: "Confirm"
    },
    message: {
      type: String,
      default: "Are you sure?"
    },
    confirmText: {
      type: String,
      default: "Confirm"
    },
    cancelText: {
      type: String,
      default: "Cancel"
    },
    confirmVariant: {
      type: String,
      default: "primary"
      // 'primary' or 'danger'
    }
  },
  emits: ["confirm", "cancel"],
  setup(__props, { emit: __emit }) {
    const emit2 = __emit;
    function handleConfirm() {
      emit2("confirm");
    }
    function handleCancel() {
      emit2("cancel");
    }
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        handleCancel();
      }
      mouseDownOnOverlay = false;
    }
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$g, [
            createBaseVNode("h2", _hoisted_2$g, toDisplayString(__props.title), 1),
            createBaseVNode("p", _hoisted_3$f, toDisplayString(__props.message), 1),
            renderSlot(_ctx.$slots, "extra", {}, void 0, true),
            createBaseVNode("div", _hoisted_4$f, [
              __props.cancelText ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "modal-btn cancel-btn",
                onClick: handleCancel
              }, toDisplayString(__props.cancelText), 1)) : createCommentVNode("", true),
              createBaseVNode("button", {
                class: normalizeClass(["modal-btn confirm-btn", __props.confirmVariant]),
                onClick: handleConfirm
              }, toDisplayString(__props.confirmText), 3)
            ])
          ])
        ], 32)
      ]);
    };
  }
};
const ConfirmDialog = /* @__PURE__ */ _export_sfc(_sfc_main$h, [["__scopeId", "data-v-5eac7478"]]);
const LICENSE_CACHE_KEY = "nuvu_license_cache";
const LICENSE_CACHE_TTL_MS = 5 * 60 * 1e3;
function getCachedLicenseStatus() {
  try {
    const raw = localStorage.getItem(LICENSE_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;
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
function cacheLicenseStatus(status) {
  try {
    localStorage.setItem(LICENSE_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      data: status
    }));
  } catch (error) {
  }
}
async function fetchLicenseStatus(options = {}) {
  const { useCache = true, backgroundRefresh = false } = options;
  if (useCache) {
    const cached = getCachedLicenseStatus();
    if (cached) {
      setCurrentLicenseStatus(cached);
      if (backgroundRefresh) {
        fetchLicenseStatus({ useCache: false }).catch(() => {
        });
      }
      return cached;
    }
  }
  const apiToken = getActiveApiToken();
  const userId = getStoredUserId();
  const userProfile = getUserProfile();
  const userEmail = userProfile?.email || "";
  if (!apiToken) {
    const noAuthStatus = {
      has_paid_subscription: false,
      subscription_status: "none",
      message: "Not authenticated"
    };
    setCurrentLicenseStatus(noAuthStatus);
    return noAuthStatus;
  }
  try {
    const response = await fetch("/nuvu/auth/subscription-check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`
      },
      body: JSON.stringify({ userId, email: userEmail })
    });
    if (response.status === 401 || response.status === 403) {
      invalidateLocalSession("license_check_unauthorized");
      throw new Error(`License check unauthorized: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`License check failed: ${response.status}`);
    }
    const status = await response.json();
    if (status.license_type === "floating" && status.has_paid_subscription) {
      const floatingResult = await handleFloatingLicenseStatus(status);
      const finalStatus = { ...status, ...floatingResult };
      if (floatingResult.floating_session_acquired) {
        cacheLicenseStatus(finalStatus);
      } else {
        localStorage.removeItem(LICENSE_CACHE_KEY);
      }
      setCurrentLicenseStatus(finalStatus);
      return finalStatus;
    }
    cacheLicenseStatus(status);
    setCurrentLicenseStatus(status);
    return status;
  } catch (error) {
    const cached = getCachedLicenseStatus();
    if (cached) {
      setCurrentLicenseStatus(cached);
      return cached;
    }
    const errorStatus = {
      has_paid_subscription: false,
      subscription_status: "error",
      message: "Failed to check license status"
    };
    setCurrentLicenseStatus(errorStatus);
    return errorStatus;
  }
}
async function handleFloatingLicenseStatus(status) {
  const orgId = status.organization?.id;
  const userProfile = getUserProfile();
  const userId = userProfile?.id || getStoredUserId();
  const email = userProfile?.email || "";
  if (!orgId || !userId) {
    console.warn("[LICENSE] Missing org or user info for floating license");
    return {
      floating_session_error: "Missing organization or user information",
      floating_session_acquired: false
    };
  }
  if (hasActiveFloatingSession()) {
    console.log("[LICENSE] Floating session already active");
    return {
      floating_session_acquired: true,
      floating_session_restored: true
    };
  }
  const restored = await restoreFloatingSession();
  if (restored) {
    console.log("[LICENSE] Floating session restored from storage");
    return {
      floating_session_acquired: true,
      floating_session_restored: true
    };
  }
  console.log("[LICENSE] Acquiring new floating session...");
  const result = await acquireFloatingSession(orgId, userId, email);
  if (result.success) {
    console.log("[LICENSE] Floating session acquired:", result.session_id);
    return {
      floating_session_acquired: true,
      floating_session_id: result.session_id
    };
  }
  console.warn("[LICENSE] Failed to acquire floating session:", result.error);
  return {
    floating_session_acquired: false,
    floating_session_error: result.error,
    floating_licenses_all_in_use: result.allInUse || false,
    // Override has_paid_subscription to false if we couldn't get a license
    has_paid_subscription: false,
    subscription_status: "floating_unavailable"
  };
}
const ACTIVE_STYLE = [
  "color: #35ffb5",
  "border-color: #35ffb5",
  "background: rgba(53, 255, 181, 0.12)",
  "box-shadow: 0 0 14px rgba(53, 255, 181, 0.35)"
].join("; ");
const INACTIVE_STYLE = [
  "color: #ff5a71",
  "border-color: #ff5a71",
  "background: rgba(255, 90, 113, 0.12)",
  "box-shadow: 0 0 16px rgba(255, 90, 113, 0.4)"
].join("; ");
function formatLicenseStatus(status) {
  if (!status) {
    return {
      isActive: false,
      statusText: "Unknown",
      statusClass: "unknown",
      message: "License status unknown",
      showPurchaseLink: false,
      style: INACTIVE_STYLE
    };
  }
  const hasPaid = status.has_paid_subscription === true;
  const subscriptionStatus = status.subscription_status || "none";
  const baseMessage = status.message;
  if (hasPaid) {
    console.log("[LICENSE] Raw status:", {
      license_type: status.license_type,
      subscription_type: status.subscription_type,
      organization: status.organization
    });
    const licenseType = status.license_type || status.subscription_type || "personal";
    const orgName = status.organization?.name;
    let licenseTypeText = "Personal";
    if (licenseType === "named") {
      licenseTypeText = "Enterprise (Named)";
    } else if (licenseType === "floating") {
      licenseTypeText = "Enterprise (Floating)";
    } else if (licenseType === "enterprise") {
      licenseTypeText = "Enterprise";
    }
    return {
      isActive: true,
      statusText: "Active",
      statusClass: "active",
      message: baseMessage || "Your subscription is active",
      showPurchaseLink: false,
      style: ACTIVE_STYLE,
      licenseType,
      licenseTypeText,
      organization: orgName || null
    };
  }
  switch (subscriptionStatus) {
    case "floating_unavailable":
      return {
        isActive: false,
        statusText: "No License Available",
        statusClass: "floating-unavailable",
        message: status.floating_session_error || "All floating licenses are currently in use. Please try again later or contact your administrator.",
        organization: status.organization?.name || "Your organization",
        licenseType: "floating",
        showPurchaseLink: false,
        showRetryButton: true,
        style: INACTIVE_STYLE
      };
    case "inactive":
    case "suspended":
    case "paused":
      return {
        isActive: false,
        statusText: status.license_type === "named" ? "License Inactive" : "Subscription Inactive",
        statusClass: "inactive",
        message: status.message || "Your license is currently inactive. Contact your administrator.",
        organization: status.organization?.name || null,
        licenseType: status.license_type || null,
        showPurchaseLink: false,
        style: INACTIVE_STYLE
      };
    case "trial":
      return {
        isActive: true,
        statusText: "Trial",
        statusClass: "trial",
        message: baseMessage || "You are on a trial",
        trialEndsAt: status.trial_ends_at || status.trialEndsAt || null,
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
    case "expired":
      return {
        isActive: false,
        statusText: "Expired",
        statusClass: "expired",
        message: baseMessage || "Your subscription has expired",
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
    case "cancelled":
      return {
        isActive: false,
        statusText: "Cancelled",
        statusClass: "cancelled",
        message: baseMessage || "Your subscription was cancelled",
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
    case "error":
      return {
        isActive: false,
        statusText: "Error",
        statusClass: "error",
        message: baseMessage || "Unable to verify license",
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
    case "free":
      return {
        isActive: false,
        statusText: "Free Plan",
        statusClass: "free",
        message: baseMessage || "You are on the free plan",
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
    default:
      return {
        isActive: false,
        statusText: "None",
        statusClass: "none",
        message: baseMessage || "No active subscription",
        showPurchaseLink: true,
        style: INACTIVE_STYLE
      };
  }
}
async function retryFloatingLicense() {
  localStorage.removeItem(LICENSE_CACHE_KEY);
  console.log("[LICENSE] Retrying floating license acquisition...");
  return fetchLicenseStatus({ useCache: false });
}
let modelsFetchPromise = null;
let modelsFetchController = null;
let modelsFetchSilent = true;
function enrichWorkflowsWithModelSizes() {
  const modelsLibrary = modelsData;
  const workflows = workflowsData;
  if (!Array.isArray(modelsLibrary) || modelsLibrary.length === 0) return;
  if (!Array.isArray(workflows) || workflows.length === 0) return;
  const libraryByName = /* @__PURE__ */ new Map();
  const libraryById = /* @__PURE__ */ new Map();
  for (const m of modelsLibrary) {
    if (!m) continue;
    if (m.id) libraryById.set(m.id, m);
    const name = (m.modelName || m.name || "").toLowerCase();
    if (name) libraryByName.set(name, m);
  }
  let anyUpdated = false;
  for (const workflow of workflows) {
    if (!workflow) continue;
    if (typeof workflow.totalModelSizeGB === "number" && workflow.totalModelSizeGB > 0) {
      continue;
    }
    let modelRefs = [];
    if (Array.isArray(workflow.models)) {
      modelRefs = workflow.models;
    } else if (workflow.dependencies) {
      const deps = workflow.dependencies;
      if (deps.M?.models?.L) {
        modelRefs = deps.M.models.L.map((item) => item.M || item);
      } else if (Array.isArray(deps.models)) {
        modelRefs = deps.models;
      }
    }
    if (modelRefs.length === 0) {
      workflow.totalModelSizeGB = 0;
      continue;
    }
    let totalSizeGB = 0;
    const countedIds = /* @__PURE__ */ new Set();
    for (const ref2 of modelRefs) {
      if (!ref2) continue;
      let libraryModel = null;
      const refId = ref2.id || ref2.libraryId;
      if (refId && libraryById.has(refId)) {
        libraryModel = libraryById.get(refId);
      }
      if (!libraryModel) {
        const refName = (ref2.name || ref2.modelName || ref2.filename || "").toLowerCase();
        if (refName && libraryByName.has(refName)) {
          libraryModel = libraryByName.get(refName);
        }
      }
      if (libraryModel && libraryModel.size && !countedIds.has(libraryModel.id)) {
        countedIds.add(libraryModel.id);
        totalSizeGB += libraryModel.size;
      }
    }
    workflow.totalModelSizeGB = totalSizeGB;
    anyUpdated = true;
  }
  if (anyUpdated) {
    const cacheInfo = getWorkflowsCacheInfo ? getWorkflowsCacheInfo() : null;
    const mode = cacheInfo?.mode || "full";
    const user = cacheInfo?.authUser || null;
    setWorkflowsData(workflows, { mode, user });
  }
}
function shouldRefreshModels(cacheInfo, hasSubscription) {
  if (!cacheInfo) {
    return true;
  }
  if (!Array.isArray(cacheInfo.data) || cacheInfo.data.length === 0) {
    return true;
  }
  if (cacheInfo.isExpired) {
    return true;
  }
  if (hasSubscription && cacheInfo.mode === "preview") {
    return true;
  }
  return false;
}
function modelsErrorMessage() {
  return '<div style="text-align: center; padding: 20px; color: #ff4444;">Failed to load models, check that:<br>1. your premium subscription is active.<br>2. your device is registered in "User Configuration".</div>';
}
async function fetchAndPersistModels(hasSubscription, { silent } = {}) {
  if (modelsFetchPromise) {
    if (!silent) {
      modelsFetchSilent = false;
    }
    return modelsFetchPromise;
  }
  modelsFetchSilent = silent;
  modelsFetchPromise = (async () => {
    try {
      if (modelsFetchController) {
        modelsFetchController.abort();
      }
      modelsFetchController = new AbortController();
      const signal = modelsFetchController.signal;
      let endpoint;
      let previewMode;
      if (hasSubscription) {
        endpoint = "/nuvu/models";
        previewMode = false;
      } else {
        endpoint = "/nuvu/models-metadata";
        previewMode = true;
      }
      const response = await fetch(endpoint, {
        headers: {
          "Authorization": `Bearer ${currentUser.apiToken}`,
          "Content-Type": "application/json",
          "X-User-Email": currentUser.email,
          "X-User-Id": currentUser.id
        },
        signal
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          invalidateLocalSession("models_unauthorized");
          return false;
        }
        if (response.status === 429) {
          return false;
        }
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      const data = await response.json();
      if (previewMode && Array.isArray(data)) {
        data.forEach((m) => m._previewMode = true);
      }
      const cacheInfo = typeof getModelsCacheInfo === "function" ? getModelsCacheInfo() : null;
      const previousVersion = cacheInfo ? cacheInfo.version : null;
      const newVersion = typeof getLatestDataVersion === "function" ? getLatestDataVersion(data) : null;
      const mode = previewMode ? "preview" : "full";
      const versionChanged = !previousVersion || !newVersion || previousVersion !== newVersion || cacheInfo && cacheInfo.mode !== mode;
      if (versionChanged) {
        setModelsData(data, { mode });
      } else {
        setModelsData(modelsData, { mode });
      }
      enrichWorkflowsWithModelSizes();
      return true;
    } catch (error) {
      if (error.name === "AbortError") {
        return false;
      }
      if (modelsFetchSilent) ;
      else {
        const modelsList = document.getElementById("nuvu-models-list");
        if (modelsList) {
          modelsList.innerHTML = modelsErrorMessage();
        }
      }
      return false;
    } finally {
      modelsFetchPromise = null;
      modelsFetchController = null;
      modelsFetchSilent = true;
    }
  })();
  return modelsFetchPromise;
}
async function loadModels(options = {}) {
  const { backgroundRefresh = true, force = false } = options;
  const cacheInfo = typeof getModelsCacheInfo === "function" ? getModelsCacheInfo() : null;
  const hasCached = cacheInfo && Array.isArray(cacheInfo.data) && cacheInfo.data.length > 0;
  const modelsList = document.getElementById("nuvu-models-list");
  if (modelsList && !hasCached) {
    modelsList.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--comfy-input-text);">Loading models...</div>';
  }
  if (!currentLicenseStatus) {
    try {
      await fetchLicenseStatus({ useCache: true, backgroundRefresh: true });
    } catch (e) {
    }
  }
  const hasSubscription = currentLicenseStatus && (currentLicenseStatus.has_paid_subscription || currentLicenseStatus.status === "paid");
  const needsRefresh = force || shouldRefreshModels(cacheInfo, hasSubscription);
  if (!currentUser || !currentUser.apiToken) {
    return hasCached;
  }
  if (!needsRefresh) {
    if (backgroundRefresh) {
      fetchAndPersistModels(hasSubscription, { silent: true }).catch(() => {
      });
    }
    return true;
  }
  return fetchAndPersistModels(hasSubscription, { silent: !backgroundRefresh });
}
const workflowDetailsCache = /* @__PURE__ */ new Map();
const workflowModelCache = /* @__PURE__ */ new Map();
let existingModelsCache = null;
let existingModelsCacheTimestamp = 0;
const EXISTING_MODELS_CACHE_TTL_MS = 60 * 1e3;
function extractDynamoValue(value) {
  if (!value) return null;
  if (value.S) return value.S;
  if (value.N) return parseFloat(value.N);
  if (value.L) return value.L.map((item) => extractDynamoValue(item));
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
  if (!dependencies || typeof dependencies !== "object") {
    return [];
  }
  const models = Array.isArray(dependencies.models) ? dependencies.models : [];
  return models.map((model) => {
    if (!model || typeof model !== "object" || !model.id) {
      return null;
    }
    const size = typeof model.size === "number" ? model.size : typeof model.fileSize === "number" ? model.fileSize : 0;
    return {
      id: model.id,
      name: model.name || model.modelName || "",
      size,
      url: model.url || "",
      hfTokenRequired: model.hfTokenRequired === true || model.hf_token_required === true
    };
  }).filter(Boolean);
}
function resolveWorkflowId(workflow) {
  if (!workflow || typeof workflow !== "object") {
    return null;
  }
  const candidates = [
    workflow.id,
    workflow.workflowId,
    workflow.workflow_id,
    workflow.slug,
    workflow.__workflowGeneratedId
  ];
  for (const candidate of candidates) {
    if (candidate !== void 0 && candidate !== null) {
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
  if (!Array.isArray(workflowsData)) {
    return;
  }
  const workflow = workflowsData.find((w) => workflowMatchesId(w, workflowId));
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
    models = workflow.models.map((model) => {
      if (!model || typeof model !== "object" || !model.id) {
        return null;
      }
      const size = typeof model.size === "number" ? model.size : typeof model.fileSize === "number" ? model.fileSize : 0;
      return {
        id: model.id,
        name: model.name || model.modelName || "",
        size,
        url: model.url || "",
        hfTokenRequired: model.hfTokenRequired === true || model.hf_token_required === true
      };
    }).filter(Boolean);
  } else {
    models = extractModelsFromDependencies(dependencies);
  }
  const globalModels = Array.isArray(modelsData) ? modelsData : [];
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
async function fetchWorkflowDetails(workflowId, options = {}) {
  const { refresh = false, mediaOnly = false } = options;
  if (!refresh && workflowDetailsCache.has(workflowId)) {
    return workflowDetailsCache.get(workflowId);
  }
  if (!refresh) {
    ensureWorkflowCachedFromState(workflowId);
    const cached = workflowDetailsCache.get(workflowId);
    if (cached && (!mediaOnly || cached.dependencies)) {
      return cached;
    }
  }
  try {
    const response = await fetch(`/nuvu/workflows/${workflowId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentUser.apiToken}`,
        "Content-Type": "application/json",
        "X-User-Email": currentUser.email,
        "X-User-Id": currentUser.id
      }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const refreshed = await ensureFreshAccessToken();
        if (!refreshed) {
          invalidateLocalSession("workflow_details_unauthorized");
        }
      }
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
async function fetchWorkflowsPaginated(options = {}) {
  const { limit = 20, cursor = null, search = null } = options;
  if (!currentUser || !currentUser.apiToken) {
    return { items: [], nextCursor: null };
  }
  const hasSubscription = currentLicenseStatus && (currentLicenseStatus.has_paid_subscription || currentLicenseStatus.status === "paid");
  const previewMode = !hasSubscription;
  try {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (search) {
      params.set("search", search);
    }
    const endpoint = `/nuvu/workflows-metadata?${params.toString()}`;
    const response = await fetch(endpoint, {
      headers: {
        "Authorization": `Bearer ${currentUser.apiToken}`,
        "Content-Type": "application/json",
        "X-User-Email": currentUser.email,
        "X-User-Id": currentUser.id
      }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        invalidateLocalSession("workflows_paginated_unauthorized");
      }
      return { items: [], nextCursor: null };
    }
    const data = await response.json();
    let items;
    let nextCursor;
    if (Array.isArray(data)) {
      items = data;
      nextCursor = null;
    } else {
      items = data.items || [];
      nextCursor = data.nextCursor || null;
    }
    if (previewMode) {
      items.forEach((w) => {
        w._previewMode = true;
      });
    }
    items.forEach((workflow) => {
      if (workflow && workflow.id) {
        cacheWorkflowModels(workflow);
      }
    });
    return { items, nextCursor };
  } catch (error) {
    console.error("[nuvu] fetchWorkflowsPaginated failed:", error);
    return { items: [], nextCursor: null };
  }
}
async function getExistingModels() {
  const now = Date.now();
  if (existingModelsCache && now - existingModelsCacheTimestamp < EXISTING_MODELS_CACHE_TTL_MS) {
    return new Set(existingModelsCache);
  }
  try {
    const response = await fetch("/nuvu/models/check-existing", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentUser.apiToken}`,
        "Content-Type": "application/json"
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
  return /* @__PURE__ */ new Set();
}
async function calculateTotalWorkflowSize(selectedWorkflowIds, options = {}) {
  const { forceRefreshCache = false } = options;
  let totalSize = 0;
  const uniqueModels = /* @__PURE__ */ new Map();
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
    models.forEach((model) => {
      if (!model || !model.id) {
        return;
      }
      if (existingModels.has(model.id) || uniqueModels.has(model.id)) {
        return;
      }
      uniqueModels.set(model.id, {
        id: model.id,
        name: model.name || "",
        size: typeof model.size === "number" ? model.size : 0,
        url: model.url || ""
      });
      if (model.size && model.size > 0) {
        totalSize += model.size;
      }
    });
  }
  return {
    totalSize,
    uniqueModelsCount: uniqueModels.size,
    uniqueModels: Array.from(uniqueModels.values())
  };
}
async function checkWorkflowsForHFTokenRequirement(options = {}) {
  const { forceRefreshCache = false } = options;
  let requiresHFToken = false;
  for (const workflowId of selectedWorkflows) {
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
    if (models.some((model) => model && model.hfTokenRequired === true)) {
      requiresHFToken = true;
      break;
    }
  }
  return requiresHFToken;
}
function extractWorkflowInstallMessage(workflow) {
  if (!workflow || typeof workflow !== "object") {
    return null;
  }
  const candidateKeys = [
    "workflowInstallMessage",
    "installMessage",
    "install_message",
    "workflow_message",
    "workflow_install_message"
  ];
  for (const key of candidateKeys) {
    const value = workflow[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}
async function collectWorkflowInstallMessages(workflowIds) {
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
    const name = workflow.name || workflow.workflowName || "Workflow";
    const id = workflow.id || workflow.workflowId || workflow.workflow_id;
    return id ? { id, name, message } : null;
  };
  const entries = [];
  workflowIds.forEach((workflowId) => {
    const cached = Array.isArray(workflowsData) ? workflowsData.find((w) => w && (w.id === workflowId || w.workflowId === workflowId || w.workflow_id === workflowId)) : null;
    if (cached) {
      const entry = buildEntry(cached);
      if (entry) {
        entries.push(entry);
      }
    }
  });
  return entries;
}
let workflowButtonUpdateToken = 0;
let hfTokenCache = null;
let hfTokenPrefetchPromise = null;
function setWorkflowHfToken(token) {
  hfTokenCache = token && typeof token === "string" ? token.trim() : "";
  const tokenInput = document.getElementById("nuvu-workflow-hf-token");
  if (tokenInput) {
    tokenInput.value = hfTokenCache || "";
  }
}
function prefetchWorkflowHfToken() {
  if (hfTokenCache) return Promise.resolve(hfTokenCache);
  if (hfTokenPrefetchPromise) return hfTokenPrefetchPromise;
  hfTokenPrefetchPromise = fetch("/nuvu/user-config").then((r) => r.ok ? r.json() : null).then((cfg) => {
    const token = cfg && typeof cfg.huggingface_token === "string" ? cfg.huggingface_token.trim() : "";
    if (token) {
      setWorkflowHfToken(token);
    }
    return hfTokenCache;
  }).catch(() => null).finally(() => {
    hfTokenPrefetchPromise = null;
  });
  return hfTokenPrefetchPromise;
}
function hideWorkflowMessage() {
  const messageElement = document.getElementById("nuvu-workflow-install-message");
  if (messageElement) {
    messageElement.style.display = "none";
    messageElement.innerHTML = "";
  }
}
function escapeHtml(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
function renderWorkflowMessage(messages) {
  const messageElement = document.getElementById("nuvu-workflow-install-message");
  if (!messageElement) {
    return;
  }
  if (!messages || !messages.length) {
    hideWorkflowMessage();
    return;
  }
  const entriesHtml = messages.map((entry) => {
    const title = escapeHtml(entry.name);
    const content = escapeHtml(entry.message);
    return `
                <div style="
                    margin-bottom:6px;
                    font-size:0.85em;
                    color:#fefefe;
                    line-height:1.4;
                    border-radius:8px;
                    padding:8px 10px;
                    background:rgba(37,99,235,0.15);
                    border:1px solid rgba(59,130,246,0.3);
                ">
                    <div style="font-weight:600; margin-bottom:2px;">${title}</div>
                    <div>${content}</div>
                </div>
            `;
  }).join("");
  messageElement.innerHTML = entriesHtml;
  messageElement.style.display = "block";
}
function resetWorkflowLoadingState(button2, container) {
  if (button2) {
    button2.classList.remove("nuvu-loading");
    button2.removeAttribute("aria-busy");
    button2.removeAttribute("data-loading-token");
  }
  if (container) {
    container.classList.remove("nuvu-loading");
    container.style.pointerEvents = "";
    container.style.opacity = "";
    container.removeAttribute("data-loading-token");
  }
}
function startWorkflowLoadingState(button2, container, token) {
  if (button2) {
    button2.dataset.loadingToken = String(token);
    button2.classList.add("nuvu-loading");
    button2.setAttribute("aria-busy", "true");
    button2.disabled = true;
    button2.textContent = "Updating...";
  }
  if (container) {
    container.dataset.loadingToken = String(token);
    container.classList.add("nuvu-loading");
    if (container.style.display === "none") {
      container.style.display = "block";
    }
    container.style.pointerEvents = "none";
    container.style.opacity = "0.6";
  }
}
function finishWorkflowLoadingState(button2, container, token) {
  if (button2 && button2.dataset.loadingToken === String(token)) {
    button2.classList.remove("nuvu-loading");
    button2.removeAttribute("aria-busy");
    button2.removeAttribute("data-loading-token");
  }
  if (container && container.dataset.loadingToken === String(token)) {
    container.classList.remove("nuvu-loading");
    container.style.pointerEvents = "";
    container.style.opacity = "";
    container.removeAttribute("data-loading-token");
  }
}
async function updateWorkflowInstallButton() {
  const installBtn = document.getElementById("nuvu-install-workflows-btn");
  const hfTokenContainer = document.getElementById("nuvu-workflow-hf-token-container");
  const updateToken = ++workflowButtonUpdateToken;
  hideWorkflowMessage();
  if (!installBtn) {
    return;
  }
  resetWorkflowLoadingState(installBtn, hfTokenContainer);
  const tokenInput = document.getElementById("nuvu-workflow-hf-token");
  if (tokenInput && !tokenInput.value.trim()) {
    if (hfTokenCache) {
      tokenInput.value = hfTokenCache;
    } else {
      prefetchWorkflowHfToken();
    }
  }
  installBtn.disabled = selectedWorkflows.size === 0 && !ongoingWorkflowInstall;
  if (ongoingWorkflowInstall) {
    installBtn.textContent = "Cancel Install";
    installBtn.style.background = "#dc3545";
    if (hfTokenContainer) {
      hfTokenContainer.style.display = "none";
      const hfTokenInput = document.getElementById("nuvu-workflow-hf-token");
      if (hfTokenInput) hfTokenInput.value = "";
      hideWorkflowMessage();
    }
    return;
  }
  if (selectedWorkflows.size === 0) {
    installBtn.textContent = "Select Workflows to Install";
    installBtn.style.background = "#0b0b0b";
    if (hfTokenContainer) {
      hfTokenContainer.style.display = "none";
      const hfTokenInput = document.getElementById("nuvu-workflow-hf-token");
      if (hfTokenInput) hfTokenInput.value = "";
      hideWorkflowMessage();
    }
    return;
  }
  startWorkflowLoadingState(installBtn, hfTokenContainer, updateToken);
  let sizeInfo;
  let requiresHFToken = false;
  let workflowMessages = [];
  try {
    sizeInfo = await calculateTotalWorkflowSize(Array.from(selectedWorkflows));
    if (workflowButtonUpdateToken !== updateToken) {
      return;
    }
    requiresHFToken = await checkWorkflowsForHFTokenRequirement();
    if (workflowButtonUpdateToken !== updateToken) {
      return;
    }
    workflowMessages = await collectWorkflowInstallMessages(Array.from(selectedWorkflows));
    if (workflowButtonUpdateToken !== updateToken) {
      return;
    }
  } catch (error) {
    installBtn.disabled = true;
    installBtn.textContent = "Unable to update selection";
    installBtn.style.background = "#555555";
    if (hfTokenContainer) {
      hfTokenContainer.style.display = "none";
    }
    hideWorkflowMessage();
    return;
  } finally {
    finishWorkflowLoadingState(installBtn, hfTokenContainer, updateToken);
  }
  if (workflowButtonUpdateToken !== updateToken) {
    return;
  }
  const totalSizeGB = sizeInfo.totalSize > 0 ? sizeInfo.totalSize.toFixed(1) : 0;
  let buttonText = `Install ${selectedWorkflows.size} Workflow${selectedWorkflows.size === 1 ? "" : "s"}`;
  if (totalSizeGB > 0) {
    buttonText += ` (${totalSizeGB} GB`;
    if (sizeInfo.uniqueModelsCount > 0) {
      buttonText += `, ${sizeInfo.uniqueModelsCount} model${sizeInfo.uniqueModelsCount === 1 ? "" : "s"}`;
    }
    buttonText += ")";
  }
  installBtn.textContent = buttonText;
  installBtn.style.background = "#0b0b0b";
  installBtn.disabled = false;
  if (hfTokenContainer) {
    hfTokenContainer.style.display = "block";
    const prefixElement = document.getElementById("nuvu-workflow-hf-token-prefix");
    if (prefixElement) {
      if (requiresHFToken) {
        prefixElement.textContent = "Required:";
        prefixElement.style.color = "#ef4444";
      } else {
        prefixElement.textContent = "Optional:";
        prefixElement.style.color = "#4ade80";
      }
    }
    const helpElement = document.getElementById("nuvu-workflow-hf-token-help");
    if (helpElement) {
      if (requiresHFToken) {
        helpElement.innerHTML = 'A HuggingFace token is required for some models in the selected workflows. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
      } else {
        helpElement.innerHTML = 'Enter your HuggingFace token for faster downloads and access to private models. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
      }
    }
    const toggleBtn = document.getElementById("nuvu-workflow-hf-token-toggle");
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const tokenInput3 = document.getElementById("nuvu-workflow-hf-token");
        if (tokenInput3) {
          if (tokenInput3.type === "password") {
            tokenInput3.type = "text";
            toggleBtn.textContent = "Hide";
            toggleBtn.title = "Hide password";
          } else {
            tokenInput3.type = "password";
            toggleBtn.textContent = "Show";
            toggleBtn.title = "Show password";
          }
        }
      };
    }
    const tokenInput2 = document.getElementById("nuvu-workflow-hf-token");
    if (tokenInput2 && !tokenInput2.value.trim()) {
      fetch("/nuvu/user-config").then((r) => r.ok ? r.json() : null).then((cfg) => {
        if (cfg && cfg.huggingface_token && typeof cfg.huggingface_token === "string" && cfg.huggingface_token.trim()) {
          tokenInput2.value = cfg.huggingface_token;
        }
      }).catch(() => {
      });
    }
    if (workflowMessages.length) {
      renderWorkflowMessage(workflowMessages);
    } else {
      hideWorkflowMessage();
    }
  }
}
async function startWorkflowInstall(workflowIds, options = {}) {
  if (!workflowIds || workflowIds.length === 0) {
    return false;
  }
  try {
    const sessionOk = await ensureValidSessionOrLogout();
    if (!sessionOk) {
      return false;
    }
    const accessToken = localStorage.getItem("api_token");
    if (!accessToken) {
      return false;
    }
    setOngoingWorkflowInstall(true);
    const userId = currentUser?.id;
    const userEmail = currentUser?.email;
    if (!userId || !userEmail) {
      setOngoingWorkflowInstall(false);
      return false;
    }
    const payload = {
      workflow_ids: workflowIds,
      user_id: userId,
      user_email: userEmail
    };
    if (options.hfToken) {
      payload.hf_token = options.hfToken;
    }
    const response = await fetch("/nuvu/install/workflow", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      setOngoingWorkflowInstall(false);
      if (response.status === 401 || response.status === 403) {
        invalidateLocalSession("workflow_install_unauthorized");
        return false;
      }
      if (response.status === 428) {
        return {
          success: false,
          deviceError: true,
          error: errorData.error || "Device not registered. Please register this device in User Configuration."
        };
      }
      return false;
    }
    const result = await response.json();
    pollForWorkflowCompletionHeadless();
    return true;
  } catch (error) {
    setOngoingWorkflowInstall(false);
    return false;
  }
}
function pollForWorkflowCompletionHeadless() {
  if (workflowPollInterval) {
    clearInterval(workflowPollInterval);
  }
  setWorkflowPollInterval(setInterval(async () => {
    try {
      const response = await fetch("/nuvu/queue/status");
      if (response.ok) {
        const status = await response.json();
        if (status.queue_size === 0 && !status.is_processing && status.in_progress_count === 0 && status.running_count === 0) {
          clearInterval(workflowPollInterval);
          setWorkflowPollInterval(null);
          setOngoingWorkflowInstall(false);
          window.dispatchEvent(new CustomEvent("nuvu-workflow-install-complete"));
        }
      }
    } catch (error) {
      clearInterval(workflowPollInterval);
      setWorkflowPollInterval(null);
      setOngoingWorkflowInstall(false);
      window.dispatchEvent(new CustomEvent("nuvu-workflow-install-error", { detail: error }));
    }
  }, 2e3));
}
async function cancelWorkflowInstall() {
  try {
    const response = await fetch("/nuvu/queue/reset", {
      method: "GET"
    });
    if (response.ok) {
      if (workflowPollInterval) {
        clearInterval(workflowPollInterval);
        setWorkflowPollInterval(null);
      }
      setOngoingWorkflowInstall(false);
      updateWorkflowInstallButton();
      if (typeof setPendingRefreshAfterRestart === "function") {
        setPendingRefreshAfterRestart(false);
      }
    } else {
    }
  } catch (error) {
    if (workflowPollInterval) {
      clearInterval(workflowPollInterval);
      setWorkflowPollInterval(null);
    }
    setOngoingWorkflowInstall(false);
    updateWorkflowInstallButton();
    if (typeof setPendingRefreshAfterRestart === "function") {
      setPendingRefreshAfterRestart(false);
    }
  }
}
const _hoisted_1$f = { class: "workflows-panel" };
const _hoisted_2$f = { class: "sound-toggle" };
const _hoisted_3$e = { class: "filters-row" };
const _hoisted_4$e = { class: "search-input-wrapper" };
const _hoisted_5$e = {
  key: 0,
  class: "search-spinner"
};
const _hoisted_6$e = ["value"];
const _hoisted_7$e = { class: "actions-row" };
const _hoisted_8$e = { class: "workflows-grid" };
const _hoisted_9$d = {
  key: 0,
  class: "loading-placeholder"
};
const _hoisted_10$c = {
  key: 1,
  class: "empty-placeholder"
};
const _hoisted_11$c = { class: "empty-message-container" };
const _hoisted_12$b = {
  key: 0,
  class: "empty-help"
};
const _hoisted_13$a = {
  key: 0,
  class: "loading-more"
};
const _hoisted_14$a = { class: "bottom-section" };
const _hoisted_15$9 = {
  key: 0,
  class: "hf-token-row"
};
const _hoisted_16$9 = { class: "hf-token-input-wrapper" };
const _hoisted_17$9 = { class: "hf-token-label" };
const _hoisted_18$9 = { class: "hf-token-input-group" };
const _hoisted_19$9 = ["type", "placeholder"];
const _hoisted_20$9 = ["title"];
const _hoisted_21$9 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_22$9 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_23$9 = {
  key: 1,
  class: "install-messages"
};
const _hoisted_24$8 = { class: "install-message-title" };
const _hoisted_25$7 = { class: "install-message-content" };
const _hoisted_26$7 = ["disabled"];
const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;
const BACKGROUND_REFRESH_COOLDOWN_MS = 3e4;
const runpodTemplateUrl$1 = "https://console.runpod.io/deploy?template=0lhzij38ow&ref=ffbuz4zw";
const runpodSignupUrl$1 = "https://runpod.io?ref=ffbuz4zw";
const _sfc_main$g = {
  __name: "WorkflowsPanel",
  setup(__props) {
    const nuvuVersions = inject("nuvuVersions", null);
    const licenseStatus = inject("licenseStatus", null);
    const activeTab = inject("activeTab", null);
    const searchInput = /* @__PURE__ */ ref("");
    const debouncedSearch = /* @__PURE__ */ ref("");
    const categoryFilter = /* @__PURE__ */ ref("all");
    const sortOption = /* @__PURE__ */ ref("date-desc");
    const workflows = /* @__PURE__ */ ref([]);
    const selectedWorkflows$1 = /* @__PURE__ */ ref(/* @__PURE__ */ new Set());
    const isLoading = /* @__PURE__ */ ref(true);
    const isLoadingMore = /* @__PURE__ */ ref(false);
    const isCalculatingSize = /* @__PURE__ */ ref(false);
    const isInstallingLocal = /* @__PURE__ */ ref(false);
    const categories = /* @__PURE__ */ ref([]);
    const nextCursor = /* @__PURE__ */ ref(null);
    const playVideoSound = /* @__PURE__ */ ref(false);
    const scrollSentinel = /* @__PURE__ */ ref(null);
    let cachedWorkflows = [];
    let cachedNextCursor = null;
    let backgroundRefreshInProgress = false;
    let lastBackgroundRefreshTime = 0;
    let mediaExpiryReloadPending = false;
    let mediaExpiryReloadTimeout = null;
    let fetchRequestId = 0;
    const totalSize = /* @__PURE__ */ ref(0);
    const uniqueModelsCount = /* @__PURE__ */ ref(0);
    const requiresHFToken = /* @__PURE__ */ ref(false);
    const hfToken = /* @__PURE__ */ ref("");
    const showHfToken = /* @__PURE__ */ ref(false);
    const installMessages = /* @__PURE__ */ ref([]);
    const { isActive, startPolling } = useQueueProgress();
    const isInstalling = computed(() => isInstallingLocal.value || isActive.value);
    const showVramWarning = /* @__PURE__ */ ref(false);
    const vramWarningWorkflows = /* @__PURE__ */ ref([]);
    const showDeviceError = /* @__PURE__ */ ref(false);
    const deviceErrorMessage = /* @__PURE__ */ ref("");
    function getIncompatibleWorkflows() {
      if (!licenseStatus?.isActive) return [];
      const vramGB = nuvuVersions?.value?.gpu?.vram_gb;
      if (!vramGB || vramGB <= 0) return [];
      const incompatible = [];
      for (const workflowId of selectedWorkflows$1.value) {
        const workflow = workflows.value.find((w) => w.id === workflowId);
        if (!workflow) continue;
        const modelSizeGB = workflow.totalModelSizeGB || 0;
        if (modelSizeGB > 0 && modelSizeGB / vramGB >= 3) {
          incompatible.push(workflow.name || workflowId);
        }
      }
      return incompatible;
    }
    async function proceedWithInstall() {
      showVramWarning.value = false;
      vramWarningWorkflows.value = [];
      isInstallingLocal.value = true;
      startPolling();
      try {
        if (startWorkflowInstall) {
          const token = hfToken.value.trim() || void 0;
          const result = await startWorkflowInstall([...selectedWorkflows$1.value], { hfToken: token });
          if (result && typeof result === "object" && result.deviceError) {
            isInstallingLocal.value = false;
            deviceErrorMessage.value = result.error;
            showDeviceError.value = true;
            return;
          }
          if (!result) {
            isInstallingLocal.value = false;
          }
        } else {
          console.warn("[nuvu] Install function not found");
          isInstallingLocal.value = false;
        }
      } catch (error) {
        console.error("[nuvu] Failed to install workflows:", error);
        isInstallingLocal.value = false;
      }
    }
    function closeDeviceError() {
      showDeviceError.value = false;
      deviceErrorMessage.value = "";
    }
    function goToUserConfig() {
      closeDeviceError();
      if (activeTab) {
        activeTab.value = "user-config";
      }
    }
    function cancelVramWarning() {
      showVramWarning.value = false;
      vramWarningWorkflows.value = [];
    }
    const vramWarningMessage = computed(() => {
      const workflowList = vramWarningWorkflows.value.map((name) => `  - ${name}`).join("\n");
      return `Based on our estimates, the following workflows may not run on your machine:

${workflowList}

This is just an estimate. You may still be able to run the workflow, but may want to look for alternative models like fp8 or gguf to be sure.`;
    });
    function normalizeSortKey(value) {
      const raw = value === void 0 || value === null ? "" : String(value);
      const stripped = raw.replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
      const normalized = typeof stripped.normalize === "function" ? stripped.normalize("NFKC") : stripped;
      return normalized.trim().replace(/\s+/g, " ");
    }
    function toCodepoints(value, limit = 200) {
      const raw = value === void 0 || value === null ? "" : String(value);
      const points = [];
      for (let i = 0; i < raw.length; i++) {
        const cp = raw.codePointAt(i);
        if (cp === void 0) continue;
        if (cp > 65535) i++;
        points.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
        if (points.length >= limit) break;
      }
      return points.join(" ");
    }
    const loggedNormalizationIds = /* @__PURE__ */ new Set();
    function logIfNameNormalized(workflow) {
      try {
        const id = workflow?.id || workflow?.__workflowGeneratedId || workflow?.workflow_id || workflow?.workflowId || null;
        if (!id || loggedNormalizationIds.has(id)) return;
        const rawName = workflow?.name;
        const normalizedName = normalizeSortKey(rawName);
        const rawStr = rawName === void 0 || rawName === null ? "" : String(rawName);
        if (rawStr !== normalizedName) {
          loggedNormalizationIds.add(id);
          console.warn("[nuvu][Sort] Workflow name normalized for sorting", {
            id,
            raw: rawStr,
            normalized: normalizedName,
            rawCodepoints: toCodepoints(rawStr)
          });
        }
      } catch {
      }
    }
    let searchDebounceTimer = null;
    watch(searchInput, (newValue) => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      searchDebounceTimer = setTimeout(() => {
        debouncedSearch.value = newValue;
      }, SEARCH_DEBOUNCE_MS);
    });
    function invalidateCurrentFetch() {
      fetchRequestId++;
    }
    watch(debouncedSearch, (newSearch, oldSearch) => {
      invalidateCurrentFetch();
      if (newSearch && !oldSearch && workflows.value.length > 0) {
        cachedWorkflows = [...workflows.value];
        cachedNextCursor = nextCursor.value;
      }
      if (!newSearch && oldSearch) {
        isLoading.value = false;
        isLoadingMore.value = false;
        if (cachedWorkflows.length > 0) {
          workflows.value = cachedWorkflows;
          nextCursor.value = cachedNextCursor;
          updateCategories();
          return;
        }
      }
      workflows.value = [];
      nextCursor.value = null;
      fetchWorkflowsPage();
    });
    const filteredWorkflows = computed(() => {
      let result = workflows.value;
      if (categoryFilter.value !== "all") {
        result = result.filter(
          (w) => w.categories?.includes(categoryFilter.value)
        );
      }
      if (sortOption.value === "name-asc") {
        result = [...result].sort((a, b) => {
          logIfNameNormalized(a);
          logIfNameNormalized(b);
          const nameA = normalizeSortKey(a?.name);
          const nameB = normalizeSortKey(b?.name);
          return nameA.localeCompare(nameB, void 0, { sensitivity: "base", numeric: true });
        });
      }
      return result;
    });
    const hasMore = computed(() => nextCursor.value !== null);
    const selectedCount = computed(() => selectedWorkflows$1.value.size);
    function formatSize(sizeGB) {
      if (typeof sizeGB !== "number" || sizeGB <= 0) return "";
      return `${sizeGB.toFixed(1)} GB`;
    }
    const installButtonText = computed(() => {
      if (isInstalling.value) return "Cancel Install";
      if (selectedCount.value === 0) return "Select Workflows to Install";
      let text = `Install ${selectedCount.value} Workflow${selectedCount.value > 1 ? "s" : ""}`;
      if (isCalculatingSize.value) {
        text += " (calculating...)";
      } else if (totalSize.value > 0) {
        text += ` (${formatSize(totalSize.value)}`;
        if (uniqueModelsCount.value > 0) {
          text += `, ${uniqueModelsCount.value} model${uniqueModelsCount.value > 1 ? "s" : ""}`;
        }
        text += ")";
      }
      return text;
    });
    watch(isActive, (next) => {
      if (!next) {
        isInstallingLocal.value = false;
      }
    });
    function syncSelectionToState(selection) {
      if (updateSelectedWorkflows) {
        updateSelectedWorkflows(selection);
      }
    }
    function toggleWorkflow(workflowId) {
      const newSet = new Set(selectedWorkflows$1.value);
      if (newSet.has(workflowId)) {
        newSet.delete(workflowId);
      } else {
        newSet.add(workflowId);
      }
      selectedWorkflows$1.value = newSet;
      syncSelectionToState(newSet);
      debouncedSizeUpdate();
    }
    function handleMediaExpired() {
      if (mediaExpiryReloadPending) return;
      mediaExpiryReloadPending = true;
      if (mediaExpiryReloadTimeout) {
        clearTimeout(mediaExpiryReloadTimeout);
      }
      mediaExpiryReloadTimeout = setTimeout(async () => {
        try {
          workflows.value = [];
          cachedWorkflows = [];
          nextCursor.value = null;
          cachedNextCursor = null;
          setWorkflowsData([], { mode: "paginated", nextCursor: null });
          isLoading.value = true;
          await fetchWorkflowsPage();
        } finally {
          mediaExpiryReloadPending = false;
          mediaExpiryReloadTimeout = null;
        }
      }, 100);
    }
    function selectAll() {
      const newSet = new Set(selectedWorkflows$1.value);
      filteredWorkflows.value.forEach((w) => {
        if (!w._previewMode && w.id) {
          newSet.add(w.id);
        }
      });
      selectedWorkflows$1.value = newSet;
      syncSelectionToState(newSet);
      debouncedSizeUpdate();
    }
    function deselectAll() {
      selectedWorkflows$1.value = /* @__PURE__ */ new Set();
      syncSelectionToState(/* @__PURE__ */ new Set());
      totalSize.value = 0;
      uniqueModelsCount.value = 0;
      requiresHFToken.value = false;
      installMessages.value = [];
    }
    let sizeCalculationToken = 0;
    async function updateSizeInfo() {
      if (selectedCount.value === 0) {
        totalSize.value = 0;
        uniqueModelsCount.value = 0;
        requiresHFToken.value = false;
        installMessages.value = [];
        return;
      }
      const currentToken = ++sizeCalculationToken;
      isCalculatingSize.value = true;
      try {
        syncSelectionToState(selectedWorkflows$1.value);
        const workflowIds = [...selectedWorkflows$1.value];
        const sizeInfo = await calculateTotalWorkflowSize(workflowIds, { forceRefreshCache: true });
        if (currentToken !== sizeCalculationToken) return;
        totalSize.value = sizeInfo?.totalSize || 0;
        uniqueModelsCount.value = sizeInfo?.uniqueModelsCount || 0;
        const needsHF = await checkWorkflowsForHFTokenRequirement({ forceRefreshCache: false });
        if (currentToken !== sizeCalculationToken) return;
        requiresHFToken.value = !!needsHF;
        const messages = await collectWorkflowInstallMessages(workflowIds);
        if (currentToken !== sizeCalculationToken) return;
        installMessages.value = messages || [];
      } catch (error) {
        console.warn("[nuvu] Size calculation failed:", error);
      } finally {
        if (currentToken === sizeCalculationToken) {
          isCalculatingSize.value = false;
        }
      }
    }
    let sizeUpdateTimeout = null;
    function debouncedSizeUpdate() {
      if (sizeUpdateTimeout) clearTimeout(sizeUpdateTimeout);
      sizeUpdateTimeout = setTimeout(updateSizeInfo, 300);
    }
    async function fetchWorkflowsPage(cursor = null) {
      const isInitialLoad = cursor === null;
      const isSearching = !!debouncedSearch.value;
      const thisRequestId = ++fetchRequestId;
      if (isInitialLoad) {
        isLoading.value = true;
      } else {
        isLoadingMore.value = true;
      }
      try {
        const result = await fetchWorkflowsPaginated({
          limit: PAGE_SIZE,
          cursor,
          search: debouncedSearch.value || null
        });
        if (thisRequestId !== fetchRequestId) {
          return;
        }
        if (isInitialLoad) {
          workflows.value = result.items || [];
        } else {
          workflows.value = [...workflows.value, ...result.items || []];
        }
        nextCursor.value = result.nextCursor || null;
        updateCategories();
        if (!isSearching) {
          cachedWorkflows = [...workflows.value];
          cachedNextCursor = nextCursor.value;
          setWorkflowsData(workflows.value, {
            mode: nextCursor.value ? "paginated" : "full",
            nextCursor: nextCursor.value
          });
        }
      } catch (error) {
        if (thisRequestId !== fetchRequestId) {
          return;
        }
        console.error("[nuvu] Failed to fetch workflows:", error);
      } finally {
        if (thisRequestId === fetchRequestId) {
          isLoading.value = false;
          isLoadingMore.value = false;
        }
      }
    }
    async function loadMore() {
      if (!hasMore.value || isLoadingMore.value) return;
      await fetchWorkflowsPage(nextCursor.value);
    }
    async function loadWorkflowsData() {
      try {
        if (typeof hydrateWorkflowsFromCache === "function") {
          hydrateWorkflowsFromCache();
        }
        if (selectedWorkflows instanceof Set) {
          selectedWorkflows$1.value = new Set(selectedWorkflows);
        }
        if (Array.isArray(workflowsData) && workflowsData.length > 0) {
          workflows.value = workflowsData;
          cachedWorkflows = [...workflowsData];
          nextCursor.value = workflowsPaginationCursor ?? null;
          cachedNextCursor = nextCursor.value;
          updateCategories();
          isLoading.value = false;
          backgroundRefreshWorkflows();
          return;
        }
        await fetchWorkflowsPage();
      } catch (error) {
        console.error("[nuvu] Failed to load workflows:", error);
        isLoading.value = false;
      }
    }
    async function backgroundRefreshWorkflows() {
      const now = Date.now();
      if (backgroundRefreshInProgress) {
        return;
      }
      if (now - lastBackgroundRefreshTime < BACKGROUND_REFRESH_COOLDOWN_MS) {
        return;
      }
      backgroundRefreshInProgress = true;
      lastBackgroundRefreshTime = now;
      try {
        const result = await fetchWorkflowsPaginated({ limit: PAGE_SIZE });
        if (!result.items || result.items.length === 0) return;
        const serverIds = result.items.map((w) => w.id);
        const cachedIds = workflows.value.slice(0, PAGE_SIZE).map((w) => w.id);
        const firstPageChanged = serverIds.length !== cachedIds.length || serverIds.some((id, index) => id !== cachedIds[index]);
        if (firstPageChanged) {
          workflows.value = result.items;
          cachedWorkflows = [...result.items];
          nextCursor.value = result.nextCursor || null;
          cachedNextCursor = nextCursor.value;
          setWorkflowsData(result.items, {
            mode: "paginated",
            nextCursor: result.nextCursor || null
          });
          updateCategories();
          return;
        }
        const updatedWorkflows = result.items.filter((serverWf) => {
          const cached = workflows.value.find((w) => w.id === serverWf.id);
          if (!cached) return false;
          const serverDate = serverWf.dateUpdated || serverWf.dateCreated || "";
          const cachedDate = cached.dateUpdated || cached.dateCreated || "";
          return serverDate > cachedDate;
        });
        if (updatedWorkflows.length > 0) {
          const updatedIds = new Set(updatedWorkflows.map((w) => w.id));
          workflows.value = workflows.value.map((wf) => {
            if (updatedIds.has(wf.id)) {
              return updatedWorkflows.find((u) => u.id === wf.id);
            }
            return wf;
          });
          cachedWorkflows = [...workflows.value];
          setWorkflowsData(workflows.value, {
            mode: nextCursor.value ? "paginated" : "full",
            nextCursor: nextCursor.value
          });
        }
      } catch (error) {
        console.warn("[nuvu] Background refresh failed:", error.message);
      } finally {
        backgroundRefreshInProgress = false;
      }
    }
    function updateCategories() {
      const allCategories = /* @__PURE__ */ new Set();
      workflows.value.forEach((w) => {
        w.categories?.forEach((c) => allCategories.add(c));
      });
      categories.value = [...allCategories].sort();
    }
    async function installWorkflows() {
      if (selectedCount.value === 0) return;
      if (isInstalling.value) {
        if (cancelWorkflowInstall) {
          cancelWorkflowInstall();
        }
        isInstallingLocal.value = false;
        return;
      }
      const incompatible = getIncompatibleWorkflows();
      if (incompatible.length > 0) {
        vramWarningWorkflows.value = incompatible;
        showVramWarning.value = true;
        return;
      }
      await proceedWithInstall();
    }
    async function loadHFToken() {
      try {
        const response = await fetch("/nuvu/user-config");
        if (response.ok) {
          const config = await response.json();
          if (config.huggingface_token) {
            hfToken.value = config.huggingface_token;
          }
        }
      } catch (e) {
      }
    }
    let hfTokenUpdatedHandler = null;
    let infiniteScrollObserver = null;
    function setupInfiniteScroll() {
      if (infiniteScrollObserver) {
        infiniteScrollObserver.disconnect();
      }
      if (scrollSentinel.value) {
        infiniteScrollObserver = new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (entry && entry.isIntersecting && hasMore.value && !isLoadingMore.value) {
              loadMore();
            }
          },
          { rootMargin: "200px" }
        );
        infiniteScrollObserver.observe(scrollSentinel.value);
      }
    }
    watch(scrollSentinel, (newVal) => {
      if (newVal) {
        setupInfiniteScroll();
      }
    });
    onMounted(() => {
      loadWorkflowsData();
      loadHFToken();
      hfTokenUpdatedHandler = (event) => {
        try {
          const nextToken = event?.detail || "";
          hfToken.value = typeof nextToken === "string" ? nextToken : "";
        } catch {
        }
      };
      window.addEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
    });
    onUnmounted(() => {
      if (hfTokenUpdatedHandler) {
        window.removeEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
        hfTokenUpdatedHandler = null;
      }
      if (sizeUpdateTimeout) {
        clearTimeout(sizeUpdateTimeout);
      }
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      if (mediaExpiryReloadTimeout) {
        clearTimeout(mediaExpiryReloadTimeout);
        mediaExpiryReloadTimeout = null;
      }
      if (infiniteScrollObserver) {
        infiniteScrollObserver.disconnect();
        infiniteScrollObserver = null;
      }
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$f, [
        createBaseVNode("label", _hoisted_2$f, [
          withDirectives(createBaseVNode("input", {
            type: "checkbox",
            "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => playVideoSound.value = $event)
          }, null, 512), [
            [vModelCheckbox, playVideoSound.value]
          ]),
          _cache[6] || (_cache[6] = createBaseVNode("span", { class: "sound-toggle-label" }, "Play sound on hover", -1))
        ]),
        createBaseVNode("div", _hoisted_3$e, [
          createBaseVNode("div", _hoisted_4$e, [
            withDirectives(createBaseVNode("input", {
              "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => searchInput.value = $event),
              type: "text",
              class: "search-input",
              placeholder: "Search workflows by name, description, or tag..."
            }, null, 512), [
              [vModelText, searchInput.value]
            ]),
            searchInput.value !== debouncedSearch.value ? (openBlock(), createElementBlock("div", _hoisted_5$e)) : createCommentVNode("", true)
          ]),
          withDirectives(createBaseVNode("select", {
            "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => categoryFilter.value = $event),
            class: "filter-select"
          }, [
            _cache[7] || (_cache[7] = createBaseVNode("option", { value: "all" }, "All Categories", -1)),
            (openBlock(true), createElementBlock(Fragment, null, renderList(categories.value, (cat) => {
              return openBlock(), createElementBlock("option", {
                key: cat,
                value: cat
              }, toDisplayString(cat), 9, _hoisted_6$e);
            }), 128))
          ], 512), [
            [vModelSelect, categoryFilter.value]
          ])
        ]),
        createBaseVNode("div", _hoisted_7$e, [
          withDirectives(createBaseVNode("select", {
            "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => sortOption.value = $event),
            class: "sort-select"
          }, [..._cache[8] || (_cache[8] = [
            createBaseVNode("option", { value: "date-desc" }, "Sort: Date Added (Newest)", -1),
            createBaseVNode("option", { value: "name-asc" }, "Sort: Name (A-Z)", -1)
          ])], 512), [
            [vModelSelect, sortOption.value]
          ]),
          createBaseVNode("div", { class: "selection-btns" }, [
            createBaseVNode("button", {
              class: "action-btn",
              onClick: selectAll
            }, "Select All"),
            createBaseVNode("button", {
              class: "action-btn",
              onClick: deselectAll
            }, "Deselect All")
          ])
        ]),
        createBaseVNode("div", _hoisted_8$e, [
          isLoading.value ? (openBlock(), createElementBlock("div", _hoisted_9$d, " Loading workflows... ")) : filteredWorkflows.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_10$c, [
            createBaseVNode("div", _hoisted_11$c, [
              _cache[9] || (_cache[9] = createBaseVNode("p", null, "No workflows match your filters.", -1)),
              !searchInput.value && categoryFilter.value === "all" ? (openBlock(), createElementBlock("p", _hoisted_12$b, " Check that your device is registered in User Configuration ")) : createCommentVNode("", true)
            ])
          ])) : (openBlock(), createElementBlock(Fragment, { key: 2 }, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(filteredWorkflows.value, (workflow) => {
              return openBlock(), createBlock(WorkflowCard, {
                key: workflow.id || workflow.__workflowGeneratedId,
                workflow,
                "is-selected": selectedWorkflows$1.value.has(workflow.id),
                "play-video-sound": playVideoSound.value,
                onToggle: toggleWorkflow,
                onMediaExpired: handleMediaExpired
              }, null, 8, ["workflow", "is-selected", "play-video-sound"]);
            }), 128)),
            createBaseVNode("div", {
              ref_key: "scrollSentinel",
              ref: scrollSentinel,
              class: "scroll-sentinel"
            }, [
              isLoadingMore.value ? (openBlock(), createElementBlock("div", _hoisted_13$a, [..._cache[10] || (_cache[10] = [
                createBaseVNode("div", { class: "loading-spinner" }, null, -1),
                createBaseVNode("span", null, "Loading more workflows...", -1)
              ])])) : createCommentVNode("", true)
            ], 512)
          ], 64))
        ]),
        createBaseVNode("div", _hoisted_14$a, [
          createVNode(QueueProgress, {
            phases: ["workflows", "subgraphs", "custom_nodes", "models"],
            title: "Installing..."
          }),
          selectedCount.value > 0 ? (openBlock(), createElementBlock("div", _hoisted_15$9, [
            createBaseVNode("div", _hoisted_16$9, [
              createBaseVNode("label", _hoisted_17$9, [
                _cache[11] || (_cache[11] = createTextVNode(" HuggingFace Token ", -1)),
                createBaseVNode("span", {
                  class: normalizeClass(requiresHFToken.value ? "required" : "optional")
                }, " (" + toDisplayString(requiresHFToken.value ? "Required" : "Optional") + ") ", 3)
              ]),
              createBaseVNode("div", _hoisted_18$9, [
                withDirectives(createBaseVNode("input", {
                  "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => hfToken.value = $event),
                  type: showHfToken.value ? "text" : "password",
                  class: "hf-token-input",
                  placeholder: requiresHFToken.value ? "Required for selected workflows" : "Optional - for faster downloads"
                }, null, 8, _hoisted_19$9), [
                  [vModelDynamic, hfToken.value]
                ]),
                createBaseVNode("button", {
                  type: "button",
                  class: "hf-token-toggle",
                  onClick: _cache[5] || (_cache[5] = ($event) => showHfToken.value = !showHfToken.value),
                  title: showHfToken.value ? "Hide token" : "Show token"
                }, [
                  showHfToken.value ? (openBlock(), createElementBlock("svg", _hoisted_21$9, [..._cache[12] || (_cache[12] = [
                    createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                    createBaseVNode("line", {
                      x1: "1",
                      y1: "1",
                      x2: "23",
                      y2: "23"
                    }, null, -1)
                  ])])) : (openBlock(), createElementBlock("svg", _hoisted_22$9, [..._cache[13] || (_cache[13] = [
                    createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                    createBaseVNode("circle", {
                      cx: "12",
                      cy: "12",
                      r: "3"
                    }, null, -1)
                  ])]))
                ], 8, _hoisted_20$9)
              ])
            ]),
            _cache[14] || (_cache[14] = createBaseVNode("a", {
              href: "https://huggingface.co/settings/tokens",
              target: "_blank",
              class: "hf-token-link"
            }, " Get token ", -1))
          ])) : createCommentVNode("", true),
          installMessages.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_23$9, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(installMessages.value, (msg) => {
              return openBlock(), createElementBlock("div", {
                key: msg.id,
                class: "install-message-item"
              }, [
                createBaseVNode("div", _hoisted_24$8, toDisplayString(msg.name), 1),
                createBaseVNode("div", _hoisted_25$7, toDisplayString(msg.message), 1)
              ]);
            }), 128))
          ])) : createCommentVNode("", true),
          createBaseVNode("button", {
            class: normalizeClass(["install-btn", { "cancel-btn": isInstalling.value }]),
            disabled: selectedCount.value === 0 && !isInstalling.value,
            onClick: installWorkflows
          }, toDisplayString(installButtonText.value), 11, _hoisted_26$7)
        ]),
        showVramWarning.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 0,
          title: "Warning",
          message: vramWarningMessage.value,
          "confirm-text": "Install Anyway",
          "cancel-text": "Cancel",
          onConfirm: proceedWithInstall,
          onCancel: cancelVramWarning
        }, {
          extra: withCtx(() => [
            createBaseVNode("div", { class: "runpod-link" }, [
              createBaseVNode("p", null, [
                _cache[15] || (_cache[15] = createTextVNode(" Want more power? Try our ", -1)),
                createBaseVNode("a", {
                  href: runpodTemplateUrl$1,
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, "RunPod cloud template")
              ]),
              createBaseVNode("p", { class: "signup-line" }, [
                _cache[16] || (_cache[16] = createTextVNode(" Don't have an account? ", -1)),
                createBaseVNode("a", {
                  href: runpodSignupUrl$1,
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, "Sign up here")
              ])
            ])
          ]),
          _: 1
        }, 8, ["message"])) : createCommentVNode("", true),
        showDeviceError.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 1,
          title: "Device Not Registered",
          message: deviceErrorMessage.value,
          "confirm-text": "Go to User Configuration",
          "cancel-text": "Close",
          onConfirm: goToUserConfig,
          onCancel: closeDeviceError
        }, null, 8, ["message"])) : createCommentVNode("", true)
      ]);
    };
  }
};
const WorkflowsPanel = /* @__PURE__ */ _export_sfc(_sfc_main$g, [["__scopeId", "data-v-d373af52"]]);
const _hoisted_1$e = { class: "modal-content" };
const _hoisted_2$e = { class: "modal-description" };
const _hoisted_3$d = { class: "modal-help" };
const _hoisted_4$d = { class: "input-group" };
const _hoisted_5$d = ["disabled"];
const _hoisted_6$d = {
  key: 0,
  class: "error-text"
};
const _hoisted_7$d = { class: "modal-actions" };
const _hoisted_8$d = ["disabled"];
const _hoisted_9$c = ["disabled"];
const _sfc_main$f = {
  __name: "HuggingFaceTokenModal",
  props: {
    context: {
      type: String,
      default: "model"
      // 'model' or 'workflow'
    }
  },
  emits: ["submit", "cancel"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const token = /* @__PURE__ */ ref("");
    const isSaving = /* @__PURE__ */ ref(false);
    const error = /* @__PURE__ */ ref("");
    const contextText = props.context === "workflow" ? "This workflow requires models from Hugging Face that need authentication." : "Some selected models require a Hugging Face Access Token.";
    async function handleSubmit() {
      const tokenValue = token.value.trim();
      if (!tokenValue) {
        error.value = "Please enter a valid HuggingFace token";
        return;
      }
      if (!tokenValue.startsWith("hf_")) {
        error.value = 'Token should start with "hf_"';
        return;
      }
      isSaving.value = true;
      error.value = "";
      try {
        await fetch("/nuvu/user-config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify({ huggingface_token: tokenValue })
        });
        emit2("submit", tokenValue);
      } catch (e) {
        error.value = "Failed to save token. Please try again.";
        console.error("[nuvu] Failed to save HF token:", e);
      } finally {
        isSaving.value = false;
      }
    }
    function handleCancel() {
      emit2("cancel");
    }
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        handleCancel();
      }
      mouseDownOnOverlay = false;
    }
    function openHFTokenPage() {
      window.open("https://huggingface.co/settings/tokens", "_blank");
    }
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$e, [
            _cache[3] || (_cache[3] = createBaseVNode("h2", { class: "modal-title" }, "HuggingFace Token Required", -1)),
            createBaseVNode("p", _hoisted_2$e, toDisplayString(unref(contextText)), 1),
            createBaseVNode("p", _hoisted_3$d, [
              _cache[1] || (_cache[1] = createTextVNode(" You can create a token at ", -1)),
              createBaseVNode("a", {
                href: "#",
                onClick: withModifiers(openHFTokenPage, ["prevent"]),
                class: "link"
              }, "huggingface.co/settings/tokens")
            ]),
            createBaseVNode("div", _hoisted_4$d, [
              _cache[2] || (_cache[2] = createBaseVNode("label", { for: "hf-token" }, "Access Token", -1)),
              withDirectives(createBaseVNode("input", {
                id: "hf-token",
                "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => token.value = $event),
                type: "password",
                placeholder: "hf_...",
                class: "token-input",
                disabled: isSaving.value,
                onKeyup: withKeys(handleSubmit, ["enter"])
              }, null, 40, _hoisted_5$d), [
                [vModelText, token.value]
              ]),
              error.value ? (openBlock(), createElementBlock("p", _hoisted_6$d, toDisplayString(error.value), 1)) : createCommentVNode("", true)
            ]),
            createBaseVNode("div", _hoisted_7$d, [
              createBaseVNode("button", {
                class: "modal-btn cancel-btn",
                onClick: handleCancel,
                disabled: isSaving.value
              }, " Cancel ", 8, _hoisted_8$d),
              createBaseVNode("button", {
                class: "modal-btn submit-btn",
                onClick: handleSubmit,
                disabled: isSaving.value || !token.value.trim()
              }, toDisplayString(isSaving.value ? "Saving..." : "Save & Continue"), 9, _hoisted_9$c)
            ])
          ])
        ], 32)
      ]);
    };
  }
};
const HuggingFaceTokenModal = /* @__PURE__ */ _export_sfc(_sfc_main$f, [["__scopeId", "data-v-f1412757"]]);
function getCurrentWorkflowDependencies() {
  try {
    const app2 = window.app;
    if (!app2 || !app2.graph) {
      return { customNodes: [], cnrIds: {}, auxIds: {}, models: [] };
    }
    let serializedDeps = null;
    try {
      if (typeof app2.graph.serialize === "function") {
        const serialized = app2.graph.serialize();
        serializedDeps = analyzeWorkflowJson(serialized);
      }
    } catch {
    }
    const customNodes = /* @__PURE__ */ new Set();
    const cnrIds = {};
    const auxIds = {};
    const models = [];
    const visitedGraphs = /* @__PURE__ */ new Set();
    const visitGraph = (graph) => {
      if (!graph || visitedGraphs.has(graph)) return;
      visitedGraphs.add(graph);
      const nodes = graph._nodes || graph.nodes || [];
      for (const node of nodes) {
        if (!node) continue;
        if (node.isSubgraphNode?.() && node.subgraph) {
          visitGraph(node.subgraph);
        }
        if (!node.type) continue;
        if (typeof node.type === "string" && node.type.startsWith("workflow>")) {
          const groupName = node.type.slice(9);
          const groupData = app2.graph?.extra?.groupNodes?.[groupName];
          if (groupData?.nodes) {
            for (const subNode of groupData.nodes) {
              if (subNode?.type) {
                customNodes.add(subNode.type);
              }
            }
          }
          continue;
        }
        customNodes.add(node.type);
        if (node.properties?.cnr_id) {
          cnrIds[node.properties.cnr_id] = node.type;
        }
        if (node.properties?.aux_id) {
          auxIds[node.properties.aux_id] = node.type;
        }
        if (Array.isArray(node.properties?.models)) {
          for (const m of node.properties.models) {
            if (!m || typeof m !== "object") continue;
            if (typeof m.name !== "string" || !m.name.trim()) continue;
            models.push({
              name: m.name.trim(),
              url: typeof m.url === "string" ? m.url : void 0,
              directory: typeof m.directory === "string" ? m.directory : void 0,
              nodeType: node.type,
              propertyName: "models"
            });
          }
        }
        if (node.widgets) {
          for (const widget of node.widgets) {
            if (isModelWidget(widget)) {
              const modelName = widget.value;
              if (modelName && typeof modelName === "string" && modelName.trim()) {
                models.push({
                  name: modelName.trim(),
                  nodeType: node.type,
                  widgetName: widget.name
                });
              }
            }
          }
        }
        if (node.properties) {
          for (const [key, value] of Object.entries(node.properties)) {
            if (isModelProperty(key, value)) {
              models.push({
                name: value,
                nodeType: node.type,
                propertyName: key
              });
            }
          }
        }
      }
    };
    visitGraph(app2.graph);
    if (serializedDeps) {
      for (const t of serializedDeps.customNodes || []) {
        if (typeof t === "string" && t) customNodes.add(t);
      }
      Object.assign(cnrIds, serializedDeps.cnrIds || {});
      Object.assign(auxIds, serializedDeps.auxIds || {});
      if (Array.isArray(serializedDeps.models)) {
        for (const m of serializedDeps.models) {
          if (m && typeof m.name === "string" && m.name.trim()) {
            models.push(m);
          }
        }
      }
    }
    return {
      customNodes: Array.from(customNodes),
      cnrIds,
      auxIds,
      models: deduplicateModelRefs(models)
    };
  } catch (error) {
    return { customNodes: [], cnrIds: {}, auxIds: {}, models: [] };
  }
}
function isModelWidget(widget) {
  if (!widget || !widget.name) return false;
  const modelWidgetNames = [
    "ckpt_name",
    "model_name",
    "vae_name",
    "clip_name",
    "lora_name",
    "control_net_name",
    "unet_name",
    "model",
    "checkpoint",
    "vae",
    "lora",
    "controlnet"
  ];
  const name = widget.name.toLowerCase();
  return modelWidgetNames.some((n) => name.includes(n));
}
function isModelProperty(key, value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const keyLower = key.toLowerCase();
  const modelKeywords = ["model", "ckpt", "checkpoint", "vae", "lora", "unet"];
  if (!modelKeywords.some((k) => keyLower.includes(k))) return false;
  const valueLower = value.toLowerCase();
  const modelExtensions = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"];
  return modelExtensions.some((ext) => valueLower.endsWith(ext));
}
function deduplicateModelRefs(refs) {
  const seen = /* @__PURE__ */ new Set();
  return refs.filter((ref2) => {
    const key = ref2.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function analyzeWorkflowJson(workflow) {
  const customNodes = /* @__PURE__ */ new Set();
  const cnrIds = {};
  const auxIds = {};
  const models = [];
  if (!workflow) return { customNodes: [], cnrIds: {}, auxIds: {}, models: [] };
  const nodes = workflow.nodes || workflow.workflow && workflow.workflow.nodes || [];
  for (const node of nodes) {
    if (!node) continue;
    if (node.type) {
      customNodes.add(node.type);
    }
    if (node.properties?.cnr_id) {
      cnrIds[node.properties.cnr_id] = node.type;
    }
    if (node.properties?.aux_id) {
      auxIds[node.properties.aux_id] = node.type;
    }
    if (Array.isArray(node.properties?.models)) {
      for (const m of node.properties.models) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.name !== "string" || !m.name.trim()) continue;
        models.push({
          name: m.name.trim(),
          url: typeof m.url === "string" ? m.url : void 0,
          directory: typeof m.directory === "string" ? m.directory : void 0,
          nodeType: node.type,
          propertyName: "models"
        });
      }
    }
    if (node.widgets_values && Array.isArray(node.widgets_values)) {
      for (const value of node.widgets_values) {
        if (typeof value === "string" && looksLikeModelFilename(value)) {
          models.push({
            name: value,
            nodeType: node.type
          });
        }
      }
    }
  }
  return {
    customNodes: Array.from(customNodes),
    cnrIds,
    auxIds,
    models: deduplicateModelRefs(models)
  };
}
function looksLikeModelFilename(value) {
  if (!value || typeof value !== "string") return false;
  const lower = value.toLowerCase();
  const extensions = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"];
  return extensions.some((ext) => lower.endsWith(ext));
}
function matchCustomNodes(customNodes, cnrIds, auxIds, availableNodes, installedNodeTypes, nodeMappings, installedNodeFolders) {
  const matches = [];
  const unresolved = [];
  const processedNodeTypes = /* @__PURE__ */ new Set();
  const nodeTypesList = Array.isArray(customNodes) ? customNodes : [];
  const cnrIdsMap = cnrIds && typeof cnrIds === "object" ? cnrIds : {};
  const auxIdsMap = auxIds && typeof auxIds === "object" ? auxIds : {};
  const library = Array.isArray(availableNodes) ? availableNodes : [];
  const installedTypes = installedNodeTypes instanceof Set ? installedNodeTypes : new Set(installedNodeTypes || []);
  const mappings = nodeMappings && typeof nodeMappings === "object" ? nodeMappings : {};
  const installedFolders = new Set(
    (Array.isArray(installedNodeFolders) ? installedNodeFolders : []).map((f) => typeof f === "string" ? f.toLowerCase() : "").filter(Boolean)
  );
  const repoToNodeMap = /* @__PURE__ */ new Map();
  const cnrIdToNodeMap = /* @__PURE__ */ new Map();
  const repoNameToNodesMap = /* @__PURE__ */ new Map();
  for (const node of library) {
    if (!node) continue;
    const repoUrl = node.gitRepo || node.repository || node.url || "";
    if (repoUrl) {
      repoToNodeMap.set(repoUrl.toLowerCase(), node);
      const repoName = extractRepoName(repoUrl);
      if (repoName) {
        const key = repoName.toLowerCase();
        if (!repoNameToNodesMap.has(key)) {
          repoNameToNodesMap.set(key, []);
        }
        repoNameToNodesMap.get(key).push(node);
      }
    }
    if (node.cnrId || node.cnr_id) {
      const cnrId = node.cnrId || node.cnr_id;
      if (typeof cnrId === "string" && cnrId.trim()) {
        cnrIdToNodeMap.set(cnrId.toLowerCase(), node);
      }
    }
  }
  const auxIdToNodeMap = /* @__PURE__ */ new Map();
  for (const node of library) {
    if (!node) continue;
    const repoUrl = node.gitRepo || node.repository || node.url || "";
    const auxKey = extractAuxId(repoUrl);
    if (auxKey) {
      auxIdToNodeMap.set(auxKey.toLowerCase(), node);
    }
  }
  function _repoNameFromIdentifier(identifier) {
    if (!identifier || typeof identifier !== "string") return null;
    const s = identifier.trim();
    if (!s) return null;
    if (s.includes("github.com")) {
      const repoName = extractRepoName(s);
      return repoName ? repoName.toLowerCase() : null;
    }
    if (s.includes("/")) {
      const parts = s.replace(/\.git$/i, "").split("/");
      const last = parts[parts.length - 1];
      return last ? last.toLowerCase() : null;
    }
    return s.replace(/\.git$/i, "").toLowerCase();
  }
  function _findLibraryNodeByIdentifier(identifier) {
    if (!identifier) return null;
    const id = String(identifier).trim();
    if (!id) return null;
    const idLower = id.toLowerCase();
    let node = cnrIdToNodeMap.get(idLower) || auxIdToNodeMap.get(idLower) || repoToNodeMap.get(idLower);
    if (node) return node;
    const repoNameLower = _repoNameFromIdentifier(id);
    if (repoNameLower) {
      const byRepoName = repoNameToNodesMap.get(repoNameLower) || [];
      if (byRepoName.length > 0) {
        const installed = byRepoName.find((n) => checkIfInstalled(n, installedFolders));
        return installed || byRepoName[0];
      }
    }
    return null;
  }
  for (const [cnrId, nodeType] of Object.entries(cnrIdsMap)) {
    if (processedNodeTypes.has(nodeType)) continue;
    if (cnrId === "comfy-core") {
      processedNodeTypes.add(nodeType);
      continue;
    }
    const libraryNode = _findLibraryNodeByIdentifier(cnrId);
    if (libraryNode) {
      processedNodeTypes.add(nodeType);
      const isInstalled = checkIfInstalled(libraryNode, installedFolders);
      matches.push({
        id: libraryNode.id || cnrId,
        name: libraryNode.name || libraryNode.title || "Unknown Custom Node",
        gitRepo: libraryNode.gitRepo || libraryNode.repository || libraryNode.url,
        matchedNodeType: nodeType,
        matchSource: "cnr_id",
        isInstalled,
        hasMultipleOptions: false,
        alternatives: []
      });
    } else {
      unresolved.push({ type: nodeType, reason: `CNR ID not found: ${cnrId}` });
    }
  }
  for (const [auxId, nodeType] of Object.entries(auxIdsMap)) {
    if (processedNodeTypes.has(nodeType)) continue;
    const libraryNode = _findLibraryNodeByIdentifier(auxId);
    if (libraryNode) {
      processedNodeTypes.add(nodeType);
      const isInstalled = checkIfInstalled(libraryNode, installedFolders);
      matches.push({
        id: libraryNode.id || auxId,
        name: libraryNode.name || libraryNode.title || "Unknown Custom Node",
        gitRepo: libraryNode.gitRepo || libraryNode.repository || libraryNode.url,
        matchedNodeType: nodeType,
        matchSource: "aux_id",
        isInstalled,
        hasMultipleOptions: false,
        alternatives: []
      });
    } else {
      unresolved.push({ type: nodeType, reason: `Aux ID not found: ${auxId}` });
    }
  }
  const nameToPacksMap = /* @__PURE__ */ new Map();
  for (const [url, data] of Object.entries(mappings)) {
    const nodeNames = Array.isArray(data) ? Array.isArray(data[0]) ? data[0] : data : [];
    for (const nodeName of nodeNames) {
      if (!nodeName || typeof nodeName !== "string") continue;
      if (!nameToPacksMap.has(nodeName)) {
        nameToPacksMap.set(nodeName, []);
      }
      nameToPacksMap.get(nodeName).push(url);
    }
  }
  for (const nodeType of nodeTypesList) {
    if (!nodeType || typeof nodeType !== "string") continue;
    if (processedNodeTypes.has(nodeType)) continue;
    processedNodeTypes.add(nodeType);
    const nodeTypeInstalled = installedTypes.has(nodeType);
    const packUrls = nameToPacksMap.get(nodeType.trim()) || [];
    if (packUrls.length === 0) {
      if (!nodeTypeInstalled) {
        unresolved.push({ type: nodeType, reason: "Not found in mappings" });
      }
      continue;
    }
    const candidateMap = /* @__PURE__ */ new Map();
    for (const url of packUrls) {
      if (!url || typeof url !== "string") continue;
      const repoName = extractRepoName(url);
      const packInstalled = repoName && installedFolders && installedFolders.has(repoName.toLowerCase());
      const keyBase = (repoName || url).toLowerCase();
      const nodesByName = repoName ? repoNameToNodesMap.get(repoName.toLowerCase()) || [] : [];
      const directMatch = repoToNodeMap.get(url.toLowerCase());
      const addCandidate = (nodeLike) => {
        const gitRepo = nodeLike?.gitRepo || nodeLike?.repository || nodeLike?.url || url;
        const name = nodeLike?.name || nodeLike?.title || repoName || "Unknown Custom Node";
        const id = nodeLike?.id || gitRepo || keyBase;
        const isInstalled = Boolean(packInstalled || checkIfInstalled(nodeLike, installedFolders));
        const mapKey = String(id).toLowerCase();
        if (!candidateMap.has(mapKey)) {
          candidateMap.set(mapKey, { id, name, gitRepo, isInstalled });
        } else {
          const existing = candidateMap.get(mapKey);
          candidateMap.set(mapKey, {
            ...existing,
            // Preserve "installed" if any source says installed
            isInstalled: Boolean(existing.isInstalled || isInstalled),
            // Prefer a concrete gitRepo/name if existing is missing
            gitRepo: existing.gitRepo || gitRepo,
            name: existing.name || name
          });
        }
      };
      if (nodesByName.length > 0) {
        for (const n of nodesByName) addCandidate(n);
      }
      if (directMatch) addCandidate(directMatch);
      if (nodesByName.length === 0 && !directMatch) {
        addCandidate({ id: keyBase, name: repoName || "Unknown Custom Node", gitRepo: url });
      }
    }
    const candidates = Array.from(candidateMap.values()).filter((c) => c && c.gitRepo).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    if (candidates.length === 0) {
      if (!nodeTypeInstalled) {
        unresolved.push({
          type: nodeType,
          reason: "Extension URL found but not in nuvu library",
          urls: packUrls
        });
      }
      continue;
    }
    const installedCandidates = candidates.filter((c) => c.isInstalled);
    if (installedCandidates.length > 0) {
      const primaryInstalled = installedCandidates[0];
      matches.push({
        id: primaryInstalled.id,
        name: primaryInstalled.name,
        gitRepo: primaryInstalled.gitRepo,
        matchedNodeType: nodeType,
        matchSource: "mapping",
        isInstalled: true,
        hasMultipleOptions: false,
        alternatives: []
      });
      continue;
    }
    if (nodeTypeInstalled) {
      continue;
    }
    const primary = candidates[0];
    const alternatives = candidates.slice(1).map((c) => ({
      id: c.id,
      name: c.name,
      gitRepo: c.gitRepo,
      isInstalled: false
    }));
    matches.push({
      id: primary.id,
      name: primary.name,
      gitRepo: primary.gitRepo,
      matchedNodeType: nodeType,
      matchSource: "mapping",
      isInstalled: false,
      hasMultipleOptions: alternatives.length > 0,
      alternatives
    });
  }
  const seen = /* @__PURE__ */ new Set();
  const deduped = matches.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return { matches: deduped, unresolved };
}
function checkIfInstalled(node, installedFolders) {
  if (!node || !installedFolders || installedFolders.size === 0) return false;
  const repoUrl = node.gitRepo || node.repository || node.url || "";
  const repoName = extractRepoName(repoUrl);
  if (repoName && installedFolders.has(repoName.toLowerCase())) {
    return true;
  }
  const name = node.name || node.title || "";
  if (name && installedFolders.has(name.toLowerCase())) {
    return true;
  }
  return false;
}
function extractRepoName(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
    const parts = cleaned.split("/");
    return parts[parts.length - 1] || null;
  } catch (error) {
    return null;
  }
}
function extractAuxId(repo) {
  if (!repo || typeof repo !== "string") return null;
  const s = repo.trim().replace(/\.git$/i, "");
  let m = s.match(/github\.com[:/]+([^/]+\/[^/]+)/i);
  if (m && m[1]) return m[1].replace(/\/$/, "");
  m = s.match(/^([^/\\\s]+)\/([^/\\\s]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}
function matchModels(modelRefs, modelsLibrary, existingModels) {
  const matches = [];
  const missing = [];
  const refs = Array.isArray(modelRefs) ? modelRefs : [];
  const library = Array.isArray(modelsLibrary) ? modelsLibrary : [];
  const existing = Array.isArray(existingModels) ? existingModels : [];
  const existingSet = new Set(
    existing.map((p2) => {
      if (typeof p2 !== "string") return "";
      const parts = p2.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1].toLowerCase();
    }).filter(Boolean)
  );
  const existingPaths = new Set(
    existing.map((p2) => typeof p2 === "string" ? p2.toLowerCase() : "").filter(Boolean)
  );
  const processed = /* @__PURE__ */ new Set();
  const MIN_MODEL_MATCH_SCORE = 0.85;
  function _basename(p2) {
    if (!p2 || typeof p2 !== "string") return "";
    return p2.split(/[/\\]/).pop();
  }
  function _stripKnownExtension(filename) {
    if (!filename || typeof filename !== "string") return filename;
    return filename.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i, "");
  }
  function _normalizeForMatch(s) {
    if (!s || typeof s !== "string") return "";
    return s.toLowerCase().replace(/[_\-\.\s]+/g, "").replace(/[^a-z0-9]/g, "");
  }
  function _levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const aLen = a.length;
    const bLen = b.length;
    if (aLen > bLen) return _levenshteinDistance(b, a);
    let prev = new Array(aLen + 1);
    let curr = new Array(aLen + 1);
    for (let i = 0; i <= aLen; i++) prev[i] = i;
    for (let j = 1; j <= bLen; j++) {
      curr[0] = j;
      const bChar = b.charCodeAt(j - 1);
      for (let i = 1; i <= aLen; i++) {
        const cost = a.charCodeAt(i - 1) === bChar ? 0 : 1;
        curr[i] = Math.min(
          prev[i] + 1,
          // deletion
          curr[i - 1] + 1,
          // insertion
          prev[i - 1] + cost
          // substitution
        );
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[aLen];
  }
  function _similarityScore(a, b) {
    const na = _normalizeForMatch(a);
    const nb = _normalizeForMatch(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const dist = _levenshteinDistance(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 0;
    return Math.max(0, 1 - dist / maxLen);
  }
  for (const modelRef of refs) {
    let _addCandidate = function(model, score, matchSource, isInstalled) {
      if (!model || !model.id) return;
      const id = model.id;
      const existing2 = candidateMap.get(id);
      if (!existing2) {
        candidateMap.set(id, { model, score, matchSource, isInstalled });
        return;
      }
      const bestScore = Math.max(existing2.score || 0, score || 0);
      const installed = Boolean(existing2.isInstalled || isInstalled);
      let source = existing2.matchSource || matchSource;
      if (existing2.matchSource && matchSource && existing2.matchSource !== matchSource) {
        const parts = new Set(String(source).split("+").concat(String(matchSource).split("+")));
        source = Array.from(parts).sort().join("+");
      }
      candidateMap.set(id, { model: existing2.model || model, score: bestScore, matchSource: source, isInstalled: installed });
    };
    if (!modelRef) continue;
    const originalPath = modelRef.name || modelRef.filename || modelRef.model_name || "";
    const modelName = originalPath;
    if (!modelName || typeof modelName !== "string") continue;
    const normalizedName = modelName.toLowerCase();
    const filename = _basename(modelName).toLowerCase();
    const filenameNoExt = _stripKnownExtension(filename);
    const referenceId = normalizedName;
    if (processed.has(filename)) continue;
    processed.add(filename);
    const referencedIsInstalled = existingSet.has(filename) || existingPaths.has(normalizedName);
    const candidateMap = /* @__PURE__ */ new Map();
    for (const model of library) {
      if (!model) continue;
      const libraryName = model.modelName || model.name || model.filename || "";
      if (!libraryName) continue;
      const libraryFilename = _basename(String(libraryName)).toLowerCase();
      const libraryFilenameNoExt = _stripKnownExtension(libraryFilename);
      let score = 0;
      if (libraryFilename === filename) {
        score = 1;
      } else {
        score = Math.max(
          _similarityScore(filename, libraryFilename),
          _similarityScore(filenameNoExt, libraryFilenameNoExt)
        );
      }
      if (score >= MIN_MODEL_MATCH_SCORE) {
        const candidateInstalled = existingSet.has(libraryFilename) || existingSet.has(_stripKnownExtension(libraryFilename)) || existingPaths.has(libraryFilename);
        _addCandidate(model, score, "library", candidateInstalled);
      }
    }
    const refNorm = _normalizeForMatch(filenameNoExt || filename);
    if (refNorm && refNorm.length >= 8) {
      const prefix8 = refNorm.slice(0, 8);
      for (const model of library) {
        if (!model) continue;
        const libraryName = model.modelName || model.name || model.filename || "";
        if (!libraryName) continue;
        const libraryFilename = _basename(String(libraryName)).toLowerCase();
        const libraryFilenameNoExt = _stripKnownExtension(libraryFilename);
        const libNorm = _normalizeForMatch(libraryFilenameNoExt || libraryFilename);
        if (!libNorm || libNorm.length < 8) continue;
        if (libNorm.slice(0, 8) !== prefix8) continue;
        const prefixScore = _similarityScore(refNorm, libNorm);
        const candidateInstalled = existingSet.has(libraryFilename) || existingSet.has(_stripKnownExtension(libraryFilename)) || existingPaths.has(libraryFilename);
        _addCandidate(model, Math.max(prefixScore, MIN_MODEL_MATCH_SCORE), "prefix8", candidateInstalled);
      }
    }
    const candidates = Array.from(candidateMap.values());
    candidates.sort((a, b) => {
      if (a.isInstalled !== b.isInstalled) return a.isInstalled ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      const an = (a.model?.modelName || a.model?.name || "").toString();
      const bn = (b.model?.modelName || b.model?.name || "").toString();
      return an.localeCompare(bn);
    });
    const primary = candidates[0] || null;
    const alternatives = candidates.slice(1).map((c) => ({
      libraryId: c.model.id,
      modelName: c.model.modelName || c.model.name,
      url: c.model.url || c.model.modelUrl || c.model.fileUrl || c.model.downloadUrl,
      installFolder: c.model.installFolder || c.model.category || "diffusion_models",
      hfTokenRequired: c.model.hfTokenRequired || false,
      size: c.model.size || c.model.fileSize || 0,
      score: c.score,
      isInstalled: c.isInstalled,
      matchSource: c.matchSource
    }));
    if (primary) {
      matches.push({
        id: referenceId,
        libraryId: primary.model.id,
        modelName: primary.model.modelName || primary.model.name,
        detectedName: modelName,
        originalPath,
        url: primary.model.url || primary.model.modelUrl || primary.model.fileUrl || primary.model.downloadUrl,
        installFolder: primary.model.installFolder || primary.model.category || "diffusion_models",
        hfTokenRequired: primary.model.hfTokenRequired || false,
        size: primary.model.size || primary.model.fileSize || 0,
        score: primary.score,
        isInstalled: primary.isInstalled,
        matchSource: primary.matchSource,
        hasMultipleOptions: alternatives.length > 0,
        alternatives
      });
    } else {
      missing.push({
        name: modelName,
        nodeType: modelRef.nodeType,
        isInstalled: referencedIsInstalled
      });
    }
  }
  return { matches, missing };
}
async function fetchCustomNodesLibrary() {
  try {
    const response = await fetch("/nuvu/custom-nodes", {
      headers: {
        "Authorization": `Bearer ${currentUser?.apiToken || ""}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch custom nodes: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    return [];
  }
}
async function fetchNodeMappings() {
  try {
    const response = await fetch("/nuvu/node-mappings", {
      headers: {
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch node mappings: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    return {};
  }
}
async function fetchInstalledCustomNodes() {
  try {
    const response = await fetch("/nuvu/custom-nodes/check-installed", {
      headers: {
        "Authorization": `Bearer ${currentUser?.apiToken || ""}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch installed custom nodes: ${response.status}`);
    }
    const data = await response.json();
    return data.installedNodes || [];
  } catch (error) {
    return [];
  }
}
const _hoisted_1$d = { class: "install-missing-panel" };
const _hoisted_2$d = {
  key: 0,
  class: "landing-view"
};
const _hoisted_3$c = { class: "landing-content" };
const _hoisted_4$c = {
  key: 0,
  class: "glow-btn",
  disabled: ""
};
const _hoisted_5$c = {
  key: 3,
  class: "error-message"
};
const _hoisted_6$c = {
  key: 1,
  class: "analyzing-view"
};
const _hoisted_7$c = {
  key: 2,
  class: "results-view"
};
const _hoisted_8$c = { class: "columns" };
const _hoisted_9$b = { class: "column" };
const _hoisted_10$b = { class: "column-header" };
const _hoisted_11$b = { class: "column-header-title" };
const _hoisted_12$a = { class: "column-content" };
const _hoisted_13$9 = {
  key: 0,
  class: "empty-message"
};
const _hoisted_14$9 = ["onClick"];
const _hoisted_15$8 = ["checked", "disabled", "onChange"];
const _hoisted_16$8 = { class: "item-content" };
const _hoisted_17$8 = ["value", "onChange"];
const _hoisted_18$8 = { value: -1 };
const _hoisted_19$8 = ["value", "disabled"];
const _hoisted_20$8 = {
  class: "alternatives-count",
  title: "Multiple packages provide this node type"
};
const _hoisted_21$8 = {
  key: 1,
  class: "item-name"
};
const _hoisted_22$8 = { class: "item-status" };
const _hoisted_23$8 = { class: "column" };
const _hoisted_24$7 = { class: "column-header" };
const _hoisted_25$6 = { class: "column-content" };
const _hoisted_26$6 = {
  key: 0,
  class: "empty-message"
};
const _hoisted_27$6 = ["onClick"];
const _hoisted_28$6 = ["checked", "disabled", "onChange"];
const _hoisted_29$6 = { class: "item-info" };
const _hoisted_30$6 = ["value", "onChange"];
const _hoisted_31$6 = { value: -1 };
const _hoisted_32$6 = ["value", "disabled"];
const _hoisted_33$6 = {
  class: "alternatives-count",
  title: "Multiple models matched this reference"
};
const _hoisted_34$6 = {
  key: 1,
  class: "item-name"
};
const _hoisted_35$5 = {
  key: 2,
  class: "item-original"
};
const _hoisted_36$5 = { class: "item-status" };
const _hoisted_37$5 = {
  key: 0,
  class: "hf-icon",
  title: "Requires HuggingFace token"
};
const _hoisted_38$5 = { class: "item-name" };
const _hoisted_39$5 = { class: "item-status not-found" };
const _hoisted_40$4 = { class: "footer" };
const _hoisted_41$3 = {
  key: 0,
  class: "hf-token-section"
};
const _hoisted_42$3 = { class: "hf-token-label" };
const _hoisted_43$3 = { class: "hf-token-input-group" };
const _hoisted_44$3 = ["type", "placeholder"];
const _hoisted_45$3 = ["title"];
const _hoisted_46$3 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_47$3 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_48$3 = { class: "footer-actions" };
const _hoisted_49$3 = ["disabled"];
const runpodTemplateUrl = "https://console.runpod.io/deploy?template=0lhzij38ow&ref=ffbuz4zw";
const runpodSignupUrl = "https://runpod.io?ref=ffbuz4zw";
const _sfc_main$e = {
  __name: "InstallMissingPanel",
  setup(__props) {
    const view = /* @__PURE__ */ ref("landing");
    const error = /* @__PURE__ */ ref(null);
    const injectedLicenseStatus = inject("licenseStatus", null);
    const isCheckingSubscription = computed(() => injectedLicenseStatus === null);
    const hasSubscription = computed(() => injectedLicenseStatus?.isActive === true);
    const nuvuVersions = inject("nuvuVersions", null);
    const showHFTokenModal = /* @__PURE__ */ ref(false);
    const matchedNodes = /* @__PURE__ */ ref([]);
    const matchedModels = /* @__PURE__ */ ref([]);
    const unmatchedModels = /* @__PURE__ */ ref([]);
    const selectedNodes = /* @__PURE__ */ ref(/* @__PURE__ */ new Set());
    const selectedModels2 = /* @__PURE__ */ ref(/* @__PURE__ */ new Set());
    const skipNodeUpdates = /* @__PURE__ */ ref(false);
    const selectedAlternatives = /* @__PURE__ */ ref(/* @__PURE__ */ new Map());
    const selectedModelAlternatives = /* @__PURE__ */ ref(/* @__PURE__ */ new Map());
    const hfToken = /* @__PURE__ */ ref("");
    const showHfToken = /* @__PURE__ */ ref(false);
    const hasSelectedModels = computed(() => {
      return matchedModels.value.some(
        (m) => selectedModels2.value.has(m.id) && !m.isInstalled
      );
    });
    const requiresHFToken = computed(() => {
      return matchedModels.value.some(
        (m) => selectedModels2.value.has(m.id) && m.hfTokenRequired && !m.isInstalled
      );
    });
    const isInstalling = /* @__PURE__ */ ref(false);
    const installStatus = /* @__PURE__ */ ref("");
    let abortController = null;
    let hfTokenUpdatedHandler = null;
    const { isActive, pollOnce: pollOnce2, startPolling } = useQueueProgress();
    watch(isActive, (next) => {
      if (!next) {
        isInstalling.value = false;
      }
    });
    const mismatchedModels = computed(() => {
      return matchedModels.value.map((m) => getEffectiveModel(m)).filter((m) => m.detectedName && m.modelName && m.detectedName !== m.modelName).map((m) => ({
        id: m.id,
        detectedName: m.detectedName,
        originalPath: m.originalPath || m.detectedName,
        installedName: m.modelName
      }));
    });
    const selectedMismatchedModels = computed(() => {
      return mismatchedModels.value.filter((m) => selectedModels2.value.has(m.id));
    });
    const showFixNamesConfirm = /* @__PURE__ */ ref(false);
    const hasAnyModelsSelected = computed(() => selectedModels2.value.size > 0);
    const hasAnyNodesToProcess = computed(() => {
      if (selectedNodes.value.size > 0) return true;
      return matchedNodes.value.some((n) => getEffectiveNode(n).isInstalled);
    });
    const canRunInstall = computed(() => {
      return !isInstalling.value && (hasAnyNodesToProcess.value || hasAnyModelsSelected.value);
    });
    const selectedModelsTotalSizeGB = computed(() => {
      const alternativesMap = selectedModelAlternatives.value;
      let totalSize = 0;
      for (const model of matchedModels.value) {
        if (!selectedModels2.value.has(model.id)) continue;
        const alt = alternativesMap.get(model.id);
        const effectiveModel = alt ? { ...model, ...alt } : model;
        if (effectiveModel.isInstalled) continue;
        const size = effectiveModel.size || effectiveModel.fileSize || 0;
        if (typeof size === "number" && size > 0) {
          totalSize += size;
        }
      }
      return totalSize;
    });
    const installButtonLabel = computed(() => {
      if (isInstalling.value) return "Installing...";
      if (!hasAnyModelsSelected.value && hasAnyNodesToProcess.value) return "Update Nodes";
      const sizeGB = selectedModelsTotalSizeGB.value;
      if (sizeGB > 0) {
        return `Install Selected (${sizeGB.toFixed(1)} GB)`;
      }
      return "Install Selected";
    });
    const installButtonVramClass = computed(() => {
      if (!hasSubscription.value) return "";
      const vramGB = nuvuVersions?.value?.gpu?.vram_gb;
      if (!vramGB || vramGB <= 0) return "";
      const modelSizeGB = selectedModelsTotalSizeGB.value;
      if (modelSizeGB <= 0) return "vram-compatible";
      const ratio = modelSizeGB / vramGB;
      if (ratio >= 3) return "vram-incompatible";
      if (ratio >= 2) return "vram-warning";
      return "vram-compatible";
    });
    const showVramWarning = /* @__PURE__ */ ref(false);
    function isVramIncompatible() {
      if (!hasSubscription.value) return false;
      const vramGB = nuvuVersions?.value?.gpu?.vram_gb;
      if (!vramGB || vramGB <= 0) return false;
      const modelSizeGB = selectedModelsTotalSizeGB.value;
      if (modelSizeGB <= 0) return false;
      return modelSizeGB / vramGB >= 3;
    }
    const vramWarningMessage = computed(() => {
      const sizeGB = selectedModelsTotalSizeGB.value.toFixed(1);
      return `Based on our estimates, the selected models (${sizeGB} GB) may not run on your machine.

This is just an estimate. You may still be able to run these models, but may want to look for alternative models like fp8 or gguf to be sure.`;
    });
    function cancelVramWarning() {
      showVramWarning.value = false;
    }
    onMounted(async () => {
      try {
        const configResponse = await fetch("/nuvu/user-config");
        if (configResponse.ok) {
          const config = await configResponse.json();
          if (config?.huggingface_token) {
            hfToken.value = config.huggingface_token;
          }
        }
        hfTokenUpdatedHandler = (event) => {
          try {
            const nextToken = event?.detail || "";
            hfToken.value = typeof nextToken === "string" ? nextToken : "";
          } catch {
          }
        };
        window.addEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
      } catch (e) {
      }
    });
    onUnmounted(() => {
      if (hfTokenUpdatedHandler) {
        window.removeEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
        hfTokenUpdatedHandler = null;
      }
    });
    function openSubscriptionPage() {
      const baseUrl = getWebsiteBaseUrl();
      window.open(baseUrl ? `${baseUrl}/#pricing` : "/#pricing", "_blank");
    }
    async function startAnalysis() {
      view.value = "analyzing";
      error.value = null;
      try {
        const { customNodes, cnrIds, auxIds, models } = getCurrentWorkflowDependencies();
        const [availableNodes, nodeMappings, installedNodeFolders, installedModelIds] = await Promise.all([
          fetchCustomNodesLibrary(),
          fetchNodeMappings(),
          fetchInstalledCustomNodes(),
          getExistingModels()
        ]);
        const availableModels = modelsData || [];
        const installedNodeTypes = new Set(
          Object.keys(LiteGraph?.registered_node_types || {})
        );
        const nodeResults = matchCustomNodes(
          customNodes,
          cnrIds,
          auxIds,
          availableNodes,
          installedNodeTypes,
          nodeMappings,
          installedNodeFolders
        );
        const modelResults = matchModels(models, availableModels, installedModelIds);
        matchedNodes.value = nodeResults.matches;
        matchedModels.value = modelResults.matches;
        unmatchedModels.value = modelResults.missing || [];
        selectedNodes.value = new Set(matchedNodes.value.filter((n) => !n.isInstalled).map((n) => n.id));
        selectedModels2.value = new Set(
          matchedModels.value.filter((m) => !m.isInstalled).map((m) => m.id)
        );
        view.value = "results";
      } catch (e) {
        console.error("[nuvu] Analysis failed:", e);
        error.value = e.message;
        view.value = "landing";
      }
    }
    function toggleNode(nodeId) {
      const newSet = new Set(selectedNodes.value);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      selectedNodes.value = newSet;
    }
    function toggleModel(modelId) {
      const newSet = new Set(selectedModels2.value);
      if (newSet.has(modelId)) {
        newSet.delete(modelId);
      } else {
        newSet.add(modelId);
      }
      selectedModels2.value = newSet;
    }
    function selectAlternative(nodeId, alternativeIndex, node) {
      const newMap = new Map(selectedAlternatives.value);
      if (alternativeIndex === -1) {
        newMap.delete(nodeId);
      } else if (node.alternatives && node.alternatives[alternativeIndex]) {
        newMap.set(nodeId, node.alternatives[alternativeIndex]);
      }
      selectedAlternatives.value = newMap;
    }
    function selectModelAlternative(modelId, alternativeIndex, model) {
      const newMap = new Map(selectedModelAlternatives.value);
      if (alternativeIndex === -1) {
        newMap.delete(modelId);
      } else if (model.alternatives && model.alternatives[alternativeIndex]) {
        newMap.set(modelId, model.alternatives[alternativeIndex]);
      }
      selectedModelAlternatives.value = newMap;
      const effective = getEffectiveModel(model);
      if (effective.isInstalled) {
        const newSet = new Set(selectedModels2.value);
        newSet.delete(modelId);
        selectedModels2.value = newSet;
      }
    }
    function getEffectiveNode(node) {
      const alt = selectedAlternatives.value.get(node.id);
      if (alt) {
        return {
          ...node,
          id: alt.id,
          name: alt.name,
          gitRepo: alt.gitRepo,
          isInstalled: alt.isInstalled
        };
      }
      return node;
    }
    function getEffectiveModel(model) {
      const alt = selectedModelAlternatives.value.get(model.id);
      if (alt) {
        return {
          ...model,
          libraryId: alt.libraryId,
          modelName: alt.modelName,
          url: alt.url,
          installFolder: alt.installFolder,
          hfTokenRequired: alt.hfTokenRequired,
          score: alt.score ?? model.score,
          isInstalled: alt.isInstalled
        };
      }
      return model;
    }
    function selectAll() {
      selectedNodes.value = new Set(matchedNodes.value.filter((n) => !n.isInstalled).map((n) => n.id));
      selectedModels2.value = new Set(matchedModels.value.filter((m) => !m.isInstalled).map((m) => m.id));
    }
    function deselectAll() {
      selectedNodes.value = /* @__PURE__ */ new Set();
      selectedModels2.value = /* @__PURE__ */ new Set();
    }
    async function fixModelNames() {
      if (selectedMismatchedModels.value.length === 0) return;
      try {
        const { app: app2 } = await import("/scripts/app.js");
        let totalFixed = 0;
        for (const model of selectedMismatchedModels.value) {
          const searchPath = model.originalPath;
          const newName = model.installedName;
          if (app2?.graph?._nodes) {
            for (const node of app2.graph._nodes) {
              if (node.widgets) {
                for (const widget of node.widgets) {
                  if (typeof widget.value === "string") {
                    const valFilename = widget.value.split(/[/\\]/).pop();
                    if (widget.value === searchPath || valFilename === searchPath.split(/[/\\]/).pop()) {
                      widget.value = newName;
                      totalFixed++;
                      if (widget.callback) {
                        try {
                          widget.callback(newName);
                        } catch {
                        }
                      }
                    }
                  }
                }
              }
            }
            if (totalFixed > 0) app2.graph.change();
          }
        }
        if (totalFixed > 0) {
          console.log(`[nuvu] Fixed ${totalFixed} model references`);
        }
      } catch (e) {
        console.error("[nuvu] Fix model names failed:", e);
      }
    }
    function requestFixModelNames() {
      if (selectedMismatchedModels.value.length === 0) return;
      showFixNamesConfirm.value = true;
    }
    async function confirmFixModelNames() {
      showFixNamesConfirm.value = false;
      await fixModelNames();
    }
    function cancelFixModelNames() {
      showFixNamesConfirm.value = false;
    }
    async function handleInstall() {
      if (!canRunInstall.value) return;
      if (requiresHFToken.value && !hfToken.value.trim()) {
        showHFTokenModal.value = true;
        return;
      }
      if (isVramIncompatible()) {
        showVramWarning.value = true;
        return;
      }
      await proceedWithInstall();
    }
    async function proceedWithInstall() {
      showVramWarning.value = false;
      try {
        if (selectedMismatchedModels.value.length > 0) {
          const fixes = selectedMismatchedModels.value.map((m) => ({
            searchPath: m.originalPath,
            newName: m.installedName
          }));
          window.localStorage.setItem(
            "nuvu_pending_model_name_fixes",
            JSON.stringify({ createdAt: Date.now(), fixes })
          );
        } else {
          window.localStorage.removeItem("nuvu_pending_model_name_fixes");
        }
      } catch {
      }
      isInstalling.value = true;
      installStatus.value = "Preparing installation...";
      abortController = new AbortController();
      startPolling();
      try {
        const selectedMissingNodes = matchedNodes.value.filter((n) => selectedNodes.value.has(n.id)).map((n) => getEffectiveNode(n)).map((n) => ({ id: n.id, name: n.name, url: n.gitRepo }));
        const installedNodesToUpdate = skipNodeUpdates.value ? [] : matchedNodes.value.map((n) => getEffectiveNode(n)).filter((n) => n.isInstalled).map((n) => ({ id: n.id, name: n.name, url: n.gitRepo }));
        const nodesToInstall = Array.from(
          new Map(
            [...installedNodesToUpdate, ...selectedMissingNodes].filter((n) => n.url).map((n) => [n.url, n])
          ).values()
        );
        const rawModelsToInstall = matchedModels.value.filter((m) => selectedModels2.value.has(m.id)).map((m) => getEffectiveModel(m)).filter((m) => !m.isInstalled).map((m) => ({
          id: m.libraryId,
          name: m.modelName || m.name,
          url: m.url || m.modelUrl || m.fileUrl || m.downloadUrl || "",
          hf_token_required: m.hfTokenRequired,
          installFolder: m.installFolder || "diffusion_models"
        }));
        const modelsToInstall = Array.from(
          new Map(rawModelsToInstall.map((m) => [m.id, m])).values()
        );
        const payload = {
          user_id: currentUser?.id,
          user_email: currentUser?.email,
          access_token: currentUser?.apiToken,
          options: {
            workflows: [],
            subgraphs: [],
            models: modelsToInstall,
            custom_nodes: nodesToInstall,
            huggingface_token: hfToken.value.trim() || void 0
          },
          script_filename: "workflow_downloader.py"
        };
        installStatus.value = "Starting installation...";
        const response = await fetch("/nuvu/execute/script", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify(payload),
          signal: abortController.signal
        });
        if (!response.ok) {
          throw new Error(`Installation request failed: ${response.status}`);
        }
        installStatus.value = "Installing...";
        try {
          await pollOnce2();
        } catch {
        }
      } catch (e) {
        if (e.name === "AbortError") {
          installStatus.value = "Installation cancelled";
        } else {
          console.error("[nuvu] Installation failed:", e);
          installStatus.value = `Error: ${e.message}`;
        }
        isInstalling.value = false;
      }
    }
    async function handleCancel() {
      if (!isInstalling.value) return;
      try {
        abortController?.abort();
        await fetch("/nuvu/execute/cancel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify({ user_email: currentUser?.email })
        });
      } catch (e) {
        console.error("[nuvu] Cancel failed:", e);
      }
      isInstalling.value = false;
      installStatus.value = "";
    }
    function handleHFTokenSubmit(tokenValue) {
      hfToken.value = tokenValue;
      showHFTokenModal.value = false;
      if (isVramIncompatible()) {
        showVramWarning.value = true;
        return;
      }
      proceedWithInstall();
    }
    function handleHFTokenCancel() {
      showHFTokenModal.value = false;
    }
    function getMatchScore(item) {
      if (item.isInstalled) return "Installed";
      const score = item.score !== void 0 ? item.score : 1;
      return `${Math.round(score * 100)}%`;
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$d, [
        createVNode(QueueProgress, {
          phases: ["custom_nodes", "models"],
          title: "Installing..."
        }),
        view.value === "landing" ? (openBlock(), createElementBlock("div", _hoisted_2$d, [
          createBaseVNode("div", _hoisted_3$c, [
            _cache[9] || (_cache[9] = createBaseVNode("h1", { class: "landing-title" }, "Install Missing Dependencies", -1)),
            _cache[10] || (_cache[10] = createBaseVNode("p", { class: "landing-description" }, [
              createTextVNode(" This tool analyzes your currently open workflow to identify all custom nodes and models it requires. "),
              createBaseVNode("br"),
              createBaseVNode("br"),
              createTextVNode(" It then attempts to match them against the Nuvu library and download them straight into your environment. ")
            ], -1)),
            isCheckingSubscription.value ? (openBlock(), createElementBlock("button", _hoisted_4$c, " Checking subscription... ")) : hasSubscription.value ? (openBlock(), createElementBlock("button", {
              key: 1,
              class: "glow-btn",
              onClick: startAnalysis
            }, " Find Missing ")) : (openBlock(), createElementBlock("button", {
              key: 2,
              class: "glow-btn",
              onClick: openSubscriptionPage
            }, [..._cache[8] || (_cache[8] = [
              createBaseVNode("span", { class: "lock-icon" }, "🔒", -1),
              createTextVNode(" Subscribe ", -1)
            ])])),
            error.value ? (openBlock(), createElementBlock("p", _hoisted_5$c, toDisplayString(error.value), 1)) : createCommentVNode("", true)
          ])
        ])) : view.value === "analyzing" ? (openBlock(), createElementBlock("div", _hoisted_6$c, [..._cache[11] || (_cache[11] = [
          createBaseVNode("div", { class: "analyzing-content" }, [
            createBaseVNode("div", { class: "spinner" }),
            createBaseVNode("h2", null, "Analyzing Workflow...")
          ], -1)
        ])])) : view.value === "results" ? (openBlock(), createElementBlock("div", _hoisted_7$c, [
          _cache[18] || (_cache[18] = createBaseVNode("div", { class: "info-header" }, [
            createBaseVNode("strong", null, "Install Missing Dependencies"),
            createTextVNode(" - Select the custom nodes and models you want to install. Items already installed are shown as disabled. "),
            createBaseVNode("br"),
            createBaseVNode("br"),
            createBaseVNode("strong", { class: "orange" }, "Note:"),
            createTextVNode(" Some custom nodes may have the same name but come from different packages. When you see a dropdown with multiple options, choose the correct package for your workflow. "),
            createBaseVNode("br"),
            createBaseVNode("br"),
            createTextVNode(" If a model shows less than 100% match, use the "),
            createBaseVNode("strong", null, "Fix Model Names"),
            createTextVNode(" button to automatically update the workflow with the correct model filenames. "),
            createBaseVNode("div", { class: "warning-text" }, " Installing Custom Nodes that do not come with the official Nuvu Workflows can lead to mismatched software requirements, and break your ComfyUI install. Install with caution. ")
          ], -1)),
          createBaseVNode("div", { class: "toolbar" }, [
            createBaseVNode("button", {
              class: "action-btn",
              onClick: selectAll
            }, "Select All"),
            createBaseVNode("button", {
              class: "action-btn",
              onClick: deselectAll
            }, "Deselect All")
          ]),
          createBaseVNode("div", _hoisted_8$c, [
            createBaseVNode("div", _hoisted_9$b, [
              createBaseVNode("div", _hoisted_10$b, [
                createBaseVNode("div", _hoisted_11$b, "Custom Nodes (" + toDisplayString(matchedNodes.value.length) + ")", 1),
                createBaseVNode("label", {
                  class: "skip-updates-checkbox",
                  onClick: _cache[1] || (_cache[1] = withModifiers(() => {
                  }, ["stop"]))
                }, [
                  withDirectives(createBaseVNode("input", {
                    type: "checkbox",
                    "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => skipNodeUpdates.value = $event)
                  }, null, 512), [
                    [vModelCheckbox, skipNodeUpdates.value]
                  ]),
                  _cache[12] || (_cache[12] = createBaseVNode("span", { class: "skip-updates-label" }, "Skip updates", -1))
                ])
              ]),
              createBaseVNode("div", _hoisted_12$a, [
                matchedNodes.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_13$9, " None detected ")) : createCommentVNode("", true),
                (openBlock(true), createElementBlock(Fragment, null, renderList(matchedNodes.value, (node) => {
                  return openBlock(), createElementBlock("div", {
                    key: node.id,
                    class: normalizeClass(["list-item", {
                      disabled: getEffectiveNode(node).isInstalled,
                      "has-alternatives": node.hasMultipleOptions && !getEffectiveNode(node).isInstalled
                    }]),
                    onClick: ($event) => !getEffectiveNode(node).isInstalled && toggleNode(node.id)
                  }, [
                    createBaseVNode("input", {
                      type: "checkbox",
                      checked: selectedNodes.value.has(node.id),
                      disabled: getEffectiveNode(node).isInstalled,
                      onClick: _cache[2] || (_cache[2] = withModifiers(() => {
                      }, ["stop"])),
                      onChange: ($event) => toggleNode(node.id)
                    }, null, 40, _hoisted_15$8),
                    createBaseVNode("div", _hoisted_16$8, [
                      node.hasMultipleOptions && !getEffectiveNode(node).isInstalled ? (openBlock(), createElementBlock("div", {
                        key: 0,
                        class: "alternatives-dropdown",
                        onClick: _cache[3] || (_cache[3] = withModifiers(() => {
                        }, ["stop"]))
                      }, [
                        createBaseVNode("select", {
                          class: "alternative-select",
                          value: selectedAlternatives.value.get(node.id) ? node.alternatives.findIndex((a) => a.id === selectedAlternatives.value.get(node.id).id) : -1,
                          onChange: ($event) => selectAlternative(node.id, parseInt($event.target.value), node)
                        }, [
                          createBaseVNode("option", _hoisted_18$8, toDisplayString(node.name), 1),
                          (openBlock(true), createElementBlock(Fragment, null, renderList(node.alternatives, (alt, idx) => {
                            return openBlock(), createElementBlock("option", {
                              key: alt.id,
                              value: idx,
                              disabled: alt.isInstalled
                            }, toDisplayString(alt.name) + toDisplayString(alt.isInstalled ? " (Installed)" : ""), 9, _hoisted_19$8);
                          }), 128))
                        ], 40, _hoisted_17$8),
                        createBaseVNode("span", _hoisted_20$8, toDisplayString(node.alternatives.length + 1) + " options ", 1)
                      ])) : (openBlock(), createElementBlock("span", _hoisted_21$8, toDisplayString(getEffectiveNode(node).name), 1))
                    ]),
                    createBaseVNode("span", _hoisted_22$8, toDisplayString(getEffectiveNode(node).isInstalled ? "Installed" : "100%"), 1)
                  ], 10, _hoisted_14$9);
                }), 128))
              ])
            ]),
            createBaseVNode("div", _hoisted_23$8, [
              createBaseVNode("div", _hoisted_24$7, " Models (" + toDisplayString(matchedModels.value.length + unmatchedModels.value.length) + ") ", 1),
              createBaseVNode("div", _hoisted_25$6, [
                matchedModels.value.length === 0 && unmatchedModels.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_26$6, " None detected ")) : createCommentVNode("", true),
                (openBlock(true), createElementBlock(Fragment, null, renderList(matchedModels.value, (model) => {
                  return openBlock(), createElementBlock("div", {
                    key: model.id,
                    class: normalizeClass(["list-item", {
                      disabled: getEffectiveModel(model).isInstalled,
                      "has-alternatives": model.hasMultipleOptions
                    }]),
                    onClick: ($event) => !getEffectiveModel(model).isInstalled && toggleModel(model.id)
                  }, [
                    createBaseVNode("input", {
                      type: "checkbox",
                      checked: selectedModels2.value.has(model.id),
                      disabled: getEffectiveModel(model).isInstalled,
                      onClick: _cache[4] || (_cache[4] = withModifiers(() => {
                      }, ["stop"])),
                      onChange: ($event) => toggleModel(model.id)
                    }, null, 40, _hoisted_28$6),
                    createBaseVNode("div", _hoisted_29$6, [
                      model.hasMultipleOptions && !getEffectiveModel(model).isInstalled ? (openBlock(), createElementBlock("div", {
                        key: 0,
                        class: "alternatives-dropdown",
                        onClick: _cache[5] || (_cache[5] = withModifiers(() => {
                        }, ["stop"]))
                      }, [
                        createBaseVNode("select", {
                          class: "alternative-select",
                          value: selectedModelAlternatives.value.get(model.id) ? model.alternatives.findIndex((a) => a.libraryId === selectedModelAlternatives.value.get(model.id).libraryId) : -1,
                          onChange: ($event) => selectModelAlternative(model.id, parseInt($event.target.value), model)
                        }, [
                          createBaseVNode("option", _hoisted_31$6, toDisplayString(model.modelName), 1),
                          (openBlock(true), createElementBlock(Fragment, null, renderList(model.alternatives, (alt, idx) => {
                            return openBlock(), createElementBlock("option", {
                              key: alt.libraryId,
                              value: idx,
                              disabled: alt.isInstalled
                            }, toDisplayString(alt.modelName) + toDisplayString(alt.isInstalled ? " (Installed)" : ""), 9, _hoisted_32$6);
                          }), 128))
                        ], 40, _hoisted_30$6),
                        createBaseVNode("span", _hoisted_33$6, toDisplayString(model.alternatives.length + 1) + " options ", 1)
                      ])) : (openBlock(), createElementBlock("span", _hoisted_34$6, toDisplayString(getEffectiveModel(model).score < 1 && getEffectiveModel(model).detectedName !== getEffectiveModel(model).modelName ? `Matched: ${getEffectiveModel(model).modelName}` : getEffectiveModel(model).modelName), 1)),
                      getEffectiveModel(model).score < 1 && getEffectiveModel(model).detectedName !== getEffectiveModel(model).modelName ? (openBlock(), createElementBlock("span", _hoisted_35$5, " Original: " + toDisplayString(getEffectiveModel(model).detectedName), 1)) : createCommentVNode("", true)
                    ]),
                    createBaseVNode("span", _hoisted_36$5, [
                      createTextVNode(toDisplayString(getMatchScore(getEffectiveModel(model))) + " ", 1),
                      getEffectiveModel(model).hfTokenRequired ? (openBlock(), createElementBlock("span", _hoisted_37$5, "🔒")) : createCommentVNode("", true)
                    ])
                  ], 10, _hoisted_27$6);
                }), 128)),
                (openBlock(true), createElementBlock(Fragment, null, renderList(unmatchedModels.value, (model) => {
                  return openBlock(), createElementBlock("div", {
                    key: model.name,
                    class: normalizeClass(["list-item unmatched", { "installed-local": model.isInstalled }])
                  }, [
                    createBaseVNode("span", _hoisted_38$5, toDisplayString(model.name), 1),
                    createBaseVNode("span", _hoisted_39$5, toDisplayString(model.isInstalled ? "Installed (not in library)" : "Not Found"), 1)
                  ], 2);
                }), 128))
              ])
            ])
          ]),
          createBaseVNode("div", _hoisted_40$4, [
            hasSelectedModels.value ? (openBlock(), createElementBlock("div", _hoisted_41$3, [
              createBaseVNode("label", _hoisted_42$3, [
                _cache[13] || (_cache[13] = createTextVNode(" HuggingFace Token ", -1)),
                createBaseVNode("span", {
                  class: normalizeClass({ "required": requiresHFToken.value, "optional": !requiresHFToken.value })
                }, " (" + toDisplayString(requiresHFToken.value ? "Required" : "Optional") + ") ", 3)
              ]),
              createBaseVNode("div", _hoisted_43$3, [
                withDirectives(createBaseVNode("input", {
                  "onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => hfToken.value = $event),
                  type: showHfToken.value ? "text" : "password",
                  placeholder: requiresHFToken.value ? "Enter your HuggingFace token (required)" : "Enter your HuggingFace token (optional)",
                  class: "hf-token-input"
                }, null, 8, _hoisted_44$3), [
                  [vModelDynamic, hfToken.value]
                ]),
                createBaseVNode("button", {
                  type: "button",
                  class: "hf-token-toggle",
                  onClick: _cache[7] || (_cache[7] = ($event) => showHfToken.value = !showHfToken.value),
                  title: showHfToken.value ? "Hide token" : "Show token"
                }, [
                  showHfToken.value ? (openBlock(), createElementBlock("svg", _hoisted_46$3, [..._cache[14] || (_cache[14] = [
                    createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                    createBaseVNode("line", {
                      x1: "1",
                      y1: "1",
                      x2: "23",
                      y2: "23"
                    }, null, -1)
                  ])])) : (openBlock(), createElementBlock("svg", _hoisted_47$3, [..._cache[15] || (_cache[15] = [
                    createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                    createBaseVNode("circle", {
                      cx: "12",
                      cy: "12",
                      r: "3"
                    }, null, -1)
                  ])]))
                ], 8, _hoisted_45$3)
              ]),
              _cache[16] || (_cache[16] = createBaseVNode("p", { class: "hf-token-help" }, [
                createTextVNode(" For faster downloads and access to private models. "),
                createBaseVNode("a", {
                  href: "https://huggingface.co/settings/tokens",
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, "Click here to create a token"),
                createTextVNode(". ")
              ], -1))
            ])) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_48$3, [
              !isInstalling.value ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "analyze-btn",
                onClick: startAnalysis,
                title: "Re-analyze current workflow"
              }, [..._cache[17] || (_cache[17] = [
                createBaseVNode("span", { class: "refresh-icon" }, "↻", -1),
                createTextVNode(" Analyze New Workflow ", -1)
              ])])) : createCommentVNode("", true),
              mismatchedModels.value.length > 0 && !isInstalling.value ? (openBlock(), createElementBlock("button", {
                key: 1,
                class: "fix-btn",
                onClick: requestFixModelNames
              }, " Fix Model Names ")) : createCommentVNode("", true),
              isInstalling.value ? (openBlock(), createElementBlock("button", {
                key: 2,
                class: "cancel-btn",
                onClick: handleCancel
              }, " Cancel Install ")) : createCommentVNode("", true),
              createBaseVNode("button", {
                class: normalizeClass(["install-btn", installButtonVramClass.value]),
                disabled: !canRunInstall.value,
                onClick: handleInstall
              }, toDisplayString(installButtonLabel.value), 11, _hoisted_49$3)
            ])
          ])
        ])) : createCommentVNode("", true),
        showHFTokenModal.value ? (openBlock(), createBlock(HuggingFaceTokenModal, {
          key: 3,
          context: "model",
          onSubmit: handleHFTokenSubmit,
          onCancel: handleHFTokenCancel
        })) : createCommentVNode("", true),
        showFixNamesConfirm.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 4,
          title: "Fix model names in workflow",
          message: `This will update model references in your currently open workflow for ${selectedMismatchedModels.value.length} selected item${selectedMismatchedModels.value.length !== 1 ? "s" : ""}. Continue?`,
          "confirm-text": "Fix names",
          "cancel-text": "Cancel",
          onConfirm: confirmFixModelNames,
          onCancel: cancelFixModelNames
        }, null, 8, ["message"])) : createCommentVNode("", true),
        showVramWarning.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 5,
          title: "Warning",
          message: vramWarningMessage.value,
          "confirm-text": "Install Anyway",
          "cancel-text": "Cancel",
          onConfirm: proceedWithInstall,
          onCancel: cancelVramWarning
        }, {
          extra: withCtx(() => [
            createBaseVNode("div", { class: "runpod-link" }, [
              createBaseVNode("p", null, [
                _cache[19] || (_cache[19] = createTextVNode(" Want more power? Try our ", -1)),
                createBaseVNode("a", {
                  href: runpodTemplateUrl,
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, "RunPod cloud template")
              ]),
              createBaseVNode("p", { class: "signup-line" }, [
                _cache[20] || (_cache[20] = createTextVNode(" Don't have an account? ", -1)),
                createBaseVNode("a", {
                  href: runpodSignupUrl,
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, "Sign up here")
              ])
            ])
          ]),
          _: 1
        }, 8, ["message"])) : createCommentVNode("", true)
      ]);
    };
  }
};
const InstallMissingPanel = /* @__PURE__ */ _export_sfc(_sfc_main$e, [["__scopeId", "data-v-ce44e080"]]);
const _hoisted_1$c = { class: "modal-content" };
const _hoisted_2$c = {
  key: 0,
  class: "premium-overlay"
};
const _hoisted_3$b = { class: "input-group" };
const _hoisted_4$b = ["disabled"];
const _hoisted_5$b = {
  key: 0,
  class: "url-type-hint"
};
const _hoisted_6$b = {
  key: 0,
  class: "hint-hf"
};
const _hoisted_7$b = {
  key: 1,
  class: "hint-civitai"
};
const _hoisted_8$b = {
  key: 2,
  class: "hint-direct"
};
const _hoisted_9$a = { class: "input-group" };
const _hoisted_10$a = ["disabled"];
const _hoisted_11$a = { class: "input-group" };
const _hoisted_12$9 = { for: "model-folder" };
const _hoisted_13$8 = ["disabled"];
const _hoisted_14$8 = { class: "folder-row" };
const _hoisted_15$7 = ["disabled"];
const _hoisted_16$7 = ["value"];
const _hoisted_17$7 = ["disabled"];
const _hoisted_18$7 = ["disabled"];
const _hoisted_19$7 = {
  key: 0,
  class: "folder-hint"
};
const _hoisted_20$7 = {
  key: 1,
  class: "queue-section"
};
const _hoisted_21$7 = { class: "queue-header" };
const _hoisted_22$7 = { class: "queue-title" };
const _hoisted_23$7 = ["disabled"];
const _hoisted_24$6 = { class: "queue-list" };
const _hoisted_25$5 = { class: "queue-item-info" };
const _hoisted_26$5 = { class: "queue-item-filename" };
const _hoisted_27$5 = {
  key: 0,
  class: "queue-item-size"
};
const _hoisted_28$5 = { class: "queue-item-meta" };
const _hoisted_29$5 = { class: "queue-item-folder" };
const _hoisted_30$5 = ["onClick", "disabled"];
const _hoisted_31$5 = {
  key: 2,
  class: "input-group token-group"
};
const _hoisted_32$5 = { class: "token-input-wrapper" };
const _hoisted_33$5 = ["type", "disabled"];
const _hoisted_34$5 = ["title"];
const _hoisted_35$4 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_36$4 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_37$4 = {
  key: 3,
  class: "input-group token-group"
};
const _hoisted_38$4 = { class: "token-input-wrapper" };
const _hoisted_39$4 = ["type", "disabled"];
const _hoisted_40$3 = ["title"];
const _hoisted_41$2 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_42$2 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_43$2 = {
  key: 4,
  class: "error-text"
};
const _hoisted_44$2 = {
  key: 5,
  class: "warning-text"
};
const _hoisted_45$2 = { key: 0 };
const _hoisted_46$2 = { key: 1 };
const _hoisted_47$2 = { class: "modal-actions" };
const _hoisted_48$2 = ["disabled"];
const _hoisted_49$2 = ["disabled"];
const SUBSCRIBE_URL = "https://app.nuvulabs.ai/pricing";
const _sfc_main$d = {
  __name: "CustomDownloadModal",
  props: {
    modelFolders: {
      type: Array,
      required: true
    },
    hasSubscription: {
      type: Boolean,
      default: false
    }
  },
  emits: ["submit", "cancel"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const downloadUrl = /* @__PURE__ */ ref("");
    const selectedFolder = /* @__PURE__ */ ref("");
    const customFolderInput = /* @__PURE__ */ ref("");
    const useCustomFolder = /* @__PURE__ */ ref(false);
    const customFilename = /* @__PURE__ */ ref("");
    const hfToken = /* @__PURE__ */ ref("");
    const civitaiToken = /* @__PURE__ */ ref("");
    const showHfToken = /* @__PURE__ */ ref(false);
    const showCivitaiToken = /* @__PURE__ */ ref(false);
    const isSubmitting = /* @__PURE__ */ ref(false);
    const error = /* @__PURE__ */ ref("");
    const downloadQueue = /* @__PURE__ */ ref([]);
    const urlType = computed(() => {
      const url = downloadUrl.value.toLowerCase().trim();
      if (!url) return "none";
      if (url.includes("huggingface.co") || url.includes("hf.co")) return "huggingface";
      if (url.includes("civitai.com")) return "civitai";
      return "direct";
    });
    const isHuggingFace = computed(() => urlType.value === "huggingface");
    const isCivitai = computed(() => urlType.value === "civitai");
    const queueNeedsHfToken = computed(() => {
      return downloadQueue.value.some((item) => item.type === "huggingface");
    });
    const queueNeedsCivitaiToken = computed(() => {
      return downloadQueue.value.some((item) => item.type === "civitai");
    });
    const isTokenMissingForAdd = computed(() => {
      if (isHuggingFace.value && !hfToken.value.trim()) return true;
      if (isCivitai.value && !civitaiToken.value.trim()) return true;
      return false;
    });
    const effectiveFolder = computed(() => {
      if (useCustomFolder.value) {
        return customFolderInput.value.trim();
      }
      return selectedFolder.value;
    });
    const canAddToQueue = computed(() => {
      if (!downloadUrl.value.trim()) return false;
      if (!effectiveFolder.value) return false;
      if (isTokenMissingForAdd.value) return false;
      return true;
    });
    const canStartDownload = computed(() => {
      if (downloadQueue.value.length === 0) return false;
      if (queueNeedsHfToken.value && !hfToken.value.trim()) return false;
      if (queueNeedsCivitaiToken.value && !civitaiToken.value.trim()) return false;
      return true;
    });
    function getFilenameFromUrl(url) {
      try {
        const urlPath = url.split("?")[0];
        const parts = urlPath.split("/");
        return decodeURIComponent(parts[parts.length - 1]) || "Unknown file";
      } catch {
        return "Unknown file";
      }
    }
    const isResolvingFilename = /* @__PURE__ */ ref(false);
    async function addToQueue() {
      if (!canAddToQueue.value) return;
      const url = downloadUrl.value.trim();
      const type = urlType.value;
      if (downloadQueue.value.some((item) => item.url === url)) {
        error.value = "This URL is already in the queue";
        return;
      }
      let filename = customFilename.value.trim();
      let fileSize = null;
      let resolvedFromServer = false;
      if (!filename && type === "civitai") {
        isResolvingFilename.value = true;
        try {
          let resolveUrl = url;
          if (civitaiToken.value.trim()) {
            const separator = url.includes("?") ? "&" : "?";
            resolveUrl = `${url}${separator}token=${civitaiToken.value.trim()}`;
          }
          const response = await fetch("/nuvu/resolve-filename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: resolveUrl })
          });
          if (response.ok) {
            const result = await response.json();
            if (result.success) {
              filename = result.filename;
              fileSize = result.file_size;
              resolvedFromServer = result.resolved;
            }
          }
        } catch (e) {
          console.warn("Failed to resolve filename:", e);
        } finally {
          isResolvingFilename.value = false;
        }
      }
      if (!filename) {
        filename = getFilenameFromUrl(url);
      }
      downloadQueue.value.push({
        id: Date.now(),
        url,
        folder: effectiveFolder.value,
        type,
        filename,
        fileSize,
        resolvedFromServer,
        customFilename: customFilename.value.trim() || null,
        isCustomFolder: useCustomFolder.value && !props.modelFolders.includes(effectiveFolder.value)
      });
      downloadUrl.value = "";
      customFilename.value = "";
      error.value = "";
    }
    function removeFromQueue(id) {
      downloadQueue.value = downloadQueue.value.filter((item) => item.id !== id);
    }
    function clearQueue() {
      downloadQueue.value = [];
    }
    async function loadSavedTokens() {
      try {
        const response = await fetch("/nuvu/user-config");
        if (response.ok) {
          const config = await response.json();
          hfToken.value = config.huggingface_token || localStorage.getItem("nuvu_hf_token") || "";
          civitaiToken.value = config.civitai_token || localStorage.getItem("nuvu_civitai_token") || "";
        } else {
          hfToken.value = localStorage.getItem("nuvu_hf_token") || "";
          civitaiToken.value = localStorage.getItem("nuvu_civitai_token") || "";
        }
      } catch (e) {
        hfToken.value = localStorage.getItem("nuvu_hf_token") || "";
        civitaiToken.value = localStorage.getItem("nuvu_civitai_token") || "";
      }
    }
    async function handleSubmit() {
      if (!canStartDownload.value) return;
      error.value = "";
      isSubmitting.value = true;
      try {
        for (const item of downloadQueue.value) {
          let finalUrl = item.url;
          if (item.type === "civitai") {
            const separator = finalUrl.includes("?") ? "&" : "?";
            finalUrl = `${finalUrl}${separator}token=${civitaiToken.value.trim()}`;
          }
          const payload = {
            url: finalUrl,
            install_folder: item.folder,
            user_id: currentUser?.userId || currentUser?.id || null,
            create_folder: item.isCustomFolder || false
          };
          if (item.customFilename) {
            payload.custom_filename = item.customFilename;
          } else if (item.resolvedFromServer && item.filename) {
            payload.custom_filename = item.filename;
          }
          if (item.type === "huggingface" && hfToken.value.trim()) {
            payload.hf_token = hfToken.value.trim();
          }
          const response = await fetch("/nuvu/install/custom-model", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${currentUser?.apiToken || ""}`
            },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Failed to queue: ${item.filename}`);
          }
        }
        emit2("submit", { count: downloadQueue.value.length });
      } catch (e) {
        error.value = e.message || "Failed to start download. Please try again.";
        console.error("[nuvu] Custom download failed:", e);
      } finally {
        isSubmitting.value = false;
      }
    }
    function handleCancel() {
      emit2("cancel");
    }
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        handleCancel();
      }
      mouseDownOnOverlay = false;
    }
    function openHFTokenPage() {
      window.open("https://huggingface.co/settings/tokens", "_blank");
    }
    function openCivitaiAccountPage() {
      window.open("https://civitai.com/user/account", "_blank");
    }
    function openSubscribePage() {
      window.open(SUBSCRIBE_URL, "_blank");
    }
    watch(() => props.modelFolders, (folders) => {
      if (folders.length > 0 && !selectedFolder.value) {
        selectedFolder.value = folders.includes("checkpoints") ? "checkpoints" : folders[0];
      }
    }, { immediate: true });
    onMounted(() => {
      loadSavedTokens();
    });
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$c, [
            !props.hasSubscription ? (openBlock(), createElementBlock("div", _hoisted_2$c, [
              createBaseVNode("div", { class: "premium-content" }, [
                _cache[9] || (_cache[9] = createBaseVNode("svg", {
                  class: "premium-icon",
                  width: "36",
                  height: "36",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  "stroke-width": "1.5"
                }, [
                  createBaseVNode("rect", {
                    x: "3",
                    y: "11",
                    width: "18",
                    height: "11",
                    rx: "2",
                    ry: "2"
                  }),
                  createBaseVNode("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
                ], -1)),
                _cache[10] || (_cache[10] = createBaseVNode("h3", { class: "premium-title" }, "Premium Feature", -1)),
                _cache[11] || (_cache[11] = createBaseVNode("p", { class: "premium-description" }, " Download any model from anywhere with Nuvu Premium. ", -1)),
                createBaseVNode("button", {
                  class: "premium-btn",
                  onClick: openSubscribePage
                }, " Subscribe "),
                createBaseVNode("button", {
                  class: "premium-close-btn",
                  onClick: handleCancel
                }, " Close ")
              ])
            ])) : createCommentVNode("", true),
            _cache[22] || (_cache[22] = createBaseVNode("h2", { class: "modal-title" }, "Custom Model Download", -1)),
            _cache[23] || (_cache[23] = createBaseVNode("p", { class: "modal-description" }, " Download models from HuggingFace, CivitAI or direct download URLs into ComfyUI. ", -1)),
            createBaseVNode("div", _hoisted_3$b, [
              _cache[12] || (_cache[12] = createBaseVNode("label", { for: "download-url" }, "Download URL", -1)),
              withDirectives(createBaseVNode("input", {
                id: "download-url",
                "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => downloadUrl.value = $event),
                type: "text",
                placeholder: "https://huggingface.co/... or https://civitai.com/...",
                class: "text-input",
                disabled: isSubmitting.value,
                onKeyup: withKeys(addToQueue, ["enter"])
              }, null, 40, _hoisted_4$b), [
                [vModelText, downloadUrl.value]
              ]),
              urlType.value !== "none" ? (openBlock(), createElementBlock("p", _hoisted_5$b, [
                isHuggingFace.value ? (openBlock(), createElementBlock("span", _hoisted_6$b, "HuggingFace URL detected")) : isCivitai.value ? (openBlock(), createElementBlock("span", _hoisted_7$b, "CivitAI URL detected")) : (openBlock(), createElementBlock("span", _hoisted_8$b, "Direct download URL"))
              ])) : createCommentVNode("", true)
            ]),
            createBaseVNode("div", _hoisted_9$a, [
              _cache[13] || (_cache[13] = createBaseVNode("label", { for: "custom-filename" }, [
                createTextVNode(" Custom Filename "),
                createBaseVNode("span", { class: "optional-badge" }, "Optional")
              ], -1)),
              withDirectives(createBaseVNode("input", {
                id: "custom-filename",
                "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => customFilename.value = $event),
                type: "text",
                placeholder: "Leave blank to use original filename",
                class: "text-input",
                disabled: isSubmitting.value
              }, null, 8, _hoisted_10$a), [
                [vModelText, customFilename.value]
              ])
            ]),
            createBaseVNode("div", _hoisted_11$a, [
              createBaseVNode("label", _hoisted_12$9, [
                _cache[14] || (_cache[14] = createTextVNode(" Model Type / Folder ", -1)),
                createBaseVNode("button", {
                  type: "button",
                  class: "folder-toggle-btn",
                  onClick: _cache[2] || (_cache[2] = ($event) => useCustomFolder.value = !useCustomFolder.value),
                  disabled: isSubmitting.value
                }, toDisplayString(useCustomFolder.value ? "Use existing" : "Custom folder"), 9, _hoisted_13$8)
              ]),
              createBaseVNode("div", _hoisted_14$8, [
                !useCustomFolder.value ? withDirectives((openBlock(), createElementBlock("select", {
                  key: 0,
                  id: "model-folder",
                  "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => selectedFolder.value = $event),
                  class: "select-input",
                  disabled: isSubmitting.value
                }, [
                  (openBlock(true), createElementBlock(Fragment, null, renderList(props.modelFolders, (folder) => {
                    return openBlock(), createElementBlock("option", {
                      key: folder,
                      value: folder
                    }, toDisplayString(folder), 9, _hoisted_16$7);
                  }), 128))
                ], 8, _hoisted_15$7)), [
                  [vModelSelect, selectedFolder.value]
                ]) : withDirectives((openBlock(), createElementBlock("input", {
                  key: 1,
                  id: "model-folder-custom",
                  "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => customFolderInput.value = $event),
                  type: "text",
                  placeholder: "e.g., custom_loras",
                  class: "text-input",
                  disabled: isSubmitting.value
                }, null, 8, _hoisted_17$7)), [
                  [vModelText, customFolderInput.value]
                ]),
                createBaseVNode("button", {
                  class: "add-btn",
                  disabled: !canAddToQueue.value || isSubmitting.value || isResolvingFilename.value,
                  onClick: addToQueue
                }, toDisplayString(isResolvingFilename.value ? "Resolving..." : "Add to Queue"), 9, _hoisted_18$7)
              ]),
              useCustomFolder.value ? (openBlock(), createElementBlock("p", _hoisted_19$7, " Custom folders will be created in your models directory. ")) : createCommentVNode("", true)
            ]),
            downloadQueue.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_20$7, [
              createBaseVNode("div", _hoisted_21$7, [
                createBaseVNode("span", _hoisted_22$7, "Download Queue (" + toDisplayString(downloadQueue.value.length) + ")", 1),
                createBaseVNode("button", {
                  class: "clear-btn",
                  onClick: clearQueue,
                  disabled: isSubmitting.value
                }, "Clear All", 8, _hoisted_23$7)
              ]),
              createBaseVNode("div", _hoisted_24$6, [
                (openBlock(true), createElementBlock(Fragment, null, renderList(downloadQueue.value, (item) => {
                  return openBlock(), createElementBlock("div", {
                    key: item.id,
                    class: "queue-item"
                  }, [
                    createBaseVNode("div", _hoisted_25$5, [
                      createBaseVNode("span", _hoisted_26$5, [
                        createTextVNode(toDisplayString(item.filename) + " ", 1),
                        item.fileSize ? (openBlock(), createElementBlock("span", _hoisted_27$5, "(" + toDisplayString(item.fileSize) + ")", 1)) : createCommentVNode("", true)
                      ]),
                      createBaseVNode("span", _hoisted_28$5, [
                        createBaseVNode("span", {
                          class: normalizeClass(["queue-item-type", `type-${item.type}`])
                        }, toDisplayString(item.type), 3),
                        createBaseVNode("span", _hoisted_29$5, toDisplayString(item.folder), 1)
                      ])
                    ]),
                    createBaseVNode("button", {
                      class: "queue-item-remove",
                      onClick: ($event) => removeFromQueue(item.id),
                      disabled: isSubmitting.value,
                      title: "Remove from queue"
                    }, [..._cache[15] || (_cache[15] = [
                      createBaseVNode("svg", {
                        width: "14",
                        height: "14",
                        viewBox: "0 0 24 24",
                        fill: "none",
                        stroke: "currentColor",
                        "stroke-width": "2"
                      }, [
                        createBaseVNode("line", {
                          x1: "18",
                          y1: "6",
                          x2: "6",
                          y2: "18"
                        }),
                        createBaseVNode("line", {
                          x1: "6",
                          y1: "6",
                          x2: "18",
                          y2: "18"
                        })
                      ], -1)
                    ])], 8, _hoisted_30$5)
                  ]);
                }), 128))
              ])
            ])) : createCommentVNode("", true),
            queueNeedsHfToken.value || isHuggingFace.value ? (openBlock(), createElementBlock("div", _hoisted_31$5, [
              _cache[18] || (_cache[18] = createBaseVNode("label", { for: "hf-token" }, [
                createTextVNode(" HuggingFace Token "),
                createBaseVNode("span", { class: "required-badge" }, "Required")
              ], -1)),
              createBaseVNode("div", _hoisted_32$5, [
                withDirectives(createBaseVNode("input", {
                  id: "hf-token",
                  "onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => hfToken.value = $event),
                  type: showHfToken.value ? "text" : "password",
                  placeholder: "hf_...",
                  class: "text-input token-input",
                  disabled: isSubmitting.value
                }, null, 8, _hoisted_33$5), [
                  [vModelDynamic, hfToken.value]
                ]),
                createBaseVNode("button", {
                  type: "button",
                  class: "token-toggle",
                  onClick: _cache[6] || (_cache[6] = ($event) => showHfToken.value = !showHfToken.value),
                  title: showHfToken.value ? "Hide token" : "Show token"
                }, [
                  showHfToken.value ? (openBlock(), createElementBlock("svg", _hoisted_35$4, [..._cache[16] || (_cache[16] = [
                    createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                    createBaseVNode("line", {
                      x1: "1",
                      y1: "1",
                      x2: "23",
                      y2: "23"
                    }, null, -1)
                  ])])) : (openBlock(), createElementBlock("svg", _hoisted_36$4, [..._cache[17] || (_cache[17] = [
                    createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                    createBaseVNode("circle", {
                      cx: "12",
                      cy: "12",
                      r: "3"
                    }, null, -1)
                  ])]))
                ], 8, _hoisted_34$5)
              ]),
              createBaseVNode("a", {
                href: "#",
                onClick: withModifiers(openHFTokenPage, ["prevent"]),
                class: "token-link"
              }, " Get a HuggingFace token ")
            ])) : createCommentVNode("", true),
            queueNeedsCivitaiToken.value || isCivitai.value ? (openBlock(), createElementBlock("div", _hoisted_37$4, [
              _cache[21] || (_cache[21] = createBaseVNode("label", { for: "civitai-token" }, [
                createTextVNode(" CivitAI API Key "),
                createBaseVNode("span", { class: "required-badge" }, "Required")
              ], -1)),
              createBaseVNode("div", _hoisted_38$4, [
                withDirectives(createBaseVNode("input", {
                  id: "civitai-token",
                  "onUpdate:modelValue": _cache[7] || (_cache[7] = ($event) => civitaiToken.value = $event),
                  type: showCivitaiToken.value ? "text" : "password",
                  placeholder: "Your CivitAI API key...",
                  class: "text-input token-input",
                  disabled: isSubmitting.value
                }, null, 8, _hoisted_39$4), [
                  [vModelDynamic, civitaiToken.value]
                ]),
                createBaseVNode("button", {
                  type: "button",
                  class: "token-toggle",
                  onClick: _cache[8] || (_cache[8] = ($event) => showCivitaiToken.value = !showCivitaiToken.value),
                  title: showCivitaiToken.value ? "Hide token" : "Show token"
                }, [
                  showCivitaiToken.value ? (openBlock(), createElementBlock("svg", _hoisted_41$2, [..._cache[19] || (_cache[19] = [
                    createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                    createBaseVNode("line", {
                      x1: "1",
                      y1: "1",
                      x2: "23",
                      y2: "23"
                    }, null, -1)
                  ])])) : (openBlock(), createElementBlock("svg", _hoisted_42$2, [..._cache[20] || (_cache[20] = [
                    createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                    createBaseVNode("circle", {
                      cx: "12",
                      cy: "12",
                      r: "3"
                    }, null, -1)
                  ])]))
                ], 8, _hoisted_40$3)
              ]),
              createBaseVNode("a", {
                href: "#",
                onClick: withModifiers(openCivitaiAccountPage, ["prevent"]),
                class: "token-link"
              }, " Get your CivitAI API key ")
            ])) : createCommentVNode("", true),
            error.value ? (openBlock(), createElementBlock("p", _hoisted_43$2, toDisplayString(error.value), 1)) : createCommentVNode("", true),
            isTokenMissingForAdd.value && urlType.value !== "none" && downloadUrl.value.trim() ? (openBlock(), createElementBlock("p", _hoisted_44$2, [
              isHuggingFace.value ? (openBlock(), createElementBlock("span", _hoisted_45$2, "A HuggingFace token is required to add this URL.")) : isCivitai.value ? (openBlock(), createElementBlock("span", _hoisted_46$2, "A CivitAI API key is required to add this URL.")) : createCommentVNode("", true)
            ])) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_47$2, [
              createBaseVNode("button", {
                class: "modal-btn cancel-btn",
                onClick: handleCancel,
                disabled: isSubmitting.value
              }, " Cancel ", 8, _hoisted_48$2),
              createBaseVNode("button", {
                class: "modal-btn submit-btn",
                onClick: handleSubmit,
                disabled: !canStartDownload.value || isSubmitting.value
              }, toDisplayString(isSubmitting.value ? "Starting..." : `Download ${downloadQueue.value.length} Model${downloadQueue.value.length !== 1 ? "s" : ""}`), 9, _hoisted_49$2)
            ])
          ])
        ], 32)
      ]);
    };
  }
};
const CustomDownloadModal = /* @__PURE__ */ _export_sfc(_sfc_main$d, [["__scopeId", "data-v-003b89b7"]]);
let modelButtonUpdateToken = 0;
function resetModelLoadingState(button2, container) {
  if (button2) {
    button2.classList.remove("nuvu-loading");
    button2.removeAttribute("aria-busy");
    button2.removeAttribute("data-loading-token");
  }
  if (container) {
    container.classList.remove("nuvu-loading");
    container.style.pointerEvents = "";
    container.style.opacity = "";
    container.removeAttribute("data-loading-token");
  }
}
function startModelLoadingState(button2, container, token) {
  if (button2) {
    button2.dataset.loadingToken = String(token);
    button2.classList.add("nuvu-loading");
    button2.setAttribute("aria-busy", "true");
    button2.disabled = true;
    button2.textContent = "Updating...";
  }
  if (container) {
    container.dataset.loadingToken = String(token);
    container.classList.add("nuvu-loading");
    if (container.style.display === "none") {
      container.style.display = "block";
    }
    container.style.pointerEvents = "none";
    container.style.opacity = "0.6";
  }
}
function finishModelLoadingState(button2, container, token) {
  if (button2 && button2.dataset.loadingToken === String(token)) {
    button2.classList.remove("nuvu-loading");
    button2.removeAttribute("aria-busy");
    button2.removeAttribute("data-loading-token");
  }
  if (container && container.dataset.loadingToken === String(token)) {
    container.classList.remove("nuvu-loading");
    container.style.pointerEvents = "";
    container.style.opacity = "";
    container.removeAttribute("data-loading-token");
  }
}
function waitForNextFrame() {
  return new Promise((resolve) => {
    const win = typeof window !== "undefined" ? window : null;
    if (win && typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(() => resolve());
      return;
    }
    if (win && typeof win.setTimeout === "function") {
      win.setTimeout(resolve, 16);
      return;
    }
    setTimeout(resolve, 16);
  });
}
async function updateModelDownloadButton() {
  const downloadBtn = document.getElementById("nuvu-download-models-btn");
  const hfTokenContainer = document.getElementById("nuvu-hf-token-container");
  if (!downloadBtn) {
    return;
  }
  resetModelLoadingState(downloadBtn, hfTokenContainer);
  downloadBtn.disabled = selectedModels.size === 0 && !ongoingModelDownload;
  if (ongoingModelDownload) {
    downloadBtn.textContent = "Cancel Download";
    downloadBtn.style.background = "#dc3545";
    if (hfTokenContainer) {
      hfTokenContainer.style.display = "none";
      const hfTokenInput = document.getElementById("nuvu-hf-token");
      if (hfTokenInput) hfTokenInput.value = "";
    }
    return;
  }
  if (selectedModels.size === 0) {
    downloadBtn.textContent = "Select Models to Download";
    downloadBtn.style.background = "#0b0b0b";
    if (hfTokenContainer) {
      hfTokenContainer.style.display = "none";
      const hfTokenInput = document.getElementById("nuvu-hf-token");
      if (hfTokenInput) hfTokenInput.value = "";
    }
    return;
  }
  const updateToken = ++modelButtonUpdateToken;
  startModelLoadingState(downloadBtn, hfTokenContainer, updateToken);
  await waitForNextFrame();
  let totalSize = 0;
  let requiresHFToken = false;
  selectedModels.forEach((modelId) => {
    const model = modelsData.find((m) => m.id === modelId);
    if (model) {
      if (model.size) {
        totalSize += model.size;
      }
      if (model.hfTokenRequired) {
        requiresHFToken = true;
      }
    }
  });
  finishModelLoadingState(downloadBtn, hfTokenContainer, updateToken);
  if (modelButtonUpdateToken !== updateToken) {
    return;
  }
  const totalSizeGB = totalSize > 0 ? totalSize.toFixed(1) : 0;
  downloadBtn.textContent = `Download ${selectedModels.size} Model${selectedModels.size === 1 ? "" : "s"} (${totalSizeGB} GB)`;
  downloadBtn.style.background = "#0b0b0b";
  downloadBtn.disabled = false;
  if (hfTokenContainer) {
    hfTokenContainer.style.display = "block";
    const prefixElement = document.getElementById("nuvu-hf-token-prefix");
    if (prefixElement) {
      if (requiresHFToken) {
        prefixElement.textContent = "Required:";
        prefixElement.style.color = "#ef4444";
      } else {
        prefixElement.textContent = "Optional:";
        prefixElement.style.color = "#4ade80";
      }
    }
    const helpElement = document.getElementById("nuvu-hf-token-help");
    if (helpElement) {
      if (requiresHFToken) {
        helpElement.innerHTML = 'A HuggingFace token is required for some selected models. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
      } else {
        helpElement.innerHTML = 'Enter your HuggingFace token for faster downloads and access to private models. <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#ffffff; text-decoration:underline;">Click here to create token</a>';
      }
    }
    const toggleBtn = document.getElementById("nuvu-hf-token-toggle");
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const tokenInput2 = document.getElementById("nuvu-hf-token");
        if (tokenInput2) {
          if (tokenInput2.type === "password") {
            tokenInput2.type = "text";
            toggleBtn.textContent = "Hide";
            toggleBtn.title = "Hide password";
          } else {
            tokenInput2.type = "password";
            toggleBtn.textContent = "Show";
            toggleBtn.title = "Show password";
          }
        }
      };
    }
    const tokenInput = document.getElementById("nuvu-hf-token");
    if (tokenInput && !tokenInput.value.trim()) {
      fetch("/nuvu/user-config").then((r) => r.ok ? r.json() : null).then((cfg) => {
        if (cfg && cfg.huggingface_token && typeof cfg.huggingface_token === "string" && cfg.huggingface_token.trim()) {
          tokenInput.value = cfg.huggingface_token;
        }
      }).catch(() => {
      });
    }
  }
}
async function startModelDownload(modelIds, options = {}) {
  if (!modelIds || modelIds.length === 0) {
    return false;
  }
  try {
    const sessionOk = await ensureValidSessionOrLogout();
    if (!sessionOk) {
      return false;
    }
    const accessToken = localStorage.getItem("api_token");
    if (!accessToken) {
      return false;
    }
    setOngoingModelDownload(true);
    const userId = currentUser?.id;
    const userEmail = currentUser?.email;
    if (!userId || !userEmail) {
      setOngoingModelDownload(false);
      return false;
    }
    const payload = {
      model_ids: modelIds,
      user_id: userId,
      user_email: userEmail
    };
    if (options.hfToken) {
      payload.hf_token = options.hfToken;
    }
    const response = await fetch("/nuvu/install/models", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      setOngoingModelDownload(false);
      if (response.status === 401 || response.status === 403) {
        invalidateLocalSession("model_download_unauthorized");
        return false;
      }
      if (response.status === 428) {
        return {
          success: false,
          deviceError: true,
          error: errorData.error || "Device not registered. Please register this device in User Configuration."
        };
      }
      return false;
    }
    const result = await response.json();
    pollForModelCompletionHeadless();
    return true;
  } catch (error) {
    setOngoingModelDownload(false);
    return false;
  }
}
function pollForModelCompletionHeadless() {
  if (modelPollInterval) {
    clearInterval(modelPollInterval);
  }
  setModelPollInterval(setInterval(async () => {
    try {
      const response = await fetch("/nuvu/queue/status");
      if (response.ok) {
        const status = await response.json();
        if (status.queue_size === 0 && !status.is_processing && status.in_progress_count === 0 && status.running_count === 0) {
          clearInterval(modelPollInterval);
          setModelPollInterval(null);
          setOngoingModelDownload(false);
          window.dispatchEvent(new CustomEvent("nuvu-model-download-complete"));
        }
      }
    } catch (error) {
      clearInterval(modelPollInterval);
      setModelPollInterval(null);
      setOngoingModelDownload(false);
      window.dispatchEvent(new CustomEvent("nuvu-model-download-error", { detail: error }));
    }
  }, 2e3));
}
async function cancelModelDownload() {
  const accessToken = window.localStorage.getItem("api_token");
  if (!accessToken) {
    console.error("[nuvu] api_token is required to cancel");
    return;
  }
  const email = currentUser?.email;
  if (!email) {
    console.error("[nuvu] user email is required to cancel");
    return;
  }
  try {
    const resp = await fetch("/nuvu/execute/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({ user_email: email })
    });
    if (!resp.ok) {
      console.error(`[nuvu] Cancel failed: ${resp.status}`);
    }
  } catch (error) {
    console.error("[nuvu] Cancel model download error:", error);
  } finally {
    if (modelPollInterval) {
      clearInterval(modelPollInterval);
      setModelPollInterval(null);
    }
    setOngoingModelDownload(false);
    updateModelDownloadButton();
  }
}
const _hoisted_1$b = { class: "models-panel" };
const _hoisted_2$b = { class: "filters-row" };
const _hoisted_3$a = ["value"];
const _hoisted_4$a = { class: "actions-row" };
const _hoisted_5$a = { class: "selection-btns" };
const _hoisted_6$a = {
  key: 0,
  class: "selection-count"
};
const _hoisted_7$a = { class: "table-container" };
const _hoisted_8$a = {
  key: 0,
  class: "loading-placeholder"
};
const _hoisted_9$9 = {
  key: 1,
  class: "empty-placeholder"
};
const _hoisted_10$9 = { class: "empty-message-container" };
const _hoisted_11$9 = {
  key: 0,
  class: "empty-help"
};
const _hoisted_12$8 = {
  key: 2,
  class: "models-table"
};
const _hoisted_13$7 = ["onClick"];
const _hoisted_14$7 = ["checked", "disabled", "onChange"];
const _hoisted_15$6 = { class: "col-name" };
const _hoisted_16$6 = { class: "model-name" };
const _hoisted_17$6 = ["href"];
const _hoisted_18$6 = {
  key: 1,
  class: "model-name-link model-name-link--disabled"
};
const _hoisted_19$6 = { key: 2 };
const _hoisted_20$6 = {
  key: 3,
  class: "lock-icon"
};
const _hoisted_21$6 = { class: "model-description" };
const _hoisted_22$6 = {
  key: 0,
  class: "preview-note"
};
const _hoisted_23$6 = { class: "col-size" };
const _hoisted_24$5 = { class: "col-folder" };
const _hoisted_25$4 = { class: "bottom-section" };
const _hoisted_26$4 = {
  key: 0,
  class: "hf-token-row"
};
const _hoisted_27$4 = { class: "hf-token-input-wrapper" };
const _hoisted_28$4 = { class: "hf-token-label" };
const _hoisted_29$4 = { class: "hf-token-input-group" };
const _hoisted_30$4 = ["type", "placeholder"];
const _hoisted_31$4 = ["title"];
const _hoisted_32$4 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_33$4 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_34$4 = ["disabled"];
const _sfc_main$c = {
  __name: "ModelsPanel",
  setup(__props) {
    const licenseStatus = inject("licenseStatus", null);
    const activeTab = inject("activeTab", null);
    const hasSubscription = computed(() => licenseStatus?.isActive === true);
    const showDeviceError = /* @__PURE__ */ ref(false);
    const deviceErrorMessage = /* @__PURE__ */ ref("");
    const searchTerm = /* @__PURE__ */ ref("");
    const folderFilter = /* @__PURE__ */ ref("");
    const sortKey = /* @__PURE__ */ ref("name");
    const sortDirection = /* @__PURE__ */ ref("asc");
    const models = /* @__PURE__ */ ref([]);
    const selectedModels$1 = /* @__PURE__ */ ref(/* @__PURE__ */ new Set());
    const isLoading = /* @__PURE__ */ ref(true);
    const isDownloadingLocal = /* @__PURE__ */ ref(false);
    const hfToken = /* @__PURE__ */ ref("");
    const showHfToken = /* @__PURE__ */ ref(false);
    const showCustomDownloadModal = /* @__PURE__ */ ref(false);
    const { isActive, startPolling } = useQueueProgress();
    const isDownloading = computed(() => isDownloadingLocal.value || isActive.value);
    watch(isActive, (next) => {
      if (!next) {
        isDownloadingLocal.value = false;
      }
    });
    const requiresHFToken = computed(() => {
      return models.value.some(
        (m) => selectedModels$1.value.has(m.id) && m.hfTokenRequired && !m.isInstalled
      );
    });
    const uniqueFolders = computed(() => {
      const folders = /* @__PURE__ */ new Set();
      models.value.forEach((model) => {
        const folder = (model.installFolder || "").trim();
        if (folder) folders.add(folder);
      });
      return [...folders].sort();
    });
    const filteredModels = computed(() => {
      let result = models.value;
      if (folderFilter.value) {
        result = result.filter((m) => (m.installFolder || "").trim() === folderFilter.value);
      }
      if (searchTerm.value) {
        const term = searchTerm.value.toLowerCase();
        result = result.filter((m) => {
          const nameMatch = (m.modelName || m.name || "").toLowerCase().includes(term);
          const descMatch = (m.notes || m.description || "").toLowerCase().includes(term);
          const tagMatch = Array.isArray(m.tags) && m.tags.some((t) => (t || "").toLowerCase().includes(term));
          return nameMatch || descMatch || tagMatch;
        });
      }
      return [...result].sort((a, b) => {
        let aVal, bVal;
        if (sortKey.value === "name") {
          aVal = (a.modelName || a.name || "").toLowerCase();
          bVal = (b.modelName || b.name || "").toLowerCase();
        } else if (sortKey.value === "size") {
          aVal = typeof a.size === "number" ? a.size : 0;
          bVal = typeof b.size === "number" ? b.size : 0;
        } else if (sortKey.value === "folder") {
          aVal = (a.installFolder || "").toLowerCase();
          bVal = (b.installFolder || "").toLowerCase();
        }
        if (sortDirection.value === "asc") {
          return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
        } else {
          return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
        }
      });
    });
    const selectedCount = computed(() => selectedModels$1.value.size);
    const totalSelectedSize = computed(() => {
      let total = 0;
      selectedModels$1.value.forEach((id) => {
        const model = models.value.find((m) => m.id === id);
        if (model && typeof model.size === "number") {
          total += model.size;
        }
      });
      return total;
    });
    const downloadButtonText = computed(() => {
      if (isDownloading.value) return "Cancel Download";
      if (selectedCount.value === 0) return "Select Models to Download";
      let text = `Download ${selectedCount.value} Model${selectedCount.value > 1 ? "s" : ""}`;
      if (totalSelectedSize.value > 0) {
        text += ` (${formatSize(totalSelectedSize.value)})`;
      }
      return text;
    });
    function formatSize(size) {
      if (typeof size !== "number") return "—";
      return `${size.toFixed(1)} GB`;
    }
    function getRepoUrl(model) {
      const url = model?.modelUrl;
      if (!url) return null;
      const resolveIndex = url.indexOf("/resolve/");
      if (resolveIndex !== -1) {
        return url.substring(0, resolveIndex) + "/";
      }
      if (url.includes("huggingface.co")) {
        const match = url.match(/huggingface\.co\/([^\/]+\/[^\/]+)/);
        if (match) {
          return `https://huggingface.co/${match[1]}/`;
        }
      }
      return null;
    }
    function syncSelectionToState(selection) {
      if (updateSelectedModels) {
        updateSelectedModels(selection);
      }
    }
    function toggleModel(modelId) {
      const newSet = new Set(selectedModels$1.value);
      if (newSet.has(modelId)) {
        newSet.delete(modelId);
      } else {
        newSet.add(modelId);
      }
      selectedModels$1.value = newSet;
      syncSelectionToState(newSet);
    }
    function selectAll() {
      const newSet = new Set(selectedModels$1.value);
      filteredModels.value.forEach((m) => {
        if (!m._previewMode && m.id) {
          newSet.add(m.id);
        }
      });
      selectedModels$1.value = newSet;
      syncSelectionToState(newSet);
    }
    function deselectAll() {
      selectedModels$1.value = /* @__PURE__ */ new Set();
      syncSelectionToState(/* @__PURE__ */ new Set());
    }
    function handleSort(key) {
      if (sortKey.value === key) {
        sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
      } else {
        sortKey.value = key;
        sortDirection.value = "asc";
      }
    }
    function getSortIndicator(key) {
      if (sortKey.value !== key) return "";
      return sortDirection.value === "asc" ? " ▲" : " ▼";
    }
    async function loadModelsData() {
      try {
        if (typeof hydrateModelsFromCache === "function") {
          hydrateModelsFromCache();
        }
        if (Array.isArray(modelsData) && modelsData.length > 0) {
          models.value = modelsData;
          isLoading.value = false;
        }
        if (selectedModels instanceof Set) {
          selectedModels$1.value = new Set(selectedModels);
        }
        loadModels({ backgroundRefresh: true, force: false }).then(() => {
          models.value = modelsData || [];
          isLoading.value = false;
        }).catch((error) => {
          console.warn("[nuvu] Background model refresh failed:", error);
          isLoading.value = false;
        });
      } catch (error) {
        console.error("[nuvu] Failed to load models:", error);
        isLoading.value = false;
      }
    }
    async function downloadModels() {
      if (selectedCount.value === 0 && !isDownloading.value) return;
      if (isDownloading.value) {
        if (cancelModelDownload) {
          cancelModelDownload();
        }
        isDownloadingLocal.value = false;
        return;
      }
      isDownloadingLocal.value = true;
      startPolling();
      try {
        if (startModelDownload) {
          const token = hfToken.value.trim() || void 0;
          const result = await startModelDownload([...selectedModels$1.value], { hfToken: token });
          if (result && typeof result === "object" && result.deviceError) {
            isDownloadingLocal.value = false;
            deviceErrorMessage.value = result.error;
            showDeviceError.value = true;
            return;
          }
          if (!result) {
            isDownloadingLocal.value = false;
          }
        } else {
          console.warn("[nuvu] Download function not found");
          isDownloadingLocal.value = false;
        }
      } catch (error) {
        console.error("[nuvu] Failed to download models:", error);
        isDownloadingLocal.value = false;
      }
    }
    function closeDeviceError() {
      showDeviceError.value = false;
      deviceErrorMessage.value = "";
    }
    function goToUserConfig() {
      closeDeviceError();
      if (activeTab) {
        activeTab.value = "user-config";
      }
    }
    async function loadHFToken() {
      try {
        const response = await fetch("/nuvu/user-config");
        if (response.ok) {
          const config = await response.json();
          if (config.huggingface_token) {
            hfToken.value = config.huggingface_token;
          }
        }
      } catch (e) {
      }
    }
    function openCustomDownloadModal() {
      showCustomDownloadModal.value = true;
    }
    function closeCustomDownloadModal() {
      showCustomDownloadModal.value = false;
    }
    function handleCustomDownloadSubmit(data) {
      showCustomDownloadModal.value = false;
      isDownloadingLocal.value = true;
      startPolling();
    }
    let stateWatcher = null;
    let hfTokenUpdatedHandler = null;
    onMounted(() => {
      loadModelsData();
      loadHFToken();
      hfTokenUpdatedHandler = (event) => {
        try {
          const nextToken = event?.detail || "";
          hfToken.value = typeof nextToken === "string" ? nextToken : "";
        } catch {
        }
      };
      window.addEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
      stateWatcher = setInterval(() => {
        if (modelsData !== models.value) {
          models.value = modelsData || [];
        }
      }, 2e3);
    });
    onUnmounted(() => {
      if (stateWatcher) {
        clearInterval(stateWatcher);
      }
      if (hfTokenUpdatedHandler) {
        window.removeEventListener("nuvu:hf-token-updated", hfTokenUpdatedHandler);
        hfTokenUpdatedHandler = null;
      }
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$b, [
        createBaseVNode("div", _hoisted_2$b, [
          withDirectives(createBaseVNode("input", {
            "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => searchTerm.value = $event),
            type: "text",
            class: "search-input",
            placeholder: "Search models by name, description, or tag..."
          }, null, 512), [
            [vModelText, searchTerm.value]
          ]),
          withDirectives(createBaseVNode("select", {
            "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => folderFilter.value = $event),
            class: "filter-select"
          }, [
            _cache[9] || (_cache[9] = createBaseVNode("option", { value: "" }, "All Model Types", -1)),
            (openBlock(true), createElementBlock(Fragment, null, renderList(uniqueFolders.value, (folder) => {
              return openBlock(), createElementBlock("option", {
                key: folder,
                value: folder
              }, toDisplayString(folder), 9, _hoisted_3$a);
            }), 128))
          ], 512), [
            [vModelSelect, folderFilter.value]
          ])
        ]),
        createBaseVNode("div", _hoisted_4$a, [
          createBaseVNode("button", {
            class: "action-btn custom-download-btn",
            onClick: openCustomDownloadModal
          }, [..._cache[10] || (_cache[10] = [
            createBaseVNode("svg", {
              width: "16",
              height: "16",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              "stroke-width": "2"
            }, [
              createBaseVNode("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
              createBaseVNode("polyline", { points: "7 10 12 15 17 10" }),
              createBaseVNode("line", {
                x1: "12",
                y1: "15",
                x2: "12",
                y2: "3"
              })
            ], -1),
            createTextVNode(" Custom Download ", -1)
          ])]),
          createBaseVNode("div", _hoisted_5$a, [
            selectedCount.value > 0 ? (openBlock(), createElementBlock("span", _hoisted_6$a, toDisplayString(selectedCount.value) + " model" + toDisplayString(selectedCount.value > 1 ? "s" : "") + " selected ", 1)) : createCommentVNode("", true),
            createBaseVNode("button", {
              class: "action-btn",
              onClick: selectAll
            }, "Select All"),
            createBaseVNode("button", {
              class: "action-btn",
              onClick: deselectAll
            }, "Deselect All")
          ])
        ]),
        createBaseVNode("div", _hoisted_7$a, [
          isLoading.value ? (openBlock(), createElementBlock("div", _hoisted_8$a, " Loading models... ")) : filteredModels.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_9$9, [
            createBaseVNode("div", _hoisted_10$9, [
              _cache[11] || (_cache[11] = createBaseVNode("p", null, "No models match your filters.", -1)),
              !searchTerm.value && !folderFilter.value ? (openBlock(), createElementBlock("p", _hoisted_11$9, " Check that your device is registered in User Configuration ")) : createCommentVNode("", true)
            ])
          ])) : (openBlock(), createElementBlock("table", _hoisted_12$8, [
            createBaseVNode("thead", null, [
              createBaseVNode("tr", null, [
                _cache[12] || (_cache[12] = createBaseVNode("th", { class: "col-checkbox" }, null, -1)),
                createBaseVNode("th", {
                  class: "col-name sortable",
                  onClick: _cache[2] || (_cache[2] = ($event) => handleSort("name"))
                }, " Name" + toDisplayString(getSortIndicator("name")), 1),
                createBaseVNode("th", {
                  class: "col-size sortable",
                  onClick: _cache[3] || (_cache[3] = ($event) => handleSort("size"))
                }, " Size" + toDisplayString(getSortIndicator("size")), 1),
                createBaseVNode("th", {
                  class: "col-folder sortable",
                  onClick: _cache[4] || (_cache[4] = ($event) => handleSort("folder"))
                }, " Type" + toDisplayString(getSortIndicator("folder")), 1)
              ])
            ]),
            createBaseVNode("tbody", null, [
              (openBlock(true), createElementBlock(Fragment, null, renderList(filteredModels.value, (model) => {
                return openBlock(), createElementBlock("tr", {
                  key: model.id,
                  class: normalizeClass(["model-row", {
                    selected: selectedModels$1.value.has(model.id),
                    disabled: model._previewMode
                  }]),
                  onClick: ($event) => !model._previewMode && toggleModel(model.id)
                }, [
                  createBaseVNode("td", {
                    class: "col-checkbox",
                    onClick: _cache[5] || (_cache[5] = withModifiers(() => {
                    }, ["stop"]))
                  }, [
                    createBaseVNode("input", {
                      type: "checkbox",
                      checked: selectedModels$1.value.has(model.id),
                      disabled: model._previewMode,
                      onChange: ($event) => toggleModel(model.id)
                    }, null, 40, _hoisted_14$7)
                  ]),
                  createBaseVNode("td", _hoisted_15$6, [
                    createBaseVNode("div", _hoisted_16$6, [
                      getRepoUrl(model) && !model._previewMode ? (openBlock(), createElementBlock("a", {
                        key: 0,
                        href: getRepoUrl(model),
                        target: "_blank",
                        rel: "noopener noreferrer",
                        class: "model-name-link",
                        onClick: _cache[6] || (_cache[6] = withModifiers(() => {
                        }, ["stop"]))
                      }, toDisplayString(model.modelName || model.name || "Unnamed Model"), 9, _hoisted_17$6)) : model._previewMode ? (openBlock(), createElementBlock("span", _hoisted_18$6, toDisplayString(model.modelName || model.name || "Unnamed Model"), 1)) : (openBlock(), createElementBlock("span", _hoisted_19$6, toDisplayString(model.modelName || model.name || "Unnamed Model"), 1)),
                      model._previewMode ? (openBlock(), createElementBlock("span", _hoisted_20$6, "🔒")) : createCommentVNode("", true)
                    ]),
                    createBaseVNode("div", _hoisted_21$6, toDisplayString(model.notes || model.description || "No description"), 1),
                    model._previewMode ? (openBlock(), createElementBlock("div", _hoisted_22$6, " Subscribe to download and view repository link ")) : createCommentVNode("", true)
                  ]),
                  createBaseVNode("td", _hoisted_23$6, toDisplayString(formatSize(model.size)), 1),
                  createBaseVNode("td", _hoisted_24$5, toDisplayString(model.installFolder || "—"), 1)
                ], 10, _hoisted_13$7);
              }), 128))
            ])
          ]))
        ]),
        createVNode(QueueProgress, {
          phases: ["models"],
          title: "Downloading..."
        }),
        createBaseVNode("div", _hoisted_25$4, [
          selectedCount.value > 0 && !isDownloading.value ? (openBlock(), createElementBlock("div", _hoisted_26$4, [
            createBaseVNode("div", _hoisted_27$4, [
              createBaseVNode("label", _hoisted_28$4, [
                _cache[13] || (_cache[13] = createTextVNode(" HuggingFace Token ", -1)),
                createBaseVNode("span", {
                  class: normalizeClass({ "required": requiresHFToken.value, "optional": !requiresHFToken.value })
                }, " (" + toDisplayString(requiresHFToken.value ? "Required" : "Optional") + ") ", 3)
              ]),
              createBaseVNode("div", _hoisted_29$4, [
                withDirectives(createBaseVNode("input", {
                  "onUpdate:modelValue": _cache[7] || (_cache[7] = ($event) => hfToken.value = $event),
                  type: showHfToken.value ? "text" : "password",
                  class: "hf-token-input",
                  placeholder: requiresHFToken.value ? "Enter your HuggingFace token (required)" : "Optional - for faster downloads"
                }, null, 8, _hoisted_30$4), [
                  [vModelDynamic, hfToken.value]
                ]),
                createBaseVNode("button", {
                  type: "button",
                  class: "hf-token-toggle",
                  onClick: _cache[8] || (_cache[8] = ($event) => showHfToken.value = !showHfToken.value),
                  title: showHfToken.value ? "Hide token" : "Show token"
                }, [
                  showHfToken.value ? (openBlock(), createElementBlock("svg", _hoisted_32$4, [..._cache[14] || (_cache[14] = [
                    createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                    createBaseVNode("line", {
                      x1: "1",
                      y1: "1",
                      x2: "23",
                      y2: "23"
                    }, null, -1)
                  ])])) : (openBlock(), createElementBlock("svg", _hoisted_33$4, [..._cache[15] || (_cache[15] = [
                    createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                    createBaseVNode("circle", {
                      cx: "12",
                      cy: "12",
                      r: "3"
                    }, null, -1)
                  ])]))
                ], 8, _hoisted_31$4)
              ])
            ]),
            _cache[16] || (_cache[16] = createBaseVNode("a", {
              href: "https://huggingface.co/settings/tokens",
              target: "_blank",
              class: "hf-token-link"
            }, " Get token ", -1))
          ])) : createCommentVNode("", true),
          createBaseVNode("button", {
            class: normalizeClass(["download-btn", { "cancel-btn": isDownloading.value }]),
            disabled: selectedCount.value === 0 && !isDownloading.value,
            onClick: downloadModels
          }, toDisplayString(downloadButtonText.value), 11, _hoisted_34$4)
        ]),
        showCustomDownloadModal.value ? (openBlock(), createBlock(CustomDownloadModal, {
          key: 0,
          "model-folders": uniqueFolders.value,
          "has-subscription": hasSubscription.value,
          onSubmit: handleCustomDownloadSubmit,
          onCancel: closeCustomDownloadModal
        }, null, 8, ["model-folders", "has-subscription"])) : createCommentVNode("", true),
        showDeviceError.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 1,
          title: "Device Not Registered",
          message: deviceErrorMessage.value,
          "confirm-text": "Go to User Configuration",
          "cancel-text": "Close",
          onConfirm: goToUserConfig,
          onCancel: closeDeviceError
        }, null, 8, ["message"])) : createCommentVNode("", true)
      ]);
    };
  }
};
const ModelsPanel = /* @__PURE__ */ _export_sfc(_sfc_main$c, [["__scopeId", "data-v-3f9f1c86"]]);
const _hoisted_1$a = { class: "modal-overlay" };
const _hoisted_2$a = { class: "modal-content" };
const _hoisted_3$9 = { class: "steps" };
const _hoisted_4$9 = { class: "step-badge" };
const _hoisted_5$9 = { key: 0 };
const _hoisted_6$9 = { key: 1 };
const _hoisted_7$9 = { class: "step-content" };
const _hoisted_8$9 = { class: "step-title" };
const _hoisted_9$8 = { class: "step-description" };
const _hoisted_10$8 = {
  key: 0,
  class: "status-spinner"
};
const _hoisted_11$8 = { class: "modal-actions" };
const _sfc_main$b = {
  __name: "RestartPromptModal",
  props: {
    notice: {
      type: String,
      default: ""
    },
    noticeType: {
      type: String,
      default: ""
      // 'success' | 'warning' | 'error'
    }
  },
  emits: ["close"],
  setup(__props, { emit: __emit }) {
    const emit2 = __emit;
    const props = __props;
    const status = /* @__PURE__ */ ref("ready");
    const statusMessage = /* @__PURE__ */ ref("ComfyUI needs to restart to apply the changes.");
    let reconnectInterval = null;
    const steps = [
      { title: "Restart Server", description: "ComfyUI will shut down and restart." },
      { title: "Reconnect", description: "We will monitor the connection and let you know when it is back online." },
      { title: "Refresh", description: "Once ComfyUI reconnects, refresh to finish applying the changes." }
    ];
    async function checkConnection() {
      try {
        const response = await fetch("/system_stats", {
          method: "GET",
          cache: "no-store"
        });
        return response.ok;
      } catch {
        return false;
      }
    }
    function startReconnectPolling() {
      status.value = "reconnecting";
      statusMessage.value = "Waiting for ComfyUI to come back online...";
      reconnectInterval = setInterval(async () => {
        const isOnline = await checkConnection();
        if (isOnline) {
          clearInterval(reconnectInterval);
          reconnectInterval = null;
          status.value = "complete";
          statusMessage.value = 'ComfyUI is back online! Click "Refresh Now" to continue.';
        }
      }, 2e3);
    }
    async function handleRestart() {
      status.value = "restarting";
      statusMessage.value = "Restarting ComfyUI. Keep this tab open...";
      try {
        await fetch("/nuvu/restart", { method: "GET" });
      } catch (error) {
        console.log("[nuvu] Restart request sent");
      }
      setTimeout(() => {
        startReconnectPolling();
      }, 3e3);
    }
    function handleRefresh() {
      try {
        window.localStorage.setItem("nuvu_show_splash_after_refresh", "true");
      } catch {
      }
      window.location.reload();
    }
    function handleClose() {
      if (status.value === "restarting" || status.value === "reconnecting") {
        return;
      }
      emit2("close");
    }
    onUnmounted(() => {
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
      }
    });
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", _hoisted_1$a, [
          createBaseVNode("div", _hoisted_2$a, [
            _cache[0] || (_cache[0] = createBaseVNode("h2", { class: "modal-title" }, "Restart Required", -1)),
            _cache[1] || (_cache[1] = createBaseVNode("p", { class: "modal-subtitle" }, "Apply changes and restart the server", -1)),
            props.notice ? (openBlock(), createElementBlock("div", {
              key: 0,
              class: normalizeClass(["notice", props.noticeType])
            }, toDisplayString(props.notice), 3)) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_3$9, [
              (openBlock(), createElementBlock(Fragment, null, renderList(steps, (step, index) => {
                return createBaseVNode("div", {
                  key: index,
                  class: normalizeClass(["step", {
                    active: index === 0 && (status.value === "ready" || status.value === "restarting") || index === 1 && status.value === "reconnecting" || index === 2 && status.value === "complete",
                    completed: index === 0 && (status.value === "reconnecting" || status.value === "complete") || index === 1 && status.value === "complete"
                  }])
                }, [
                  createBaseVNode("div", _hoisted_4$9, [
                    index === 0 && (status.value === "reconnecting" || status.value === "complete") || index === 1 && status.value === "complete" ? (openBlock(), createElementBlock("span", _hoisted_5$9, "✓")) : (openBlock(), createElementBlock("span", _hoisted_6$9, toDisplayString(index + 1), 1))
                  ]),
                  createBaseVNode("div", _hoisted_7$9, [
                    createBaseVNode("div", _hoisted_8$9, toDisplayString(step.title), 1),
                    createBaseVNode("div", _hoisted_9$8, toDisplayString(step.description), 1)
                  ])
                ], 2);
              }), 64))
            ]),
            createBaseVNode("div", {
              class: normalizeClass(["status-message", status.value])
            }, [
              status.value === "restarting" || status.value === "reconnecting" ? (openBlock(), createElementBlock("div", _hoisted_10$8)) : createCommentVNode("", true),
              createTextVNode(" " + toDisplayString(statusMessage.value), 1)
            ], 2),
            createBaseVNode("div", _hoisted_11$8, [
              status.value === "ready" ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "modal-btn later-btn",
                onClick: handleClose
              }, " Later ")) : createCommentVNode("", true),
              status.value === "ready" ? (openBlock(), createElementBlock("button", {
                key: 1,
                class: "modal-btn restart-btn",
                onClick: handleRestart
              }, " Restart Now ")) : createCommentVNode("", true),
              status.value === "complete" ? (openBlock(), createElementBlock("button", {
                key: 2,
                class: "modal-btn refresh-btn",
                onClick: handleRefresh
              }, " Refresh Now ")) : createCommentVNode("", true)
            ])
          ])
        ])
      ]);
    };
  }
};
const RestartPromptModal = /* @__PURE__ */ _export_sfc(_sfc_main$b, [["__scopeId", "data-v-46475f3b"]]);
const _hoisted_1$9 = { class: "modal-content" };
const _hoisted_2$9 = { class: "modal-header" };
const _hoisted_3$8 = { class: "commit-list" };
const _hoisted_4$8 = {
  key: 0,
  class: "loading"
};
const _hoisted_5$8 = {
  key: 1,
  class: "error"
};
const _hoisted_6$8 = { class: "commit-row" };
const _hoisted_7$8 = { class: "commit-info" };
const _hoisted_8$8 = { class: "commit-meta" };
const _hoisted_9$7 = { class: "commit-hash" };
const _hoisted_10$7 = {
  key: 0,
  class: "commit-tag"
};
const _hoisted_11$7 = { class: "commit-date" };
const _hoisted_12$7 = {
  key: 1,
  class: "current-indicator"
};
const _hoisted_13$6 = { class: "commit-msg" };
const _hoisted_14$6 = ["disabled", "onClick", "title"];
const _sfc_main$a = {
  __name: "ChangelogModal",
  props: ["repoType", "title", "current"],
  emits: ["close", "switched"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        emit2("close");
      }
      mouseDownOnOverlay = false;
    }
    const commits = /* @__PURE__ */ ref([]);
    const loading = /* @__PURE__ */ ref(true);
    const error = /* @__PURE__ */ ref(null);
    const switching = /* @__PURE__ */ ref(false);
    const switchingHash = /* @__PURE__ */ ref(null);
    const statusMessage = /* @__PURE__ */ ref("");
    const statusError = /* @__PURE__ */ ref(false);
    const statusSuccess = /* @__PURE__ */ ref(false);
    function isCurrent(commit) {
      if (!props.current) return false;
      const currentVer = String(props.current).trim().toLowerCase();
      const commitHash = commit.hash.toLowerCase();
      if (commitHash.startsWith(currentVer.substring(0, 7)) || currentVer.startsWith(commitHash.substring(0, 7))) {
        return true;
      }
      if (commit.tag) {
        const cleanCurrent = currentVer.replace(/^v/, "");
        const cleanTag = commit.tag.toLowerCase().replace(/^v/, "");
        if (cleanTag === cleanCurrent) {
          return true;
        }
      }
      const describeMatch = currentVer.match(/-g([0-9a-f]{7,})$/);
      if (describeMatch) {
        const extractedHash = describeMatch[1];
        if (commitHash.startsWith(extractedHash.substring(0, 7))) {
          return true;
        }
      }
      return false;
    }
    function canSwitch(commit) {
      if (isCurrent(commit)) return false;
      if (props.repoType === "nuvu") {
        return !!commit.tag;
      }
      return true;
    }
    async function switchToVersion(commit) {
      const targetRef = commit.tag || commit.hash;
      switching.value = true;
      switchingHash.value = commit.hash;
      statusMessage.value = "";
      statusError.value = false;
      statusSuccess.value = false;
      try {
        const headers = await getAuthHeaders();
        headers["Content-Type"] = "application/json";
        const response = await fetch(`/nuvu/checkout/${props.repoType}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            tag: commit.tag,
            hash: commit.hash
          })
        });
        const result = await response.json();
        if (response.ok && result.success) {
          statusMessage.value = `Switched to ${targetRef}. Please restart ComfyUI to apply changes.`;
          statusSuccess.value = true;
          emit2("switched", { commit, result });
        } else {
          statusMessage.value = result.error || result.message || "Failed to switch version";
          statusError.value = true;
        }
      } catch (e) {
        statusMessage.value = `Error: ${e.message}`;
        statusError.value = true;
      } finally {
        switching.value = false;
        switchingHash.value = null;
      }
    }
    onMounted(async () => {
      try {
        const resp = await fetch(`/nuvu/changelog/${props.repoType}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        commits.value = data.commits;
      } catch (e) {
        error.value = "Failed to load changelog";
      } finally {
        loading.value = false;
      }
    });
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$9, [
            createBaseVNode("div", _hoisted_2$9, [
              createBaseVNode("h3", null, toDisplayString(__props.title) + " Changelog", 1),
              createBaseVNode("button", {
                class: "close-icon",
                onClick: _cache[0] || (_cache[0] = ($event) => _ctx.$emit("close"))
              }, "×")
            ]),
            statusMessage.value ? (openBlock(), createElementBlock("div", {
              key: 0,
              class: normalizeClass(["status-message", { "status-error": statusError.value, "status-success": statusSuccess.value }])
            }, toDisplayString(statusMessage.value), 3)) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_3$8, [
              loading.value ? (openBlock(), createElementBlock("div", _hoisted_4$8, "Loading commits...")) : error.value ? (openBlock(), createElementBlock("div", _hoisted_5$8, toDisplayString(error.value), 1)) : (openBlock(true), createElementBlock(Fragment, { key: 2 }, renderList(commits.value, (commit) => {
                return openBlock(), createElementBlock("div", {
                  key: commit.hash,
                  class: normalizeClass(["commit-item", { "current-commit": isCurrent(commit) }])
                }, [
                  createBaseVNode("div", _hoisted_6$8, [
                    createBaseVNode("div", _hoisted_7$8, [
                      createBaseVNode("div", _hoisted_8$8, [
                        createBaseVNode("span", _hoisted_9$7, "#" + toDisplayString(commit.hash), 1),
                        commit.tag ? (openBlock(), createElementBlock("span", _hoisted_10$7, toDisplayString(commit.tag), 1)) : createCommentVNode("", true),
                        createBaseVNode("span", _hoisted_11$7, toDisplayString(commit.date), 1),
                        isCurrent(commit) ? (openBlock(), createElementBlock("span", _hoisted_12$7, "Current")) : createCommentVNode("", true)
                      ]),
                      createBaseVNode("div", _hoisted_13$6, toDisplayString(commit.message), 1)
                    ]),
                    canSwitch(commit) ? (openBlock(), createElementBlock("button", {
                      key: 0,
                      class: "switch-btn",
                      disabled: switching.value,
                      onClick: ($event) => switchToVersion(commit),
                      title: "Switch to " + (commit.tag || commit.hash)
                    }, toDisplayString(switching.value && switchingHash.value === commit.hash ? "Switching..." : "Switch"), 9, _hoisted_14$6)) : createCommentVNode("", true)
                  ])
                ], 2);
              }), 128))
            ])
          ])
        ], 32)
      ]);
    };
  }
};
const ChangelogModal = /* @__PURE__ */ _export_sfc(_sfc_main$a, [["__scopeId", "data-v-2f863ab4"]]);
const _hoisted_1$8 = { class: "modal-content" };
const _hoisted_2$8 = { class: "modal-header" };
const _hoisted_3$7 = { class: "search-bar" };
const _hoisted_4$7 = { class: "package-list" };
const _hoisted_5$7 = {
  key: 0,
  class: "loading"
};
const _hoisted_6$7 = {
  key: 1,
  class: "error"
};
const _hoisted_7$7 = {
  key: 2,
  class: "empty"
};
const _hoisted_8$7 = { class: "package-row" };
const _hoisted_9$6 = { class: "package-info" };
const _hoisted_10$6 = { class: "package-meta" };
const _hoisted_11$6 = { class: "package-name" };
const _hoisted_12$6 = { class: "package-version" };
const _hoisted_13$5 = ["disabled", "onClick"];
const _hoisted_14$5 = { class: "modal-footer" };
const _hoisted_15$5 = ["disabled"];
const _hoisted_16$5 = { class: "version-selector-content" };
const _hoisted_17$5 = { class: "version-selector-header" };
const _hoisted_18$5 = {
  key: 0,
  class: "loading"
};
const _hoisted_19$5 = {
  key: 1,
  class: "error"
};
const _hoisted_20$5 = {
  key: 2,
  class: "empty"
};
const _hoisted_21$5 = {
  key: 3,
  class: "versions-list"
};
const _hoisted_22$5 = ["onClick"];
const _hoisted_23$5 = { class: "version-number" };
const _hoisted_24$4 = {
  key: 0,
  class: "current-indicator"
};
const _sfc_main$9 = {
  __name: "PipPackagesModal",
  emits: ["close", "package-switched"],
  setup(__props, { emit: __emit }) {
    const emit2 = __emit;
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        emit2("close");
      }
      mouseDownOnOverlay = false;
    }
    const packages = /* @__PURE__ */ ref([]);
    const loading = /* @__PURE__ */ ref(true);
    const error = /* @__PURE__ */ ref(null);
    const searchQuery = /* @__PURE__ */ ref("");
    const switching = /* @__PURE__ */ ref(false);
    const switchingPackage = /* @__PURE__ */ ref(null);
    const statusMessage = /* @__PURE__ */ ref("");
    const statusError = /* @__PURE__ */ ref(false);
    const statusSuccess = /* @__PURE__ */ ref(false);
    const showVersionSelector = /* @__PURE__ */ ref(false);
    const selectedPackage = /* @__PURE__ */ ref(null);
    const availableVersions = /* @__PURE__ */ ref([]);
    const loadingVersions = /* @__PURE__ */ ref(false);
    const versionsError = /* @__PURE__ */ ref(null);
    const filteredPackages = computed(() => {
      if (!searchQuery.value) return packages.value;
      const query = searchQuery.value.toLowerCase();
      return packages.value.filter(
        (pkg) => pkg.name.toLowerCase().includes(query)
      );
    });
    async function openVersionSelector(pkg) {
      selectedPackage.value = pkg;
      showVersionSelector.value = true;
      loadingVersions.value = true;
      versionsError.value = null;
      availableVersions.value = [];
      try {
        const response = await fetch(`/nuvu/pypi-versions/${encodeURIComponent(pkg.name)}`);
        const data = await response.json();
        if (data.error) {
          versionsError.value = data.error;
        } else {
          availableVersions.value = data.versions || [];
        }
      } catch (e) {
        versionsError.value = "Failed to fetch versions from PyPI";
      } finally {
        loadingVersions.value = false;
      }
    }
    function closeVersionSelector() {
      showVersionSelector.value = false;
      selectedPackage.value = null;
      availableVersions.value = [];
    }
    async function switchToVersion(version2) {
      if (!selectedPackage.value || version2 === selectedPackage.value.version) return;
      const packageName = selectedPackage.value.name;
      switching.value = true;
      switchingPackage.value = packageName;
      statusMessage.value = "";
      statusError.value = false;
      statusSuccess.value = false;
      closeVersionSelector();
      try {
        const headers = await getAuthHeaders();
        headers["Content-Type"] = "application/json";
        const response = await fetch("/nuvu/pip-install", {
          method: "POST",
          headers,
          body: JSON.stringify({
            package: packageName,
            version: version2
          })
        });
        const result = await response.json();
        if (response.ok && result.success) {
          if (result.pending_restart) {
            statusMessage.value = result.message || `${packageName}==${version2} will be installed on next restart (files are locked).`;
          } else {
            statusMessage.value = `Successfully installed ${switchingPackage.value}==${version2}. Restart ComfyUI to apply changes.`;
          }
          statusSuccess.value = true;
          await loadPackages();
          emit2("package-switched", { package: packageName, version: version2, pendingRestart: !!result.pending_restart });
        } else {
          statusMessage.value = result.error || "Failed to switch version";
          statusError.value = true;
        }
      } catch (e) {
        statusMessage.value = `Error: ${e.message}`;
        statusError.value = true;
      } finally {
        switching.value = false;
        switchingPackage.value = null;
      }
    }
    async function loadPackages() {
      try {
        const response = await fetch("/nuvu/pip-list");
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        packages.value = data.packages || [];
      } catch (e) {
        error.value = "Failed to load packages";
      } finally {
        loading.value = false;
      }
    }
    function exportList() {
      if (packages.value.length === 0) return;
      const content = packages.value.map((pkg) => {
        if (pkg.version && pkg.version !== "Unknown" && pkg.version !== "None") {
          return `${pkg.name}==${pkg.version}`;
        }
        return pkg.name;
      }).join("\n");
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "packages_state.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    onMounted(loadPackages);
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$8, [
            createBaseVNode("div", _hoisted_2$8, [
              _cache[2] || (_cache[2] = createBaseVNode("h3", null, "Installed Packages", -1)),
              createBaseVNode("button", {
                class: "close-icon",
                onClick: _cache[0] || (_cache[0] = ($event) => _ctx.$emit("close"))
              }, "×")
            ]),
            createBaseVNode("div", _hoisted_3$7, [
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => searchQuery.value = $event),
                type: "text",
                placeholder: "Search packages...",
                class: "search-input"
              }, null, 512), [
                [vModelText, searchQuery.value]
              ])
            ]),
            statusMessage.value ? (openBlock(), createElementBlock("div", {
              key: 0,
              class: normalizeClass(["status-message", { "status-error": statusError.value, "status-success": statusSuccess.value }])
            }, toDisplayString(statusMessage.value), 3)) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_4$7, [
              loading.value ? (openBlock(), createElementBlock("div", _hoisted_5$7, "Loading packages...")) : error.value ? (openBlock(), createElementBlock("div", _hoisted_6$7, toDisplayString(error.value), 1)) : filteredPackages.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_7$7, "No packages found")) : (openBlock(true), createElementBlock(Fragment, { key: 3 }, renderList(filteredPackages.value, (pkg) => {
                return openBlock(), createElementBlock("div", {
                  key: pkg.name,
                  class: "package-item"
                }, [
                  createBaseVNode("div", _hoisted_8$7, [
                    createBaseVNode("div", _hoisted_9$6, [
                      createBaseVNode("div", _hoisted_10$6, [
                        createBaseVNode("span", _hoisted_11$6, toDisplayString(pkg.name), 1),
                        createBaseVNode("span", _hoisted_12$6, toDisplayString(pkg.version || "Unknown"), 1)
                      ])
                    ]),
                    createBaseVNode("button", {
                      class: "switch-btn",
                      disabled: switching.value,
                      onClick: ($event) => openVersionSelector(pkg)
                    }, toDisplayString(switching.value && switchingPackage.value === pkg.name ? "Switching..." : "Switch"), 9, _hoisted_13$5)
                  ])
                ]);
              }), 128))
            ]),
            createBaseVNode("div", _hoisted_14$5, [
              createBaseVNode("button", {
                class: "export-btn",
                disabled: loading.value || packages.value.length === 0,
                onClick: exportList
              }, " Export List ", 8, _hoisted_15$5)
            ]),
            showVersionSelector.value ? (openBlock(), createElementBlock("div", {
              key: 1,
              class: "version-selector-overlay",
              onClick: withModifiers(closeVersionSelector, ["self"])
            }, [
              createBaseVNode("div", _hoisted_16$5, [
                createBaseVNode("div", _hoisted_17$5, [
                  createBaseVNode("h4", null, "Select version for " + toDisplayString(selectedPackage.value?.name), 1),
                  createBaseVNode("button", {
                    class: "close-icon",
                    onClick: closeVersionSelector
                  }, "×")
                ]),
                loadingVersions.value ? (openBlock(), createElementBlock("div", _hoisted_18$5, "Loading versions from PyPI...")) : versionsError.value ? (openBlock(), createElementBlock("div", _hoisted_19$5, toDisplayString(versionsError.value), 1)) : availableVersions.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_20$5, "No versions available")) : (openBlock(), createElementBlock("div", _hoisted_21$5, [
                  (openBlock(true), createElementBlock(Fragment, null, renderList(availableVersions.value, (version2) => {
                    return openBlock(), createElementBlock("div", {
                      key: version2,
                      class: normalizeClass(["version-item", { "current-version": version2 === selectedPackage.value?.version }]),
                      onClick: ($event) => switchToVersion(version2)
                    }, [
                      createBaseVNode("span", _hoisted_23$5, toDisplayString(version2), 1),
                      version2 === selectedPackage.value?.version ? (openBlock(), createElementBlock("span", _hoisted_24$4, "Current")) : createCommentVNode("", true)
                    ], 10, _hoisted_22$5);
                  }), 128))
                ]))
              ])
            ])) : createCommentVNode("", true)
          ])
        ], 32)
      ]);
    };
  }
};
const PipPackagesModal = /* @__PURE__ */ _export_sfc(_sfc_main$9, [["__scopeId", "data-v-a7ccd662"]]);
const _hoisted_1$7 = { class: "optimizer-panel" };
const _hoisted_2$7 = {
  key: 0,
  class: "progress-modal-overlay"
};
const _hoisted_3$6 = { class: "progress-modal-content" };
const _hoisted_4$6 = { class: "progress-modal-title" };
const _hoisted_5$6 = { class: "utilities-section" };
const _hoisted_6$6 = { class: "button-grid" };
const _hoisted_7$6 = { class: "utility-col" };
const _hoisted_8$6 = ["disabled", "title"];
const _hoisted_9$5 = {
  key: 0,
  class: "update-indicator"
};
const _hoisted_10$5 = { class: "utility-col" };
const _hoisted_11$5 = ["disabled"];
const _hoisted_12$5 = { class: "update-mode-selector" };
const _hoisted_13$4 = { class: "radio-option" };
const _hoisted_14$4 = ["disabled"];
const _hoisted_15$4 = { class: "radio-option" };
const _hoisted_16$4 = ["disabled"];
const _hoisted_17$4 = { class: "config-section" };
const _hoisted_18$4 = {
  key: 0,
  class: "loading"
};
const _hoisted_19$4 = {
  key: 1,
  class: "system-info"
};
const _hoisted_20$4 = { class: "info-row" };
const _hoisted_21$4 = { class: "info-value" };
const _hoisted_22$4 = { class: "info-row" };
const _hoisted_23$4 = { class: "info-value" };
const _hoisted_24$3 = { class: "info-row" };
const _hoisted_25$3 = { class: "info-value" };
const _hoisted_26$3 = { class: "info-row" };
const _hoisted_27$3 = { class: "info-value" };
const _hoisted_28$3 = {
  key: 2,
  class: "empty"
};
const _hoisted_29$3 = { class: "config-section" };
const _hoisted_30$3 = {
  key: 0,
  class: "loading"
};
const _hoisted_31$3 = {
  key: 1,
  class: "system-info"
};
const _hoisted_32$3 = { class: "info-row" };
const _hoisted_33$3 = { class: "info-value" };
const _hoisted_34$3 = { class: "info-row" };
const _hoisted_35$3 = { class: "info-value" };
const _hoisted_36$3 = { class: "info-row" };
const _hoisted_37$3 = { class: "info-value" };
const _hoisted_38$3 = { class: "info-row" };
const _hoisted_39$3 = { class: "info-value" };
const _hoisted_40$2 = { class: "info-row" };
const _hoisted_41$1 = { class: "info-value" };
const _hoisted_42$1 = { class: "info-row" };
const _hoisted_43$1 = { class: "info-value" };
const _hoisted_44$1 = { class: "info-row" };
const _hoisted_45$1 = { class: "info-value" };
const _hoisted_46$1 = {
  key: 2,
  class: "empty"
};
const _hoisted_47$1 = { class: "packages-section" };
const _hoisted_48$1 = { class: "pytorch-switcher" };
const _hoisted_49$1 = {
  key: 0,
  class: "pytorch-current"
};
const _hoisted_50$1 = { class: "pytorch-info" };
const _hoisted_51$1 = { class: "pytorch-version" };
const _hoisted_52$1 = {
  key: 0,
  class: "pytorch-cuda"
};
const _hoisted_53$1 = ["disabled"];
const _hoisted_54$1 = {
  key: 1,
  class: "pytorch-form"
};
const _hoisted_55$1 = {
  key: 0,
  class: "loading"
};
const _hoisted_56$1 = {
  key: 1,
  class: "form-group full-width"
};
const _hoisted_57$1 = ["value"];
const _hoisted_58$1 = {
  key: 2,
  class: "empty"
};
const _hoisted_59$1 = { class: "form-actions" };
const _hoisted_60$1 = ["disabled"];
const _hoisted_61$1 = { class: "packages-section" };
const _hoisted_62$1 = { class: "sage-toggle ck-toggle" };
const _hoisted_63$1 = { class: "toggle-label" };
const _hoisted_64$1 = ["checked", "disabled"];
const _hoisted_65$1 = { class: "toggle-text" };
const _hoisted_66$1 = {
  key: 0,
  class: "loading"
};
const _hoisted_67$1 = {
  key: 1,
  class: "package-list"
};
const _hoisted_68$1 = { class: "package-info" };
const _hoisted_69$1 = { class: "package-name" };
const _hoisted_70$1 = { class: "package-description" };
const _hoisted_71$1 = { class: "package-version" };
const _hoisted_72$1 = {
  key: 0,
  class: "version-badge installed"
};
const _hoisted_73$1 = {
  key: 1,
  class: "version-badge not-installed"
};
const _hoisted_74$1 = ["title"];
const _hoisted_75$1 = {
  key: 3,
  class: "version-badge update-available"
};
const _hoisted_76$1 = {
  key: 0,
  class: "sage-toggle"
};
const _hoisted_77$1 = { class: "toggle-label" };
const _hoisted_78$1 = ["checked", "disabled"];
const _hoisted_79$1 = { class: "toggle-text" };
const _hoisted_80$1 = { class: "package-actions" };
const _hoisted_81$1 = ["disabled", "title", "onClick"];
const _hoisted_82$1 = ["disabled", "onClick"];
const _hoisted_83$1 = {
  key: 2,
  class: "empty"
};
const _hoisted_84$1 = { class: "packages-section" };
const _hoisted_85$1 = { class: "python-env-buttons" };
const _hoisted_86$1 = ["disabled"];
const _hoisted_87$1 = ["disabled"];
const _hoisted_88$1 = {
  key: 0,
  class: "install-package-dialog"
};
const _hoisted_89$1 = { class: "install-package-header" };
const _hoisted_90$1 = { class: "install-package-form" };
const _hoisted_91$1 = ["disabled"];
const _hoisted_92$1 = ["disabled"];
const _hoisted_93$1 = { class: "packages-section" };
const _hoisted_94$1 = { class: "aria2-status-row" };
const _hoisted_95$1 = {
  key: 0,
  class: "aria2-ok"
};
const _hoisted_96$1 = { class: "aria2-detail" };
const _hoisted_97$1 = ["disabled"];
const _hoisted_98$1 = {
  key: 1,
  class: "aria2-hint"
};
const _hoisted_99$1 = { class: "download-bandwidth" };
const _hoisted_100$1 = { class: "toggle-label bandwidth-toggle" };
const _hoisted_101$1 = ["disabled"];
const _hoisted_102$1 = { class: "bandwidth-measure" };
const _hoisted_103$1 = ["disabled"];
const _hoisted_104$1 = {
  key: 0,
  class: "measured-speed"
};
const _hoisted_105$1 = {
  key: 0,
  class: "bandwidth-share"
};
const _hoisted_106$1 = ["disabled"];
const _hoisted_107$1 = { class: "share-value" };
const _hoisted_108$1 = { class: "mbit-hint" };
const _hoisted_109$1 = {
  key: 1,
  class: "measured-speed current-limit"
};
const _hoisted_110$1 = { class: "mbit-hint" };
const _hoisted_111$1 = { class: "bandwidth-actions" };
const _hoisted_112$1 = ["disabled"];
const _hoisted_113$1 = {
  key: 2,
  class: "download-limit-notice"
};
const _hoisted_114$1 = { class: "packages-section" };
const _hoisted_115$1 = {
  key: 0,
  class: "package-list"
};
const _hoisted_116$1 = { class: "package-info" };
const _hoisted_117$1 = { class: "tool-header" };
const _hoisted_118$1 = { class: "package-name" };
const _hoisted_119$1 = ["disabled", "onClick"];
const _hoisted_120$1 = { class: "package-description" };
const _hoisted_121$1 = { class: "package-version" };
const _hoisted_122$1 = {
  key: 0,
  class: "version-badge installed"
};
const _hoisted_123$1 = {
  key: 1,
  class: "version-badge not-installed"
};
const _hoisted_124$1 = {
  key: 0,
  class: "cuda-config"
};
const _hoisted_125$1 = { class: "cuda-config-row" };
const _hoisted_126 = { value: "match" };
const _hoisted_127 = {
  key: 0,
  class: "cuda-config-row"
};
const _hoisted_128 = {
  key: 1,
  class: "cuda-config-hint error"
};
const _hoisted_129 = {
  key: 1,
  class: "build-shell-section"
};
const _hoisted_130 = ["disabled", "title"];
const _hoisted_131 = {
  key: 0,
  class: "build-shell-note"
};
const _sfc_main$8 = {
  __name: "OptimizerPanel",
  setup(__props) {
    const isUpdating = /* @__PURE__ */ ref(false);
    const injectedVersions = inject("nuvuVersions", null);
    const injectedIsLoadingVersions = inject("isLoadingnuvuVersions", null);
    const injectedLoadVersions = inject("loadnuvuVersions", null);
    const isLoadingVersions = injectedIsLoadingVersions || /* @__PURE__ */ ref(false);
    const isLoadingConfigs = /* @__PURE__ */ ref(false);
    const isInstallingPackage = /* @__PURE__ */ ref(false);
    const installingPackageName = /* @__PURE__ */ ref("");
    const installingPackageAction = /* @__PURE__ */ ref("install");
    const statusMessage = /* @__PURE__ */ ref("");
    const statusError = /* @__PURE__ */ ref(false);
    const versions = injectedVersions || /* @__PURE__ */ ref(null);
    const comfyConfigs = /* @__PURE__ */ ref([]);
    const showRestartModal = /* @__PURE__ */ ref(false);
    const activeChangelog = /* @__PURE__ */ ref(null);
    const restartNotice = /* @__PURE__ */ ref("");
    const restartNoticeType = /* @__PURE__ */ ref("");
    const showErrorModal = /* @__PURE__ */ ref(false);
    const errorModalMessage = /* @__PURE__ */ ref("");
    const showPipPackagesModal = /* @__PURE__ */ ref(false);
    const showInstallPackageDialog = /* @__PURE__ */ ref(false);
    const installPackageInput = /* @__PURE__ */ ref("");
    const isInstallingCustomPackage = /* @__PURE__ */ ref(false);
    const nuvuUpdateAvailable = /* @__PURE__ */ ref(false);
    const nuvuUpdateInfo = /* @__PURE__ */ ref(null);
    const comfyuiUpdateMode = /* @__PURE__ */ ref("latest");
    const showPyTorchSwitcher = /* @__PURE__ */ ref(false);
    const selectedPytorchConfig = /* @__PURE__ */ ref(null);
    const cudaToolkitMode = /* @__PURE__ */ ref("match");
    const cudaToolkitManualVersion = /* @__PURE__ */ ref("");
    const useSageAttention = /* @__PURE__ */ ref(true);
    const isSavingSagePreference = /* @__PURE__ */ ref(false);
    const useCkAttention = /* @__PURE__ */ ref(true);
    const isSavingCkPreference = /* @__PURE__ */ ref(false);
    const limitDownloadSpeed = /* @__PURE__ */ ref(false);
    const maxDownloadMbps = /* @__PURE__ */ ref(null);
    const measuredMbps = /* @__PURE__ */ ref(null);
    const isMeasuringSpeed = /* @__PURE__ */ ref(false);
    const downloadSharePercent = /* @__PURE__ */ ref(50);
    const isSavingDownloadLimit = /* @__PURE__ */ ref(false);
    const downloadLimitNotice = /* @__PURE__ */ ref("");
    const aria2 = /* @__PURE__ */ ref({ installed: false, version: null, source: null, can_autofetch: false, install_hint: null });
    const isInstallingAria2 = /* @__PURE__ */ ref(false);
    const effectiveLimitMbps = computed(() => {
      if (!limitDownloadSpeed.value) return 0;
      if (measuredMbps.value) {
        return Math.max(0.1, Math.round(measuredMbps.value * downloadSharePercent.value) / 100);
      }
      return Number(maxDownloadMbps.value) || 0;
    });
    function toMbit(mbps) {
      return Math.round((Number(mbps) || 0) * 8);
    }
    async function loadAria2Status() {
      try {
        const response = await fetch("/nuvu/aria2/status");
        if (response.ok) aria2.value = await response.json();
      } catch (error) {
        console.error("[nuvu] aria2 status failed:", error);
      }
    }
    async function downloadAria2() {
      isInstallingAria2.value = true;
      try {
        const response = await fetch("/nuvu/aria2/install", { method: "POST" });
        const data = await response.json();
        aria2.value = data;
        downloadLimitNotice.value = data.installed ? `aria2 ready (v${data.version || "?"}).` : data.install_hint ? `Could not auto-install here. Run: ${data.install_hint}` : "Could not install aria2.";
      } catch (error) {
        console.error("[nuvu] aria2 install failed:", error);
        downloadLimitNotice.value = "Could not install aria2.";
      } finally {
        isInstallingAria2.value = false;
      }
    }
    async function measureDownloadSpeed() {
      isMeasuringSpeed.value = true;
      downloadLimitNotice.value = "";
      try {
        const response = await fetch("/nuvu/measure-download-speed");
        if (response.ok) {
          const data = await response.json();
          measuredMbps.value = data.mbps;
          downloadLimitNotice.value = `Measured ${data.mbps} MB/s (${data.sampled_mb} MB in ${data.seconds}s).`;
        } else {
          downloadLimitNotice.value = "Could not measure connection speed.";
        }
      } catch (error) {
        console.error("[nuvu] Speed measurement failed:", error);
        downloadLimitNotice.value = "Could not measure connection speed.";
      } finally {
        isMeasuringSpeed.value = false;
      }
    }
    function extractValue(field) {
      if (!field) return null;
      if (typeof field === "object" && field.S) return field.S;
      return field;
    }
    function normalizeVersionForCompare(value) {
      if (value === null || value === void 0) return null;
      let cleaned = String(value).trim();
      cleaned = cleaned.replace(/^>=/, "").replace(/^<=/, "").replace(/^==/, "").replace(/^>/, "").replace(/^</, "");
      return cleaned.trim();
    }
    function stripBuildSuffix(versionValue) {
      if (!versionValue) return "";
      return String(versionValue).split("+")[0].split("-")[0].trim();
    }
    function compareVersions(version1, version2) {
      const v1Parts = String(version1).split(".").map(Number);
      const v2Parts = String(version2).split(".").map(Number);
      const maxLength = Math.max(v1Parts.length, v2Parts.length);
      for (let i = 0; i < maxLength; i++) {
        const v1Part = v1Parts[i] || 0;
        const v2Part = v2Parts[i] || 0;
        if (v1Part > v2Part) return 1;
        if (v1Part < v2Part) return -1;
      }
      return 0;
    }
    function versionMatches(requiredRaw, currentRaw) {
      if (!requiredRaw || !currentRaw) return false;
      const required = String(requiredRaw).trim();
      const current = String(currentRaw).trim();
      if (required === current) return true;
      if (required.startsWith(">=")) {
        const minVersion = normalizeVersionForCompare(required);
        return compareVersions(current, minVersion) >= 0;
      }
      if (required.startsWith(">")) {
        const minVersion = normalizeVersionForCompare(required);
        return compareVersions(current, minVersion) > 0;
      }
      if (required.startsWith("<=")) {
        const maxVersion = normalizeVersionForCompare(required);
        return compareVersions(current, maxVersion) <= 0;
      }
      if (required.startsWith("<")) {
        const maxVersion = normalizeVersionForCompare(required);
        return compareVersions(current, maxVersion) < 0;
      }
      if (required.startsWith("==")) {
        const exactVersion = normalizeVersionForCompare(required);
        return exactVersion === current;
      }
      return required === current;
    }
    function getSystemVersionsForComfyConfigMatching() {
      const python = versions.value?.python?.version ? String(versions.value.python.version).trim() : null;
      const torchFull = versions.value?.torch?.version ? String(versions.value.torch.version).trim() : null;
      const torch = torchFull ? stripBuildSuffix(torchFull) : null;
      const cuda = versions.value?.cuda?.version ? String(versions.value.cuda.version).trim() : null;
      return { python, torchFull, torch, cuda };
    }
    function extractCudaFromTorchBuild(torchVersionRaw) {
      if (!torchVersionRaw) return null;
      const raw = String(torchVersionRaw);
      const match = raw.match(/cu(\d{2,3})/i);
      if (!match) return null;
      const digits = match[1];
      if (digits.length === 2) {
        return `${digits[0]}.${digits[1]}`;
      }
      if (digits.length === 3) {
        return `${digits.slice(0, 2)}.${digits.slice(2)}`;
      }
      return null;
    }
    function findMatchingComfyConfig(category, systemVersions) {
      const targetCategory = String(category || "").toLowerCase();
      const candidates = comfyConfigs.value.filter((c) => {
        const cat = extractValue(c.category);
        return String(cat || "").toLowerCase() === targetCategory;
      });
      for (const cfg of candidates) {
        const pythonReq = extractValue(cfg.pythonVersion);
        const torchReq = extractValue(cfg.torchVersion);
        const cudaReq = extractValue(cfg.cudaVersion);
        let matches = true;
        if (pythonReq && String(pythonReq).trim() !== "") {
          if (!systemVersions.python || !versionMatches(pythonReq, systemVersions.python)) {
            matches = false;
          }
        }
        if (torchReq && String(torchReq).trim() !== "") {
          if (!systemVersions.torch || !versionMatches(torchReq, systemVersions.torch)) {
            matches = false;
          }
        }
        if (cudaReq && String(cudaReq).trim() !== "") {
          if (!systemVersions.cuda || !versionMatches(cudaReq, systemVersions.cuda)) {
            matches = false;
          }
        }
        if (matches) return cfg;
      }
      return null;
    }
    function parseVersion(versionStr) {
      if (!versionStr || versionStr === "Latest") return [0, 0, 0];
      const parts = versionStr.replace(/^==?/, "").split(".").map((p2) => parseInt(p2, 10) || 0);
      while (parts.length < 3) parts.push(0);
      return parts;
    }
    const pytorchConfigs = computed(() => {
      const configs = comfyConfigs.value.filter((config) => {
        const category = extractValue(config.category);
        return category?.toLowerCase() === "pytorch" || category?.toLowerCase() === "torch";
      }).map((config) => {
        const versionRaw = extractValue(config.version) || "Latest";
        const cudaVersionRaw = extractValue(config.cudaVersion);
        const configId = extractValue(config.id);
        const packageSource = extractValue(config.packageSource);
        const versionClean = versionRaw.replace(/^==?/, "");
        let cudaClean = "";
        if (cudaVersionRaw) {
          cudaClean = cudaVersionRaw.replace(/^==?/, "");
        }
        let label = `PyTorch ${versionClean}`;
        if (cudaClean) {
          label += ` - CUDA ${cudaClean}`;
        }
        return {
          id: configId,
          version: versionRaw,
          versionClean,
          cudaVersion: cudaVersionRaw,
          cudaClean,
          label,
          packageSource,
          raw: config
        };
      });
      configs.sort((a, b) => {
        const pytorchA = parseVersion(a.versionClean);
        const pytorchB = parseVersion(b.versionClean);
        for (let i = 0; i < 3; i++) {
          if (pytorchB[i] !== pytorchA[i]) {
            return pytorchB[i] - pytorchA[i];
          }
        }
        const cudaA = parseVersion(a.cudaClean);
        const cudaB = parseVersion(b.cudaClean);
        for (let i = 0; i < 3; i++) {
          if (cudaB[i] !== cudaA[i]) {
            return cudaB[i] - cudaA[i];
          }
        }
        return 0;
      });
      return configs;
    });
    const sageConfigs = computed(() => {
      return comfyConfigs.value.filter((config) => {
        const category = extractValue(config.category);
        return category?.toLowerCase() === "sageattention" || category?.toLowerCase() === "sage";
      }).map((config) => {
        const version2 = extractValue(config.version) || "Latest";
        const configId = extractValue(config.id);
        const packageSource = extractValue(config.packageSource);
        return {
          id: configId,
          version: version2,
          label: version2,
          packageSource,
          raw: config
        };
      });
    });
    const tritonConfigs = computed(() => {
      return comfyConfigs.value.filter((config) => {
        const category = extractValue(config.category);
        return category?.toLowerCase() === "triton" || category?.toLowerCase() === "triton-windows";
      }).map((config) => {
        const version2 = extractValue(config.version) || "Latest";
        const configId = extractValue(config.id);
        const packageSource = extractValue(config.packageSource);
        return {
          id: configId,
          version: version2,
          label: version2,
          packageSource,
          raw: config
        };
      });
    });
    const compatibleConfigByCategory = computed(() => {
      if (!versions.value) return {};
      if (!Array.isArray(comfyConfigs.value) || comfyConfigs.value.length === 0) return {};
      const systemVersions = getSystemVersionsForComfyConfigMatching();
      return {
        "sageattention": findMatchingComfyConfig("sageattention", systemVersions),
        "triton-windows": findMatchingComfyConfig("triton-windows", systemVersions)
      };
    });
    function isPackageUpToDate(pkg) {
      if (!pkg.installed) return false;
      if (!pkg.latestVersion) return true;
      return pkg.version === pkg.latestVersion;
    }
    const packages = computed(() => {
      if (!versions.value) return [];
      const isWindowsOS = versions.value.os === "Windows";
      const hasTorch = versions.value.torch?.installed && !!versions.value.torch?.version;
      const sageMatch = compatibleConfigByCategory.value?.["sageattention"] || null;
      const tritonWindowsMatch = compatibleConfigByCategory.value?.["triton-windows"] || null;
      const buildInstallConfig = (cfg) => {
        if (!cfg) return null;
        return {
          version: extractValue(cfg.version),
          cudaVersion: extractValue(cfg.cudaVersion),
          torchVersion: extractValue(cfg.torchVersion),
          packageSource: extractValue(cfg.packageSource),
          configId: extractValue(cfg.id)
        };
      };
      const formatInstallVersion = (cfg) => {
        if (!cfg) return null;
        const raw = extractValue(cfg.version);
        if (!raw) return null;
        return String(raw).replace(/^==?/, "").trim();
      };
      return [
        {
          id: "triton-windows",
          name: "Windows Triton",
          description: "GPU acceleration for Windows",
          installed: versions.value.windows_triton?.installed,
          version: versions.value.windows_triton?.version,
          latestVersion: versions.value.windows_triton?.latest_version,
          category: "triton-windows",
          show: isWindowsOS,
          hasConfigs: tritonConfigs.value.length > 0,
          requiresTorchMatch: true,
          compatibleVersion: formatInstallVersion(tritonWindowsMatch),
          installConfig: buildInstallConfig(tritonWindowsMatch),
          compatibilityMessage: !hasTorch ? "Requires PyTorch to be installed" : tritonWindowsMatch ? "Matches your current PyTorch/CUDA" : "No compatible build found for your PyTorch/CUDA"
        },
        {
          id: "triton",
          name: "Triton",
          description: "GPU acceleration for Linux/Mac",
          installed: versions.value.triton?.installed,
          version: versions.value.triton?.version,
          latestVersion: null,
          category: "triton",
          show: !isWindowsOS,
          hasConfigs: false
        },
        {
          id: "sageattention",
          name: "SageAttention",
          description: "Memory-efficient attention mechanism",
          installed: versions.value.sageattention?.installed,
          version: versions.value.sageattention?.version,
          latestVersion: versions.value.sageattention?.latest_version,
          category: "sageattention",
          show: true,
          hasConfigs: sageConfigs.value.length > 0,
          requiresTorchMatch: true,
          compatibleVersion: formatInstallVersion(sageMatch),
          installConfig: buildInstallConfig(sageMatch),
          compatibilityMessage: !hasTorch ? "Requires PyTorch to be installed" : sageMatch ? "Matches your current PyTorch/CUDA" : "No compatible build found for your PyTorch/CUDA"
        },
        {
          id: "onnxruntime-gpu",
          name: "ONNX Runtime GPU",
          description: "GPU-accelerated inference (fixes slow pose/depth)",
          installed: versions.value.onnxruntime_gpu?.installed,
          version: versions.value.onnxruntime_gpu?.version,
          latestVersion: versions.value.onnxruntime_gpu?.latest_version,
          category: "onnxruntime-gpu",
          show: true,
          hasConfigs: false
        }
      ].filter((pkg) => pkg.show);
    });
    const advancedTools = computed(() => {
      if (!versions.value) return [];
      const isWindowsOS = versions.value.os === "Windows";
      return [
        {
          id: "cuda-toolkit",
          name: "CUDA Toolkit",
          description: "NVIDIA CUDA development toolkit",
          installed: !!versions.value.cudaDriver?.version,
          version: versions.value.cudaDriver?.version,
          category: "cuda-toolkit",
          show: true,
          alwaysAllowInstall: true
          // Can always update/reinstall CUDA
        },
        {
          id: "vs-build-tools",
          name: "VS Build Tools 2022",
          description: "Microsoft Visual Studio Build Tools (required for compilation)",
          installed: versions.value.vs_build_tools?.installed,
          version: versions.value.vs_build_tools?.version,
          category: "vs-build-tools",
          show: isWindowsOS
        }
      ].filter((tool) => tool.show);
    });
    const systemInfo = computed(() => {
      if (!versions.value) return null;
      return {
        os: versions.value.os,
        python: versions.value.python?.version,
        torch: versions.value.torch?.version,
        torchCuda: versions.value.cuda?.version,
        cudaDriver: versions.value.cudaDriver?.version,
        gpuName: versions.value.gpu?.name,
        gpuVram: versions.value.gpu?.vram_gb,
        ram: versions.value.ram?.total_gb
      };
    });
    const comfyuiInfo = computed(() => {
      if (!versions.value) return null;
      return {
        nuvuFrontend: versions.value.nuvu_frontend?.tag,
        nuvuFrontendHash: versions.value.nuvu_frontend?.hash,
        nuvuBackend: versions.value.nuvu_backend?.version,
        comfyuiFrontend: versions.value.comfyui_frontend?.version,
        comfyuiBackend: versions.value.comfyui_backend?.tag,
        comfyuiBackendHash: versions.value.comfyui_backend?.hash
      };
    });
    const detectedPytorchCudaVersion = computed(() => {
      const fromTorchField = systemInfo.value?.torchCuda ? String(systemInfo.value.torchCuda).trim() : "";
      if (fromTorchField) return fromTorchField;
      const fromTorchBuild = extractCudaFromTorchBuild(systemInfo.value?.torch);
      return fromTorchBuild ? String(fromTorchBuild).trim() : "";
    });
    const cudaToolkitTargetVersion = computed(() => {
      if (cudaToolkitMode.value === "match") {
        return detectedPytorchCudaVersion.value || "";
      }
      return cudaToolkitManualVersion.value ? String(cudaToolkitManualVersion.value).trim() : "";
    });
    const isWindows = computed(() => versions.value?.os === "Windows");
    onMounted(() => {
      loadVersions();
      loadComfyConfigs();
      checknuvuUpdates();
      loadUserConfig();
      loadAria2Status();
    });
    async function loadVersions() {
      if (typeof injectedLoadVersions === "function") {
        await injectedLoadVersions();
        return;
      }
      isLoadingVersions.value = true;
      try {
        const response = await fetch("/nuvu/check-versions");
        if (response.ok) {
          versions.value = await response.json();
        }
      } catch (error) {
        console.error("[Nuvu] Failed to load versions:", error);
      } finally {
        isLoadingVersions.value = false;
      }
    }
    async function loadComfyConfigs() {
      isLoadingConfigs.value = true;
      try {
        const websiteUrl2 = getWebsiteBaseUrl();
        if (!websiteUrl2) {
          console.error("[nuvu] Website base URL not configured");
          return;
        }
        const apiUrl = `${websiteUrl2}/api/comfy-configs`;
        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`,
            "Content-Type": "application/json"
          }
        });
        if (response.ok) {
          const data = await response.json();
          comfyConfigs.value = Array.isArray(data) ? data : [];
          if (pytorchConfigs.value.length > 0 && !selectedPytorchConfig.value) {
            selectedPytorchConfig.value = pytorchConfigs.value[0].id;
          }
        } else {
          console.error("[nuvu] comfy-configs response not ok:", response.status, await response.text());
        }
      } catch (error) {
        console.error("[nuvu] Failed to load comfy configs:", error);
      } finally {
        isLoadingConfigs.value = false;
      }
    }
    async function loadUserConfig() {
      try {
        const response = await fetch("/nuvu/user-config");
        if (response.ok) {
          const data = await response.json();
          useSageAttention.value = data.use_sage_attention === true;
          useCkAttention.value = data.use_ck_attention !== false;
          const saved = Number(data.max_download_mbps || 0);
          limitDownloadSpeed.value = saved > 0;
          maxDownloadMbps.value = saved > 0 ? saved : null;
        }
      } catch (error) {
        console.error("[nuvu] Failed to load user config:", error);
      }
    }
    async function saveDownloadLimit() {
      const requested = effectiveLimitMbps.value;
      if (limitDownloadSpeed.value && (!Number.isFinite(requested) || requested <= 0)) {
        downloadLimitNotice.value = "Measure your connection first, then pick a share of it.";
        return;
      }
      isSavingDownloadLimit.value = true;
      downloadLimitNotice.value = "";
      try {
        const getResponse = await fetch("/nuvu/user-config");
        let currentConfig = {};
        if (getResponse.ok) {
          currentConfig = await getResponse.json();
        }
        const saveResponse = await fetch("/nuvu/user-config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify({
            ...currentConfig,
            max_download_mbps: requested
          })
        });
        if (saveResponse.ok) {
          downloadLimitNotice.value = requested > 0 ? `Model downloads limited to ${requested} MB/s.` : "Model downloads will use the full connection.";
        } else {
          downloadLimitNotice.value = "Failed to save the download speed setting.";
        }
      } catch (error) {
        console.error("[nuvu] Failed to save download limit:", error);
        downloadLimitNotice.value = "Failed to save the download speed setting.";
      } finally {
        isSavingDownloadLimit.value = false;
      }
    }
    async function toggleSageAttention() {
      const newValue = !useSageAttention.value;
      if (newValue === true && !versions.value?.sageattention?.installed) {
        statusMessage.value = "Cannot enable SageAttention - it is not installed";
        statusError.value = true;
        return;
      }
      isSavingSagePreference.value = true;
      try {
        const getResponse = await fetch("/nuvu/user-config");
        let currentConfig = {};
        if (getResponse.ok) {
          currentConfig = await getResponse.json();
        }
        const saveResponse = await fetch("/nuvu/user-config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify({
            ...currentConfig,
            use_sage_attention: newValue,
            // Sage and Comfy Kitchen attention are mutually exclusive.
            use_ck_attention: newValue ? false : useCkAttention.value
          })
        });
        if (saveResponse.ok) {
          useSageAttention.value = newValue;
          if (newValue) useCkAttention.value = false;
          restartNoticeType.value = "success";
          restartNotice.value = newValue ? "SageAttention enabled. Restart ComfyUI to apply." : "SageAttention disabled. Restart ComfyUI to apply.";
          showRestartModal.value = true;
        } else {
          statusMessage.value = "Failed to save SageAttention preference";
          statusError.value = true;
        }
      } catch (error) {
        console.error("[nuvu] Failed to save sage attention preference:", error);
        statusMessage.value = `Failed to save preference: ${error.message}`;
        statusError.value = true;
      } finally {
        isSavingSagePreference.value = false;
      }
    }
    async function toggleCkAttention() {
      const newValue = !useCkAttention.value;
      isSavingCkPreference.value = true;
      try {
        const getResponse = await fetch("/nuvu/user-config");
        let currentConfig = {};
        if (getResponse.ok) {
          currentConfig = await getResponse.json();
        }
        const saveResponse = await fetch("/nuvu/user-config", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify({
            ...currentConfig,
            use_ck_attention: newValue,
            use_sage_attention: newValue ? false : useSageAttention.value
          })
        });
        if (saveResponse.ok) {
          useCkAttention.value = newValue;
          if (newValue) useSageAttention.value = false;
          restartNoticeType.value = "success";
          restartNotice.value = newValue ? "Comfy Kitchen attention enabled. Restart ComfyUI to apply." : "Comfy Kitchen attention disabled. Restart ComfyUI to apply.";
          showRestartModal.value = true;
        } else {
          statusMessage.value = "Failed to save Comfy Kitchen attention preference";
          statusError.value = true;
        }
      } catch (error) {
        console.error("[nuvu] Failed to save CK attention preference:", error);
        statusMessage.value = `Failed to save preference: ${error.message}`;
        statusError.value = true;
      } finally {
        isSavingCkPreference.value = false;
      }
    }
    function getAuthHeaders2() {
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentUser?.apiToken || ""}`
      };
    }
    async function checknuvuUpdates() {
      try {
        const response = await fetch("/nuvu/check-nuvu-updates");
        if (response.ok) {
          const data = await response.json();
          nuvuUpdateAvailable.value = data.updatesAvailable === true;
          nuvuUpdateInfo.value = data;
        }
      } catch (error) {
        nuvuUpdateAvailable.value = false;
      }
    }
    async function updatenuvu() {
      isUpdating.value = true;
      statusMessage.value = "Updating Nuvu...";
      statusError.value = false;
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/update-nuvu", {
          method: "POST",
          headers
        });
        const result = await response.json();
        if (response.ok && result.success) {
          statusMessage.value = result.message || "Nuvu updated successfully! Restart ComfyUI to apply changes.";
          restartNoticeType.value = "success";
          restartNotice.value = statusMessage.value;
          showRestartModal.value = true;
          nuvuUpdateAvailable.value = false;
          nuvuUpdateInfo.value = null;
        } else if (result.requires_restart) {
          const errorMsg = result.errors?.[0] || result.message || "Update requires a restart";
          restartNoticeType.value = "warning";
          restartNotice.value = errorMsg;
          showRestartModal.value = true;
        } else {
          statusMessage.value = result.error || result.message || "Update failed";
          statusError.value = true;
        }
      } catch (error) {
        statusMessage.value = `Update failed: ${error.message}`;
        statusError.value = true;
      } finally {
        isUpdating.value = false;
      }
    }
    async function updateComfyUI() {
      isUpdating.value = true;
      const modeLabel = comfyuiUpdateMode.value === "stable" ? "stable version" : "latest";
      statusMessage.value = `Updating ComfyUI to ${modeLabel}...`;
      statusError.value = false;
      try {
        const headers = await getAuthHeaders2();
        headers["Content-Type"] = "application/json";
        const response = await fetch("/nuvu/update-comfyui", {
          method: "POST",
          headers,
          body: JSON.stringify({
            stable: comfyuiUpdateMode.value === "stable"
          })
        });
        const result = await response.json();
        if (response.ok && result.success) {
          statusMessage.value = result.message || "ComfyUI updated successfully! Restart ComfyUI to apply changes.";
          restartNoticeType.value = "success";
          restartNotice.value = statusMessage.value;
          showRestartModal.value = true;
        } else if (result.requires_restart) {
          const errorMsg = result.errors?.[0] || result.message || "Update requires a restart";
          restartNoticeType.value = "warning";
          restartNotice.value = errorMsg;
          showRestartModal.value = true;
        } else {
          statusMessage.value = result.error || result.message || "Update failed";
          statusError.value = true;
        }
      } catch (error) {
        statusMessage.value = `Update failed: ${error.message}`;
        statusError.value = true;
      } finally {
        isUpdating.value = false;
      }
    }
    async function installPackage(pkg, config = {}) {
      console.log("[nuvu] installPackage called:", pkg.name, pkg.category);
      isInstallingPackage.value = true;
      installingPackageName.value = pkg.name;
      installingPackageAction.value = "install";
      statusMessage.value = `Installing ${pkg.name}...`;
      statusError.value = false;
      console.log("[nuvu] State updated - isInstallingPackage:", isInstallingPackage.value);
      try {
        const isEmptyConfig = config && typeof config === "object" && Object.keys(config).length === 0;
        if (isEmptyConfig && (pkg.category === "sageattention" || pkg.category === "triton-windows")) {
          if (!versions.value?.torch?.installed || !versions.value?.torch?.version) {
            statusMessage.value = "PyTorch must be installed before installing this package.";
            statusError.value = true;
            isInstallingPackage.value = false;
            installingPackageName.value = "";
            installingPackageAction.value = "install";
            return;
          }
          if (!comfyConfigs.value || comfyConfigs.value.length === 0) {
            statusMessage.value = "No comfy-configs available. Please refresh and try again.";
            statusError.value = true;
            isInstallingPackage.value = false;
            installingPackageName.value = "";
            installingPackageAction.value = "install";
            return;
          }
          const systemVersions = getSystemVersionsForComfyConfigMatching();
          const matchingConfig = findMatchingComfyConfig(pkg.category, systemVersions);
          if (!matchingConfig) {
            statusMessage.value = `No compatible ${pkg.name} build found for your current PyTorch ${systemVersions.torchFull || "Unknown"} and CUDA ${systemVersions.cuda || "Unknown"}.`;
            statusError.value = true;
            isInstallingPackage.value = false;
            installingPackageName.value = "";
            installingPackageAction.value = "install";
            return;
          }
          config = {
            version: extractValue(matchingConfig.version),
            cudaVersion: extractValue(matchingConfig.cudaVersion),
            torchVersion: extractValue(matchingConfig.torchVersion),
            packageSource: extractValue(matchingConfig.packageSource),
            configId: extractValue(matchingConfig.id)
          };
        }
        const payload = {
          user_id: currentUser?.id,
          user_email: currentUser?.email,
          script_filename: "package_installer.py",
          options: {
            category: pkg.category,
            config: JSON.stringify(config)
          }
        };
        const response = await fetch("/nuvu/execute/script", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.ok) {
          statusMessage.value = `${pkg.name} installation started. This may take several minutes...`;
          pollInstallStatus();
        } else {
          statusMessage.value = result.error || "Installation failed";
          statusError.value = true;
          isInstallingPackage.value = false;
          installingPackageName.value = "";
          installingPackageAction.value = "install";
        }
      } catch (error) {
        statusMessage.value = `Installation failed: ${error.message}`;
        statusError.value = true;
        isInstallingPackage.value = false;
        installingPackageName.value = "";
        installingPackageAction.value = "install";
      }
    }
    async function installPyTorch() {
      if (!selectedPytorchConfig.value) {
        statusMessage.value = "Please select a PyTorch version";
        statusError.value = true;
        return;
      }
      const selectedConfig = pytorchConfigs.value.find((c) => c.id === selectedPytorchConfig.value);
      if (!selectedConfig) {
        statusMessage.value = "Invalid PyTorch configuration selected";
        statusError.value = true;
        return;
      }
      const pkg = {
        id: "pytorch",
        name: "PyTorch",
        category: "pytorch"
      };
      const version2 = selectedConfig.version?.replace("==", "") || "";
      const cudaVersion = selectedConfig.cudaVersion?.replace("==", "") || "";
      const config = {
        version: version2,
        cudaVersion,
        packageSource: selectedConfig.packageSource
      };
      showPyTorchSwitcher.value = false;
      await installPackage(pkg, config);
    }
    async function openBuildShell() {
      statusMessage.value = "Opening Build Tools shell...";
      statusError.value = false;
      try {
        const payload = {
          user_id: currentUser?.id,
          user_email: currentUser?.email,
          script_filename: "package_installer.py",
          options: {
            category: "vs-build-shell",
            config: "{}"
          }
        };
        const response = await fetch("/nuvu/execute/script", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.ok) {
          statusMessage.value = "Build Tools shell opened in a new window.";
        } else {
          statusMessage.value = result.error || "Failed to open Build Tools shell";
          statusError.value = true;
        }
      } catch (error) {
        statusMessage.value = `Failed: ${error.message}`;
        statusError.value = true;
      }
    }
    async function installCudaToolkit(tool) {
      const targetVersion = cudaToolkitTargetVersion.value;
      if (!targetVersion) {
        statusMessage.value = cudaToolkitMode.value === "match" ? "Unable to detect CUDA version from your current PyTorch. Choose manual and enter a CUDA version." : "Please enter a CUDA Toolkit version (e.g., 12.8).";
        statusError.value = true;
        return;
      }
      await installPackage(tool, { targetVersion, forceReinstall: true });
    }
    async function pollInstallStatus() {
      let longInstallTimeout = null;
      const pollInterval = setInterval(async () => {
        try {
          const response = await fetch("/nuvu/queue/status");
          if (response.ok) {
            const status = await response.json();
            if (status.error) {
              clearInterval(pollInterval);
              if (longInstallTimeout) clearTimeout(longInstallTimeout);
              isInstallingPackage.value = false;
              installingPackageName.value = "";
              installingPackageAction.value = "install";
              statusMessage.value = status.error.message || "Installation failed";
              statusError.value = true;
              const isValidationError = status.error.category === "installer_error";
              if (isValidationError) {
                errorModalMessage.value = status.error.message;
                showErrorModal.value = true;
              } else {
                restartNoticeType.value = "error";
                restartNotice.value = statusMessage.value;
                showRestartModal.value = true;
              }
              return;
            }
            if (status.completed || status.queue_size === 0 && !status.is_processing && status.running_count === 0) {
              clearInterval(pollInterval);
              if (longInstallTimeout) clearTimeout(longInstallTimeout);
              isInstallingPackage.value = false;
              installingPackageName.value = "";
              installingPackageAction.value = "install";
              if (status.pending_restart) {
                restartNoticeType.value = "warning";
                restartNotice.value = status.pending_restart_message || "Files are locked. The operation will complete on restart. Please restart ComfyUI.";
                statusMessage.value = "Restart required to complete operation";
                statusError.value = false;
                showRestartModal.value = true;
                await loadVersions();
                return;
              }
              const warnings = Array.isArray(status.warnings) ? status.warnings : [];
              if (warnings.length > 0) {
                restartNoticeType.value = "warning";
                restartNotice.value = warnings.slice(0, 3).join(" ");
              } else {
                restartNoticeType.value = "success";
                restartNotice.value = "Installation completed.";
              }
              statusMessage.value = "Installation complete!";
              statusError.value = false;
              showRestartModal.value = true;
              await loadVersions();
            }
          }
        } catch (error) {
          console.error("[nuvu] Poll error:", error);
        }
      }, 2e3);
      longInstallTimeout = setTimeout(() => {
        if (isInstallingPackage.value) {
          statusMessage.value = "Installation is taking longer than usual, but is still running...";
          statusError.value = false;
        }
      }, 12e5);
    }
    function getPackageButtonText(pkg) {
      if (isInstallingPackage.value && installingPackageName.value === pkg.name) {
        return "Installing...";
      }
      if (!pkg.installed) {
        return "Install";
      }
      if (isPackageUpToDate(pkg) && !pkg.alwaysAllowInstall) {
        return "Installed";
      }
      if (pkg.latestVersion && pkg.version !== pkg.latestVersion) {
        return "Update";
      }
      return "Reinstall";
    }
    function getCudaToolkitButtonText(tool) {
      if (isInstallingPackage.value && installingPackageName.value === tool.name) {
        return "Installing...";
      }
      return "Install";
    }
    function isButtonDisabled(pkg) {
      if (isInstallingPackage.value || isUpdating.value) return true;
      if (pkg.category === "cuda-toolkit") {
        if (!cudaToolkitTargetVersion.value) return true;
      }
      if (pkg.requiresTorchMatch) {
        const hasTorch = versions.value?.torch?.installed && !!versions.value?.torch?.version;
        if (!hasTorch) return true;
        if (!pkg.installConfig) return true;
      }
      if (isPackageUpToDate(pkg) && !pkg.alwaysAllowInstall) return true;
      return false;
    }
    function needsUpdate(pkg) {
      return pkg.latestVersion && pkg.version !== pkg.latestVersion;
    }
    function closeRestartModal() {
      showRestartModal.value = false;
      restartNotice.value = "";
      restartNoticeType.value = "";
      statusMessage.value = "";
    }
    function handleVersionSwitch({ commit, result }) {
      activeChangelog.value = null;
      const targetRef = commit.tag || commit.hash;
      restartNotice.value = `Switched to ${targetRef}. Please restart ComfyUI to apply changes.`;
      restartNoticeType.value = "success";
      showRestartModal.value = true;
    }
    function handlePackageSwitched({ package: packageName, version: version2, pendingRestart }) {
      showPipPackagesModal.value = false;
      if (pendingRestart) {
        restartNotice.value = `${packageName}==${version2} will be installed on next restart (files are locked).`;
        restartNoticeType.value = "warning";
      } else {
        restartNotice.value = `Installed ${packageName}==${version2}. Please restart ComfyUI to apply changes.`;
        restartNoticeType.value = "success";
      }
      showRestartModal.value = true;
    }
    async function installCustomPackage() {
      const packageSpec = installPackageInput.value.trim();
      if (!packageSpec) return;
      isInstallingCustomPackage.value = true;
      try {
        const headers = await getAuthHeaders2();
        headers["Content-Type"] = "application/json";
        const isUrl = packageSpec.startsWith("http://") || packageSpec.startsWith("https://") || packageSpec.startsWith("git+");
        let body = {};
        if (isUrl) {
          body = { url: packageSpec };
        } else if (packageSpec.includes("==")) {
          const parts = packageSpec.split("==");
          body = { package: parts[0], version: parts[1] };
        } else {
          body = { package: packageSpec };
        }
        const response = await fetch("/nuvu/pip-install", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (response.ok && result.success) {
          showInstallPackageDialog.value = false;
          installPackageInput.value = "";
          const displayName = isUrl ? packageSpec.split("/").pop() : packageSpec;
          if (result.pending_restart) {
            restartNotice.value = result.message || `${displayName} will be installed on next restart (files are locked).`;
            restartNoticeType.value = "warning";
          } else {
            restartNotice.value = `Successfully installed ${displayName}. Please restart ComfyUI to apply changes.`;
            restartNoticeType.value = "success";
          }
          showRestartModal.value = true;
        } else {
          statusMessage.value = result.error || "Failed to install package";
          statusError.value = true;
        }
      } catch (e) {
        statusMessage.value = `Error: ${e.message}`;
        statusError.value = true;
      } finally {
        isInstallingCustomPackage.value = false;
      }
    }
    async function uninstallPackage(pkg) {
      console.log("[nuvu] uninstallPackage called:", pkg.name, pkg.category);
      isInstallingPackage.value = true;
      installingPackageName.value = pkg.name;
      installingPackageAction.value = "uninstall";
      statusMessage.value = `Uninstalling ${pkg.name}...`;
      statusError.value = false;
      try {
        const payload = {
          user_id: currentUser?.id,
          user_email: currentUser?.email,
          script_filename: "package_installer.py",
          options: {
            category: `${pkg.category}-uninstall`,
            config: "{}"
          }
        };
        const response = await fetch("/nuvu/execute/script", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentUser?.apiToken || ""}`
          },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.ok) {
          statusMessage.value = `${pkg.name} uninstall started...`;
          pollInstallStatus();
        } else {
          statusMessage.value = result.error || "Uninstall failed";
          statusError.value = true;
          isInstallingPackage.value = false;
          installingPackageName.value = "";
          installingPackageAction.value = "install";
        }
      } catch (error) {
        statusMessage.value = `Uninstall failed: ${error.message}`;
        statusError.value = true;
        isInstallingPackage.value = false;
        installingPackageName.value = "";
        installingPackageAction.value = "install";
      }
    }
    function canUninstall(pkg) {
      return pkg.installed && !isInstallingPackage.value && !isUpdating.value;
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$7, [
        (openBlock(), createBlock(Teleport, { to: "body" }, [
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              isInstallingPackage.value ? (openBlock(), createElementBlock("div", _hoisted_2$7, [
                createBaseVNode("div", _hoisted_3$6, [
                  _cache[19] || (_cache[19] = createBaseVNode("div", { class: "progress-modal-spinner" }, null, -1)),
                  createBaseVNode("h3", _hoisted_4$6, toDisplayString(installingPackageAction.value === "uninstall" ? "Uninstalling" : "Installing") + " " + toDisplayString(installingPackageName.value), 1),
                  _cache[20] || (_cache[20] = createBaseVNode("p", { class: "progress-modal-subtitle" }, "This may take several minutes. Please don't close this window.", -1))
                ])
              ])) : createCommentVNode("", true)
            ]),
            _: 1
          })
        ])),
        createBaseVNode("div", _hoisted_5$6, [
          _cache[26] || (_cache[26] = createBaseVNode("h4", { class: "section-title" }, "ComfyUI Utilities", -1)),
          createBaseVNode("div", _hoisted_6$6, [
            createBaseVNode("div", _hoisted_7$6, [
              createBaseVNode("button", {
                class: normalizeClass(["nuvu-btn utility-btn", nuvuUpdateAvailable.value ? "nuvu-btn-update-available" : "nuvu-btn-primary"]),
                disabled: isUpdating.value || isInstallingPackage.value,
                onClick: updatenuvu,
                title: nuvuUpdateInfo.value?.behind ? `${nuvuUpdateInfo.value.behind} commit(s) behind` : ""
              }, [
                nuvuUpdateAvailable.value ? (openBlock(), createElementBlock("span", _hoisted_9$5, [..._cache[21] || (_cache[21] = [
                  createBaseVNode("svg", {
                    class: "update-arrow",
                    width: "14",
                    height: "14",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "2.5"
                  }, [
                    createBaseVNode("path", { d: "M12 19V5M5 12l7-7 7 7" })
                  ], -1)
                ])])) : createCommentVNode("", true),
                createTextVNode(" " + toDisplayString(isUpdating.value ? "Updating..." : nuvuUpdateAvailable.value ? "Update Available" : "Update Nuvu"), 1)
              ], 10, _hoisted_8$6),
              createBaseVNode("a", {
                href: "#",
                class: "changelog-link",
                onClick: _cache[0] || (_cache[0] = withModifiers(($event) => activeChangelog.value = { type: "nuvu", title: "Nuvu", current: comfyuiInfo.value?.nuvuFrontendHash || comfyuiInfo.value?.nuvuFrontend }, ["prevent"]))
              }, " view changelog ")
            ]),
            createBaseVNode("div", _hoisted_10$5, [
              createBaseVNode("button", {
                class: "nuvu-btn utility-btn",
                disabled: isUpdating.value || isInstallingPackage.value,
                onClick: updateComfyUI
              }, toDisplayString(isUpdating.value ? "Updating..." : "Update ComfyUI"), 9, _hoisted_11$5),
              createBaseVNode("a", {
                href: "#",
                class: "changelog-link",
                onClick: _cache[1] || (_cache[1] = withModifiers(($event) => activeChangelog.value = { type: "comfyui", title: "ComfyUI", current: comfyuiInfo.value?.comfyuiBackendHash || comfyuiInfo.value?.comfyuiBackend }, ["prevent"]))
              }, " view changelog "),
              createBaseVNode("div", _hoisted_12$5, [
                createBaseVNode("label", _hoisted_13$4, [
                  withDirectives(createBaseVNode("input", {
                    type: "radio",
                    "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => comfyuiUpdateMode.value = $event),
                    value: "latest",
                    disabled: isUpdating.value || isInstallingPackage.value
                  }, null, 8, _hoisted_14$4), [
                    [vModelRadio, comfyuiUpdateMode.value]
                  ]),
                  _cache[22] || (_cache[22] = createBaseVNode("span", { class: "radio-label" }, "Latest", -1)),
                  _cache[23] || (_cache[23] = createBaseVNode("span", { class: "radio-hint" }, "(newest features)", -1))
                ]),
                createBaseVNode("label", _hoisted_15$4, [
                  withDirectives(createBaseVNode("input", {
                    type: "radio",
                    "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => comfyuiUpdateMode.value = $event),
                    value: "stable",
                    disabled: isUpdating.value || isInstallingPackage.value
                  }, null, 8, _hoisted_16$4), [
                    [vModelRadio, comfyuiUpdateMode.value]
                  ]),
                  _cache[24] || (_cache[24] = createBaseVNode("span", { class: "radio-label" }, "Stable", -1)),
                  _cache[25] || (_cache[25] = createBaseVNode("span", { class: "radio-hint" }, "(most consistent)", -1))
                ])
              ])
            ])
          ])
        ]),
        createBaseVNode("div", _hoisted_17$4, [
          _cache[31] || (_cache[31] = createBaseVNode("h4", { class: "section-title" }, "ComfyUI Information", -1)),
          unref(isLoadingVersions) ? (openBlock(), createElementBlock("div", _hoisted_18$4, "Loading ComfyUI info...")) : comfyuiInfo.value ? (openBlock(), createElementBlock("div", _hoisted_19$4, [
            createBaseVNode("div", _hoisted_20$4, [
              _cache[27] || (_cache[27] = createBaseVNode("span", { class: "info-label" }, "Nuvu Frontend:", -1)),
              createBaseVNode("span", _hoisted_21$4, toDisplayString(comfyuiInfo.value.nuvuFrontend || "0.0.0"), 1)
            ]),
            createBaseVNode("div", _hoisted_22$4, [
              _cache[28] || (_cache[28] = createBaseVNode("span", { class: "info-label" }, "Nuvu Backend:", -1)),
              createBaseVNode("span", _hoisted_23$4, toDisplayString(comfyuiInfo.value.nuvuBackend || "Unknown"), 1)
            ]),
            createBaseVNode("div", _hoisted_24$3, [
              _cache[29] || (_cache[29] = createBaseVNode("span", { class: "info-label" }, "ComfyUI Frontend:", -1)),
              createBaseVNode("span", _hoisted_25$3, toDisplayString(comfyuiInfo.value.comfyuiFrontend || "Unknown"), 1)
            ]),
            createBaseVNode("div", _hoisted_26$3, [
              _cache[30] || (_cache[30] = createBaseVNode("span", { class: "info-label" }, "ComfyUI Backend:", -1)),
              createBaseVNode("span", _hoisted_27$3, toDisplayString(comfyuiInfo.value.comfyuiBackend || "0.0.0"), 1)
            ])
          ])) : (openBlock(), createElementBlock("div", _hoisted_28$3, "Unable to load ComfyUI info"))
        ]),
        createBaseVNode("div", _hoisted_29$3, [
          _cache[39] || (_cache[39] = createBaseVNode("h4", { class: "section-title" }, "System Information", -1)),
          unref(isLoadingVersions) ? (openBlock(), createElementBlock("div", _hoisted_30$3, "Loading system info...")) : systemInfo.value ? (openBlock(), createElementBlock("div", _hoisted_31$3, [
            createBaseVNode("div", _hoisted_32$3, [
              _cache[32] || (_cache[32] = createBaseVNode("span", { class: "info-label" }, "OS:", -1)),
              createBaseVNode("span", _hoisted_33$3, toDisplayString(systemInfo.value.os), 1)
            ]),
            createBaseVNode("div", _hoisted_34$3, [
              _cache[33] || (_cache[33] = createBaseVNode("span", { class: "info-label" }, "Python:", -1)),
              createBaseVNode("span", _hoisted_35$3, toDisplayString(systemInfo.value.python || "Unknown"), 1)
            ]),
            createBaseVNode("div", _hoisted_36$3, [
              _cache[34] || (_cache[34] = createBaseVNode("span", { class: "info-label" }, "PyTorch:", -1)),
              createBaseVNode("span", _hoisted_37$3, toDisplayString(systemInfo.value.torch || "Not installed"), 1)
            ]),
            createBaseVNode("div", _hoisted_38$3, [
              _cache[35] || (_cache[35] = createBaseVNode("span", { class: "info-label" }, "CUDA Driver:", -1)),
              createBaseVNode("span", _hoisted_39$3, toDisplayString(systemInfo.value.cudaDriver || "Not detected"), 1)
            ]),
            createBaseVNode("div", _hoisted_40$2, [
              _cache[36] || (_cache[36] = createBaseVNode("span", { class: "info-label" }, "GPU:", -1)),
              createBaseVNode("span", _hoisted_41$1, toDisplayString(systemInfo.value.gpuName || "Not detected"), 1)
            ]),
            createBaseVNode("div", _hoisted_42$1, [
              _cache[37] || (_cache[37] = createBaseVNode("span", { class: "info-label" }, "VRAM:", -1)),
              createBaseVNode("span", _hoisted_43$1, toDisplayString(systemInfo.value.gpuVram ? systemInfo.value.gpuVram + " GB" : "Not detected"), 1)
            ]),
            createBaseVNode("div", _hoisted_44$1, [
              _cache[38] || (_cache[38] = createBaseVNode("span", { class: "info-label" }, "RAM:", -1)),
              createBaseVNode("span", _hoisted_45$1, toDisplayString(systemInfo.value.ram ? systemInfo.value.ram + " GB" : "Not detected"), 1)
            ])
          ])) : (openBlock(), createElementBlock("div", _hoisted_46$1, "Unable to load system info"))
        ]),
        createBaseVNode("div", _hoisted_47$1, [
          _cache[43] || (_cache[43] = createBaseVNode("h4", { class: "section-title" }, "PyTorch Configuration", -1)),
          _cache[44] || (_cache[44] = createBaseVNode("p", { class: "section-description" }, "Switch PyTorch version and CUDA compatibility.", -1)),
          createBaseVNode("div", _hoisted_48$1, [
            !showPyTorchSwitcher.value ? (openBlock(), createElementBlock("div", _hoisted_49$1, [
              createBaseVNode("div", _hoisted_50$1, [
                _cache[40] || (_cache[40] = createBaseVNode("span", { class: "pytorch-label" }, "Current:", -1)),
                createBaseVNode("span", _hoisted_51$1, toDisplayString(systemInfo.value?.torch || "Not installed"), 1),
                systemInfo.value?.torchCuda ? (openBlock(), createElementBlock("span", _hoisted_52$1, "(CUDA " + toDisplayString(systemInfo.value.torchCuda) + ")", 1)) : createCommentVNode("", true)
              ]),
              createBaseVNode("button", {
                class: "nuvu-btn nuvu-btn-secondary package-btn",
                disabled: isInstallingPackage.value || isUpdating.value || isLoadingConfigs.value,
                onClick: _cache[4] || (_cache[4] = ($event) => showPyTorchSwitcher.value = true)
              }, " Change Version ", 8, _hoisted_53$1)
            ])) : (openBlock(), createElementBlock("div", _hoisted_54$1, [
              isLoadingConfigs.value ? (openBlock(), createElementBlock("div", _hoisted_55$1, "Loading available versions...")) : pytorchConfigs.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_56$1, [
                _cache[41] || (_cache[41] = createBaseVNode("label", null, "Select PyTorch Version", -1)),
                withDirectives(createBaseVNode("select", {
                  "onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => selectedPytorchConfig.value = $event),
                  class: "select-input"
                }, [
                  (openBlock(true), createElementBlock(Fragment, null, renderList(pytorchConfigs.value, (config) => {
                    return openBlock(), createElementBlock("option", {
                      key: config.id,
                      value: config.id
                    }, toDisplayString(config.label), 9, _hoisted_57$1);
                  }), 128))
                ], 512), [
                  [vModelSelect, selectedPytorchConfig.value]
                ])
              ])) : (openBlock(), createElementBlock("div", _hoisted_58$1, " No PyTorch configurations available. Please check your connection. ")),
              createBaseVNode("div", _hoisted_59$1, [
                createBaseVNode("button", {
                  class: "nuvu-btn nuvu-btn-primary package-btn",
                  disabled: isInstallingPackage.value || pytorchConfigs.value.length === 0,
                  onClick: installPyTorch
                }, toDisplayString(isInstallingPackage.value && installingPackageName.value === "PyTorch" ? "Installing..." : "Install PyTorch"), 9, _hoisted_60$1),
                createBaseVNode("button", {
                  class: "nuvu-btn nuvu-btn-secondary package-btn",
                  onClick: _cache[6] || (_cache[6] = ($event) => showPyTorchSwitcher.value = false)
                }, " Cancel ")
              ]),
              _cache[42] || (_cache[42] = createBaseVNode("p", { class: "form-note" }, " Note: This will reinstall all custom node dependencies after PyTorch installation. ", -1))
            ]))
          ])
        ]),
        createBaseVNode("div", _hoisted_61$1, [
          _cache[47] || (_cache[47] = createBaseVNode("h4", { class: "section-title" }, "Performance Packages", -1)),
          _cache[48] || (_cache[48] = createBaseVNode("p", { class: "section-description" }, "Install performance optimization packages.", -1)),
          createBaseVNode("div", _hoisted_62$1, [
            createBaseVNode("label", _hoisted_63$1, [
              createBaseVNode("input", {
                type: "checkbox",
                checked: useCkAttention.value,
                disabled: isSavingCkPreference.value || isInstallingPackage.value || isUpdating.value,
                onChange: toggleCkAttention
              }, null, 40, _hoisted_64$1),
              createBaseVNode("span", _hoisted_65$1, toDisplayString(isSavingCkPreference.value ? "Saving..." : "Use Comfy Kitchen attention on startup"), 1)
            ]),
            _cache[45] || (_cache[45] = createBaseVNode("span", { class: "toggle-hint" }, " When enabled, ComfyUI starts with the --use-ck-attention flag. Cannot be combined with SageAttention. ", -1))
          ]),
          unref(isLoadingVersions) ? (openBlock(), createElementBlock("div", _hoisted_66$1, "Loading packages...")) : packages.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_67$1, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(packages.value, (pkg) => {
              return openBlock(), createElementBlock("div", {
                key: pkg.id,
                class: "package-card"
              }, [
                createBaseVNode("div", _hoisted_68$1, [
                  createBaseVNode("div", _hoisted_69$1, toDisplayString(pkg.name), 1),
                  createBaseVNode("div", _hoisted_70$1, toDisplayString(pkg.description), 1),
                  createBaseVNode("div", _hoisted_71$1, [
                    pkg.installed ? (openBlock(), createElementBlock("span", _hoisted_72$1, " v" + toDisplayString(pkg.version), 1)) : (openBlock(), createElementBlock("span", _hoisted_73$1, " Not installed ")),
                    pkg.requiresTorchMatch && !pkg.installed ? (openBlock(), createElementBlock("span", {
                      key: 2,
                      class: normalizeClass(["version-badge", pkg.installConfig ? "compatible" : "unavailable"]),
                      title: pkg.compatibilityMessage
                    }, toDisplayString(pkg.installConfig ? `Will install v${pkg.compatibleVersion}` : "No compatible build"), 11, _hoisted_74$1)) : createCommentVNode("", true),
                    needsUpdate(pkg) ? (openBlock(), createElementBlock("span", _hoisted_75$1, " v" + toDisplayString(pkg.latestVersion) + " available ", 1)) : createCommentVNode("", true)
                  ]),
                  pkg.id === "sageattention" && pkg.installed ? (openBlock(), createElementBlock("div", _hoisted_76$1, [
                    createBaseVNode("label", _hoisted_77$1, [
                      createBaseVNode("input", {
                        type: "checkbox",
                        checked: useSageAttention.value,
                        disabled: isSavingSagePreference.value || isInstallingPackage.value || isUpdating.value,
                        onChange: toggleSageAttention
                      }, null, 40, _hoisted_78$1),
                      createBaseVNode("span", _hoisted_79$1, toDisplayString(isSavingSagePreference.value ? "Saving..." : "Use SageAttention on startup"), 1)
                    ]),
                    _cache[46] || (_cache[46] = createBaseVNode("span", { class: "toggle-hint" }, " When enabled, ComfyUI will start with the --use-sage-attention flag ", -1))
                  ])) : createCommentVNode("", true)
                ]),
                createBaseVNode("div", _hoisted_80$1, [
                  createBaseVNode("button", {
                    class: normalizeClass(["nuvu-btn package-btn", isButtonDisabled(pkg) ? "nuvu-btn-disabled" : "nuvu-btn-primary"]),
                    disabled: isButtonDisabled(pkg),
                    title: pkg.requiresTorchMatch && !pkg.installConfig ? pkg.compatibilityMessage : "",
                    onClick: ($event) => installPackage(pkg, pkg.installConfig || {})
                  }, toDisplayString(getPackageButtonText(pkg)), 11, _hoisted_81$1),
                  pkg.installed ? (openBlock(), createElementBlock("button", {
                    key: 0,
                    class: "nuvu-btn package-btn nuvu-btn-danger",
                    disabled: !canUninstall(pkg),
                    onClick: ($event) => uninstallPackage(pkg)
                  }, " Uninstall ", 8, _hoisted_82$1)) : createCommentVNode("", true)
                ])
              ]);
            }), 128))
          ])) : (openBlock(), createElementBlock("div", _hoisted_83$1, "No packages available"))
        ]),
        createBaseVNode("div", _hoisted_84$1, [
          _cache[51] || (_cache[51] = createBaseVNode("h4", { class: "section-title" }, "Python Environment Manager", -1)),
          _cache[52] || (_cache[52] = createBaseVNode("p", { class: "section-description" }, "View, install, and manage Python packages in your environment.", -1)),
          createBaseVNode("div", _hoisted_85$1, [
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-secondary python-env-btn",
              disabled: isInstallingPackage.value || isUpdating.value,
              onClick: _cache[7] || (_cache[7] = ($event) => showPipPackagesModal.value = true),
              title: "View and switch versions of installed packages"
            }, " View Installed Packages ", 8, _hoisted_86$1),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-secondary python-env-btn",
              disabled: isInstallingPackage.value || isUpdating.value || isInstallingCustomPackage.value,
              onClick: _cache[8] || (_cache[8] = ($event) => showInstallPackageDialog.value = true),
              title: "Install a new Python package"
            }, " Install Package ", 8, _hoisted_87$1)
          ]),
          showInstallPackageDialog.value ? (openBlock(), createElementBlock("div", _hoisted_88$1, [
            createBaseVNode("div", _hoisted_89$1, [
              _cache[49] || (_cache[49] = createBaseVNode("span", null, "Install Python Package", -1)),
              createBaseVNode("button", {
                class: "close-icon",
                onClick: _cache[9] || (_cache[9] = ($event) => {
                  showInstallPackageDialog.value = false;
                  installPackageInput.value = "";
                })
              }, "×")
            ]),
            createBaseVNode("div", _hoisted_90$1, [
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[10] || (_cache[10] = ($event) => installPackageInput.value = $event),
                type: "text",
                class: "install-package-input",
                placeholder: "e.g., numpy, numpy==1.24.0, or https://...whl",
                onKeyup: withKeys(installCustomPackage, ["enter"]),
                disabled: isInstallingCustomPackage.value
              }, null, 40, _hoisted_91$1), [
                [vModelText, installPackageInput.value]
              ]),
              createBaseVNode("button", {
                class: "nuvu-btn nuvu-btn-primary",
                disabled: !installPackageInput.value.trim() || isInstallingCustomPackage.value,
                onClick: installCustomPackage
              }, toDisplayString(isInstallingCustomPackage.value ? "Installing..." : "Install"), 9, _hoisted_92$1)
            ]),
            _cache[50] || (_cache[50] = createBaseVNode("p", { class: "install-package-hint" }, "Package name, package==version, wheel URL, or git+https://...", -1))
          ])) : createCommentVNode("", true)
        ]),
        createBaseVNode("div", _hoisted_93$1, [
          _cache[62] || (_cache[62] = createBaseVNode("h4", { class: "section-title" }, "Download Bandwidth", -1)),
          _cache[63] || (_cache[63] = createBaseVNode("p", { class: "section-description" }, " Model downloads use your whole internet connection by default for fast downloads. If you would like to throttle the speed so you can continue to use the internet while models install, use the interface below. ", -1)),
          createBaseVNode("div", _hoisted_94$1, [
            aria2.value.installed ? (openBlock(), createElementBlock("span", _hoisted_95$1, [
              _cache[53] || (_cache[53] = createTextVNode(" Fast downloader ready ", -1)),
              createBaseVNode("span", _hoisted_96$1, "(aria2 v" + toDisplayString(aria2.value.version || "?") + ")", 1)
            ])) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [
              _cache[55] || (_cache[55] = createBaseVNode("span", { class: "aria2-missing" }, " Fast downloader not installed - the speed limit needs aria2. ", -1)),
              aria2.value.can_autofetch ? (openBlock(), createElementBlock("button", {
                key: 0,
                class: "nuvu-btn nuvu-btn-primary",
                disabled: isInstallingAria2.value,
                onClick: downloadAria2
              }, toDisplayString(isInstallingAria2.value ? "Downloading..." : "Download aria2"), 9, _hoisted_97$1)) : aria2.value.install_hint ? (openBlock(), createElementBlock("span", _hoisted_98$1, [
                _cache[54] || (_cache[54] = createTextVNode(" Install it with: ", -1)),
                createBaseVNode("code", null, toDisplayString(aria2.value.install_hint), 1)
              ])) : createCommentVNode("", true)
            ], 64))
          ]),
          createBaseVNode("div", _hoisted_99$1, [
            createBaseVNode("label", _hoisted_100$1, [
              withDirectives(createBaseVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[11] || (_cache[11] = ($event) => limitDownloadSpeed.value = $event),
                disabled: isSavingDownloadLimit.value || !aria2.value.installed
              }, null, 8, _hoisted_101$1), [
                [vModelCheckbox, limitDownloadSpeed.value]
              ]),
              _cache[56] || (_cache[56] = createBaseVNode("span", { class: "toggle-text" }, "Limit model download speed", -1))
            ]),
            createBaseVNode("div", _hoisted_102$1, [
              createBaseVNode("button", {
                class: normalizeClass(["nuvu-btn python-env-btn", measuredMbps.value ? "nuvu-btn-secondary" : "nuvu-btn-primary"]),
                disabled: isMeasuringSpeed.value || isSavingDownloadLimit.value,
                onClick: measureDownloadSpeed
              }, toDisplayString(isMeasuringSpeed.value ? "Measuring..." : measuredMbps.value ? "Re-measure" : "Measure my speed"), 11, _hoisted_103$1),
              measuredMbps.value ? (openBlock(), createElementBlock("span", _hoisted_104$1, [
                _cache[57] || (_cache[57] = createTextVNode(" Your connection: ", -1)),
                createBaseVNode("strong", null, toDisplayString(measuredMbps.value) + " MB/s", 1)
              ])) : createCommentVNode("", true)
            ]),
            limitDownloadSpeed.value && measuredMbps.value ? (openBlock(), createElementBlock("div", _hoisted_105$1, [
              _cache[58] || (_cache[58] = createBaseVNode("label", {
                class: "share-label",
                for: "dl-share"
              }, "Use at most", -1)),
              withDirectives(createBaseVNode("input", {
                id: "dl-share",
                type: "range",
                min: "10",
                max: "100",
                step: "5",
                "onUpdate:modelValue": _cache[12] || (_cache[12] = ($event) => downloadSharePercent.value = $event),
                disabled: isSavingDownloadLimit.value,
                class: "share-slider"
              }, null, 8, _hoisted_106$1), [
                [
                  vModelText,
                  downloadSharePercent.value,
                  void 0,
                  { number: true }
                ]
              ]),
              createBaseVNode("span", _hoisted_107$1, [
                createBaseVNode("strong", null, toDisplayString(downloadSharePercent.value) + "%", 1),
                createTextVNode(" = " + toDisplayString(effectiveLimitMbps.value) + " MB/s ", 1),
                createBaseVNode("span", _hoisted_108$1, "(~" + toDisplayString(toMbit(effectiveLimitMbps.value)) + " Mbit/s in Task Manager)", 1)
              ])
            ])) : limitDownloadSpeed.value && maxDownloadMbps.value ? (openBlock(), createElementBlock("p", _hoisted_109$1, [
              _cache[59] || (_cache[59] = createTextVNode(" Currently limited to ", -1)),
              createBaseVNode("strong", null, toDisplayString(maxDownloadMbps.value) + " MB/s", 1),
              createBaseVNode("span", _hoisted_110$1, "(~" + toDisplayString(toMbit(maxDownloadMbps.value)) + " Mbit/s in Task Manager)", 1),
              _cache[60] || (_cache[60] = createTextVNode(". Measure to change it as a share of your connection. ", -1))
            ])) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_111$1, [
              createBaseVNode("button", {
                class: "nuvu-btn nuvu-btn-primary python-env-btn",
                disabled: isSavingDownloadLimit.value,
                onClick: saveDownloadLimit
              }, toDisplayString(isSavingDownloadLimit.value ? "Saving..." : "Save"), 9, _hoisted_112$1)
            ]),
            _cache[61] || (_cache[61] = createBaseVNode("p", { class: "bandwidth-hint" }, " Measure first, then choose how much of your connection downloads may use. Unchecked uses all of it. Applies to the next model download; no restart needed. ", -1)),
            downloadLimitNotice.value ? (openBlock(), createElementBlock("p", _hoisted_113$1, toDisplayString(downloadLimitNotice.value), 1)) : createCommentVNode("", true)
          ])
        ]),
        createBaseVNode("div", _hoisted_114$1, [
          _cache[67] || (_cache[67] = createBaseVNode("h4", { class: "section-title" }, "Advanced Tools", -1)),
          _cache[68] || (_cache[68] = createBaseVNode("p", { class: "section-description" }, "CUDA toolkit and build tools for compilation.", -1)),
          advancedTools.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_115$1, [
            (openBlock(true), createElementBlock(Fragment, null, renderList(advancedTools.value, (tool) => {
              return openBlock(), createElementBlock("div", {
                key: tool.id,
                class: "package-card"
              }, [
                createBaseVNode("div", _hoisted_116$1, [
                  createBaseVNode("div", _hoisted_117$1, [
                    createBaseVNode("div", _hoisted_118$1, toDisplayString(tool.name), 1),
                    createBaseVNode("button", {
                      class: normalizeClass(["nuvu-btn package-btn", isButtonDisabled(tool) ? "nuvu-btn-disabled" : "nuvu-btn-primary"]),
                      disabled: isButtonDisabled(tool),
                      onClick: ($event) => tool.id === "cuda-toolkit" ? installCudaToolkit(tool) : installPackage(tool, tool.installConfig || {})
                    }, toDisplayString(tool.id === "cuda-toolkit" ? getCudaToolkitButtonText(tool) : getPackageButtonText(tool)), 11, _hoisted_119$1)
                  ]),
                  createBaseVNode("div", _hoisted_120$1, toDisplayString(tool.description), 1),
                  createBaseVNode("div", _hoisted_121$1, [
                    tool.installed ? (openBlock(), createElementBlock("span", _hoisted_122$1, toDisplayString(tool.version ? `v${tool.version}` : "Installed"), 1)) : (openBlock(), createElementBlock("span", _hoisted_123$1, " Not installed "))
                  ]),
                  tool.id === "cuda-toolkit" ? (openBlock(), createElementBlock("div", _hoisted_124$1, [
                    createBaseVNode("div", _hoisted_125$1, [
                      _cache[65] || (_cache[65] = createBaseVNode("label", { class: "cuda-config-label" }, "CUDA version", -1)),
                      withDirectives(createBaseVNode("select", {
                        "onUpdate:modelValue": _cache[13] || (_cache[13] = ($event) => cudaToolkitMode.value = $event),
                        class: "select-input cuda-config-select"
                      }, [
                        createBaseVNode("option", _hoisted_126, "Match PyTorch (" + toDisplayString(detectedPytorchCudaVersion.value || "not detected") + ")", 1),
                        _cache[64] || (_cache[64] = createBaseVNode("option", { value: "manual" }, "Enter manually", -1))
                      ], 512), [
                        [vModelSelect, cudaToolkitMode.value]
                      ])
                    ]),
                    cudaToolkitMode.value === "manual" ? (openBlock(), createElementBlock("div", _hoisted_127, [
                      _cache[66] || (_cache[66] = createBaseVNode("label", { class: "cuda-config-label" }, "Target", -1)),
                      withDirectives(createBaseVNode("input", {
                        "onUpdate:modelValue": _cache[14] || (_cache[14] = ($event) => cudaToolkitManualVersion.value = $event),
                        type: "text",
                        class: "select-input cuda-config-input",
                        placeholder: "e.g., 12.8"
                      }, null, 512), [
                        [vModelText, cudaToolkitManualVersion.value]
                      ])
                    ])) : !detectedPytorchCudaVersion.value ? (openBlock(), createElementBlock("div", _hoisted_128, " PyTorch CUDA version could not be detected. Choose manual and enter a version. ")) : createCommentVNode("", true)
                  ])) : createCommentVNode("", true)
                ])
              ]);
            }), 128))
          ])) : createCommentVNode("", true),
          isWindows.value ? (openBlock(), createElementBlock("div", _hoisted_129, [
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-secondary build-shell-btn",
              disabled: isInstallingPackage.value || isUpdating.value || !unref(versions)?.vs_build_tools?.installed,
              onClick: openBuildShell,
              title: !unref(versions)?.vs_build_tools?.installed ? "Install VS Build Tools first" : "Open developer command prompt"
            }, " Open Build Tools Shell ", 8, _hoisted_130),
            !unref(versions)?.vs_build_tools?.installed ? (openBlock(), createElementBlock("span", _hoisted_131, " Install VS Build Tools first ")) : createCommentVNode("", true)
          ])) : createCommentVNode("", true)
        ]),
        showPipPackagesModal.value ? (openBlock(), createBlock(PipPackagesModal, {
          key: 0,
          onClose: _cache[15] || (_cache[15] = ($event) => showPipPackagesModal.value = false),
          onPackageSwitched: handlePackageSwitched
        })) : createCommentVNode("", true),
        showRestartModal.value ? (openBlock(), createBlock(RestartPromptModal, {
          key: 1,
          notice: restartNotice.value,
          noticeType: restartNoticeType.value,
          onClose: closeRestartModal
        }, null, 8, ["notice", "noticeType"])) : createCommentVNode("", true),
        showErrorModal.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 2,
          title: "Installation Error",
          message: errorModalMessage.value,
          confirmText: "OK",
          cancelText: "",
          onConfirm: _cache[16] || (_cache[16] = ($event) => showErrorModal.value = false),
          onCancel: _cache[17] || (_cache[17] = ($event) => showErrorModal.value = false)
        }, null, 8, ["message"])) : createCommentVNode("", true),
        activeChangelog.value ? (openBlock(), createBlock(ChangelogModal, {
          key: 3,
          "repo-type": activeChangelog.value.type,
          title: activeChangelog.value.title,
          current: activeChangelog.value.current,
          onClose: _cache[18] || (_cache[18] = ($event) => activeChangelog.value = null),
          onSwitched: handleVersionSwitch
        }, null, 8, ["repo-type", "title", "current"])) : createCommentVNode("", true)
      ]);
    };
  }
};
const OptimizerPanel = /* @__PURE__ */ _export_sfc(_sfc_main$8, [["__scopeId", "data-v-a5b58492"]]);
const _hoisted_1$6 = { class: "user-config-panel" };
const _hoisted_2$6 = { class: "config-section" };
const _hoisted_3$5 = {
  key: 0,
  class: "floating-license-note"
};
const _hoisted_4$5 = { class: "device-form" };
const _hoisted_5$5 = ["disabled"];
const _hoisted_6$5 = ["disabled"];
const _hoisted_7$5 = {
  key: 1,
  class: "replace-dialog-overlay"
};
const _hoisted_8$5 = { class: "replace-dialog" };
const _hoisted_9$4 = { class: "replace-device-list" };
const _hoisted_10$4 = ["onClick"];
const _hoisted_11$4 = { class: "replace-device-name" };
const _hoisted_12$4 = { class: "replace-device-info" };
const _hoisted_13$3 = { key: 0 };
const _hoisted_14$3 = {
  key: 1,
  class: "replace-device-date"
};
const _hoisted_15$3 = {
  key: 2,
  class: "replace-dialog-overlay"
};
const _hoisted_16$3 = { class: "replace-dialog permission-error-dialog" };
const _hoisted_17$3 = { class: "permission-error-message" };
const _hoisted_18$3 = {
  key: 0,
  class: "message error"
};
const _hoisted_19$3 = {
  key: 0,
  class: "message success"
};
const _hoisted_20$3 = { class: "device-list" };
const _hoisted_21$3 = {
  key: 0,
  class: "loading"
};
const _hoisted_22$3 = {
  key: 1,
  class: "empty"
};
const _hoisted_23$3 = { class: "device-header" };
const _hoisted_24$2 = { class: "device-name" };
const _hoisted_25$2 = { class: "device-header-actions" };
const _hoisted_26$2 = {
  key: 0,
  class: "current-badge"
};
const _hoisted_27$2 = ["disabled", "onClick"];
const _hoisted_28$2 = {
  key: 0,
  width: "14",
  height: "14",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  class: "spin"
};
const _hoisted_29$2 = {
  key: 1,
  width: "14",
  height: "14",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_30$2 = { class: "device-info" };
const _hoisted_31$2 = { key: 0 };
const _hoisted_32$2 = {
  key: 1,
  class: "device-date"
};
const _hoisted_33$2 = { class: "config-section" };
const _hoisted_34$2 = { class: "token-form" };
const _hoisted_35$2 = { class: "token-input-group" };
const _hoisted_36$2 = ["type"];
const _hoisted_37$2 = ["title"];
const _hoisted_38$2 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_39$2 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_40$1 = ["disabled"];
const _hoisted_41 = ["disabled"];
const _hoisted_42 = {
  key: 0,
  class: "message success"
};
const _hoisted_43 = {
  key: 0,
  class: "message error"
};
const _hoisted_44 = { class: "config-section" };
const _hoisted_45 = { class: "token-form" };
const _hoisted_46 = { class: "token-input-group" };
const _hoisted_47 = ["type"];
const _hoisted_48 = ["title"];
const _hoisted_49 = {
  key: 0,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_50 = {
  key: 1,
  width: "18",
  height: "18",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_51 = ["disabled"];
const _hoisted_52 = ["disabled"];
const _hoisted_53 = {
  key: 0,
  class: "message success"
};
const _hoisted_54 = {
  key: 0,
  class: "message error"
};
const _hoisted_55 = { class: "config-section" };
const _hoisted_56 = { class: "path-form" };
const _hoisted_57 = ["disabled"];
const _hoisted_58 = ["disabled"];
const _hoisted_59 = { class: "install-location-section" };
const _hoisted_60 = ["checked", "disabled"];
const _hoisted_61 = {
  key: 0,
  class: "install-badge"
};
const _hoisted_62 = ["onClick"];
const _hoisted_63 = ["checked", "disabled", "onChange"];
const _hoisted_64 = { class: "path-text" };
const _hoisted_65 = {
  key: 0,
  class: "install-badge"
};
const _hoisted_66 = ["onClick"];
const _hoisted_67 = {
  key: 0,
  class: "message error"
};
const _hoisted_68 = {
  key: 0,
  class: "message success"
};
const _hoisted_69 = { class: "config-section" };
const _hoisted_70 = { class: "path-form" };
const _hoisted_71 = ["disabled"];
const _hoisted_72 = ["disabled"];
const _hoisted_73 = { class: "install-location-section" };
const _hoisted_74 = ["checked", "disabled"];
const _hoisted_75 = {
  key: 0,
  class: "install-badge"
};
const _hoisted_76 = ["onClick"];
const _hoisted_77 = ["checked", "disabled", "onChange"];
const _hoisted_78 = { class: "path-text" };
const _hoisted_79 = {
  key: 0,
  class: "install-badge"
};
const _hoisted_80 = ["onClick"];
const _hoisted_81 = {
  key: 0,
  class: "message error"
};
const _hoisted_82 = {
  key: 0,
  class: "message success"
};
const _hoisted_83 = { class: "config-section" };
const _hoisted_84 = { class: "comfy-settings-grid" };
const _hoisted_85 = { class: "setting-row" };
const _hoisted_86 = ["disabled"];
const _hoisted_87 = { class: "setting-row" };
const _hoisted_88 = ["disabled"];
const _hoisted_89 = { class: "setting-row" };
const _hoisted_90 = ["disabled"];
const _hoisted_91 = {
  key: 0,
  class: "setting-row"
};
const _hoisted_92 = ["disabled"];
const _hoisted_93 = { class: "setting-row" };
const _hoisted_94 = ["disabled"];
const _hoisted_95 = { class: "setting-row" };
const _hoisted_96 = ["disabled"];
const _hoisted_97 = { class: "setting-row" };
const _hoisted_98 = ["disabled"];
const _hoisted_99 = { class: "setting-row" };
const _hoisted_100 = ["disabled"];
const _hoisted_101 = ["disabled"];
const _hoisted_102 = {
  key: 0,
  class: "message error"
};
const _hoisted_103 = {
  key: 0,
  class: "message success"
};
const _hoisted_104 = {
  key: 0,
  class: "config-section affiliate-section"
};
const _hoisted_105 = { class: "section-description" };
const _hoisted_106 = {
  key: 0,
  class: "affiliate-stats"
};
const _hoisted_107 = { class: "stat-card" };
const _hoisted_108 = { class: "stat-value" };
const _hoisted_109 = { class: "stat-card" };
const _hoisted_110 = { class: "stat-value" };
const _hoisted_111 = { class: "stat-card" };
const _hoisted_112 = { class: "stat-value" };
const _hoisted_113 = { class: "stat-card" };
const _hoisted_114 = { class: "stat-value" };
const _hoisted_115 = { class: "affiliate-form" };
const _hoisted_116 = ["value"];
const _hoisted_117 = {
  key: 1,
  class: "affiliate-payout"
};
const _hoisted_118 = { class: "payout-info" };
const _hoisted_119 = { class: "payout-row" };
const _hoisted_120 = { class: "payout-value" };
const _hoisted_121 = { class: "payout-row" };
const _hoisted_122 = { class: "payout-value pending" };
const _hoisted_123 = {
  key: 0,
  class: "auto-payout-badge"
};
const _hoisted_124 = {
  key: 2,
  class: "affiliate-pending"
};
const _hoisted_125 = {
  key: 1,
  class: "loading-affiliate"
};
const _sfc_main$7 = {
  __name: "UserConfigPanel",
  emits: ["device-changed"],
  setup(__props, { emit: __emit }) {
    const emit2 = __emit;
    const hfToken = /* @__PURE__ */ ref("");
    const showHfToken = /* @__PURE__ */ ref(false);
    const hfTokenSaved = /* @__PURE__ */ ref(false);
    const hfTokenError = /* @__PURE__ */ ref("");
    const civitaiToken = /* @__PURE__ */ ref("");
    const showCivitaiToken = /* @__PURE__ */ ref(false);
    const civitaiTokenSaved = /* @__PURE__ */ ref(false);
    const civitaiTokenError = /* @__PURE__ */ ref("");
    const affiliateData = /* @__PURE__ */ ref(null);
    const affiliateCopied = /* @__PURE__ */ ref(false);
    const isLoadingAffiliate = /* @__PURE__ */ ref(false);
    const devices = /* @__PURE__ */ ref([]);
    const isLoadingDevices = /* @__PURE__ */ ref(false);
    const isRegisteringDevice = /* @__PURE__ */ ref(false);
    const deviceLabel = /* @__PURE__ */ ref("");
    const deviceError = /* @__PURE__ */ ref("");
    const deviceSuccess = /* @__PURE__ */ ref("");
    const currentDeviceId = /* @__PURE__ */ ref("");
    const removingDeviceId = /* @__PURE__ */ ref(null);
    const showReplaceDialog = /* @__PURE__ */ ref(false);
    const devicesToReplace = /* @__PURE__ */ ref([]);
    const pendingDeviceLabel = /* @__PURE__ */ ref("");
    const extraModelPaths = /* @__PURE__ */ ref([]);
    const newModelPath = /* @__PURE__ */ ref("");
    const isLoadingConfig = /* @__PURE__ */ ref(false);
    const isSavingConfig = /* @__PURE__ */ ref(false);
    const configError = /* @__PURE__ */ ref("");
    const configSuccess = /* @__PURE__ */ ref("");
    const selectedInstallPathIndex = /* @__PURE__ */ ref(-1);
    const extraCustomNodesPaths = /* @__PURE__ */ ref([]);
    const newCustomNodesPath = /* @__PURE__ */ ref("");
    const selectedCustomNodesPathIndex = /* @__PURE__ */ ref(-1);
    const customNodesError = /* @__PURE__ */ ref("");
    const customNodesSuccess = /* @__PURE__ */ ref("");
    const vramMode = /* @__PURE__ */ ref("ignore");
    const previewMethod = /* @__PURE__ */ ref("auto");
    const cacheMode = /* @__PURE__ */ ref("ignore");
    const cacheLruSize = /* @__PURE__ */ ref(64);
    const cudaDevice = /* @__PURE__ */ ref("");
    const reserveVram = /* @__PURE__ */ ref("");
    const outputDirectory = /* @__PURE__ */ ref("");
    const inputDirectory = /* @__PURE__ */ ref("");
    const comfySettingsError = /* @__PURE__ */ ref("");
    const comfySettingsSuccess = /* @__PURE__ */ ref("");
    const isSavingComfySettings = /* @__PURE__ */ ref(false);
    const showPermissionErrorModal = /* @__PURE__ */ ref(false);
    const permissionErrorMessage = /* @__PURE__ */ ref("");
    const isSavingModelPaths = isSavingConfig;
    const modelPathsError = configError;
    const modelPathsSuccess = configSuccess;
    const isSavingHfToken = /* @__PURE__ */ ref(false);
    const isSavingCivitaiToken = /* @__PURE__ */ ref(false);
    const affiliateLink = computed(() => {
      if (!affiliateData.value?.affiliateCode) return "";
      return `https://app.nuvulabs.ai/?ref=${affiliateData.value.affiliateCode}`;
    });
    const isAffiliate = computed(() => {
      return affiliateData.value !== null && affiliateData.value?.affiliateCode;
    });
    const hasFloatingLicense = computed(() => {
      const licenseStatus = currentLicenseStatus;
      return licenseStatus?.license_type === "floating";
    });
    const isCurrentDevice = (device) => {
      const deviceId = device?.id || device?.deviceId || device?.device_id || "";
      const fingerprint = device?.fingerprint_hash || device?.fingerprintHash || device?.fingerprint || "";
      return deviceId === currentDeviceId.value || fingerprint === currentDeviceId.value;
    };
    function getAuthHeaders2() {
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentUser?.apiToken || ""}`,
        "X-User-Email": currentUser?.email || "",
        "X-User-Id": currentUser?.id || ""
      };
    }
    function setGlobalHfToken(token) {
      if (typeof setHfToken === "function") {
        setHfToken(token || "");
      }
      try {
        window.dispatchEvent(new CustomEvent("nuvu:hf-token-updated", { detail: token || "" }));
      } catch {
      }
    }
    async function loadUserData() {
      try {
        const deviceResp = await fetch("/nuvu/device/identity");
        if (deviceResp.ok) {
          const identity = await deviceResp.json();
          currentDeviceId.value = identity.fingerprint_hash || "";
        }
      } catch (error) {
        console.error("[nuvu] Failed to load user data:", error);
      }
    }
    async function loadAffiliateData() {
      isLoadingAffiliate.value = true;
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/affiliates/me", { headers });
        if (response.ok) {
          const data = await response.json();
          affiliateData.value = data.affiliate || null;
        } else {
          affiliateData.value = null;
        }
      } catch (error) {
        console.error("[nuvu] Failed to load affiliate data:", error);
        affiliateData.value = null;
      } finally {
        isLoadingAffiliate.value = false;
      }
    }
    async function loadDevices() {
      isLoadingDevices.value = true;
      deviceError.value = "";
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/device/registrations", { headers });
        if (response.ok) {
          const data = await response.json();
          devices.value = data.devices || data || [];
        } else {
          const err = await response.json();
          deviceError.value = err.error || "Failed to load devices";
        }
      } catch (error) {
        console.error("[nuvu] Failed to load devices:", error);
        deviceError.value = "Failed to load devices";
      } finally {
        isLoadingDevices.value = false;
      }
    }
    async function registerDevice(replaceDeviceId = null) {
      if (!deviceLabel.value.trim()) {
        deviceError.value = "Please enter a device label";
        return;
      }
      isRegisteringDevice.value = true;
      deviceError.value = "";
      deviceSuccess.value = "";
      try {
        const headers = await getAuthHeaders2();
        const payload = { device_label: deviceLabel.value.trim() };
        if (replaceDeviceId) {
          payload.replace_device_id = replaceDeviceId;
        }
        const response = await fetch("/nuvu/device/register", {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.ok) {
          deviceSuccess.value = result.message || "Device registered successfully!";
          deviceLabel.value = "";
          pendingDeviceLabel.value = "";
          showReplaceDialog.value = false;
          await loadDevices();
          emit2("device-changed");
        } else if (result.error === "device_limit_reached" && result.registeredDevices) {
          pendingDeviceLabel.value = deviceLabel.value.trim();
          devicesToReplace.value = result.registeredDevices || [];
          showReplaceDialog.value = true;
        } else {
          deviceError.value = result.error || "Failed to register device";
        }
      } catch (error) {
        deviceError.value = "Failed to register device";
      } finally {
        isRegisteringDevice.value = false;
      }
    }
    function selectDeviceToReplace(deviceId) {
      showReplaceDialog.value = false;
      deviceLabel.value = pendingDeviceLabel.value;
      registerDevice(deviceId);
    }
    function cancelReplacement() {
      showReplaceDialog.value = false;
      pendingDeviceLabel.value = "";
      devicesToReplace.value = [];
    }
    async function removeDevice(device) {
      const deviceId = device?.id || device?.deviceId || device?.device_id;
      if (!deviceId) {
        deviceError.value = "Cannot remove device: missing device ID";
        return;
      }
      const deviceName = device.deviceLabel || device.label || device.name || "this device";
      if (!confirm(`Are you sure you want to remove "${deviceName}"? You can re-register it later.`)) {
        return;
      }
      removingDeviceId.value = deviceId;
      deviceError.value = "";
      deviceSuccess.value = "";
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch(`/nuvu/device/unregister/${deviceId}`, {
          method: "DELETE",
          headers
        });
        const result = await response.json();
        if (response.ok) {
          deviceSuccess.value = result.message || "Device removed successfully!";
          await loadDevices();
          emit2("device-changed");
        } else {
          deviceError.value = result.error || "Failed to remove device";
        }
      } catch (error) {
        deviceError.value = "Failed to remove device";
      } finally {
        removingDeviceId.value = null;
      }
    }
    async function loadUserConfig() {
      isLoadingConfig.value = true;
      modelPathsError.value = "";
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/user-config", { headers });
        if (response.ok) {
          const data = await response.json();
          extraModelPaths.value = data.extra_model_paths || [];
          hfToken.value = data.huggingface_token || localStorage.getItem("nuvu_hf_token") || "";
          civitaiToken.value = data.civitai_token || localStorage.getItem("nuvu_civitai_token") || "";
          const savedIndex = data.install_path_index;
          if (typeof savedIndex === "number" && savedIndex >= -1) {
            if (savedIndex === -1 || savedIndex < extraModelPaths.value.length) {
              selectedInstallPathIndex.value = savedIndex;
            } else {
              selectedInstallPathIndex.value = -1;
            }
          } else {
            selectedInstallPathIndex.value = -1;
          }
          extraCustomNodesPaths.value = data.extra_custom_nodes_paths || [];
          const savedCustomNodesIndex = data.custom_nodes_path_index;
          if (typeof savedCustomNodesIndex === "number" && savedCustomNodesIndex >= -1) {
            if (savedCustomNodesIndex === -1 || savedCustomNodesIndex < extraCustomNodesPaths.value.length) {
              selectedCustomNodesPathIndex.value = savedCustomNodesIndex;
            } else {
              selectedCustomNodesPathIndex.value = -1;
            }
          } else {
            selectedCustomNodesPathIndex.value = -1;
          }
          vramMode.value = data.vram_mode || "ignore";
          previewMethod.value = data.preview_method || "ignore";
          cacheMode.value = data.cache_mode || "ignore";
          cacheLruSize.value = data.cache_lru_size || 64;
          cudaDevice.value = data.cuda_device ?? "";
          reserveVram.value = data.reserve_vram ?? "";
          outputDirectory.value = data.output_directory || "";
          inputDirectory.value = data.input_directory || "";
          await setGlobalHfToken(hfToken.value.trim());
        }
      } catch (error) {
        console.error("[nuvu] Failed to load user config:", error);
        modelPathsError.value = "Failed to load configuration";
      } finally {
        isLoadingConfig.value = false;
      }
    }
    async function saveAllPathsConfig(section = "models") {
      isSavingConfig.value = true;
      if (section === "customNodes") {
        customNodesError.value = "";
        customNodesSuccess.value = "";
      } else {
        configError.value = "";
        configSuccess.value = "";
      }
      try {
        const headers = await getAuthHeaders2();
        const normalizedModelPaths = extraModelPaths.value.map((p2) => normalizePath(p2));
        const normalizedCustomNodesPaths = extraCustomNodesPaths.value.map((p2) => normalizePath(p2));
        const response = await fetch("/nuvu/user-config", {
          method: "POST",
          headers,
          body: JSON.stringify({
            extra_model_paths: normalizedModelPaths,
            huggingface_token: hfToken.value.trim(),
            civitai_token: civitaiToken.value.trim(),
            install_path_index: selectedInstallPathIndex.value,
            extra_custom_nodes_paths: normalizedCustomNodesPaths,
            custom_nodes_path_index: selectedCustomNodesPathIndex.value
          })
        });
        if (response.ok) {
          extraModelPaths.value = normalizedModelPaths;
          extraCustomNodesPaths.value = normalizedCustomNodesPaths;
          const successMsg = "Configuration saved! Restart ComfyUI to apply changes.";
          if (section === "customNodes") {
            customNodesSuccess.value = successMsg;
            setTimeout(() => {
              customNodesSuccess.value = "";
            }, 5e3);
          } else {
            configSuccess.value = successMsg;
            setTimeout(() => {
              configSuccess.value = "";
            }, 5e3);
          }
        } else {
          const err = await response.json();
          const errorMsg = err.error || "Failed to save configuration";
          if (errorMsg.toLowerCase().includes("permission") || errorMsg.toLowerCase().includes("cannot create")) {
            permissionErrorMessage.value = errorMsg;
            showPermissionErrorModal.value = true;
          } else {
            if (section === "customNodes") {
              customNodesError.value = errorMsg;
            } else {
              configError.value = errorMsg;
            }
          }
        }
      } catch (error) {
        console.error("[nuvu] Failed to save user config:", error);
        if (section === "customNodes") {
          customNodesError.value = "Failed to save configuration";
        } else {
          configError.value = "Failed to save configuration";
        }
      } finally {
        isSavingConfig.value = false;
      }
    }
    async function saveModelPathsToConfig() {
      await saveAllPathsConfig("models");
    }
    function normalizePath(path) {
      if (!path) return "";
      let normalized = path.replace(/\\/g, "/");
      normalized = normalized.replace(/([^:])\/+/g, "$1/");
      if (normalized.length > 1 && normalized.endsWith("/") && !normalized.endsWith(":/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized.trim();
    }
    async function addModelPath() {
      const rawPath = newModelPath.value.trim();
      if (!rawPath) return;
      const path = normalizePath(rawPath);
      const normalizedExisting = extraModelPaths.value.map((p2) => normalizePath(p2));
      if (normalizedExisting.includes(path)) {
        modelPathsError.value = "This path is already added";
        setTimeout(() => modelPathsError.value = "", 3e3);
        return;
      }
      extraModelPaths.value.push(path);
      newModelPath.value = "";
      await saveModelPathsToConfig();
    }
    async function removeModelPath(index) {
      extraModelPaths.value.splice(index, 1);
      if (selectedInstallPathIndex.value === index) {
        selectedInstallPathIndex.value = -1;
      } else if (selectedInstallPathIndex.value > index) {
        selectedInstallPathIndex.value--;
      }
      await saveModelPathsToConfig();
    }
    async function selectInstallPath(index) {
      selectedInstallPathIndex.value = index;
      await saveAllPathsConfig("models");
    }
    async function addCustomNodesPath() {
      const rawPath = newCustomNodesPath.value.trim();
      if (!rawPath) return;
      const path = normalizePath(rawPath);
      const normalizedExisting = extraCustomNodesPaths.value.map((p2) => normalizePath(p2));
      if (normalizedExisting.includes(path)) {
        customNodesError.value = "This path is already added";
        setTimeout(() => customNodesError.value = "", 3e3);
        return;
      }
      extraCustomNodesPaths.value.push(path);
      newCustomNodesPath.value = "";
      await saveAllPathsConfig("customNodes");
    }
    async function removeCustomNodesPath(index) {
      extraCustomNodesPaths.value.splice(index, 1);
      if (selectedCustomNodesPathIndex.value === index) {
        selectedCustomNodesPathIndex.value = -1;
      } else if (selectedCustomNodesPathIndex.value > index) {
        selectedCustomNodesPathIndex.value--;
      }
      await saveAllPathsConfig("customNodes");
    }
    async function selectCustomNodesPath(index) {
      selectedCustomNodesPathIndex.value = index;
      await saveAllPathsConfig("customNodes");
    }
    async function saveComfySettings() {
      isSavingComfySettings.value = true;
      comfySettingsError.value = "";
      comfySettingsSuccess.value = "";
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/user-config", {
          method: "POST",
          headers,
          body: JSON.stringify({
            comfy_settings_only: true,
            vram_mode: vramMode.value,
            preview_method: previewMethod.value,
            cache_mode: cacheMode.value,
            cache_lru_size: cacheLruSize.value,
            cuda_device: cudaDevice.value,
            reserve_vram: reserveVram.value,
            output_directory: normalizePath(outputDirectory.value),
            input_directory: normalizePath(inputDirectory.value)
          })
        });
        if (response.ok) {
          comfySettingsSuccess.value = "Settings saved! Restart ComfyUI to apply changes.";
          setTimeout(() => {
            comfySettingsSuccess.value = "";
          }, 5e3);
        } else {
          const err = await response.json();
          comfySettingsError.value = err.error || "Failed to save settings";
        }
      } catch (error) {
        console.error("[nuvu] Failed to save Comfy settings:", error);
        comfySettingsError.value = "Failed to save settings";
      } finally {
        isSavingComfySettings.value = false;
      }
    }
    async function saveHfTokenToConfig() {
      isSavingHfToken.value = true;
      hfTokenError.value = "";
      hfTokenSaved.value = false;
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/user-config", {
          method: "POST",
          headers,
          body: JSON.stringify({
            extra_model_paths: extraModelPaths.value,
            huggingface_token: hfToken.value.trim(),
            civitai_token: civitaiToken.value.trim(),
            install_path_index: selectedInstallPathIndex.value,
            extra_custom_nodes_paths: extraCustomNodesPaths.value,
            custom_nodes_path_index: selectedCustomNodesPathIndex.value
          })
        });
        if (response.ok) {
          const trimmed = hfToken.value.trim();
          if (trimmed) {
            localStorage.setItem("nuvu_hf_token", trimmed);
          } else {
            localStorage.removeItem("nuvu_hf_token");
          }
          await setGlobalHfToken(trimmed);
          hfTokenSaved.value = true;
          setTimeout(() => {
            hfTokenSaved.value = false;
          }, 3e3);
        } else {
          const err = await response.json();
          hfTokenError.value = err.error || "Failed to save token";
        }
      } catch (error) {
        console.error("[nuvu] Failed to save HF token:", error);
        hfTokenError.value = "Failed to save token";
      } finally {
        isSavingHfToken.value = false;
      }
    }
    async function clearHfToken() {
      hfToken.value = "";
      await saveHfTokenToConfig();
    }
    async function saveCivitaiTokenToConfig() {
      isSavingCivitaiToken.value = true;
      civitaiTokenError.value = "";
      civitaiTokenSaved.value = false;
      try {
        const headers = await getAuthHeaders2();
        const response = await fetch("/nuvu/user-config", {
          method: "POST",
          headers,
          body: JSON.stringify({
            extra_model_paths: extraModelPaths.value,
            huggingface_token: hfToken.value.trim(),
            civitai_token: civitaiToken.value.trim(),
            install_path_index: selectedInstallPathIndex.value,
            extra_custom_nodes_paths: extraCustomNodesPaths.value,
            custom_nodes_path_index: selectedCustomNodesPathIndex.value
          })
        });
        if (response.ok) {
          const trimmed = civitaiToken.value.trim();
          if (trimmed) {
            localStorage.setItem("nuvu_civitai_token", trimmed);
          } else {
            localStorage.removeItem("nuvu_civitai_token");
          }
          civitaiTokenSaved.value = true;
          setTimeout(() => {
            civitaiTokenSaved.value = false;
          }, 3e3);
        } else {
          const err = await response.json();
          civitaiTokenError.value = err.error || "Failed to save token";
        }
      } catch (error) {
        console.error("[nuvu] Failed to save CivitAI token:", error);
        civitaiTokenError.value = "Failed to save token";
      } finally {
        isSavingCivitaiToken.value = false;
      }
    }
    async function clearCivitaiToken() {
      civitaiToken.value = "";
      await saveCivitaiTokenToConfig();
    }
    async function copyAffiliateLink() {
      if (!affiliateLink.value) return;
      try {
        await navigator.clipboard.writeText(affiliateLink.value);
        affiliateCopied.value = true;
        setTimeout(() => {
          affiliateCopied.value = false;
        }, 2e3);
      } catch (error) {
        console.error("[nuvu] Failed to copy:", error);
      }
    }
    onMounted(() => {
      loadUserConfig();
      loadDevices();
      loadUserData();
      loadAffiliateData();
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$6, [
        _cache[85] || (_cache[85] = createBaseVNode("h3", { class: "panel-title" }, "User Configuration", -1)),
        createBaseVNode("section", _hoisted_2$6, [
          _cache[33] || (_cache[33] = createBaseVNode("h4", { class: "section-title" }, "Registered Devices", -1)),
          _cache[34] || (_cache[34] = createBaseVNode("p", { class: "section-description" }, " Register this device to enable downloads and installations. Your subscription allows a limited number of active devices. ", -1)),
          hasFloatingLicense.value ? (openBlock(), createElementBlock("p", _hoisted_3$5, [..._cache[26] || (_cache[26] = [
            createBaseVNode("strong", null, "Note:", -1),
            createTextVNode(" As a floating license user, you do not need to register devices. ", -1)
          ])])) : createCommentVNode("", true),
          createBaseVNode("div", _hoisted_4$5, [
            withDirectives(createBaseVNode("input", {
              "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => deviceLabel.value = $event),
              type: "text",
              class: "input device-input",
              placeholder: "Device label (e.g., My Desktop)",
              disabled: isRegisteringDevice.value,
              onKeyup: _cache[1] || (_cache[1] = withKeys(($event) => registerDevice(), ["enter"]))
            }, null, 40, _hoisted_5$5), [
              [vModelText, deviceLabel.value]
            ]),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              disabled: isRegisteringDevice.value || !deviceLabel.value.trim(),
              onClick: _cache[2] || (_cache[2] = ($event) => registerDevice())
            }, toDisplayString(isRegisteringDevice.value ? "Registering..." : "Register Device"), 9, _hoisted_6$5)
          ]),
          showReplaceDialog.value ? (openBlock(), createElementBlock("div", _hoisted_7$5, [
            createBaseVNode("div", _hoisted_8$5, [
              _cache[27] || (_cache[27] = createBaseVNode("h4", { class: "replace-dialog-title" }, "Device Limit Reached", -1)),
              _cache[28] || (_cache[28] = createBaseVNode("p", { class: "replace-dialog-message" }, " You have reached your device limit. Select a device to replace: ", -1)),
              createBaseVNode("div", _hoisted_9$4, [
                (openBlock(true), createElementBlock(Fragment, null, renderList(devicesToReplace.value, (device) => {
                  return openBlock(), createElementBlock("button", {
                    key: device.deviceId,
                    class: "replace-device-item",
                    onClick: ($event) => selectDeviceToReplace(device.deviceId)
                  }, [
                    createBaseVNode("div", _hoisted_11$4, toDisplayString(device.deviceLabel || device.machineName || "Unnamed Device"), 1),
                    createBaseVNode("div", _hoisted_12$4, [
                      device.platform ? (openBlock(), createElementBlock("span", _hoisted_13$3, toDisplayString(device.platform), 1)) : createCommentVNode("", true),
                      device.lastSeenAt ? (openBlock(), createElementBlock("span", _hoisted_14$3, " Last seen: " + toDisplayString(new Date(device.lastSeenAt).toLocaleDateString()), 1)) : createCommentVNode("", true)
                    ])
                  ], 8, _hoisted_10$4);
                }), 128))
              ]),
              createBaseVNode("button", {
                class: "nuvu-btn nuvu-btn-secondary replace-cancel-btn",
                onClick: cancelReplacement
              }, " Cancel ")
            ])
          ])) : createCommentVNode("", true),
          showPermissionErrorModal.value ? (openBlock(), createElementBlock("div", _hoisted_15$3, [
            createBaseVNode("div", _hoisted_16$3, [
              _cache[29] || (_cache[29] = createBaseVNode("h4", { class: "replace-dialog-title" }, "Cannot Create Directory", -1)),
              createBaseVNode("p", _hoisted_17$3, toDisplayString(permissionErrorMessage.value), 1),
              _cache[30] || (_cache[30] = createBaseVNode("p", { class: "permission-error-hint" }, " Please either create the directory manually with appropriate permissions, or choose a different location as the install path. ", -1)),
              createBaseVNode("button", {
                class: "nuvu-btn nuvu-btn-primary replace-cancel-btn",
                onClick: _cache[3] || (_cache[3] = ($event) => showPermissionErrorModal.value = false)
              }, " OK ")
            ])
          ])) : createCommentVNode("", true),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              deviceError.value ? (openBlock(), createElementBlock("div", _hoisted_18$3, toDisplayString(deviceError.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              deviceSuccess.value ? (openBlock(), createElementBlock("div", _hoisted_19$3, toDisplayString(deviceSuccess.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createBaseVNode("div", _hoisted_20$3, [
            isLoadingDevices.value ? (openBlock(), createElementBlock("div", _hoisted_21$3, "Loading devices...")) : devices.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_22$3, " No devices registered. Register this device to continue. ")) : (openBlock(true), createElementBlock(Fragment, { key: 2 }, renderList(devices.value, (device) => {
              return openBlock(), createElementBlock("div", {
                key: device.id || device.deviceId || device.device_id,
                class: normalizeClass(["device-card", { current: isCurrentDevice(device) }])
              }, [
                createBaseVNode("div", _hoisted_23$3, [
                  createBaseVNode("div", _hoisted_24$2, toDisplayString(device.deviceLabel || device.label || device.name || device.machineName || "Unnamed Device"), 1),
                  createBaseVNode("div", _hoisted_25$2, [
                    isCurrentDevice(device) ? (openBlock(), createElementBlock("span", _hoisted_26$2, "This Device")) : createCommentVNode("", true),
                    createBaseVNode("button", {
                      class: "device-remove-btn",
                      disabled: removingDeviceId.value === (device.id || device.deviceId || device.device_id),
                      onClick: ($event) => removeDevice(device),
                      title: "Remove this device"
                    }, [
                      removingDeviceId.value === (device.id || device.deviceId || device.device_id) ? (openBlock(), createElementBlock("svg", _hoisted_28$2, [..._cache[31] || (_cache[31] = [
                        createBaseVNode("circle", {
                          cx: "12",
                          cy: "12",
                          r: "10",
                          "stroke-dasharray": "30",
                          "stroke-dashoffset": "10"
                        }, null, -1)
                      ])])) : (openBlock(), createElementBlock("svg", _hoisted_29$2, [..._cache[32] || (_cache[32] = [
                        createBaseVNode("line", {
                          x1: "18",
                          y1: "6",
                          x2: "6",
                          y2: "18"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "6",
                          y1: "6",
                          x2: "18",
                          y2: "18"
                        }, null, -1)
                      ])]))
                    ], 8, _hoisted_27$2)
                  ])
                ]),
                createBaseVNode("div", _hoisted_30$2, [
                  device.platform ? (openBlock(), createElementBlock("span", _hoisted_31$2, toDisplayString(device.platform), 1)) : createCommentVNode("", true),
                  device.createdAt || device.created_at ? (openBlock(), createElementBlock("span", _hoisted_32$2, " Registered: " + toDisplayString(new Date(device.createdAt || device.created_at).toLocaleDateString()), 1)) : createCommentVNode("", true)
                ])
              ], 2);
            }), 128))
          ])
        ]),
        createBaseVNode("section", _hoisted_33$2, [
          _cache[37] || (_cache[37] = createBaseVNode("h4", { class: "section-title" }, "HuggingFace Token", -1)),
          _cache[38] || (_cache[38] = createBaseVNode("p", { class: "section-description" }, " Add your HuggingFace token for faster downloads and access to gated models. Your token is stored locally and never sent to our servers. ", -1)),
          createBaseVNode("div", _hoisted_34$2, [
            createBaseVNode("div", _hoisted_35$2, [
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => hfToken.value = $event),
                type: showHfToken.value ? "text" : "password",
                class: "input",
                placeholder: "hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                onKeyup: withKeys(saveHfTokenToConfig, ["enter"])
              }, null, 40, _hoisted_36$2), [
                [vModelDynamic, hfToken.value]
              ]),
              createBaseVNode("button", {
                type: "button",
                class: "token-toggle",
                onClick: _cache[5] || (_cache[5] = ($event) => showHfToken.value = !showHfToken.value),
                title: showHfToken.value ? "Hide token" : "Show token"
              }, [
                showHfToken.value ? (openBlock(), createElementBlock("svg", _hoisted_38$2, [..._cache[35] || (_cache[35] = [
                  createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                  createBaseVNode("line", {
                    x1: "1",
                    y1: "1",
                    x2: "23",
                    y2: "23"
                  }, null, -1)
                ])])) : (openBlock(), createElementBlock("svg", _hoisted_39$2, [..._cache[36] || (_cache[36] = [
                  createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                  createBaseVNode("circle", {
                    cx: "12",
                    cy: "12",
                    r: "3"
                  }, null, -1)
                ])]))
              ], 8, _hoisted_37$2)
            ]),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              disabled: isSavingHfToken.value,
              onClick: saveHfTokenToConfig
            }, toDisplayString(isSavingHfToken.value ? "Saving..." : "Save Token"), 9, _hoisted_40$1),
            hfToken.value ? (openBlock(), createElementBlock("button", {
              key: 0,
              class: "nuvu-btn nuvu-btn-secondary",
              onClick: clearHfToken,
              title: "Clear token",
              disabled: isSavingHfToken.value
            }, " Clear ", 8, _hoisted_41)) : createCommentVNode("", true)
          ]),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              hfTokenSaved.value ? (openBlock(), createElementBlock("div", _hoisted_42, "Token saved!")) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              hfTokenError.value ? (openBlock(), createElementBlock("div", _hoisted_43, toDisplayString(hfTokenError.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          _cache[39] || (_cache[39] = createBaseVNode("a", {
            href: "https://huggingface.co/settings/tokens",
            target: "_blank",
            rel: "noopener noreferrer",
            class: "help-link"
          }, " Get a HuggingFace token ", -1))
        ]),
        createBaseVNode("section", _hoisted_44, [
          _cache[42] || (_cache[42] = createBaseVNode("h4", { class: "section-title" }, "CivitAI API Key", -1)),
          _cache[43] || (_cache[43] = createBaseVNode("p", { class: "section-description" }, " Add your CivitAI API key to download models from CivitAI. Your key is stored locally and never sent to our servers. ", -1)),
          createBaseVNode("div", _hoisted_45, [
            createBaseVNode("div", _hoisted_46, [
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => civitaiToken.value = $event),
                type: showCivitaiToken.value ? "text" : "password",
                class: "input",
                placeholder: "Your CivitAI API key...",
                onKeyup: withKeys(saveCivitaiTokenToConfig, ["enter"])
              }, null, 40, _hoisted_47), [
                [vModelDynamic, civitaiToken.value]
              ]),
              createBaseVNode("button", {
                type: "button",
                class: "token-toggle",
                onClick: _cache[7] || (_cache[7] = ($event) => showCivitaiToken.value = !showCivitaiToken.value),
                title: showCivitaiToken.value ? "Hide token" : "Show token"
              }, [
                showCivitaiToken.value ? (openBlock(), createElementBlock("svg", _hoisted_49, [..._cache[40] || (_cache[40] = [
                  createBaseVNode("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" }, null, -1),
                  createBaseVNode("line", {
                    x1: "1",
                    y1: "1",
                    x2: "23",
                    y2: "23"
                  }, null, -1)
                ])])) : (openBlock(), createElementBlock("svg", _hoisted_50, [..._cache[41] || (_cache[41] = [
                  createBaseVNode("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }, null, -1),
                  createBaseVNode("circle", {
                    cx: "12",
                    cy: "12",
                    r: "3"
                  }, null, -1)
                ])]))
              ], 8, _hoisted_48)
            ]),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              disabled: isSavingCivitaiToken.value,
              onClick: saveCivitaiTokenToConfig
            }, toDisplayString(isSavingCivitaiToken.value ? "Saving..." : "Save Token"), 9, _hoisted_51),
            civitaiToken.value ? (openBlock(), createElementBlock("button", {
              key: 0,
              class: "nuvu-btn nuvu-btn-secondary",
              onClick: clearCivitaiToken,
              title: "Clear token",
              disabled: isSavingCivitaiToken.value
            }, " Clear ", 8, _hoisted_52)) : createCommentVNode("", true)
          ]),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              civitaiTokenSaved.value ? (openBlock(), createElementBlock("div", _hoisted_53, "Token saved!")) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              civitaiTokenError.value ? (openBlock(), createElementBlock("div", _hoisted_54, toDisplayString(civitaiTokenError.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          _cache[44] || (_cache[44] = createBaseVNode("a", {
            href: "https://civitai.com/user/account",
            target: "_blank",
            rel: "noopener noreferrer",
            class: "help-link"
          }, " Get a CivitAI API key ", -1))
        ]),
        createBaseVNode("section", _hoisted_55, [
          _cache[51] || (_cache[51] = createBaseVNode("h4", { class: "section-title" }, "Extra Model Paths", -1)),
          _cache[52] || (_cache[52] = createBaseVNode("p", { class: "section-description" }, " Add paths to external model directories. ComfyUI will search these locations for models, LoRAs, embeddings, etc. This is useful for sharing models between multiple ComfyUI installations. ", -1)),
          createBaseVNode("div", _hoisted_56, [
            withDirectives(createBaseVNode("input", {
              "onUpdate:modelValue": _cache[8] || (_cache[8] = ($event) => newModelPath.value = $event),
              type: "text",
              class: "input path-input",
              placeholder: "C:\\path\\to\\your\\models or /home/user/models",
              disabled: unref(isSavingModelPaths),
              onKeyup: withKeys(addModelPath, ["enter"])
            }, null, 40, _hoisted_57), [
              [vModelText, newModelPath.value]
            ]),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-secondary",
              disabled: unref(isSavingModelPaths) || !newModelPath.value.trim(),
              onClick: addModelPath
            }, toDisplayString(unref(isSavingModelPaths) ? "Saving..." : "Add Path"), 9, _hoisted_58)
          ]),
          createBaseVNode("div", _hoisted_59, [
            _cache[49] || (_cache[49] = createBaseVNode("h5", { class: "install-location-title" }, "Install Location", -1)),
            _cache[50] || (_cache[50] = createBaseVNode("p", { class: "install-location-description" }, " Select where new models should be installed. The selected path will be used as the primary location for downloads. ", -1)),
            createBaseVNode("div", {
              class: normalizeClass(["path-item install-option", { selected: selectedInstallPathIndex.value === -1 }]),
              onClick: _cache[11] || (_cache[11] = ($event) => selectInstallPath(-1))
            }, [
              createBaseVNode("label", {
                class: "install-radio-label",
                onClick: _cache[10] || (_cache[10] = withModifiers(() => {
                }, ["stop"]))
              }, [
                createBaseVNode("input", {
                  type: "radio",
                  name: "installPath",
                  checked: selectedInstallPathIndex.value === -1,
                  disabled: unref(isSavingModelPaths),
                  onChange: _cache[9] || (_cache[9] = ($event) => selectInstallPath(-1)),
                  class: "install-radio"
                }, null, 40, _hoisted_60),
                _cache[45] || (_cache[45] = createBaseVNode("span", { class: "radio-custom" }, null, -1))
              ]),
              _cache[46] || (_cache[46] = createBaseVNode("span", { class: "path-text default-path" }, "Default (ComfyUI/models)", -1)),
              selectedInstallPathIndex.value === -1 ? (openBlock(), createElementBlock("span", _hoisted_61, "Install Location")) : createCommentVNode("", true)
            ], 2),
            (openBlock(true), createElementBlock(Fragment, null, renderList(extraModelPaths.value, (path, index) => {
              return openBlock(), createElementBlock("div", {
                key: index,
                class: normalizeClass(["path-item install-option", { selected: selectedInstallPathIndex.value === index }]),
                onClick: ($event) => selectInstallPath(index)
              }, [
                createBaseVNode("label", {
                  class: "install-radio-label",
                  onClick: _cache[12] || (_cache[12] = withModifiers(() => {
                  }, ["stop"]))
                }, [
                  createBaseVNode("input", {
                    type: "radio",
                    name: "installPath",
                    checked: selectedInstallPathIndex.value === index,
                    disabled: unref(isSavingModelPaths),
                    onChange: ($event) => selectInstallPath(index),
                    class: "install-radio"
                  }, null, 40, _hoisted_63),
                  _cache[47] || (_cache[47] = createBaseVNode("span", { class: "radio-custom" }, null, -1))
                ]),
                createBaseVNode("span", _hoisted_64, toDisplayString(path), 1),
                selectedInstallPathIndex.value === index ? (openBlock(), createElementBlock("span", _hoisted_65, "Install Location")) : createCommentVNode("", true),
                createBaseVNode("button", {
                  class: "path-remove",
                  onClick: withModifiers(($event) => removeModelPath(index), ["stop"]),
                  title: "Remove path"
                }, [..._cache[48] || (_cache[48] = [
                  createBaseVNode("svg", {
                    width: "14",
                    height: "14",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "2"
                  }, [
                    createBaseVNode("line", {
                      x1: "18",
                      y1: "6",
                      x2: "6",
                      y2: "18"
                    }),
                    createBaseVNode("line", {
                      x1: "6",
                      y1: "6",
                      x2: "18",
                      y2: "18"
                    })
                  ], -1)
                ])], 8, _hoisted_66)
              ], 10, _hoisted_62);
            }), 128))
          ]),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              unref(modelPathsError) ? (openBlock(), createElementBlock("div", _hoisted_67, toDisplayString(unref(modelPathsError)), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              unref(modelPathsSuccess) ? (openBlock(), createElementBlock("div", _hoisted_68, toDisplayString(unref(modelPathsSuccess)), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          })
        ]),
        createBaseVNode("section", _hoisted_69, [
          _cache[59] || (_cache[59] = createBaseVNode("h4", { class: "section-title" }, "Extra Custom Nodes Paths", -1)),
          _cache[60] || (_cache[60] = createBaseVNode("p", { class: "section-description" }, " Add paths to external custom nodes directories. ComfyUI will load custom nodes from these locations. ", -1)),
          createBaseVNode("div", _hoisted_70, [
            withDirectives(createBaseVNode("input", {
              "onUpdate:modelValue": _cache[13] || (_cache[13] = ($event) => newCustomNodesPath.value = $event),
              type: "text",
              class: "input path-input",
              placeholder: "C:\\path\\to\\your\\custom_nodes or /home/user/custom_nodes",
              disabled: isSavingConfig.value,
              onKeyup: withKeys(addCustomNodesPath, ["enter"])
            }, null, 40, _hoisted_71), [
              [vModelText, newCustomNodesPath.value]
            ]),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-secondary",
              disabled: isSavingConfig.value || !newCustomNodesPath.value.trim(),
              onClick: addCustomNodesPath
            }, toDisplayString(isSavingConfig.value ? "Saving..." : "Add Path"), 9, _hoisted_72)
          ]),
          createBaseVNode("div", _hoisted_73, [
            _cache[57] || (_cache[57] = createBaseVNode("h5", { class: "install-location-title" }, "Install Location", -1)),
            _cache[58] || (_cache[58] = createBaseVNode("p", { class: "install-location-description" }, " Select where new custom nodes should be installed. ", -1)),
            createBaseVNode("div", {
              class: normalizeClass(["path-item install-option", { selected: selectedCustomNodesPathIndex.value === -1 }]),
              onClick: _cache[16] || (_cache[16] = ($event) => selectCustomNodesPath(-1))
            }, [
              createBaseVNode("label", {
                class: "install-radio-label",
                onClick: _cache[15] || (_cache[15] = withModifiers(() => {
                }, ["stop"]))
              }, [
                createBaseVNode("input", {
                  type: "radio",
                  name: "customNodesPath",
                  checked: selectedCustomNodesPathIndex.value === -1,
                  disabled: isSavingConfig.value,
                  onChange: _cache[14] || (_cache[14] = ($event) => selectCustomNodesPath(-1)),
                  class: "install-radio"
                }, null, 40, _hoisted_74),
                _cache[53] || (_cache[53] = createBaseVNode("span", { class: "radio-custom" }, null, -1))
              ]),
              _cache[54] || (_cache[54] = createBaseVNode("span", { class: "path-text default-path" }, "Default (ComfyUI/custom_nodes)", -1)),
              selectedCustomNodesPathIndex.value === -1 ? (openBlock(), createElementBlock("span", _hoisted_75, "Install Location")) : createCommentVNode("", true)
            ], 2),
            (openBlock(true), createElementBlock(Fragment, null, renderList(extraCustomNodesPaths.value, (path, index) => {
              return openBlock(), createElementBlock("div", {
                key: index,
                class: normalizeClass(["path-item install-option", { selected: selectedCustomNodesPathIndex.value === index }]),
                onClick: ($event) => selectCustomNodesPath(index)
              }, [
                createBaseVNode("label", {
                  class: "install-radio-label",
                  onClick: _cache[17] || (_cache[17] = withModifiers(() => {
                  }, ["stop"]))
                }, [
                  createBaseVNode("input", {
                    type: "radio",
                    name: "customNodesPath",
                    checked: selectedCustomNodesPathIndex.value === index,
                    disabled: isSavingConfig.value,
                    onChange: ($event) => selectCustomNodesPath(index),
                    class: "install-radio"
                  }, null, 40, _hoisted_77),
                  _cache[55] || (_cache[55] = createBaseVNode("span", { class: "radio-custom" }, null, -1))
                ]),
                createBaseVNode("span", _hoisted_78, toDisplayString(path), 1),
                selectedCustomNodesPathIndex.value === index ? (openBlock(), createElementBlock("span", _hoisted_79, "Install Location")) : createCommentVNode("", true),
                createBaseVNode("button", {
                  class: "path-remove",
                  onClick: withModifiers(($event) => removeCustomNodesPath(index), ["stop"]),
                  title: "Remove path"
                }, [..._cache[56] || (_cache[56] = [
                  createBaseVNode("svg", {
                    width: "14",
                    height: "14",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "2"
                  }, [
                    createBaseVNode("line", {
                      x1: "18",
                      y1: "6",
                      x2: "6",
                      y2: "18"
                    }),
                    createBaseVNode("line", {
                      x1: "6",
                      y1: "6",
                      x2: "18",
                      y2: "18"
                    })
                  ], -1)
                ])], 8, _hoisted_80)
              ], 10, _hoisted_76);
            }), 128))
          ]),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              customNodesError.value ? (openBlock(), createElementBlock("div", _hoisted_81, toDisplayString(customNodesError.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              customNodesSuccess.value ? (openBlock(), createElementBlock("div", _hoisted_82, toDisplayString(customNodesSuccess.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          })
        ]),
        createBaseVNode("section", _hoisted_83, [
          _cache[76] || (_cache[76] = createBaseVNode("h4", { class: "section-title" }, "Common ComfyUI Settings", -1)),
          _cache[77] || (_cache[77] = createBaseVNode("p", { class: "section-description" }, " Configure ComfyUI launch options. Changes take effect after restarting ComfyUI. ", -1)),
          createBaseVNode("div", _hoisted_84, [
            createBaseVNode("div", _hoisted_85, [
              _cache[62] || (_cache[62] = createBaseVNode("label", { class: "setting-label" }, "VRAM Mode", -1)),
              withDirectives(createBaseVNode("select", {
                "onUpdate:modelValue": _cache[18] || (_cache[18] = ($event) => vramMode.value = $event),
                class: "setting-select",
                disabled: isSavingComfySettings.value
              }, [..._cache[61] || (_cache[61] = [
                createStaticVNode('<option value="ignore" data-v-f026eb11>Ignore (use default)</option><option value="gpu-only" data-v-f026eb11>GPU Only (keep everything on GPU)</option><option value="highvram" data-v-f026eb11>High VRAM (keep models in GPU after use)</option><option value="normalvram" data-v-f026eb11>Normal VRAM</option><option value="lowvram" data-v-f026eb11>Low VRAM (split unet)</option><option value="novram" data-v-f026eb11>No VRAM (extreme low memory)</option>', 6)
              ])], 8, _hoisted_86), [
                [vModelSelect, vramMode.value]
              ])
            ]),
            createBaseVNode("div", _hoisted_87, [
              _cache[64] || (_cache[64] = createBaseVNode("label", { class: "setting-label" }, "Preview Method", -1)),
              withDirectives(createBaseVNode("select", {
                "onUpdate:modelValue": _cache[19] || (_cache[19] = ($event) => previewMethod.value = $event),
                class: "setting-select",
                disabled: isSavingComfySettings.value
              }, [..._cache[63] || (_cache[63] = [
                createStaticVNode('<option value="ignore" data-v-f026eb11>Ignore (use default)</option><option value="none" data-v-f026eb11>None (no previews)</option><option value="auto" data-v-f026eb11>Auto</option><option value="latent2rgb" data-v-f026eb11>Latent2RGB (fast, lower quality)</option><option value="taesd" data-v-f026eb11>TAESD (slower, higher quality)</option>', 5)
              ])], 8, _hoisted_88), [
                [vModelSelect, previewMethod.value]
              ])
            ]),
            createBaseVNode("div", _hoisted_89, [
              _cache[66] || (_cache[66] = createBaseVNode("label", { class: "setting-label" }, "Cache Mode", -1)),
              withDirectives(createBaseVNode("select", {
                "onUpdate:modelValue": _cache[20] || (_cache[20] = ($event) => cacheMode.value = $event),
                class: "setting-select",
                disabled: isSavingComfySettings.value
              }, [..._cache[65] || (_cache[65] = [
                createBaseVNode("option", { value: "ignore" }, "Ignore (use default)", -1),
                createBaseVNode("option", { value: "classic" }, "Classic (aggressive caching)", -1),
                createBaseVNode("option", { value: "lru" }, "LRU (limited cache)", -1),
                createBaseVNode("option", { value: "none" }, "None (no caching, less RAM)", -1)
              ])], 8, _hoisted_90), [
                [vModelSelect, cacheMode.value]
              ])
            ]),
            cacheMode.value === "lru" ? (openBlock(), createElementBlock("div", _hoisted_91, [
              _cache[67] || (_cache[67] = createBaseVNode("label", { class: "setting-label" }, "LRU Cache Size", -1)),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[21] || (_cache[21] = ($event) => cacheLruSize.value = $event),
                type: "number",
                class: "setting-input setting-input-small",
                placeholder: "64",
                min: "1",
                disabled: isSavingComfySettings.value
              }, null, 8, _hoisted_92), [
                [
                  vModelText,
                  cacheLruSize.value,
                  void 0,
                  { number: true }
                ]
              ])
            ])) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_93, [
              _cache[68] || (_cache[68] = createBaseVNode("label", { class: "setting-label" }, "CUDA Device", -1)),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[22] || (_cache[22] = ($event) => cudaDevice.value = $event),
                type: "text",
                class: "setting-input setting-input-small",
                placeholder: "Leave empty to ignore",
                disabled: isSavingComfySettings.value
              }, null, 8, _hoisted_94), [
                [vModelText, cudaDevice.value]
              ]),
              _cache[69] || (_cache[69] = createBaseVNode("span", { class: "setting-hint" }, "GPU index (0, 1, etc.) for multi-GPU systems", -1))
            ]),
            createBaseVNode("div", _hoisted_95, [
              _cache[70] || (_cache[70] = createBaseVNode("label", { class: "setting-label" }, "Reserve VRAM (GB)", -1)),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[23] || (_cache[23] = ($event) => reserveVram.value = $event),
                type: "text",
                class: "setting-input setting-input-small",
                placeholder: "Leave empty to ignore",
                disabled: isSavingComfySettings.value
              }, null, 8, _hoisted_96), [
                [vModelText, reserveVram.value]
              ]),
              _cache[71] || (_cache[71] = createBaseVNode("span", { class: "setting-hint" }, "VRAM to reserve for OS/other apps", -1))
            ]),
            createBaseVNode("div", _hoisted_97, [
              _cache[72] || (_cache[72] = createBaseVNode("label", { class: "setting-label" }, "Input Directory", -1)),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[24] || (_cache[24] = ($event) => inputDirectory.value = $event),
                type: "text",
                class: "setting-input",
                placeholder: "Leave empty to use default",
                disabled: isSavingComfySettings.value
              }, null, 8, _hoisted_98), [
                [vModelText, inputDirectory.value]
              ]),
              _cache[73] || (_cache[73] = createBaseVNode("span", { class: "setting-hint" }, "Where input images are loaded from", -1))
            ]),
            createBaseVNode("div", _hoisted_99, [
              _cache[74] || (_cache[74] = createBaseVNode("label", { class: "setting-label" }, "Output Directory", -1)),
              withDirectives(createBaseVNode("input", {
                "onUpdate:modelValue": _cache[25] || (_cache[25] = ($event) => outputDirectory.value = $event),
                type: "text",
                class: "setting-input",
                placeholder: "Leave empty to use default",
                disabled: isSavingComfySettings.value
              }, null, 8, _hoisted_100), [
                [vModelText, outputDirectory.value]
              ]),
              _cache[75] || (_cache[75] = createBaseVNode("span", { class: "setting-hint" }, "Where generated images are saved", -1))
            ])
          ]),
          createBaseVNode("button", {
            class: "nuvu-btn nuvu-btn-secondary save-settings-btn",
            disabled: isSavingComfySettings.value,
            onClick: saveComfySettings
          }, toDisplayString(isSavingComfySettings.value ? "Saving..." : "Save Settings"), 9, _hoisted_101),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              comfySettingsError.value ? (openBlock(), createElementBlock("div", _hoisted_102, toDisplayString(comfySettingsError.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          }),
          createVNode(Transition, { name: "fade" }, {
            default: withCtx(() => [
              comfySettingsSuccess.value ? (openBlock(), createElementBlock("div", _hoisted_103, toDisplayString(comfySettingsSuccess.value), 1)) : createCommentVNode("", true)
            ]),
            _: 1
          })
        ]),
        isAffiliate.value ? (openBlock(), createElementBlock("section", _hoisted_104, [
          _cache[84] || (_cache[84] = createBaseVNode("h4", { class: "section-title" }, "Affiliate Program", -1)),
          createBaseVNode("p", _hoisted_105, " Share your affiliate link to earn " + toDisplayString(affiliateData.value?.commissionPercent || 20) + "% commission when others subscribe. ", 1),
          affiliateData.value ? (openBlock(), createElementBlock("div", _hoisted_106, [
            createBaseVNode("div", _hoisted_107, [
              createBaseVNode("div", _hoisted_108, toDisplayString(affiliateData.value.visits || 0), 1),
              _cache[78] || (_cache[78] = createBaseVNode("div", { class: "stat-label" }, "Visits", -1))
            ]),
            createBaseVNode("div", _hoisted_109, [
              createBaseVNode("div", _hoisted_110, toDisplayString(affiliateData.value.conversions || 0), 1),
              _cache[79] || (_cache[79] = createBaseVNode("div", { class: "stat-label" }, "Conversions", -1))
            ]),
            createBaseVNode("div", _hoisted_111, [
              createBaseVNode("div", _hoisted_112, toDisplayString(affiliateData.value.conversionRate || 0) + "%", 1),
              _cache[80] || (_cache[80] = createBaseVNode("div", { class: "stat-label" }, "Rate", -1))
            ]),
            createBaseVNode("div", _hoisted_113, [
              createBaseVNode("div", _hoisted_114, "$" + toDisplayString(((affiliateData.value.revenue || 0) / 100).toFixed(2)), 1),
              _cache[81] || (_cache[81] = createBaseVNode("div", { class: "stat-label" }, "Revenue", -1))
            ])
          ])) : createCommentVNode("", true),
          createBaseVNode("div", _hoisted_115, [
            createBaseVNode("input", {
              value: affiliateLink.value,
              type: "text",
              class: "input affiliate-input",
              readonly: ""
            }, null, 8, _hoisted_116),
            createBaseVNode("button", {
              class: "nuvu-btn nuvu-btn-primary",
              onClick: copyAffiliateLink
            }, toDisplayString(affiliateCopied.value ? "Copied!" : "Copy Link"), 1)
          ]),
          affiliateData.value?.stripeConnectStatus === "active" ? (openBlock(), createElementBlock("div", _hoisted_117, [
            createBaseVNode("div", _hoisted_118, [
              createBaseVNode("div", _hoisted_119, [
                _cache[82] || (_cache[82] = createBaseVNode("span", { class: "payout-label" }, "Total Payouts:", -1)),
                createBaseVNode("span", _hoisted_120, "$" + toDisplayString(((affiliateData.value.totalPayouts || 0) / 100).toFixed(2)), 1)
              ]),
              createBaseVNode("div", _hoisted_121, [
                _cache[83] || (_cache[83] = createBaseVNode("span", { class: "payout-label" }, "Pending Payout:", -1)),
                createBaseVNode("span", _hoisted_122, "$" + toDisplayString(((affiliateData.value.pendingPayout || 0) / 100).toFixed(2)), 1)
              ])
            ]),
            affiliateData.value.autoPayoutEnabled ? (openBlock(), createElementBlock("div", _hoisted_123, " Auto-payout enabled ")) : createCommentVNode("", true)
          ])) : affiliateData.value?.stripeConnectStatus === "pending" ? (openBlock(), createElementBlock("div", _hoisted_124, " Your Stripe Connect account is pending verification. You'll be able to receive payouts once approved. ")) : createCommentVNode("", true)
        ])) : createCommentVNode("", true),
        isLoadingAffiliate.value ? (openBlock(), createElementBlock("div", _hoisted_125, " Loading affiliate status... ")) : createCommentVNode("", true)
      ]);
    };
  }
};
const UserConfigPanel = /* @__PURE__ */ _export_sfc(_sfc_main$7, [["__scopeId", "data-v-f026eb11"]]);
const _hoisted_1$5 = { class: "help-panel" };
const _hoisted_2$5 = { class: "panel-content" };
const _hoisted_3$4 = { class: "form-row" };
const _hoisted_4$4 = { class: "form-group" };
const _hoisted_5$4 = ["disabled"];
const _hoisted_6$4 = { class: "form-group" };
const _hoisted_7$4 = ["disabled"];
const _hoisted_8$4 = { class: "form-group" };
const _hoisted_9$3 = ["disabled"];
const _hoisted_10$3 = { class: "form-group" };
const _hoisted_11$3 = ["disabled"];
const _hoisted_12$3 = ["disabled"];
const _sfc_main$6 = {
  __name: "HelpPanel",
  setup(__props) {
    const form = /* @__PURE__ */ reactive({
      name: "",
      email: "",
      subject: "",
      message: ""
    });
    const isSubmitting = /* @__PURE__ */ ref(false);
    const submitStatus = /* @__PURE__ */ ref("");
    const submitError = /* @__PURE__ */ ref(false);
    onMounted(() => {
      try {
        if (currentUser?.email) {
          form.email = currentUser.email;
        }
        if (currentUser?.name) {
          form.name = currentUser.name;
        }
      } catch (error) {
      }
    });
    async function submitForm() {
      if (!form.email || !form.message) {
        submitStatus.value = "Please fill in all required fields.";
        submitError.value = true;
        return;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(form.email)) {
        submitStatus.value = "Please enter a valid email address.";
        submitError.value = true;
        return;
      }
      isSubmitting.value = true;
      submitStatus.value = "";
      submitError.value = false;
      try {
        const response = await fetch("/nuvu/contact", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: form.name.trim() || "Anonymous",
            email: form.email.trim(),
            subject: form.subject.trim() || "General Inquiry",
            message: form.message.trim()
          })
        });
        if (response.ok) {
          submitStatus.value = "Message sent successfully! We'll get back to you as soon as possible.";
          submitError.value = false;
          form.subject = "";
          form.message = "";
        } else {
          const result = await response.json().catch(() => ({}));
          submitStatus.value = result.error || result.message || "Failed to send message. Please try again.";
          submitError.value = true;
        }
      } catch (error) {
        console.error("[nuvu] Contact form error:", error);
        submitStatus.value = "Failed to send message. Please check your connection and try again.";
        submitError.value = true;
      } finally {
        isSubmitting.value = false;
      }
    }
    function clearStatus() {
      submitStatus.value = "";
      submitError.value = false;
    }
    const isFormValid = computed(() => {
      return form.email && form.message;
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$5, [
        createBaseVNode("div", _hoisted_2$5, [
          _cache[8] || (_cache[8] = createStaticVNode('<h3 class="panel-title" data-v-8120e231>How can we help?</h3><p class="intro-text" data-v-8120e231> Nuvu is purpose-built to integrate ComfyUI seamlessly into modern production pipelines. Beyond ComfyUI-Nuvu, we deliver: </p><div class="value-props" data-v-8120e231><div class="prop-item" data-v-8120e231><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" data-v-8120e231><polyline points="20 6 9 17 4 12" data-v-8120e231></polyline></svg><span data-v-8120e231>Deep, production-proven expertise across film and VFX pipelines</span></div><div class="prop-item" data-v-8120e231><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" data-v-8120e231><polyline points="20 6 9 17 4 12" data-v-8120e231></polyline></svg><span data-v-8120e231>Secure, on-premise and air-gapped deployment solutions</span></div><div class="prop-item" data-v-8120e231><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" data-v-8120e231><polyline points="20 6 9 17 4 12" data-v-8120e231></polyline></svg><span data-v-8120e231>Custom model training and workflow optimization tailored to your needs</span></div><div class="prop-item" data-v-8120e231><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" data-v-8120e231><polyline points="20 6 9 17 4 12" data-v-8120e231></polyline></svg><span data-v-8120e231>Industry-leading best practices for scalable AI integration</span></div></div>', 3)),
          createBaseVNode("form", {
            class: "contact-form",
            onSubmit: withModifiers(submitForm, ["prevent"])
          }, [
            createBaseVNode("div", _hoisted_3$4, [
              createBaseVNode("div", _hoisted_4$4, [
                _cache[4] || (_cache[4] = createBaseVNode("label", { for: "help-name" }, "Name", -1)),
                withDirectives(createBaseVNode("input", {
                  id: "help-name",
                  "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => form.name = $event),
                  type: "text",
                  class: "input",
                  placeholder: "Your name",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_5$4), [
                  [vModelText, form.name]
                ])
              ]),
              createBaseVNode("div", _hoisted_6$4, [
                _cache[5] || (_cache[5] = createBaseVNode("label", { for: "help-email" }, "Email *", -1)),
                withDirectives(createBaseVNode("input", {
                  id: "help-email",
                  "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => form.email = $event),
                  type: "email",
                  class: "input",
                  placeholder: "your@email.com",
                  required: "",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_7$4), [
                  [vModelText, form.email]
                ])
              ])
            ]),
            createBaseVNode("div", _hoisted_8$4, [
              _cache[6] || (_cache[6] = createBaseVNode("label", { for: "help-subject" }, "Subject", -1)),
              withDirectives(createBaseVNode("input", {
                id: "help-subject",
                "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => form.subject = $event),
                type: "text",
                class: "input",
                placeholder: "What's this about?",
                disabled: isSubmitting.value,
                onInput: clearStatus
              }, null, 40, _hoisted_9$3), [
                [vModelText, form.subject]
              ])
            ]),
            createBaseVNode("div", _hoisted_10$3, [
              _cache[7] || (_cache[7] = createBaseVNode("label", { for: "help-message" }, "Message *", -1)),
              withDirectives(createBaseVNode("textarea", {
                id: "help-message",
                "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => form.message = $event),
                class: "textarea",
                placeholder: "Tell us how we can help...",
                rows: "6",
                required: "",
                disabled: isSubmitting.value,
                onInput: clearStatus
              }, null, 40, _hoisted_11$3), [
                [vModelText, form.message]
              ])
            ]),
            createVNode(Transition, { name: "fade" }, {
              default: withCtx(() => [
                submitStatus.value ? (openBlock(), createElementBlock("div", {
                  key: 0,
                  class: normalizeClass(["status-message", { error: submitError.value }])
                }, toDisplayString(submitStatus.value), 3)) : createCommentVNode("", true)
              ]),
              _: 1
            }),
            createBaseVNode("button", {
              type: "submit",
              class: "submit-btn nuvu-btn nuvu-btn-primary",
              disabled: isSubmitting.value || !isFormValid.value
            }, toDisplayString(isSubmitting.value ? "Sending..." : "Send Message"), 9, _hoisted_12$3)
          ], 32),
          _cache[9] || (_cache[9] = createStaticVNode('<div class="alternative-contact" data-v-8120e231><p class="alt-title" data-v-8120e231>Other ways to reach us</p><div class="contact-links" data-v-8120e231><a href="https://discord.gg/vdW97AtTAu" target="_blank" rel="noopener noreferrer" class="contact-link" data-v-8120e231><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" data-v-8120e231><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" data-v-8120e231></path></svg><span data-v-8120e231>Discord Community</span></a><a href="mailto:support@nuvulabs.ai" class="contact-link" data-v-8120e231><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" data-v-8120e231><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" data-v-8120e231></path><polyline points="22,6 12,13 2,6" data-v-8120e231></polyline></svg><span data-v-8120e231>support@nuvulabs.ai</span></a></div></div>', 1))
        ])
      ]);
    };
  }
};
const HelpPanel = /* @__PURE__ */ _export_sfc(_sfc_main$6, [["__scopeId", "data-v-8120e231"]]);
const _hoisted_1$4 = { class: "support-panel" };
const _hoisted_2$4 = { class: "panel-content" };
const _hoisted_3$3 = { class: "form-row" };
const _hoisted_4$3 = { class: "form-group" };
const _hoisted_5$3 = ["disabled"];
const _hoisted_6$3 = { class: "form-group" };
const _hoisted_7$3 = ["disabled"];
const _hoisted_8$3 = { class: "form-row" };
const _hoisted_9$2 = { class: "form-group" };
const _hoisted_10$2 = ["disabled"];
const _hoisted_11$2 = ["value"];
const _hoisted_12$2 = { class: "form-group" };
const _hoisted_13$2 = ["disabled"];
const _hoisted_14$2 = ["value"];
const _hoisted_15$2 = { class: "form-group" };
const _hoisted_16$2 = ["disabled"];
const _hoisted_17$2 = { class: "form-group" };
const _hoisted_18$2 = ["disabled"];
const _hoisted_19$2 = { class: "form-group" };
const _hoisted_20$2 = ["disabled"];
const _hoisted_21$2 = { class: "form-row" };
const _hoisted_22$2 = { class: "form-group" };
const _hoisted_23$2 = ["disabled"];
const _hoisted_24$1 = { class: "form-group" };
const _hoisted_25$1 = ["disabled"];
const _hoisted_26$1 = { class: "form-group" };
const _hoisted_27$1 = ["disabled"];
const _hoisted_28$1 = { class: "form-group" };
const _hoisted_29$1 = { class: "screenshot-upload" };
const _hoisted_30$1 = ["disabled"];
const _hoisted_31$1 = { key: 0 };
const _hoisted_32$1 = { key: 1 };
const _hoisted_33$1 = {
  key: 0,
  class: "screenshot-previews"
};
const _hoisted_34$1 = ["src", "alt"];
const _hoisted_35$1 = { class: "preview-info" };
const _hoisted_36$1 = ["title"];
const _hoisted_37$1 = { class: "preview-size" };
const _hoisted_38$1 = ["onClick", "disabled"];
const _hoisted_39$1 = {
  key: 0,
  class: "screenshot-error"
};
const _hoisted_40 = ["disabled"];
const MAX_SCREENSHOTS = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const _sfc_main$5 = {
  __name: "SupportPanel",
  setup(__props) {
    const versionsRef = inject("nuvuVersions", null);
    const loadVersions = inject("loadnuvuVersions", null);
    const form = /* @__PURE__ */ reactive({
      name: "",
      email: "",
      issueType: "bug",
      severity: "medium",
      summary: "",
      description: "",
      stepsToReproduce: "",
      expectedBehavior: "",
      actualBehavior: "",
      systemInfo: ""
    });
    const isSubmitting = /* @__PURE__ */ ref(false);
    const submitStatus = /* @__PURE__ */ ref("");
    const submitError = /* @__PURE__ */ ref(false);
    const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
    const screenshots = /* @__PURE__ */ ref([]);
    const screenshotPreviews = /* @__PURE__ */ ref([]);
    const screenshotError = /* @__PURE__ */ ref("");
    const isUploadingScreenshots = /* @__PURE__ */ ref(false);
    function buildSystemInfoText(v) {
      if (!v) return "";
      const comfyLines = [];
      comfyLines.push("ComfyUI Information:");
      comfyLines.push(`Nuvu Frontend: ${v.nuvu_frontend?.tag || "0.0.0"}`);
      comfyLines.push(`Nuvu Backend: ${v.nuvu_backend?.version || "Unknown"}`);
      comfyLines.push(`ComfyUI Frontend: ${v.comfyui_frontend?.version || "Unknown"}`);
      comfyLines.push(`ComfyUI Backend: ${v.comfyui_backend?.tag || "0.0.0"}`);
      const systemLines = [];
      systemLines.push("System Information:");
      systemLines.push(`OS: ${v.os || "Unknown"}`);
      systemLines.push(`Python: ${v.python?.version || "Unknown"}`);
      systemLines.push(`PyTorch: ${v.torch?.version || "Not installed"}`);
      systemLines.push(`CUDA Driver: ${v.cudaDriver?.version || "Not detected"}`);
      systemLines.push(`GPU: ${v.gpu?.name || "Not detected"}`);
      systemLines.push(`VRAM: ${v.gpu?.vram_gb ? v.gpu.vram_gb + " GB" : "Not detected"}`);
      systemLines.push(`RAM: ${v.ram?.total_gb ? v.ram.total_gb + " GB" : "Not detected"}`);
      return [...comfyLines, "", ...systemLines].join("\n");
    }
    function hydrateSystemInfoFromVersions() {
      const v = versionsRef?.value || null;
      const text = buildSystemInfoText(v);
      if (text) {
        form.systemInfo = text;
      }
    }
    const issueTypes = [
      { value: "bug", label: "Bug Report" },
      { value: "feature", label: "Feature Request" },
      { value: "installation", label: "Installation Issue" },
      { value: "performance", label: "Performance Problem" },
      { value: "crash", label: "Crash / Error" },
      { value: "other", label: "Other" }
    ];
    const severityLevels = [
      { value: "low", label: "Low - Minor inconvenience" },
      { value: "medium", label: "Medium - Affects workflow" },
      { value: "high", label: "High - Major blocker" },
      { value: "critical", label: "Critical - Cannot use at all" }
    ];
    onMounted(async () => {
      try {
        if (currentUser?.email) {
          form.email = currentUser.email;
        }
        if (currentUser?.name) {
          form.name = currentUser.name;
        }
      } catch (error) {
      }
      try {
        if (!versionsRef?.value && typeof loadVersions === "function") {
          await loadVersions();
        }
        hydrateSystemInfoFromVersions();
      } catch {
      }
    });
    watch(
      () => versionsRef?.value,
      (next) => {
        if (next) {
          hydrateSystemInfoFromVersions();
        }
      }
    );
    async function submitForm() {
      if (!form.email || !form.summary || !form.description) {
        submitStatus.value = "Please fill in all required fields.";
        submitError.value = true;
        return;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(form.email)) {
        submitStatus.value = "Please enter a valid email address.";
        submitError.value = true;
        return;
      }
      isSubmitting.value = true;
      submitStatus.value = "";
      submitError.value = false;
      try {
        let uploadedScreenshots = [];
        if (screenshots.value.length > 0) {
          submitStatus.value = "Uploading screenshots...";
          try {
            uploadedScreenshots = await uploadScreenshots();
          } catch (uploadError) {
            console.error("[nuvu] Screenshot upload error:", uploadError);
            submitStatus.value = `Failed to upload screenshots: ${uploadError.message}`;
            submitError.value = true;
            isSubmitting.value = false;
            return;
          }
        }
        submitStatus.value = "Submitting ticket...";
        const response = await fetch("/nuvu/support", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: form.name.trim() || "Anonymous",
            email: form.email.trim(),
            issueType: form.issueType,
            severity: form.severity,
            summary: form.summary.trim(),
            description: form.description.trim(),
            stepsToReproduce: form.stepsToReproduce.trim(),
            expectedBehavior: form.expectedBehavior.trim(),
            actualBehavior: form.actualBehavior.trim(),
            systemInfo: form.systemInfo.trim(),
            screenshots: uploadedScreenshots
          })
        });
        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          const screenshotMsg = uploadedScreenshots.length > 0 ? ` (${uploadedScreenshots.length} screenshot(s) attached)` : "";
          submitStatus.value = `Support ticket created successfully! Ticket ID: ${result.ticketId || "N/A"}${screenshotMsg}. We'll get back to you as soon as possible.`;
          submitError.value = false;
          form.issueType = "bug";
          form.severity = "medium";
          form.summary = "";
          form.description = "";
          form.stepsToReproduce = "";
          form.expectedBehavior = "";
          form.actualBehavior = "";
          screenshots.value = [];
          screenshotPreviews.value = [];
        } else {
          const result = await response.json().catch(() => ({}));
          submitStatus.value = result.error || result.message || "Failed to submit ticket. Please try again.";
          submitError.value = true;
        }
      } catch (error) {
        console.error("[nuvu] Support form error:", error);
        submitStatus.value = "Failed to submit ticket. Please check your connection and try again.";
        submitError.value = true;
      } finally {
        isSubmitting.value = false;
      }
    }
    function clearStatus() {
      submitStatus.value = "";
      submitError.value = false;
    }
    const isFormValid = computed(() => {
      return form.email && form.summary && form.description;
    });
    function handleScreenshotSelect(event) {
      const files = Array.from(event.target.files || []);
      screenshotError.value = "";
      const totalCount = screenshots.value.length + files.length;
      if (totalCount > MAX_SCREENSHOTS) {
        screenshotError.value = `Maximum ${MAX_SCREENSHOTS} screenshots allowed`;
        event.target.value = "";
        return;
      }
      for (const file of files) {
        if (!ALLOWED_TYPES.includes(file.type)) {
          screenshotError.value = `Invalid file type: ${file.name}. Only images (JPEG, PNG, GIF, WebP) are allowed.`;
          event.target.value = "";
          return;
        }
        if (file.size > MAX_FILE_SIZE) {
          screenshotError.value = `File "${file.name}" exceeds 5MB limit`;
          event.target.value = "";
          return;
        }
        screenshots.value.push(file);
        createPreview(file);
      }
      event.target.value = "";
    }
    function createPreview(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        screenshotPreviews.value.push({
          url: e.target.result,
          name: file.name,
          size: formatFileSize(file.size)
        });
      };
      reader.readAsDataURL(file);
    }
    function removeScreenshot(index) {
      screenshots.value.splice(index, 1);
      screenshotPreviews.value.splice(index, 1);
      screenshotError.value = "";
    }
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
    async function stripMetadata(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          let outputType = file.type;
          if (!["image/jpeg", "image/png", "image/webp"].includes(outputType)) {
            outputType = "image/jpeg";
          }
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(new File([blob], file.name, { type: outputType }));
            } else {
              reject(new Error("Failed to process image"));
            }
          }, outputType, 0.92);
        };
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = URL.createObjectURL(file);
      });
    }
    async function uploadScreenshots() {
      if (screenshots.value.length === 0) return [];
      isUploadingScreenshots.value = true;
      try {
        const fileMeta = await Promise.all(screenshots.value.map(async (file) => {
          const cleanFile = await stripMetadata(file);
          return {
            filename: cleanFile.name,
            contentType: cleanFile.type,
            size: cleanFile.size,
            file: cleanFile
          };
        }));
        const urlResponse = await fetch("/nuvu/support/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: fileMeta.map((f) => ({
              filename: f.filename,
              contentType: f.contentType,
              size: f.size
            }))
          })
        });
        if (!urlResponse.ok) {
          const err = await urlResponse.json().catch(() => ({}));
          throw new Error(err.error || "Failed to get upload URLs");
        }
        const { uploadUrls } = await urlResponse.json();
        const uploadedKeys = [];
        for (let i = 0; i < uploadUrls.length; i++) {
          const { url, key, contentType } = uploadUrls[i];
          const cleanFile = fileMeta[i].file;
          const uploadResponse = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: cleanFile
          });
          if (!uploadResponse.ok) {
            throw new Error(`Failed to upload ${fileMeta[i].filename}`);
          }
          uploadedKeys.push({
            key,
            originalFilename: fileMeta[i].filename,
            contentType
          });
        }
        return uploadedKeys;
      } finally {
        isUploadingScreenshots.value = false;
      }
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$4, [
        createBaseVNode("div", _hoisted_2$4, [
          _cache[25] || (_cache[25] = createBaseVNode("h3", { class: "panel-title" }, "Support", -1)),
          _cache[26] || (_cache[26] = createBaseVNode("p", { class: "intro-text" }, " Found a bug or having technical issues? Submit a support ticket and we'll help you resolve it. ", -1)),
          createBaseVNode("form", {
            class: "support-form",
            onSubmit: withModifiers(submitForm, ["prevent"])
          }, [
            createBaseVNode("div", _hoisted_3$3, [
              createBaseVNode("div", _hoisted_4$3, [
                _cache[10] || (_cache[10] = createBaseVNode("label", { for: "support-name" }, "Name", -1)),
                withDirectives(createBaseVNode("input", {
                  id: "support-name",
                  "onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => form.name = $event),
                  type: "text",
                  class: "input",
                  placeholder: "Your name",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_5$3), [
                  [vModelText, form.name]
                ])
              ]),
              createBaseVNode("div", _hoisted_6$3, [
                _cache[11] || (_cache[11] = createBaseVNode("label", { for: "support-email" }, "Email *", -1)),
                withDirectives(createBaseVNode("input", {
                  id: "support-email",
                  "onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => form.email = $event),
                  type: "email",
                  class: "input",
                  placeholder: "your@email.com",
                  required: "",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_7$3), [
                  [vModelText, form.email]
                ])
              ])
            ]),
            createBaseVNode("div", _hoisted_8$3, [
              createBaseVNode("div", _hoisted_9$2, [
                _cache[12] || (_cache[12] = createBaseVNode("label", { for: "support-type" }, "Issue Type *", -1)),
                withDirectives(createBaseVNode("select", {
                  id: "support-type",
                  "onUpdate:modelValue": _cache[2] || (_cache[2] = ($event) => form.issueType = $event),
                  class: "select",
                  disabled: isSubmitting.value,
                  onChange: clearStatus
                }, [
                  (openBlock(), createElementBlock(Fragment, null, renderList(issueTypes, (type) => {
                    return createBaseVNode("option", {
                      key: type.value,
                      value: type.value
                    }, toDisplayString(type.label), 9, _hoisted_11$2);
                  }), 64))
                ], 40, _hoisted_10$2), [
                  [vModelSelect, form.issueType]
                ])
              ]),
              createBaseVNode("div", _hoisted_12$2, [
                _cache[13] || (_cache[13] = createBaseVNode("label", { for: "support-severity" }, "Severity *", -1)),
                withDirectives(createBaseVNode("select", {
                  id: "support-severity",
                  "onUpdate:modelValue": _cache[3] || (_cache[3] = ($event) => form.severity = $event),
                  class: "select",
                  disabled: isSubmitting.value,
                  onChange: clearStatus
                }, [
                  (openBlock(), createElementBlock(Fragment, null, renderList(severityLevels, (level) => {
                    return createBaseVNode("option", {
                      key: level.value,
                      value: level.value
                    }, toDisplayString(level.label), 9, _hoisted_14$2);
                  }), 64))
                ], 40, _hoisted_13$2), [
                  [vModelSelect, form.severity]
                ])
              ])
            ]),
            createBaseVNode("div", _hoisted_15$2, [
              _cache[14] || (_cache[14] = createBaseVNode("label", { for: "support-summary" }, "Summary *", -1)),
              withDirectives(createBaseVNode("input", {
                id: "support-summary",
                "onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => form.summary = $event),
                type: "text",
                class: "input",
                placeholder: "Brief description of the issue",
                required: "",
                disabled: isSubmitting.value,
                onInput: clearStatus
              }, null, 40, _hoisted_16$2), [
                [vModelText, form.summary]
              ])
            ]),
            createBaseVNode("div", _hoisted_17$2, [
              _cache[15] || (_cache[15] = createBaseVNode("label", { for: "support-description" }, "Description *", -1)),
              withDirectives(createBaseVNode("textarea", {
                id: "support-description",
                "onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => form.description = $event),
                class: "textarea",
                placeholder: "Detailed description of what happened...",
                rows: "3",
                required: "",
                disabled: isSubmitting.value,
                onInput: clearStatus
              }, null, 40, _hoisted_18$2), [
                [vModelText, form.description]
              ])
            ]),
            createBaseVNode("div", _hoisted_19$2, [
              _cache[16] || (_cache[16] = createBaseVNode("label", { for: "support-steps" }, "Steps to Reproduce", -1)),
              withDirectives(createBaseVNode("textarea", {
                id: "support-steps",
                "onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => form.stepsToReproduce = $event),
                class: "textarea",
                placeholder: "1. Open workflow...\n2. Click on...\n3. Error appears...",
                rows: "3",
                disabled: isSubmitting.value,
                onInput: clearStatus
              }, null, 40, _hoisted_20$2), [
                [vModelText, form.stepsToReproduce]
              ])
            ]),
            createBaseVNode("div", _hoisted_21$2, [
              createBaseVNode("div", _hoisted_22$2, [
                _cache[17] || (_cache[17] = createBaseVNode("label", { for: "support-expected" }, "Expected Behavior", -1)),
                withDirectives(createBaseVNode("textarea", {
                  id: "support-expected",
                  "onUpdate:modelValue": _cache[7] || (_cache[7] = ($event) => form.expectedBehavior = $event),
                  class: "textarea textarea-sm",
                  placeholder: "What should happen?",
                  rows: "2",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_23$2), [
                  [vModelText, form.expectedBehavior]
                ])
              ]),
              createBaseVNode("div", _hoisted_24$1, [
                _cache[18] || (_cache[18] = createBaseVNode("label", { for: "support-actual" }, "Actual Behavior", -1)),
                withDirectives(createBaseVNode("textarea", {
                  id: "support-actual",
                  "onUpdate:modelValue": _cache[8] || (_cache[8] = ($event) => form.actualBehavior = $event),
                  class: "textarea textarea-sm",
                  placeholder: "What happened instead?",
                  rows: "2",
                  disabled: isSubmitting.value,
                  onInput: clearStatus
                }, null, 40, _hoisted_25$1), [
                  [vModelText, form.actualBehavior]
                ])
              ])
            ]),
            createBaseVNode("div", _hoisted_26$1, [
              _cache[19] || (_cache[19] = createBaseVNode("label", { for: "support-system" }, "System Information", -1)),
              withDirectives(createBaseVNode("textarea", {
                id: "support-system",
                "onUpdate:modelValue": _cache[9] || (_cache[9] = ($event) => form.systemInfo = $event),
                class: "textarea textarea-mono",
                placeholder: "Auto-populated system info...",
                rows: "10",
                readonly: "",
                spellcheck: "false",
                disabled: isSubmitting.value
              }, null, 8, _hoisted_27$1), [
                [vModelText, form.systemInfo]
              ]),
              _cache[20] || (_cache[20] = createBaseVNode("span", { class: "form-hint" }, "This information helps us debug your issue faster", -1))
            ]),
            createBaseVNode("div", _hoisted_28$1, [
              _cache[23] || (_cache[23] = createBaseVNode("label", null, "Screenshots (optional)", -1)),
              createBaseVNode("div", _hoisted_29$1, [
                createBaseVNode("label", {
                  class: normalizeClass(["upload-area", { disabled: isSubmitting.value || screenshots.value.length >= MAX_SCREENSHOTS }])
                }, [
                  createBaseVNode("input", {
                    type: "file",
                    accept: "image/jpeg,image/png,image/gif,image/webp",
                    multiple: "",
                    disabled: isSubmitting.value || screenshots.value.length >= MAX_SCREENSHOTS,
                    onChange: handleScreenshotSelect,
                    class: "file-input"
                  }, null, 40, _hoisted_30$1),
                  _cache[21] || (_cache[21] = createBaseVNode("svg", {
                    width: "24",
                    height: "24",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "2"
                  }, [
                    createBaseVNode("rect", {
                      x: "3",
                      y: "3",
                      width: "18",
                      height: "18",
                      rx: "2",
                      ry: "2"
                    }),
                    createBaseVNode("circle", {
                      cx: "8.5",
                      cy: "8.5",
                      r: "1.5"
                    }),
                    createBaseVNode("polyline", { points: "21 15 16 10 5 21" })
                  ], -1)),
                  screenshots.value.length >= MAX_SCREENSHOTS ? (openBlock(), createElementBlock("span", _hoisted_31$1, "Maximum " + toDisplayString(MAX_SCREENSHOTS) + " screenshots")) : (openBlock(), createElementBlock("span", _hoisted_32$1, "Click to add screenshots (" + toDisplayString(screenshots.value.length) + "/" + toDisplayString(MAX_SCREENSHOTS) + ")", 1))
                ], 2),
                screenshotPreviews.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_33$1, [
                  (openBlock(true), createElementBlock(Fragment, null, renderList(screenshotPreviews.value, (preview, index) => {
                    return openBlock(), createElementBlock("div", {
                      key: index,
                      class: "preview-item"
                    }, [
                      createBaseVNode("img", {
                        src: preview.url,
                        alt: preview.name,
                        class: "preview-image"
                      }, null, 8, _hoisted_34$1),
                      createBaseVNode("div", _hoisted_35$1, [
                        createBaseVNode("span", {
                          class: "preview-name",
                          title: preview.name
                        }, toDisplayString(preview.name), 9, _hoisted_36$1),
                        createBaseVNode("span", _hoisted_37$1, toDisplayString(preview.size), 1)
                      ]),
                      createBaseVNode("button", {
                        type: "button",
                        class: "remove-btn",
                        onClick: ($event) => removeScreenshot(index),
                        disabled: isSubmitting.value,
                        title: "Remove"
                      }, [..._cache[22] || (_cache[22] = [
                        createBaseVNode("svg", {
                          width: "14",
                          height: "14",
                          viewBox: "0 0 24 24",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "2"
                        }, [
                          createBaseVNode("line", {
                            x1: "18",
                            y1: "6",
                            x2: "6",
                            y2: "18"
                          }),
                          createBaseVNode("line", {
                            x1: "6",
                            y1: "6",
                            x2: "18",
                            y2: "18"
                          })
                        ], -1)
                      ])], 8, _hoisted_38$1)
                    ]);
                  }), 128))
                ])) : createCommentVNode("", true),
                createVNode(Transition, { name: "fade" }, {
                  default: withCtx(() => [
                    screenshotError.value ? (openBlock(), createElementBlock("div", _hoisted_39$1, toDisplayString(screenshotError.value), 1)) : createCommentVNode("", true)
                  ]),
                  _: 1
                })
              ]),
              _cache[24] || (_cache[24] = createBaseVNode("span", { class: "form-hint" }, "Max 3 screenshots, 5MB each. JPEG, PNG, GIF, or WebP.", -1))
            ]),
            createVNode(Transition, { name: "fade" }, {
              default: withCtx(() => [
                submitStatus.value ? (openBlock(), createElementBlock("div", {
                  key: 0,
                  class: normalizeClass(["status-message", { error: submitError.value }])
                }, toDisplayString(submitStatus.value), 3)) : createCommentVNode("", true)
              ]),
              _: 1
            }),
            createBaseVNode("button", {
              type: "submit",
              class: "submit-btn nuvu-btn nuvu-btn-primary",
              disabled: isSubmitting.value || !isFormValid.value
            }, toDisplayString(isSubmitting.value ? "Submitting..." : "Submit Support Ticket"), 9, _hoisted_40)
          ], 32),
          _cache[27] || (_cache[27] = createStaticVNode('<div class="alternative-contact" data-v-9b421917><p class="alt-title" data-v-9b421917>Other ways to get help</p><div class="contact-links" data-v-9b421917><a href="https://discord.gg/vdW97AtTAu" target="_blank" rel="noopener noreferrer" class="contact-link" data-v-9b421917><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" data-v-9b421917><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" data-v-9b421917></path></svg><span data-v-9b421917>Discord Community</span></a><a href="mailto:support@nuvulabs.ai" class="contact-link" data-v-9b421917><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" data-v-9b421917><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" data-v-9b421917></path><polyline points="22,6 12,13 2,6" data-v-9b421917></polyline></svg><span data-v-9b421917>support@nuvulabs.ai</span></a></div></div>', 1))
        ])
      ]);
    };
  }
};
const SupportPanel = /* @__PURE__ */ _export_sfc(_sfc_main$5, [["__scopeId", "data-v-9b421917"]]);
const _hoisted_1$3 = { class: "documentation-panel" };
const _hoisted_2$3 = { class: "sections-container" };
const _hoisted_3$2 = { class: "section-title" };
const _hoisted_4$2 = { class: "links-grid" };
const _hoisted_5$2 = ["href"];
const _hoisted_6$2 = { class: "doc-icon" };
const _hoisted_7$2 = {
  key: 0,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_8$2 = {
  key: 1,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_9$1 = {
  key: 2,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_10$1 = {
  key: 3,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_11$1 = {
  key: 4,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_12$1 = {
  key: 5,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_13$1 = {
  key: 6,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_14$1 = {
  key: 7,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_15$1 = {
  key: 8,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_16$1 = {
  key: 9,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_17$1 = {
  key: 10,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "currentColor"
};
const _hoisted_18$1 = {
  key: 11,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "currentColor"
};
const _hoisted_19$1 = {
  key: 12,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_20$1 = {
  key: 13,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_21$1 = {
  key: 14,
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2"
};
const _hoisted_22$1 = { class: "doc-content" };
const _hoisted_23$1 = { class: "doc-title" };
const _hoisted_24 = { class: "doc-description" };
const _hoisted_25 = { class: "changelog-section" };
const _hoisted_26 = {
  key: 0,
  class: "changelog-loading"
};
const _hoisted_27 = {
  key: 1,
  class: "changelog-empty"
};
const _hoisted_28 = {
  key: 2,
  class: "changelog-lists"
};
const _hoisted_29 = {
  key: 0,
  class: "changelog-column"
};
const _hoisted_30 = { class: "changelog-date" };
const _hoisted_31 = { class: "changelog-entries" };
const _hoisted_32 = { class: "changelog-time" };
const _hoisted_33 = { class: "changelog-workflow" };
const _hoisted_34 = {
  key: 1,
  class: "changelog-column"
};
const _hoisted_35 = { class: "changelog-date" };
const _hoisted_36 = { class: "changelog-entries" };
const _hoisted_37 = { class: "changelog-time" };
const _hoisted_38 = { class: "changelog-workflow" };
const _hoisted_39 = {
  key: 0,
  class: "version-info"
};
const _sfc_main$4 = {
  __name: "DocumentationPanel",
  setup(__props) {
    const nuvuVersion = /* @__PURE__ */ ref("");
    const workflowChangelog = /* @__PURE__ */ ref([]);
    const isLoadingChangelog = /* @__PURE__ */ ref(false);
    const groupedCreatedWorkflows = computed(() => {
      return groupByDate(workflowChangelog.value.filter((entry) => entry.action === "created"));
    });
    const groupedUpdatedWorkflows = computed(() => {
      return groupByDate(workflowChangelog.value.filter((entry) => entry.action === "updated"));
    });
    function groupByDate(entries) {
      const grouped = {};
      entries.forEach((entry) => {
        const date = new Date(entry.timestamp);
        const dateKey = date.toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric"
        });
        if (!grouped[dateKey]) {
          grouped[dateKey] = [];
        }
        grouped[dateKey].push({
          ...entry,
          formattedTime: date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit"
          })
        });
      });
      Object.keys(grouped).forEach((dateKey) => {
        grouped[dateKey].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      });
      return Object.entries(grouped).map(([date, entries2]) => ({ date, entries: entries2 })).sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
    }
    async function fetchWorkflowChangelog() {
      isLoadingChangelog.value = true;
      try {
        const token = await getApiToken();
        if (!token) {
          return;
        }
        const response = await fetch("/nuvu/workflow-changelog", {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        });
        if (response.ok) {
          const data = await response.json();
          workflowChangelog.value = data.entries || [];
        }
      } catch (error) {
        console.warn("Failed to fetch workflow changelog:", error);
      } finally {
        isLoadingChangelog.value = false;
      }
    }
    onMounted(async () => {
      try {
        const response = await fetch("/nuvu/config");
        if (response.ok) {
          const config = await response.json();
          nuvuVersion.value = config.version || "";
        }
      } catch {
      }
      fetchWorkflowChangelog();
    });
    const sections = [
      {
        title: "Getting Started",
        links: [
          {
            title: "Welcome to Nuvu",
            description: "Learn about Nuvu and the advantages for film and VFX artists",
            url: "https://docs.nuvulabs.ai/",
            iconType: "info"
          },
          {
            title: "The Nuvu Advantage",
            description: "See how Nuvu makes AI workflows effortless",
            url: "https://docs.nuvulabs.ai/the-nuvu-advantage",
            iconType: "star"
          },
          {
            title: "Installation Guide",
            description: "Auto-installers, Comfy Manager, and manual installation options",
            url: "https://docs.nuvulabs.ai/installation",
            iconType: "download"
          },
          {
            title: "RunPod Template",
            description: "Deploy ComfyUI with Nuvu in the cloud instantly",
            url: "https://docs.nuvulabs.ai/installation/runpod",
            iconType: "cloud"
          }
        ]
      },
      {
        title: "Account & Subscription",
        links: [
          {
            title: "Account Dashboard",
            description: "Manage your subscription and account settings",
            url: "https://app.nuvulabs.ai",
            iconType: "user"
          },
          {
            title: "Free vs Premium Features",
            description: "Compare features available on free and premium plans",
            url: "https://docs.nuvulabs.ai/account",
            iconType: "star"
          },
          {
            title: "Create an Account",
            description: "Step-by-step guide to create your free account",
            url: "https://docs.nuvulabs.ai/account/create-account",
            iconType: "user"
          },
          {
            title: "Subscribe to Premium",
            description: "Upgrade to Nuvu Premium for full access",
            url: "https://docs.nuvulabs.ai/account/subscribe",
            iconType: "credit"
          }
        ]
      },
      {
        title: "Using Nuvu",
        links: [
          {
            title: "Workflow Installer",
            description: "Install workflows with all dependencies in one click",
            url: "https://docs.nuvulabs.ai/features/workflow-installer",
            iconType: "workflow"
          },
          {
            title: "Subgraphs",
            description: "Use pre-built subgraphs as searchable nodes",
            url: "https://docs.nuvulabs.ai/features/subgraphs",
            iconType: "node"
          },
          {
            title: "Install Missing",
            description: "Auto-detect and install missing dependencies",
            url: "https://docs.nuvulabs.ai/features/install-missing",
            iconType: "download"
          },
          {
            title: "Model Installer",
            description: "Browse and install 2000+ models",
            url: "https://docs.nuvulabs.ai/features/model-installer",
            iconType: "model"
          },
          {
            title: "ComfyUI Optimizer",
            description: "Performance tools and system utilities",
            url: "https://docs.nuvulabs.ai/features/comfyui-optimizer",
            iconType: "settings"
          },
          {
            title: "User Configuration",
            description: "Manage devices, tokens, and model paths",
            url: "https://docs.nuvulabs.ai/features/user-configuration",
            iconType: "settings"
          }
        ]
      },
      {
        title: "Help & Community",
        links: [
          {
            title: "How Can We Help?",
            description: "Professional services and consulting from Nuvu Labs",
            url: "https://docs.nuvulabs.ai/support/how-can-we-help",
            iconType: "info"
          },
          {
            title: "Getting Support",
            description: "Get help from the Nuvu Labs team",
            url: "https://docs.nuvulabs.ai/support",
            iconType: "email"
          },
          {
            title: "Community Discord",
            description: "Join our community for help and discussions",
            url: "https://discord.gg/vdW97AtTAu",
            iconType: "discord"
          },
          {
            title: "GitHub Repository",
            description: "Source code, issues, and contributions",
            url: "https://github.com/nuvulabs/ComfyUI-nuvu",
            iconType: "github"
          },
          {
            title: "Report an Issue",
            description: "Found a bug? Let us know on GitHub",
            url: "https://github.com/nuvulabs/ComfyUI-nuvu/issues/new",
            iconType: "bug"
          },
          {
            title: "Releases & Changelog",
            description: "See what's new in each release",
            url: "https://github.com/nuvulabs/ComfyUI-nuvu/releases",
            iconType: "changelog"
          }
        ]
      }
    ];
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$3, [
        _cache[21] || (_cache[21] = createBaseVNode("h3", { class: "panel-title" }, "Documentation", -1)),
        _cache[22] || (_cache[22] = createBaseVNode("p", { class: "intro-text" }, " Nuvu makes private AI generation in ComfyUI effortless - built for film and VFX artists who demand privacy, polish, and more time to create. ", -1)),
        createBaseVNode("div", _hoisted_2$3, [
          (openBlock(), createElementBlock(Fragment, null, renderList(sections, (section) => {
            return createBaseVNode("div", {
              key: section.title,
              class: "doc-section"
            }, [
              createBaseVNode("h4", _hoisted_3$2, toDisplayString(section.title), 1),
              createBaseVNode("div", _hoisted_4$2, [
                (openBlock(true), createElementBlock(Fragment, null, renderList(section.links, (link) => {
                  return openBlock(), createElementBlock("a", {
                    key: link.url,
                    href: link.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    class: "doc-card"
                  }, [
                    createBaseVNode("div", _hoisted_6$2, [
                      link.iconType === "info" ? (openBlock(), createElementBlock("svg", _hoisted_7$2, [..._cache[0] || (_cache[0] = [
                        createBaseVNode("circle", {
                          cx: "12",
                          cy: "12",
                          r: "10"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "12",
                          y1: "16",
                          x2: "12",
                          y2: "12"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "12",
                          y1: "8",
                          x2: "12.01",
                          y2: "8"
                        }, null, -1)
                      ])])) : link.iconType === "download" ? (openBlock(), createElementBlock("svg", _hoisted_8$2, [..._cache[1] || (_cache[1] = [
                        createBaseVNode("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }, null, -1),
                        createBaseVNode("polyline", { points: "7 10 12 15 17 10" }, null, -1),
                        createBaseVNode("line", {
                          x1: "12",
                          y1: "15",
                          x2: "12",
                          y2: "3"
                        }, null, -1)
                      ])])) : link.iconType === "cloud" ? (openBlock(), createElementBlock("svg", _hoisted_9$1, [..._cache[2] || (_cache[2] = [
                        createBaseVNode("path", { d: "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" }, null, -1)
                      ])])) : link.iconType === "user" ? (openBlock(), createElementBlock("svg", _hoisted_10$1, [..._cache[3] || (_cache[3] = [
                        createBaseVNode("path", { d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }, null, -1),
                        createBaseVNode("circle", {
                          cx: "12",
                          cy: "7",
                          r: "4"
                        }, null, -1)
                      ])])) : link.iconType === "star" ? (openBlock(), createElementBlock("svg", _hoisted_11$1, [..._cache[4] || (_cache[4] = [
                        createBaseVNode("polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }, null, -1)
                      ])])) : link.iconType === "credit" ? (openBlock(), createElementBlock("svg", _hoisted_12$1, [..._cache[5] || (_cache[5] = [
                        createBaseVNode("rect", {
                          x: "1",
                          y: "4",
                          width: "22",
                          height: "16",
                          rx: "2",
                          ry: "2"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "1",
                          y1: "10",
                          x2: "23",
                          y2: "10"
                        }, null, -1)
                      ])])) : link.iconType === "workflow" ? (openBlock(), createElementBlock("svg", _hoisted_13$1, [..._cache[6] || (_cache[6] = [
                        createStaticVNode('<polyline points="16 3 21 3 21 8" data-v-fe4a71d6></polyline><line x1="4" y1="20" x2="21" y2="3" data-v-fe4a71d6></line><polyline points="21 16 21 21 16 21" data-v-fe4a71d6></polyline><line x1="15" y1="15" x2="21" y2="21" data-v-fe4a71d6></line><line x1="4" y1="4" x2="9" y2="9" data-v-fe4a71d6></line>', 5)
                      ])])) : link.iconType === "node" ? (openBlock(), createElementBlock("svg", _hoisted_14$1, [..._cache[7] || (_cache[7] = [
                        createBaseVNode("rect", {
                          x: "3",
                          y: "3",
                          width: "7",
                          height: "7"
                        }, null, -1),
                        createBaseVNode("rect", {
                          x: "14",
                          y: "3",
                          width: "7",
                          height: "7"
                        }, null, -1),
                        createBaseVNode("rect", {
                          x: "14",
                          y: "14",
                          width: "7",
                          height: "7"
                        }, null, -1),
                        createBaseVNode("rect", {
                          x: "3",
                          y: "14",
                          width: "7",
                          height: "7"
                        }, null, -1)
                      ])])) : link.iconType === "model" ? (openBlock(), createElementBlock("svg", _hoisted_15$1, [..._cache[8] || (_cache[8] = [
                        createBaseVNode("rect", {
                          x: "2",
                          y: "3",
                          width: "20",
                          height: "14",
                          rx: "2",
                          ry: "2"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "8",
                          y1: "21",
                          x2: "16",
                          y2: "21"
                        }, null, -1),
                        createBaseVNode("line", {
                          x1: "12",
                          y1: "17",
                          x2: "12",
                          y2: "21"
                        }, null, -1)
                      ])])) : link.iconType === "settings" ? (openBlock(), createElementBlock("svg", _hoisted_16$1, [..._cache[9] || (_cache[9] = [
                        createBaseVNode("circle", {
                          cx: "12",
                          cy: "12",
                          r: "3"
                        }, null, -1),
                        createBaseVNode("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" }, null, -1)
                      ])])) : link.iconType === "github" ? (openBlock(), createElementBlock("svg", _hoisted_17$1, [..._cache[10] || (_cache[10] = [
                        createBaseVNode("path", { d: "M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" }, null, -1)
                      ])])) : link.iconType === "discord" ? (openBlock(), createElementBlock("svg", _hoisted_18$1, [..._cache[11] || (_cache[11] = [
                        createBaseVNode("path", { d: "M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" }, null, -1)
                      ])])) : link.iconType === "bug" ? (openBlock(), createElementBlock("svg", _hoisted_19$1, [..._cache[12] || (_cache[12] = [
                        createStaticVNode('<rect x="8" y="6" width="8" height="14" rx="4" data-v-fe4a71d6></rect><path d="M6 12H2" data-v-fe4a71d6></path><path d="M22 12h-4" data-v-fe4a71d6></path><path d="M9 6V3" data-v-fe4a71d6></path><path d="M15 6V3" data-v-fe4a71d6></path><path d="M6 18l-2 2" data-v-fe4a71d6></path><path d="M18 18l2 2" data-v-fe4a71d6></path><path d="M6 6L4 4" data-v-fe4a71d6></path><path d="M18 6l2-2" data-v-fe4a71d6></path>', 9)
                      ])])) : link.iconType === "changelog" ? (openBlock(), createElementBlock("svg", _hoisted_20$1, [..._cache[13] || (_cache[13] = [
                        createStaticVNode('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" data-v-fe4a71d6></path><polyline points="14 2 14 8 20 8" data-v-fe4a71d6></polyline><line x1="16" y1="13" x2="8" y2="13" data-v-fe4a71d6></line><line x1="16" y1="17" x2="8" y2="17" data-v-fe4a71d6></line><polyline points="10 9 9 9 8 9" data-v-fe4a71d6></polyline>', 5)
                      ])])) : link.iconType === "email" ? (openBlock(), createElementBlock("svg", _hoisted_21$1, [..._cache[14] || (_cache[14] = [
                        createBaseVNode("path", { d: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" }, null, -1),
                        createBaseVNode("polyline", { points: "22,6 12,13 2,6" }, null, -1)
                      ])])) : createCommentVNode("", true)
                    ]),
                    createBaseVNode("div", _hoisted_22$1, [
                      createBaseVNode("h4", _hoisted_23$1, toDisplayString(link.title), 1),
                      createBaseVNode("p", _hoisted_24, toDisplayString(link.description), 1)
                    ]),
                    _cache[15] || (_cache[15] = createBaseVNode("svg", {
                      class: "doc-arrow",
                      width: "20",
                      height: "20",
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      "stroke-width": "2"
                    }, [
                      createBaseVNode("line", {
                        x1: "5",
                        y1: "12",
                        x2: "19",
                        y2: "12"
                      }),
                      createBaseVNode("polyline", { points: "12 5 19 12 12 19" })
                    ], -1))
                  ], 8, _hoisted_5$2);
                }), 128))
              ])
            ]);
          }), 64))
        ]),
        createBaseVNode("div", _hoisted_25, [
          _cache[20] || (_cache[20] = createBaseVNode("h4", { class: "section-title" }, "Workflow Updates", -1)),
          isLoadingChangelog.value ? (openBlock(), createElementBlock("div", _hoisted_26, " Loading changelog... ")) : groupedCreatedWorkflows.value.length === 0 && groupedUpdatedWorkflows.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_27, " No recent workflow changes. ")) : (openBlock(), createElementBlock("div", _hoisted_28, [
            groupedCreatedWorkflows.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_29, [
              _cache[17] || (_cache[17] = createBaseVNode("h5", { class: "changelog-subtitle" }, "Recently Created", -1)),
              (openBlock(true), createElementBlock(Fragment, null, renderList(groupedCreatedWorkflows.value, (group) => {
                return openBlock(), createElementBlock("div", {
                  key: "created-" + group.date,
                  class: "changelog-day"
                }, [
                  createBaseVNode("div", _hoisted_30, toDisplayString(group.date), 1),
                  createBaseVNode("div", _hoisted_31, [
                    (openBlock(true), createElementBlock(Fragment, null, renderList(group.entries, (entry) => {
                      return openBlock(), createElementBlock("div", {
                        key: entry.timestamp,
                        class: "changelog-entry"
                      }, [
                        createBaseVNode("span", _hoisted_32, toDisplayString(entry.formattedTime), 1),
                        createBaseVNode("span", _hoisted_33, toDisplayString(entry.workflowName), 1),
                        _cache[16] || (_cache[16] = createBaseVNode("span", { class: "changelog-action created" }, "created", -1))
                      ]);
                    }), 128))
                  ])
                ]);
              }), 128))
            ])) : createCommentVNode("", true),
            groupedUpdatedWorkflows.value.length > 0 ? (openBlock(), createElementBlock("div", _hoisted_34, [
              _cache[19] || (_cache[19] = createBaseVNode("h5", { class: "changelog-subtitle" }, "Recently Updated", -1)),
              (openBlock(true), createElementBlock(Fragment, null, renderList(groupedUpdatedWorkflows.value, (group) => {
                return openBlock(), createElementBlock("div", {
                  key: "updated-" + group.date,
                  class: "changelog-day"
                }, [
                  createBaseVNode("div", _hoisted_35, toDisplayString(group.date), 1),
                  createBaseVNode("div", _hoisted_36, [
                    (openBlock(true), createElementBlock(Fragment, null, renderList(group.entries, (entry) => {
                      return openBlock(), createElementBlock("div", {
                        key: entry.timestamp,
                        class: "changelog-entry"
                      }, [
                        createBaseVNode("span", _hoisted_37, toDisplayString(entry.formattedTime), 1),
                        createBaseVNode("span", _hoisted_38, toDisplayString(entry.workflowName), 1),
                        _cache[18] || (_cache[18] = createBaseVNode("span", { class: "changelog-action updated" }, "updated", -1))
                      ]);
                    }), 128))
                  ])
                ]);
              }), 128))
            ])) : createCommentVNode("", true)
          ]))
        ]),
        nuvuVersion.value ? (openBlock(), createElementBlock("div", _hoisted_39, " ComfyUI-Nuvu v" + toDisplayString(nuvuVersion.value), 1)) : createCommentVNode("", true)
      ]);
    };
  }
};
const DocumentationPanel = /* @__PURE__ */ _export_sfc(_sfc_main$4, [["__scopeId", "data-v-fe4a71d6"]]);
const _hoisted_1$2 = { class: "modal-content" };
const _hoisted_2$2 = { class: "modal-title" };
const _hoisted_3$1 = { class: "summary-box" };
const _hoisted_4$1 = { class: "summary-header" };
const _hoisted_5$1 = { class: "summary-rows" };
const _hoisted_6$1 = {
  key: 0,
  class: "summary-row"
};
const _hoisted_7$1 = { class: "summary-value" };
const _hoisted_8$1 = {
  key: 1,
  class: "summary-row"
};
const _hoisted_9 = { class: "summary-value" };
const _hoisted_10 = {
  key: 2,
  class: "summary-row"
};
const _hoisted_11 = { class: "summary-value" };
const _hoisted_12 = { class: "summary-row" };
const _hoisted_13 = { class: "summary-value" };
const _hoisted_14 = {
  key: 0,
  class: "failed-section"
};
const _hoisted_15 = {
  key: 0,
  class: "failed-group"
};
const _hoisted_16 = {
  key: 1,
  class: "failed-group"
};
const _hoisted_17 = {
  key: 2,
  class: "failed-group"
};
const _hoisted_18 = {
  key: 3,
  class: "failed-group"
};
const _hoisted_19 = {
  key: 1,
  class: "failed-section warnings-section"
};
const _hoisted_20 = {
  key: 0,
  class: "status-spinner"
};
const _hoisted_21 = {
  key: 3,
  class: "restart-notice"
};
const _hoisted_22 = {
  key: 4,
  class: "restart-notice"
};
const _hoisted_23 = { class: "modal-actions" };
const _sfc_main$3 = {
  __name: "InstallationSummaryModal",
  props: {
    summary: {
      type: Object,
      required: true
    },
    warnings: {
      type: Array,
      default: () => []
    },
    modelsOnly: {
      type: Boolean,
      default: false
    }
  },
  emits: ["close", "restart"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const status = /* @__PURE__ */ ref("ready");
    const statusMessage = /* @__PURE__ */ ref("");
    let reconnectInterval = null;
    const allSuccess = computed(() => props.summary?.all_success ?? false);
    const totalSuccess = computed(() => props.summary?.total_success ?? 0);
    const totalCount = computed(() => props.summary?.total_count ?? 0);
    const failedItems = computed(() => props.summary?.failed_items ?? {});
    const hasFailures = computed(() => {
      const items = failedItems.value;
      return items.workflows?.length > 0 || items.subgraphs?.length > 0 || items.custom_nodes?.length > 0 || items.models?.length > 0;
    });
    const hasWarnings = computed(() => Array.isArray(props.warnings) && props.warnings.length > 0);
    const summaryMessage = computed(() => {
      if (props.modelsOnly) {
        if (allSuccess.value) {
          return `All ${totalSuccess.value} model${totalSuccess.value !== 1 ? "s" : ""} downloaded successfully!`;
        }
        return `${totalSuccess.value}/${totalCount.value} models downloaded`;
      }
      if (allSuccess.value) {
        return `All ${totalSuccess.value} components installed successfully!`;
      }
      return `${totalSuccess.value}/${totalCount.value} components installed successfully`;
    });
    const modalTitle = computed(() => props.modelsOnly ? "Download Complete" : "Installation Complete");
    const summaryHeader = computed(() => props.modelsOnly ? "DOWNLOAD SUMMARY" : "INSTALLATION SUMMARY");
    const hasPendingModelFixes = computed(() => {
      try {
        const raw = window.localStorage.getItem("nuvu_pending_model_name_fixes");
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.fixes) && parsed.fixes.length > 0;
      } catch {
        return false;
      }
    });
    async function checkConnection() {
      try {
        const response = await fetch("/system_stats", {
          method: "GET",
          cache: "no-store"
        });
        return response.ok;
      } catch {
        return false;
      }
    }
    function startReconnectPolling() {
      status.value = "reconnecting";
      statusMessage.value = "Waiting for ComfyUI to come back online...";
      reconnectInterval = setInterval(async () => {
        const isOnline = await checkConnection();
        if (isOnline) {
          clearInterval(reconnectInterval);
          reconnectInterval = null;
          status.value = "complete";
          statusMessage.value = 'ComfyUI is back online! Click "Refresh Now" to continue.';
        }
      }, 2e3);
    }
    async function handleRestart() {
      status.value = "restarting";
      statusMessage.value = "Restarting ComfyUI. Keep this tab open...";
      try {
        await fetch("/nuvu/restart", { method: "GET" });
      } catch (error) {
        console.log("[nuvu] Restart request sent");
      }
      emit2("restart");
      setTimeout(() => {
        startReconnectPolling();
      }, 3e3);
    }
    async function handleRefresh() {
      try {
        await fetch("/nuvu/queue/clear-summary", { method: "POST" });
      } catch {
      }
      try {
        window.localStorage.setItem("nuvu_show_splash_after_refresh", "true");
      } catch {
      }
      window.location.reload();
    }
    function handleClose() {
      if (status.value === "restarting" || status.value === "reconnecting") {
        return;
      }
      emit2("close");
    }
    let mouseDownOnOverlay = false;
    function handleOverlayMouseDown(event) {
      mouseDownOnOverlay = event.target === event.currentTarget;
    }
    function handleOverlayMouseUp(event) {
      if (mouseDownOnOverlay && event.target === event.currentTarget) {
        handleClose();
      }
      mouseDownOnOverlay = false;
    }
    onUnmounted(() => {
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
      }
    });
    return (_ctx, _cache) => {
      return openBlock(), createBlock(Teleport, { to: "body" }, [
        createBaseVNode("div", {
          class: "modal-overlay",
          onMousedown: handleOverlayMouseDown,
          onMouseup: handleOverlayMouseUp
        }, [
          createBaseVNode("div", _hoisted_1$2, [
            createBaseVNode("h2", _hoisted_2$2, toDisplayString(modalTitle.value), 1),
            createBaseVNode("div", _hoisted_3$1, [
              createBaseVNode("div", _hoisted_4$1, toDisplayString(summaryHeader.value), 1),
              _cache[4] || (_cache[4] = createBaseVNode("div", { class: "summary-divider" }, null, -1)),
              createBaseVNode("div", _hoisted_5$1, [
                !__props.modelsOnly ? (openBlock(), createElementBlock("div", _hoisted_6$1, [
                  _cache[0] || (_cache[0] = createBaseVNode("span", { class: "summary-label" }, "Workflows:", -1)),
                  createBaseVNode("span", _hoisted_7$1, toDisplayString(__props.summary.workflows?.current ?? 0) + "/" + toDisplayString(__props.summary.workflows?.total ?? 0), 1)
                ])) : createCommentVNode("", true),
                !__props.modelsOnly ? (openBlock(), createElementBlock("div", _hoisted_8$1, [
                  _cache[1] || (_cache[1] = createBaseVNode("span", { class: "summary-label" }, "Subgraphs:", -1)),
                  createBaseVNode("span", _hoisted_9, toDisplayString(__props.summary.subgraphs?.current ?? 0) + "/" + toDisplayString(__props.summary.subgraphs?.total ?? 0), 1)
                ])) : createCommentVNode("", true),
                !__props.modelsOnly ? (openBlock(), createElementBlock("div", _hoisted_10, [
                  _cache[2] || (_cache[2] = createBaseVNode("span", { class: "summary-label" }, "Custom Nodes:", -1)),
                  createBaseVNode("span", _hoisted_11, toDisplayString(__props.summary.custom_nodes?.current ?? 0) + "/" + toDisplayString(__props.summary.custom_nodes?.total ?? 0), 1)
                ])) : createCommentVNode("", true),
                createBaseVNode("div", _hoisted_12, [
                  _cache[3] || (_cache[3] = createBaseVNode("span", { class: "summary-label" }, "Models:", -1)),
                  createBaseVNode("span", _hoisted_13, toDisplayString(__props.summary.models?.current ?? 0) + "/" + toDisplayString(__props.summary.models?.total ?? 0), 1)
                ])
              ]),
              _cache[5] || (_cache[5] = createBaseVNode("div", { class: "summary-divider" }, null, -1)),
              createBaseVNode("div", {
                class: normalizeClass(["summary-result", { success: allSuccess.value, partial: !allSuccess.value }])
              }, toDisplayString(summaryMessage.value), 3)
            ]),
            hasFailures.value ? (openBlock(), createElementBlock("div", _hoisted_14, [
              _cache[10] || (_cache[10] = createBaseVNode("div", { class: "failed-header" }, "Failed Components", -1)),
              failedItems.value.workflows?.length ? (openBlock(), createElementBlock("div", _hoisted_15, [
                _cache[6] || (_cache[6] = createBaseVNode("div", { class: "failed-category" }, "Workflows:", -1)),
                (openBlock(true), createElementBlock(Fragment, null, renderList(failedItems.value.workflows, (name) => {
                  return openBlock(), createElementBlock("div", {
                    key: "wf-" + name,
                    class: "failed-item"
                  }, toDisplayString(name), 1);
                }), 128))
              ])) : createCommentVNode("", true),
              failedItems.value.subgraphs?.length ? (openBlock(), createElementBlock("div", _hoisted_16, [
                _cache[7] || (_cache[7] = createBaseVNode("div", { class: "failed-category" }, "Subgraphs:", -1)),
                (openBlock(true), createElementBlock(Fragment, null, renderList(failedItems.value.subgraphs, (name) => {
                  return openBlock(), createElementBlock("div", {
                    key: "sg-" + name,
                    class: "failed-item"
                  }, toDisplayString(name), 1);
                }), 128))
              ])) : createCommentVNode("", true),
              failedItems.value.custom_nodes?.length ? (openBlock(), createElementBlock("div", _hoisted_17, [
                _cache[8] || (_cache[8] = createBaseVNode("div", { class: "failed-category" }, "Custom Nodes:", -1)),
                (openBlock(true), createElementBlock(Fragment, null, renderList(failedItems.value.custom_nodes, (name) => {
                  return openBlock(), createElementBlock("div", {
                    key: "cn-" + name,
                    class: "failed-item"
                  }, toDisplayString(name), 1);
                }), 128))
              ])) : createCommentVNode("", true),
              failedItems.value.models?.length ? (openBlock(), createElementBlock("div", _hoisted_18, [
                _cache[9] || (_cache[9] = createBaseVNode("div", { class: "failed-category" }, "Models:", -1)),
                (openBlock(true), createElementBlock(Fragment, null, renderList(failedItems.value.models, (name) => {
                  return openBlock(), createElementBlock("div", {
                    key: "m-" + name,
                    class: "failed-item"
                  }, toDisplayString(name), 1);
                }), 128))
              ])) : createCommentVNode("", true)
            ])) : createCommentVNode("", true),
            hasWarnings.value ? (openBlock(), createElementBlock("div", _hoisted_19, [
              _cache[11] || (_cache[11] = createBaseVNode("div", { class: "failed-header" }, "Warnings", -1)),
              (openBlock(true), createElementBlock(Fragment, null, renderList(__props.warnings, (w, idx) => {
                return openBlock(), createElementBlock("div", {
                  key: "warn-" + idx,
                  class: "failed-item"
                }, toDisplayString(w), 1);
              }), 128))
            ])) : createCommentVNode("", true),
            status.value !== "ready" && !__props.modelsOnly ? (openBlock(), createElementBlock("div", {
              key: 2,
              class: normalizeClass(["status-message", status.value])
            }, [
              status.value === "restarting" || status.value === "reconnecting" ? (openBlock(), createElementBlock("div", _hoisted_20)) : createCommentVNode("", true),
              createTextVNode(" " + toDisplayString(statusMessage.value), 1)
            ], 2)) : createCommentVNode("", true),
            status.value === "ready" && !__props.modelsOnly ? (openBlock(), createElementBlock("p", _hoisted_21, " A restart is recommended to apply custom node changes. ")) : createCommentVNode("", true),
            status.value === "ready" && hasPendingModelFixes.value ? (openBlock(), createElementBlock("p", _hoisted_22, " After restarting and refreshing, Nuvu will automatically fix workflow model name references. ")) : createCommentVNode("", true),
            createBaseVNode("div", _hoisted_23, [
              __props.modelsOnly ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [
                createBaseVNode("button", {
                  class: "modal-btn later-btn",
                  onClick: handleClose
                }, " Close "),
                createBaseVNode("button", {
                  class: "modal-btn refresh-btn",
                  onClick: handleRefresh
                }, " Refresh ")
              ], 64)) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [
                status.value === "ready" ? (openBlock(), createElementBlock("button", {
                  key: 0,
                  class: "modal-btn later-btn",
                  onClick: handleClose
                }, " Later ")) : createCommentVNode("", true),
                status.value === "ready" ? (openBlock(), createElementBlock("button", {
                  key: 1,
                  class: "modal-btn restart-btn",
                  onClick: handleRestart
                }, " Restart ComfyUI ")) : createCommentVNode("", true),
                status.value === "complete" ? (openBlock(), createElementBlock("button", {
                  key: 2,
                  class: "modal-btn refresh-btn",
                  onClick: handleRefresh
                }, " Refresh Now ")) : createCommentVNode("", true)
              ], 64))
            ])
          ])
        ], 32)
      ]);
    };
  }
};
const InstallationSummaryModal = /* @__PURE__ */ _export_sfc(_sfc_main$3, [["__scopeId", "data-v-f96caa4a"]]);
const _sfc_main$2 = {
  __name: "QueueProgressProvider",
  setup(__props) {
    const status = /* @__PURE__ */ ref(null);
    const lastError = /* @__PURE__ */ ref(null);
    const isActive = computed(() => {
      const s = status.value;
      if (!s) return false;
      return Boolean(
        s.is_processing || (s.running_count || 0) > 0 || (s.queue_size || 0) > 0 || (s.in_progress_count || 0) > 0
      );
    });
    const downloadProgress = computed(() => status.value?.download_progress || null);
    const installationSummary = computed(() => status.value?.installation_summary || null);
    const warnings = computed(() => status.value?.warnings || []);
    const backendError = computed(() => status.value?.error || null);
    const showSummaryModal = /* @__PURE__ */ ref(false);
    const pollingEnabled = /* @__PURE__ */ ref(false);
    const idleTicks2 = /* @__PURE__ */ ref(0);
    const modelsOnlyForSummary = computed(() => {
      const summary = installationSummary.value;
      if (!summary) return false;
      const wfTotal = summary.workflows?.total ?? 0;
      const sgTotal = summary.subgraphs?.total ?? 0;
      const cnTotal = summary.custom_nodes?.total ?? 0;
      const mTotal = summary.models?.total ?? 0;
      return wfTotal === 0 && sgTotal === 0 && cnTotal === 0 && mTotal > 0;
    });
    async function pollOnce2() {
      try {
        const resp = await fetch("/nuvu/queue/status", { cache: "no-store" });
        if (!resp.ok) {
          lastError.value = `Queue status failed: ${resp.status}`;
          return;
        }
        status.value = await resp.json();
        lastError.value = null;
        if (pollingEnabled.value) {
          if (isActive.value) {
            idleTicks2.value = 0;
          } else {
            idleTicks2.value += 1;
            if (idleTicks2.value >= 2) {
              stopPolling2();
            }
          }
        }
      } catch (e) {
        lastError.value = e?.message || String(e);
      }
    }
    async function clearSummary() {
      try {
        await fetch("/nuvu/queue/clear-summary", { method: "POST" });
      } catch {
      }
      if (status.value) {
        status.value = { ...status.value, installation_summary: null };
      }
    }
    async function clearError() {
      try {
        await fetch("/nuvu/queue/clear-error", { method: "POST" });
      } catch {
      }
      if (status.value) {
        status.value = { ...status.value, error: null, completed: false };
      }
    }
    function closeSummaryModal() {
      showSummaryModal.value = false;
      clearSummary();
    }
    function handleSummaryRestart() {
    }
    let pollTimer2 = null;
    function startPolling() {
      if (pollingEnabled.value) return;
      pollingEnabled.value = true;
      idleTicks2.value = 0;
      pollOnce2();
      if (pollTimer2) {
        clearInterval(pollTimer2);
        pollTimer2 = null;
      }
      pollTimer2 = setInterval(() => {
        pollOnce2();
      }, 1e3);
    }
    function stopPolling2() {
      pollingEnabled.value = false;
      idleTicks2.value = 0;
      if (pollTimer2) {
        clearInterval(pollTimer2);
        pollTimer2 = null;
      }
    }
    async function handleDialogOpen() {
      await pollOnce2();
      if (isActive.value || installationSummary.value) {
        startPolling();
      }
    }
    onMounted(async () => {
      await pollOnce2();
      if (isActive.value || installationSummary.value) {
        startPolling();
      }
      window.addEventListener("nuvu-vue-open", handleDialogOpen);
    });
    onUnmounted(() => {
      if (pollTimer2) {
        clearInterval(pollTimer2);
        pollTimer2 = null;
      }
      window.removeEventListener("nuvu-vue-open", handleDialogOpen);
    });
    watch(
      () => installationSummary.value,
      (next) => {
        if (next) {
          showSummaryModal.value = true;
        }
      }
    );
    provide(QUEUE_PROGRESS_KEY, {
      status,
      isActive,
      downloadProgress,
      installationSummary,
      warnings,
      backendError,
      lastError,
      pollOnce: pollOnce2,
      startPolling,
      stopPolling: stopPolling2,
      pollingEnabled,
      clearSummary,
      clearError
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock(Fragment, null, [
        renderSlot(_ctx.$slots, "default"),
        showSummaryModal.value && installationSummary.value ? (openBlock(), createBlock(InstallationSummaryModal, {
          key: 0,
          summary: installationSummary.value,
          "models-only": modelsOnlyForSummary.value,
          warnings: warnings.value,
          onClose: closeSummaryModal,
          onRestart: handleSummaryRestart
        }, null, 8, ["summary", "models-only", "warnings"])) : createCommentVNode("", true)
      ], 64);
    };
  }
};
const _hoisted_1$1 = { class: "dashboard" };
const _hoisted_2$1 = { class: "main-content" };
const _sfc_main$1 = {
  __name: "Dashboard",
  props: {
    user: {
      type: Object,
      default: () => ({ name: "User" })
    },
    licenseStatus: {
      type: Object,
      default: null
    }
  },
  emits: ["logout", "close", "retry-floating"],
  setup(__props, { emit: __emit }) {
    const props = __props;
    const emit2 = __emit;
    const activeTab = /* @__PURE__ */ ref("workflows");
    const showRestartConfirm = /* @__PURE__ */ ref(false);
    const showRefreshConfirm = /* @__PURE__ */ ref(false);
    const nuvuUpdateAvailable = /* @__PURE__ */ ref(false);
    const deviceRegistered = /* @__PURE__ */ ref(true);
    const nuvuVersions = /* @__PURE__ */ ref(null);
    const isLoadingnuvuVersions = /* @__PURE__ */ ref(false);
    const tabs = [
      { id: "workflows", label: "Workflows" },
      { id: "install-missing", label: "Install Missing" },
      { id: "models", label: "Models" },
      { id: "optimizer", label: "ComfyUI Optimizer" },
      { id: "user-config", label: "User Configuration" },
      { id: "help", label: "How can we help?" },
      { id: "support", label: "Support" },
      { id: "documentation", label: "Documentation" }
    ];
    provide("activeTab", activeTab);
    provide("user", props.user);
    provide("licenseStatus", props.licenseStatus);
    provide("nuvuUpdateAvailable", nuvuUpdateAvailable);
    provide("nuvuVersions", nuvuVersions);
    provide("isLoadingnuvuVersions", isLoadingnuvuVersions);
    async function loadnuvuVersions() {
      if (isLoadingnuvuVersions.value) return;
      isLoadingnuvuVersions.value = true;
      try {
        const resp = await fetch("/nuvu/check-versions", { cache: "no-store" });
        if (resp.ok) {
          nuvuVersions.value = await resp.json();
        }
      } catch {
      } finally {
        isLoadingnuvuVersions.value = false;
      }
    }
    provide("loadnuvuVersions", loadnuvuVersions);
    onMounted(() => {
      checknuvuUpdates();
      checkDeviceRegistration();
      applyPendingModelNameFixes();
      loadnuvuVersions();
    });
    async function applyPendingModelNameFixes() {
      let payload = null;
      try {
        const raw = window.localStorage.getItem("nuvu_pending_model_name_fixes");
        if (!raw) return;
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      const fixes = Array.isArray(payload?.fixes) ? payload.fixes : [];
      if (fixes.length === 0) {
        try {
          window.localStorage.removeItem("nuvu_pending_model_name_fixes");
        } catch {
        }
        return;
      }
      try {
        const { app: app2 } = await import("/scripts/app.js");
        if (!app2?.graph?._nodes) return;
        let totalFixed = 0;
        for (const fix of fixes) {
          const searchPath = fix?.searchPath;
          const newName = fix?.newName;
          if (typeof searchPath !== "string" || typeof newName !== "string" || !searchPath || !newName) continue;
          const searchBase = searchPath.split(/[/\\]/).pop();
          for (const node of app2.graph._nodes) {
            if (!node?.widgets) continue;
            for (const widget of node.widgets) {
              if (typeof widget?.value !== "string") continue;
              const valBase = widget.value.split(/[/\\]/).pop();
              if (widget.value === searchPath || valBase === searchBase) {
                widget.value = newName;
                totalFixed++;
                if (widget.callback) {
                  try {
                    widget.callback(newName);
                  } catch {
                  }
                }
              }
            }
          }
        }
        if (totalFixed > 0) {
          app2.graph.change();
        }
        try {
          window.localStorage.removeItem("nuvu_pending_model_name_fixes");
        } catch {
        }
      } catch {
      }
    }
    async function checknuvuUpdates() {
      try {
        const response = await fetch("/nuvu/check-nuvu-updates");
        if (response.ok) {
          const data = await response.json();
          nuvuUpdateAvailable.value = data.updatesAvailable === true;
        }
      } catch (error) {
        nuvuUpdateAvailable.value = false;
      }
    }
    async function checkDeviceRegistration() {
      try {
        const identityResp = await fetch("/nuvu/device/identity");
        if (!identityResp.ok) {
          deviceRegistered.value = false;
          return;
        }
        const identity = await identityResp.json();
        const currentFingerprint = identity.fingerprint_hash || "";
        if (identity.has_stored_token && identity.stored_device?.device_id) {
          deviceRegistered.value = true;
          return;
        }
        deviceRegistered.value = false;
      } catch (error) {
        deviceRegistered.value = false;
      }
    }
    function setActiveTab(tabId) {
      activeTab.value = tabId;
    }
    async function handleLogout() {
      try {
        await logout();
        emit2("logout");
      } catch (error) {
        console.error("[nuvu] Logout failed:", error);
      }
    }
    function handleRestart() {
      showRestartConfirm.value = true;
    }
    async function confirmRestart() {
      showRestartConfirm.value = false;
      try {
        await fetch("/nuvu/restart", { method: "GET" });
        console.log("[nuvu] Restart request sent");
      } catch (error) {
        console.log("[nuvu] Restart request sent (connection closed as expected)");
      }
    }
    function cancelRestart() {
      showRestartConfirm.value = false;
    }
    function handleRefresh() {
      if (props.licenseStatus?.statusClass === "floating-unavailable") {
        emit2("retry-floating");
        return;
      }
      showRefreshConfirm.value = true;
    }
    function confirmRefresh() {
      showRefreshConfirm.value = false;
      window.location.reload();
    }
    function cancelRefresh() {
      showRefreshConfirm.value = false;
    }
    function handleClose() {
      emit2("close");
    }
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1$1, [
        createVNode(Sidebar, {
          tabs,
          "active-tab": activeTab.value,
          user: __props.user,
          "license-status": __props.licenseStatus,
          "nuvu-update-available": nuvuUpdateAvailable.value,
          "device-registered": deviceRegistered.value,
          onTabChange: setActiveTab,
          onLogout: handleLogout,
          onRestart: handleRestart,
          onRefresh: handleRefresh
        }, null, 8, ["active-tab", "user", "license-status", "nuvu-update-available", "device-registered"]),
        createBaseVNode("main", _hoisted_2$1, [
          createBaseVNode("button", {
            class: "close-btn",
            onClick: handleClose,
            title: "Close"
          }, [..._cache[0] || (_cache[0] = [
            createBaseVNode("svg", {
              width: "24",
              height: "24",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              "stroke-width": "2"
            }, [
              createBaseVNode("path", { d: "M18 6L6 18M6 6l12 12" })
            ], -1)
          ])]),
          createVNode(_sfc_main$2, null, {
            default: withCtx(() => [
              withDirectives(createVNode(WorkflowsPanel, null, null, 512), [
                [vShow, activeTab.value === "workflows"]
              ]),
              withDirectives(createVNode(InstallMissingPanel, null, null, 512), [
                [vShow, activeTab.value === "install-missing"]
              ]),
              withDirectives(createVNode(ModelsPanel, null, null, 512), [
                [vShow, activeTab.value === "models"]
              ]),
              withDirectives(createVNode(OptimizerPanel, null, null, 512), [
                [vShow, activeTab.value === "optimizer"]
              ]),
              withDirectives(createVNode(UserConfigPanel, { onDeviceChanged: checkDeviceRegistration }, null, 512), [
                [vShow, activeTab.value === "user-config"]
              ]),
              withDirectives(createVNode(HelpPanel, null, null, 512), [
                [vShow, activeTab.value === "help"]
              ]),
              withDirectives(createVNode(SupportPanel, null, null, 512), [
                [vShow, activeTab.value === "support"]
              ]),
              withDirectives(createVNode(DocumentationPanel, null, null, 512), [
                [vShow, activeTab.value === "documentation"]
              ])
            ]),
            _: 1
          })
        ]),
        showRestartConfirm.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 0,
          title: "Restart ComfyUI",
          message: "Are you sure you want to restart ComfyUI? Any unsaved work may be lost.",
          "confirm-text": "Restart",
          "cancel-text": "Cancel",
          onConfirm: confirmRestart,
          onCancel: cancelRestart
        })) : createCommentVNode("", true),
        showRefreshConfirm.value ? (openBlock(), createBlock(ConfirmDialog, {
          key: 1,
          title: "Refresh Page",
          message: "Are you sure you want to refresh the page?",
          "confirm-text": "Refresh",
          "cancel-text": "Cancel",
          onConfirm: confirmRefresh,
          onCancel: cancelRefresh
        })) : createCommentVNode("", true)
      ]);
    };
  }
};
const Dashboard = /* @__PURE__ */ _export_sfc(_sfc_main$1, [["__scopeId", "data-v-71b89cf4"]]);
let initComplete = false;
async function initialize() {
  if (initComplete) return { authenticated: isAuthenticated };
  try {
    hydrateWorkflowsFromCache();
    hydrateModelsFromCache();
    const storedApiToken = localStorage.getItem("api_token");
    if (!storedApiToken) {
      initComplete = true;
      return { authenticated: false, reason: "no_token" };
    }
    const expiresAt = localStorage.getItem("auth_expires_at");
    if (expiresAt && Date.now() > parseInt(expiresAt)) {
      localStorage.removeItem("api_token");
      localStorage.removeItem("user_token");
      localStorage.removeItem("auth_expires_at");
      initComplete = true;
      return { authenticated: false, reason: "token_expired" };
    }
    hydrateUserFromStorage();
    initComplete = true;
    return { authenticated: isAuthenticated };
  } catch (error) {
    initComplete = true;
    return { authenticated: false, reason: "error", error };
  }
}
function getStatus() {
  return {
    initComplete,
    isAuthenticated,
    hasWorkflowsCache: Array.isArray(workflowsData) && workflowsData.length > 0,
    hasModelsCache: Array.isArray(modelsData) && modelsData.length > 0,
    user: currentUser,
    licenseStatus: currentLicenseStatus
  };
}
async function waitForInit() {
  if (!initComplete) {
    await initialize();
  }
  return getStatus();
}
const _hoisted_1 = { class: "nuvu-app" };
const _hoisted_2 = {
  key: 0,
  class: "loading-screen"
};
const _hoisted_3 = { class: "loading-content" };
const _hoisted_4 = { class: "loading-logo-container" };
const _hoisted_5 = ["src"];
const _hoisted_6 = { class: "loading-message" };
const _hoisted_7 = { class: "progress-container" };
const _hoisted_8 = { class: "progress-track" };
const _sfc_main = {
  __name: "App",
  setup(__props, { expose: __expose }) {
    const currentView = /* @__PURE__ */ ref("loading");
    const isAuthenticated$1 = /* @__PURE__ */ ref(false);
    const user = /* @__PURE__ */ shallowRef(null);
    const licenseStatus = /* @__PURE__ */ shallowRef(null);
    const isLoading = /* @__PURE__ */ ref(true);
    const loadingMessage = /* @__PURE__ */ ref("Powering up ComfyUI with Nuvu...");
    const loadingProgress = /* @__PURE__ */ ref(0);
    const onAuthInvalidated = () => {
      isAuthenticated$1.value = false;
      currentView.value = "login";
      user.value = null;
      licenseStatus.value = null;
      isLoading.value = false;
    };
    let authBootstrapPromise = null;
    async function bootstrapAuthenticatedData({ useCache = true, trackProgress = true } = {}) {
      if (authBootstrapPromise) {
        return authBootstrapPromise;
      }
      isLoading.value = true;
      loadingMessage.value = "Loading your workflows...";
      loadingProgress.value = 0;
      authBootstrapPromise = (async () => {
        try {
          await fetchAllData({ useCache, trackProgress });
          try {
            licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
          } catch {
          }
          currentView.value = "dashboard";
        } finally {
          isLoading.value = false;
          authBootstrapPromise = null;
        }
      })();
      return authBootstrapPromise;
    }
    const showLoadingScreen = computed(() => {
      return isLoading.value || isAuthenticated$1.value && licenseStatus.value === null;
    });
    provide("isAuthenticated", isAuthenticated$1);
    provide("currentView", currentView);
    provide("user", user);
    const logoUrl = extensionUrl("images/NuvuLogo.png");
    async function fetchAllData(options = {}) {
      const { useCache = true, trackProgress = false } = options;
      if (trackProgress) loadingProgress.value = 10;
      if (trackProgress) loadingProgress.value = 20;
      try {
        if (!currentLicenseStatus) {
          await fetchLicenseStatus({ useCache, backgroundRefresh: useCache });
        } else if (useCache) {
          fetchLicenseStatus({ useCache: true, backgroundRefresh: true }).catch(() => {
          });
        }
      } catch (e) {
        console.warn("[nuvu] License fetch failed:", e);
      }
      let completed = 0;
      const progressPerTask = 80 / 3;
      const trackCompletion = () => {
        completed++;
        if (trackProgress) {
          loadingProgress.value = 20 + completed * progressPerTask;
        }
      };
      await Promise.all([
        getExistingModels().catch((e) => console.warn("[nuvu] Existing models check failed:", e)).finally(trackCompletion),
        // Pre-load first page of workflows (paginated) for instant display
        // Skip if we already have cached data
        (async () => {
          const hasCache = Array.isArray(workflowsData) && workflowsData.length > 0;
          if (hasCache) {
            return;
          }
          const result = await fetchWorkflowsPaginated({ limit: 20 });
          if (result.items && result.items.length > 0) {
            setWorkflowsData(result.items, {
              mode: "paginated",
              nextCursor: result.nextCursor || null
            });
          }
        })().catch((e) => console.warn("[nuvu] Workflows fetch failed:", e)).finally(trackCompletion),
        loadModels({ backgroundRefresh: false, force: false }).catch((e) => console.warn("[nuvu] Models fetch failed:", e)).finally(trackCompletion)
      ]);
      if (trackProgress) loadingProgress.value = 100;
    }
    async function ensureDataReadyOnDialogOpen() {
      if (!isAuthenticated$1.value) {
        return;
      }
      if (isLoading.value) {
        return;
      }
      try {
        const hasWorkflowsCache = Array.isArray(workflowsData) && workflowsData.length > 0;
        const hasModelsCache = Array.isArray(modelsData) && modelsData.length > 0;
        if (!hasWorkflowsCache || !hasModelsCache) {
          isLoading.value = true;
          loadingMessage.value = "Loading your workflows...";
          loadingProgress.value = 0;
          await fetchAllData({ useCache: true, trackProgress: true });
          try {
            licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
          } catch {
          }
          currentView.value = "dashboard";
        }
      } catch {
      } finally {
        isLoading.value = false;
      }
    }
    onMounted(async () => {
      try {
        await waitForInit();
        if (isAuthenticated) {
          try {
            const ok = await checkWebsiteSession({ allowRefreshRetry: true, skipApiCall: false });
            if (!ok) {
              isAuthenticated$1.value = false;
              currentView.value = "login";
              user.value = null;
              licenseStatus.value = null;
              isLoading.value = false;
              return;
            }
          } catch {
          }
        }
        if (!isAuthenticated) {
          currentView.value = "login";
          isLoading.value = false;
          return;
        }
        isAuthenticated$1.value = true;
        user.value = currentUser;
        const hasWorkflowsCache = Array.isArray(workflowsData) && workflowsData.length > 0;
        const hasModelsCache = Array.isArray(modelsData) && modelsData.length > 0;
        if (hasWorkflowsCache && hasModelsCache && currentLicenseStatus) {
          licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
          currentView.value = "dashboard";
          isLoading.value = false;
          fetchAllData().then(() => {
            licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
          }).catch(() => {
          });
        } else {
          loadingMessage.value = "Powering up ComfyUI with Nuvu...";
          loadingProgress.value = 0;
          await fetchAllData({ trackProgress: true });
          licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
          currentView.value = "dashboard";
          isLoading.value = false;
        }
      } catch (error) {
        console.error("[nuvu] App initialization error:", error);
        currentView.value = "login";
        isLoading.value = false;
      }
      window.addEventListener("nuvu-vue-open", ensureDataReadyOnDialogOpen);
      window.addEventListener("nuvu:auth-invalidated", onAuthInvalidated);
      window.addEventListener("nuvu:floating-session-expired", onFloatingSessionExpired);
    });
    const onFloatingSessionExpired = async () => {
      console.log("[App] Floating session expired, refreshing license status");
      try {
        await fetchLicenseStatus({ useCache: false });
        licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
      } catch (error) {
        console.error("[App] Error refreshing license status after session expiration:", error);
      }
    };
    onUnmounted(() => {
      window.removeEventListener("nuvu-vue-open", ensureDataReadyOnDialogOpen);
      window.removeEventListener("nuvu:auth-invalidated", onAuthInvalidated);
      window.removeEventListener("nuvu:floating-session-expired", onFloatingSessionExpired);
    });
    function onLoginSuccess() {
      console.log("[nuvu Vue] Login initiated successfully");
    }
    function onLoginError(error) {
      console.error("[nuvu Vue] Login error:", error);
    }
    function onLogout() {
      isAuthenticated$1.value = false;
      currentView.value = "login";
      user.value = null;
      licenseStatus.value = null;
    }
    function onClose() {
      window.dispatchEvent(new CustomEvent("nuvu-vue-close"));
    }
    async function onRetryFloating() {
      console.log("[App] Retrying floating license acquisition...");
      isLoading.value = true;
      loadingMessage.value = "Checking license availability...";
      loadingProgress.value = 50;
      try {
        await retryFloatingLicense();
        licenseStatus.value = formatLicenseStatus(currentLicenseStatus);
        if (currentLicenseStatus?.has_paid_subscription) {
          console.log("[App] Floating license acquired successfully!");
        } else {
          console.log("[App] Floating license still unavailable");
        }
      } catch (error) {
        console.error("[App] Error retrying floating license:", error);
      } finally {
        isLoading.value = false;
        loadingProgress.value = 100;
      }
    }
    function setAuthenticated2(value, userData = null, license = null) {
      isAuthenticated$1.value = value;
      user.value = userData;
      licenseStatus.value = license;
      if (!value) {
        isLoading.value = false;
        currentView.value = "login";
        return;
      }
      bootstrapAuthenticatedData({ useCache: true, trackProgress: true }).catch(() => {
      });
    }
    function setView(view) {
      currentView.value = view;
    }
    __expose({
      setAuthenticated: setAuthenticated2,
      setView,
      currentView,
      isAuthenticated: isAuthenticated$1,
      user,
      licenseStatus
    });
    return (_ctx, _cache) => {
      return openBlock(), createElementBlock("div", _hoisted_1, [
        createVNode(Transition, { name: "fade" }, {
          default: withCtx(() => [
            showLoadingScreen.value ? (openBlock(), createElementBlock("div", _hoisted_2, [
              createBaseVNode("div", _hoisted_3, [
                createBaseVNode("div", _hoisted_4, [
                  _cache[0] || (_cache[0] = createBaseVNode("div", { class: "loading-logo-glow" }, null, -1)),
                  createBaseVNode("img", {
                    src: unref(logoUrl),
                    alt: "Nuvu",
                    class: "loading-logo"
                  }, null, 8, _hoisted_5)
                ]),
                createBaseVNode("p", _hoisted_6, toDisplayString(loadingMessage.value), 1),
                createBaseVNode("div", _hoisted_7, [
                  createBaseVNode("div", _hoisted_8, [
                    createBaseVNode("div", {
                      class: "progress-bar",
                      style: normalizeStyle({ width: loadingProgress.value + "%" })
                    }, null, 4)
                  ])
                ])
              ])
            ])) : createCommentVNode("", true)
          ]),
          _: 1
        }),
        !showLoadingScreen.value && currentView.value === "login" ? (openBlock(), createBlock(LoginForm, {
          key: 0,
          onLoginSuccess,
          onLoginError
        })) : !showLoadingScreen.value && currentView.value === "dashboard" ? (openBlock(), createBlock(Dashboard, {
          key: 1,
          user: user.value,
          "license-status": licenseStatus.value,
          onLogout,
          onClose,
          onRetryFloating
        }, null, 8, ["user", "license-status"])) : createCommentVNode("", true)
      ]);
    };
  }
};
const App = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-716c21de"]]);
let appInstance = null;
let mountedElement = null;
let appComponentRef = null;
function mountNuvuApp(container, options = {}) {
  if (appInstance) {
    appInstance.unmount();
  }
  appInstance = createApp(App);
  {
    mountedElement = document.querySelector(container);
  }
  if (mountedElement) {
    const vm = appInstance.mount(mountedElement);
    appComponentRef = vm;
    if (options.view) {
      vm.setView(options.view);
    }
    if (options.user || options.licenseStatus) {
      vm.setAuthenticated(true, options.user, options.licenseStatus);
    }
  }
  return appInstance;
}
function isNuvuAppMounted() {
  return appInstance !== null && mountedElement !== null;
}
function setNuvuView(view) {
  if (appComponentRef) {
    appComponentRef.setView(view);
  }
}
let vueCloseHandlerRegistered = false;
const DIALOG_ANIM_MS = 180;
function showDialogAnimated(dialog) {
  if (!dialog) return;
  dialog.style.display = "flex";
  dialog.removeAttribute("aria-hidden");
  requestAnimationFrame(() => {
    try {
      dialog.classList.add("nuvu-open");
    } catch (e) {
    }
  });
}
function hideDialogAnimated(dialog) {
  if (!dialog) return;
  try {
    dialog.classList.remove("nuvu-open");
  } catch (e) {
  }
  dialog.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    try {
      dialog.style.display = "none";
    } catch (e) {
    }
  }, DIALOG_ANIM_MS);
}
function createSplashDialog() {
  const dialog = document.createElement("div");
  dialog.className = "nuvu-splash-dialog";
  dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.15);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.3s ease-out;
        pointer-events: auto;
    `;
  const style = document.createElement("style");
  style.textContent = `
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        @keyframes slideIn {
            from { transform: scale(0.9) translateY(-20px); opacity: 0; }
            to { transform: scale(1) translateY(0); opacity: 1; }
        }
        /* Fun zoom in/out on show/hide (keeps Vue mounted) */
        .nuvu-splash-dialog {
            opacity: 0;
            transition: opacity ${DIALOG_ANIM_MS}ms ease;
        }
        .nuvu-splash-dialog.nuvu-open {
            opacity: 1;
        }
        .nuvu-splash-dialog .nuvu-modern-card {
            transform: scale(0.92) translateY(10px);
            transition: transform ${DIALOG_ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity ${DIALOG_ANIM_MS}ms ease;
        }
        .nuvu-splash-dialog.nuvu-open .nuvu-modern-card {
            transform: scale(1) translateY(0);
        }
        .nuvu-modern-card {
            background: #1a1a1a;
            border: 1px solid rgba(160, 187, 196, 0.2);
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(32, 44, 57, 0.3);
            transition: all 0.3s ease;
        }
        .nuvu-modern-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 25px 50px rgba(32, 44, 57, 0.4);
        }
        .nuvu-modern-button {
            background: #D14E72;
            border: none;
            border-radius: 8px;
            color: #F0F0F0;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-modern-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(209, 78, 114, 0.4);
        }
        .nuvu-modern-button:active {
            transform: translateY(0);
        }
        .nuvu-accent-button {
            background: #A0BBC4;
            border: none;
            border-radius: 8px;
            color: #202C39;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-accent-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(160, 187, 196, 0.4);
        }
        .nuvu-success-button {
            background: #D14E72;
            border: none;
            border-radius: 8px;
            color: #F0F0F0;
            font-weight: 600;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        .nuvu-success-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(209, 78, 114, 0.4);
        }
    `;
  document.head.appendChild(style);
  const content = document.createElement("div");
  content.className = "nuvu-modern-card";
  content.style.cssText = `
        background: #1a1a1a;
        border: 1px solid rgba(160, 187, 196, 0.2);
        border-radius: 16px;
        width: 95vw;
        height: 90vh;
        max-width: 1440px;
        max-height: 90vh;
        overflow: hidden;
        box-shadow: 0 20px 40px rgba(32, 44, 57, 0.5);
        display: flex;
        flex-direction: column;
        animation: slideIn 0.4s ease-out;
        position: relative;
    `;
  const body = document.createElement("div");
  body.id = "nuvu-dialog-body";
  body.style.cssText = `
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        align-items: stretch;
        justify-content: flex-start;
        min-height: 0;
        position: relative;
    `;
  content.appendChild(body);
  dialog.appendChild(content);
  const closeOverlay = () => {
    try {
      window.dispatchEvent(new CustomEvent("nuvu-vue-close"));
    } catch (e) {
    }
  };
  let mouseDownOnOverlay = false;
  dialog.onmousedown = (e) => {
    mouseDownOnOverlay = e.target === dialog;
  };
  dialog.onmouseup = (e) => {
    if (mouseDownOnOverlay && e.target === dialog) {
      closeOverlay();
    }
    mouseDownOnOverlay = false;
  };
  showDialogAnimated(dialog);
  return { dialog, body };
}
function updateDialogForLogin() {
  if (!nuvuDialog) return;
  const body = nuvuDialog.querySelector("#nuvu-dialog-body");
  let vueMount = body.querySelector("#nuvu-vue-app");
  if (!vueMount) {
    body.innerHTML = "";
    body.style.cssText = `
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-height: 0;
            position: relative;
            width: 100%;
            height: 100%;
        `;
    vueMount = document.createElement("div");
    vueMount.id = "nuvu-vue-app";
    vueMount.style.cssText = "width: 100%; height: 100%;";
    body.appendChild(vueMount);
  }
  if (!isNuvuAppMounted()) {
    mountNuvuApp("#nuvu-vue-app", { view: "login" });
  } else {
    setNuvuView("login");
  }
  setupVueCloseHandler();
}
function updateDialogForAuthenticated() {
  if (!nuvuDialog) return;
  const body = nuvuDialog.querySelector("#nuvu-dialog-body");
  let vueMount = body.querySelector("#nuvu-vue-app");
  if (!vueMount) {
    body.innerHTML = "";
    body.style.cssText = `
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-height: 0;
            position: relative;
            width: 100%;
            height: 100%;
        `;
    vueMount = document.createElement("div");
    vueMount.id = "nuvu-vue-app";
    vueMount.style.cssText = "width: 100%; height: 100%;";
    body.appendChild(vueMount);
  }
  if (!isNuvuAppMounted()) {
    mountNuvuApp("#nuvu-vue-app", {
      view: "dashboard",
      user: currentUser,
      licenseStatus: currentLicenseStatus
    });
  } else {
    setNuvuView("dashboard");
  }
  setupVueCloseHandler();
}
function setupVueCloseHandler() {
  if (vueCloseHandlerRegistered) {
    return;
  }
  const closeHandler = () => {
    hideDialogAnimated(nuvuDialog);
  };
  window.addEventListener("nuvu-vue-close", closeHandler);
  vueCloseHandlerRegistered = true;
}
let currentDialogBuild = null;
async function shownuvuSplash() {
  if (window.location.search.includes("token=") || window.location.hash.includes("token=")) {
    try {
      handleWebsiteCallbackFromUrl(updateDialogForAuthenticated);
    } catch (error) {
    }
  }
  if (nuvuDialog) {
    try {
      nuvuDialog.style.display = "flex";
      nuvuDialog.removeAttribute("aria-hidden");
      requestAnimationFrame(() => {
        try {
          nuvuDialog.classList.add("nuvu-open");
        } catch (error) {
        }
      });
    } catch (error) {
    }
    try {
      window.dispatchEvent(new CustomEvent("nuvu-vue-open"));
    } catch (error) {
    }
    return;
  }
  if (currentDialogBuild) {
    try {
      await currentDialogBuild;
    } catch (error) {
    }
  }
  const buildPromise = buildAndMountDialog();
  currentDialogBuild = buildPromise;
  try {
    await buildPromise;
  } catch (error) {
    clearExistingDialog();
    throw error;
  } finally {
    if (currentDialogBuild === buildPromise) {
      currentDialogBuild = null;
    }
  }
  try {
    window.dispatchEvent(new CustomEvent("nuvu-vue-open"));
  } catch (error) {
  }
}
async function buildAndMountDialog() {
  if (nuvuDialog) {
    try {
      nuvuDialog.style.display = "flex";
      nuvuDialog.removeAttribute("aria-hidden");
    } catch (error) {
    }
    return;
  }
  const { dialog } = createSplashDialog();
  document.body.appendChild(dialog);
  setnuvuDialog(dialog);
  try {
    requestAnimationFrame(() => {
      try {
        dialog.classList.add("nuvu-open");
      } catch (error) {
      }
    });
  } catch (error) {
  }
  if (isAuthenticated) {
    await updateDialogForAuthenticated();
  } else {
    await updateDialogForLogin();
  }
}
function clearExistingDialog() {
  const existingDialogs = document.querySelectorAll(".nuvu-splash-dialog");
  existingDialogs.forEach((dialog) => {
    if (nuvuDialog && dialog === nuvuDialog) {
      return;
    }
    try {
      if (dialog.parentElement) {
        dialog.parentElement.removeChild(dialog);
      } else {
        dialog.remove();
      }
    } catch (error) {
    }
  });
}
function createElement(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === "className") {
      element.className = value;
    } else if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      const eventProp = key.charAt(2).toLowerCase() + key.slice(3);
      element["on" + eventProp] = value;
    } else if (value !== null && value !== void 0) {
      element.setAttribute(key, value);
    }
  });
  children.flat().forEach((child) => {
    if (child != null && child !== false) {
      element.append(
        typeof child === "string" ? document.createTextNode(child) : child
      );
    }
  });
  return element;
}
const div = (...args) => createElement("div", ...args);
const button = (...args) => createElement("button", ...args);
function Modal({
  title,
  subtitle,
  children,
  onClose,
  maxWidth = "600px",
  showCloseButton = true
}) {
  const overlay = div({
    className: "nuvu-modal-overlay",
    onClick: (e) => {
      if (e.target === overlay && onClose) {
        onClose();
      }
    }
  });
  const modal = div(
    {
      className: "nuvu-modal",
      style: { maxWidth }
    },
    div(
      { className: "nuvu-modal-header" },
      div(
        { className: "nuvu-modal-title-group" },
        div({ className: "nuvu-modal-title" }, title),
        subtitle && div({ className: "nuvu-modal-subtitle" }, subtitle)
      ),
      onClose && showCloseButton ? button(
        {
          className: "nuvu-modal-close",
          onClick: onClose
        },
        "×"
      ) : null
    ),
    div({ className: "nuvu-modal-body" }, ...children)
  );
  overlay.appendChild(modal);
  return overlay;
}
function Button({
  text,
  onClick,
  variant = "primary",
  disabled = false,
  large = false,
  icon = null,
  id = null
}) {
  const classes = ["nuvu-btn", `nuvu-btn-${variant}`];
  if (large) classes.push("nuvu-btn-large");
  if (icon) classes.push("nuvu-btn-with-icon");
  const props = {
    className: classes.join(" "),
    onClick
  };
  if (id) props.id = id;
  if (disabled) props.disabled = disabled;
  const btnElement = icon ? button(props, icon, text) : button(props, text);
  return btnElement;
}
const MODAL_KEY = "post-restart-refresh";
const SPLASH_FLAG_KEY = "nuvu_show_splash_after_refresh";
function setSplashFlag() {
  try {
    window.localStorage.setItem(SPLASH_FLAG_KEY, "true");
  } catch (error) {
  }
}
function modalExists(key) {
  return Boolean(document.querySelector(`[data-nuvu-modal="${key}"]`));
}
function mountModal(overlay, key) {
  overlay.dataset.nuvuModal = key;
  document.body.appendChild(overlay);
}
function removeModal(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}
function showPostRestartRefreshPrompt() {
  setPendingRefreshAfterRestart(false);
  if (modalExists(MODAL_KEY)) {
    return;
  }
  let overlay = null;
  const close = () => {
    removeModal(overlay);
    overlay = null;
  };
  const refreshButton = Button({
    text: "Refresh Now",
    variant: "secondary",
    id: "nuvu-post-restart-refresh",
    onClick: () => {
      setSplashFlag();
      window.location.reload();
    }
  });
  const laterButton = Button({
    text: "Later",
    variant: "primary",
    id: "nuvu-post-restart-refresh-later",
    onClick: close
  });
  overlay = Modal({
    title: "Restart Complete",
    maxWidth: "520px",
    onClose: close,
    showCloseButton: false,
    children: [
      div(
        { className: "nuvu-modal-message" },
        "ComfyUI is back online. Refresh this tab to continue."
      ),
      div({ className: "nuvu-modal-actions" }, laterButton, refreshButton)
    ]
  });
  mountModal(overlay, MODAL_KEY);
}
const MINI_ID = "nuvu-mini-queue-progress";
const POS_KEY = "nuvu_mini_queue_pos_v1";
let overlayEl = null;
let pollTimer = null;
let idleTicks = 0;
let lastStatus = null;
let isDragging = false;
let activePointerId = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
async function cancelInstallFromMini() {
  const accessToken = window.localStorage.getItem("api_token");
  if (!accessToken) {
    throw new Error("api_token is required to cancel installs");
  }
  const email = currentUser?.email;
  if (!email) {
    throw new Error("user email is required to cancel installs");
  }
  const resp = await fetch("/nuvu/execute/cancel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`
    },
    body: JSON.stringify({ user_email: email })
  });
  if (!resp.ok) {
    throw new Error(`Cancel failed: ${resp.status}`);
  }
}
function isQueueActive(s) {
  if (!s) return false;
  return Boolean(
    s.is_processing || (s.running_count || 0) > 0 || (s.queue_size || 0) > 0 || (s.in_progress_count || 0) > 0
  );
}
function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadPosition() {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const left = Number(parsed.left);
    const top = Number(parsed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}
function savePosition(left, top) {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
  }
}
function ensureOverlay() {
  if (overlayEl && document.getElementById(MINI_ID) === overlayEl) return overlayEl;
  overlayEl = document.getElementById(MINI_ID);
  if (overlayEl) return overlayEl;
  const el = document.createElement("div");
  el.id = MINI_ID;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `
    position: fixed;
    z-index: 10001;
    width: 360px;
    max-width: calc(100vw - 24px);
    background: #121212;
    border: 1px solid #272727;
    border-radius: 10px;
    color: #f5f5f5;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    display: none;
    user-select: none;
  `;
  el.innerHTML = `
    <div data-role="header" style="
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: move;
      border-bottom: 1px solid #272727;
      background: #0b0b0b;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
    ">
      <div style="font-weight: 700; font-size: 12px; letter-spacing: 0.08em; opacity: 0.9;">
        Nuvu Installer
      </div>
      <button data-role="open" type="button" style="
        border: 1px solid #ffffff;
        background: #ffffff;
        color: #000000;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      ">Open</button>
    </div>
    <div data-role="body" style="padding: 10px 12px;">
      <div data-role="summary" style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">Working...</div>
      <div data-role="file" style="font-size: 12px; opacity: 0.8; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></div>
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="flex: 1; height: 8px; background: #050505; border-radius: 4px; overflow: hidden;">
          <div data-role="bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #22c55e, #4ade80); transition: width 0.3s ease;"></div>
        </div>
        <button data-role="cancel" type="button" title="Cancel install" aria-label="Cancel install" style="
          border: none;
          background: #d14e72;
          color: #ffffff;
          border-radius: 6px;
          width: 26px;
          height: 26px;
          line-height: 26px;
          font-size: 16px;
          font-weight: 900;
          cursor: pointer;
          padding: 0;
        ">×</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  overlayEl = el;
  const openBtn = el.querySelector('[data-role="open"]');
  if (openBtn) {
    openBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    openBtn.addEventListener("click", () => {
      if (typeof opennuvuDialog === "function") {
        opennuvuDialog();
      }
    });
  }
  const cancelBtn = el.querySelector('[data-role="cancel"]');
  if (cancelBtn) {
    cancelBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    cancelBtn.addEventListener("mouseenter", () => {
      try {
        cancelBtn.style.background = "#b53f60";
      } catch {
      }
    });
    cancelBtn.addEventListener("mouseleave", () => {
      try {
        cancelBtn.style.background = "#d14e72";
      } catch {
      }
    });
    cancelBtn.addEventListener("click", async () => {
      try {
        cancelBtn.disabled = true;
        cancelBtn.style.opacity = "0.7";
        await cancelInstallFromMini();
        await pollOnce();
      } catch {
      } finally {
        try {
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = "1";
        } catch {
        }
      }
    });
  }
  const header = el.querySelector('[data-role="header"]');
  if (header) {
    header.addEventListener("pointerdown", (ev) => {
      if (!overlayEl) return;
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest("button")) return;
      ev.preventDefault();
      isDragging = true;
      activePointerId = ev.pointerId;
      try {
        header.setPointerCapture(ev.pointerId);
      } catch {
      }
      const rect = overlayEl.getBoundingClientRect();
      dragOffsetX = ev.clientX - rect.left;
      dragOffsetY = ev.clientY - rect.top;
    });
    header.addEventListener("pointermove", (ev) => {
      if (!overlayEl || !isDragging) return;
      if (activePointerId !== ev.pointerId) return;
      const newLeft = Math.max(12, Math.min(window.innerWidth - overlayEl.offsetWidth - 12, ev.clientX - dragOffsetX));
      const newTop = Math.max(12, Math.min(window.innerHeight - overlayEl.offsetHeight - 12, ev.clientY - dragOffsetY));
      overlayEl.style.left = `${newLeft}px`;
      overlayEl.style.top = `${newTop}px`;
      overlayEl.style.right = "auto";
      overlayEl.style.bottom = "auto";
    });
    const stopDrag = () => {
      if (!overlayEl) return;
      isDragging = false;
      activePointerId = null;
      const rect = overlayEl.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    };
    header.addEventListener("pointerup", (ev) => {
      if (activePointerId !== ev.pointerId) return;
      stopDrag();
    });
    header.addEventListener("pointercancel", () => {
      isDragging = false;
      activePointerId = null;
    });
    document.addEventListener("pointerup", () => {
      if (!isDragging) return;
      stopDrag();
    });
  }
  const pos = loadPosition();
  if (pos) {
    overlayEl.style.left = `${pos.left}px`;
    overlayEl.style.top = `${pos.top}px`;
    overlayEl.style.right = "auto";
    overlayEl.style.bottom = "auto";
  } else {
    overlayEl.style.right = "12px";
    overlayEl.style.bottom = "88px";
  }
  return overlayEl;
}
function setVisible(visible) {
  const el = ensureOverlay();
  if (!el) return;
  el.style.display = visible ? "block" : "none";
  el.setAttribute("aria-hidden", visible ? "false" : "true");
}
function renderStatus(status) {
  const el = ensureOverlay();
  if (!el) return;
  const p2 = status?.download_progress || null;
  const summaryEl = el.querySelector('[data-role="summary"]');
  const fileEl = el.querySelector('[data-role="file"]');
  const barEl = el.querySelector('[data-role="bar"]');
  const summaryText = (() => {
    if (!p2) return "Working...";
    if (p2.message) return p2.message;
    if (p2.current_phase) return `Working: ${p2.current_phase}`;
    return "Working...";
  })();
  const fileText = (() => {
    if (!p2) return "";
    const fname = typeof p2.filename === "string" ? p2.filename : "";
    if (!fname) return "";
    const raw = Number(p2.percent || 0);
    if (Number.isFinite(raw) && raw > 0) {
      let t = `${fname}: ${Math.round(raw)}%`;
      if (p2.downloaded && p2.total) {
        t += ` (${p2.downloaded}/${p2.total})`;
      }
      return t;
    }
    return fname;
  })();
  const percent = (() => {
    if (!p2) return 0;
    const raw = Number(p2.percent || 0);
    if (Number.isFinite(raw) && raw > 0) {
      return Math.max(0, Math.min(100, raw));
    }
    return 0;
  })();
  if (summaryEl) summaryEl.textContent = summaryText;
  if (fileEl) fileEl.textContent = fileText;
  if (barEl) barEl.style.width = `${percent}%`;
}
async function pollOnce() {
  const resp = await fetch("/nuvu/queue/status", { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Queue status failed: ${resp.status}`);
  }
  lastStatus = await resp.json();
  renderStatus(lastStatus);
  return lastStatus;
}
function stopPolling() {
  idleTicks = 0;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
function startPollingWhileHiddenIfActive() {
  if (pollTimer) return;
  idleTicks = 0;
  pollTimer = setInterval(async () => {
    try {
      const s = await pollOnce();
      if (isQueueActive(s)) {
        idleTicks = 0;
        setVisible(true);
      } else {
        idleTicks += 1;
        if (idleTicks >= 2) {
          setVisible(false);
          stopPolling();
        }
      }
    } catch {
      setVisible(false);
      stopPolling();
    }
  }, 1e3);
}
async function onDialogClose() {
  try {
    const s = await pollOnce();
    if (isQueueActive(s)) {
      setVisible(true);
      startPollingWhileHiddenIfActive();
    } else {
      setVisible(false);
      stopPolling();
    }
  } catch {
    setVisible(false);
    stopPolling();
  }
}
function onDialogOpen() {
  isDragging = false;
  activePointerId = null;
  setVisible(false);
  stopPolling();
}
function initializeMiniQueueProgress() {
  ensureOverlay();
  setVisible(false);
  window.addEventListener("nuvu-vue-close", onDialogClose);
  window.addEventListener("nuvu-vue-open", onDialogOpen);
}
const EXTENSION_BASE_URL = new URL(".", import.meta.url).href;
function loadnuvuCSS() {
  const mainCssPath = new URL("./nuvu.css", import.meta.url).href;
  if (!document.querySelector(`link[href="${mainCssPath}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = mainCssPath;
    document.head.appendChild(link);
  }
  const vueCssPath = new URL("./comfyui-nuvu.css", import.meta.url).href;
  if (!document.querySelector(`link[href="${vueCssPath}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = vueCssPath;
    document.head.appendChild(link);
  }
}
loadnuvuCSS();
initializeMiniQueueProgress();
function handleApiReconnected() {
  if (pendingRefreshAfterRestart) {
    showPostRestartRefreshPrompt();
  }
}
if (api && typeof api.addEventListener === "function") {
  api.addEventListener("reconnected", handleApiReconnected);
}
let fallbackReconnectInterval = null;
let fallbackReconnectStart = 0;
let fallbackReconnectSawFailure = false;
function stopFallbackReconnectWatcher() {
  if (fallbackReconnectInterval) {
    clearInterval(fallbackReconnectInterval);
    fallbackReconnectInterval = null;
  }
}
async function attemptServerReadyCheck() {
  if (!pendingRefreshAfterRestart) {
    stopFallbackReconnectWatcher();
    return;
  }
  try {
    const response = await fetch(`/nuvu/queue/status?ts=${Date.now()}`, {
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (response.ok) {
      const elapsed = Date.now() - fallbackReconnectStart;
      if (fallbackReconnectSawFailure || elapsed > 7e3) {
        showPostRestartRefreshPrompt();
        stopFallbackReconnectWatcher();
      }
    } else {
      fallbackReconnectSawFailure = true;
    }
  } catch (error) {
    fallbackReconnectSawFailure = true;
  }
}
function startFallbackReconnectWatcher() {
  if (fallbackReconnectInterval) {
    return;
  }
  fallbackReconnectStart = Date.now();
  fallbackReconnectSawFailure = false;
  setTimeout(attemptServerReadyCheck, 2500);
  fallbackReconnectInterval = setInterval(attemptServerReadyCheck, 4e3);
}
if (typeof onPendingRefreshChange === "function") {
  onPendingRefreshChange((value) => {
    if (value) {
      startFallbackReconnectWatcher();
    } else {
      stopFallbackReconnectWatcher();
    }
  });
}
if (pendingRefreshAfterRestart) {
  startFallbackReconnectWatcher();
}
app.registerExtension({
  name: "Comfy.AOLabs",
  // Add a command and keybinding so users can open the dialog without clicking the button
  commands: [
    {
      id: "Comfy.AOLabs.Open",
      label: "Open nuvu",
      function: () => {
        if (typeof opennuvuDialog === "function") {
          opennuvuDialog();
        }
      }
    }
  ],
  // Default shortcut: Ctrl+L for Labs
  keybindings: [
    {
      commandId: "Comfy.AOLabs.Open",
      combo: { ctrl: true, key: "l" }
    }
  ],
  async setup() {
    await fetchConfig();
    initialize().catch(() => {
    });
    setOpennuvuDialog(shownuvuSplash);
    const hasAuthTokens = window.location.search.includes("token=") || window.location.hash.includes("token=");
    if (hasAuthTokens) {
      const success = handleWebsiteCallbackFromUrl(updateDialogForAuthenticated);
      if (success) {
        setTimeout(() => {
          opennuvuDialog();
        }, 1e3);
      }
    } else if (localStorage.getItem("nuvu_show_splash_after_refresh") === "true") {
      localStorage.removeItem("nuvu_show_splash_after_refresh");
      setTimeout(() => {
        opennuvuDialog();
      }, 500);
    }
    window.addEventListener("error", (event) => {
      if (event.error && event.error.message && (event.error.message.includes("message channel closed") || event.error.message.includes("asynchronous response"))) {
        event.preventDefault();
        return;
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      if (event.reason && event.reason.message && (event.reason.message.includes("message channel closed") || event.reason.message.includes("asynchronous response"))) {
        event.preventDefault();
        return;
      }
    });
    window.addEventListener("message", (event) => {
      try {
        handlePopupAuthResult(event, updateDialogForAuthenticated);
      } catch (error) {
        if (error.message && error.message.includes("message channel closed")) {
          return;
        }
      }
    }, false);
    window.testnuvu = () => {
      alert("nuvu test function works!");
    };
    const menu = document.querySelector(".comfy-menu");
    if (!menu) {
      return;
    }
    let buttonCreated = false;
    try {
      const Button2 = (await import("/scripts/ui/components/button.js")).ComfyButton;
      const ButtonGroup = (await import("/scripts/ui/components/buttonGroup.js")).ComfyButtonGroup;
      const nuvuBtn = new Button2({
        icon: null,
        action: () => {
          if (typeof opennuvuDialog === "function") {
            opennuvuDialog();
          }
        },
        tooltip: "Open nuvu Control Panel",
        content: "",
        classList: "comfyui-button comfyui-menu-mobile-collapse"
      });
      const logoSrc = new URL("images/NuvuNoOutline.png", EXTENSION_BASE_URL).href;
      const logoImg = document.createElement("img");
      logoImg.src = logoSrc;
      logoImg.alt = "nuvu";
      logoImg.style.height = "36px";
      logoImg.style.display = "block";
      logoImg.style.marginTop = "2px";
      nuvuBtn.element.innerHTML = "";
      nuvuBtn.element.appendChild(logoImg);
      nuvuBtn.element.style.background = "#ffffff";
      nuvuBtn.element.style.border = "0px solid #000000";
      nuvuBtn.element.style.borderRadius = "0px";
      nuvuBtn.element.style.padding = "0px 0px";
      nuvuBtn.element.style.display = "flex";
      nuvuBtn.element.style.alignItems = "center";
      nuvuBtn.element.style.justifyContent = "center";
      nuvuBtn.element.style.minWidth = "95px";
      nuvuBtn.element.style.maxWidth = "100px";
      const group = new ButtonGroup(nuvuBtn.element);
      app.menu?.settingsGroup?.element?.before(group.element);
      buttonCreated = true;
    } catch (e) {
    }
    if (!buttonCreated) {
      try {
        const btn = document.createElement("button");
        btn.textContent = "nuvu";
        btn.onclick = () => {
          if (typeof opennuvuDialog === "function") {
            opennuvuDialog();
          }
        };
        const fallbackLogo = document.createElement("img");
        fallbackLogo.src = new URL("images/NuvuNoOutline.png", EXTENSION_BASE_URL).href;
        fallbackLogo.alt = "nuvu";
        fallbackLogo.style.height = "28px";
        fallbackLogo.style.display = "block";
        btn.innerHTML = "";
        btn.appendChild(fallbackLogo);
        btn.style.background = "#ffffff";
        btn.style.border = "1px solid #000000";
        btn.style.borderRadius = "8px";
        btn.style.padding = "4px 12px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.minWidth = "120px";
        btn.style.maxWidth = "160px";
        menu.append(btn);
        buttonCreated = true;
      } catch (e) {
      }
    }
    if (!buttonCreated) {
      setTimeout(() => {
        const existingBtn = document.querySelector('button[data-tooltip="nuvu - Authentication & Updates"]') || document.querySelector('button[style*="background: #D14E72"]');
        if (existingBtn) {
          existingBtn.style.display = "block";
          existingBtn.style.visibility = "visible";
          existingBtn.style.opacity = "1";
        }
      }, 1e3);
    }
  }
});
