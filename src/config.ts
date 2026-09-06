export * from '../shared/rules';
import { DEFAULT_FLAG_MIN_POINTS } from '../shared/rules';

export const CITY = {
  name: 'Assam',
  center: [91.7505, 26.1855] as [number, number], // start over Guwahati, Ambari / Pan Bazar
  zoom: 16,
  // W, S, E, N — the whole state, with a little room around it
  bounds: [[89.4, 23.9], [96.3, 28.2]] as [[number, number], [number, number]],
};
/** Vector tiles with every OSM footprint in Assam, built by scripts/build-tiles.sh. */
export const TILES_URL = import.meta.env.VITE_TILES_URL || '/data/assam.pmtiles';

export const MAP_STYLE = import.meta.env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron';
export const NIGHT_STYLE = import.meta.env.VITE_NIGHT_STYLE || 'https://tiles.openfreemap.org/styles/fiord';
/** Aerial imagery for the satellite toggle. Esri World Imagery; keep the attribution. */
export const SATELLITE_TILES = import.meta.env.VITE_SATELLITE_TILES || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';
/** Material Symbols names for each kind. */
export const KIND_ICONS: Record<string, string> = { building: 'home_work', farm: 'agriculture', tree: 'park', park: 'nature', playground: 'sports_soccer', pond: 'water', flyover: 'alt_route', road: 'add_road', landmark: 'temple_hindu', furniture: 'light', wall: 'fence', railway: 'train', civic: 'report_problem' };
export const SUBTYPE_ICONS: Record<string, string> = { temple: 'temple_hindu', mosque: 'mosque', church: 'church', statue: 'emoji_people', gate: 'door_sliding', tank: 'water_drop', streetlight: 'light', busstop: 'directions_bus', bench: 'chair', dustbin: 'delete', teastall: 'emoji_food_beverage',
  garbage: 'delete_sweep', pothole: 'warning', waterlogging: 'water_damage', drain: 'water', streetlight_broken: 'light_off', dumping: 'recycling', encroachment: 'block' };
export const CIVIC_SHORT: Record<string, string> = { garbage: 'Garbage', pothole: 'Pothole', waterlogging: 'Water', drain: 'Drain', streetlight: 'Light', dumping: 'Dumping', encroachment: 'Footpath' };
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
/** 'local' keeps everything in this browser, 'server' talks to the CityNovus API, 'auto' probes for one. */
export const BACKEND = (import.meta.env.VITE_BACKEND as 'local' | 'server' | 'auto' | undefined) ?? 'auto';
/** Hoardings are the future revenue model. Off until there is traction: everything is free. */
export const HOARDINGS_ENABLED = (import.meta.env.VITE_HOARDINGS as string | undefined) === 'true';
export const LOCAL_FLAG_MIN_POINTS = Number(import.meta.env.VITE_FLAG_MIN_POINTS ?? DEFAULT_FLAG_MIN_POINTS);

export const GREY = '#cfcfcf'; // unbuilt
export const HIDDEN = '#ece7e7'; // under community review

export const PALETTE = [
  '#f2c14e', '#e07a5f', '#d94f4f', '#f4a261', '#8ab17d', '#3d8b6e',
  '#5b8def', '#3a5ba0', '#b57edc', '#8d6e63', '#f5f0e6', '#4a4a4a',
];

export const STYLES = [
  { id: 'assam-type', label: 'Assam-type' },
  { id: 'rcc', label: 'RCC / concrete' },
  { id: 'shophouse', label: 'Shophouse' },
  { id: 'bamboo', label: 'Bamboo / kutcha' },
  { id: 'colonial', label: 'Colonial' },
  { id: 'modern', label: 'Modern / glass' },
];

export const ROOFS = [
  { id: 'flat', label: 'Flat (terrace)' },
  { id: 'tin', label: 'Tin sheet' },
  { id: 'tiled', label: 'Tiled' },
  { id: 'thatch', label: 'Thatch' },
  { id: 'dome', label: 'Dome / spire' },
];
/** null means "a darker shade of the wall colour". */
export const ROOF_COLOURS: Record<string, string | null> = { flat: null, tin: '#7f8c99', tiled: '#b5533c', thatch: '#8a7048', dome: null };

export const USES = [
  { id: 'house', label: 'House' },
  { id: 'shop', label: 'Shop' },
  { id: 'restaurant', label: 'Restaurant / tea stall' },
  { id: 'office', label: 'Office' },
  { id: 'school', label: 'School / college' },
  { id: 'hospital', label: 'Hospital / clinic' },
  { id: 'worship', label: 'Temple / mosque / church' },
  { id: 'hotel', label: 'Hotel' },
  { id: 'government', label: 'Government' },
  { id: 'factory', label: 'Factory / warehouse' },
  { id: 'other', label: 'Other' },
];
/** Uses that get a darker shopfront band on the ground floor. */
export const COMMERCIAL_USES = new Set(['shop', 'restaurant', 'hotel', 'office']);

export const TREES = [
  { id: 'sparse', label: 'A few trees' },
  { id: 'normal', label: 'Some trees' },
  { id: 'dense', label: 'Lots of trees' },
];
export const TREE_M2: Record<string, number> = { sparse: 500, normal: 220, dense: 110 }; // m² per tree
export const MAX_TREES = 90;
export const MAX_PLANTS = 140;

export const LANES = [
  { id: '1', label: '1 lane' },
  { id: '2', label: '2 lanes' },
  { id: '4', label: '4 lanes' },
  { id: '6', label: '6 lanes' },
];

export const FLAG_REASONS = [
  { id: 'wrong', label: 'Wrong: this is not what is here' },
  { id: 'offensive', label: 'Offensive or abusive' },
  { id: 'spam', label: 'Spam or advertising' },
  { id: 'private', label: 'Names a private person or home' },
];

export const BADGES: { id: string; label: string; emoji: string; test: (s: BadgeStats) => boolean; hint: string }[] = [
  { id: 'citizen', label: 'Citizen', emoji: '🪪', test: (s) => s.points >= 100, hint: '100 points' },
  { id: 'builder', label: 'Builder', emoji: '🏗️', test: (s) => s.kinds.building >= 10, hint: '10 buildings' },
  { id: 'master', label: 'Master builder', emoji: '🏛️', test: (s) => s.kinds.building >= 50, hint: '50 buildings' },
  { id: 'farmer', label: 'Farmer', emoji: '🌾', test: (s) => s.kinds.farm >= 1, hint: 'own a farm' },
  { id: 'gardener', label: 'Gardener', emoji: '🌳', test: (s) => s.kinds.tree >= 10, hint: 'plant 10 trees' },
  { id: 'water', label: 'Water keeper', emoji: '💧', test: (s) => s.kinds.pond >= 1, hint: 'colour in a pond' },
  { id: 'engineer', label: 'Engineer', emoji: '🌉', test: (s) => s.kinds.flyover >= 1, hint: 'build a flyover' },
  { id: 'planner', label: 'Planner', emoji: '🛣️', test: (s) => s.kinds.road >= 1, hint: 'lay a road' },
  { id: 'councillor', label: 'Councillor', emoji: '⚖️', test: (s) => s.points >= 1000, hint: '1000 points, can flag' },
  { id: 'mayor', label: 'Mayor', emoji: '🎖️', test: (s) => s.points >= 5000, hint: '5000 points' },
];
export interface BadgeStats { points: number; kinds: Record<string, number> }
