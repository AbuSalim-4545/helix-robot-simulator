const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env files
function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const k = trimmed.substring(0, idx).trim();
          const v = trimmed.substring(idx + 1).trim();
          if (k && !process.env[k]) process.env[k] = v;
        }
      });
    }
  } catch (e) {}
}
loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));


// ─────────────────────────────────────────────────────────────────────────────
// Map & Marker Configuration Management
// Loads map-config.json and the Hotel Occupancy Grid Image file
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'map-config.json');
let mapConfig = {
  mapImageFile: "Hotel_layout_occupancy_grid_map_202607301416.jpeg",
  resolution: 0.05,
  origin: { x: -10.0, y: -10.0 },
  markers: [
    { name: "Charging Dock",  pose: { position: { x: 19.9, y: 6.2 },  orientation: { z: 0, w: 1 } }, behavior_code: 11 },
    { name: "Reception",      pose: { position: { x: 3.5,  y: -1.5 }, orientation: { z: 0, w: 1 } }, behavior_code: 0 },
    { name: "Lobby",          pose: { position: { x: 1.0,  y: 1.5 },  orientation: { z: 0, w: 1 } }, behavior_code: 0 },
    { name: "Meeting Room A", pose: { position: { x: -4.0, y: 3.5 },  orientation: { z: 0, w: 1 } }, behavior_code: 0 },
    { name: "Room 101",       pose: { position: { x: -5.5, y: -2.5 }, orientation: { z: 0, w: 1 } }, behavior_code: 0 },
    { name: "Room 102",       pose: { position: { x: -5.5, y: 0.5 },  orientation: { z: 0, w: 1 } }, behavior_code: 0 },
    { name: "Kitchen",        pose: { position: { x: 5.0,  y: 4.0 },  orientation: { z: 0, w: 1 } }, behavior_code: 0 }
  ],
  pathways: [
    { from: "Charging Dock",  to: "Lobby" },
    { from: "Lobby",          to: "Reception" },
    { from: "Lobby",          to: "Meeting Room A" },
    { from: "Lobby",          to: "Kitchen" },
    { from: "Charging Dock",  to: "Room 102" },
    { from: "Room 102",       to: "Room 101" }
  ]
};

function loadMapConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      mapConfig = JSON.parse(data);
      console.log(`[CONFIG] Loaded ${mapConfig.markers.length} markers & ${mapConfig.pathways?.length || 0} pathways from map-config.json`);
    }
  } catch (e) {
    console.error('[CONFIG] Error loading map-config.json:', e.message);
  }
}
loadMapConfig();

function saveMapConfig(newCfg) {
  try {
    mapConfig = Object.assign({}, mapConfig, newCfg);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(mapConfig, null, 2), 'utf8');
    console.log(`[CONFIG] Saved map configuration to map-config.json (${mapConfig.markers.length} markers)`);
    broadcastMapToAll();
  } catch (e) {
    console.error('[CONFIG] Error saving map-config.json:', e.message);
  }
}

function getMarkerMap() {
  const map = {};
  if (mapConfig.markers) {
    mapConfig.markers.forEach(m => { map[m.name] = m; });
  }
  return map;
}

function getMapBase64() {
  const imgPath = path.join(__dirname, mapConfig.mapImageFile || "Hotel_layout_occupancy_grid_map_202607301416.jpeg");
  if (fs.existsSync(imgPath)) {
    return fs.readFileSync(imgPath).toString('base64');
  }
  return '';
}

function broadcastMap(client) {
  const b64 = getMapBase64();
  const msg = JSON.stringify({
    op: 'publish', topic: '/map',
    msg: {
      data: b64,
      info: {
        width: 1024, height: 1024, resolution: mapConfig.resolution || 0.05,
        origin: { position: { x: mapConfig.origin?.x ?? -10.0, y: mapConfig.origin?.y ?? -10.0 } }
      }
    }
  });
  if (client && client.readyState === 1) client.send(msg);
}

