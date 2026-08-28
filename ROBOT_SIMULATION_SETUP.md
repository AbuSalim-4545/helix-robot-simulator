# Robot UI Simulation Setup

## Overview
This PC acts as the simulated robot chassis and central hub. `server.js` hosts:
1. **ROSBridge Mock WebSocket Server** on `ws://0.0.0.0:9090`
2. **Central Simulation Dashboard** on `http://localhost:3000`
3. **Environment-Isolated Robot UIs** on dedicated ports (`:3001`, `:3002`, `:3003`...)

---

## Multi-Robot Port Isolation Architecture
To test multiple robots simultaneously without cross-talk or localStorage collision, each robot runs on a dedicated origin:

| Robot | Dedicated Port | URL | Topic Namespace |
|---|---|---|---|
| **Model 01** | `3001` | `http://localhost:3001` | `robot/model01/*` |
| **Model 02** | `3002` | `http://localhost:3002` | `robot/model02/*` |
| **Model 03** | `3003` | `http://localhost:3003` | `robot/model03/*` |
| **Model 04-10** | `3004–3010` | `http://localhost:<PORT>` | `robot/model<XX>/*` |

> 💡 **Why Separate Ports?**  
> Browsers isolate `localStorage`, session storage, and cookies per **origin (`protocol + host + port`)**. Having dedicated ports guarantees that testing `model01` and `model03` concurrently in different tabs or windows will never overwrite each other's configuration or cache.

---

## Quick Start

### 1. Start the Simulator Server
```powershell
cd c:\Users\sam\Desktop\helix-amr-control-main\helix-amr-control-main\robot-simulator
node server.js
```

Expected output:
```text
[SIMULATOR] ROSBridge Mock WS listening on ws://0.0.0.0:9090
[SIMULATOR] Central Control Dashboard active at http://0.0.0.0:3000
[ROBOT INSTANCE] model01 isolated UI active at http://0.0.0.0:3001 (-> /robot-ui/robot-ui.html?id=model01)
[ROBOT INSTANCE] model02 isolated UI active at http://0.0.0.0:3002 (-> /robot-ui/robot-ui.html?id=model02)
[ROBOT INSTANCE] model03 isolated UI active at http://0.0.0.0:3003 (-> /robot-ui/robot-ui.html?id=model03)
[ROBOT INSTANCE] model04 isolated UI active at http://0.0.0.0:3004 (-> /robot-ui/robot-ui.html?id=model04)
```

---

### 2. Launch Robot UIs
Open the Central Dashboard at:
👉 **`http://localhost:3000`**

From the dashboard, click any of the **Quick Launch buttons**:
- 🚀 **Open Model 01 UI** (opens `http://localhost:3001`)
- 🚀 **Open Model 02 UI** (opens `http://localhost:3002`)
- 🚀 **Open Model 03 UI** (opens `http://localhost:3003`)
- Or enter a custom robot ID and select a port (3004–3010)

---

### 3. Verify Connection
- Robot UI status indicator shows **CONNECTED** for Robot WS and Cloud Sync.
- Tab title displays `Robot UI - model0X (Port 300X)`.
- Simulator logs in the Dashboard show incoming telemetry and navigation queries in real-time.
