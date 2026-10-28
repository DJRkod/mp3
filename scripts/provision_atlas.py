#!/usr/bin/env python3
"""Provision the MongoDB Atlas resources for this project through the Atlas
Admin API (v2) and write the connection string to .env.

Idempotent: re-running finds existing resources instead of duplicating them.
Reads ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY from .atlas_api_keys. Never prints
secrets; the generated database password goes only into .env and the LLM log
redaction list.

Usage: python scripts/provision_atlas.py [--project NAME] [--cluster NAME]
"""
import argparse
import json
import secrets
import string
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://cloud.mongodb.com/api/atlas/v2"
ACCEPT = "application/vnd.atlas.2024-08-05+json"


def read_env_file(path):
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class Atlas:
    def __init__(self, public, private):
        password_manager = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        password_manager.add_password(None, BASE, public, private)
        self.opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(password_manager))

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, method=method)
        request.add_header("Accept", ACCEPT)
        if data is not None:
            request.add_header("Content-Type", ACCEPT)
        try:
            with self.opener.open(request, timeout=60) as response:
                text = response.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise SystemExit("Atlas API %s %s failed: HTTP %d\n%s" % (method, path, error.code, detail))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="cs409-mp3")
    parser.add_argument("--cluster", default="mp3")
    parser.add_argument("--db-user", default="mp3app")
    parser.add_argument("--database", default="mp3")
    args = parser.parse_args()

    keys = read_env_file(ROOT / ".atlas_api_keys")
    if not keys.get("ATLAS_PUBLIC_KEY") or not keys.get("ATLAS_PRIVATE_KEY"):
        raise SystemExit(".atlas_api_keys must define ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY")
    atlas = Atlas(keys["ATLAS_PUBLIC_KEY"], keys["ATLAS_PRIVATE_KEY"])

    orgs = atlas.call("GET", "/orgs")["results"]
    if not orgs:
        raise SystemExit("the API key can see no organizations")
    org_id = orgs[0]["id"]
    print("organization: %s" % orgs[0]["name"])

    projects = [p for p in atlas.call("GET", "/groups?itemsPerPage=500")["results"] if p["name"] == args.project]
    if projects:
        project = projects[0]
        print("project: %s (exists)" % project["name"])
    else:
        project = atlas.call("POST", "/groups", {"name": args.project, "orgId": org_id})
        print("project: %s (created)" % project["name"])
    group = project["id"]

    # Open access list, as the course README requires for grading.
    entries = atlas.call("GET", "/groups/%s/accessList" % group)["results"]
    if not any(e.get("cidrBlock") == "0.0.0.0/0" for e in entries):
        atlas.call("POST", "/groups/%s/accessList" % group,
                   [{"cidrBlock": "0.0.0.0/0", "comment": "course requirement: allow access from anywhere"}])
        print("access list: 0.0.0.0/0 added")
    else:
        print("access list: 0.0.0.0/0 present")

    clusters = atlas.call("GET", "/groups/%s/clusters" % group)["results"]
    cluster = next((c for c in clusters if c["name"] == args.cluster), None)
    if cluster is None:
        cluster = atlas.call("POST", "/groups/%s/clusters" % group, {
            "name": args.cluster,
            "clusterType": "REPLICASET",
            "replicationSpecs": [{"regionConfigs": [{
                "providerName": "TENANT",
                "backingProviderName": "AWS",
                "regionName": "US_EAST_1",
                "priority": 7,
                "electableSpecs": {"instanceSize": "M0", "nodeCount": 3},
            }]}],
        })
        print("cluster: %s (creating, free tier M0)" % args.cluster)
    else:
        print("cluster: %s (exists, %s)" % (args.cluster, cluster.get("stateName")))

    # Database user: create once with a generated password; reuse the one in .env after that.
    env_path = ROOT / ".env"
    env = read_env_file(env_path)
    existing_uri = env.get("MONGODB_URI", "")
    users = atlas.call("GET", "/groups/%s/databaseUsers" % group)["results"]
    password = None
    if any(u["username"] == args.db_user for u in users) and args.db_user + ":" in existing_uri:
        password = existing_uri.split(args.db_user + ":", 1)[1].split("@", 1)[0]
        print("database user: %s (exists)" % args.db_user)
    else:
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(32))
        if any(u["username"] == args.db_user for u in users):
            atlas.call("PATCH", "/groups/%s/databaseUsers/admin/%s" % (group, args.db_user), {"password": password})
            print("database user: %s (password reset)" % args.db_user)
        else:
            atlas.call("POST", "/groups/%s/databaseUsers" % group, {
                "databaseName": "admin", "username": args.db_user, "password": password,
                "roles": [{"roleName": "readWriteAnyDatabase", "databaseName": "admin"}],
            })
            print("database user: %s (created)" % args.db_user)

    for _ in range(60):
        cluster = atlas.call("GET", "/groups/%s/clusters/%s" % (group, args.cluster))
        if cluster.get("stateName") == "IDLE" and cluster.get("connectionStrings", {}).get("standardSrv"):
            break
        print("waiting for cluster (%s)..." % cluster.get("stateName"))
        time.sleep(15)
    else:
        raise SystemExit("cluster did not become ready in time; re-run this script later")

    srv = cluster["connectionStrings"]["standardSrv"]  # mongodb+srv://host
    uri = srv.replace("mongodb+srv://", "mongodb+srv://%s:%s@" % (args.db_user, password))
    uri += "/%s?retryWrites=true&w=majority" % args.database

    lines = []
    if env_path.exists():
        lines = [l for l in env_path.read_text(encoding="utf-8-sig").splitlines() if not l.startswith("MONGODB_URI=")]
    if not any(l.startswith("TOKEN=") for l in lines):
        lines.append("TOKEN=secret-starter-mern")
    lines.append("MONGODB_URI=%s" % uri)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(".env written (host %s)" % srv.replace("mongodb+srv://", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
