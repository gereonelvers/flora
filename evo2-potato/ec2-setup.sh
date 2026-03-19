#!/usr/bin/env bash
# Run this ON the EC2 instance after SSH-ing in.
# Usage: bash ec2-setup.sh
set -euo pipefail

echo "=== Evo 2 Potato Mutation Scorer — EC2 Setup ==="

# System packages
sudo apt-get update -y
sudo apt-get install -y git build-essential python3.11 python3.11-venv python3.11-dev

# Python venv
python3.11 -m venv ~/evo2-env
source ~/evo2-env/bin/activate

pip install --upgrade pip

# PyTorch with CUDA 12.8
echo "=== Installing PyTorch ==="
pip install torch==2.7.1 --index-url https://download.pytorch.org/whl/cu128

# FlashAttention (required by Evo 2)
echo "=== Installing FlashAttention ==="
pip install flash-attn==2.8.0.post2 --no-build-isolation

# Evo 2 + server deps
echo "=== Installing Evo 2 + server dependencies ==="
pip install evo2 fastapi uvicorn biopython

# Sanity check
echo "=== Running Evo 2 generation test ==="
python -m evo2.test.test_evo2_generation --model_name evo2_7b_base

echo ""
echo "=== Setup complete! ==="
echo "To start the server:"
echo "  source ~/evo2-env/bin/activate"
echo "  cd ~/evo2-potato"
echo "  uvicorn server:app --host 0.0.0.0 --port 8000"
