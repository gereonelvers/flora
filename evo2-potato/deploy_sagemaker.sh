#!/usr/bin/env bash
# Deploy Evo 2 7B on SageMaker (after Marketplace subscription).
#
# Prerequisites:
#   1. AWS CLI configured
#   2. Subscribe to Evo 2 NIM on AWS Marketplace:
#      https://aws.amazon.com/marketplace/pp/prodview-daikatl6hfzqe
#
# Usage: bash deploy_sagemaker.sh
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
MODEL_NAME="evo2-7b-nim"
ENDPOINT_NAME="evo2-7b-nim"
INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g6e.xlarge}"  # single L40S, 48GB — enough for 7B
ROLE_ARN="arn:aws:iam::872716504287:role/evo2-sagemaker-role"

# Model package ARN per region
declare -A MODEL_PKGS=(
    ["us-east-1"]="arn:aws:sagemaker:us-east-1:865070037744:model-package/evo2-7b-v-210-with-added-g6e-2bfa65c53ec6343cb4a4b8d00b17373a"
    ["us-east-2"]="arn:aws:sagemaker:us-east-2:057799348421:model-package/evo2-7b-v-210-with-added-g6e-2bfa65c53ec6343cb4a4b8d00b17373a"
    ["us-west-2"]="arn:aws:sagemaker:us-west-2:594846645681:model-package/evo2-7b-v-210-with-added-g6e-2bfa65c53ec6343cb4a4b8d00b17373a"
)

MODEL_PKG="${MODEL_PKGS[$REGION]:-}"
if [ -z "$MODEL_PKG" ]; then
    echo "ERROR: Region $REGION not supported. Use us-east-1, us-east-2, or us-west-2."
    exit 1
fi

echo "=== Evo 2 7B SageMaker Deployment ==="
echo "Region:   $REGION"
echo "Instance: $INSTANCE_TYPE"
echo ""

# --- Create model ---
echo "Creating SageMaker model..."
aws sagemaker create-model \
    --model-name "$MODEL_NAME" \
    --primary-container "{\"ModelPackageName\":\"$MODEL_PKG\"}" \
    --execution-role-arn "$ROLE_ARN" \
    --enable-network-isolation \
    --region "$REGION" \
    --query 'ModelArn' --output text

# --- Create endpoint config ---
echo "Creating endpoint config..."
aws sagemaker create-endpoint-config \
    --endpoint-config-name "$ENDPOINT_NAME" \
    --production-variants "[{
        \"VariantName\": \"AllTraffic\",
        \"ModelName\": \"$MODEL_NAME\",
        \"InitialInstanceCount\": 1,
        \"InstanceType\": \"$INSTANCE_TYPE\",
        \"InferenceAmiVersion\": \"al2-ami-sagemaker-inference-gpu-3-1\",
        \"RoutingConfig\": {\"RoutingStrategy\": \"LEAST_OUTSTANDING_REQUESTS\"},
        \"ModelDataDownloadTimeoutInSeconds\": 3600,
        \"ContainerStartupHealthCheckTimeoutInSeconds\": 3600
    }]" \
    --region "$REGION" \
    --query 'EndpointConfigArn' --output text

# --- Create endpoint ---
echo "Creating endpoint (this takes 10-20 min for model download + startup)..."
aws sagemaker create-endpoint \
    --endpoint-name "$ENDPOINT_NAME" \
    --endpoint-config-name "$ENDPOINT_NAME" \
    --region "$REGION" \
    --query 'EndpointArn' --output text

echo ""
echo "Endpoint is being created. Monitor status with:"
echo "  aws sagemaker describe-endpoint --endpoint-name $ENDPOINT_NAME --region $REGION --query 'EndpointStatus'"
echo ""
echo "Wait for 'InService' status, then test with:"
echo "  aws sagemaker-runtime invoke-endpoint \\"
echo "    --endpoint-name $ENDPOINT_NAME \\"
echo "    --region $REGION \\"
echo "    --content-type application/json \\"
echo "    --body '{\"sequence\":\"ACGTACGTACGT\",\"num_tokens\":10,\"top_k\":4}' \\"
echo "    /dev/stdout"
echo ""
echo "To delete when done:"
echo "  aws sagemaker delete-endpoint --endpoint-name $ENDPOINT_NAME --region $REGION"
echo "  aws sagemaker delete-endpoint-config --endpoint-config-name $ENDPOINT_NAME --region $REGION"
echo "  aws sagemaker delete-model --model-name $MODEL_NAME --region $REGION"
