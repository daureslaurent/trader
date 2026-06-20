// Authentication gateway — guards the API and WebSocket behind a login.
// Public API (per the "every module exposes its API via index.ts" convention).
export { getAuthState, refreshAuthState, type AuthState } from './config.js'
export { requireAuth, extractBearer } from './middleware.js'
export { isWsRequestAuthorized } from './ws.js'
export { authRouter } from './routes.js'
export { hashPassword, verifyPassword } from './password.js'
export { signToken, verifyToken, type TokenClaims } from './token.js'
