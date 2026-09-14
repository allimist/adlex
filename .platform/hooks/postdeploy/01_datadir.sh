#!/bin/bash
# Data directory outside /var/app/current so JSON files survive redeploys
# (not instance replacement - move to Firestore before relying on it).
set -e
mkdir -p /var/app/data
chown -R webapp:webapp /var/app/data
chmod 750 /var/app/data
