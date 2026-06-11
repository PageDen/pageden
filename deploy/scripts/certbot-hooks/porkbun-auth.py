#!/usr/bin/env python3
import os
import time

from porkbun_common import auth_payload, certbot_domain, fail, request, validation


try:
    domain = certbot_domain()
    payload = auth_payload()
    payload.update(
        {
            "name": "_acme-challenge",
            "type": "TXT",
            "content": validation(),
            "ttl": "600",
        }
    )
    request(f"dns/create/{domain}", payload)
    wait_seconds = int(os.environ.get("PORKBUN_PROPAGATION_SECONDS", "180"))
    print(f"Created Porkbun ACME TXT for {domain}; waiting {wait_seconds}s for DNS propagation.")
    time.sleep(wait_seconds)
except Exception as exc:
    fail(exc)
