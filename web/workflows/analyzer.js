// Workflow Analyzer
// Analyzes ComfyUI workflows to extract dependencies
// Mirrors ComfyUI-Manager's approach to finding missing nodes

/**
 * Get dependencies from the current workflow loaded in ComfyUI
 * Returns customNodes (node types), cnrIds, auxIds, and models
 * @returns {Object} Object containing customNodes, cnrIds, auxIds, models
 */
export function getCurrentWorkflowDependencies() {
    try {
        // Access the ComfyUI app instance
        const app = window.app;
        if (!app || !app.graph) {
            return { customNodes: [], cnrIds: {}, auxIds: {}, models: [] };
        }
        
        // Prefer analyzing the serialized workflow graph because it contains the
        // persisted `properties` and `widgets_values` from the workflow JSON.
        // Some runtime node instances may not retain all custom `properties`
        // (like aux_id/cnr_id or properties.models).
        let serializedDeps = null;
        try {
            if (typeof app.graph.serialize === 'function') {
                const serialized = app.graph.serialize();
                serializedDeps = analyzeWorkflowJson(serialized);
            }
        } catch {
            // ignore, we'll fall back to runtime graph traversal
        }
        
        const customNodes = new Set(); // Node type strings
        const cnrIds = {};              // cnr_id -> node_type mapping
        const auxIds = {};              // aux_id -> node_type mapping
        const models = [];
        const visitedGraphs = new Set();
        
        // Recursively visit graphs (handles subgraphs)
        const visitGraph = (graph) => {
            if (!graph || visitedGraphs.has(graph)) return;
            visitedGraphs.add(graph);
            
            const nodes = graph._nodes || graph.nodes || [];
            for (const node of nodes) {
                if (!node) continue;
                
                // Handle SubgraphNodes - recurse into their graph
                if (node.isSubgraphNode?.() && node.subgraph) {
                    visitGraph(node.subgraph);
                }
                
                if (!node.type) continue;
                
                // Skip group nodes (workflow>xxx format)
                if (typeof node.type === 'string' && node.type.startsWith('workflow>')) {
                    // Process group node's internal nodes
                    const groupName = node.type.slice(9);
                    const groupData = app.graph?.extra?.groupNodes?.[groupName];
                    if (groupData?.nodes) {
                        for (const subNode of groupData.nodes) {
                            if (subNode?.type) {
                                customNodes.add(subNode.type);
                            }
                        }
                    }
                    continue;
                }
                
                // Add node type to the set
                customNodes.add(node.type);
                
                // Extract CNR ID if present (ComfyRegistry identifier)
                if (node.properties?.cnr_id) {
                    cnrIds[node.properties.cnr_id] = node.type;
                }
                
                // Extract aux_id if present (legacy GitHub identifier)
                if (node.properties?.aux_id) {
                    auxIds[node.properties.aux_id] = node.type;
                }

                // Some workflows embed explicit model requirements under node.properties.models
                // Example:
                //   properties: { models: [{ name, url, directory }] }
                if (Array.isArray(node.properties?.models)) {
                    for (const m of node.properties.models) {
                        if (!m || typeof m !== 'object') continue;
                        if (typeof m.name !== 'string' || !m.name.trim()) continue;
                        models.push({
                            name: m.name.trim(),
                            url: typeof m.url === 'string' ? m.url : undefined,
                            directory: typeof m.directory === 'string' ? m.directory : undefined,
                            nodeType: node.type,
                            propertyName: 'models'
                        });
                    }
                }
                
                // Collect model references from widgets
                if (node.widgets) {
                    for (const widget of node.widgets) {
                        if (isModelWidget(widget)) {
                            const modelName = widget.value;
                            if (modelName && typeof modelName === 'string' && modelName.trim()) {
                                models.push({
                                    name: modelName.trim(),
                                    nodeType: node.type,
                                    widgetName: widget.name
                                });
                            }
                        }
                    }
                }
                
                // Check properties for model references
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
        
        visitGraph(app.graph);

        // Merge in serialized workflow-derived data (if available)
        if (serializedDeps) {
            for (const t of serializedDeps.customNodes || []) {
                if (typeof t === 'string' && t) customNodes.add(t);
            }
            Object.assign(cnrIds, serializedDeps.cnrIds || {});
            Object.assign(auxIds, serializedDeps.auxIds || {});
            if (Array.isArray(serializedDeps.models)) {
                for (const m of serializedDeps.models) {
                    if (m && typeof m.name === 'string' && m.name.trim()) {
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

/**
 * Check if a widget is a model selector
 * @param {Object} widget - Widget object
 * @returns {boolean}
 */
function isModelWidget(widget) {
    if (!widget || !widget.name) return false;
    
    const modelWidgetNames = [
        'ckpt_name', 'model_name', 'vae_name', 'clip_name',
        'lora_name', 'control_net_name', 'unet_name',
        'model', 'checkpoint', 'vae', 'lora', 'controlnet'
    ];
    
    const name = widget.name.toLowerCase();
    return modelWidgetNames.some(n => name.includes(n));
}

/**
 * Check if a property contains a model reference
 * @param {string} key - Property key
 * @param {any} value - Property value
 * @returns {boolean}
 */
function isModelProperty(key, value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    
    const keyLower = key.toLowerCase();
    const modelKeywords = ['model', 'ckpt', 'checkpoint', 'vae', 'lora', 'unet'];
    
    // Check if key suggests it's a model reference
    if (!modelKeywords.some(k => keyLower.includes(k))) return false;
    
    // Check if value looks like a model filename
    const valueLower = value.toLowerCase();
    const modelExtensions = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'];
    return modelExtensions.some(ext => valueLower.endsWith(ext));
}

/**
 * Remove duplicate model references
 * @param {Array} refs - Array of model reference objects
 * @returns {Array} Deduplicated array
 */
function deduplicateModelRefs(refs) {
    const seen = new Set();
    return refs.filter(ref => {
        const key = ref.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Analyze a workflow JSON object
 * @param {Object} workflow - Workflow JSON object
 * @returns {Object} Dependencies object
 */
export function analyzeWorkflowJson(workflow) {
    const customNodes = new Set();
    const cnrIds = {};
    const auxIds = {};
    const models = [];
    
    if (!workflow) return { customNodes: [], cnrIds: {}, auxIds: {}, models: [] };
    
    // Handle both graph formats
    const nodes = workflow.nodes || (workflow.workflow && workflow.workflow.nodes) || [];
    
    for (const node of nodes) {
        if (!node) continue;
        
        if (node.type) {
            customNodes.add(node.type);
        }
        
        // Extract CNR ID if present
        if (node.properties?.cnr_id) {
            cnrIds[node.properties.cnr_id] = node.type;
        }
        
        // Extract aux_id if present
        if (node.properties?.aux_id) {
            auxIds[node.properties.aux_id] = node.type;
        }

        // Pick up explicit model requirements embedded in properties.models
        if (Array.isArray(node.properties?.models)) {
            for (const m of node.properties.models) {
                if (!m || typeof m !== 'object') continue;
                if (typeof m.name !== 'string' || !m.name.trim()) continue;
                models.push({
                    name: m.name.trim(),
                    url: typeof m.url === 'string' ? m.url : undefined,
                    directory: typeof m.directory === 'string' ? m.directory : undefined,
                    nodeType: node.type,
                    propertyName: 'models'
                });
            }
        }
        
        // Check widgets_values for model references
        if (node.widgets_values && Array.isArray(node.widgets_values)) {
            for (const value of node.widgets_values) {
                if (typeof value === 'string' && looksLikeModelFilename(value)) {
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

/**
 * Check if a string looks like a model filename
 * @param {string} value - String to check
 * @returns {boolean}
 */
function looksLikeModelFilename(value) {
    if (!value || typeof value !== 'string') return false;
    const lower = value.toLowerCase();
    const extensions = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'];
    return extensions.some(ext => lower.endsWith(ext));
}

