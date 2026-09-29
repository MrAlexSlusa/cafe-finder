# Nook cafe finder

A real, browser-based cafe finder. Search a town or use your location, then browse nearby cafes on the map and in a distance-sorted list. Filters use details explicitly present in OpenStreetMap, such as listed Wi-Fi and outdoor seating.

## Run locally

No install or API key is needed. From this folder, run:

```sh
python -m http.server 8000
```

Then visit [http://localhost:8000](http://localhost:8000). A local web server is required for browser location permissions.

## Data, privacy, and limits

- Place listings come from OpenStreetMap through the public Overpass API; place data is incomplete and may be out of date.
- Town search uses the public Photon geocoder, which is a community demo service with no uptime guarantee. Searches are user initiated and cached in this browser.
- The map uses Leaflet and the OpenStreetMap tile service, with visible map attribution.
- Coordinates are sent to Overpass only after the user starts a nearby search. Saved places stay in local browser storage.
- Ratings, noise levels, atmosphere, opening status, and “best” are not invented. The app ranks by available requested amenities and then distance. Cozy and quiet remain personal judgements until a trustworthy review source is connected.

This is a static app: it has no server, API key, sign-in, or build step.
