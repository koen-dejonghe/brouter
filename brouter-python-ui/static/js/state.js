// Shared mutable application state.
// All modules import this object and read/write its properties directly.
export const state = {
  map:               null,   // L.Map — set in main.js after map creation
  routeSource:       'brouter', // 'brouter' | 'imported'
  waypoints:         [],     // [{ lat, lon, marker: L.Marker }]
  undoStack:         [],     // array of snapshots (max 50)
  addingMode:        false,
  routeLayer:        null,
  routeHitLayer:     null,   // transparent wide polyline for hover/click
  routeGeom:         null,   // dense [{ lat, lon, cumDist }] from geometry coords
  routeWpSegs:       null,   // routeGeom index of each waypoint (for insertion)
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
  clickTimer:        null,   // guard against dblclick zoom
  dragSrcIdx:        null,   // index of row being dragged
  wpListExpanded:    false,  // whether intermediate waypoints are expanded
  locationMarker:    null,
  locationAccCircle: null,
  legCache:          [],     // legCache[i]: GeoJSON for wp[i]→wp[i+1], null = stale
  lastRouteKey:      '',     // detects profile/params changes → invalidates all legs
  svgDragState:      null,   // { startX, startDist, isDragging }
  fitRouteControl:   null,   // FitRouteControl instance — set in controls.js
};
