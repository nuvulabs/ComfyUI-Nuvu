// Modal component
// NEW CODE - Component library

import { div, button } from './core.js';

export function Modal({ 
    title,
    subtitle,
    children,
    onClose,
    maxWidth = '600px',
    showCloseButton = true
}) {
    // Create overlay
    const overlay = div({ 
        className: 'nuvu-modal-overlay',
        onClick: (e) => {
            if (e.target === overlay && onClose) {
                onClose();
            }
        }
    });
    
    // Create modal content
    const modal = div(
        { 
            className: 'nuvu-modal',
            style: { maxWidth }
        },
        title && div(
            { className: 'nuvu-modal-header' },
            div(
                { className: 'nuvu-modal-title-group' },
                div({ className: 'nuvu-modal-title' }, title),
                subtitle && div({ className: 'nuvu-modal-subtitle' }, subtitle)
            ),
            (onClose && showCloseButton)
                ? button(
                    { 
                        className: 'nuvu-modal-close',
                        onClick: onClose
                    },
                    '×'
                )
                : null
        ),
        div({ className: 'nuvu-modal-body' }, ...children)
    );
    
    overlay.appendChild(modal);
    
    return overlay;
}










