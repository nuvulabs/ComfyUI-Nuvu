#!/usr/bin/env bash
set -euo pipefail
set -E

# Set log file
INSTALL_LOG="$(pwd)/install.log"
> "$INSTALL_LOG"

# Verbose mode - set to 1 to show all output, 0 to redirect to log file
VERBOSE=0

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --verbose|-v)
      VERBOSE=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# Helper to redirect output based on verbose mode
run_cmd() {
  if [ "$VERBOSE" -eq 1 ]; then
    "$@"
  else
    "$@" >> "$INSTALL_LOG" 2>&1
  fi
}

log() {
  printf '\n=== %s ===\n' "$1"
}

if [ "$VERBOSE" -eq 1 ]; then
  echo "========================================================"
  echo "  ComfyUI + Nuvu Installer"
  echo "========================================================"
  echo "  [VERBOSE MODE ENABLED]"
  echo ""
fi

on_error() {
  local rc=$?
  local line_no=${BASH_LINENO[0]:-}
  local cmd=${BASH_COMMAND:-}
  echo "" >&2
  echo "ERROR: Installer failed (exit $rc) at line $line_no" >&2
  if [ -n "$cmd" ]; then
    echo "Command: $cmd" >&2
  fi
  echo "See log: $INSTALL_LOG" >&2
  if [ -f "$INSTALL_LOG" ]; then
    echo "" >&2
    echo "Last 60 lines of install.log:" >&2
    tail -n 60 "$INSTALL_LOG" >&2 || true
  fi
  exit $rc
}

trap on_error ERR

ensure_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" | tee -a "$INSTALL_LOG"
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="$SCRIPT_DIR/ComfyUI"
TORCH_CONSTRAINTS="$COMFY_DIR/nuvu_torch_constraints.txt"
PIP_CONSTRAINTS_FILE="$COMFY_DIR/nuvu_pip_constraints.txt"
RUN_SCRIPT_NAME="run_comfy.sh"
PYTHON_BIN="${PYTHON_BIN:-python3}"
nuvu_COMPILED_REPO="https://github.com/nuvulabs/ComfyUI-Nuvu.git"

# UV install location (same as prestartup_script.py)
UV_DIR="$HOME/.local/bin"
UV_EXE="$UV_DIR/uv"
USE_UV=0

# Package installation helper - uses uv if available, falls back to pip
pkg_install() {
  local -a torch_c=()
  if [ -n "${TORCH_CONSTRAINTS:-}" ] && [ -s "$TORCH_CONSTRAINTS" ]; then
    torch_c=(-c "$TORCH_CONSTRAINTS")
  fi
  if [ "$VERBOSE" -eq 1 ]; then
    if [ "$USE_UV" -eq 1 ]; then
      "$UV_EXE" pip install "${torch_c[@]}" "$@"
    else
      python -m pip install "${torch_c[@]}" "$@"
    fi
  else
    if [ "$USE_UV" -eq 1 ]; then
      "$UV_EXE" pip install --quiet "${torch_c[@]}" "$@" >> "$INSTALL_LOG" 2>&1
    else
      python -m pip install -q "${torch_c[@]}" "$@" >> "$INSTALL_LOG" 2>&1
    fi
  fi
}

pkg_install_req() {
  local req_file="$1"
  local -a torch_c=()
  if [ -n "${TORCH_CONSTRAINTS:-}" ] && [ -s "$TORCH_CONSTRAINTS" ]; then
    torch_c=(-c "$TORCH_CONSTRAINTS")
  fi
  shift
  if [ "$VERBOSE" -eq 1 ]; then
    if [ "$USE_UV" -eq 1 ]; then
      "$UV_EXE" pip install "${torch_c[@]}" -r "$req_file" "$@"
    else
      python -m pip install "${torch_c[@]}" -r "$req_file" "$@"
    fi
  else
    if [ "$USE_UV" -eq 1 ]; then
      "$UV_EXE" pip install --quiet "${torch_c[@]}" -r "$req_file" "$@" >> "$INSTALL_LOG" 2>&1
    else
      python -m pip install -q "${torch_c[@]}" -r "$req_file" "$@" >> "$INSTALL_LOG" 2>&1
    fi
  fi
}

