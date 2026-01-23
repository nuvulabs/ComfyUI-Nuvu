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


def _get_pending_uninstalls_dir():
    """Get the directory for pending uninstall markers."""
    nuvu_dir = os.path.join(_script_dir, '.nuvu', 'pending_uninstalls')
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
    
    # Get site-packages directories
    site_packages_dirs = site.getsitepackages()
    if hasattr(site, 'getusersitepackages'):
        user_site = site.getusersitepackages()
        if user_site:
            site_packages_dirs.append(user_site)
    
    # Normalize package name for directory matching
    pkg_normalized = pkg_name.lower().replace('-', '_').replace('.', '_')
    
    deleted = False
    for sp_dir in site_packages_dirs:
        if not os.path.isdir(sp_dir):
            continue
        
        try:
            for item in os.listdir(sp_dir):
                item_lower = item.lower().replace('-', '_').replace('.', '_')
                # Match package directory or dist-info/egg-info
                if (item_lower.startswith(pkg_normalized) or 
                    item_lower.startswith(f"{pkg_normalized}-")):
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
    logger.info(f"[ComfyUI-Nuvu] Found {len(markers)} pending uninstall marker(s)")
    
    for marker_path in markers:
        marker_name = os.path.basename(marker_path).replace('.txt', '')
        
        try:
            with open(marker_path, 'r') as f:
                packages = [pkg.strip() for pkg in f.read().strip().split('\n') if pkg.strip()]
            
            if not packages:
                os.remove(marker_path)
                continue
            
            print(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall: {', '.join(packages)}", flush=True)
            logger.info(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall: {', '.join(packages)}")
            
            # Always use pip for uninstalls - it's more lenient about missing RECORD files
            is_embedded = "python_embeded" in sys.executable.lower()
            base = [sys.executable]
            if is_embedded:
                base.append('-s')
            cmd = base + ['-m', 'pip', 'uninstall', '-y']
            
            cmd.extend(packages)
            
            print(f"[ComfyUI-Nuvu] Running: {' '.join(cmd)}", flush=True)
            logger.info(f"[ComfyUI-Nuvu] Running: {' '.join(cmd)}")
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
            )
            
            if result.returncode == 0:
                for pkg in packages:
                    print(f"[ComfyUI-Nuvu] Uninstalled: {pkg}", flush=True)
                    logger.info(f"[ComfyUI-Nuvu] Uninstalled: {pkg}")
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
                                    logger.info(f"[ComfyUI-Nuvu] Force deleted: {pkg}")
                                    continue
                        all_gone = False
                        still_installed.append(pkg)
                    else:
                        print(f"[ComfyUI-Nuvu] Uninstalled: {pkg}", flush=True)
                        logger.info(f"[ComfyUI-Nuvu] Uninstalled: {pkg}")
                
                if all_gone:
                    print(f"[ComfyUI-Nuvu] {marker_name} packages verified removed", flush=True)
                    logger.info(f"[ComfyUI-Nuvu] {marker_name} packages verified removed")
                    os.remove(marker_path)
                else:
                    print(f"[ComfyUI-Nuvu] {marker_name} uninstall incomplete, still installed: {', '.join(still_installed)}", flush=True)
                    logger.warning(f"[ComfyUI-Nuvu] {marker_name} uninstall issue: {result.stderr[:200]}")
        
        except Exception as e:
            print(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall error: {e}", flush=True)
            logger.warning(f"[ComfyUI-Nuvu] Pending {marker_name} uninstall error: {e}")


def _get_pending_installs_dir():
    """Get the directory for pending install markers."""
    nuvu_dir = os.path.join(_script_dir, '.nuvu', 'pending_installs')
    os.makedirs(nuvu_dir, exist_ok=True)
    return nuvu_dir


def _run_pending_installs(uv_path):
    """Install all packages that were marked for installation on restart.
    
    This handles packages that failed to install due to locked files.
    Marker files are stored in .nuvu/pending_installs/<name>.txt
    Each file contains the full package spec to install.
    """
    pending_dir = _get_pending_installs_dir()
    
    if not os.path.isdir(pending_dir):
        return
    
    markers = [f for f in os.listdir(pending_dir) if f.endswith('.txt')]
    
    if not markers:
        return
    
    print(f"\n[ComfyUI-Nuvu] Processing {len(markers)} pending install(s)...", flush=True)
    logger.info(f"[ComfyUI-Nuvu] Found {len(markers)} pending install marker(s)")
    
    for filename in markers:
        marker_path = os.path.join(pending_dir, filename)
        
        try:
            with open(marker_path, 'r') as f:
                package_spec = f.read().strip()
            
            if not package_spec:
                os.remove(marker_path)
                continue
            
            print(f"[ComfyUI-Nuvu] Pending install: {package_spec}", flush=True)
            logger.info(f"[ComfyUI-Nuvu] Pending install: {package_spec}")
            
            # Split the package spec to handle args like --pre --index-url
            # e.g., "onnxruntime-gpu --pre --index-url https://..."
            import shlex
            spec_parts = shlex.split(package_spec)
            
            # Use uv if available, otherwise pip
            # Note: For special index URLs, we use pip since uv may not support all options
            if '--index-url' in package_spec or '--pre' in package_spec:
                # Use pip for special cases
                cmd = [sys.executable, '-m', 'pip', 'install', '-U'] + spec_parts
            elif uv_path:
                cmd = [uv_path, 'pip', 'install', '-U'] + spec_parts
            else:
                cmd = [sys.executable, '-m', 'pip', 'install', '-U'] + spec_parts
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode == 0:
                print(f"[ComfyUI-Nuvu] Successfully installed {package_spec}", flush=True)
                logger.info(f"[ComfyUI-Nuvu] Successfully installed {package_spec}")
            else:
                print(f"[ComfyUI-Nuvu] Failed to install {package_spec}: {result.stderr[:200]}", flush=True)
                logger.warning(f"[ComfyUI-Nuvu] Failed to install {package_spec}: {result.stderr[:200]}")
            
            # Remove marker regardless of success (don't retry forever)
            os.remove(marker_path)
            
        except subprocess.TimeoutExpired:
            print(f"[ComfyUI-Nuvu] Pending install timed out: {package_spec}", flush=True)
            logger.warning(f"[ComfyUI-Nuvu] Pending install timed out: {package_spec}")
            try:
                os.remove(marker_path)
            except Exception:
                pass
        except Exception as e:
            print(f"[ComfyUI-Nuvu] Pending install error: {e}", flush=True)
            logger.warning(f"[ComfyUI-Nuvu] Pending install error: {e}")


def _install_pending_requirements():
    """Install pending requirements for Nuvu, ComfyUI, and custom nodes."""
    # Find or install uv
    uv_path = _find_uv()
    if not uv_path:
        uv_path = _install_uv()
    
    if uv_path:
        logger.info("[ComfyUI-Nuvu] Using uv for faster installs")
    
    # Handle pending package uninstalls FIRST (before anything loads .pyd files)
    _run_pending_uninstalls(uv_path)
    
    # Handle pending package installs (for packages that failed due to locked files)
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


# Run on module load (prestartup phase)
try:
    # Install any pending requirements
    _install_pending_requirements()
    
    # Clean up orphaned dist-info directories after install
    _cleanup_orphaned_dist_info()
except Exception as e:
    logger.warning(f"[ComfyUI-Nuvu] Prestartup error (non-fatal): {e}")
