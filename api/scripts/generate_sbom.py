"""Generate a reproducible SPDX 2.3 JSON SBOM from uv.lock/package-lock.json."""
from __future__ import annotations

import hashlib
import json
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def spdx_id(value: str) -> str:
    return "SPDXRef-" + "".join(char if char.isalnum() or char in ".-" else "-" for char in value)


def python_packages() -> list[dict]:
    lock = tomllib.loads((ROOT / "api" / "uv.lock").read_text(encoding="utf-8"))
    packages = []
    for package in lock.get("package", []):
        source = package.get("source", {})
        archive = package.get("sdist") or next(iter(package.get("wheels", [])), {})
        checksum = str(archive.get("hash", "")).removeprefix("sha256:")
        item = {
            "SPDXID": spdx_id(f"pypi-{package['name']}-{package['version']}"),
            "name": package["name"], "versionInfo": package["version"],
            "downloadLocation": archive.get("url") or source.get("registry") or "NOASSERTION",
            "filesAnalyzed": False, "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION", "supplier": "NOASSERTION",
            "externalRefs": [{
                "referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                "referenceLocator": f"pkg:pypi/{package['name']}@{package['version']}",
            }],
        }
        if checksum:
            item["checksums"] = [{"algorithm": "SHA256", "checksumValue": checksum}]
        packages.append(item)
    return packages


def node_packages() -> list[dict]:
    lock = json.loads((ROOT / "web" / "package-lock.json").read_text(encoding="utf-8"))
    packages = []
    for path, package in lock.get("packages", {}).items():
        if not path or not package.get("version"):
            continue
        name = package.get("name") or path.rsplit("node_modules/", 1)[-1]
        version = package["version"]
        packages.append({
            "SPDXID": spdx_id(f"npm-{name}-{version}"), "name": name,
            "versionInfo": version, "downloadLocation": package.get("resolved", "NOASSERTION"),
            "filesAnalyzed": False, "licenseConcluded": "NOASSERTION",
            "licenseDeclared": package.get("license", "NOASSERTION"), "supplier": "NOASSERTION",
            "externalRefs": [{
                "referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                "referenceLocator": f"pkg:npm/{name}@{version}",
            }],
        })
    return packages


def main() -> None:
    packages = python_packages() + node_packages()
    namespace_hash = hashlib.sha256("\n".join(sorted(p["SPDXID"] for p in packages)).encode()).hexdigest()[:20]
    document = {
        "spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT", "name": "Y-v2-SBOM",
        "documentNamespace": f"https://y.local/spdx/{namespace_hash}",
        "creationInfo": {
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "creators": ["Tool: Y-api/scripts/generate_sbom.py"],
        },
        "packages": packages,
        "relationships": [{
            "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES",
            "relatedSpdxElement": package["SPDXID"],
        } for package in packages],
    }
    output = ROOT / "sbom.spdx.json"
    output.write_text(json.dumps(document, indent=2), encoding="utf-8")
    print(f"wrote {output} with {len(packages)} packages")


if __name__ == "__main__":
    sys.exit(main())
