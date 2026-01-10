"""
ComfyUI-Nuvu Prestartup Script

This script runs during ComfyUI's prestartup phase and handles installing
uv (fast Python package installer) if not already present.

"""

import os
import sys

# Add src directory to path so we can import from the package
# This works whether or not the package is pip-installed
_script_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.join(_script_dir, "src")
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

try:
    from comfyui_nuvu.uv_installer import run_prestartup
    run_prestartup()
except ImportError as e:
    # Package not available yet - this can happen on first install
    # uv installation will be skipped, pip will be used as fallback
    import logging
    logging.getLogger("ComfyUI-Nuvu").debug(
        f"[ComfyUI-Nuvu] uv_installer not available yet (first install?): {e}"
    )
except Exception as e:
    # Non-fatal error - pip will be used as fallback
    import logging
    logging.getLogger("ComfyUI-Nuvu").warning(
        f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}"
    )
