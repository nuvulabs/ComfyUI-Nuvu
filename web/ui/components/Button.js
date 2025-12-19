// Button component
// NEW CODE - Component library

import { button } from './core.js';

export function Button({ 
    text, 
    onClick, 
    variant = 'primary', 
    disabled = false,
    large = false,
    icon = null,
    id = null
}) {
    // Build CSS classes
    const classes = ['nuvu-btn', `nuvu-btn-${variant}`];
    if (large) classes.push('nuvu-btn-large');
    if (icon) classes.push('nuvu-btn-with-icon');
    
    // Build props object
    const props = {
        className: classes.join(' '),
        onClick
    };
    
    if (id) props.id = id;
    if (disabled) props.disabled = disabled;
    
    // Create button element
    const btnElement = icon ? button(props, icon, text) : button(props, text);
    
    return btnElement;
}


