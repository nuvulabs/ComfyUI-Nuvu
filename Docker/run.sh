#!/bin/bash
set -euo pipefail

# Configuration
IMAGE_NAME="nuvulabs/comfyui-nuvu"
CONTAINER_NAME="io_comfy"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/nuvulabs/comfyui-nuvu}"
PORT_COMFYUI=8188
PORT_JUPYTER=8888

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Docker container: ${CONTAINER_NAME}${NC}"

# Create workspace directory if it doesn't exist
mkdir -p "$WORKSPACE_DIR"
echo -e "${YELLOW}Workspace directory: $(realpath "$WORKSPACE_DIR")${NC}"

# Stop and remove existing container if it exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Stopping existing container...${NC}"
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo -e "${YELLOW}Removing existing container...${NC}"
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

# Check if image exists (handle both local and Docker Hub images)
if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^${IMAGE_NAME}:latest$" && \
   ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^${IMAGE_NAME}:"; then
    echo -e "${RED}Error: Docker image '${IMAGE_NAME}' not found.${NC}"
    echo -e "${YELLOW}Please pull the image first with: docker pull ${IMAGE_NAME}:latest${NC}"
    echo -e "${YELLOW}Or build it locally with: docker build -t ${IMAGE_NAME} .${NC}"
    exit 1
fi

# Run the container
echo -e "${GREEN}Starting container...${NC}"
docker run -d \
    --name "$CONTAINER_NAME" \
    --gpus all \
    -p "${PORT_COMFYUI}:8188" \
    -p "${PORT_JUPYTER}:8888" \
    -v "$(realpath "$WORKSPACE_DIR"):/workspace" \
    "${IMAGE_NAME}:latest"

# Wait a moment for container to start
sleep 2

# Check if container is running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${GREEN}✓ Container started successfully!${NC}"
    echo ""
    echo -e "${GREEN}Access:${NC}"
    echo -e "  ComfyUI:  http://localhost:${PORT_COMFYUI}"
    echo -e "  JupyterLab: http://localhost:${PORT_JUPYTER}"
    echo ""
    echo -e "${YELLOW}View logs: docker logs -f ${CONTAINER_NAME}${NC}"
    echo -e "${YELLOW}Stop container: docker stop ${CONTAINER_NAME}${NC}"
else
    echo -e "${RED}✗ Container failed to start. Check logs with: docker logs ${CONTAINER_NAME}${NC}"
    exit 1
fi


