# AdVault Spy 1.3.1 — Prospecting Engine

This build turns **Find Prospects from Scan** into a real page-level business prospect extractor.

## What changed

- Improved Google Maps result extraction using result-feed/card structures.
- Added fallback extraction for Maps layouts that expose only place links.
- Added structured-data extraction for LocalBusiness / Organization pages.
- Added generic public business-directory card extraction.
- Added business-name filtering to reduce false positives such as “Directions” and “Share”.
- Extracts rating and review count when visible.
- Extracts public phone, email, website and source URL when available.
- Deduplicates businesses using normalized business/website keys.
- Advertising evidence is now attributed to the specific business instead of giving every business a page-wide ad bonus.
- Ad evidence can match by advertiser name, title, or landing-page domain.
- Prospect scoring now reflects evidence and public-data quality.
- Prospect cards show HOT / GOOD / POSSIBLE tier and advertising signal count.
- CSV export now includes rating, review count, advertising signals, matched advertisers and evidence signals.
- Existing ad scanning and AI creative analysis remain intact.

## Intended flow

Scan Page → Find Prospects from Scan → Extract Businesses → Match Advertising Evidence → Score → Explain Why → Generate Pitch → Export CSV