function broadcastMapToAll() {
  robotInstances.forEach(inst => {
    inst.wsClients.forEach(c => broadcastMap(c));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pathway Waypoint Finder (Shortest Path via BFS / Dijkstra)
// ─────────────────────────────────────────────────────────────────────────────
function findPathWaypoints(startPose, targetMarkerName) {
  const markerMap = getMarkerMap();
  const targetMarker = markerMap[targetMarkerName];
  if (!targetMarker) return null;

  const targetPos = targetMarker.pose.position;

  // Build graph of waypoints and pathways
  const graph = {};
  mapConfig.markers.forEach(m => { graph[m.name] = []; });
  if (mapConfig.pathways) {
    mapConfig.pathways.forEach(p => {
      if (graph[p.from] && graph[p.to]) {
        const m1 = markerMap[p.from], m2 = markerMap[p.to];
        const dist = Math.hypot(m1.pose.position.x - m2.pose.position.x, m1.pose.position.y - m2.pose.position.y);
        graph[p.from].push({ name: p.to, dist, x: m2.pose.position.x, y: m2.pose.position.y });
        graph[p.to].push({ name: p.from, dist, x: m1.pose.position.x, y: m1.pose.position.y });
      }
    });
  }

  // Find nearest graph node to start pose
  let startNode = null, minDist = Infinity;
  mapConfig.markers.forEach(m => {
    const d = Math.hypot(m.pose.position.x - startPose.x, m.pose.position.y - startPose.y);
    if (d < minDist) { minDist = d; startNode = m.name; }
  });

  if (startNode && graph[startNode]) {
    const queue = [[startNode]];
    const visited = new Set([startNode]);
    let foundPath = null;

    while (queue.length > 0) {
      const currentPath = queue.shift();
      const node = currentPath[currentPath.length - 1];

      if (node === targetMarkerName) {
        foundPath = currentPath;
        break;
      }

      for (const neighbor of graph[node] || []) {
        if (!visited.has(neighbor.name)) {
          visited.add(neighbor.name);
          queue.push([...currentPath, neighbor.name]);
        }
      }
    }

    if (foundPath) {
      return foundPath.map(name => ({
        name,
        x: markerMap[name].pose.position.x,
        y: markerMap[name].pose.position.y
      }));
    }
  }

  return [
    { name: 'Start', x: startPose.x, y: startPose.y },
    { name: targetMarkerName, x: targetPos.x, y: targetPos.y }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Persistence Files & Helpers
// ─────────────────────────────────────────────────────────────────────────────
const ROBOTS_FILE = path.join(__dirname, 'robots-registry.json');
const ORGS_FILE = path.join(__dirname, 'organizations.json');
const ROUTINES_FILE = path.join(__dirname, 'routines.json');
const CONTACTS_FILE = path.join(__dirname, 'delivery-contacts.json');

function loadRobots() {
  try {
    if (fs.existsSync(ROBOTS_FILE)) {
      const data = fs.readFileSync(ROBOTS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error('[ROBOTS] Error loading robots-registry.json:', e.message);
  }
  return [];
}

function saveRobots(robots) {
  try {
    fs.writeFileSync(ROBOTS_FILE, JSON.stringify(robots, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ROBOTS] Error saving robots-registry.json:', e.message);
    return false;
  }
}

function loadOrganizations() {
  try {
    if (fs.existsSync(ORGS_FILE)) {
      const data = fs.readFileSync(ORGS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error('[ORGS] Error loading organizations.json:', e.message);
  }
  return [];
}

function saveOrganizations(orgs) {
  try {
    fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ORGS] Error saving organizations.json:', e.message);
    return false;
  }
}

function loadRoutines() {
  try {
    if (fs.existsSync(ROUTINES_FILE)) {
      const data = fs.readFileSync(ROUTINES_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.error('[ROUTINES] Error loading routines.json:', e.message);
  }
  return [];
}

function saveRoutines(routines) {
  try {
    fs.writeFileSync(ROUTINES_FILE, JSON.stringify(routines, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ROUTINES] Error saving routines.json:', e.message);
    return false;
  }
}

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = fs.readFileSync(CONTACTS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.contacts || [];
    }
  } catch (e) {
    console.error('[CONTACTS] Error loading delivery-contacts.json:', e.message);
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Independent Simulated Robot Instance (Per-Robot Backbone)
// Each robot has its OWN isolated position, battery, navigation timer, and WS clients!
// ─────────────────────────────────────────────────────────────────────────────
function getDefaultPoseForRobot(robotId, index = 0) {
  if (robotId === 'model01') return { x: 19.9, y: 6.2, theta: 0 };
  if (robotId === 'model02') return { x: 18.0, y: 6.2, theta: 0 };
  if (robotId === 'model03') return { x: 16.0, y: 6.2, theta: 0 };
  return { x: parseFloat((14.0 - index * 1.5).toFixed(1)), y: 6.2, theta: 0 };
}

class RobotSimInstance {
  constructor(id, initialData = {}) {
    this.id = id;
    this.name = initialData.name || `Sadeem ${id.toUpperCase()}`;
    this.model = initialData.model || 'Sadeem AMR-V2';
    this.battery = typeof initialData.battery === 'number' ? initialData.battery : 85;
    this.charger = typeof initialData.charger === 'number' ? initialData.charger : 0;
    this.robotPose = initialData.pose || getDefaultPoseForRobot(id);
    this.isMoving = initialData.status === 'navigating' || false;
    this.navStatus = 0;
    this.currentGoal = initialData.currentGoal || 'Idle';
    this.last_poi = initialData.currentLocation || 'Charging Dock';
    this.speedScale = 15;
    this.remainingWaypoints = [];
    this.navTimer = null;
    this.wsClients = new Set();
    this.subscriptions = new Set();
  }

  broadcast(msgObj) {
    const msgStr = JSON.stringify(msgObj);
    this.wsClients.forEach((ws) => {
      if (ws.readyState === 1) {
        try { ws.send(msgStr); } catch (e) {}
      }
    });
  }

  startNavigationTo(targetMarkerName) {
    if (this.navTimer) {
      clearInterval(this.navTimer);
      this.navTimer = null;
    }

    const markerMap = getMarkerMap();
    const targetMarker = markerMap[targetMarkerName];

    // Check if robot is already at or very close to the destination
    if (targetMarker) {
      const dist = Math.hypot(this.robotPose.x - targetMarker.pose.position.x, this.robotPose.y - targetMarker.pose.position.y);
      if (dist < 0.25) {
        this.robotPose.x = targetMarker.pose.position.x;
        this.robotPose.y = targetMarker.pose.position.y;
        this.last_poi = targetMarkerName;
        this.isMoving = false;
        this.navStatus = 0;
        this.currentGoal = 'Idle';
        broadcastDashState();

        this.broadcast({
          op: 'publish',
          topic: '/robot_pose',
          msg: { x: this.robotPose.x, y: this.robotPose.y, theta: this.robotPose.theta }
        });
        this.broadcast({
          op: 'publish',
          topic: '/move_base/result',
          msg: { status: { status: 3 } }
        });

        if (typeof this.onArrival === 'function') {
          try { this.onArrival(this, targetMarkerName); } catch (e) {}
        }

        logDashboard(`[NAV-${this.id.toUpperCase()}] Already at "${targetMarkerName}" -> Immediate Navigation Success`);
        return;
      }
    }

    this.currentGoal = targetMarkerName;
    this.isMoving = true;
    this.navStatus = 1;
    broadcastDashState();

    const waypoints = findPathWaypoints(this.robotPose, targetMarkerName) || [
      { x: this.robotPose.x, y: this.robotPose.y },
      { x: targetMarker ? targetMarker.pose.position.x : 0, y: targetMarker ? targetMarker.pose.position.y : 0 }
    ];

    logDashboard(`[NAV-${this.id.toUpperCase()}] Started navigation to "${targetMarkerName}" (${waypoints.length} waypoints)`);

    this.broadcast({
      op: 'publish',
      topic: '/global_path',
      msg: { points: waypoints.map(w => ({ x: w.x, y: w.y, z: 0 })) }
    });

    const speedScale = Math.max(1, Math.min(20, parseInt(this.speedScale) || 15));
    const speed = speedScale * 0.12;
    const intervalMs = 200;
    const stepDist = speed * (intervalMs / 1000);

    let currentWayIdx = 0;
    let currX = this.robotPose.x;
    let currY = this.robotPose.y;

    this.navTimer = setInterval(() => {
      if (!this.isMoving) {
        clearInterval(this.navTimer);
        this.navTimer = null;
        return;
      }

      if (currentWayIdx >= waypoints.length) {
        clearInterval(this.navTimer);
        this.navTimer = null;
        if (targetMarker) {
          this.robotPose.x = targetMarker.pose.position.x;
          this.robotPose.y = targetMarker.pose.position.y;
          this.last_poi = targetMarkerName;
        }
        this.isMoving = false;
        this.navStatus = 0;
        this.currentGoal = 'Idle';
        broadcastDashState();

        this.broadcast({
          op: 'publish',
          topic: '/robot_pose',
          msg: { x: this.robotPose.x, y: this.robotPose.y, theta: this.robotPose.theta }
        });
        this.broadcast({
          op: 'publish',
          topic: '/move_base/result',
          msg: { status: { status: 3 } }
        });

        if (typeof this.onArrival === 'function') {
          try { this.onArrival(this, targetMarkerName); } catch (e) {}
        }

        logDashboard(`[NAV-${this.id.toUpperCase()}] Arrived at "${targetMarkerName}" (x:${this.robotPose.x}, y:${this.robotPose.y})`);
        return;
      }

      const targetWay = waypoints[currentWayIdx];
      const dx = targetWay.x - currX;
      const dy = targetWay.y - currY;
      const distToTarget = Math.hypot(dx, dy);

      if (distToTarget < stepDist || distToTarget === 0) {
        currX = targetWay.x;
        currY = targetWay.y;
        currentWayIdx++;
      } else {
        currX += (dx / distToTarget) * stepDist;
        currY += (dy / distToTarget) * stepDist;
        this.robotPose.theta = Math.atan2(dy, dx);
      }

      this.robotPose.x = parseFloat(currX.toFixed(2));
      this.robotPose.y = parseFloat(currY.toFixed(2));
      this.remainingWaypoints = waypoints.slice(currentWayIdx).map(w => ({ x: w.x, y: w.y }));

      if (this.battery > 5) {
        this.battery = Math.max(5, Math.round((this.battery - 0.02) * 10) / 10);
      }

      broadcastDashState();

      if (typeof this.onPoseUpdate === 'function') {
        try { this.onPoseUpdate(this); } catch (e) {}
      }

      this.broadcast({
        op: 'publish',
        topic: '/robot_pose',
        msg: { x: this.robotPose.x, y: this.robotPose.y, theta: this.robotPose.theta }
      });
    }, intervalMs);
  }

  cancelNavigation() {
    if (this.navTimer) {
      clearInterval(this.navTimer);
      this.navTimer = null;
    }
    this.isMoving = false;
    this.navStatus = 0;
    this.currentGoal = 'Idle';
    broadcastDashState();

    if (typeof this.onCancel === 'function') {
      try { this.onCancel(this); } catch (e) {}
    }

    this.broadcast({
      op: 'publish',
      topic: '/move_base/result',
      msg: { status: { status: 2 } }
    });
    logDashboard(`[NAV-${this.id.toUpperCase()}] Navigation cancelled`);
  }

  tick() {
    if (this.wsClients.size === 0) return;

    if (this.subscriptions.has('/robot_status')) {
      this.broadcast({
        op: 'publish',
        topic: '/robot_status',
        msg: {
          battery: parseFloat(this.battery),
          charger: parseInt(this.charger),
          velocity: this.isMoving ? [0.35, 0, 0] : [0, 0, 0],
          nav_status: this.navStatus,
          current_goal_name: this.currentGoal,
          last_poi: this.last_poi
        }
      });
    }

    if (this.subscriptions.has('/localization_confidence')) {
      this.broadcast({
        op: 'publish',
        topic: '/localization_confidence',
        msg: { data: 1.0 }
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Robot Simulation Registry & Map
// ─────────────────────────────────────────────────────────────────────────────
const robotInstances = new Map();
let currentDashboardRobotId = 'model01';

function getOrCreateRobotInstance(robotId) {
  if (!robotId) robotId = 'model01';
  const cleanId = robotId.trim();
  if (!robotInstances.has(cleanId)) {
    const robots = loadRobots();
    const existing = robots.find(r => r.id === cleanId);
    const inst = new RobotSimInstance(cleanId, existing || {});
    robotInstances.set(cleanId, inst);
  }
  return robotInstances.get(cleanId);
}

// Initialize standard fleet from file / defaults
const initialRobots = loadRobots();
if (initialRobots.length > 0) {
  initialRobots.forEach((r, idx) => {
    if (!r.pose) r.pose = getDefaultPoseForRobot(r.id, idx);
    robotInstances.set(r.id, new RobotSimInstance(r.id, r));
  });
} else {
  ['model01', 'model02', 'model03'].forEach((id, idx) => {
    robotInstances.set(id, new RobotSimInstance(id, { pose: getDefaultPoseForRobot(id, idx) }));
  });
}

function buildLiveRobotStatus(robotId = 'model01') {
  const inst = getOrCreateRobotInstance(robotId);
  const robots = loadRobots();
  let robot = robots.find(r => r.id === robotId) || { id: robotId, name: `Sadeem ${robotId.toUpperCase()}`, model: 'Sadeem AMR-V2' };

  let nearestMarker = 'Charging Dock';
  let minDist = Infinity;
  if (mapConfig.markers && mapConfig.markers.length > 0) {
    for (const m of mapConfig.markers) {
      const mx = m.pose?.position?.x ?? m.x ?? 0;
      const my = m.pose?.position?.y ?? m.y ?? 0;
      const d = Math.hypot(mx - inst.robotPose.x, my - inst.robotPose.y);
      if (d < minDist) {
        minDist = d;
        nearestMarker = m.name;
      }
    }
  }

  const isNav = inst.isMoving || inst.navStatus === 1;
  const statusStr = inst.charger === 1 ? 'charging' : (isNav ? 'navigating' : 'online');
  const batVal = typeof inst.battery === 'number' ? Math.round(inst.battery) : 85;
  const knownWaypoints = (mapConfig.markers || []).map(m => m.name);
  const homeMarker = (mapConfig.markers || []).find(m => m.behavior_code === 11 || m.name?.toLowerCase().includes('dock'))?.name || 'Charging Dock';

  return {
    success: true,
    robotId: inst.id,
    name: robot ? robot.name : `Sadeem ${inst.id.toUpperCase()}`,
    model: robot ? robot.model : 'Sadeem AMR-V2',
    status: statusStr,
    robot_connected: inst.wsClients.size > 0 ? 'connected' : 'disconnected',
    battery: batVal,
    battery_percent: String(batVal),
    charger: inst.charger,
    is_moving: inst.isMoving,
    nav_status: inst.navStatus,
    current_goal: inst.currentGoal || 'Idle',
    current_location: inst.last_poi || nearestMarker,
    nearest_location: nearestMarker,
    last_reached_waypoint: inst.last_poi || nearestMarker,
    pose: {
      x: parseFloat(inst.robotPose.x),
      y: parseFloat(inst.robotPose.y),
      theta: parseFloat(inst.robotPose.theta)
    },
    hard_estop: false,
    soft_estop: false,
    obstacle_region: 0,
    confidence: 1.0,
    known_waypoints: knownWaypoints,
    home_waypoint: homeMarker,
    active_mission: isNav ? `Moving to ${inst.currentGoal || nearestMarker}` : 'none',
    timestamp: Date.now()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Web Application & Multi-Port Environment Isolation
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

const MAIN_PORT = 3000;
const ROBOT_PORTS = [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];

const PORT_DEFAULT_ROBOTS = {
  3001: 'model01',
  3002: 'model02',
  3003: 'model03',
  3004: 'model04',
  3005: 'model05',
  3006: 'model06',
  3007: 'model07',
  3008: 'model08',
  3009: 'model09',
  3010: 'model10',
};

// Helper: Get dedicated ROS WS port for a robot (model01 -> 9091, model03 -> 9093, etc.)
function getRosPortForRobot(robotId) {
  const match = robotId.match(/\d+/);
  if (match) {
    const num = parseInt(match[0], 10);
    if (num >= 1 && num <= 20) {
      return 9090 + num;
    }
  }
  return 9090;
}

// CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Security & Health Check Middleware: Lock down public UI routes
app.use((req, res, next) => {
  // Allow health check endpoint for Render / Uptime monitors
  if (req.path === '/' || req.path === '/health' || req.path === '/ping') {
    return res.json({
      service: 'Helix AMR Headless Fleet Backend',
      status: 'ONLINE',
      activeRobots: ['model01', 'model02', 'model03'],
      mqtt: headlessMqttClient?.connected ? 'CONNECTED' : 'CONNECTING',
      uptime: Math.round(process.uptime()) + 's'
    });
  }

  // Block all public UI & dashboard access in production
  if (process.env.NODE_ENV === 'production' || process.env.RENDER || !req.ip?.includes('127.0.0.1')) {
    if (req.path.startsWith('/robot-ui') || req.path === '/setup' || req.path === '/demo-map' || req.path.startsWith('/public')) {
      return res.status(403).json({ error: 'Access Denied: Simulation UI is locked. Only Headless MQTT operation is enabled.' });
    }
  }

  next();
});

app.use(express.json());

// Simulator Ports & Topology API
app.get('/api/simulator/ports', (req, res) => {
  res.json({
    mainPort: MAIN_PORT,
    robotPorts: ROBOT_PORTS,
    portMapping: PORT_DEFAULT_ROBOTS
  });
});

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map-setup.html'));
});

app.get(['/demo-map', '/demo-map.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo-map.html'));
});

app.get('/map-image.jpeg', (req, res) => {
  const imgPath = path.join(__dirname, mapConfig.mapImageFile || "Hotel_layout_occupancy_grid_map_202607301416.jpeg");
  if (fs.existsSync(imgPath)) {
    res.sendFile(imgPath);
  } else {
    res.status(404).send('Map image not found');
  }
});

app.get('/api/map-config', (req, res) => {
  res.json(mapConfig);
});

app.post('/api/map-config', (req, res) => {
  const newCfg = req.body;
  if (newCfg && Array.isArray(newCfg.markers)) {
    saveMapConfig(newCfg);
    res.json({ success: true, message: 'Map configuration saved', config: mapConfig });
  } else {
    res.status(400).json({ error: 'Invalid config body' });
  }
});

// Navigation REST API
app.post('/api/navigate', (req, res) => {
  const target = req.body?.target || req.body?.poi || req.body?.waypoint;
  const robotId = req.body?.robotId || req.body?.id || 'model01';
  if (!target) return res.status(400).json({ error: 'No target specified' });
  
  const inst = getOrCreateRobotInstance(robotId);
  inst.startNavigationTo(target);
  logDashboard(`[API-${robotId.toUpperCase()}] Navigation to "${target}" requested via REST API`);
  res.json({ success: true, robotId, status: 'navigating', target, message: `Navigation of ${robotId} to ${target} started.` });
});

// Live Status REST API
app.get(['/api/robot-status', '/api/robots/status', '/api/robots/:id/status'], (req, res) => {
  const robotId = req.params.id || req.query.id || req.query.robot_id || 'model01';
  const statusObj = buildLiveRobotStatus(robotId);
  res.json(statusObj);
});

// Delivery Contacts API
app.get('/api/contacts', (req, res) => {
  const contacts = loadContacts();
  res.json({ success: true, contacts });
});

// Routines API
app.get('/api/routines', (req, res) => {
  const routines = loadRoutines();
  res.json({ success: true, routines });
});

app.post('/api/routines', (req, res) => {
  const routines = req.body?.routines;
  if (Array.isArray(routines)) {
    saveRoutines(routines);
    res.json({ success: true, routines });
  } else {
    res.status(400).json({ error: 'Invalid routines array' });
  }
});

// Auth Endpoints
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUser = username.trim().toLowerCase();
  const cleanPass = password.trim();

  // Super Admin
  if ((cleanUser === 'superadmin@sadeem.com' || cleanUser === 'superadmin') && cleanPass === 'admin123') {
    return res.json({
      success: true,
      role: 'superadmin',
      user: {
        id: 'user_superadmin_01',
        name: 'Sadeem Super Admin',
        email: 'superadmin@sadeem.com',
        roleTitle: 'Chief System Architect'
      },
      token: 'jwt_superadmin_' + Buffer.from(Date.now().toString()).toString('base64'),
      message: 'Super Admin authenticated successfully.'
    });
  }

  // Org Admin
  const orgs = loadOrganizations();
  const matchedOrg = orgs.find(o => 
    o.admin && o.admin.username && o.admin.username.toLowerCase() === cleanUser && o.admin.password === cleanPass
  );

  if (matchedOrg) {
    return res.json({
      success: true,
      role: 'org_admin',
      user: {
        id: `user_${matchedOrg.id}`,
        name: matchedOrg.admin.name || 'Organization Admin',
        email: matchedOrg.admin.username,
        roleTitle: `${matchedOrg.name} Administrator`
      },
      org: {
        id: matchedOrg.id,
        name: matchedOrg.name,
        slug: matchedOrg.slug,
        businessType: matchedOrg.businessType,
        logo: matchedOrg.logo,
        assignedRobots: matchedOrg.assignedRobots || [],
        facilityZones: matchedOrg.facilityZones || []
      },
      token: `jwt_org_${matchedOrg.id}_` + Buffer.from(Date.now().toString()).toString('base64'),
      message: `Authenticated as ${matchedOrg.name} Admin.`
    });
  }

  return res.status(401).json({
    error: 'Invalid credentials. Please verify your email and password.'
  });
});

app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing Bearer token' });
  }
  const token = authHeader.substring(7);
  if (token.includes('superadmin')) {
    return res.json({
      success: true,
      role: 'superadmin',
      user: { id: 'user_superadmin_01', name: 'Sadeem Super Admin', email: 'superadmin@sadeem.com' }
    });
  }
  if (token.includes('org_')) {
    const orgs = loadOrganizations();
    const orgIdPart = token.split('_')[2];
    const org = orgs.find(o => o.id.includes(orgIdPart) || o.id === orgIdPart);
    if (org) {
      return res.json({
        success: true,
        role: 'org_admin',
        user: { id: `user_${org.id}`, name: org.admin.name, email: org.admin.username },
        org: {
          id: org.id, name: org.name, slug: org.slug, businessType: org.businessType,
          logo: org.logo, assignedRobots: org.assignedRobots || []
        }
      });
    }
  }
  return res.status(401).json({ error: 'Session expired' });
});

// Organizations CRUD
app.get('/api/orgs', (req, res) => {
  const orgs = loadOrganizations();
  res.json({ success: true, count: orgs.length, orgs });
});

app.post('/api/orgs', (req, res) => {
  const { name, businessType, logo, admin, assignedRobots, facilityZones } = req.body || {};
  if (!name || !admin || !admin.username || !admin.password) {
    return res.status(400).json({ error: 'Organization name and admin credentials (username & password) are required.' });
  }

  const orgs = loadOrganizations();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const id = `org_${slug}_${Date.now().toString().slice(-4)}`;

  const newOrg = {
    id,
    name,
    slug,
    businessType: businessType || 'Enterprise Fleet',
    logo: logo || '🏢',
    status: 'ACTIVE',
    admin: {
      username: admin.username,
      name: admin.name || name + ' Admin',
      password: admin.password
    },
    assignedRobots: Array.isArray(assignedRobots) ? assignedRobots : [],
    facilityZones: Array.isArray(facilityZones) && facilityZones.length > 0 ? facilityZones : ["Reception", "Lobby", "Gate 1", "Gate 2", "Main kitchen", "Charging Dock"],
    createdAt: new Date().toISOString()
  };

  orgs.push(newOrg);
  saveOrganizations(orgs);

  if (newOrg.assignedRobots.length > 0) {
    const robots = loadRobots();
    robots.forEach(r => {
      if (newOrg.assignedRobots.includes(r.id)) {
        r.assignedOrgId = newOrg.id;
      }
    });
    saveRobots(robots);
  }

  logDashboard(`[SUPERADMIN] Created organization "${newOrg.name}" (${newOrg.id})`);
  res.status(201).json({ success: true, organization: newOrg });
});

app.put('/api/orgs/:id', (req, res) => {
  const { id } = req.params;
  const orgs = loadOrganizations();
  const idx = orgs.findIndex(o => o.id === id);
  if (idx < 0) return res.status(404).json({ error: `Organization "${id}" not found` });

  const existing = orgs[idx];
  const { name, businessType, logo, status, admin, assignedRobots, facilityZones } = req.body || {};

  const oldAssigned = existing.assignedRobots || [];
  const newAssigned = Array.isArray(assignedRobots) ? assignedRobots : oldAssigned;

  orgs[idx] = {
    ...existing,
    name: name || existing.name,
    businessType: businessType || existing.businessType,
    logo: logo || existing.logo,
    status: status || existing.status,
    admin: {
      username: admin?.username || existing.admin.username,
      name: admin?.name || existing.admin.name,
      password: admin?.password || existing.admin.password
    },
    assignedRobots: newAssigned,
    facilityZones: Array.isArray(facilityZones) ? facilityZones : existing.facilityZones,
    updatedAt: new Date().toISOString()
  };

  saveOrganizations(orgs);

  const robots = loadRobots();
  robots.forEach(r => {
    if (newAssigned.includes(r.id)) {
      r.assignedOrgId = id;
    } else if (oldAssigned.includes(r.id) && !newAssigned.includes(r.id)) {
      r.assignedOrgId = null;
    }
  });
  saveRobots(robots);

  logDashboard(`[SUPERADMIN] Updated organization "${orgs[idx].name}"`);
  res.json({ success: true, organization: orgs[idx] });
});

app.delete('/api/orgs/:id', (req, res) => {
  const { id } = req.params;
  let orgs = loadOrganizations();
  const target = orgs.find(o => o.id === id);
  if (!target) return res.status(404).json({ error: `Organization "${id}" not found` });

  const robots = loadRobots();
  robots.forEach(r => {
    if (r.assignedOrgId === id) r.assignedOrgId = null;
  });
  saveRobots(robots);

  orgs = orgs.filter(o => o.id !== id);
  saveOrganizations(orgs);

  logDashboard(`[SUPERADMIN] Deleted organization "${target.name}" (${id})`);
  res.json({ success: true, message: `Organization ${target.name} deleted and robots released to pool.` });
});

// Robots Registry API
app.get('/api/robots', (req, res) => {
  const { orgId, unassigned } = req.query;
  let robots = loadRobots();

  // Sync live telemetry from active robot instances
  robots = robots.map(r => {
    const inst = robotInstances.get(r.id);
    if (inst) {
      return {
        ...r,
        battery: Math.round(inst.battery),
        status: inst.charger === 1 ? 'charging' : (inst.isMoving ? 'navigating' : 'online'),
        currentLocation: inst.last_poi || r.currentLocation || 'Charging Dock',
        currentGoal: inst.currentGoal || 'Idle',
        pose: { x: inst.robotPose.x, y: inst.robotPose.y, theta: inst.robotPose.theta || 0 },
        lastSeen: new Date().toISOString()
      };
    }
    return r;
  });

  if (orgId) {
    robots = robots.filter(r => r.assignedOrgId === orgId);
  } else if (unassigned === 'true') {
    robots = robots.filter(r => !r.assignedOrgId);
  }
  res.json({ success: true, count: robots.length, robots });
});

app.post('/api/robots/assign', (req, res) => {
  const { robotId, orgId } = req.body || {};
  if (!robotId) return res.status(400).json({ error: 'robotId is required' });

  const robots = loadRobots();
  const robot = robots.find(r => r.id === robotId);
  if (!robot) return res.status(404).json({ error: `Robot "${robotId}" not found in registry.` });

  const previousOrgId = robot.assignedOrgId;
  robot.assignedOrgId = orgId || null;
  saveRobots(robots);

  const orgs = loadOrganizations();
  orgs.forEach(o => {
    if (o.id === orgId) {
      if (!o.assignedRobots) o.assignedRobots = [];
      if (!o.assignedRobots.includes(robotId)) o.assignedRobots.push(robotId);
    } else if (o.id === previousOrgId && previousOrgId !== orgId) {
      o.assignedRobots = (o.assignedRobots || []).filter(rid => rid !== robotId);
    }
  });
  saveOrganizations(orgs);

  logDashboard(`[FLEET] Assigned robot "${robotId}" to org "${orgId || 'Unassigned Pool'}"`);
  res.json({ success: true, robot, previousOrgId, currentOrgId: robot.assignedOrgId });
});

app.post('/api/robots/heartbeat', (req, res) => {
  const { robotId, name, model, status, battery, pose, currentLocation, currentGoal } = req.body || {};
  if (!robotId) return res.status(400).json({ error: 'robotId is required' });

  const robots = loadRobots();
  let robot = robots.find(r => r.id === robotId);

  if (!robot) {
    robot = {
      id: robotId,
      name: name || `Sadeem ${robotId}`,
      model: model || 'Sadeem AMR-V2',
      status: status || 'online',
      battery: typeof battery === 'number' ? battery : 100,
      currentLocation: currentLocation || 'Charging Dock',
      currentGoal: currentGoal || 'Idle',
      currentTask: null,
      assignedOrgId: null,
      ip: '127.0.0.1',
      wsUrl: `ws://localhost:${getRosPortForRobot(robotId)}`,
      pose: pose || getDefaultPoseForRobot(robotId),
      lastSeen: new Date().toISOString(),
      telemetry: { velocity: { linear: 0, angular: 0 }, charger: 0, navStatus: 0, confidence: 1 }
    };
    robots.push(robot);
  } else {
    if (status) robot.status = status;
    if (typeof battery === 'number') robot.battery = battery;
    if (pose) robot.pose = pose;
    if (currentLocation) robot.currentLocation = currentLocation;
    if (currentGoal) robot.currentGoal = currentGoal;
    robot.lastSeen = new Date().toISOString();
  }

  saveRobots(robots);
  const inst = getOrCreateRobotInstance(robotId);
  if (typeof battery === 'number') inst.battery = battery;
  if (pose) inst.robotPose = pose;

  res.json({ success: true, robot });
});

app.post('/api/fleet/command', (req, res) => {
  const { command, targets } = req.body || {};
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array is required' });
  }

  const results = [];
  targets.forEach(t => {
    const inst = getOrCreateRobotInstance(t.robotId);
    if (t.target) {
      inst.startNavigationTo(t.target);
      results.push({ robotId: t.robotId, status: 'dispatched', target: t.target });
    }
  });

  logDashboard(`[FLEET-CMD] Dispatched multi-robot command: ${results.map(r => `${r.robotId} -> ${r.target}`).join(', ')}`);
  res.json({ success: true, dispatchedCount: results.length, results });
});

app.post('/api/robots/:id/goal', (req, res) => {
  const { id } = req.params;
  const { target } = req.body || {};
  const inst = getOrCreateRobotInstance(id);
  if (target) {
    inst.startNavigationTo(target);
    return res.json({ success: true, robotId: id, target, status: 'navigating' });
  }
  res.status(400).json({ error: 'target waypoint required' });
});

app.post('/api/robots/:id/stop', (req, res) => {
  const { id } = req.params;
  const inst = getOrCreateRobotInstance(id);
  inst.cancelNavigation();
  res.json({ success: true, robotId: id, status: 'stopped' });
});

// Email dispatch API
app.post('/api/send-email', async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }
  logDashboard(`[EMAIL] Sent to ${to}: ${subject}`);
  return res.json({ success: true, provider: 'simulator_logger', message: `Email to ${to} sent successfully.` });
});

// ─────────────────────────────────────────────────────────────────────────────
// Serve Robot UI with Environment Isolation
// Injects dedicated ROS WS port (e.g. 9091 for model01, 9093 for model03)
// and preconfigures localStorage.macs_robot_id for that specific origin
// ─────────────────────────────────────────────────────────────────────────────
app.get('/robot-ui/*.html', (req, res, next) => {
  const fileBasename = req.params[0] + '.html';
  const filePath = path.join(__dirname, 'robot-ui', fileBasename);
  if (fs.existsSync(filePath)) {
    let html = fs.readFileSync(filePath, 'utf8');
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
    const httpPort = req.socket?.localPort || 3000;
    const defaultRobotId = (req.query.id || req.query.robot_id || PORT_DEFAULT_ROBOTS[httpPort] || 'model01').toString().trim();
    const rosPort = getRosPortForRobot(defaultRobotId);

    const injectScript = `<script>
      (function() {
        try {
          const targetRobotId = '${defaultRobotId}';
          localStorage.setItem('macs_robot_id', targetRobotId);
          const cfgKey = 'macs_config';
          let cfg = JSON.parse(localStorage.getItem(cfgKey) || '{}');
          cfg.robot_ws_url = 'ws://${host}:${rosPort}';
          localStorage.setItem(cfgKey, JSON.stringify(cfg));
          console.log('[Simulator Engine] Initialized isolated Robot UI for', targetRobotId, 'on UI Port', ${httpPort}, 'with ROS WS Port', ${rosPort});
          document.title = 'Robot UI - ' + targetRobotId + ' (Port ' + ${httpPort} + ')';
        } catch(e) {}
      })();
    </script>`;
    html = html.replace('<head>', '<head>\n    ' + injectScript);
    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  }
  next();
});
app.use('/robot-ui', express.static(path.join(__dirname, 'robot-ui')));

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard WebSocket Server
// ─────────────────────────────────────────────────────────────────────────────
const dashWss = new WebSocketServer({ noServer: true });
const DASH_CLIENTS = new Set();

dashWss.on('connection', (ws) => {
  DASH_CLIENTS.add(ws);
  sendDashStateToClient(ws);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'select_robot') {
        currentDashboardRobotId = data.robotId || 'model01';
        broadcastDashState();
      } else if (data.type === 'update_state') {
        const targetId = data.robotId || currentDashboardRobotId;
        const inst = getOrCreateRobotInstance(targetId);
        if (data.state) {
          if (typeof data.state.battery !== 'undefined') inst.battery = parseFloat(data.state.battery);
          if (typeof data.state.charger !== 'undefined') inst.charger = parseInt(data.state.charger);
          if (typeof data.state.isMoving !== 'undefined') inst.isMoving = !!data.state.isMoving;
          if (typeof data.state.speedScale !== 'undefined') inst.speedScale = parseInt(data.state.speedScale);
          if (data.state.robotPose) {
            inst.robotPose = {
              x: parseFloat(data.state.robotPose.x || 0),
              y: parseFloat(data.state.robotPose.y || 0),
              theta: parseFloat(data.state.robotPose.theta || 0)
            };
          }
        }
        broadcastDashState();
      } else if (data.type === 'trigger_nav_result') {
        const targetId = data.robotId || currentDashboardRobotId;
        const inst = getOrCreateRobotInstance(targetId);
        inst.broadcast({
          op: 'publish',
          topic: '/move_base/result',
          msg: { status: { status: data.status, text: 'Manual Trigger' } }
        });
        logDashboard(`[${targetId.toUpperCase()}] Triggered nav result: ${data.status}`);
      }
    } catch (e) {}
  });

  ws.on('close', () => DASH_CLIENTS.delete(ws));
});

function getDashStatePayload() {
  const robotsList = Array.from(robotInstances.values()).map(inst => ({
    id: inst.id,
    name: inst.name,
    battery: inst.battery,
    charger: inst.charger,
    robotPose: inst.robotPose,
    isMoving: inst.isMoving,
    navStatus: inst.navStatus,
    currentGoal: inst.currentGoal,
    last_poi: inst.last_poi,
    speedScale: inst.speedScale,
    connectedClients: inst.wsClients.size
  }));

  const activeInst = robotInstances.get(currentDashboardRobotId) || robotInstances.get('model01') || {
    id: 'model01', battery: 85, charger: 0, robotPose: { x: 19.9, y: 6.2, theta: 0 }, isMoving: false, speedScale: 15
  };

  return JSON.stringify({
    type: 'state',
    selectedRobotId: currentDashboardRobotId,
    robots: robotsList,
    state: {
      battery: activeInst.battery,
      charger: activeInst.charger,
      robotPose: activeInst.robotPose,
      isMoving: activeInst.isMoving,
      navStatus: activeInst.navStatus,
      currentGoal: activeInst.currentGoal,
      last_poi: activeInst.last_poi,
      speedScale: activeInst.speedScale
    }
  });
}

function sendDashStateToClient(ws) {
  if (ws.readyState === 1) ws.send(getDashStatePayload());
}

function broadcastDashState() {
  const payload = getDashStatePayload();
  DASH_CLIENTS.forEach(c => {
    if (c.readyState === 1) c.send(payload);
  });
}

const dashboardLogs = [];
function logDashboard(message, direction = 'local') {
  const log = { time: Date.now(), text: message, direction };
  dashboardLogs.unshift(log);
  if (dashboardLogs.length > 80) dashboardLogs.pop();
  const pkt = JSON.stringify({ type: 'log', log });
  DASH_CLIENTS.forEach(c => {
    if (c.readyState === 1) c.send(pkt);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-Robot ROSBridge WebSocket Connection Handler
// ─────────────────────────────────────────────────────────────────────────────
function handleRosClientConnection(ws, robotId = 'model01') {
  const inst = getOrCreateRobotInstance(robotId);
  inst.wsClients.add(ws);
  logDashboard(`[WS] Robot "${robotId}" connected to mock ROSBridge (Clients: ${inst.wsClients.size})`, 'client');
  broadcastDashState();

  ws.on('message', (message) => {
    try {
      const msgStr = message.toString();
      const req = JSON.parse(msgStr);
      logDashboard(`[${robotId.toUpperCase()}] UI -> ROS: ${msgStr}`, 'in');

      if (req.op === 'subscribe') {
        inst.subscriptions.add(req.topic);
        if (req.topic === '/map') broadcastMap(ws);
        if (req.topic === '/robot_status') {
          ws.send(JSON.stringify({
            op: 'publish',
            topic: '/robot_status',
            msg: {
              battery: parseFloat(inst.battery),
              charger: parseInt(inst.charger),
              velocity: inst.isMoving ? [0.35, 0, 0] : [0, 0, 0],
              nav_status: inst.navStatus,
              current_goal_name: inst.currentGoal,
              last_poi: inst.last_poi
            }
          }));
        }
        if (req.topic === '/robot_pose') {
          ws.send(JSON.stringify({
            op: 'publish',
            topic: '/robot_pose',
            msg: {
              x: parseFloat(inst.robotPose.x),
              y: parseFloat(inst.robotPose.y),
              theta: parseFloat(inst.robotPose.theta)
            }
          }));
        }
      }
      else if (req.op === 'call_service') {
        handleRosServiceCall(ws, req, inst);
      }
      else if (req.op === 'publish') {
        if (req.topic === '/request_robot_status') {
          inst.broadcast({
            op: 'publish',
            topic: '/robot_status',
            msg: {
              battery: parseFloat(inst.battery),
              charger: parseInt(inst.charger),
              velocity: inst.isMoving ? [0.35, 0, 0] : [0, 0, 0],
              nav_status: inst.navStatus,
              current_goal_name: inst.currentGoal,
              last_poi: inst.last_poi
            }
          });
        } else if (req.topic === '/robot_pose' && req.msg) {
          inst.robotPose = {
            x: parseFloat(req.msg.x || 0),
            y: parseFloat(req.msg.y || 0),
            theta: parseFloat(req.msg.theta || 0)
          };
          broadcastDashState();
        } else if (req.topic === '/move_base/cancel') {
          inst.cancelNavigation();
        }
      }
    } catch (e) {
      console.error(`Invalid JSON received on ROS WS for ${robotId}`, e);
    }
  });

  ws.on('close', () => {
    inst.wsClients.delete(ws);
    logDashboard(`[WS] Robot "${robotId}" disconnected from mock ROSBridge`, 'client');
    broadcastDashState();
  });
}

function handleRosServiceCall(ws, req, inst) {
  const svc = req.service;
  if (svc === '/marker_operation/get_markers') {
    ws.send(JSON.stringify({
      op: 'service_response',
      id: req.id,
      service: svc,
      values: { markers: { waypoints: mapConfig.markers } }
    }));
  } 
  else if (svc === '/virtual_wall_operation/get_walls') {
    ws.send(JSON.stringify({
      op: 'service_response', id: req.id, service: svc,
      values: { walls: [] }
    }));
  }
  else if (svc === '/poi') {
    const target = req.args?.poi || 'unknown';
    inst.startNavigationTo(target);
  }
  else if (svc === '/get_robot_status' || svc === '/status' || svc === '/request_robot_status') {
    const liveStatus = buildLiveRobotStatus(inst.id);
    ws.send(JSON.stringify({
      op: 'service_response',
      id: req.id,
      service: svc,
      values: liveStatus
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic Topic Ticker (Per-Robot Isolated Telemetry)
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  robotInstances.forEach((inst) => {
    inst.tick();
  });
}, 250);

// ─────────────────────────────────────────────────────────────────────────────
// Server Creation & Multi-Port Listeners
// ─────────────────────────────────────────────────────────────────────────────
const centralServer = http.createServer(app);

function attachWebSocketUpgrade(httpServer, defaultRobotId = null) {
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/dash') {
        dashWss.handleUpgrade(request, socket, head, (ws) => dashWss.emit('connection', ws, request));
      } else if (pathname === '/ws' || pathname === '/ros' || defaultRobotId) {
        // Upgrade to this robot's ROSBridge WebSocket
        const botId = defaultRobotId || url.searchParams.get('id') || 'model01';
        const wss = getOrCreateRosWssForRobot(botId);
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      } else {
        socket.destroy();
      }
    } catch(e) {
      socket.destroy();
    }
  });
}

attachWebSocketUpgrade(centralServer, null);

// ROSBridge WSS per Robot
const rosWssMap = new Map();
function getOrCreateRosWssForRobot(robotId) {
  if (!rosWssMap.has(robotId)) {
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws) => {
      handleRosClientConnection(ws, robotId);
    });
    rosWssMap.set(robotId, wss);
  }
  return rosWssMap.get(robotId);
}

// Central ROS server on 9090 (routes dynamically by URL path or query)
const rosServer9090 = http.createServer({}, (req, res) => res.end('ROS Bridge Simulator Hub'));
rosServer9090.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let botId = url.searchParams.get('id') || url.searchParams.get('robot_id');
    if (!botId) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0 && parts[0].startsWith('model')) {
        botId = parts[0];
      }
    }
    botId = botId || 'model01';
    const wss = getOrCreateRosWssForRobot(botId);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } catch (e) {
    socket.destroy();
  }
});

