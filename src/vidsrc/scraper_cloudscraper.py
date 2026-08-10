"""
Cloudscraper-based m3u8 URL extraction for VidSrc.to.
Replaces SeleniumBase with cloudscraper (no headed Chrome needed).
"""

from __future__ import annotations

import re
import time
import sys

# Use the global CLOUDSCRAPER from scraper.py
from scraper import CLOUDSCRAPER


def fetch_player_html(rcp_url: str, timeout_s: int = 60) -> str:
    """
    Fetch the player HTML using cloudscraper, waiting for Turnstile to clear.
    Returns the complete player HTML with m3u8 URLs.
    """
    if not CLOUDSCRAPER:
        raise RuntimeError(
            "cloudscraper is not available. Install with: pip install cloudscraper"
        )
    
    print(f"[*] Using cloudscraper for Turnstile: {rcp_url[:80]}...", file=sys.stderr)
    
    deadline = time.time() + timeout_s
    player_html = ""
    
    while time.time() < deadline:
        try:
            resp = CLOUDSCRAPER.get(rcp_url, timeout=15)
            html = resp.text
            
            # Check if we got the player HTML (not just the challenge page)
            if _is_player_html(html):
                player_html = html
                print(f"[+] Turnstile cleared via cloudscraper", file=sys.stderr)
                break
                
            # If we got the challenge page, wait a bit and retry
            if _is_challenge(html):
                print(f"[*] Challenge still present, waiting...", file=sys.stderr)
                time.sleep(2)
                continue
                
            # Check if the HTML contains m3u8 URLs
            if _has_m3u8_content(html):
                player_html = html
                print(f"[+] Player HTML obtained via cloudscraper", file=sys.stderr)
                break
                
        except Exception as e:
            print(f"[-] cloudscraper request failed: {e}", file=sys.stderr)
            time.sleep(1)
            continue
    
    if not player_html:
        raise ValueError(
            f"cloudscraper timed out after {timeout_s}s waiting for player HTML"
        )
    
    return player_html


def _is_player_html(html: str) -> bool:
    """Check if HTML contains the player payload (not just challenge)."""
    if not html:
        return False
    return (
        "master_urls" in html 
        or "generate.php" in html 
        or "Playerjs" in html
    )


def _is_challenge(html: str) -> bool:
    """Check if HTML is a Cloudflare challenge page."""
    if not html:
        return False
    return (
        "Just a moment" in html
        or "challenges.cloudflare.com" in html
        or "cf-turnstile" in html
    )


def _has_m3u8_content(html: str) -> bool:
    """Check if HTML contains m3u8 content."""
    if not html:
        return False
    return bool(re.search(r'https?://[^\s"\'<>]+\.m3u8', html))


def extract_m3u8_urls(player_html: str, player_base: str) -> list[dict]:
    """
    Extract m3u8 URLs from player HTML using the same logic as scraper.py.
    """
    # Use the existing extraction logic from scraper.py
    from scraper import _extract, _parse_file_field
    
    # First try to get the file match from master_urls or Playerjs
    file_match = (
        _extract(r'master_urls\s*=\s*"([^"]+\.m3u8[^"]*)"', player_html)
        or _extract(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', player_html)
        or _extract(r'"file"\s*:\s*"([^"]+\.m3u8[^"]*)"', player_html)
    )
    
    if not file_match:
        # Fallback: find any m3u8 URLs in the HTML
        urls = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', player_html)
        if not urls:
            raise ValueError("Player loaded but no m3u8 URLs found in HTML")
        file_match = " or ".join(dict.fromkeys(urls))
    
    # Handle token-based streams
    token = None
    if "__TOKEN__" in file_match or "__TOKEN__" in player_html:
        # For cloudscraper, we need to get the token differently
        # The token should be available in the page or from generate.php
        token_match = _extract(r'__TOKEN__\s*=\s*["\']([^"\']+)["\']', player_html)
        if token_match:
            token = token_match
        else:
            # Try to find the token from generate.php response
            generate_match = _extract(
                r'["\']generate\.php\?t=([^"\']+)["\']',
                player_html
            )
            if generate_match:
                token = generate_match
    
    return _parse_file_field(file_match, player_html, player_base, token=token)


def get_m3u8_urls_cloudscraper(rcp_url: str, player_base: str, timeout_s: int = 60) -> list[dict]:
    """
    Cloudscraper-based m3u8 extraction - no headed Chrome needed!
    """
    player_html = fetch_player_html(rcp_url, timeout_s)
    return extract_m3u8_urls(player_html, player_base)
