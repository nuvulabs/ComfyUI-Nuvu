#!/bin/bash

# Configuration
IMAGE_NAME="nuvulabs/comfyui-nuvu"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}${NC}"

# Check if Dockerfile exists
if [ ! -f "Dockerfile" ]; then
    echo -e "${RED}Error: Dockerfile not found in current directory${NC}"
    exit 1
fi

# Build the image
echo -e "${YELLOW}Building image...${NC}"
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Image built successfully!${NC}"
    echo ""
    echo -e "${GREEN}Image: ${IMAGE_NAME}:${IMAGE_TAG}${NC}"
    echo ""
    echo -e "${YELLOW}To push the image, run: ./push.sh${NC}"
    echo -e "${YELLOW}Or manually: docker push ${IMAGE_NAME}:${IMAGE_TAG}${NC}"
else
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi


