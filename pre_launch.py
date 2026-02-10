"""
Pre-launch script for ComfyUI-Nuvu-Packager.

This script runs BEFORE main.py to handle pending package installs/uninstalls.
Running before main.py ensures no packages are locked by the Python process.

Called from the batch file launcher.
"""
import os
import sys
import subprocess
import shutil
import shlex
from pathlib import Path

# Global to track torch index URL from pending installs
_torch_index_url = None

# Global to cache uv availability
_uv_cmd = None
_uv_is_standalone = False
_uv_checked = False


def _is_embedded_python():
    """Check if running in embedded Python (portable install)."""
    return "python_embeded" in sys.executable.lower()


def _get_uv_paths():
    """Get platform-specific uv paths."""
    if sys.platform == "win32":
        import os as _os
        local_app_data = _os.environ.get("LOCALAPPDATA")
        if local_app_data:
            uv_dir = Path(local_app_data) / "nuvu" / "bin"
        else:
            uv_dir = Path.home() / "AppData" / "Local" / "nuvu" / "bin"
        uv_exe = uv_dir / "uv.exe"
        download_url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    else:
        uv_dir = Path.home() / ".local" / "bin"
        uv_exe = uv_dir / "uv"
        download_url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz"
    
    return uv_dir, uv_exe, download_url


def _install_uv():
    """Install uv to the platform-specific location if not already present."""
    uv_dir, uv_exe, download_url = _get_uv_paths()
    
    if uv_exe.exists():
        return str(uv_exe)
    
    try:
        uv_dir.mkdir(parents=True, exist_ok=True)
        
        import urllib.request
        import tempfile
        
        if sys.platform == "win32":
            import zipfile
            print("[Nuvu Pre-Launch] Downloading uv...", flush=True)
            with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
                urllib.request.urlretrieve(download_url, tmp.name)
                with zipfile.ZipFile(tmp.name, 'r') as zf:
                    for member in zf.namelist():
                        if member.endswith("uv.exe"):
                            with zf.open(member) as src, open(uv_exe, 'wb') as dst:
                                dst.write(src.read())
                            break
                Path(tmp.name).unlink(missing_ok=True)
        else:
            import tarfile
            print("[Nuvu Pre-Launch] Downloading uv...", flush=True)
            with tempfile.NamedTemporaryFile(suffix='.tar.gz', delete=False) as tmp:
                urllib.request.urlretrieve(download_url, tmp.name)
                with tarfile.open(tmp.name, 'r:gz') as tf:
                    for member in tf.getmembers():
                        if member.name.endswith("/uv") or member.name == "uv":
                            member.name = "uv"
                            tf.extract(member, uv_dir)
                            break
                import os
                os.chmod(uv_exe, 0o755)
                Path(tmp.name).unlink(missing_ok=True)
        
        if uv_exe.exists():
            print(f"[Nuvu Pre-Launch] uv installed to {uv_exe}", flush=True)
            return str(uv_exe)
    except Exception as e:
        print(f"[Nuvu Pre-Launch] Failed to install uv: {e}", flush=True)
    
    return None


