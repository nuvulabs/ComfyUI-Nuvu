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

# =============================================================================
# CRITICAL: Ensure user site-packages is disabled for portable/embedded Python
# =============================================================================
# This is the environment variable equivalent of the -s flag passed to Python.
# Setting this ensures user site-packages (e.g., %APPDATA%\Python\...) is NOT
# used even after os.execv() restarts (which ComfyUI-Manager uses).
# Without this, conflicting package versions in user site-packages can break
# ComfyUI (e.g., huggingface_hub>=1.0 in user site-packages when <1.0 is required).
if "python_embeded" in sys.executable.lower():
    os.environ['PYTHONNOUSERSITE'] = '1'

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


def _get_torch_index_file():
    """Get the path to the torch index URL file."""
    comfyui_root = _detect_comfyui_root() or os.path.dirname(os.path.dirname(_script_dir))
    nuvu_dir = os.path.join(comfyui_root, '.nuvu')
    os.makedirs(nuvu_dir, exist_ok=True)
    return os.path.join(nuvu_dir, 'torch_index_url.txt')


def get_torch_index_url():
    """Load saved torch index URL from file."""
    index_file = _get_torch_index_file()
    if os.path.isfile(index_file):
        try:
            with open(index_file, 'r') as f:
                url = f.read().strip()
                if url:
                    return url
        except Exception:
            pass
    return None


def save_torch_index_url(url):
    """Save torch index URL to file for future use."""
    if not url:
        return
    index_file = _get_torch_index_file()
    try:
        os.makedirs(os.path.dirname(index_file), exist_ok=True)
        with open(index_file, 'w') as f:
            f.write(url)
        logger.info(f"[ComfyUI-Nuvu] Saved torch index URL: {url}")
    except Exception as e:
        logger.debug(f"[ComfyUI-Nuvu] Could not save torch index URL: {e}")


def _detect_and_save_torch_index():
    """
    Detect the installed PyTorch CUDA version and save the corresponding index URL.
    
    This is useful when:
    - User manually installed PyTorch
    - First run after fresh install
    - Index URL file was deleted
    
    Only saves if no index URL is already saved.
    """
    # Skip if already have a saved index URL
    if get_torch_index_url():
        return
    
    try:
        import torch
        if hasattr(torch, 'version') and hasattr(torch.version, 'cuda') and torch.version.cuda:
            # Extract CUDA version like "12.8" from torch
            cuda_version = torch.version.cuda
            # Convert to index format like "cu128"
            cuda_parts = cuda_version.split('.')
            if len(cuda_parts) >= 2:
                cuda_label = f"cu{cuda_parts[0]}{cuda_parts[1]}"
                index_url = f"https://download.pytorch.org/whl/{cuda_label}"
                save_torch_index_url(index_url)
                logger.debug(f"[ComfyUI-Nuvu] Detected PyTorch CUDA {cuda_version}, saved index URL")
    except ImportError:
        # PyTorch not installed yet
        pass
    except Exception as e:
        logger.debug(f"[ComfyUI-Nuvu] Could not detect PyTorch CUDA version: {e}")


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
    
    # Add torch index URL if available (ensures torch dependencies come from correct CUDA index)
    torch_index = get_torch_index_url()
    if torch_index:
        cmd.extend(['--extra-index-url', torch_index])
        logger.debug(f"[ComfyUI-Nuvu] Using torch index: {torch_index}")
    
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


def _get_pending_uninstalls_dir():
    """Get the directory for pending uninstall markers."""
    comfyui_root = _detect_comfyui_root() or os.path.dirname(os.path.dirname(_script_dir))
    nuvu_dir = os.path.join(comfyui_root, 'user', 'default', '.nuvu', 'pending_uninstalls')
    os.makedirs(nuvu_dir, exist_ok=True)
    return nuvu_dir


def _migrate_old_pending_markers():
    """Migrate old-style pending markers to new location."""
    # Old triton marker location (for backward compatibility)
    old_triton_marker = os.path.join(_script_dir, '.nuvu', 'pending_triton_uninstall')
    if os.path.exists(old_triton_marker):
        try:
            new_dir = _get_pending_uninstalls_dir()
            new_path = os.path.join(new_dir, 'triton.txt')
            shutil.move(old_triton_marker, new_path)
            logger.info("[ComfyUI-Nuvu] Migrated old triton uninstall marker to new location")
        except Exception as e:
            logger.debug(f"[ComfyUI-Nuvu] Could not migrate old marker: {e}")


def _get_all_pending_uninstall_markers():
    """Get all pending uninstall marker files."""
    # First, migrate any old-style markers
    _migrate_old_pending_markers()
    
    pending_dir = _get_pending_uninstalls_dir()
    markers = []
    
    logger.debug(f"[ComfyUI-Nuvu] Checking for pending uninstalls in: {pending_dir}")
    
    if not os.path.isdir(pending_dir):
        logger.debug(f"[ComfyUI-Nuvu] Pending uninstalls directory does not exist")
        return markers
    
    for filename in os.listdir(pending_dir):
        if filename.endswith('.txt'):
            markers.append(os.path.join(pending_dir, filename))
    
    if markers:
        logger.debug(f"[ComfyUI-Nuvu] Found pending uninstall markers: {markers}")
    
    return markers


