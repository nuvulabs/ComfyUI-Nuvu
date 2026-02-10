#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '\n[%s] %s\n' "$(date +'%H:%M:%S')" "$1"
}

ensure_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

# Package installer helper - uses uv if available, falls back to pip
# Sets VIRTUAL_ENV so uv properly targets the venv
pkg_install() {
  local pip_cmd="$1"
  shift
  if command -v uv >/dev/null 2>&1; then
    log "Installing with uv: $*"
    VIRTUAL_ENV="$VENV_DIR" uv pip install "$@"
  else
    log "Installing with pip: $*"
    "$pip_cmd" install "$@"
  fi
}

pkg_install_requirements() {
  local pip_cmd="$1"
  local req_file="$2"
  shift 2
  if command -v uv >/dev/null 2>&1; then
    log "Installing requirements with uv: $req_file"
    VIRTUAL_ENV="$VENV_DIR" uv pip install -r "$req_file" "$@"
  else
    log "Installing requirements with pip: $req_file"
    "$pip_cmd" install -r "$req_file" "$@"
  fi
}

install_python312() {
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing python3.12 via apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    if ! apt-get install -y python3.12 python3.12-venv python3.12-distutils python3.12-dev; then
      log "Adding deadsnakes PPA to obtain python3.12"
      apt-get install -y software-properties-common gnupg ca-certificates
      add-apt-repository -y ppa:deadsnakes/ppa
      apt-get update
      apt-get install -y python3.12 python3.12-venv python3.12-distutils python3.12-dev
    fi
  else
    echo "python3.12 is required. Install it manually or set PYTHON_BIN to an existing interpreter." >&2
    exit 1
  fi
}

