"""
ComfyUI-Nuvu Extension
Custom node entrypoint for ComfyUI.

This file is only loaded by ComfyUI when discovering custom nodes.
It imports the server module from the comfyui_nuvu package (installed via pip)
to register the API routes.
"""

import logging

WEB_DIRECTORY = "web"

# Define empty mappings so the module imports successfully and the web folder is registered.
# This follows the same pattern used by ComfyUI-Manager and ComfyUI-SubgraphSearch.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Import server module to register routes
try:
    from comfyui_nuvu import nuvu_server
    logging.info("Nuvu: Server routes registered successfully")
except Exception as err:
    logging.error("Nuvu: Failed to import server module: %s", err)
    import traceback
    traceback.print_exc()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

