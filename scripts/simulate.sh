#!/bin/bash
# Usage: scripts/simulate.sh <campaignKey> [clicks=20] [conversions=2] [BASE_URL=http://localhost:8080]
set -e
KEY=${1:?campaign key required}
N=${2:-20}
C=${3:-2}
BASE=${BASE_URL:-http://localhost:8080}
IDS=()
for i in $(seq 1 "$N"); do
  LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -H "X-Forwarded-For: 10.0.$((RANDOM%255)).$((RANDOM%255))" \
    "$BASE/click/$KEY?clickid=EXT$RANDOM&cost=0.012&t1=zone$((RANDOM%5))")
  CID=$(echo "$LOC" | grep -oE '[0-9A-Z]{26}' | head -1)
  [ -n "$CID" ] && IDS+=("$CID")
done
echo "clicks sent: ${#IDS[@]}"
for i in $(seq 1 "$C"); do
  CID=${IDS[$((RANDOM % ${#IDS[@]}))]}
  printf 'postback %s -> ' "$CID"
  curl -s "$BASE/postback?clickid=$CID&payout=3.5&status=sale&txid=TX$RANDOM"; echo
done
