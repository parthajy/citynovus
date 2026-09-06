#!/usr/bin/env bash
# Builds public/data/assam.pmtiles and the side files from a Geofabrik PBF.
#   scripts/build-tiles.sh <india-latest.osm.pbf> <boundary.geojson>
# Needs: osmium-tool, tippecanoe (brew install osmium-tool tippecanoe). Takes a while; run it once per data refresh.
set -euo pipefail
PBF="${1:?path to india-latest.osm.pbf}"
BOUNDARY="${2:?path to assam-boundary.geojson}"
WORK="${WORK:-$(mktemp -d)}"
OUT="${OUT:-public/data}"
echo "1/4 clipping Assam out of $PBF"
osmium extract -p "$BOUNDARY" -s smart "$PBF" -o "$WORK/assam.osm.pbf" --overwrite
echo "2/4 keeping only what the map needs"
osmium tags-filter "$WORK/assam.osm.pbf" w/building w/natural=water w/landuse=reservoir,grass,recreation_ground w/leisure=park,garden,playground,pitch w/bridge=yes n/place w/highway n/amenity w/amenity n/shop w/shop n/tourism w/tourism n/historic w/historic n/railway=station -o "$WORK/filtered.osm.pbf" --overwrite
osmium export "$WORK/filtered.osm.pbf" -c scripts/tiles-export.json -f geojsonseq -o "$WORK/export.geojsonl" --overwrite
echo "3/4 preparing footprints, places, neighbourhoods, search"
node scripts/tiles-prepare.mjs "$WORK/export.geojsonl" "$OUT"
echo "4/4 tiles"
tippecanoe -o "$OUT/assam.pmtiles" -l osm -Z 11 -z 15 -pc --drop-densest-as-needed --extend-zooms-if-still-dropping --simplification=4 --force -q "$OUT/osm.geojsonl"
[ -n "${KEEP_GEOJSONL:-}" ] || rm -f "$OUT/osm.geojsonl"
ls -la "$OUT"/assam.pmtiles "$OUT"/places.json "$OUT"/neighbourhoods.json "$OUT"/search.json
echo "done. work dir: $WORK"
