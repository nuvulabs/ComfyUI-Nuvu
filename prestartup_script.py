"""
ComfyUI-Nuvu Prestartup Script

This script runs during ComfyUI's prestartup phase BEFORE extensions are loaded.
It handles:
1. Installing uv (fast Python package installer) if not present
2. Installing/updating Nuvu requirements (while .pyd files aren't locked)

"""

import os
import sys
import subprocess
import logging

logger = logging.getLogger("ComfyUI-Nuvu")

# Add src directory to path so we can import from the package
# This works whether or not the package is pip-installed
_script_dir = os.path.dirname(os.path.abspath(__file__))
_src_dir = os.path.join(_script_dir, "src")
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)


def _get_install_cmd(requirements_path, use_reinstall=False):
    """
    Get the install command, preferring uv over pip.
    Returns (cmd, tool_name) tuple.
    """
    # Try uv first via pip_utils
    try:
        from comfyui_nuvu.pip_utils import make_pip_cmd, get_current_tool
        tool = get_current_tool()
        
        args = ['install', '--quiet', '--no-warn-script-location']
        if use_reinstall:
            # uv uses --reinstall, pip uses --force-reinstall
            args.append('--reinstall' if tool == 'uv' else '--force-reinstall')
        args.extend(['-r', requirements_path])
        
        return make_pip_cmd(args), tool
    except ImportError:
        pass
    
    # Fallback to pip directly
    args = [sys.executable, '-m', 'pip', 'install', '--quiet', '--no-warn-script-location']
    if use_reinstall:
        args.append('--force-reinstall')
    args.extend(['-r', requirements_path])
    
    return args, "pip"


def _install_requirements():
    """
    Install Nuvu requirements.txt during prestartup (before .pyd files are loaded).
    This avoids Windows file lock issues when updating the comfyui-nuvu package.
    """
    requirements_path = os.path.join(_script_dir, "requirements.txt")
    if not os.path.isfile(requirements_path):
        return
    
    cmd, tool = _get_install_cmd(requirements_path, use_reinstall=False)
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
            cwd=_script_dir,
        )
        
        # Check for RECORD file error (corrupted previous install)
        output = (result.stderr or "") + (result.stdout or "")
        if result.returncode != 0 and ("no RECORD file" in output or "uninstall-no-record-file" in output):
            logger.info(f"[ComfyUI-Nuvu] Detected corrupted install, retrying with {tool} reinstall flag")
            
            # Retry with reinstall flag to fix corrupted installation
            retry_cmd, tool = _get_install_cmd(requirements_path, use_reinstall=True)
            
            result = subprocess.run(
                retry_cmd,
                capture_output=True,
                text=True,
                timeout=300,
                cwd=_script_dir,
            )
        
        if result.returncode == 0:
            logger.debug(f"[ComfyUI-Nuvu] Requirements installed successfully with {tool}")
        else:
            # Log error but don't fail - the extension might still work
            error_msg = result.stderr or result.stdout or "Unknown error"
            logger.warning(f"[ComfyUI-Nuvu] Requirements install returned non-zero: {error_msg[:200]}")
    except subprocess.TimeoutExpired:
        logger.warning("[ComfyUI-Nuvu] Requirements install timed out")
    except Exception as e:
        logger.warning(f"[ComfyUI-Nuvu] Requirements install error: {e}")


# Step 1: Install uv if needed
try:
    from comfyui_nuvu.uv_installer import run_prestartup
    run_prestartup()
except ImportError as e:
    # Package not available yet - this can happen on first install
    logger.debug(f"[ComfyUI-Nuvu] uv_installer not available yet (first install?): {e}")
except Exception as e:
    # Non-fatal error - pip will be used as fallback
    logger.warning(f"[ComfyUI-Nuvu] uv setup error (non-fatal): {e}")

# Step 2: Install requirements (before extension loads, so .pyd isn't locked)
try:
    _install_requirements()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Requirements install error (non-fatal): {e}")
