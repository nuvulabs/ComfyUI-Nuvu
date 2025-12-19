// Matcher utilities for Install Missing panel
// Matches node types to custom nodes and models
// Mirrors ComfyUI-Manager's approach with support for multiple package alternatives

/**
 * Match node types from a workflow to custom nodes in the library
 * Handles CNR IDs, aux IDs, and node type mappings
 * When multiple packages provide the same node type, returns alternatives for dropdown selection
 * 
 * @param {Array} customNodes - Array of node type strings from workflow
 * @param {Object} cnrIds - Map of cnr_id -> node_type
 * @param {Object} auxIds - Map of aux_id -> node_type
 * @param {Array} availableNodes - Array of custom node objects from library (nuvu database)
 * @param {Set} installedNodeTypes - Set of installed node type strings (LiteGraph.registered_node_types)
 * @param {Object} nodeMappings - Node type to extension URL mappings from ComfyUI-Manager
 * @param {Array} installedNodeFolders - Array of installed custom node folder names
 * @returns {Object} { matches: Array of missing custom nodes with alternatives, unresolved: Array }
 */
export function matchCustomNodes(
    customNodes,
    cnrIds,
    auxIds,
    availableNodes,
    installedNodeTypes,
    nodeMappings,
    installedNodeFolders
) {
    const matches = [];
    const unresolved = [];
    const processedNodeTypes = new Set();
    
    // Safely handle bad inputs
    const nodeTypesList = Array.isArray(customNodes) ? customNodes : [];
    const cnrIdsMap = cnrIds && typeof cnrIds === 'object' ? cnrIds : {};
    const auxIdsMap = auxIds && typeof auxIds === 'object' ? auxIds : {};
    const library = Array.isArray(availableNodes) ? availableNodes : [];
    const installedTypes = installedNodeTypes instanceof Set ? installedNodeTypes : new Set(installedNodeTypes || []);
    const mappings = nodeMappings && typeof nodeMappings === 'object' ? nodeMappings : {};
    const installedFolders = new Set(
        (Array.isArray(installedNodeFolders) ? installedNodeFolders : [])
            .map(f => typeof f === 'string' ? f.toLowerCase() : '')
            .filter(Boolean)
    );
    
    // Build lookup maps for efficiency
    // Map repo URL -> library node
    const repoToNodeMap = new Map();
    // Map CNR ID -> library node
    const cnrIdToNodeMap = new Map();
    // Map repo name (extracted) -> library nodes (multiple possible)
    const repoNameToNodesMap = new Map();
    
    for (const node of library) {
        if (!node) continue;
        
        const repoUrl = node.gitRepo || node.repository || node.url || '';
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
        
        // Index by CNR ID if present
        if (node.cnrId || node.cnr_id) {
            const cnrId = node.cnrId || node.cnr_id;
            if (typeof cnrId === 'string' && cnrId.trim()) {
                cnrIdToNodeMap.set(cnrId.toLowerCase(), node);
            }
        }
    }
    
    // Build aux_id to library node map (GitHub format: owner/repo)
    const auxIdToNodeMap = new Map();
    for (const node of library) {
        if (!node) continue;
        const repoUrl = node.gitRepo || node.repository || node.url || '';
        const auxKey = extractAuxId(repoUrl);
        if (auxKey) {
            auxIdToNodeMap.set(auxKey.toLowerCase(), node);
        }
    }

    function _repoNameFromIdentifier(identifier) {
        if (!identifier || typeof identifier !== 'string') return null;
        const s = identifier.trim();
        if (!s) return null;

        // URL forms: https://github.com/owner/repo(.git), git@github.com:owner/repo(.git)
        if (s.includes('github.com')) {
            const repoName = extractRepoName(s);
            return repoName ? repoName.toLowerCase() : null;
        }

        // owner/repo -> repo
        if (s.includes('/')) {
            const parts = s.replace(/\.git$/i, '').split('/');
            const last = parts[parts.length - 1];
            return last ? last.toLowerCase() : null;
        }

        // plain repo/package id
        return s.replace(/\.git$/i, '').toLowerCase();
    }

    function _findLibraryNodeByIdentifier(identifier) {
        if (!identifier) return null;
        const id = String(identifier).trim();
        if (!id) return null;

        const idLower = id.toLowerCase();

        // Exact identifiers
        let node = cnrIdToNodeMap.get(idLower) || auxIdToNodeMap.get(idLower) || repoToNodeMap.get(idLower);
        if (node) return node;

        // Repo name fallback (covers cases like "ComfyUI-WanAnimatePreprocess")
        const repoNameLower = _repoNameFromIdentifier(id);
        if (repoNameLower) {
            const byRepoName = repoNameToNodesMap.get(repoNameLower) || [];
            if (byRepoName.length > 0) {
                const installed = byRepoName.find(n => checkIfInstalled(n, installedFolders));
                return installed || byRepoName[0];
            }
        }

        return null;
    }
    
    // Step 1: Process CNR IDs first (most reliable)
    for (const [cnrId, nodeType] of Object.entries(cnrIdsMap)) {
        if (processedNodeTypes.has(nodeType)) continue;
        
        // Special case: comfy-core means ComfyUI itself is outdated
        // For "Install Missing", treat comfy-core as a native ComfyUI node and do not try to map it
        // to a custom node package (it has no custom node associated).
        if (cnrId === 'comfy-core') {
            processedNodeTypes.add(nodeType);
            continue;
        }
        
        const libraryNode = _findLibraryNodeByIdentifier(cnrId);

        if (libraryNode) {
            processedNodeTypes.add(nodeType);
            // Installed is based on folder match (we can only update repos we can identify on disk).
            const isInstalled = checkIfInstalled(libraryNode, installedFolders);
            
            matches.push({
                id: libraryNode.id || cnrId,
                name: libraryNode.name || libraryNode.title || cnrId,
                gitRepo: libraryNode.gitRepo || libraryNode.repository || libraryNode.url,
                matchedNodeType: nodeType,
                matchSource: 'cnr_id',
                isInstalled,
                hasMultipleOptions: false,
                alternatives: []
            });
        } else {
            unresolved.push({ type: nodeType, reason: `CNR ID not found: ${cnrId}` });
        }
    }
    
    // Step 2: Process aux IDs (GitHub owner/repo format)
    for (const [auxId, nodeType] of Object.entries(auxIdsMap)) {
        if (processedNodeTypes.has(nodeType)) continue;
        
        const libraryNode = _findLibraryNodeByIdentifier(auxId);
        if (libraryNode) {
            processedNodeTypes.add(nodeType);
            const isInstalled = checkIfInstalled(libraryNode, installedFolders);
            
            matches.push({
                id: libraryNode.id || auxId,
                name: libraryNode.name || libraryNode.title || auxId,
                gitRepo: libraryNode.gitRepo || libraryNode.repository || libraryNode.url,
                matchedNodeType: nodeType,
                matchSource: 'aux_id',
                isInstalled,
                hasMultipleOptions: false,
                alternatives: []
            });
        } else {
            unresolved.push({ type: nodeType, reason: `Aux ID not found: ${auxId}` });
        }
    }
    
    // Step 3: Process remaining node types using extension-node-map.json mappings
    // Build name_to_packs map like ComfyUI-Manager does
    const nameToPacksMap = new Map();
    for (const [url, data] of Object.entries(mappings)) {
        // data can be [nodeNames, metadata] or just nodeNames array
        const nodeNames = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0] : data) : [];
        for (const nodeName of nodeNames) {
            if (!nodeName || typeof nodeName !== 'string') continue;
            if (!nameToPacksMap.has(nodeName)) {
                nameToPacksMap.set(nodeName, []);
            }
            nameToPacksMap.get(nodeName).push(url);
        }
    }
    
    for (const nodeType of nodeTypesList) {
        if (!nodeType || typeof nodeType !== 'string') continue;
        if (processedNodeTypes.has(nodeType)) continue;
        
        processedNodeTypes.add(nodeType);
        const nodeTypeInstalled = installedTypes.has(nodeType);
        
        // Find which packages provide this node type
        const packUrls = nameToPacksMap.get(nodeType.trim()) || [];
        
        if (packUrls.length === 0) {
            // If the node type is already registered/installed, it's satisfied, but we do NOT
            // show it in the UI because we can't map it to a specific repo/package (no match).
            if (!nodeTypeInstalled) {
                unresolved.push({ type: nodeType, reason: 'Not found in mappings' });
            }
            continue;
        }
        
        // Build candidate packages for this node type.
        // Important behavior:
        // - If ANY candidate is already installed, we ONLY show that installed candidate (no dropdown).
        // - We ONLY show multiple candidates (dropdown) when NONE are installed.
        //
        // We detect "installed" primarily by custom_nodes folder name matching against the
        // extension-node-map pack URL repo name (most reliable for "which package is installed").
        const candidateMap = new Map(); // key -> { id, name, gitRepo, isInstalled }
        for (const url of packUrls) {
            if (!url || typeof url !== 'string') continue;
            const repoName = extractRepoName(url);
            const packInstalled =
                repoName && installedFolders && installedFolders.has(repoName.toLowerCase());

            const keyBase = (repoName || url).toLowerCase();

            // Prefer library metadata when available, but still fall back to the URL itself.
            const nodesByName = repoName ? (repoNameToNodesMap.get(repoName.toLowerCase()) || []) : [];
            const directMatch = repoToNodeMap.get(url.toLowerCase());

            const addCandidate = (nodeLike) => {
                const gitRepo = nodeLike?.gitRepo || nodeLike?.repository || nodeLike?.url || url;
                const name = nodeLike?.name || nodeLike?.title || repoName || url;
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
                        name: existing.name || name,
                    });
                }
            };

            if (nodesByName.length > 0) {
                for (const n of nodesByName) addCandidate(n);
            }
            if (directMatch) addCandidate(directMatch);

            // If the nuvu library doesn't have metadata for this pack URL, still expose the option
            // (this is the case where users need the dropdown to pick which repo provides the node).
            if (nodesByName.length === 0 && !directMatch) {
                addCandidate({ id: keyBase, name: repoName || url, gitRepo: url });
            }
        }

        const candidates = Array.from(candidateMap.values())
            .filter(c => c && c.gitRepo)
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        if (candidates.length === 0) {
            // If the node type is already registered/installed, it's satisfied, but we do NOT
            // show it in the UI because we can't map it to a specific repo/package (no match).
            if (!nodeTypeInstalled) {
                unresolved.push({
                    type: nodeType,
                    reason: 'Extension URL found but not in nuvu library',
                    urls: packUrls
                });
            }
            continue;
        }

        const installedCandidates = candidates.filter(c => c.isInstalled);
        if (installedCandidates.length > 0) {
            // Workflow satisfied by installed package: show ONLY the installed package (disabled).
            const primaryInstalled = installedCandidates[0];
            matches.push({
                id: primaryInstalled.id,
                name: primaryInstalled.name,
                gitRepo: primaryInstalled.gitRepo,
                matchedNodeType: nodeType,
                matchSource: 'mapping',
                isInstalled: true,
                hasMultipleOptions: false,
                alternatives: []
            });
            continue;
        }

        // If the node type is already available in this ComfyUI instance (native or otherwise),
        // we do NOT show any package options. Only show options when the node type is missing.
        if (nodeTypeInstalled) {
            continue;
        }

        // Missing: show dropdown options (all active) so the user can choose.
        const primary = candidates[0];
        const alternatives = candidates.slice(1).map(c => ({
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
            matchSource: 'mapping',
            isInstalled: false,
            hasMultipleOptions: alternatives.length > 0,
            alternatives
        });
    }
    
    // Deduplicate by ID
    const seen = new Set();
    const deduped = matches.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    });
    
    return { matches: deduped, unresolved };
}

