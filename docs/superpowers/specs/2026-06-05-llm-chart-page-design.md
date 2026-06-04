# LLM Value Chart Page

## Purpose
Add a page showing a line chart of LLM analysis values over time per coin, so the user can visually track how the bot's conviction changes over time.

## Architecture

### Backend: `GET /api/chart`
- Queries all `decisions` rows ordered by `created_at ASC`
- Computes a `value` for each row: `confidence × direction` (BUY=+1, SELL=-1, HOLD=0)
- Returns `Array<{ coin, action, confidence, value, created_at }>`
- No pagination needed — the decisions table grows slowly

### Frontend: `Charts.tsx` page
- Uses `recharts` (already installed)
- `useEffect` fetches `/api/chart` on mount
- Groups data by `coin`, each coin gets a `Line` in a `<LineChart>`
- Coins mapped to distinct colors from a fixed palette
- X-axis: `created_at` as short date string
- Y-axis: domain -1 to +1, with a dashed zero-reference line
- Tooltip shows coin, action, confidence, value on hover
- Legend for coin colors
- New "Charts" tab in `App.tsx` navigation

## Files Changed
| File | Change |
|------|--------|
| `backend/src/api/routes.ts` | Add `GET /api/chart` route |
| `frontend/src/pages/Charts.tsx` | New file — chart page component |
| `frontend/src/App.tsx` | Add "Charts" tab, import & render page |
