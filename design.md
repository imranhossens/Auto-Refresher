# Design System & UI Preferences Guidelines

This document outlines the technical design system, visual aesthetics, icon specifications, color palettes, and micro-animations for the **Auto Refresher & Tab Reload** extension and dashboard.

---

## 1. Visual Aesthetics & Theme Philosophy

- **Aesthetic**: Modern Dark Glassmorphism with Vibrant Cyberpunk / Neon Accents.
- **Background Gradient**: Radial gradient `radial-gradient(circle at 50% 0%, #15092d 0%, #0a0316 100%)` with subtle background grid pattern.
- **Glass Containers**: `rgba(255, 255, 255, 0.03)` with `backdrop-filter: blur(16px)` and translucent borders `rgba(255, 255, 255, 0.08)`.
- **Typography**: Primary font `'Outfit', sans-serif` from Google Fonts. Clean letter spacing, uppercase section headers (`11px`, `font-weight: 600`, `letter-spacing: 0.5px`).

---

## 2. Icon System & Standards

All icons are SVG vector elements styled consistently with crisp 2-pixel strokes (`stroke-width="2"` or `2.5"`), `stroke-linecap="round"`, and `stroke-linejoin="round"`.

### A. Delete Icon (Icon-Only Action Button)
- **SVG Spec**: Trash bin vector path.
  ```html
  <svg class="svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>
  ```
- **Styling**:
  - Class: `.btn-icon-action.btn-icon-danger` or `.icon-action-btn.danger`
  - Text/Stroke Color: `#ff334b` or `var(--danger-color)`
  - Background: `rgba(255, 51, 75, 0.08)`
  - Border: `1px solid rgba(255, 51, 75, 0.25)`
- **Hover / Active State**:
  - Background: `rgba(255, 51, 75, 0.22)`
  - Box Shadow: `0 0 10px rgba(255, 51, 75, 0.35)`
  - Transform: `scale(1.08)` or `translateY(-1px)`

### B. Edit Icon (Icon-Only Action Button)
- **SVG Spec**: Pencil / edit path.
  ```html
  <svg class="svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>
  ```
- **Styling**:
  - Class: `.btn-icon-action.btn-icon-edit` or `.btn-options-edit-group`
  - Stroke Color: `var(--text-secondary)` or `#00F0FF` on hover
  - Background: `rgba(255, 255, 255, 0.04)`
  - Border: `1px solid rgba(255, 255, 255, 0.08)`
- **Hover State**:
  - Background: `rgba(0, 240, 255, 0.15)`
  - Stroke Color: `#ffffff`
  - Box Shadow: `0 0 8px rgba(0, 240, 255, 0.3)`

### C. Gear / Settings Icon
- **SVG Spec**: Gear wheel vector.
  ```html
  <svg class="gear-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
  ```
- **Behavior**: Clicking redirects directly to Options Central Dashboard (`chrome.runtime.openOptionsPage()`).

### D. Chevron / Expander Icon
- **SVG Spec**: Chevron polyline `6 9 12 15 18 9`.
- **Behavior**: Smooth 180° rotation on expansion (`.expanded .chevron-icon { transform: rotate(180deg); }`).

---

## 3. Color System & Swatches

### Preset Color Swatches
To prevent browser user-agent button skins (`appearance: auto`) from overriding custom background colors with solid white circles:
1. Always apply `appearance: none; -webkit-appearance: none;`.
2. Map explicit attribute rules `.color-swatch[data-color="<HEX>"] { background-color: <HEX> !important; }`.

**Current Standard Palette**:
- Classic Blue: `#3b82f6`
- Emerald Green: `#10b981`
- Amber Gold: `#f59e0b`
- Crimson Red: `#ef4444`
- Royal Purple: `#8b5cf6`
- Electric Cyan: `#00F0FF`
- Hot Pink: `#ff007f`
- Sunset Coral: `#ff5722`
- Teal Aqua: `#14b8a6`
- Bright Gold: `#eab308`

**Active State**:
- Border: `2px solid #ffffff !important`
- Transform: `scale(1.25)`
- Box Shadow: `0 0 8px rgba(255, 255, 255, 0.8)`

### Custom Color Picker Popover
- Trigger: Palette Icon Button (`.color-picker-btn`) with multi-color gradient background.
- Popover Card: Glassmorphic popover panel with format selector tabs (`HEX` default, `RGB`, `HSL`), text input parsing, visual color preview badge dot, and hidden color wheel picker.

---

## 4. Micro-Animations & Interactivity

- **Button Hover Effect**:
  - `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)`
  - Glow on hover using glowing box-shadow (`box-shadow: 0 0 12px rgba(0, 240, 255, 0.3)`).
- **Expand / Collapse Panels**:
  - Soft fade-in animation: `@keyframes tab-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`
- **Feedback States**:
  - Action success buttons temporarily swap text to `✓ Added!` with green text (`#2ed573`) for 1000ms.

---

## 5. Cards & Section Layout Guidelines

- **Dashboard Layout**: 2-column responsive grid layout.
  - **Upper Right Side**: Link Groups Central Dashboard (`#groups-dashboard-section`).
  - **Upper Left Side**: Global Settings.
  - **Row 2**: Target Reload Links Manager & Active Auto-Reload Dashboard.
  - **Row 3**: Full-width Keyboard Shortcuts card (`span-two`).
