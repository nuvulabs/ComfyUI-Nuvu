"""
ComfyUI-Nuvu Prestartup Script

This script runs during ComfyUI's prestartup phase BEFORE extensions are loaded.
It handles:
1. Installing uv (fast Python package installer) if not present
2. Installing pending requirements (before .pyd files are loaded/locked)

IMPORTANT: This script must NOT import from comfyui_nuvu to avoid locking .pyd files.
"""

import os
import sys
import subprocess
import shutil
import platform
import logging
import filecmp

logger = logging.getLogger("ComfyUI-Nuvu")

_script_dir = os.path.dirname(os.path.abspath(__file__))


# =============================================================================
# Requirements Tracking (inline to avoid importing comfyui_nuvu)
# =============================================================================

def _cleanup_orphaned_dist_info():
    """
    Clean up orphaned comfyui_nuvu .dist-info directories.
    
    These can accumulate when installations are interrupted or when uv/pip
    fails to uninstall old versions due to missing RECORD files.
    """
    try:
        # Find site-packages directory
        import site
        site_packages = None
        
        # Try to find the site-packages containing comfyui_nuvu
        for sp in site.getsitepackages() + [site.getusersitepackages()]:
            if sp and os.path.isdir(sp):
                # Check if this site-packages has any comfyui_nuvu dist-info
                for item in os.listdir(sp):
                    if item.startswith('comfyui_nuvu-') and item.endswith('.dist-info'):
                        site_packages = sp
                        break
            if site_packages:
                break
        
        if not site_packages:
            return
        
        # Find all comfyui_nuvu dist-info directories
        dist_infos = []
        for item in os.listdir(site_packages):
            if item.startswith('comfyui_nuvu-') and item.endswith('.dist-info'):
                dist_infos.append(item)
        
        if len(dist_infos) <= 1:
            # Nothing to clean up
            return
        
        # Find which ones are orphaned (missing RECORD file)
        orphaned = []
        valid = []
        for dist_info in dist_infos:
            dist_info_path = os.path.join(site_packages, dist_info)
            record_path = os.path.join(dist_info_path, 'RECORD')
            if os.path.isfile(record_path):
                valid.append(dist_info)
            else:
                orphaned.append(dist_info)
        
        if not orphaned:
            return
        
        logger.info(f"[ComfyUI-Nuvu] Cleaning up {len(orphaned)} orphaned dist-info directories")
        
        for dist_info in orphaned:
            dist_info_path = os.path.join(site_packages, dist_info)
            try:
                shutil.rmtree(dist_info_path)
                logger.debug(f"[ComfyUI-Nuvu] Removed orphaned: {dist_info}")
            except Exception as e:
                logger.debug(f"[ComfyUI-Nuvu] Could not remove {dist_info}: {e}")
    
    except Exception as e:
        # Non-fatal - don't break startup for cleanup issues
        logger.debug(f"[ComfyUI-Nuvu] Dist-info cleanup skipped: {e}")


def _get_requirements_cache_path(repo_path):
    """Get the path to the cached requirements file for a repo"""
    nuvu_dir = os.path.join(repo_path, '.nuvu')
    os.makedirs(nuvu_dir, exist_ok=True)
    return os.path.join(nuvu_dir, 'installed_requirements.txt')


def _files_equal(file1, file2):
    """Check if two files are equal"""
    try:
        return filecmp.cmp(file1, file2, shallow=False)
    except Exception:
        return False


def _requirements_need_install(repo_path, requirements_filename='requirements.txt'):
    """
    Check if requirements need to be installed by comparing with cached version.
    Returns True if requirements have changed or cache doesn't exist.
    """
    requirements_path = os.path.join(repo_path, requirements_filename)
    cache_path = _get_requirements_cache_path(repo_path)
    
    if not os.path.exists(requirements_path):
        return False
    
    if not os.path.exists(cache_path):
        return True
    
    return not _files_equal(requirements_path, cache_path)


def _mark_requirements_installed(repo_path, requirements_filename='requirements.txt'):
    """Mark requirements as successfully installed by copying to cache."""
    requirements_path = os.path.join(repo_path, requirements_filename)
    cache_path = _get_requirements_cache_path(repo_path)
    
    if not os.path.exists(requirements_path):
        return False
    
    try:
        shutil.copy(requirements_path, cache_path)
        return True
    except Exception as e:
        logger.warning(f"[ComfyUI-Nuvu] Failed to cache requirements: {e}")
        return False


def _detect_comfyui_root():
    """Detect the ComfyUI root directory."""
    # Walk up from script directory to find ComfyUI root
    current = os.path.dirname(_script_dir)  # custom_nodes
    parent = os.path.dirname(current)  # Should be ComfyUI root
    
    # Verify it looks like ComfyUI
    if os.path.exists(os.path.join(parent, 'main.py')) or os.path.exists(os.path.join(parent, 'comfy')):
        return parent
    
    # Try environment variable
    env_root = os.environ.get('COMFYUI_ROOT')
    if env_root and os.path.isdir(env_root):
        return env_root
    
    return None


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


def _build_install_cmd(uv_path, requirements_path):
    """Build the install command for requirements."""
    is_embedded = "python_embeded" in sys.executable.lower()
    if uv_path:
        cmd = [uv_path, 'pip', 'install', '--quiet']
        if is_embedded:
            cmd.extend(['--system', '--python', sys.executable])
        cmd.extend(['-r', requirements_path])
    else:
        base = [sys.executable]
        if is_embedded:
            base.append('-s')
        cmd = base + ['-m', 'pip', 'install', '--quiet', '-r', requirements_path]
    return cmd


