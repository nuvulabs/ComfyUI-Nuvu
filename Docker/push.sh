#!/bin/bash
set -euo pipefail

# Configuration
IMAGE_NAME="nuvulabs/comfyui-nuvu"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Pushing Docker image: ${IMAGE_NAME}:${IMAGE_TAG}${NC}"

# Check if image exists locally
if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^${IMAGE_NAME}:${IMAGE_TAG}$"; then
    echo -e "${RED}Error: Docker image '${IMAGE_NAME}:${IMAGE_TAG}' not found locally${NC}"
    echo -e "${YELLOW}Please build the image first with: ./build.sh${NC}"
    exit 1
fi

# Check if user is logged in to Docker Hub
if ! docker info | grep -q "Username"; then
    echo -e "${YELLOW}Not logged in to Docker Hub. Attempting to login...${NC}"
    docker login
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Docker login failed${NC}"
        exit 1
    fi
fi

# Push the image
echo -e "${YELLOW}Pushing image to Docker Hub...${NC}"
docker push "${IMAGE_NAME}:${IMAGE_TAG}"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Image pushed successfully!${NC}"
    echo ""
    echo -e "${GREEN}Image available at: https://hub.docker.com/r/${IMAGE_NAME}${NC}"
    echo ""
    echo -e "${YELLOW}To pull the image: docker pull ${IMAGE_NAME}:${IMAGE_TAG}${NC}"
else
    echo -e "${RED}✗ Push failed${NC}"
    exit 1
fi