# Ensure git exists; try to install if missing (Debian/Ubuntu)
if ! command -v git >/dev/null 2>&1; then
  log "Git not detected"
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing git via apt-get"
    if [ "$VERBOSE" -eq 1 ]; then
      sudo apt-get update
      sudo apt-get install -y git
    else
      sudo apt-get update >> "$INSTALL_LOG" 2>&1
      sudo apt-get install -y git >> "$INSTALL_LOG" 2>&1
    fi
  else
    echo "Git is required but was not found. Install git and re-run." | tee -a "$INSTALL_LOG"
    exit 1
  fi
fi

ensure_cmd git

# Ensure python exists; try to install if missing (Debian/Ubuntu)
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  log "Python not detected"
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing python3 and venv via apt-get"
    if [ "$VERBOSE" -eq 1 ]; then
      sudo apt-get update
      sudo apt-get install -y python3 python3-venv
    else
      sudo apt-get update >> "$INSTALL_LOG" 2>&1
      sudo apt-get install -y python3 python3-venv >> "$INSTALL_LOG" 2>&1
    fi
    PYTHON_BIN="python3"
  else
    echo "Python is required but was not found. Install python3.10+ and re-run." | tee -a "$INSTALL_LOG"
    exit 1
  fi
fi

ensure_cmd "$PYTHON_BIN"

export PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring

"$PYTHON_BIN" - <<'PY'
import sys
required = (3, 10)
if sys.version_info < required:
    ver = ".".join(map(str, sys.version_info[:3]))
    raise SystemExit(
        f"Python {required[0]}.{required[1]}+ is required, but {ver} is available."
    )
PY

log "Installing uv (fast package installer)"
if [ -x "$UV_EXE" ]; then
  echo "uv already installed at $UV_EXE"
  USE_UV=1
else
  echo "Downloading uv..."
  mkdir -p "$UV_DIR"
  UV_TAR="/tmp/uv-download.tar.gz"
  if [ "$VERBOSE" -eq 1 ]; then
    if curl -LsSf "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$UV_TAR"; then
      echo "Extracting uv..."
      if tar -xzf "$UV_TAR" -C "$UV_DIR" --strip-components=1; then
        chmod +x "$UV_EXE"
        rm -f "$UV_TAR"
        if [ -x "$UV_EXE" ]; then
          echo "uv installed successfully to $UV_EXE"
          USE_UV=1
        else
          echo "uv installation failed, will use pip instead."
        fi
      else
        echo "Failed to extract uv, will use pip instead."
        rm -f "$UV_TAR"
      fi
    else
      echo "Failed to download uv, will use pip instead."
    fi
  else
    if curl -LsSf "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$UV_TAR" >> "$INSTALL_LOG" 2>&1; then
      echo "Extracting uv..."
      if tar -xzf "$UV_TAR" -C "$UV_DIR" --strip-components=1 >> "$INSTALL_LOG" 2>&1; then
        chmod +x "$UV_EXE"
        rm -f "$UV_TAR"
        if [ -x "$UV_EXE" ]; then
          echo "uv installed successfully to $UV_EXE"
          USE_UV=1
        else
          echo "uv installation failed, will use pip instead."
        fi
      else
        echo "Failed to extract uv, will use pip instead."
        rm -f "$UV_TAR"
      fi
    else
      echo "Failed to download uv, will use pip instead."
    fi
  fi
fi

# Add uv to PATH for this session
if [ "$USE_UV" -eq 1 ]; then
  export PATH="$UV_DIR:$PATH"
  echo "Using uv for fast package installation"
else
  echo "Using pip for package installation"
fi

clone_and_install() {
  local dir="$1"
  local repo="$2"

  echo "Installing $dir custom node..."
  if [ ! -d "$dir" ]; then
    if [ "$VERBOSE" -eq 1 ]; then
      git clone "$repo"
    else
      git clone -q "$repo" >> "$INSTALL_LOG" 2>&1
    fi
  else
    if [ "$VERBOSE" -eq 1 ]; then
      echo "$dir already present; skipping clone."
    else
      echo "$dir already present; skipping clone." >> "$INSTALL_LOG" 2>&1
    fi
  fi

  if [ -f "$dir/requirements.txt" ]; then
    (cd "$dir" && pkg_install_req requirements.txt)
  elif [ -f "$dir/req.txt" ]; then
    (cd "$dir" && pkg_install_req req.txt)
  fi
}