rosServer9090.listen(9090, '0.0.0.0', () => {
  console.log('[SIMULATOR] Central ROSBridge Mock WS listening on ws://0.0.0.0:9090');
});
rosServer9090.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') console.error('Error on ROS port 9090:', err.message);
});

// Dedicated ROSBridge Port Listeners (9091 = model01, 9092 = model02, 9093 = model03...)
for (let i = 1; i <= 10; i++) {
  const rosPort = 9090 + i;
  const botId = `model${String(i).padStart(2, '0')}`;
  try {
    const rRosServer = http.createServer({}, (req, res) => res.end(`ROS Bridge Simulator for ${botId}`));
    const wss = getOrCreateRosWssForRobot(botId);
    rRosServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    rRosServer.listen(rosPort, '0.0.0.0', () => {
      console.log(`[SIMULATOR] Dedicated ROSBridge WS for ${botId} listening on ws://0.0.0.0:${rosPort}`);
    });
    rRosServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') console.error(`Error on ROS port ${rosPort}:`, err.message);
    });
  } catch (e) {}
}

// Start Central Dashboard on 3000
centralServer.listen(MAIN_PORT, '0.0.0.0', () => {
  console.log(`[SIMULATOR] Central Control Dashboard active at http://0.0.0.0:${MAIN_PORT}`);
  console.log(`[SIMULATOR] Map & Pathway Setup UI at http://0.0.0.0:${MAIN_PORT}/setup`);
});
centralServer.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') console.error(`Error on central port ${MAIN_PORT}:`, err.message);
});

