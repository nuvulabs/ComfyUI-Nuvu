// Core component creation utilities
// NEW CODE - Modern component approach

export function createElement(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    
    // Apply props
    Object.entries(props).forEach(([key, value]) => {
        if (key === 'className') {
            element.className = value;
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(element.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            // Direct event handler assignment (onclick, oninput, onchange, etc.)
            const eventProp = key.charAt(2).toLowerCase() + key.slice(3);
            element['on' + eventProp] = value;
        } else if (value !== null && value !== undefined) {
            element.setAttribute(key, value);
        }
    });
    
    // Append children (filter out null, undefined, and false)
    children.flat().forEach(child => {
        if (child != null && child !== false) {
            element.append(
                typeof child === 'string' ? document.createTextNode(child) : child
            );
        }
    });
    
    return element;
}

// Shorthand helpers
export const div = (...args) => createElement('div', ...args);
export const span = (...args) => createElement('span', ...args);
export const button = (...args) => createElement('button', ...args);
export const input = (...args) => createElement('input', ...args);
export const label = (...args) => createElement('label', ...args);
export const h1 = (...args) => createElement('h1', ...args);
export const h2 = (...args) => createElement('h2', ...args);
export const h3 = (...args) => createElement('h3', ...args);
export const p = (...args) => createElement('p', ...args);
export const ul = (...args) => createElement('ul', ...args);
export const li = (...args) => createElement('li', ...args);
export const a = (...args) => createElement('a', ...args);
export const strong = (...args) => createElement('strong', ...args);
export const svg = (...args) => createElement('svg', ...args);
export const path = (...args) => createElement('path', ...args);
export const img = (...args) => createElement('img', ...args);