log "Installing system packages"
if command -v apt-get >/dev/null 2>&1; then
  if [ "$VERBOSE" -eq 1 ]; then
    sudo apt-get update
    sudo apt-get install -y git ninja-build
  else
    sudo apt-get update >> "$INSTALL_LOG" 2>&1
    sudo apt-get install -y git ninja-build >> "$INSTALL_LOG" 2>&1
  fi
else
  echo "apt-get not found; install git and ninja manually."
fi

log "Preparing ComfyUI directory"
if [ ! -d "$COMFY_DIR" ]; then
  echo "Cloning ComfyUI..."
  if [ "$VERBOSE" -eq 1 ]; then
    git clone https://github.com/Comfy-Org/ComfyUI.git "$COMFY_DIR"
  else
    git clone -q https://github.com/Comfy-Org/ComfyUI.git "$COMFY_DIR" >> "$INSTALL_LOG" 2>&1
  fi
else
  echo "ComfyUI already exists at $COMFY_DIR; skipping clone."
fi

cd "$COMFY_DIR"

log "Creating virtual environment"
if [ ! -d "venv" ]; then
  if [ "$VERBOSE" -eq 1 ]; then
    "$PYTHON_BIN" -m venv venv
  else
    "$PYTHON_BIN" -m venv venv >> "$INSTALL_LOG" 2>&1
  fi
else
  echo "venv already exists; skipping creation."
fi

# shellcheck disable=SC1091
source "venv/bin/activate"

log "Upgrading pip"
if [ "$VERBOSE" -eq 1 ]; then
  python -m pip install --upgrade pip
else
  python -m pip install -q --upgrade pip >> "$INSTALL_LOG" 2>&1
fi

log "Installing keyring helpers"
pkg_install keyrings.alt

log "Installing PyTorch 2.11.0 stack"
# Pin torch, torchvision, and torchaudio together (unpinned torchaudio can resolve to a newer ABI).
pkg_install torch==2.11.0+cu130 torchvision==0.26.0+cu130 torchaudio==2.11.0+cu130 --index-url https://download.pytorch.org/whl/cu130

log "Saving PyTorch pins for dependency installs"
python -m pip freeze | grep -E '^(torch|torchvision|torchaudio)==' > "$TORCH_CONSTRAINTS" || true

log "Installing core ComfyUI dependencies"
pkg_install_req requirements.txt --extra-index-url https://download.pytorch.org/whl/cu130

log "Installing additional custom nodes"
mkdir -p "$COMFY_DIR/custom_nodes"
cd "$COMFY_DIR/custom_nodes"

clone_and_install "ComfyUI-Manager" "https://github.com/Comfy-Org/ComfyUI-Manager.git"
clone_and_install "ComfyUI-Nuvu" "$nuvu_COMPILED_REPO"
clone_and_install "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
clone_and_install "ComfyUI-Impact-Pack" "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"
clone_and_install "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
clone_and_install "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
clone_and_install "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
clone_and_install "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"

cd "$COMFY_DIR"

log "Installing critical ML packages (force reinstall)"
# Mirrors pre_launch.py::install_critical_packages so prelaunch does not need to
# reinstall these on first ComfyUI startup. Uses --force-reinstall (pip) /
# --reinstall (uv) to write fresh dist-info metadata even if pip thinks the
# packages are already satisfied. No torch constraints applied here because
# none of these conflict with the pinned torch stack.
if [ "$USE_UV" -eq 1 ]; then
  if [ "$VERBOSE" -eq 1 ]; then
    "$UV_EXE" pip install --reinstall pillow numpy "transformers==4.57.6" "huggingface_hub<1.0" "diffusers>=0.33.0"
  else
    "$UV_EXE" pip install --reinstall --quiet pillow numpy "transformers==4.57.6" "huggingface_hub<1.0" "diffusers>=0.33.0" >> "$INSTALL_LOG" 2>&1
  fi