/**
 * Check if a library node is installed based on folder name matching
 */
function checkIfInstalled(node, installedFolders) {
    if (!node || !installedFolders || installedFolders.size === 0) return false;
    
    const repoUrl = node.gitRepo || node.repository || node.url || '';
    const repoName = extractRepoName(repoUrl);
    if (repoName && installedFolders.has(repoName.toLowerCase())) {
        return true;
    }
    
    // Also check node name/title
    const name = node.name || node.title || '';
    if (name && installedFolders.has(name.toLowerCase())) {
        return true;
    }
    
    return false;
}

/**
 * Extract repository name from git URL
 * @param {string} url - Git repository URL
 * @returns {string|null} Repository name or null
 */
function extractRepoName(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    
    try {
        // Handle various URL formats
        const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
        const parts = cleaned.split('/');
        return parts[parts.length - 1] || null;
    } catch (error) {
        return null;
    }
}

/**
 * Extract aux_id style "owner/repo" from a repository identifier.
 * Supports:
 * - https://github.com/owner/repo(.git)
 * - git@github.com:owner/repo(.git)
 * - owner/repo
 */
function extractAuxId(repo) {
    if (!repo || typeof repo !== 'string') return null;
    const s = repo.trim().replace(/\.git$/i, '');

    // git@github.com:owner/repo
    let m = s.match(/github\.com[:/]+([^/]+\/[^/]+)/i);
    if (m && m[1]) return m[1].replace(/\/$/, '');

    // plain owner/repo
    m = s.match(/^([^/\\\s]+)\/([^/\\\s]+)$/);
    if (m) return `${m[1]}/${m[2]}`;

    return null;
}