def _run_requirements_install(name, repo_path, requirements_filename, uv_path):
    """Install requirements for a specific repo if needed."""
    requirements_path = os.path.join(repo_path, requirements_filename)
    
    if not os.path.isfile(requirements_path):
        return
    
    # Check if we need to install (either requirements changed OR pending marker exists)
    needs_install = _requirements_need_install(repo_path, requirements_filename)
    has_pending = _has_pending_install_marker(repo_path)
    
    if not needs_install and not has_pending:
        logger.debug(f"[ComfyUI-Nuvu] {name} requirements already up to date")
        return
    
    logger.info(f"[ComfyUI-Nuvu] Installing {name} requirements...")
    
    cmd = _build_install_cmd(uv_path, requirements_path)
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=repo_path,
        )
        
        if result.returncode == 0:
            logger.info(f"[ComfyUI-Nuvu] {name} requirements installed successfully")
            _mark_requirements_installed(repo_path, requirements_filename)
            _remove_pending_install_marker(repo_path)  # Clear pending marker on success
        else:
            output = (result.stderr or "") + (result.stdout or "")
            # Check for file lock errors
            lock_indicators = ['Access is denied', 'os error 5', 'failed to remove file', 'being used by another process']
            if any(ind in output for ind in lock_indicators):
                logger.warning(f"[ComfyUI-Nuvu] {name} requirements have file locks - will retry on next restart")
                _create_pending_install_marker(repo_path)  # Mark for retry
            else:
                logger.warning(f"[ComfyUI-Nuvu] {name} requirements install issue: {output[:300]}")
    except subprocess.TimeoutExpired:
        logger.warning(f"[ComfyUI-Nuvu] {name} requirements install timed out")
        _create_pending_install_marker(repo_path)  # Mark for retry
    except Exception as e:
        logger.warning(f"[ComfyUI-Nuvu] {name} requirements install error: {e}")


def _has_pending_install_marker(repo_path):
    """Check if a repo has a pending install marker (created when install fails due to file locks)."""
    marker_path = os.path.join(repo_path, '.nuvu', 'pending_requirements')
    return os.path.exists(marker_path)


def _create_pending_install_marker(repo_path):
    """Create a marker to indicate requirements need to be installed on next restart."""
    nuvu_dir = os.path.join(repo_path, '.nuvu')
    os.makedirs(nuvu_dir, exist_ok=True)
    marker_path = os.path.join(nuvu_dir, 'pending_requirements')
    try:
        with open(marker_path, 'w') as f:
            f.write('')
        return True
    except Exception:
        return False


def _remove_pending_install_marker(repo_path):
    """Remove the pending install marker after successful install."""
    marker_path = os.path.join(repo_path, '.nuvu', 'pending_requirements')
    try:
        if os.path.exists(marker_path):
            os.remove(marker_path)
    except Exception:
        pass


def _get_custom_nodes_with_pending_requirements(custom_nodes_dir):
    """Find custom nodes that have pending requirements to install.
    
    Only returns nodes that have been explicitly marked for retry
    (via .nuvu/pending_requirements marker) to avoid reinstalling
    all custom nodes on every startup.
    """
    pending = []
    
    if not os.path.isdir(custom_nodes_dir):
        return pending
    
    for node_name in os.listdir(custom_nodes_dir):
        node_path = os.path.join(custom_nodes_dir, node_name)
        
        # Skip non-directories and hidden folders
        if not os.path.isdir(node_path) or node_name.startswith('.'):
            continue
        
        # Skip Nuvu itself (handled separately)
        if node_name in ('ComfyUI-Nuvu', 'ComfyUI-Nuvu-Packager'):
            continue
        
        # Only process nodes with pending install marker
        # This prevents reinstalling all nodes on every startup
        if _has_pending_install_marker(node_path):
            pending.append((node_name, node_path))
    
    return pending


def _install_pending_requirements():
    """Install pending requirements for Nuvu, ComfyUI, and custom nodes."""
    # Find or install uv
    uv_path = _find_uv()
    if not uv_path:
        uv_path = _install_uv()
    
    if uv_path:
        logger.info("[ComfyUI-Nuvu] Using uv for faster installs")
    
    # Install Nuvu requirements
    _run_requirements_install("Nuvu", _script_dir, "requirements.txt", uv_path)
    
    # Install ComfyUI requirements (if pending)
    comfyui_root = _detect_comfyui_root()
    if comfyui_root:
        _run_requirements_install("ComfyUI", comfyui_root, "requirements.txt", uv_path)
        
        # Install custom nodes requirements (if pending)
        custom_nodes_dir = os.path.join(comfyui_root, 'custom_nodes')
        pending_nodes = _get_custom_nodes_with_pending_requirements(custom_nodes_dir)
        
        if pending_nodes:
            logger.info(f"[ComfyUI-Nuvu] Found {len(pending_nodes)} custom node(s) with pending requirements")
            for node_name, node_path in pending_nodes:
                _run_requirements_install(f"Custom Node: {node_name}", node_path, "requirements.txt", uv_path)


# Run on module load (prestartup phase)
try:
    # Install any pending requirements
    _install_pending_requirements()
    
    # Clean up orphaned dist-info directories after install
    _cleanup_orphaned_dist_info()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}")
