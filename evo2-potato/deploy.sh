#!/usr/bin/env bash
# Deploy Evo 2 Potato Mutation Scorer to AWS EC2.
#
# Prerequisites:
#   - AWS CLI configured (aws configure / aws sso login)
#   - An EC2 key pair (will be created if KEY_NAME doesn't exist)
#
# Usage:
#   bash deploy.sh                  # uses defaults
#   KEY_NAME=mykey bash deploy.sh   # specify key pair
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g6e.xlarge}"
KEY_NAME="${KEY_NAME:-evo2-potato-key}"
SG_NAME="evo2-potato-sg"
VOLUME_SIZE=200
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Evo 2 Potato Mutation Scorer — AWS Deploy ==="
echo "Region:        $REGION"
echo "Instance type: $INSTANCE_TYPE"
echo "Key pair:      $KEY_NAME"
echo ""

# --- Key pair ---
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" &>/dev/null; then
    echo "Creating key pair '$KEY_NAME'..."
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$REGION" \
        --query 'KeyMaterial' \
        --output text > "${SCRIPT_DIR}/${KEY_NAME}.pem"
    chmod 400 "${SCRIPT_DIR}/${KEY_NAME}.pem"
    echo "  Key saved to ${SCRIPT_DIR}/${KEY_NAME}.pem"
else
    echo "Key pair '$KEY_NAME' already exists."
fi

# --- Security group ---
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)

SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)

if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
    echo "Creating security group '$SG_NAME'..."
    SG_ID=$(aws ec2 create-security-group \
        --group-name "$SG_NAME" \
        --description "Evo2 potato mutation scorer - SSH + HTTP" \
        --vpc-id "$VPC_ID" \
        --region "$REGION" \
        --query 'GroupId' --output text)

    # SSH
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" --region "$REGION" \
        --protocol tcp --port 22 --cidr 0.0.0.0/0

    # HTTP API
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" --region "$REGION" \
        --protocol tcp --port 8000 --cidr 0.0.0.0/0

    echo "  Security group: $SG_ID"
else
    echo "Security group '$SG_NAME' already exists: $SG_ID"
fi

# --- Subnet (pick first public subnet in default VPC) ---
SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" Name=map-public-ip-on-launch,Values=true \
    --query 'Subnets[0].SubnetId' --output text)
echo "Using subnet: $SUBNET_ID"

# --- Launch instance ---
echo ""
echo "Launching $INSTANCE_TYPE instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "resolve:ssm:/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --subnet-id "$SUBNET_ID" \
    --associate-public-ip-address \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE,\"VolumeType\":\"gp3\"}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=evo2-potato}]" \
    --query 'Instances[0].InstanceId' --output text)

echo "Instance launched: $INSTANCE_ID"
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo ""
echo "=== Instance Ready ==="
echo "Instance ID:  $INSTANCE_ID"
echo "Public IP:    $PUBLIC_IP"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. SSH into the instance (wait ~60s for boot):"
echo "   ssh -i ${SCRIPT_DIR}/${KEY_NAME}.pem ubuntu@${PUBLIC_IP}"
echo ""
echo "2. Upload the project files:"
echo "   scp -i ${SCRIPT_DIR}/${KEY_NAME}.pem -r ${SCRIPT_DIR}/{server.py,potato_gbss.fasta,ec2-setup.sh} ubuntu@${PUBLIC_IP}:~/"
echo ""
echo "3. Run the setup script on the instance:"
echo "   bash ~/ec2-setup.sh"
echo ""
echo "4. Start the server:"
echo "   source ~/evo2-env/bin/activate"
echo "   uvicorn server:app --host 0.0.0.0 --port 8000"
echo ""
echo "5. Test from your laptop:"
echo "   curl -X POST http://${PUBLIC_IP}:8000/score \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"kind\":\"snv\",\"pos\":250,\"alt\":\"G\",\"window\":4096}'"
echo ""
echo "6. To stop and avoid charges:"
echo "   aws ec2 terminate-instances --instance-ids $INSTANCE_ID --region $REGION"
