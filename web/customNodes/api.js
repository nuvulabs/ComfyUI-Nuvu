// Custom Nodes API
// Fetches custom node library and mappings for Install Missing panel

import * as state from '../core/state.js';

/**
 * Fetch all custom nodes from the library
 * @returns {Promise<Array>} Array of custom node objects
 */
export async function fetchCustomNodesLibrary() {
    try {
        const response = await fetch('/nuvu/custom-nodes', {
            headers: {
                'Authorization': `Bearer ${state.currentUser?.apiToken || ''}`,
                'Content-Type': 'application/json'
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

/**
 * Fetch node type mappings from ComfyUI-Manager
 * @returns {Promise<Object>} Node mappings object
 */
export async function fetchNodeMappings() {
    try {
        const response = await fetch('/nuvu/node-mappings', {
            headers: {
                'Content-Type': 'application/json'
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

/**
 * Fetch list of installed custom nodes
 * @returns {Promise<Array>} Array of installed custom node names
 */
export async function fetchInstalledCustomNodes() {
    try {
        const response = await fetch('/nuvu/custom-nodes/check-installed', {
            headers: {
                'Authorization': `Bearer ${state.currentUser?.apiToken || ''}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch installed custom nodes: ${response.status}`);
        }
        
        const data = await response.json();
        // Backend returns { installedNodes: [...] }
        return data.installedNodes || [];
    } catch (error) {
        return [];
    }
}





