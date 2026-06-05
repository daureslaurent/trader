# Task 7: Add Risk Management Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add risk management configuration fields to the backend types, frontend types, and Settings page.

**Architecture:** 
- Backend: Add risk fields to `BotSettings` interface in `backend/src/types.ts`
- Frontend: Add risk fields to `Settings` interface in `frontend/src/pages/Settings.tsx` (frontend has its own inline interface)
- Frontend UI: Add a new "Risk Management" section to the Settings form with four number inputs

**Tech Stack:** TypeScript, React, Tailwind CSS, SQLite

---

## File Structure

| File | Action | Lines | Responsibility |
|------|--------|-------|----------------|
| `backend/src/types.ts` | Modify | +5 | Add risk fields to `BotSettings` interface |
| `frontend/src/pages/Settings.tsx` | Modify | +20 | Add Risk Management section with four inputs |

---

## Task 1: Update Backend Types

**Files:**
- Modify: `backend/src/types.ts:42-48` (`BotSettings` interface)

- [ ] **Step 1: Add risk fields to BotSettings interface**

```typescript
export interface BotSettings {
  watchlist: string[]
  interval_minutes: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number           // NEW
  take_profit_atr: number         // NEW
  max_risk_per_trade: number      // NEW
  max_open_positions: number      // NEW
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/types.ts
git commit -m "feat: add risk management fields to BotSettings"
```

---

## Task 2: Update Frontend Types and UI

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:3-9` (`Settings` interface)
- Modify: `frontend/src/pages/Settings.tsx:32-65` (Settings form)

- [ ] **Step 1: Add risk fields to Settings interface**

```typescript
interface Settings {
  watchlist: string[]
  interval_minutes: number
  min_confidence: number
  max_position_size_usd: number
  approval_required: boolean
  stop_loss_atr: number
  take_profit_atr: number
  max_risk_per_trade: number
  max_open_positions: number
}
```

- [ ] **Step 2: Add Risk Management section to the form**

Insert after the "Approval required" checkbox (line 60), before the submit button (line 61):

```tsx
<div className="space-y-3">
  <div>
    <label className="block text-sm text-gray-400 mb-1">Stop Loss ATR</label>
    <input type="number" step="0.1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.stop_loss_atr} onChange={(e) => setSettings({ ...settings, stop_loss_atr: parseFloat(e.target.value) })} />
  </div>
  <div>
    <label className="block text-sm text-gray-400 mb-1">Take Profit ATR</label>
    <input type="number" step="0.1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.take_profit_atr} onChange={(e) => setSettings({ ...settings, take_profit_atr: parseFloat(e.target.value) })} />
  </div>
  <div>
    <label className="block text-sm text-gray-400 mb-1">Max Risk Per Trade (%)</label>
    <input type="number" step="0.01" min="0" max="1" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.max_risk_per_trade} onChange={(e) => setSettings({ ...settings, max_risk_per_trade: parseFloat(e.target.value) })} />
  </div>
  <div>
    <label className="block text-sm text-gray-400 mb-1">Max Open Positions</label>
    <input type="number" step="1" min="0" className="w-full bg-gray-800 rounded px-3 py-2 text-sm" value={settings.max_open_positions} onChange={(e) => setSettings({ ...settings, max_open_positions: parseInt(e.target.value) })} />
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat: add risk management settings to frontend"
```

---

## Task 3: Run Type Check

- [ ] **Step 1: Run typecheck**

```bash
cd /home/dauresl/cryptoBot && npm run typecheck
```

Expected: No errors

---

## Task 4: Run Lint

- [ ] **Step 1: Run lint**

```bash
cd /home/dauresl/cryptoBot && npm run lint
```

Expected: No errors

---

## Task 5: Final Commit

- [ ] **Step 1: Review changes**

```bash
git status
git diff
```

- [ ] **Step 2: Commit**

```bash
git add .
git commit -m "feat: add risk management settings to frontend"
```

---

## Test Plan

- **Unit tests:** N/A (UI component, no backend integration required)
- **Integration tests:** N/A
- **Manual testing:** 
  - Open the Settings page
  - Verify four new inputs appear under a "Risk Management" heading
  - Verify inputs have correct step sizes (0.1, 0.01, 1)
  - Verify Tailwind styling matches existing sections (bg-gray-800, rounded, px-3 py-2, text-sm)
  - Verify values update in state on change

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Backend types updated with risk fields
- [x] Frontend types updated with risk fields  
- [x] Settings page updated with Risk Management section
- [x] Four fields implemented: stop_loss_atr, take_profit_atr, max_risk_per_trade, max_open_positions
- [x] Correct step sizes: 0.1 (ATR), 0.01 (risk), 1 (positions)
- [x] Correct defaults mentioned in spec (not hardcoded in UI — frontend doesn't have defaults for new fields since it's just adding the UI)
- [x] Styling matches existing sections (Tailwind classes verified)

**2. Placeholder scan:** None found

**3. Type consistency:** All types are `number`, matching the backend `RiskConfig` interface

**Execution options:**

**1. Subagent-Driven** - Dispatch a subagent per task (recommended)

**2. Inline Execution** - Execute all tasks in this session

Which approach?