def _force_delete_package(pkg_name):
    """Force delete a package by removing its directories from site-packages.
    
    Used when pip/uv can't uninstall due to missing RECORD file.
    """
    import site
    import re
    
    # Get site-packages directories
    site_packages_dirs = site.getsitepackages()
    if hasattr(site, 'getusersitepackages'):
        user_site = site.getusersitepackages()
        if user_site:
            site_packages_dirs.append(user_site)
    
    # Normalize package name for directory matching (pip uses underscores internally)
    pkg_normalized = pkg_name.lower().replace('-', '_')
    
    deleted = False
    for sp_dir in site_packages_dirs:
        if not os.path.isdir(sp_dir):
            continue
        
        try:
            for item in os.listdir(sp_dir):
                item_lower = item.lower().replace('-', '_')
                
                # Check for exact match (package directory like "torch" or "torchvision")
                is_exact_match = item_lower == pkg_normalized
                
                # Check for metadata directory (like "torch_2.10.0.dist_info" or "torch_2.10.0+cu130.dist_info")
                # Pattern: {package}_{version}.dist_info or .egg_info
                # The version starts with a digit, so we check for {pkg}_{digit}
                is_metadata = bool(re.match(rf'^{re.escape(pkg_normalized)}_\d', item_lower)) and \
                              ('dist_info' in item_lower or 'dist-info' in item_lower or 
                               'egg_info' in item_lower or 'egg-info' in item_lower)
                
                if is_exact_match or is_metadata:
                    item_path = os.path.join(sp_dir, item)
                    if os.path.isdir(item_path):
                        print(f"[ComfyUI-Nuvu] Force deleting: {item_path}", flush=True)
                        shutil.rmtree(item_path, ignore_errors=True)
                        deleted = True
        except Exception as e:
            logger.debug(f"[ComfyUI-Nuvu] Error scanning {sp_dir}: {e}")
    
    return deleted


