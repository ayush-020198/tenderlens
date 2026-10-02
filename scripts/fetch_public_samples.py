"""Download only manifest-listed Indian public PDFs; never scrape a login or CAPTCHA."""
import argparse
import hashlib
import json
import re
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
HOSTS = {"iisc.ac.in", "www.iisc.ac.in"}
MAX_BYTES = 20 * 1024 * 1024


def allowed(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in HOSTS and not parsed.username


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise ValueError("Redirect left the approved official source. Download stopped.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", default="iisc-wall-fans-2021")
    parser.add_argument("--acknowledge-source-terms", action="store_true")
    args = parser.parse_args()
    if not args.acknowledge_source_terms:
        parser.error("Read datasets/sources.json, then explicitly pass --acknowledge-source-terms.")
    manifest = json.loads((ROOT / "datasets/sources.json").read_text("utf-8"))
    matches = [package for package in manifest["packages"] if package["id"] == args.package]
    if len(matches) != 1 or not re.fullmatch(r"[a-z0-9-]+", args.package):
        parser.error("Choose an existing package ID from datasets/sources.json.")
    package = matches[0]
    destination = ROOT / "data/public" / package["id"]
    destination.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(OfficialRedirects())
    records = []
    for document in package["documents"]:
        if not allowed(document["url"]) or Path(document["filename"]).name != document["filename"]:
            raise ValueError("Unsafe URL or filename in source manifest.")
        request = urllib.request.Request(
            document["url"], headers={"User-Agent": "TenderLens-research/0.1 (public-document-reader)"}
        )
        with opener.open(request, timeout=60) as response:
            data = response.read(MAX_BYTES + 1)
            resolved_url = response.url
        if len(data) > MAX_BYTES or not data.lstrip().startswith(b"%PDF-"):
            raise ValueError("Source did not return a PDF within the 20 MB limit; no file saved.")
        digest = hashlib.sha256(data).hexdigest()
        if document.get("sha256") and digest != document["sha256"]:
            raise ValueError("The public document changed. Review it before updating the manifest hash.")
        path = destination / document["filename"]
        temporary = path.with_suffix(".download")
        temporary.write_bytes(data)
        temporary.replace(path)
        records.append(document | {
            "resolved_url": resolved_url, "sha256": digest, "bytes": len(data),
            "downloaded_at": datetime.now(UTC).isoformat(),
        })
        print(f"Downloaded {path.name}: {len(data)} bytes, SHA256 {digest}")
    receipt = package | {"download_receipts": records}
    (destination / "provenance.json").write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Local-only dataset: {destination}")
    print("Review each PDF before using it as ground truth. No real-document labels were invented.")


if __name__ == "__main__":
    main()
