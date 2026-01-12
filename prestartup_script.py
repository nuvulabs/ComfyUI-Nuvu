"""
ComfyUI-Nuvu Prestartup Script

This script runs during ComfyUI's prestartup phase BEFORE extensions are loaded.
It handles installing uv (fast Python package installer) if not present.

IMPORTANT: This script must NOT import from comfyui_nuvu to avoid locking .pyd files.
"""

import os
import platform
import logging

logger = logging.getLogger("ComfyUI-Nuvu")


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


# Run on module load (prestartup phase)
try:
    _install_uv()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}")
