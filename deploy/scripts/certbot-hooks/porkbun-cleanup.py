#!/usr/bin/env python3
from porkbun_common import auth_payload, certbot_domain, fail, request, validation


try:
    domain = certbot_domain()
    expected_name = f"_acme-challenge.{domain}"
    expected_value = validation()
    payload = auth_payload()
    records = request(f"dns/retrieve/{domain}", payload).get("records", [])
    deleted = 0
    for record in records:
        if (
            record.get("type") == "TXT"
            and record.get("name") == expected_name
            and record.get("content") == expected_value
        ):
            request(f"dns/delete/{domain}/{record['id']}", payload)
            deleted += 1
    print(f"Removed {deleted} Porkbun ACME TXT record(s) for {domain}.")
except Exception as exc:
    fail(exc)
