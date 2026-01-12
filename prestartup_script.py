"""
ComfyUI-Nuvu Prestartup Script

This script runs during ComfyUI's prestartup phase BEFORE extensions are loaded.
It handles:
1. Installing uv (fast Python package installer) if not present
2. Installing requirements.txt (before .pyd files are loaded/locked)

IMPORTANT: This script must NOT import from comfyui_nuvu to avoid locking .pyd files.
"""

import os
import sys
import subprocess
import shutil
import platform
import logging

logger = logging.getLogger("ComfyUI-Nuvu")

_script_dir = os.path.dirname(os.path.abspath(__file__))


def _get_uv_paths():
    """Get platform-specific uv paths."""
    if platform.system() == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            uv_dir = os.path.join(local_app_data, "nuvu", "bin")
        else:
            uv_dir = os.path.join(os.path.expanduser("~"), "AppData", "Local", "nuvu", "bin")
        uv_exe = os.path.join(uv_dir, "uv.exe")
        download_url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    else:
        uv_dir = os.path.join(os.path.expanduser("~"), ".local", "bin")
        uv_exe = os.path.join(uv_dir, "uv")
        download_url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz"
    
    return uv_dir, uv_exe, download_url


def _find_uv():
    """Find uv executable without importing from comfyui_nuvu."""
    uv_dir, uv_exe, _ = _get_uv_paths()
    if os.path.isfile(uv_exe):
        return uv_exe
    return shutil.which("uv")


def _install_uv():
    """Install uv to the platform-specific location if not already present."""
    uv_dir, uv_exe, download_url = _get_uv_paths()
    
    if os.path.isfile(uv_exe):
        return uv_exe
    
    try:
        os.makedirs(uv_dir, exist_ok=True)
        
        if platform.system() == "Windows":
            import urllib.request
            import zipfile
            import tempfile
            
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
                tmp_path = tmp.name
            
            try:
                logger.info("[ComfyUI-Nuvu] Downloading uv...")
                urllib.request.urlretrieve(download_url, tmp_path)
                
                with zipfile.ZipFile(tmp_path, 'r') as zf:
                    for member in zf.namelist():
                        if member.endswith("uv.exe"):
                            with zf.open(member) as src, open(uv_exe, 'wb') as dst:
                                dst.write(src.read())
                            break
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        else:
            import urllib.request
            import tarfile
            import tempfile
            
            with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
                tmp_path = tmp.name
            
            try:
                logger.info("[ComfyUI-Nuvu] Downloading uv...")
                urllib.request.urlretrieve(download_url, tmp_path)
                
                with tarfile.open(tmp_path, 'r:gz') as tf:
                    for member in tf.getmembers():
                        if member.name.endswith("/uv") or member.name == "uv":
                            member.name = "uv"
                            tf.extract(member, uv_dir)
                            break
                
                os.chmod(uv_exe, 0o755)
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        
        if os.path.isfile(uv_exe):
            logger.info(f"[ComfyUI-Nuvu] uv installed to {uv_exe}")
            return uv_exe
    except Exception as e:
        logger.warning(f"[ComfyUI-Nuvu] Failed to install uv: {e}")
    
    return None


def _install_requirements():
    """Install requirements.txt using uv or pip (without importing comfyui_nuvu)."""
    requirements_path = os.path.join(_script_dir, "requirements.txt")
    if not os.path.isfile(requirements_path):
        return
    
    # Find or install uv
    uv_path = _find_uv()
    if not uv_path:
        uv_path = _install_uv()
    
    # Build install command
    if uv_path:
        cmd = [uv_path, 'pip', 'install', '--quiet', '-r', requirements_path]
        tool = "uv"
    else:
        cmd = [sys.executable, '-m', 'pip', 'install', '--quiet', '-r', requirements_path]
        tool = "pip"
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=_script_dir,
        )
        
        if result.returncode == 0:
            logger.debug(f"[ComfyUI-Nuvu] Requirements installed with {tool}")
        else:
            output = (result.stderr or "") + (result.stdout or "")
            logger.warning(f"[ComfyUI-Nuvu] Requirements install issue: {output[:200]}")
    except subprocess.TimeoutExpired:
        logger.warning("[ComfyUI-Nuvu] Requirements install timed out")
    except Exception as e:
        logger.warning(f"[ComfyUI-Nuvu] Requirements install error: {e}")


# Run on module load (prestartup phase)
try:
    _install_requirements()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}")
