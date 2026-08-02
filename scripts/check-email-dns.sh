#!/usr/bin/env bash
# Snapshot the DNS records that email depends on.
#
# Run it BEFORE touching DNS and again AFTER, then diff the two:
#
#   ./scripts/check-email-dns.sh > /tmp/email-before.txt
#   ...add the reverie record, deploy...
#   ./scripts/check-email-dns.sh > /tmp/email-after.txt
#   diff /tmp/email-before.txt /tmp/email-after.txt && echo "email DNS unchanged"
#
# Adding a subdomain cannot affect any of these, but proving it beats assuming it.

set -uo pipefail
DOMAIN="${1:-walter.com.au}"

echo "# email DNS for $DOMAIN"
echo

echo "## MX (where inbound mail goes)"
dig +short MX "$DOMAIN" | sort
echo

echo "## TXT at apex (includes SPF)"
dig +short TXT "$DOMAIN" | sort
echo

echo "## DMARC"
dig +short TXT "_dmarc.$DOMAIN" | sort
echo

echo "## DKIM selectors"
for sel in google default selector1 selector2 k1 mail; do
  out=$(dig +short TXT "$sel._domainkey.$DOMAIN")
  [ -n "$out" ] && echo "$sel: $out"
done
echo

echo "## Nameservers"
dig +short NS "$DOMAIN" | sort