def _get_uv_cmd():
    """
    Get the uv command if available, otherwise None.
    
    Returns (cmd, is_standalone) tuple where:
    - cmd: list like ['path/to/uv.exe', 'pip'] or None if uv not available
    - is_standalone: True if using standalone uv.exe (needs --python flag)
    """
    global _uv_cmd, _uv_is_standalone, _uv_checked
    
    if _uv_checked:
        return _uv_cmd, _uv_is_standalone
    
    _uv_checked = True
    
    # Try uv as a Python module first (preferred - uses invoking Python automatically)
    try:
        base = [sys.executable]
        if _is_embedded_python():
            base.append("-s")
        
        test_cmd = base + ["-m", "uv", "--version"]
        result = subprocess.run(test_cmd, capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            print(f"[Nuvu Pre-Launch] Using uv (module): {result.stdout.strip()}", flush=True)
            _uv_cmd = base + ["-m", "uv", "pip"]
            _uv_is_standalone = False
            return _uv_cmd, _uv_is_standalone
    except Exception:
        pass
    
    # Try standalone uv executable - check nuvu install location first
    _, nuvu_uv_exe, _ = _get_uv_paths()
    if nuvu_uv_exe.exists():
        try:
            result = subprocess.run([str(nuvu_uv_exe), "--version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                print(f"[Nuvu Pre-Launch] Using uv (standalone): {result.stdout.strip()}", flush=True)
                _uv_cmd = [str(nuvu_uv_exe), "pip"]
                _uv_is_standalone = True
                return _uv_cmd, _uv_is_standalone
        except Exception:
            pass
    
    # Try other common locations
    script_dir = Path(__file__).parent
    uv_locations = [
        script_dir / ".nuvu" / "bin" / ("uv.exe" if sys.platform == "win32" else "uv"),
        Path(sys.executable).parent / ("uv.exe" if sys.platform == "win32" else "uv"),
    ]
    
    for uv_path in uv_locations:
        if uv_path.exists():
            try:
                result = subprocess.run([str(uv_path), "--version"], capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    print(f"[Nuvu Pre-Launch] Using uv (standalone): {result.stdout.strip()}", flush=True)
                    _uv_cmd = [str(uv_path), "pip"]
                    _uv_is_standalone = True
                    return _uv_cmd, _uv_is_standalone
            except Exception:
                pass
    
    # Try system PATH
    uv_path = shutil.which("uv")
    if uv_path:
        try:
            result = subprocess.run([uv_path, "--version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                print(f"[Nuvu Pre-Launch] Using uv (PATH): {result.stdout.strip()}", flush=True)
                _uv_cmd = [uv_path, "pip"]
                _uv_is_standalone = True
                return _uv_cmd, _uv_is_standalone
        except Exception:
            pass
    
    # Try to install uv
    installed_path = _install_uv()
    if installed_path:
        _uv_cmd = [installed_path, "pip"]
        _uv_is_standalone = True
        return _uv_cmd, _uv_is_standalone
    
    return None, False


def _get_pip_base():
    """Get the base pip command (uses uv if available, otherwise pip)."""
    uv_cmd, is_standalone_uv = _get_uv_cmd()
    
    if uv_cmd:
        # For standalone uv on embedded Python, we need --python to target correct Python
        # For uv as module, it uses the Python that invoked it
        return uv_cmd, True, is_standalone_uv  # Returns (cmd, is_uv, is_standalone)
    
    # Fall back to pip
    pip_base = [sys.executable]
    if _is_embedded_python():
        pip_base.append('-s')
    pip_base.extend(['-m', 'pip'])
    return pip_base, False, False


def get_nuvu_dir():
    """Get the .nuvu directory path."""
    # This script is in custom_nodes/ComfyUI-Nuvu-Packager/
    script_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(script_dir)
    comfyui_dir = os.path.dirname(custom_nodes_dir)
    # Match prestartup_script.py path: ComfyUI/user/default/.nuvu/
    return os.path.join(comfyui_dir, 'user', 'default', '.nuvu')


def get_pending_installs_dir():
    return os.path.join(get_nuvu_dir(), 'pending_installs')


def get_pending_uninstalls_dir():
    return os.path.join(get_nuvu_dir(), 'pending_uninstalls')


def get_torch_index_file():
    return os.path.join(get_nuvu_dir(), 'torch_index_url.txt')


def load_torch_index_url():
    """Load saved torch index URL from file."""
    global _torch_index_url
    index_file = get_torch_index_file()
    if os.path.isfile(index_file):
        try:
            with open(index_file, 'r') as f:
                url = f.read().strip()
                if url:
                    _torch_index_url = url
        except Exception:
            pass


def save_torch_index_url(url):
    """Save torch index URL to file for future use."""
    global _torch_index_url
    _torch_index_url = url
    index_file = get_torch_index_file()
    try:
        os.makedirs(os.path.dirname(index_file), exist_ok=True)
        with open(index_file, 'w') as f:
            f.write(url)
    except Exception:
        pass


def extract_package_names(spec_parts):
    """Extract just the package names from a spec_parts list."""
    packages = []
    skip_next = False
    
    for part in spec_parts:
        if skip_next:
            skip_next = False
            continue
        
        if part.startswith('--'):
            if part in ['--index-url', '--extra-index-url', '--find-links', '-f']:
                skip_next = True
            continue
        elif part.startswith('-'):
            continue
        else:
            import re
            pkg_name = re.split(r'[<>=!]', part)[0]
            if pkg_name:
                packages.append(pkg_name)
    
    return packages


def extract_index_url(spec_parts):
    """Extract --index-url or --extra-index-url value from spec_parts."""
    for i, part in enumerate(spec_parts):
        if part in ['--index-url', '--extra-index-url'] and i + 1 < len(spec_parts):
            return spec_parts[i + 1]
    return None


def force_delete_package(pkg_name):
    """Force delete a package from site-packages."""
    import site
    import re
    
    site_packages_dirs = site.getsitepackages()
    if hasattr(site, 'getusersitepackages'):
        user_site = site.getusersitepackages()
        if user_site:
            site_packages_dirs.append(user_site)
    
    pkg_normalized = pkg_name.lower().replace('-', '_')
    deleted = False
    
    for sp_dir in site_packages_dirs:
        if not os.path.isdir(sp_dir):
            continue
        
        try:
            for item in os.listdir(sp_dir):
                item_lower = item.lower().replace('-', '_')
                is_exact_match = item_lower == pkg_normalized
                is_metadata = bool(re.match(rf'^{re.escape(pkg_normalized)}_\d', item_lower)) and \
                              ('dist_info' in item_lower or 'dist-info' in item_lower or 
                               'egg_info' in item_lower or 'egg-info' in item_lower)
                
                if is_exact_match or is_metadata:
                    item_path = os.path.join(sp_dir, item)
                    if os.path.isdir(item_path):
                        print(f"[Nuvu Pre-Launch] Force deleting: {item_path}", flush=True)
                        shutil.rmtree(item_path, ignore_errors=True)
                        deleted = True
        except Exception:
            pass
    
    return deleted


def run_pending_uninstalls():
    """Process pending uninstall markers."""
    pending_dir = get_pending_uninstalls_dir()
    
    if not os.path.isdir(pending_dir):
        return
    
    markers = [f for f in os.listdir(pending_dir) if f.endswith('.txt')]
    if not markers:
        return
    
    print(f"\n[Nuvu Pre-Launch] Processing {len(markers)} pending uninstall(s)...", flush=True)
    
    pip_base, is_uv, is_standalone = _get_pip_base()
    
    for filename in markers:
        marker_path = os.path.join(pending_dir, filename)
        
        try:
            with open(marker_path, 'r') as f:
                package_name = f.read().strip()
            
            if not package_name:
                os.remove(marker_path)
                continue
            
            print(f"[Nuvu Pre-Launch] Uninstalling: {package_name}", flush=True)
            
            if is_uv:
                cmd = list(pip_base) + ['uninstall']
                if is_standalone and _is_embedded_python():
                    cmd.extend(['--python', sys.executable])
                cmd.extend(['-y', package_name])
            else:
                cmd = list(pip_base) + ['uninstall', '-y', package_name]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            
            if result.returncode != 0:
                force_delete_package(package_name)
            
            os.remove(marker_path)
            
        except Exception as e:
            print(f"[Nuvu Pre-Launch] Uninstall error: {e}", flush=True)
            try:
                os.remove(marker_path)
            except Exception:
                pass


def run_pending_installs():
    """Process pending install markers."""
    global _torch_index_url
    
    pending_dir = get_pending_installs_dir()
    
    if not os.path.isdir(pending_dir):
        return
    
    markers = [f for f in os.listdir(pending_dir) if f.endswith('.txt')]
    if not markers:
        return
    
    print(f"\n[Nuvu Pre-Launch] Processing {len(markers)} pending install(s)...", flush=True)
    
    pip_base, is_uv, is_standalone = _get_pip_base()
    
    for filename in markers:
        marker_path = os.path.join(pending_dir, filename)
        
        try:
            with open(marker_path, 'r') as f:
                package_spec = f.read().strip()
            
            if not package_spec:
                os.remove(marker_path)
                continue
            
            print(f"[Nuvu Pre-Launch] Pending install: {package_spec}", flush=True)
            
            spec_parts = shlex.split(package_spec)
            package_names = extract_package_names(spec_parts)
            
            # If this is a torch-related install, save the index URL for later use
            torch_packages = ['torch', 'torchvision', 'torchaudio']
            if any(pkg in torch_packages for pkg in package_names):
                index_url = extract_index_url(spec_parts)
                if index_url:
                    save_torch_index_url(index_url)
                    print(f"[Nuvu Pre-Launch] Saved torch index URL: {index_url}", flush=True)
            
            # Uninstall first to ensure clean state
            if package_names:
                print(f"[Nuvu Pre-Launch] Uninstalling first: {', '.join(package_names)}", flush=True)
                if is_uv:
                    uninstall_cmd = list(pip_base) + ['uninstall']
                    if is_standalone and _is_embedded_python():
                        uninstall_cmd.extend(['--python', sys.executable])
                    uninstall_cmd.extend(['-y'] + package_names)
                else:
                    uninstall_cmd = list(pip_base) + ['uninstall', '-y'] + package_names
                uninstall_result = subprocess.run(uninstall_cmd, capture_output=True, text=True, timeout=120)
                if uninstall_result.returncode != 0:
                    for pkg in package_names:
                        force_delete_package(pkg)
            
            # Install packages
            # Filter out --force-reinstall for uv (use --reinstall instead)
            if is_uv:
                spec_parts = [p if p != '--force-reinstall' else '--reinstall' for p in spec_parts]
                cmd = list(pip_base) + ['install']
                if is_standalone and _is_embedded_python():
                    cmd.extend(['--python', sys.executable])
                cmd.extend(spec_parts)
            else:
                cmd = list(pip_base) + ['install'] + spec_parts
            
            print(f"[Nuvu Pre-Launch] Installing: {' '.join(cmd)}", flush=True)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            
            if result.returncode == 0:
                print(f"[Nuvu Pre-Launch] Successfully installed {package_spec}", flush=True)
            else:
                print(f"[Nuvu Pre-Launch] Failed: {result.stderr[:500]}", flush=True)
            
            os.remove(marker_path)
            
        except subprocess.TimeoutExpired:
            print(f"[Nuvu Pre-Launch] Install timed out", flush=True)
            try:
                os.remove(marker_path)
            except Exception:
                pass
        except Exception as e:
            print(f"[Nuvu Pre-Launch] Install error: {e}", flush=True)
            try:
                os.remove(marker_path)
            except Exception:
                pass


def cleanup_corrupted_packages():
    """Find and delete packages with 'None' version (corrupted metadata).
    
    These packages have broken metadata that prevents proper version comparison.
    Force deleting them allows a clean reinstall.
    """
    pip_base = [sys.executable]
    if _is_embedded_python():
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
            print(f"[Nuvu Pre-Launch] Found {len(corrupted)} corrupted package(s): {', '.join(corrupted)}", flush=True)
            for pkg in corrupted:
                print(f"[Nuvu Pre-Launch] Force deleting corrupted: {pkg}", flush=True)
                force_delete_package(pkg)
    
    except Exception as e:
        print(f"[Nuvu Pre-Launch] Error checking for corrupted packages: {e}", flush=True)


def install_critical_packages():
    """Force reinstall critical packages that may be broken."""
    # First, clean up any packages with corrupted metadata (version = None)
    cleanup_corrupted_packages()
    
    pip_base, is_uv, is_standalone = _get_pip_base()
    
    # Force reinstall packages that commonly get corrupted metadata after PyTorch upgrades
    # - pillow: Image processing, breaks ComfyUI startup if corrupted
    # - transformers: HuggingFace, version comparison fails if numpy metadata is broken
    # - numpy: Core dependency, metadata often corrupted during torch upgrades
    # - huggingface_hub: Must be <1.0, higher versions break some ComfyUI workflows
    print("[Nuvu Pre-Launch] Ensuring critical packages...", flush=True)
    
    critical_packages = ['pillow', 'numpy', 'transformers==4.57.6', 'huggingface_hub<1.0', 'diffusers>=0.33.0']
    
    if is_uv:
        cmd = list(pip_base) + ['install']
        if is_standalone and _is_embedded_python():
            cmd.extend(['--python', sys.executable])
        cmd.extend(['--reinstall'] + critical_packages + ['-q'])
    else:
        cmd = list(pip_base) + ['install', '--force-reinstall'] + critical_packages + ['-q']
    
    print(f"[Nuvu Pre-Launch] Running: {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        print(f"[Nuvu Pre-Launch] Critical packages install issue: {result.stderr[:200]}", flush=True)


def parse_requirement(req_line):
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


def get_installed_version(pip_name):
    """Get the installed version of a package using importlib.metadata."""
    try:
        import importlib.metadata
        return importlib.metadata.version(pip_name)
    except Exception:
        return None


def version_satisfies(installed_version, version_spec):
    """Check if installed version satisfies the version specification."""
    if not version_spec or not installed_version:
        return installed_version is not None  # If no spec, just check if installed
    
    try:
        from packaging import version as pkg_version
        from packaging.specifiers import SpecifierSet
        
        installed = pkg_version.parse(installed_version)
        specifier = SpecifierSet(version_spec)
        return installed in specifier
    except Exception:
        # If packaging isn't available, try a basic check
        import re
        
        # Handle simple cases: ==, >=, <=, >, <
        match = re.match(r'^([<>=!]+)(.+)$', version_spec)
        if not match:
            return True  # Can't parse, assume OK
        
        op, required = match.groups()
        
        try:
            # Simple version comparison (works for most cases)
            inst_parts = [int(x) for x in re.split(r'[.+]', installed_version.split('+')[0])]
            req_parts = [int(x) for x in re.split(r'[.+]', required.split('+')[0])]
            
            # Pad to same length
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
        
        return True  # Can't compare, assume OK


def verify_and_install_requirements():
    """Verify ComfyUI requirements.txt packages are installed with correct versions.
    
    This is more thorough than just running pip install -r requirements.txt because:
    1. It checks actual installed versions against requirements
    2. It reports which packages are missing or have wrong versions
    3. It only installs/upgrades what's actually needed
    """
    global _torch_index_url
    
    pip_base, is_uv, is_standalone = _get_pip_base()
    
    # Find ComfyUI requirements.txt
    script_dir = os.path.dirname(os.path.abspath(__file__))
    custom_nodes_dir = os.path.dirname(script_dir)
    comfyui_dir = os.path.dirname(custom_nodes_dir)
    requirements_path = os.path.join(comfyui_dir, 'requirements.txt')
    
    if not os.path.isfile(requirements_path):
        print("[Nuvu Pre-Launch] No requirements.txt found", flush=True)
        return
    
    print("[Nuvu Pre-Launch] Verifying ComfyUI requirements...", flush=True)
    
    # Parse requirements file
    missing_packages = []
    wrong_version_packages = []
    
    try:
        with open(requirements_path, 'r') as f:
            for line in f:
                req = parse_requirement(line)
                if not req:
                    continue
                
                pkg_name, version_spec = req
                installed = get_installed_version(pkg_name)
                
                if installed is None:
                    missing_packages.append(f"{pkg_name}{version_spec}")
                    print(f"[Nuvu Pre-Launch] Missing: {pkg_name}", flush=True)
                elif version_spec and not version_satisfies(installed, version_spec):
                    wrong_version_packages.append(f"{pkg_name}{version_spec}")
                    print(f"[Nuvu Pre-Launch] Version mismatch: {pkg_name} (installed={installed}, required={version_spec})", flush=True)
    except Exception as e:
        print(f"[Nuvu Pre-Launch] Error parsing requirements: {e}", flush=True)
        # Fall back to just running pip install
        missing_packages = []
        wrong_version_packages = []
    
    # Install missing packages
    packages_to_install = missing_packages + wrong_version_packages
    
    if packages_to_install:
        print(f"[Nuvu Pre-Launch] Installing {len(packages_to_install)} package(s)...", flush=True)
        
        if is_uv:
            cmd = list(pip_base) + ['install']
            if is_standalone and _is_embedded_python():
                cmd.extend(['--python', sys.executable])
            cmd.extend(packages_to_install)
        else:
            cmd = list(pip_base) + ['install'] + packages_to_install
        
        # Add torch index URL if available
        if _torch_index_url:
            cmd.extend(['--extra-index-url', _torch_index_url])
            print(f"[Nuvu Pre-Launch] Using torch index: {_torch_index_url}", flush=True)
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            print(f"[Nuvu Pre-Launch] Install error: {result.stderr[:500]}", flush=True)
        else:
            print(f"[Nuvu Pre-Launch] Requirements verified and installed", flush=True)
    else:
        print("[Nuvu Pre-Launch] All requirements satisfied", flush=True)


def install_comfyui_requirements():
    """Install ComfyUI requirements.txt with version verification."""
    verify_and_install_requirements()


def main():
    """Main entry point."""
    try:
        # Load any previously saved torch index URL
        load_torch_index_url()
        
        # Process pending uninstalls first
        run_pending_uninstalls()
        
        # Process pending installs (e.g., PyTorch upgrades)
        # This may also update the saved torch index URL
        run_pending_installs()
        
        # Force reinstall critical packages (pillow, transformers)
        install_critical_packages()
        
        # Install ComfyUI requirements (uses torch index URL if available)
        install_comfyui_requirements()
        
    except Exception as e:
        print(f"[Nuvu Pre-Launch] Error: {e}", flush=True)


if __name__ == '__main__':
    main()
