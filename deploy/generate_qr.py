"""Generate the automatic and phone-specific event QR codes."""
from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import qrcode


def with_mode(url: str, mode: str | None) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if mode:
        query["ui"] = mode
    else:
        query.pop("ui", None)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="Deployed /app URL")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, url in {
        "y-demo-auto-qr.png": with_mode(args.url, None),
        "y-demo-mobile-qr.png": with_mode(args.url, "mobile"),
    }.items():
        qrcode.make(url).save(args.output_dir / name)
        print(f"{name}: {url}")


if __name__ == "__main__":
    main()