else
  if [ "$VERBOSE" -eq 1 ]; then
    python -m pip install --force-reinstall pillow numpy "transformers==4.57.6" "huggingface_hub<1.0" "diffusers>=0.33.0"
  else
    python -m pip install --force-reinstall -q pillow numpy "transformers==4.57.6" "huggingface_hub<1.0" "diffusers>=0.33.0" >> "$INSTALL_LOG" 2>&1
  fi
fi

# Persist a pip/uv constraints file OUTSIDE any pip-managed metadata so it survives and can be
# referenced at launch time. transformers pins huggingface_hub<1.0, but ComfyUI-Manager's
# prestartup dependency restore re-installs unpinned node requirements on first launch and drags
# huggingface_hub up to 1.x AFTER install -> transformers fails to import. Exporting this as a
# constraint in the launcher means every pip/uv call at runtime (including Manager's) is blocked
# from resolving huggingface_hub>=1.0.
log "Writing pip constraints: $PIP_CONSTRAINTS_FILE"
printf 'huggingface_hub<1.0\n' > "$PIP_CONSTRAINTS_FILE"

log "Creating helper launcher: $RUN_SCRIPT_NAME"
cat > "$RUN_SCRIPT_NAME" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Prevent ComfyUI-Manager's prestartup (and any runtime pip/uv install) from pulling
# huggingface_hub>=1.0, which breaks transformers. See nuvu_pip_constraints.txt.
if [ -f "$SCRIPT_DIR/nuvu_pip_constraints.txt" ]; then
  export PIP_CONSTRAINT="$SCRIPT_DIR/nuvu_pip_constraints.txt"
  export UV_CONSTRAINT="$SCRIPT_DIR/nuvu_pip_constraints.txt"
fi
source "$SCRIPT_DIR/venv/bin/activate"
# --use-ck-attention is preferred; if ComfyUI exits non-zero with it, relaunch once without it.
if python "$SCRIPT_DIR/main.py" --use-ck-attention --preview-method auto --auto-launch; then
  :
else
  echo "ComfyUI exited with --use-ck-attention; retrying without it..."
  python "$SCRIPT_DIR/main.py" --preview-method auto --auto-launch
fi
EOF

chmod +x "$RUN_SCRIPT_NAME"

log "Creating shortcuts"
ICON_PATH="$COMFY_DIR/custom_nodes/ComfyUI-Nuvu/web/images/NuvuLogo.png"
DESKTOP_ENTRY_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=Nuvu-ComfyUI
Comment=Launch Nuvu-ComfyUI
Exec=$COMFY_DIR/$RUN_SCRIPT_NAME
Icon=$ICON_PATH
Terminal=true
Categories=Graphics;"

# Create application menu entry
APP_DIR="$HOME/.local/share/applications"
mkdir -p "$APP_DIR"
echo "$DESKTOP_ENTRY_CONTENT" > "$APP_DIR/nuvu-comfyui.desktop"
chmod +x "$APP_DIR/nuvu-comfyui.desktop"

# Create desktop shortcut
DESKTOP_DIR="$HOME/Desktop"
if [ -d "$DESKTOP_DIR" ]; then
  echo "$DESKTOP_ENTRY_CONTENT" > "$DESKTOP_DIR/Nuvu-ComfyUI.desktop"
  chmod +x "$DESKTOP_DIR/Nuvu-ComfyUI.desktop"
  # Mark as trusted on GNOME-based systems
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/Nuvu-ComfyUI.desktop" metadata::trusted true >> "$INSTALL_LOG" 2>&1 || true
  fi
  echo "Created desktop shortcut: $DESKTOP_DIR/Nuvu-ComfyUI.desktop"
fi

# Update desktop database if available
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >> "$INSTALL_LOG" 2>&1 || true
fi

log "All done!"
echo "Use $COMFY_DIR/$RUN_SCRIPT_NAME to launch ComfyUI with ComfyUI-Nuvu."
echo "You can also find 'Nuvu-ComfyUI' in your application menu and on your Desktop."
echo "If you run into issues, check: $INSTALL_LOG"
exit 0

