FROM runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring

# System deps
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git ffmpeg unzip \
    libgl1 libglib2.0-0 \
    software-properties-common build-essential \
    aria2 \
    jq \
    ninja-build \
    && rm -rf /var/lib/apt/lists/*

# Python 3.12 (via deadsnakes)
RUN add-apt-repository ppa:deadsnakes/ppa -y && apt-get update -y && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package installer) to /opt/uv
ENV UV_DIR=/opt/uv
ENV PATH="$UV_DIR:$PATH"
RUN mkdir -p "$UV_DIR" \
    && curl -LsSf https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz \
    | tar -xz -C "$UV_DIR" --strip-components=1 \
    && chmod +x "$UV_DIR/uv" \
    && uv --version

# Pip (as fallback, but uv is preferred)
RUN curl -sS https://bootstrap.pypa.io/get-pip.py -o get-pip.py && \
    python3.12 get-pip.py && rm get-pip.py && \
    python3.12 -m pip install --upgrade pip setuptools wheel

WORKDIR /workspace

# CUDA-appropriate PyTorch wheel index (CUDA 12.8)
ENV TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128 \
    COMFY_DIR=/workspace

# Copy setup script and make it executable
#COPY comfy_setup.sh /usr/local/lib/ao_labs/.bootstrap.sh
#RUN sed -i 's/\r$//' /usr/local/lib/ao_labs/.bootstrap.sh && chmod +x /usr/local/lib/ao_labs/.bootstrap.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#COPY full /usr/local/lib/ao_labs/config
#COPY full/subgraphs /usr/local/bin/subgraphs
#COPY full/workflows /usr/local/bin/workflows

# Global pip/uv constraint, baked into the IMAGE (not the ComfyUI repo, which is cloned into
# /workspace at runtime). transformers pins huggingface_hub<1.0, but several bundled custom
# nodes list huggingface_hub unpinned, so on first boot ComfyUI-Manager's prestartup dependency
# restore pip-installs them and the resolver drags huggingface_hub up to 1.x AFTER the entrypoint
# pin has run -> transformers fails to import -> ComfyUI crashes (a restart "fixes" it because
# Manager's first-run routines don't repeat). Both env vars are inherited by every child process
# (entrypoint installs, Manager's make_pip_cmd via pip OR uv, node install scripts, runtime
# installs), so huggingface_hub>=1.0 can never be resolved in the first place. The constraints
# file lives at /etc so it survives the runtime clone of ComfyUI into /workspace.
RUN printf 'huggingface_hub<1.0\n' > /etc/nuvu-pip-constraints.txt
ENV PIP_CONSTRAINT=/etc/nuvu-pip-constraints.txt \
    UV_CONSTRAINT=/etc/nuvu-pip-constraints.txt

EXPOSE 8188 8888
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
