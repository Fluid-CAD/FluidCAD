# FluidCAD Server

Node.js server that bridges the editor extension (VSCode/Neovim) with the 3D viewer UI. It exposes an HTTP REST API, a WebSocket connection for real-time scene updates, and communicates with the extension host via Node.js IPC.

## Architecture

```
Extension (VSCode/Neovim) --IPC--> Server --WebSocket--> UI (3D viewer)
                                     |
                                  REST API
                                  (used by UI)
```

The server uses [Vite](https://vitejs.dev/) internally to resolve and execute user CAD scripts, manage module hot-reloading, and support live code updates.

## Configuration

| Environment Variable       | Default | Description                        |
| -------------------------- | ------- | ---------------------------------- |
| `FLUIDCAD_SERVER_PORT`     | `3100`  | HTTP & WebSocket port              |
| `FLUIDCAD_WORKSPACE_PATH`  | `""`    | Root path of the user's workspace  |

## Starting the Server

The server is normally spawned as a child process by the editor extension (with IPC enabled). It can also be started directly:

```bash
cd server
npx tsx src/index.ts
```

On startup it:
1. Starts an Express HTTP server on the configured port.
2. Serves the UI static build from `../ui/dist`.
3. Opens a WebSocket server on the same port.
4. Initializes the CAD engine via the workspace's `init.js` file.
5. Sends `ready` and `init-complete` messages back to the extension over IPC.

## REST API

All endpoints are prefixed with `/api`.

### Properties

#### `GET /api/materials`

Returns the list of available materials.

**Response:** `200` with JSON array of materials.

---

#### `GET /api/shape-properties`

Returns geometric properties of a shape.

| Query Param | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| `shapeId`   | string | yes      | Shape ID    |

**Response:** `200` with shape properties JSON, or `404` if not found.

---

#### `GET /api/face-properties`

Returns properties of a specific face on a shape.

| Query Param | Type   | Required | Description        |
| ----------- | ------ | -------- | ------------------ |
| `shapeId`   | string | yes      | Shape ID           |
| `faceIndex` | number | yes      | Zero-based index   |

**Response:** `200` with face properties JSON, `400` on invalid params, or `404` if not found.

---

#### `GET /api/edge-properties`

Returns properties of a specific edge on a shape.

| Query Param | Type   | Required | Description        |
| ----------- | ------ | -------- | ------------------ |
| `shapeId`   | string | yes      | Shape ID           |
| `edgeIndex` | number | yes      | Zero-based index   |

**Response:** `200` with edge properties JSON, `400` on invalid params, or `404` if not found.

### Actions

#### `POST /api/hit-test`

Performs a ray-cast hit test against a shape to determine which face/edge was clicked.

**Request body:**

```json
{
  "shapeId": "string",
  "rayOrigin": [0, 0, 0],
  "rayDir": [0, 0, -1],
  "edgeThreshold": 0.01
}
```

**Response:** `200` with hit test result JSON, or `400` on invalid body.

---

#### `POST /api/insert-point`

Forwards an insert-point command to the extension, which inserts a point into the source code.

**Request body:**

```json
{
  "point": [10, 20],
  "sourceLocation": { "line": 5, "column": 12 }
}
```

**Response:** `200 { "success": true }` or `400` on invalid body.

---

#### `POST /api/remove-point`

Forwards a remove-point command to the extension, which removes a point from the source code.

**Request body:**

```json
{
  "point": [10, 20],
  "sourceLocation": { "line": 5, "column": 12 }
}
```

**Response:** `200 { "success": true }` or `400` on invalid body.

---

#### `POST /api/set-pick-points`

Forwards a batch of pick points to the extension for source code insertion.

**Request body:**

```json
{
  "points": [[10, 20], [30, 40]],
  "sourceLocation": { "line": 5, "column": 12 }
}
```

**Response:** `200 { "success": true }` or `400` on invalid body.

---

#### `POST /api/rollback`

Rolls the scene back to a specific object index (undo step).

**Request body:**

```json
{
  "index": 3
}
```

**Response:** `200 { "success": true }`, `400` on invalid index, or `404` if no active scene.

---

#### `POST /api/import-file`

Imports a CAD file (e.g. STEP/STP) into the workspace.

**Request body:**

```json
{
  "fileName": "part.step",
  "data": "<base64-encoded file contents>"
}
```

**Response:** `200 { "success": true, "fileName": "part" }` or `500` on error.

### Export

#### `POST /api/export`

Exports selected shapes as a STEP or STL file download.

**Request body:**

```json
{
  "format": "step",
  "shapeIds": ["shape-1", "shape-2"],
  "includeColors": true,
  "resolution": "medium",
  "customLinearDeflection": 0.1,
  "customAngularDeflectionDeg": 30
}
```

| Field                        | Type     | Required | Description                                                 |
| ---------------------------- | -------- | -------- | ----------------------------------------------------------- |
| `format`                     | string   | yes      | `"step"` or `"stl"`                                         |
| `shapeIds`                   | string[] | yes      | Non-empty array of shape IDs to export                      |
| `includeColors`              | boolean  | no       | Include color data in export                                |
| `resolution`                 | string   | no       | STL only: `"coarse"`, `"medium"`, `"fine"`, or `"custom"`   |
| `customLinearDeflection`     | number   | no       | Required when resolution is `"custom"`                      |
| `customAngularDeflectionDeg` | number   | no       | Required when resolution is `"custom"`                      |

**Response:** Binary file download with appropriate `Content-Type`, `400` on invalid params, or `404` if no active scene.

### Screenshot

#### `POST /api/screenshot`

Captures a PNG screenshot of the current 3D scene from the connected UI client.

**Request body (all fields optional):**

```json
{
  "width": 1920,
  "height": 1080,
  "showGrid": false,
  "showAxes": false,
  "transparent": true,
  "autoCrop": true,
  "margin": 20
}
```

| Field         | Type    | Default   | Description                              |
| ------------- | ------- | --------- | ---------------------------------------- |
| `width`       | number  | viewport  | Output width in pixels (1-8192)          |
| `height`      | number  | viewport  | Output height in pixels (1-8192)         |
| `showGrid`    | boolean | viewport  | Show the grid in the screenshot          |
| `showAxes`    | boolean | viewport  | Show the axes in the screenshot          |
| `transparent` | boolean | viewport  | Use a transparent background             |
| `autoCrop`    | boolean | viewport  | Auto-crop whitespace around the scene    |
| `margin`      | number  | viewport  | Margin in pixels (used with `autoCrop`)  |

**Response:** PNG image (`Content-Type: image/png`), `400` on invalid params, `503` if no UI client is connected or the request times out.

## WebSocket Protocol

The server accepts WebSocket connections on the same port as HTTP. Connected UI clients receive real-time messages:

| Message Type           | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `init-complete`        | CAD engine initialization result                 |
| `processing-file`      | A file is being processed                        |
| `scene-rendered`       | Scene render complete, contains mesh data        |
| `highlight-shape`      | Highlight a shape in the viewer                  |
| `clear-highlight`      | Clear all shape highlights                       |
| `show-shape-properties`| Open the properties panel for a shape            |
| `take-screenshot`      | Request the UI to capture a screenshot           |

On new connections, the server replays the last `init-complete` and `scene-rendered` messages so the UI can immediately display the current state.

The UI can send messages back to the server:

| Message Type         | Description                                         |
| -------------------- | --------------------------------------------------- |
| `screenshot-result`  | Response to a `take-screenshot` request (base64 PNG)|

## IPC Protocol (Extension <-> Server)

The server communicates with the editor extension via Node.js IPC (`process.send` / `process.on('message')`).

### Extension -> Server

| Message Type           | Description                                  |
| ---------------------- | -------------------------------------------- |
| `process-file`         | Process and render a CAD file                |
| `live-update`          | Live-update with in-memory code changes      |
| `rollback`             | Roll back the scene to a specific index      |
| `import-file`          | Import a CAD file (base64 data)              |
| `highlight-shape`      | Highlight a shape in the UI                  |
| `clear-highlight`      | Clear UI highlights                          |
| `show-shape-properties`| Show properties panel for a shape in the UI  |
| `export-scene`         | Export shapes to STEP/STL                    |

### Server -> Extension

| Message Type       | Description                                      |
| ------------------ | ------------------------------------------------ |
| `ready`            | Server is listening (includes port and URL)       |
| `init-complete`    | CAD engine initialized (success/error)            |
| `scene-rendered`   | Scene render result with mesh data                |
| `error`            | Error message                                     |
| `import-complete`  | File import result                                |
| `insert-point`     | Request to insert a point in source code          |
| `remove-point`     | Request to remove a point from source code        |
| `set-pick-points`  | Request to set pick points in source code         |
| `export-complete`  | Export result (base64 data or error)              |