def _run_pending_uninstalls(uv_path):
    """Uninstall all packages that were marked for removal on restart.
    
    This is a generic system that handles any installer's pending uninstalls.
    Marker files are stored in .nuvu/pending_uninstalls/<name>.txt
    Each file contains package names, one per line.
    
    Always uses pip for uninstalls (not uv) because pip is more lenient about
    missing RECORD files and other metadata issues.
    
    If pip fails, falls back to force deletion.
    """
    markers = _get_all_pending_uninstall_markers()
    
    if not markers:
        return
    
    print(f"\n[ComfyUI-Nuvu] Processing {len(markers)} pending uninstall(s)...", flush=True)
    
    for marker_path in markers:
        marker_name = os.path.basename(marker_path).replace('.txt', '')
        
        try:
            with open(marker_path, 'r') as f:
                packages = [pkg.strip() for pkg in f.read().strip().split('\n') if pkg.strip()]
            
            if not packages:
                os.remove(marker_path)
                continue
            
            print(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall: {', '.join(packages)}", flush=True)
            
            # Always use pip for uninstalls - it's more lenient about missing RECORD files
            is_embedded = "python_embeded" in sys.executable.lower()
            base = [sys.executable]
            if is_embedded:
                base.append('-s')
            cmd = base + ['-m', 'pip', 'uninstall', '-y']
            
            cmd.extend(packages)
            
            print(f"[ComfyUI-Nuvu] Running: {' '.join(cmd)}", flush=True)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
            )
            
            if result.returncode == 0:
                for pkg in packages:
                    print(f"[ComfyUI-Nuvu] Uninstalled: {pkg}", flush=True)
                os.remove(marker_path)
            else:
                # Check if RECORD file error - need force deletion
                error_output = result.stderr + result.stdout
                is_record_error = 'RECORD' in error_output and 'not found' in error_output.lower()
                
                # Check if packages are actually gone despite error
                all_gone = True
                still_installed = []
                for pkg in packages:
                    check_cmd = [sys.executable, '-m', 'pip', 'show', pkg]
                    check_result = subprocess.run(check_cmd, capture_output=True, text=True, timeout=30)
                    if check_result.returncode == 0:
                        # Package still installed
                        if is_record_error:
                            # Try force deletion
                            print(f"[ComfyUI-Nuvu] RECORD file missing for {pkg}, trying force delete...", flush=True)
                            if _force_delete_package(pkg):
                                # Verify it's gone
                                verify_cmd = [sys.executable, '-m', 'pip', 'show', pkg]
                                verify_result = subprocess.run(verify_cmd, capture_output=True, text=True, timeout=30)
                                if verify_result.returncode != 0:
                                    print(f"[ComfyUI-Nuvu] Force deleted: {pkg}", flush=True)
                                    continue
                        all_gone = False
                        still_installed.append(pkg)
                    else:
                        print(f"[ComfyUI-Nuvu] Uninstalled: {pkg}", flush=True)
                
                if all_gone:
                    print(f"[ComfyUI-Nuvu] {marker_name} packages verified removed", flush=True)
                    os.remove(marker_path)
                else:
                    print(f"[ComfyUI-Nuvu] {marker_name} uninstall incomplete, still installed: {', '.join(still_installed)}", flush=True)
        
        except Exception as e:
            print(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall error: {e}", flush=True)


def _get_pending_installs_dir():
    """Get the directory for pending install markers."""
    comfyui_root = _detect_comfyui_root() or os.path.dirname(os.path.dirname(_script_dir))
    nuvu_dir = os.path.join(comfyui_root, 'user', 'default', '.nuvu', 'pending_installs')
    os.makedirs(nuvu_dir, exist_ok=True)
    return nuvu_dir


def _extract_package_names(spec_parts):
    """
    Extract just the package names from a spec_parts list.
    
    Filters out flags (--force-reinstall, --index-url, etc.) and their values,
    returning only package names/specs like 'torch==2.10.0', 'torchvision'.
    """
    packages = []
    skip_next = False
    
    for part in spec_parts:
        if skip_next:
            skip_next = False
            continue
        
        if part.startswith('--'):
            # Check if this flag takes a value
            if part in ['--index-url', '--extra-index-url', '--find-links', '-f']:
                skip_next = True
            continue
        elif part.startswith('-'):
            # Short flags like -U, -q
            continue
        else:
            # This is a package name/spec
            # Extract just the package name (before == or >= etc.)
            import re
            pkg_name = re.split(r'[<>=!]', part)[0]
            if pkg_name:
                packages.append(pkg_name)
    
    return packages


def _run_pending_installs(uv_path):
    """Install all packages that were marked for installation on restart.
    
    This handles packages that failed to install due to locked files.
    Marker files are stored in .nuvu/pending_installs/<name>.txt
    Each file contains the full package spec to install.
    
    For reliability, we:
    1. Uninstall the packages first (to avoid CUDA version mismatches, broken metadata)
    2. Then install fresh
    """
    pending_dir = _get_pending_installs_dir()
    
    if not os.path.isdir(pending_dir):
        return
    
    markers = [f for f in os.listdir(pending_dir) if f.endswith('.txt')]
    
    if not markers:
        return
    
    print(f"\n[ComfyUI-Nuvu] Processing {len(markers)} pending install(s)...", flush=True)
    
    is_embedded = "python_embeded" in sys.executable.lower()
    
    # Use uv if available, otherwise pip
    use_uv = uv_path is not None
    
    for filename in markers:
        marker_path = os.path.join(pending_dir, filename)
        
        try:
            with open(marker_path, 'r') as f:
                package_spec = f.read().strip()
            
            if not package_spec:
                os.remove(marker_path)
                continue
            
            print(f"[ComfyUI-Nuvu] Pending install: {package_spec}", flush=True)
            
            # Split the package spec to handle args like --pre --extra-index-url
            import shlex
            spec_parts = shlex.split(package_spec)
            
            # Extract package names for uninstall step
            package_names = _extract_package_names(spec_parts)
            
            # Step 1: Uninstall packages first to ensure clean state
            # This avoids CUDA version mismatches and broken metadata issues
            if package_names:
                print(f"[ComfyUI-Nuvu] Uninstalling first: {', '.join(package_names)}", flush=True)
                if use_uv:
                    uninstall_cmd = [uv_path, 'pip', 'uninstall']
                    if is_embedded:
                        uninstall_cmd.extend(['--python', sys.executable])
                    uninstall_cmd.extend(['-y'] + package_names)
                else:
                    uninstall_cmd = [sys.executable]
                    if is_embedded:
                        uninstall_cmd.append('-s')
                    uninstall_cmd.extend(['-m', 'pip', 'uninstall', '-y'] + package_names)
                
                uninstall_result = subprocess.run(uninstall_cmd, capture_output=True, text=True, timeout=120)
                if uninstall_result.returncode != 0:
                    # If uninstall fails, try force-deleting from site-packages
                    for pkg in package_names:
                        _force_delete_package(pkg)
            
            # Step 2: Install packages
            # Translate --force-reinstall to --reinstall for uv
            if use_uv:
                spec_parts = [p if p != '--force-reinstall' else '--reinstall' for p in spec_parts]
                cmd = [uv_path, 'pip', 'install']
                if is_embedded:
                    cmd.extend(['--python', sys.executable])
                cmd.extend(spec_parts)
            else:
                cmd = [sys.executable]
                if is_embedded:
                    cmd.append('-s')
                cmd.extend(['-m', 'pip', 'install'] + spec_parts)
            
            print(f"[ComfyUI-Nuvu] Installing: {' '.join(cmd)}", flush=True)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            
            if result.returncode == 0:
                print(f"[ComfyUI-Nuvu] Successfully installed {package_spec}", flush=True)
            else:
                print(f"[ComfyUI-Nuvu] Failed to install {package_spec}: {result.stderr[:500]}", flush=True)
            
            # Remove marker regardless of success (don't retry forever)
            os.remove(marker_path)
            
        except subprocess.TimeoutExpired:
            print(f"[ComfyUI-Nuvu] Pending install timed out: {package_spec}", flush=True)
            try:
                os.remove(marker_path)
            except Exception:
                pass
        except Exception as e:
            print(f"[ComfyUI-Nuvu] Pending install error: {e}", flush=True)


def _install_pending_requirements():
    """Install pending requirements for Nuvu, ComfyUI, and custom nodes.
    
    NOTE: Pending installs/uninstalls are primarily handled by pre_launch.py which runs
    BEFORE main.py (from the batch file). This avoids file lock issues since no
    packages are loaded yet. However, we also run them here as a fallback in case:
    - The batch file wasn't patched yet
    - User runs main.py directly without the batch file
    - pre_launch.py failed for some reason
    
    If pre_launch already processed the markers, these will be no-ops.
    """
    # FIRST: Clean up any packages with corrupted metadata (version = None)
    # This must happen before any installs to avoid version comparison errors
    _cleanup_corrupted_packages()
    
    # Use uv if available for faster installs
    uv_path = _find_uv()
    
    # Handle pending package uninstalls FIRST (before anything loads .pyd files)
    # These are also handled by pre_launch.py, but we run here as fallback
    _run_pending_uninstalls(uv_path)
    
    # Handle pending package installs (for packages that failed due to locked files)
    # May fail here due to file locks, but will create new markers for next restart
    _run_pending_installs(uv_path)
    
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


# =============================================================================
# Critical Package Verification
# =============================================================================
# Packages that must be installed and functional for ComfyUI to start.
# Format: (pip_name, package_spec, description)
#   - pip_name: Package name as shown by pip (e.g., "Pillow", "numpy")
#   - package_spec: Package to install if missing (e.g., "pillow" or "pillow>=10.0.0")
#   - description: Human-readable name for logging

# CRITICAL_PACKAGES: packages that must be installed for ComfyUI to start
# Format: (pip_name, package_spec, description, force_version)
# - pip_name: name to check with pip show
# - package_spec: what to install (can include version constraints)
# - description: for logging
# - force_version: if True, always reinstall to ensure version constraint (for <, >, != specs)
CRITICAL_PACKAGES = [
    ("Pillow", "pillow", "Pillow", False),
    # huggingface_hub>=1.0 breaks some ComfyUI workflows, pin to <1.0
    ("huggingface_hub", "huggingface_hub<1.0", "HuggingFace Hub", True),
    # Add more critical packages here as needed:
    # ("numpy", "numpy", "NumPy", False),
    # ("torch", "torch", "PyTorch", False),
]


def _check_package_installed(pip_name: str) -> bool:
    """
    Check if a package is installed using pip show (without importing it).
    
    This avoids loading/locking module files, which is important for packages
    that might be in a broken state and need reinstallation.
    """
    is_embedded = "python_embeded" in sys.executable.lower()
    
    if is_embedded:
        cmd = [sys.executable, '-s', '-m', 'pip', 'show', pip_name]
    else:
        cmd = [sys.executable, '-m', 'pip', 'show', pip_name]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        # pip show returns 0 if package is found, non-zero if not
        if result.returncode != 0:
            return False
        
        # Also check that the Location exists and isn't empty
        # This catches partially uninstalled packages
        for line in result.stdout.splitlines():
            if line.startswith('Location:'):
                location = line.split(':', 1)[1].strip()
                if not location or not os.path.isdir(location):
                    return False
                break
        
        return True
    except Exception:
        return False


def _install_package(package_spec: str, description: str) -> bool:
    """
    Force reinstall a package using pip.
    
    NOTE: We always use pip here instead of uv for reliability.
    uv can leave packages in broken states when interrupted.
    
    Args:
        package_spec: Package specification (e.g., "pillow" or "pillow>=10.0.0")
        description: Human-readable name for logging
    
    Returns:
        True if installation succeeded, False otherwise
    """
    print(f"[ComfyUI-Nuvu] {description} is missing or broken, reinstalling...", flush=True)
    
    is_embedded = "python_embeded" in sys.executable.lower()
    
    # Always use pip in prestartup for reliability
    if is_embedded:
        cmd = [sys.executable, '-s', '-m', 'pip', 'install', '--force-reinstall', package_spec]
    else:
        cmd = [sys.executable, '-m', 'pip', 'install', '--force-reinstall', package_spec]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        if result.returncode == 0:
            print(f"[ComfyUI-Nuvu] {description} reinstalled successfully", flush=True)
            return True
        else:
            print(f"[ComfyUI-Nuvu] {description} reinstall failed: {result.stderr[:200]}", flush=True)
            return False
    except Exception as e:
        print(f"[ComfyUI-Nuvu] {description} reinstall error: {e}", flush=True)
        return False


def _cleanup_corrupted_packages():
    """Find and delete packages with 'None' version (corrupted metadata).
    
    These packages have broken metadata that prevents proper version comparison.
    Force deleting them allows a clean reinstall.
    """
    is_embedded = "python_embeded" in sys.executable.lower()
    
    pip_base = [sys.executable]
    if is_embedded:
        pip_base.append('-s')
    pip_base.extend(['-m', 'pip'])
    
    try:
        # Run pip list to get all packages
        cmd = list(pip_base) + ['list', '--format=freeze']
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        if result.returncode != 0:
            return
        
        corrupted = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            # Format is "package==version" or just "package" if version is missing
            if '==' in line:
                pkg, version = line.split('==', 1)
                if version.lower() == 'none' or not version:
                    corrupted.append(pkg)
            elif '==' not in line and '@' not in line:
                # Package with no version at all
                corrupted.append(line)
        
        # Also check regular pip list format for "None" versions
        cmd2 = list(pip_base) + ['list']
        result2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=30)
        if result2.returncode == 0:
            for line in result2.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[1].lower() == 'none':
                    pkg = parts[0]
                    if pkg not in corrupted:
                        corrupted.append(pkg)
        
        if corrupted:
            print(f"[ComfyUI-Nuvu] Found {len(corrupted)} corrupted package(s): {', '.join(corrupted)}", flush=True)
            for pkg in corrupted:
                print(f"[ComfyUI-Nuvu] Force deleting corrupted: {pkg}", flush=True)
                _force_delete_package(pkg)
    
    except Exception as e:
        logger.debug(f"[ComfyUI-Nuvu] Error checking for corrupted packages: {e}")