COMFY_DIR=${COMFY_DIR:-/workspace}
TORCH_INDEX_URL=${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}
nuvu_REPO=${nuvu_REPO:-https://github.com/nuvulabs/ComfyUI-Nuvu.git}
nuvu_BRANCH=${nuvu_BRANCH:-}
MANAGER_REPO=${MANAGER_REPO:-https://github.com/Comfy-Org/ComfyUI-Manager.git}
SAGE_REPO=${SAGE_REPO:-https://github.com/thu-ml/SageAttention.git}
PYTHON_DEFAULT_BIN=${PYTHON_DEFAULT_BIN:-python3.12}

export LICENSE_SERVER_URL LICENSE_KEY

if [ -n "${PYTHON_BIN:-}" ]; then
  ensure_cmd "$PYTHON_BIN"
else
  PY_FOUND="$(command -v "$PYTHON_DEFAULT_BIN" || true)"
  if [ -z "$PY_FOUND" ]; then
    log "python3.12 not detected. Attempting installation..."
    install_python312
    PY_FOUND="$(command -v "$PYTHON_DEFAULT_BIN" || true)"
    if [ -z "$PY_FOUND" ]; then
      echo "Failed to locate python3.12 even after installation attempt. Set PYTHON_BIN to a valid interpreter." >&2
      exit 1
    fi
  fi
  PYTHON_BIN="$PY_FOUND"
fi

ensure_cmd git
ensure_cmd "$PYTHON_BIN"

"$PYTHON_BIN" - <<'PY'
import sys
if sys.version_info < (3, 12):
    ver = ".".join(map(str, sys.version_info[:3]))
    raise SystemExit(f"Python 3.12+ is required, but {ver} is available.")
PY

export PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring

APP_DIR="$COMFY_DIR/ComfyUI"
VENV_DIR="$APP_DIR/venv"
VENV_PY="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

CUSTOM_NODES_DIR="$APP_DIR/custom_nodes"
CUSTOM_NODE_DIR="$CUSTOM_NODES_DIR/ComfyUI-Nuvu"
MANAGER_DIR="$CUSTOM_NODES_DIR/ComfyUI-Manager"

# Trust mounted repositories to avoid Git safe.directory warnings
git config --global --add safe.directory '*' || true

# Helper function to clone and install a custom node if missing
# Checks individually - only installs if not present
clone_and_install_node() {
  local NODE_NAME="$1"
  local NODE_REPO="$2"
  local NODE_DIR="$CUSTOM_NODES_DIR/$NODE_NAME"
  
  if [ ! -d "$NODE_DIR/.git" ]; then
    log "$NODE_NAME not found, installing..."
    git clone "$NODE_REPO" "$NODE_DIR"
    
    if [ -f "$NODE_DIR/requirements.txt" ]; then
      pkg_install_requirements "$VENV_PIP" "$NODE_DIR/requirements.txt"
    fi
  else
    log "$NODE_NAME already present, skipping"
  fi
}

# Helper function to ensure ComfyUI-Nuvu is installed
ensure_nuvu_node() {
  if [ ! -d "$CUSTOM_NODE_DIR/.git" ]; then
    log "ComfyUI-Nuvu not found, installing..."
    mkdir -p "$CUSTOM_NODES_DIR"
    git clone "$nuvu_REPO" "$CUSTOM_NODE_DIR"
    
    if [ -n "$nuvu_BRANCH" ]; then
      log "Checking out ComfyUI-Nuvu branch: $nuvu_BRANCH"
      git -C "$CUSTOM_NODE_DIR" fetch origin "$nuvu_BRANCH" || true
      git -C "$CUSTOM_NODE_DIR" checkout "$nuvu_BRANCH"
    fi
    
    # Install ComfyUI-Nuvu requirements
    CUSTOM_REQS="$CUSTOM_NODE_DIR/requirements.txt"
    CUSTOM_REQS_ALT="$CUSTOM_NODE_DIR/req.txt"
    if [ -f "$CUSTOM_REQS" ]; then
      log "Installing ComfyUI-Nuvu requirements.txt"
      pkg_install_requirements "$VENV_PIP" "$CUSTOM_REQS"
    elif [ -f "$CUSTOM_REQS_ALT" ]; then
      log "Installing ComfyUI-Nuvu req.txt"
      pkg_install_requirements "$VENV_PIP" "$CUSTOM_REQS_ALT"
    else
      echo "ComfyUI-Nuvu requirements file not found at $CUSTOM_REQS (or $CUSTOM_REQS_ALT)" >&2
      exit 1
    fi
  else
    log "ComfyUI-Nuvu already present, skipping"
    
    # Check branch if specified
    if [ -n "$nuvu_BRANCH" ]; then
      log "Checking out ComfyUI-Nuvu branch: $nuvu_BRANCH"
      git -C "$CUSTOM_NODE_DIR" fetch origin "$nuvu_BRANCH" || true
      git -C "$CUSTOM_NODE_DIR" checkout "$nuvu_BRANCH"
    fi
  fi
}

# Helper function to ensure ComfyUI-Manager is installed
ensure_manager_node() {
  if [ ! -d "$MANAGER_DIR/.git" ]; then
    log "ComfyUI-Manager not found, installing..."
    git clone "$MANAGER_REPO" "$MANAGER_DIR"
    
    if [ -f "$MANAGER_DIR/requirements.txt" ]; then
      pkg_install_requirements "$VENV_PIP" "$MANAGER_DIR/requirements.txt"
    fi
  else
    log "ComfyUI-Manager already present, skipping"
  fi
}

# Check if ComfyUI is already fully installed (has venv with working python)
COMFYUI_INSTALLED=false
if [ -d "$APP_DIR/.git" ] && [ -x "$VENV_PY" ]; then
  log "ComfyUI installation detected at $APP_DIR"
  COMFYUI_INSTALLED=true
fi

if [ "$COMFYUI_INSTALLED" = true ]; then
  log "Skipping ComfyUI installation (already installed)"
  
  # Export VIRTUAL_ENV so uv and other tools properly target this venv
  export VIRTUAL_ENV="$VENV_DIR"
  
  # Check each custom node individually and install only if missing
  log "Checking custom nodes..."
  ensure_manager_node
  ensure_nuvu_node
  clone_and_install_node "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
  clone_and_install_node "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
  clone_and_install_node "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
  clone_and_install_node "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"
  clone_and_install_node "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
  
  # Ensure correct ML dependency versions (override any weird versions from custom nodes)
  log "Installing ML dependencies"
  pkg_install "$VENV_PIP" "transformers==4.57.6"
  pkg_install "$VENV_PIP" "diffusers>=0.33.0"
  pkg_install "$VENV_PIP" "huggingface_hub<1.0"
else
  log "ComfyUI not found, performing full installation..."
  
  # Ensure base ComfyUI directory exists
  mkdir -p "$COMFY_DIR"

  log "Cloning ComfyUI repository"
  git clone https://github.com/Comfy-Org/ComfyUI.git "$APP_DIR"

  log "Creating Python venv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"

  # Export VIRTUAL_ENV so uv and other tools properly target this venv
  export VIRTUAL_ENV="$VENV_DIR"

  mkdir -p "$CUSTOM_NODES_DIR"

  if [ -f "$APP_DIR/requirements.txt" ]; then
    log "Installing ComfyUI requirements"
    pkg_install "$VENV_PIP" torch torchvision torchaudio --index-url "$TORCH_INDEX_URL"
    pkg_install_requirements "$VENV_PIP" "$APP_DIR/requirements.txt" --extra-index-url "$TORCH_INDEX_URL"
  fi

  log "Upgrading pip/setuptools/wheel inside venv"
  pkg_install "$VENV_PIP" --upgrade pip setuptools wheel

  log "Installing keyring helpers"
  pkg_install "$VENV_PIP" keyrings.alt

  log "Installing SageAttention"
  pkg_install "$VENV_PIP" sageattention --no-build-isolation

  # Install all custom nodes (each checked individually)
  ensure_manager_node
  ensure_nuvu_node
  clone_and_install_node "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
  clone_and_install_node "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
  clone_and_install_node "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
  clone_and_install_node "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"
  clone_and_install_node "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"

  # Ensure correct ML dependency versions (override any weird versions from custom nodes)
  log "Installing ML dependencies"
  pkg_install "$VENV_PIP" "transformers==4.57.6"
  pkg_install "$VENV_PIP" "diffusers>=0.33.0"
  pkg_install "$VENV_PIP" "huggingface_hub<1.0"

  # Install JupyterLab using python3.12
  log "Installing JupyterLab"
  "$PYTHON_BIN" -m pip install jupyterlab pexpect || true
fi

# Start JupyterLab in the background using python3.12
log "Starting JupyterLab on port 8888"
SHELL=/bin/bash "$PYTHON_BIN" -m jupyterlab \
  --ip=0.0.0.0 \
  --port=8888 \
  --no-browser \
  --allow-root \
  --ServerApp.token='' \
  --ServerApp.password='' \
  --ServerApp.terminals_enabled=True \
  --ServerApp.disable_check_xsrf=True \
  --ServerApp.allow_origin='*' \
  --ServerApp.allow_credentials=False &

# GPU monitoring and auto-shutdown (only if SHUTDOWN_CHECK_TIME is set)
if [ -n "${SHUTDOWN_CHECK_TIME:-}" ]; then
  # Parse shutdown time (format: HHMM or HH:MM, e.g., "0300" or "03:00")
  SHUTDOWN_TIME=$(echo "$SHUTDOWN_CHECK_TIME" | tr -d ':')
  if [ ${#SHUTDOWN_TIME} -ne 4 ]; then
    echo "WARNING: SHUTDOWN_CHECK_TIME must be in HHMM or HH:MM format (e.g., 0300 or 03:00), got: $SHUTDOWN_CHECK_TIME"
  else
    SHUTDOWN_HOUR_STR=$(echo "$SHUTDOWN_TIME" | cut -c1-2)
    SHUTDOWN_HOUR=$((10#$SHUTDOWN_HOUR_STR))
    END_CHECK_HOUR=$((SHUTDOWN_HOUR + 1))
    if [ $END_CHECK_HOUR -ge 24 ]; then
      END_CHECK_HOUR=0
    fi
    
    echo "GPU shutdown monitoring enabled: checking at ${SHUTDOWN_TIME} (${SHUTDOWN_HOUR}:00 - ${END_CHECK_HOUR}:00)"
    mkdir -p /var/log
    export SHUTDOWN_TIME SHUTDOWN_HOUR END_CHECK_HOUR
    bash -c '
      shutdown_pod() {
        local pod_id="${RUNPOD_POD_ID:-}"
        if [ -z "$pod_id" ]; then
          echo "ERROR: RUNPOD_POD_ID not set, cannot shutdown pod" >&2
          return 1
        fi
        
        # Try runpodctl first, fallback to API
        if command -v runpodctl >/dev/null 2>&1; then
          echo "Stopping pod $pod_id using runpodctl..."
          runpodctl stop pod "$pod_id" || return 1
        elif [ -n "${RUNPOD_API_KEY:-}" ]; then
          echo "Stopping pod $pod_id using RunPod API..."
          curl -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
            -H "Content-Type: application/json" \
            -d "{\"query\": \"mutation { podStop(input: {podId: \\\"$pod_id\\\"}) { id } }\"}" || return 1
        else
          echo "ERROR: Neither runpodctl nor RUNPOD_API_KEY available, cannot shutdown pod" >&2
          return 1
        fi
      }
      
      while true; do
        CURRENT_HOUR_STR=$(date +%H)
        CURRENT_HOUR=$((10#$CURRENT_HOUR_STR))
        CURRENT_TIME=$(date +%H%M)
        
        # If it is after the end check hour, sleep until next shutdown time
        if [ "$CURRENT_HOUR" -ge "$END_CHECK_HOUR" ] || [ "$CURRENT_HOUR" -lt "$SHUTDOWN_HOUR" ]; then
          # Calculate seconds until next shutdown time
          NOW=$(date +%s)
          TARGET_HOUR=$(printf "%02d" "$SHUTDOWN_HOUR")
          TARGET=$(date -d "tomorrow ${TARGET_HOUR}:00" +%s 2>/dev/null || date -d "next day ${TARGET_HOUR}:00" +%s)
          SLEEP_TIME=$((TARGET - NOW))
          if [ $SLEEP_TIME -lt 0 ]; then
            SLEEP_TIME=$((SLEEP_TIME + 86400))  # Add 24 hours if calculation went wrong
          fi
          echo "[$(date)] Sleeping until next ${SHUTDOWN_TIME} check window (in $((SLEEP_TIME / 3600)) hours)..."
          sleep $SLEEP_TIME
          continue
        fi
        
        # We are in the check window
        if [ "$CURRENT_TIME" = "$SHUTDOWN_TIME" ]; then
          echo "[$(date)] Checking GPU utilization at ${SHUTDOWN_TIME}..."
          GPU_UTIL=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk "{print int(\$1)}" || echo "0")
          echo "[$(date)] GPU utilization: ${GPU_UTIL}%"
          
          if [ "${GPU_UTIL:-0}" -lt 10 ]; then
            echo "[$(date)] GPU utilization ${GPU_UTIL}% is below 10%, shutting down pod..."
            shutdown_pod && break || echo "[$(date)] Failed to shutdown pod, will retry tomorrow"
          else
            echo "[$(date)] GPU utilization ${GPU_UTIL}% is above 10%, keeping pod running"
          fi
          
          # Wait until after end check hour before stopping checks
          while [ "$CURRENT_HOUR" -lt "$END_CHECK_HOUR" ]; do
            sleep 60
            CURRENT_HOUR_STR=$(date +%H)
            CURRENT_HOUR=$((10#$CURRENT_HOUR_STR))
          done
          echo "[$(date)] ${END_CHECK_HOUR}:00 reached, stopping checks until tomorrow"
        else
          sleep 30  # check every 30 seconds during the check window
        fi
      done
    ' >/var/log/gpu-watch.log 2>&1 &
  fi
else
  echo "SHUTDOWN_CHECK_TIME not set, GPU shutdown monitoring disabled"
fi

# Start ComfyUI in background (without exec so shell stays as PID 1)
"$VENV_PY" "$APP_DIR/main.py" --use-sage-attention --listen --port 8188 --preview-method auto "$@" &
COMFYUI_PID=$!

# Function to handle cleanup
cleanup() {
    echo "Shutting down..."
    kill $COMFYUI_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT

# Wait for ComfyUI, but keep container alive if it's killed
wait $COMFYUI_PID || {
    echo "ComfyUI process ended. Container will stay alive for JupyterLab."
    # Keep container running for JupyterLab
    while true; do sleep 3600; done
}

