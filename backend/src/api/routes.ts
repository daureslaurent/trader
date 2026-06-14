// The API surface now lives in ./routes/, split into per-domain sub-routers.
// This barrel preserves the original import path (`./routes.js`).
export { router } from './routes/index.js'