def _get_installed_version(pip_name: str) -> str:
    """Get the installed version of a package using importlib.metadata.
    
    This uses importlib.metadata.version() which reflects what Python will actually
    import at runtime (including user site-packages if -s flag is not used).
    This is more accurate than pip show for detecting version conflicts.
    """
    try:
        import importlib.metadata
        return importlib.metadata.version(pip_name)
    except importlib.metadata.PackageNotFoundError:
        return ""
    except Exception:
        return ""


def _version_satisfies_constraint(installed_version: str, constraint: str) -> bool:
    """Check if installed version satisfies a version constraint like '<1.0' or '>=0.34.0'."""
    if not installed_version:
        return False
    
    try:
        # Parse the constraint
        import re
        match = re.match(r'^([<>=!]+)(.+)$', constraint)
        if not match:
            return True  # No constraint, any version is fine
        
        op, required = match.groups()
        
        # Parse versions into tuples for comparison
        def parse_version(v):
            # Handle versions like "1.2.3" or "0.34.0"
            parts = []
            for part in v.split('.'):
                # Extract numeric prefix
                num_match = re.match(r'^(\d+)', part)
                if num_match:
                    parts.append(int(num_match.group(1)))
                else:
                    parts.append(0)
            return tuple(parts)
        
        installed = parse_version(installed_version)
        required_v = parse_version(required)
        
        if op == '<':
            return installed < required_v
        elif op == '<=':
            return installed <= required_v
        elif op == '>':
            return installed > required_v
        elif op == '>=':
            return installed >= required_v
        elif op == '==':
            return installed == required_v
        elif op == '!=':
            return installed != required_v
        else:
            return True
    except Exception:
        return False  # If we can't parse, assume it doesn't satisfy


