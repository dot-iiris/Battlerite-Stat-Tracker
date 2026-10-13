#!/bin/bash
# Paste this into Oracle Cloud > Create instance > Advanced options > Management >
# "Initialization script". It runs once at first boot (about 10 minutes); progress
# is in /var/log/cloud-init-output.log. No secrets in here - those are uploaded later.
set -e
export DOMAIN=br.iarhm.xyz
apt-get update && apt-get install -y git
git clone --branch main https://github.com/dot-iiris/Battlerite-Stat-Tracker.git /opt/brstats/site
bash /opt/brstats/site/deploy/oracle-setup.sh