// Start Dedicated Isolated HTTP Servers (ports 3001-3010)
ROBOT_PORTS.forEach((port) => {
  try {
    const botId = PORT_DEFAULT_ROBOTS[port] || `model${String(port - 3000).padStart(2, '0')}`;
    const rServer = http.createServer(app);
    attachWebSocketUpgrade(rServer, botId);
    rServer.listen(port, '0.0.0.0', () => {
      console.log(`[ROBOT INSTANCE] ${botId} isolated UI active at http://0.0.0.0:${port} (-> /robot-ui/robot-ui.html?id=${botId})`);
    });
    rServer.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') console.error(`Error on port ${port}:`, err.message);
    });
  } catch (err) {
    console.error(`Failed to bind port ${port}:`, err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 24/7 Headless MQTT Fleet Worker (Zero Browser Tabs Required)
// Connects simulated robots directly to HiveMQ Cloud MQTT 24/7
// Handles real-time navigation, task queue execution, status telemetry & pings.
// ─────────────────────────────────────────────────────────────────────────────
let mqtt = null;
try {
  mqtt = require('mqtt');
} catch (e) {
  console.warn('[HEADLESS FLEET] mqtt module not found:', e.message);
}

let headlessMqttClient = null;
const activeTaskQueues = new Map();

function initHeadlessMqttFleet() {
  if (!mqtt) {
    console.warn('[HEADLESS FLEET] MQTT module unavailable, skipping headless MQTT worker.');
    return;
  }

  const MQTT_HOST = process.env.MQTT_HOST || 'wss://d0198e38be3049bd878bc42799f52885.s1.eu.hivemq.cloud:8884/mqtt';
  const MQTT_USER = process.env.MQTT_USER || 'hivemq.webclient.1773177445105';
  const MQTT_PASS = process.env.MQTT_PASS || '15apW02MK,%A*gOdy;Tw';

  console.log('[HEADLESS FLEET] Initializing 24/7 MQTT connection for fleet (model01, model02, model03)...');

  try {
    headlessMqttClient = mqtt.connect(MQTT_HOST, {
      username: MQTT_USER,
      password: MQTT_PASS,
      clientId: 'headless_fleet_' + Math.random().toString(36).substring(2, 9),
      keepalive: 30,
      reconnectPeriod: 3000,
      clean: true
    });
  } catch (e) {
    console.error('[HEADLESS FLEET] MQTT connect error:', e.message);
    return;
  }

  function safePublish(topic, payload, opts = { qos: 0 }) {
    if (headlessMqttClient && headlessMqttClient.connected) {
      try {
        const msgStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        headlessMqttClient.publish(topic, msgStr, opts);
      } catch (e) {
        console.warn('[HEADLESS FLEET] Publish error on topic', topic, e.message);
      }
    }
  }

  function publishRobotStatus(inst) {
    const statusObj = buildLiveRobotStatus(inst.id);
    const currLoc = inst.last_poi || statusObj.nearest_location || 'Charging Dock';
    const hb = {
      robot_id: inst.id,
      robotId: inst.id,
      status: inst.isMoving ? 'navigating' : 'online',
      battery: typeof inst.battery === 'number' ? Math.round(inst.battery) : 85,
      pose: {
        x: parseFloat(inst.robotPose.x),
        y: parseFloat(inst.robotPose.y),
        theta: parseFloat(inst.robotPose.theta)
      },
      currentLocation: currLoc,
      currentGoal: inst.currentGoal || 'Idle',
      isMoving: !!inst.isMoving,
      emergency_stop: false,
      rosLatencyMs: 0,
      timestamp: Date.now(),
      _senderId: 'headless_fleet_srv',
      _senderRobotId: inst.id,
      _ts: Date.now()
    };
    safePublish(`robot/${inst.id}/status`, hb);
    safePublish('robot/fleet/heartbeat', hb);
  }

  function publishTaskQueue(robotId) {
    const queue = activeTaskQueues.get(robotId) || [];
    safePublish(`robot/${robotId}/tasks/queue`, {
      robotId,
      tasks: queue,
      activeTaskId: queue.find(t => t.status === 'RUNNING')?.id || null,
      timestamp: Date.now(),
      _senderId: 'headless_fleet_srv'
    });
  }

  // Hook into RobotSimInstance lifecycle events
  robotInstances.forEach((inst) => {
    inst.onPoseUpdate = (r) => {
      const now = Date.now();
      if (!r._lastPoseMqttTime || now - r._lastPoseMqttTime >= 150) {
        r._lastPoseMqttTime = now;
        safePublish(`robot/${r.id}/bridge/response`, {
          op: 'publish',
          topic: '/robot_pose',
          msg: { x: r.robotPose.x, y: r.robotPose.y, theta: r.robotPose.theta },
          _senderId: 'headless_fleet_srv',
          _ts: now
        });
        safePublish(`robot/${r.id}/status`, {
          robot_id: r.id,
          robotId: r.id,
          status: 'navigating',
          battery: typeof r.battery === 'number' ? Math.round(r.battery) : 85,
          pose: { x: parseFloat(r.robotPose.x), y: parseFloat(r.robotPose.y), theta: parseFloat(r.robotPose.theta) },
          currentLocation: r.last_poi || 'En Route',
          currentGoal: r.currentGoal || 'Idle',
          isMoving: true,
          rosLatencyMs: 0,
          timestamp: now,
          _senderId: 'headless_fleet_srv',
          _ts: now
        });
      }
    };

    inst.onArrival = (r, targetName) => {
      safePublish(`robot/${r.id}/bridge/response`, {
        op: 'publish',
        topic: '/move_base/result',
        msg: { status: { status: 3 } },
        _senderId: 'headless_fleet_srv',
        _ts: Date.now()
      });
      publishRobotStatus(r);

      // Check multi-step task queue
      const queue = activeTaskQueues.get(r.id) || [];
      const currentTask = queue.find(t => t.status === 'RUNNING');
      if (currentTask) {
        currentTask.currentStepIndex = (currentTask.currentStepIndex || 0) + 1;
        if (currentTask.steps && currentTask.currentStepIndex < currentTask.steps.length) {
          const nextStep = currentTask.steps[currentTask.currentStepIndex];
          const nextTarget = nextStep.target || nextStep.location || nextStep.poi;
          if (nextTarget) {
            console.log(`[HEADLESS FLEET:${r.id}] Advancing to step ${currentTask.currentStepIndex + 1}/${currentTask.steps.length}: "${nextTarget}"`);
            setTimeout(() => {
              r.startNavigationTo(nextTarget);
              publishTaskQueue(r.id);
            }, 1200);
            return;
          }
        }
        currentTask.status = 'COMPLETED';
        currentTask.completedAt = Date.now();
        console.log(`[HEADLESS FLEET:${r.id}] Task "${currentTask.name || currentTask.id}" COMPLETED successfully!`);
        publishTaskQueue(r.id);

        // Auto-archive finished task from active queue after 2.5s
        setTimeout(() => {
          const q = activeTaskQueues.get(r.id) || [];
          const remaining = q.filter(t => t.id !== currentTask.id);
          activeTaskQueues.set(r.id, remaining);
          publishTaskQueue(r.id);
        }, 2500);
      }
    };

    inst.onCancel = (r) => {
      safePublish(`robot/${r.id}/bridge/response`, {
        op: 'publish',
        topic: '/move_base/result',
        msg: { status: { status: 2 } },
        _senderId: 'headless_fleet_srv',
        _senderRobotId: r.id,
        _ts: Date.now()
      });
      publishRobotStatus(r);
      const queue = activeTaskQueues.get(r.id) || [];
      const currentTask = queue.find(t => t.status === 'RUNNING');
      if (currentTask) {
        currentTask.status = 'CANCELLED';
        publishTaskQueue(r.id);
        setTimeout(() => {
          const q = activeTaskQueues.get(r.id) || [];
          const remaining = q.filter(t => t.id !== currentTask.id);
          activeTaskQueues.set(r.id, remaining);
          publishTaskQueue(r.id);
        }, 2500);
      }
    };
  });

  headlessMqttClient.on('connect', () => {
    console.log('✅ [HEADLESS FLEET] Connected to HiveMQ Cloud MQTT 24/7. Headless workers active for all robots.');

    const topics = [
      'robot/+/tasks/command',
      'robot/tasks/command',
      'robot/+/bridge/request',
      'robot/bridge/request',
      'robot/+/bridge/ping/req',
      'robot/bridge/ping/req',
      'robot/+/estop/command',
      'robot/estop/command',
      'robot/+/speed/command',
      'robot/speed/command',
      'robot/+/drive/cmd_vel',
      'robot/fleet/broadcast'
    ];
    headlessMqttClient.subscribe(topics, { qos: 0 }, (err) => {
      if (err) console.error('[HEADLESS FLEET] Subscribe error:', err.message);
      else console.log('[HEADLESS FLEET] Subscribed to fleet command topics');
    });

    // Initial broadcast of all robot statuses
    robotInstances.forEach((inst) => publishRobotStatus(inst));
  });

  headlessMqttClient.on('message', (topic, message) => {
    try {
      const payloadStr = message.toString();
      let p = null;
      try { p = JSON.parse(payloadStr); } catch (_) {}
      if (!p) return;

      // Ignore our own echo
      if (p._senderId && (p._senderId === 'headless_fleet_srv' || p._senderId.startsWith('headless_fleet_'))) {
        return;
      }

      // Determine target robot
      let targetRobotId = p.targetRobotId || p.robotId || p.robot_id;
      if (!targetRobotId && topic.includes('/')) {
        const parts = topic.split('/');
        if (parts.length >= 3 && parts[0] === 'robot' && parts[1].startsWith('model')) {
          targetRobotId = parts[1];
        }
      }
      if (!targetRobotId) targetRobotId = 'model01';

      const inst = getOrCreateRobotInstance(targetRobotId);

      // ── Diagnostic Ping Request ──
      if (topic === 'robot/bridge/ping/req' || topic === `robot/${targetRobotId}/bridge/ping/req`) {
        if (p.probeId) {
          const pong = JSON.stringify({
            probeId: p.probeId,
            sentAt: p.sentAt,
            receivedAt: Date.now(),
            rosLatencyMs: 0,
            robotId: targetRobotId,
            robot_id: targetRobotId,
            _senderId: 'headless_fleet_srv',
            _senderRobotId: targetRobotId
          });
          if (p.clientId) {
            safePublish(`robot/bridge/ping/res/${p.clientId}`, pong);
          }
          safePublish('robot/bridge/ping/res', pong);
        }
        return;
      }

      // ── Task Command ──
      if (topic.includes('/tasks/command') || topic === 'robot/fleet/broadcast') {
        const taskType = p.type || (p.action === 'cancel' ? 'CANCEL' : 'PLAN_AND_EXECUTE');

        if (taskType === 'CANCEL' || p.action === 'cancel') {
          console.log(`[HEADLESS FLEET:${targetRobotId}] Received CANCEL command.`);
          inst.cancelNavigation();
          return;
        }

        let targetMarker = null;
        let steps = [];

        if (p.steps && Array.isArray(p.steps) && p.steps.length > 0) {
          steps = p.steps;
          targetMarker = steps[0].target || steps[0].location || steps[0].poi || 'Reception';
        } else if (p.target || p.poi) {
          targetMarker = p.target || p.poi;
          steps = [{ type: 'navigate', target: targetMarker }];
        } else if (p.marker_name) {
          targetMarker = p.marker_name;
          steps = [{ type: 'navigate', target: targetMarker }];
        }

        if (targetMarker) {
          const taskObj = {
            id: p.id || `task_${Date.now()}`,
            name: p.mission_name || `Navigate to ${targetMarker}`,
            type: taskType,
            steps,
            currentStepIndex: 0,
            status: 'RUNNING',
            createdAt: Date.now()
          };

          const queue = activeTaskQueues.get(targetRobotId) || [];
          // Deduplicate tasks: ignore if this exact task id or duplicate name in last 2 seconds
          const isDuplicate = queue.some(t => t.id === taskObj.id || (t.status === 'RUNNING' && t.name === taskObj.name && (Date.now() - t.createdAt) < 2000));
          if (isDuplicate) {
            console.log(`[HEADLESS FLEET:${targetRobotId}] Ignoring duplicate task command "${taskObj.id}"`);
            return;
          }

          console.log(`[HEADLESS FLEET:${targetRobotId}] Executing Task "${taskObj.name}": Navigating to "${targetMarker}"`);
          queue.unshift(taskObj);
          if (queue.length > 20) queue.pop();
          activeTaskQueues.set(targetRobotId, queue);
          publishTaskQueue(targetRobotId);

          inst.startNavigationTo(targetMarker);
        }
        return;
      }

      // ── Estop Command ──
      if (topic.includes('/estop/command')) {
        if (p.stop) {
          console.log(`[HEADLESS FLEET:${targetRobotId}] ESTOP Activated!`);
          inst.cancelNavigation();
        } else {
          console.log(`[HEADLESS FLEET:${targetRobotId}] ESTOP Released.`);
        }
        publishRobotStatus(inst);
        return;
      }

      // ── Speed Command ──
      if (topic.includes('/speed/command')) {
        const spd = parseInt(p.speed) || 15;
        inst.speedScale = Math.max(1, Math.min(20, spd));
        console.log(`[HEADLESS FLEET:${targetRobotId}] Speed scale set to: ${inst.speedScale}`);
        return;
      }

      // ── ROSBridge Service Requests over MQTT ──
      if (topic.includes('/bridge/request')) {
        if (p.op === 'call_service') {
          if (p.service === '/get_robot_status' || p.service === '/status' || p.service === '/request_robot_status') {
            const liveStatus = buildLiveRobotStatus(inst.id);
            safePublish(`robot/${inst.id}/bridge/response`, {
              op: 'service_response',
              id: p.id,
              service: p.service,
              values: liveStatus,
              result: true,
              _senderId: 'headless_fleet_srv',
              _ts: Date.now()
            });
            publishRobotStatus(inst);
          } else if (p.service === '/marker_operation/get_markers') {
            const allWps = (mapConfig.markers || []).map(m => ({
              name: m.name,
              behavior_code: m.behavior_code ?? 0,
              pose: m.pose || { position: { x: m.x ?? 0, y: m.y ?? 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
            }));
            safePublish(`robot/${inst.id}/bridge/response`, {
              op: 'service_response',
              id: p.id,
              service: '/marker_operation/get_markers',
              values: { markers: { waypoints: allWps } },
              result: true,
              _senderId: 'headless_fleet_srv',
              _ts: Date.now()
            });
          } else if (p.service === '/poi' && p.args?.poi) {
            console.log(`[HEADLESS FLEET:${targetRobotId}] /poi service requested navigation to "${p.args.poi}"`);
            inst.startNavigationTo(p.args.poi);
            safePublish(`robot/${inst.id}/bridge/response`, {
              op: 'service_response',
              id: p.id,
              service: '/poi',
              values: { success: true },
              result: true,
              _senderId: 'headless_fleet_srv',
              _ts: Date.now()
            });
          }
        }
      }
    } catch (err) {
      console.warn('[HEADLESS FLEET] Error processing message:', err.message);
    }
  });

  // Periodic Heartbeat Interval (Every 4 seconds)
  setInterval(() => {
    robotInstances.forEach((inst) => {
      publishRobotStatus(inst);
    });
  }, 4000);
}

// Start Headless 24/7 MQTT Fleet Worker automatically
initHeadlessMqttFleet();