def _uninstall_package(pip_name: str) -> bool:
    """
    Uninstall a package from both embedded AND user site-packages.
    
    This is aggressive because:
    1. It uninstalls from embedded site-packages (with -s flag)
    2. It also uninstalls from user site-packages (without -s flag)
    3. Falls back to force deletion if pip fails
    
    This handles the case where ComfyUI-Manager restarts without the -s flag,
    causing Python to see packages from user site-packages.
    
    Returns True if uninstall succeeded, False otherwise.
    """
    is_embedded = "python_embeded" in sys.executable.lower()
    
    if is_embedded:
        # First uninstall from embedded site-packages
        cmd1 = [sys.executable, '-s', '-m', 'pip', 'uninstall', '-y', pip_name]
        try:
            subprocess.run(cmd1, capture_output=True, text=True, timeout=60)
        except Exception:
            pass
        
        # Also uninstall from user site-packages (this handles the case where
        # ComfyUI-Manager restarts without -s flag and Python sees user packages)
        cmd2 = [sys.executable, '-m', 'pip', 'uninstall', '-y', pip_name]
        try:
            result = subprocess.run(cmd2, capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                # pip failed, force delete from both locations
                _force_delete_package(pip_name)
        except Exception:
            _force_delete_package(pip_name)
    else:
        # Non-embedded Python - just uninstall normally
        cmd = [sys.executable, '-m', 'pip', 'uninstall', '-y', pip_name]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                _force_delete_package(pip_name)
        except Exception:
            _force_delete_package(pip_name)
    
    return True


def _has_conflicting_versions(pip_name: str) -> bool:
    """
    Check if a package has multiple dist-info directories (conflicting versions).
    
    This can happen when pip/uv fails to fully remove an old version during upgrade,
    leaving multiple .dist-info directories. pip show might report one version,
    but Python could import code from another version's actual module files.
    
    Returns True if multiple dist-info directories exist, False otherwise.
    """
    import site
    import re
    
    # Normalize package name (pip uses underscores internally)
    normalized_name = pip_name.replace('-', '_').lower()
    
    # Get site-packages directories
    site_packages_dirs = site.getsitepackages()
    if hasattr(site, 'getusersitepackages'):
        user_site = site.getusersitepackages()
        if user_site:
            site_packages_dirs.append(user_site)
    
    total_dist_infos = 0
    
    for sp_dir in site_packages_dirs:
        if not sp_dir or not os.path.isdir(sp_dir):
            continue
        
        try:
            for item in os.listdir(sp_dir):
                # Match package_name-version.dist-info
                if item.endswith('.dist-info'):
                    # Extract package name from dist-info (format: name-version.dist-info)
                    dist_name = item.rsplit('-', 1)[0] if '-' in item else item[:-10]
                    dist_name_normalized = dist_name.replace('-', '_').lower()
                    if dist_name_normalized == normalized_name:
                        total_dist_infos += 1
        except Exception:
            continue
    
    return total_dist_infos > 1


def _ensure_critical_packages():
    """
    Ensure all critical packages are installed and functional.
    
    Critical packages are required for ComfyUI to start. If any are missing or broken,
    they will be force reinstalled. This can happen when package upgrades fail mid-way
    (e.g., PyTorch upgrade that tries to reinstall dependencies but fails due to locked files).
    
    Uses pip show to check packages WITHOUT importing them, which avoids loading/locking
    broken module files that would prevent reinstallation.
    
    For packages with version constraints (force_version=True), check if the installed
    version satisfies the constraint before reinstalling. To handle cases where multiple
    conflicting versions exist (pip sees one version but Python imports another), we
    explicitly uninstall before reinstalling.
    """
    print(f"[ComfyUI-Nuvu] Checking {len(CRITICAL_PACKAGES)} critical packages...", flush=True)
    
    # Clean up any packages with corrupted metadata (version = None)
    # Also called earlier in _install_pending_requirements(), but run again here
    # in case new corrupted packages were created during pending installs
    _cleanup_corrupted_packages()
    
    for pip_name, package_spec, description, force_version in CRITICAL_PACKAGES:
        if force_version:
            # Check if installed version satisfies the constraint
            # Extract constraint from package_spec (e.g., "huggingface_hub<1.0" -> "<1.0")
            import re
            match = re.search(r'([<>=!]+.+)$', package_spec)
            if match:
                constraint = match.group(1)
                installed_version = _get_installed_version(pip_name)
                has_conflicts = _has_conflicting_versions(pip_name)
                print(f"[ComfyUI-Nuvu] Checking {pip_name}: installed={installed_version}, constraint={constraint}, conflicts={has_conflicts}", flush=True)
                
                if has_conflicts:
                    # Multiple dist-info directories exist - pip might report one version
                    # but Python could import another. Force clean reinstall.
                    print(f"[ComfyUI-Nuvu] {pip_name} has conflicting versions, will uninstall and reinstall", flush=True)
                    _uninstall_package(pip_name)
                    _install_package(package_spec, description)
                    continue
                
                if installed_version and _version_satisfies_constraint(installed_version, constraint):
                    # Already installed with correct version and no conflicts
                    print(f"[ComfyUI-Nuvu] {pip_name} version OK", flush=True)
                    continue
                    
                print(f"[ComfyUI-Nuvu] {pip_name} version mismatch, will uninstall and reinstall", flush=True)
                # Explicitly uninstall first to remove ALL conflicting versions
                # This handles cases where pip sees one version but Python imports another
                _uninstall_package(pip_name)
            # Version doesn't satisfy constraint or not installed
            _install_package(package_spec, description)
        elif not _check_package_installed(pip_name):
            _install_package(package_spec, description)


def _patch_batch_files():
    """
    Patch ComfyUI batch files to install requirements.txt before starting.
    
    This ensures that if packages are broken/missing (e.g., after a failed PyTorch upgrade),
    they get reinstalled BEFORE main.py tries to import them.
    
    This runs once on first prestartup and modifies the batch files in-place.
    """
    is_embedded = "python_embeded" in sys.executable.lower()
    
    # Find ComfyUI root directory
    # prestartup runs from custom_nodes/ComfyUI-Nuvu-Packager/
    packager_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(packager_dir)
    comfyui_dir = os.path.dirname(custom_nodes_dir)
    
    if is_embedded:
        # Portable install: batch file is in parent of ComfyUI folder
        # Structure: portable_root/ComfyUI/custom_nodes/...
        portable_root = os.path.dirname(comfyui_dir)
        
        # Look for common portable batch file names
        batch_candidates = [
            'run_nvidia_gpu.bat',
            'run_nvidia_gpu_fast_fp16_accumulation.bat',
            'run_cpu.bat', 
            'run.bat',
        ]
        
        for batch_name in batch_candidates:
            batch_path = os.path.join(portable_root, batch_name)
            if os.path.isfile(batch_path):
                _patch_portable_batch(batch_path)
    else:
        # Venv install: batch file is in ComfyUI folder
        batch_path = os.path.join(comfyui_dir, 'run_comfy.bat')
        venv_path = os.path.join(comfyui_dir, 'venv')
        
        if os.path.isfile(batch_path):
            _patch_venv_batch(batch_path)
        elif os.path.isdir(venv_path):
            # Create run_comfy.bat if it doesn't exist but venv does
            _create_venv_batch(batch_path)
            _patch_venv_batch(batch_path)


def _patch_portable_batch(batch_path):
    """Patch a portable batch file to run pre_launch.py before main.py."""
    # The correct path uses ComfyUI-Nuvu (distributed name)
    correct_path = 'ComfyUI-Nuvu\\pre_launch.py'
    # Old path used ComfyUI-Nuvu-Packager (dev repo name) - needs upgrade
    old_path = 'ComfyUI-Nuvu-Packager\\pre_launch.py'
    
    try:
        with open(batch_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Already patched with correct path?
        if correct_path in content:
            return
        
        # Check if patched with old path - upgrade it
        if old_path in content:
            new_content = content.replace(old_path, correct_path)
            with open(batch_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[ComfyUI-Nuvu] Upgraded {os.path.basename(batch_path)} pre_launch.py path", flush=True)
            return
        
        # Not patched at all - add pre_launch.py
        lines = content.splitlines()
        new_lines = []
        
        for line in lines:
            # Skip old patch lines (any previous force-reinstall or requirements install lines we added)
            if '--force-reinstall pillow' in line.lower():
                continue
            if 'pip install -r' in line.lower() and 'requirements.txt' in line.lower():
                continue
            
            # Find the line that runs main.py
            if 'python' in line.lower() and 'main.py' in line.lower():
                # Extract the python executable path from this line
                # e.g., ".\python_embeded\python.exe -s ComfyUI\main.py ..."
                parts = line.split()
                if parts:
                    python_exe = parts[0]
                    # Run pre_launch.py which handles everything
                    prelaunch_line = f'{python_exe} -s ComfyUI\\custom_nodes\\{correct_path}'
                    new_lines.append(prelaunch_line)
            
            new_lines.append(line)
        
        new_content = '\n'.join(new_lines)
        
        # Only write if changed
        if new_content != content:
            with open(batch_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[ComfyUI-Nuvu] Patched {os.path.basename(batch_path)} to run pre_launch.py on startup", flush=True)
    
    except Exception as e:
        # Don't fail prestartup if patching fails
        print(f"[ComfyUI-Nuvu] Could not patch {batch_path}: {e}", flush=True)


def _create_venv_batch(batch_path):
    """Create a run_comfy.bat for venv installs if it doesn't exist."""
    try:
        # Default port - can be overridden by user later
        port = 8188
        
        content = f"""@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0venv\\Scripts\\activate.bat"
python main.py --port {port} --preview-method auto
"""
        with open(batch_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"[ComfyUI-Nuvu] Created {os.path.basename(batch_path)}", flush=True)
    
    except Exception as e:
        print(f"[ComfyUI-Nuvu] Could not create {batch_path}: {e}", flush=True)


def _patch_venv_batch(batch_path):
    """Patch a venv batch file to run pre_launch.py before main.py."""
    # The correct path uses ComfyUI-Nuvu (distributed name)
    correct_path = 'ComfyUI-Nuvu\\pre_launch.py'
    # Old path used ComfyUI-Nuvu-Packager (dev repo name) - needs upgrade
    old_path = 'ComfyUI-Nuvu-Packager\\pre_launch.py'
    
    try:
        with open(batch_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Already patched with correct path?
        if correct_path in content:
            return
        
        # Check if patched with old path - upgrade it
        if old_path in content:
            new_content = content.replace(old_path, correct_path)
            with open(batch_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[ComfyUI-Nuvu] Upgraded {os.path.basename(batch_path)} pre_launch.py path", flush=True)
            return
        
        # Not patched at all - add pre_launch.py
        lines = content.splitlines()
        new_lines = []
        
        for line in lines:
            # Skip old patch lines (any previous force-reinstall or requirements install lines we added)
            if '--force-reinstall pillow' in line.lower():
                continue
            if 'pip install -r' in line.lower() and 'requirements.txt' in line.lower():
                continue
            
            # Find the line that runs main.py
            if 'python' in line.lower() and 'main.py' in line.lower():
                # Run pre_launch.py which handles everything: pending installs, critical packages, requirements
                prelaunch_line = f'python custom_nodes\\{correct_path}'
                new_lines.append(prelaunch_line)
            
            new_lines.append(line)
        
        new_content = '\n'.join(new_lines)
        
        # Only write if changed
        if new_content != content:
            with open(batch_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[ComfyUI-Nuvu] Patched {os.path.basename(batch_path)} to run pre_launch.py on startup", flush=True)
    
    except Exception as e:
        # Don't fail prestartup if patching fails
        print(f"[ComfyUI-Nuvu] Could not patch {batch_path}: {e}", flush=True)


def _parse_requirement(req_line: str):
    """Parse a requirement line into (package_name, version_spec) or None if invalid."""
    import re
    
    req_line = req_line.strip()
    
    # Skip comments and empty lines
    if not req_line or req_line.startswith('#'):
        return None
    
    # Skip lines with URLs or options
    if req_line.startswith('-') or '://' in req_line:
        return None
    
    # Handle environment markers (e.g., "package; platform_system == 'Windows'")
    if ';' in req_line:
        req_line = req_line.split(';')[0].strip()
    
    # Extract package name and version spec
    # Patterns: package>=1.0, package==1.0, package<2.0, package[extra]>=1.0
    match = re.match(r'^([a-zA-Z0-9_-]+)(\[[^\]]+\])?(.*)$', req_line)
    if match:
        pkg_name = match.group(1)
        version_spec = match.group(3).strip() if match.group(3) else ''
        return (pkg_name, version_spec)
    
    return None


def _version_satisfies_spec(installed_version: str, version_spec: str) -> bool:
    """Check if installed version satisfies the version specification."""
    if not version_spec or not installed_version:
        return installed_version is not None
    
    try:
        from packaging import version as pkg_version
        from packaging.specifiers import SpecifierSet
        
        installed = pkg_version.parse(installed_version)
        specifier = SpecifierSet(version_spec)
        return installed in specifier
    except Exception:
        # If packaging isn't available, try a basic check
        import re
        
        match = re.match(r'^([<>=!]+)(.+)$', version_spec)
        if not match:
            return True
        
        op, required = match.groups()
        
        try:
            inst_parts = [int(x) for x in re.split(r'[.+]', installed_version.split('+')[0])]
            req_parts = [int(x) for x in re.split(r'[.+]', required.split('+')[0])]
            
            max_len = max(len(inst_parts), len(req_parts))
            inst_parts += [0] * (max_len - len(inst_parts))
            req_parts += [0] * (max_len - len(req_parts))
            
            if op == '==':
                return inst_parts == req_parts
            elif op == '>=':
                return inst_parts >= req_parts
            elif op == '<=':
                return inst_parts <= req_parts
            elif op == '>':
                return inst_parts > req_parts
            elif op == '<':
                return inst_parts < req_parts
            elif op == '!=':
                return inst_parts != req_parts
        except Exception:
            pass
        
        return True


def _verify_comfyui_requirements():
    """Verify ComfyUI requirements.txt packages are installed with correct versions.
    
    This runs as a safety net in prestartup. If pre_launch.py already ran,
    all packages should be satisfied and this will be a quick check.
    If pre_launch.py was bypassed (e.g., ComfyUI-Manager os.execv restart),
    this will catch and install missing/wrong-version packages.
    """
    print("[ComfyUI-Nuvu] Verifying ComfyUI requirements...", flush=True)
    
    # Find ComfyUI requirements.txt
    packager_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(packager_dir)
    comfyui_dir = os.path.dirname(custom_nodes_dir)
    requirements_path = os.path.join(comfyui_dir, 'requirements.txt')
    
    if not os.path.isfile(requirements_path):
        print("[ComfyUI-Nuvu] No requirements.txt found", flush=True)
        return
    
    missing_packages = []
    wrong_version_packages = []
    
    try:
        with open(requirements_path, 'r') as f:
            for line in f:
                req = _parse_requirement(line)
                if not req:
                    continue
                
                pkg_name, version_spec = req
                installed = _get_installed_version(pkg_name)
                
                if installed is None or installed == '':
                    missing_packages.append(f"{pkg_name}{version_spec}")
                elif version_spec and not _version_satisfies_spec(installed, version_spec):
                    wrong_version_packages.append(f"{pkg_name}{version_spec}")
    except Exception as e:
        print(f"[ComfyUI-Nuvu] Error parsing requirements: {e}", flush=True)
        return
    
    packages_to_install = missing_packages + wrong_version_packages
    
    if not packages_to_install:
        print("[ComfyUI-Nuvu] All ComfyUI requirements satisfied", flush=True)
        return
    
    print(f"[ComfyUI-Nuvu] Installing {len(packages_to_install)} missing/outdated requirement(s)...", flush=True)
    for pkg in packages_to_install:
        print(f"[ComfyUI-Nuvu]   - {pkg}", flush=True)
    
    is_embedded = "python_embeded" in sys.executable.lower()
    uv_path = _find_uv()
    
    if uv_path:
        cmd = [uv_path, 'pip', 'install']
        if is_embedded:
            cmd.extend(['--python', sys.executable])
        cmd.extend(packages_to_install)
    else:
        cmd = [sys.executable]
        if is_embedded:
            cmd.append('-s')
        cmd.extend(['-m', 'pip', 'install'] + packages_to_install)
    
    # Add torch index URL if available
    torch_index = get_torch_index_url()
    if torch_index:
        cmd.extend(['--extra-index-url', torch_index])
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            print(f"[ComfyUI-Nuvu] Requirements install error: {result.stderr[:300]}", flush=True)
        else:
            print(f"[ComfyUI-Nuvu] Requirements installed successfully", flush=True)
    except Exception as e:
        print(f"[ComfyUI-Nuvu] Requirements install exception: {e}", flush=True)


# Run on module load (prestartup phase)
try:
    # Install uv if not present (used by pre_launch.py for faster installs)
    _install_uv()
    
    # Patch batch files to install requirements before main.py (runs once)
    _patch_batch_files()
    
    # Detect and save torch index URL if not already saved
    # This captures the CUDA version from the installed PyTorch
    _detect_and_save_torch_index()
    
    # Install any pending requirements
    _install_pending_requirements()
    
    # Ensure critical packages are installed and working
    _ensure_critical_packages()
    
    # Verify ComfyUI requirements.txt packages are installed with correct versions
    _verify_comfyui_requirements()
    
    # Clean up orphaned dist-info directories after install
    _cleanup_orphaned_dist_info()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}")
