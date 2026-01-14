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

# CUDA-appropriate PyTorch wheel index (CUDA 13.0)
ENV TORCH_INDEX_URL=https://download.pytorch.org/whl/cu130 \
    COMFY_DIR=/workspace

# Copy setup script and make it executable
#COPY comfy_setup.sh /usr/local/lib/ao_labs/.bootstrap.sh
#RUN sed -i 's/\r$//' /usr/local/lib/ao_labs/.bootstrap.sh && chmod +x /usr/local/lib/ao_labs/.bootstrap.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#COPY full /usr/local/lib/ao_labs/config
#COPY full/subgraphs /usr/local/bin/subgraphs
#COPY full/workflows /usr/local/bin/workflows

EXPOSE 8188 8888
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