/**
 * Match model references from a workflow to models in the library
 * @param {Array} modelRefs - Array of model reference objects from workflow
 * @param {Array} modelsLibrary - Array of model objects from library
 * @param {Array} existingModels - Array of existing model file paths
 * @returns {Object} { matches: Array, missing: Array }
 */
export function matchModels(modelRefs, modelsLibrary, existingModels) {
    const matches = [];
    const missing = [];
    
    // Safely handle bad inputs
    const refs = Array.isArray(modelRefs) ? modelRefs : [];
    const library = Array.isArray(modelsLibrary) ? modelsLibrary : [];
    const existing = Array.isArray(existingModels) ? existingModels : [];
    
    // Build set of existing model filenames (normalized)
    const existingSet = new Set(
        existing.map(p => {
            if (typeof p !== 'string') return '';
            const parts = p.replace(/\\/g, '/').split('/');
            return parts[parts.length - 1].toLowerCase();
        }).filter(Boolean)
    );
    
    // Also track full paths for exact matches
    const existingPaths = new Set(
        existing.map(p => typeof p === 'string' ? p.toLowerCase() : '').filter(Boolean)
    );
    
    const processed = new Set();

    const MIN_MODEL_MATCH_SCORE = 0.85;

    function _basename(p) {
        if (!p || typeof p !== 'string') return '';
        return p.split(/[/\\]/).pop();
    }

    function _stripKnownExtension(filename) {
        if (!filename || typeof filename !== 'string') return filename;
        // Only strip common model file extensions (keep the rest of the name intact).
        return filename.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i, '');
    }

    function _normalizeForMatch(s) {
        if (!s || typeof s !== 'string') return '';
        // Lowercase + remove separators and punctuation to match "foo-bar_v2" with "foo bar v2"
        // Keep alphanumerics only.
        return s
            .toLowerCase()
            .replace(/[_\-\.\s]+/g, '')
            .replace(/[^a-z0-9]/g, '');
    }

    function _levenshteinDistance(a, b) {
        if (a === b) return 0;
        if (!a) return b.length;
        if (!b) return a.length;

        const aLen = a.length;
        const bLen = b.length;

        // Ensure a is the shorter string to reduce memory.
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
                    prev[i] + 1,          // deletion
                    curr[i - 1] + 1,      // insertion
                    prev[i - 1] + cost    // substitution
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
        if (na === nb) return 1.0;
        const dist = _levenshteinDistance(na, nb);
        const maxLen = Math.max(na.length, nb.length);
        if (maxLen === 0) return 0;
        return Math.max(0, 1 - (dist / maxLen));
    }
    
    for (const modelRef of refs) {
        if (!modelRef) continue;
        
        // Preserve the original workflow string (often includes folders) for the "Fix Model Names" feature.
        const originalPath = modelRef.name || modelRef.filename || modelRef.model_name || '';
        const modelName = originalPath;
        if (!modelName || typeof modelName !== 'string') continue;
        
        const normalizedName = modelName.toLowerCase();
        const filename = _basename(modelName).toLowerCase();
        const filenameNoExt = _stripKnownExtension(filename);
        // Unique ID for this workflow reference (do NOT use the library model id here).
        // Multiple different workflow refs can legitimately match the same library model.
        const referenceId = normalizedName;
        
        if (processed.has(filename)) continue;
        processed.add(filename);
        
        // Check if the *referenced* name already exists locally (used for unmatched items)
        const referencedIsInstalled = existingSet.has(filename) || existingPaths.has(normalizedName);
        
        // Find matching models in library.
        // Requirements:
        // - Consider BOTH fuzzy >= 85% and prefix-8 fallback as potential options
        // - If multiple matches exist, return them as alternatives (dropdown in UI)
        // - De-dupe if the same model matches via both methods (keep best score; record both sources)
        const candidateMap = new Map(); // modelId -> { model, score, matchSource, isInstalled }

        function _addCandidate(model, score, matchSource, isInstalled) {
            if (!model || !model.id) return;
            const id = model.id;
            const existing = candidateMap.get(id);
            if (!existing) {
                candidateMap.set(id, { model, score, matchSource, isInstalled });
                return;
            }
            // Merge: keep highest score, installed if either says installed,
            // and preserve matchSource information.
            const bestScore = Math.max(existing.score || 0, score || 0);
            const installed = Boolean(existing.isInstalled || isInstalled);
            let source = existing.matchSource || matchSource;
            if (existing.matchSource && matchSource && existing.matchSource !== matchSource) {
                // Keep stable, readable combined source label
                const parts = new Set(String(source).split('+').concat(String(matchSource).split('+')));
                source = Array.from(parts).sort().join('+');
            }
            candidateMap.set(id, { model: existing.model || model, score: bestScore, matchSource: source, isInstalled: installed });
        }

        for (const model of library) {
            if (!model) continue;

            const libraryName = model.modelName || model.name || model.filename || '';
            if (!libraryName) continue;

            const libraryFilename = _basename(String(libraryName)).toLowerCase();
            const libraryFilenameNoExt = _stripKnownExtension(libraryFilename);

            let score = 0;
            if (libraryFilename === filename) {
                score = 1.0;
            } else {
                score = Math.max(
                    _similarityScore(filename, libraryFilename),
                    _similarityScore(filenameNoExt, libraryFilenameNoExt)
                );
            }

            if (score >= MIN_MODEL_MATCH_SCORE) {
                const candidateInstalled = existingSet.has(libraryFilename) || existingSet.has(_stripKnownExtension(libraryFilename)) || existingPaths.has(libraryFilename);
                _addCandidate(model, score, 'library', candidateInstalled);
            }
        }

        // Prefix-8 fallback is ALSO considered as a potential option (even if fuzzy candidates exist).
        const refNorm = _normalizeForMatch(filenameNoExt || filename);
        if (refNorm && refNorm.length >= 8) {
            const prefix8 = refNorm.slice(0, 8);
            for (const model of library) {
                if (!model) continue;
                const libraryName = model.modelName || model.name || model.filename || '';
                if (!libraryName) continue;

                const libraryFilename = _basename(String(libraryName)).toLowerCase();
                const libraryFilenameNoExt = _stripKnownExtension(libraryFilename);
                const libNorm = _normalizeForMatch(libraryFilenameNoExt || libraryFilename);

                if (!libNorm || libNorm.length < 8) continue;
                if (libNorm.slice(0, 8) !== prefix8) continue;

                const prefixScore = _similarityScore(refNorm, libNorm);
                const candidateInstalled = existingSet.has(libraryFilename) || existingSet.has(_stripKnownExtension(libraryFilename)) || existingPaths.has(libraryFilename);
                // Treat prefix match as valid; clamp to threshold so it isn't rejected by downstream logic.
                _addCandidate(model, Math.max(prefixScore, MIN_MODEL_MATCH_SCORE), 'prefix8', candidateInstalled);
            }
        }

        const candidates = Array.from(candidateMap.values());

        // Sort candidates: non-installed first, then best score, then name for stability.
        candidates.sort((a, b) => {
            if (a.isInstalled !== b.isInstalled) return a.isInstalled ? 1 : -1;
            if (b.score !== a.score) return b.score - a.score;
            const an = (a.model?.modelName || a.model?.name || '').toString();
            const bn = (b.model?.modelName || b.model?.name || '').toString();
            return an.localeCompare(bn);
        });

        const primary = candidates[0] || null;
        const alternatives = candidates.slice(1).map(c => ({
            libraryId: c.model.id,
            modelName: c.model.modelName || c.model.name,
            url: c.model.url || c.model.modelUrl || c.model.fileUrl || c.model.downloadUrl,
            installFolder: c.model.installFolder || c.model.category || 'diffusion_models',
            hfTokenRequired: c.model.hfTokenRequired || false,
            score: c.score,
            isInstalled: c.isInstalled,
            matchSource: c.matchSource,
        }));
        
        // Only accept high-confidence matches (avoid wrong installs).
        if (primary) {
            matches.push({
                id: referenceId,
                libraryId: primary.model.id,
                modelName: primary.model.modelName || primary.model.name,
                detectedName: modelName,
                originalPath,
                url: primary.model.url || primary.model.modelUrl || primary.model.fileUrl || primary.model.downloadUrl,
                installFolder: primary.model.installFolder || primary.model.category || 'diffusion_models',
                hfTokenRequired: primary.model.hfTokenRequired || false,
                score: primary.score,
                isInstalled: primary.isInstalled,
                matchSource: primary.matchSource,
                hasMultipleOptions: alternatives.length > 0,
                alternatives,
            });
        } else {
            // Model not found in library
            missing.push({
                name: modelName,
                nodeType: modelRef.nodeType,
                isInstalled: referencedIsInstalled
            });
        }
    }
    
    return { matches, missing };
}

