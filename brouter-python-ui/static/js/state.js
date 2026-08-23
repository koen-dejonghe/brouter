// Shared mutable application state.
// All modules import this object and read/write its properties directly.
export const state = {
  map:               null,   // L.Map — set in main.js after map creation
  routeSource:       'brouter', // 'brouter' | 'imported'
  waypoints:         [],     // [{ lat, lon, marker: L.Marker }]
  undoStack:         [],     // array of snapshots (max 50)
  addingMode:        false,
  routeLayer:        null,
  routeInfoLayer:    null,   // direction + distance indicators
  routeInfoHandler:  null,   // zoom listener for dynamic marker spacing
  routeHitLayer:     null,   // transparent wide polyline for hover/click
  routeGeom:         null,   // dense [{ lat, lon, cumDist }] from geometry coords
  routeWpSegs:       null,   // routeGeom index of each waypoint (for insertion)
  routeWpMeasures:   null,   // monotonic route distance of each waypoint
  elevData:          null,
  elevMode:          'gradient', // 'gradient' | 'surface'
  elevSelection:     null,   // { distStart, distEnd } or null
  selectionLayer:    null,   // L.layerGroup overlay for selected segment
  selStartMarker:    null,   // L.circleMarker at selection start
  selEndMarker:      null,   // L.circleMarker at selection end
  routeSegments:     null,   // [{ latlngs, category, cumDistStart, cumDistEnd }]
  routeBounds:       null,   // full route L.LatLngBounds
  profileParams:     [],
  hoverMarker:       null,
  routeTimer:        null,   // debounce handle for auto-route
  routeRequestSeq:   0,
  routeAbortController: null,
  profileParamsRequestSeq: 0,
  profileParamsAbortController: null,
  profileParamsProfile: null,
  profileParamsReady: false,
  clickTimer:        null,   // guard against dblclick zoom
  dragSrcIdx:        null,   // index of row being dragged
  wpListExpanded:    false,  // whether intermediate waypoints are expanded
  wpListVisible:     false,  // whether waypoint list panel is visible
  locationMarker:    null,
  locationAccCircle: null,
  legCache:          [],     // legCache[i]: GeoJSON for wp[i]→wp[i+1], null = stale
  lastRouteKey:      '',     // detects profile/params changes → invalidates all legs
  svgDragState:      null,   // { startX, startDist, isDragging }
  fitRouteControl:   null,   // FitRouteControl instance — set in controls.js
  poiLayer:          null,   // L.LayerGroup with POI markers
  poiEnabled:        false,
  poiTypes:          new Set(['water', 'food', 'shelter']),
  poiFetchTimer:     null,
  poiRequestSeq:     0,
  poiAbortController: null,
  poiLoading:        false,
  selectedPois:      [],     // explicitly marked POIs for GPX export
  poiStore:          new Map(), // id -> { id, name, category, lat, lon }
  addPreviewLine:    null,    // temporary line from last waypoint to cursor
  addPreviewLabel:   null,    // distance label for add preview
  gpxImportSeq:      0,
  gpxAbortController: null,
  importedRoute:     null,    // { originalXml, fileName, geojson }
};
