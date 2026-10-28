#!/usr/bin/env python3
"""Create (or update) the Render web service for this API and wait for it to
deploy. Reads RENDER_API_KEY from .render_api_key and MONGODB_URI/TOKEN from
.env, which are passed to the service as environment variables. Never prints
secrets.

Usage: python scripts/deploy_render.py [--name NAME] [--repo URL]
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.render.com/v1"


def read_env_file(path):
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def call(key, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + key)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode()
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        raise SystemExit("Render API %s %s failed: HTTP %d\n%s" % (method, path, error.code, error.read().decode(errors="replace")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="cs409-mp3")
    parser.add_argument("--repo", default="https://github.com/DJRkod/mp3")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--region", default="ohio")
    args = parser.parse_args()

    key = read_env_file(ROOT / ".render_api_key").get("RENDER_API_KEY")
    if not key:
        raise SystemExit(".render_api_key must define RENDER_API_KEY")
    env = read_env_file(ROOT / ".env")
    if not env.get("MONGODB_URI"):
        raise SystemExit(".env must define MONGODB_URI (run scripts/provision_atlas.py)")
    env_vars = [{"key": "MONGODB_URI", "value": env["MONGODB_URI"]},
                {"key": "TOKEN", "value": env.get("TOKEN", "secret-starter-mern")}]

    owners = call(key, "GET", "/owners?limit=20")
    owner_id = owners[0]["owner"]["id"]
    print("owner: %s" % owners[0]["owner"]["name"])

    services = [s["service"] for s in call(key, "GET", "/services?limit=100")]
    service = next((s for s in services if s["name"] == args.name), None)
    if service is None:
        service = call(key, "POST", "/services", {
            "type": "web_service",
            "name": args.name,
            "ownerId": owner_id,
            "repo": args.repo,
            "branch": args.branch,
            "autoDeploy": "yes",
            "envVars": env_vars,
            "serviceDetails": {
                "runtime": "node",
                "region": args.region,
                "plan": "free",
                "healthCheckPath": "/",
                "envSpecificDetails": {"buildCommand": "npm install", "startCommand": "npm start"},
            },
        })["service"]
        print("service: %s (created)" % service["name"])
    else:
        call(key, "PUT", "/services/%s/env-vars" % service["id"], env_vars)
        call(key, "POST", "/services/%s/deploys" % service["id"], {})
        print("service: %s (exists; env vars updated, deploy triggered)" % service["name"])
    url = service["serviceDetails"]["url"]
    print("url: %s" % url)

    for _ in range(60):
        deploys = call(key, "GET", "/services/%s/deploys?limit=1" % service["id"])
        status = deploys[0]["deploy"]["status"] if deploys else "pending"
        if status == "live":
            print("deploy: live")
            break
        if status in ("build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"):
            raise SystemExit("deploy: %s" % status)
        print("deploy: %s..." % status)
        time.sleep(15)
    else:
        raise SystemExit("deploy did not finish in time; check the Render dashboard")
    return 0


if __name__ == "__main__":
    sys.exit(main())
