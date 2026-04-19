#!/bin/bash
# Crew Assist SWIM Service — One-command server setup
# Run this in the Lightsail browser SSH terminal:
#   bash <(curl -s https://raw.githubusercontent.com/YOUR_REPO/main/swim-service/setup.sh)
# OR paste the whole script directly into the terminal.

set -e
echo "=== Crew Assist SWIM Service Setup ==="

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/6] Installing system dependencies..."
sudo apt-get update -q
sudo apt-get install -y -q nodejs npm git curl

# Install Node 20 LTS (Ubuntu 22 ships Node 12 which is too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null
sudo apt-get install -y -q nodejs
echo "Node: $(node --version), npm: $(npm --version)"

# ── 2. Create app directory ───────────────────────────────────────────────────
echo "[2/6] Setting up app directory..."
sudo mkdir -p /opt/crew-assist-swim
sudo chown ubuntu:ubuntu /opt/crew-assist-swim
cd /opt/crew-assist-swim
mkdir -p data

# ── 3. Copy service files ─────────────────────────────────────────────────────
# (Files will be uploaded via scp or git — placeholder here)
echo "[3/6] Checking for service files..."
if [ ! -f "package.json" ]; then
  echo "ERROR: Service files not found in /opt/crew-assist-swim"
  echo "Please upload the swim-service directory contents first."
  exit 1
fi

# ── 4. Install Node dependencies ──────────────────────────────────────────────
echo "[4/6] Installing Node.js dependencies..."
npm install --production

# ── 5. Create .env file ───────────────────────────────────────────────────────
echo "[5/6] Creating .env file..."
if [ ! -f ".env" ]; then
cat > .env << 'ENVEOF'
# FAA SWIM SCDS credentials — fill in after portal.swim.faa.gov approval
SWIM_HOST=scds.swim.faa.gov
SWIM_PORT=5671
SWIM_USERNAME=
SWIM_PASSWORD=
SWIM_QUEUE=

# API secret — must match SWIM_API_SECRET in Netlify env vars
API_SECRET=CHANGE_THIS_TO_A_RANDOM_STRING
API_PORT=3000

# VAPID push notification keys (generate with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:support@crewassistapp.com

# Netlify credentials (to read push subscriptions)
NETLIFY_TOKEN=
NETLIFY_SITE_ID=

# Database path
DB_PATH=./data/swim.db
ENVEOF
echo ">>> .env created — edit it with your credentials: nano .env"
else
  echo ".env already exists — skipping"
fi

# ── 6. Install PM2 and start service ─────────────────────────────────────────
echo "[6/6] Setting up PM2 process manager..."
sudo npm install -g pm2 --silent
pm2 start index.js --name crew-assist-swim
pm2 startup systemd -u ubuntu --hp /home/ubuntu | sudo bash || true
pm2 save

echo ""
echo "=== Setup Complete ==="
echo "Service status: pm2 status"
echo "View logs:      pm2 logs crew-assist-swim"
echo "Edit config:    nano /opt/crew-assist-swim/.env"
echo "Restart:        pm2 restart crew-assist-swim"
echo ""
echo "API is running on port 3000"
echo "Next: open port 3000 in Lightsail firewall, then set SWIM_API_URL in Netlify"
