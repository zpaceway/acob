# ACOB Website

This directory contains ACOB's buildless static marketing website. It is
separate from the Django API, makes no ACOB API requests, and is not an
authenticated product interface.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, product copy, and metadata. |
| `styles.css` | Responsive layout, theme, and animations. |
| `script.js` | Mobile navigation, example tabs, and copyright year. |
| `favicon.svg` | Browser icon. |

## Local Preview

No package installation or build step is required. From the monorepo root:

```bash
python -m http.server 8000 --directory web
```

Open `http://127.0.0.1:8000`. From this directory, `python -m http.server 8000`
is equivalent.

## Verification

Before publishing changes:

- Preview narrow mobile and desktop viewport widths.
- Exercise the mobile menu and the Research, Operations, and Testing tabs.
- Check keyboard navigation, visible focus, reduced-motion behavior, and local
  and external links.
- Confirm `index.html`, `styles.css`, `script.js`, and `favicon.svg` load without
  browser console errors.

The page loads Google Fonts from `fonts.googleapis.com` and
`fonts.gstatic.com`, so its typography depends on network access and those
third-party requests should be considered in any deployment privacy policy.

## Deployment

Deploy the contents of `web/` as a static site with `index.html` at the site
root. The repository does not define a hosting provider or deployment pipeline;
provider-specific state and local environment files are intentionally ignored.
