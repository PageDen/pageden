#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request


API_BASE = "https://api.porkbun.com/api/json/v3"
CREDENTIALS_PATH = "/conf/porkbun.ini"


def load_credentials():
    values = {}
    with open(CREDENTIALS_PATH, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    try:
        return values["dns_porkbun_key"], values["dns_porkbun_secret"]
    except KeyError as exc:
        raise RuntimeError(f"Missing {exc.args[0]} in {CREDENTIALS_PATH}") from exc


def request(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Porkbun API HTTP {exc.code}: {body}") from exc
    result = json.loads(body)
    if result.get("status") != "SUCCESS":
        raise RuntimeError(f"Porkbun API error: {result.get('message') or result}")
    return result


def auth_payload():
    api_key, secret = load_credentials()
    return {"apikey": api_key, "secretapikey": secret}


def certbot_domain():
    domain = os.environ.get("CERTBOT_DOMAIN", "").removeprefix("*.").strip(".")
    if domain not in {"pageden.app", "pageden.io"}:
        raise RuntimeError(f"Unexpected CERTBOT_DOMAIN: {domain}")
    return domain


def validation():
    value = os.environ.get("CERTBOT_VALIDATION", "")
    if not value:
        raise RuntimeError("CERTBOT_VALIDATION is missing")
    return value


def fail(error):
    print(str(error), file=sys.stderr)
    sys.exit(1)
