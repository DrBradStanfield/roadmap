# Health Roadmap Design System

A reference for AI agents generating UI for this project. All new components must match these patterns.

---

## 1. Visual Theme & Atmosphere

Health Roadmap is a clinical-grade health tool embedded in a Shopify storefront. The design language is clean, trustworthy, and medically neutral — it should feel like a well-designed patient portal, not a wellness app. Warm but not playful. Authoritative but not intimidating.

The palette is built on near-white backgrounds (`#fff`, `#f8f9fa`) with a teal brand accent (`#00a38b`) that signals health without the cold sterility of blue-only medical interfaces. A second blue (`#0066cc`) is reserved for primary CTAs. Typography uses the system font stack for instant legibility and zero layout shift. Borders are restrained (`1px solid #ddd`); elevation comes from subtle one-layer shadows rather than heavy drop shadows.

**Key Characteristics:**
- System font stack — no custom fonts, maximum legibility, zero flash
- Teal brand accent (`#00a38b`) for focus states, active elements, section highlights
- Blue primary action (`#0066cc`) for buttons and links
- Cards: white on light-gray page background, 12px radius, soft shadow
- Inputs: 8px radius, 1px `#ddd` border, brand-colored focus ring
- Mobile-first at 768px breakpoint — tab bar, single column, sticky "View Plan" CTA
- All interactive states use brand or primary color — no gray hover states on CTAs

---

## 2. Color Palette & Roles

### Primary
- **Brand Teal** (`#00a38b`): Primary CTA buttons (`.btn-primary`), focus rings, active tabs, toggle selections, unit toggle pills, guest CTA banner, supplement highlights. The health identity color.
- **Brand Teal Hover** (`#008f7a`): Hover state for teal buttons and elements.
- **Primary Blue** (`#0066cc`): `info`-tier suggestion group titles and badges. Not used for buttons.
- **Primary Blue Hover** (`#0052a3`): Hover state for blue elements.

### Neutral Scale
- **Page Background** (`#f8f9fa`): Results panel background, page-level sections.
- **Card Background** (`#ffffff`): All section cards, input backgrounds.
- **Text Primary** (`#1a1a1a`): Body copy, form values.
- **Text Heading** (`#111`): Section titles, card headings.
- **Text Secondary / Gray Dark** (`#333`): Labels, field titles.
- **Text Muted / Gray Medium** (`#666`): Helper text, descriptions, secondary labels.
- **Text Faint / Gray Light** (`#888`): Placeholders, hints, timestamps.
- **Border** (`#ddd`): Input borders, card dividers, section separators.

### Semantic / Severity
- **Error / Urgent** (`#dc3545`, `#dc2626`): Validation errors, urgent suggestion tier.
- **Success / Normal** (`#16a34a`): Positive health indicators, optimal stat status.
- **Warning / Attention** (`#fd7e14`): Attention suggestion tier, at-risk metrics.
- **Caution** (`#ea580c`): Attention stat status (between warning and urgent).
- **Info / Muted Warning** (`#d97706`): Info stat status.
- **Skin** (`#D63384`): Dermatology/skin health suggestion tier — pink accent.
- **Screening Notice** (`#92400e` text / `#fffbeb` bg / `#fcd34d` border): Amber inline notice for age-gated screening fields.

### Focus System
- Focus ring: `0 0 0 3px rgba(0, 163, 139, 0.1)` with `border-color: var(--color-brand)`

---

## 3. Typography Rules

### Font Family
System font stack — renders native on every OS with zero FOIT/FOUT:
```
-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif
```

### Hierarchy

| Role | Size | Weight | Color | Notes |
|------|------|--------|-------|-------|
| Section Title | 18px | 600 | `#333` | `.health-section-title` |
| Body / Field Value | 16px | 400 | `#1a1a1a` | Input text, results body |
| Field Label | 14px | 500 | `#333` | Form labels |
| Description / Helper | 13–14px | 400 | `#666` | Section descriptions, hints |
| Hint / Meta | 12–13px | 400 | `#888` | Field hints, timestamps |
| Badge / Unit Pill | 12px (0.85em) | 500 | `#00a38b` | `.unit-toggle-pill` |
| Button | 16px | 500–600 | `#fff` | Primary CTA |

### Principles
- No display-size headlines — this is an embedded tool, not a marketing page
- Labels at 14px weight 500, inputs at 16px weight 400 (avoids mobile zoom on iOS)
- 1.4–1.5 line height for body; 1.2–1.3 for compact labels and hints
- Never use pure black text — `#1a1a1a` or `#111` keeps reading comfortable

---

## 4. Component Stylings

### Buttons

**Primary (`.btn-primary`)**
- Background: `#00a38b` (brand teal)
- Text: `#fff`
- Radius: `8px`
- Hover: `#008f7a`
- Active: `scale(0.98)` transform
- Disabled: `#888` background
- Use: Save actions, primary form submissions

**Save Inline (`.save-inline-btn`)**
- Smaller variant of `.btn-primary` — used inside section cards next to longitudinal fields

**Save Top (`.save-top-btn`)**
- Full-width, `10px 16px` padding, `14px` font, `6px` radius (slightly tighter than base)
- Used at top of input panel on mobile

**Mobile View Plan (`.mobile-view-plan-btn`)**
- Fixed, full-width, bottom of screen on mobile
- Background: `var(--color-brand)` (#00a38b), radius 8px, padding 14px 20px
- `box-shadow: 0 -2px 12px rgba(0,0,0,0.15)` — lifts above page

**Ghost / Link**
- No background, `#0066cc` text, underline on hover
- Use: Tertiary actions, "View history" links

### Cards (`.section-card`)
- Background: `#ffffff`
- Border: none (shadow only)
- Radius: `12px`
- Padding: `24px` (desktop), `12px` (mobile)
- Shadow: `0 1px 3px rgba(0,0,0,0.08)`
- Use: Each input section (demographics, blood tests, medications, screenings)

### Stat Cards (`.stat-card`)
- Background: `#fff`, radius `8px`, `0 1px 2px rgba(0,0,0,0.05)` shadow
- Centered text: label at 12px `#666`, value at 20px weight 600 `#111`
- Status line at 11px weight 500: normal=`#16a34a`, info=`#d97706`, attention=`#ea580c`, urgent=`#dc2626`
- Clickable cards expand to full grid width (`grid-column: 1 / -1`) and show detail text
- Grid: `repeat(3, 1fr)` desktop, `repeat(2, 1fr)` mobile

### Suggestion Cards (`.suggestion-card`)
- Background: `#fff`, radius `8px`, `0 1px 2px rgba(0,0,0,0.05)` shadow
- **Left border: `4px solid`** — color signals severity tier:
  - Urgent: `#dc3545`
  - Attention: `#fd7e14`
  - Info: `#0066cc`
  - Supplement: `#00a38b`
  - Skin: `#D63384`
- Hover: `translateY(-1px)` + `0 4px 8px rgba(0,0,0,0.08)`
- Title: 15px weight 600; Description: 14px `#666`, line-height 1.5
- Evidence section: guideline tags + toggle link, then reason text + DOI links
- Suggestion group titles: 13px uppercase, `letter-spacing: 0.5px`, weight 600, `border-bottom: 2px solid` in severity color

### Suggestion Badges (`.suggestion-badge`)
- Radius: `4px` (rectangular, not pill)
- 11px uppercase, weight 600, `letter-spacing: 0.3px`, `3px 8px` padding
- Urgent: `#fce4e4` bg / `#dc3545` text; Attention: `#fff3e0` / `#fd7e14`; Info: `#e3f2fd` / `#0066cc`

### Guideline Tags (`.guideline-tag`)
- Inline pill: 11px, `#666` text, `#f5f5f5` bg, `1px solid #ddd` border, `10px` radius
- Clickable variant (`.guideline-tag-clickable`): hover darkens to `#ddd` bg

### Guest CTA Banner (`.guest-cta`)
- Sticky at top of results panel: full-width, `#00a38b` background, white text
- Internal button: white bg, `#00a38b` text, `6px` radius — inverted brand style
- Inline variant (`.guest-cta-inline`): `#e6f7f4` tinted background, `#b2dfdb` border, `#00695c` text

### Results Panel (`.health-tool-right`)
- Background: `#f8f9fa`
- Radius: `12px`
- Padding: `24px`
- Shadow: `0 1px 3px rgba(0,0,0,0.1)`
- Position: sticky on desktop (`top: 24px`), static on mobile
- Use: Health suggestions output panel

### Inputs & Selects
- Background: `#fff`
- Border: `1px solid #ddd`
- Radius: `8px`
- Padding: `10px 12px`
- Font-size: `16px` (prevents iOS zoom)
- Focus: `border-color: #00a38b` + `box-shadow: 0 0 0 3px rgba(0,163,139,0.1)`
- Error: `border-color: #dc3545`
- Placeholder: `#aaa`

### Toggle Buttons (`.sex-toggle`)
- Container: `1px solid #ddd` border, `8px` radius, `overflow: hidden`
- Each button: `flex: 1`, `16px` font, `#666` default color, no border
- Active (`.sex-toggle-btn--active`): background `#00a38b`, text `#fff`
- Use: Sex selection, any binary option

### Unit Toggle Pill (`.unit-toggle-pill`)
- Display: inline, within label text
- Border: `1px solid #ddd`, radius `12px`, padding `1px 8px`
- Font: `0.85em`, weight `500`, color `#00a38b`
- Hover: `rgba(0,163,139,0.08)` background, `#00a38b` border
- Use: Switch individual field units (e.g., lbs ↔ kg)

### Mobile Tab Bar (`.mobile-tab-bar`)
- Sticky at top, white background, `border-bottom: 1px solid #ddd`
- Each tab: `flex: 1`, `14px` font, weight `500`, `#666` default
- Active (`.mobile-tab--active`): color `#00a38b`, `border-bottom: 2px solid #00a38b`
- Hidden on desktop (shown only at ≤768px)

### Pill Badges
- Radius: `9999px`
- Use: Status indicators, unit labels, "New" tags
- Background: brand-tinted surface; text in brand color

---

## 5. Layout Principles

### Spacing Scale
| Token | Value | Use |
|-------|-------|-----|
| `--spacing-xs` | 4px | Micro gaps (field-meta, inline elements) |
| `--spacing-sm` | 8px | Between labels and inputs, icon gaps |
| `--spacing-md` | 12px | Card margins, grouped field gaps |
| `--spacing-lg` | 16px | Between form fields, section padding |
| `--spacing-xl` | 24px | Card padding, panel padding, major sections |

### Two-Panel Grid
Desktop: `grid-template-columns: 5fr 6fr; gap: 32px`
- Left (5fr): Input panel — section cards stacked vertically
- Right (6fr): Results panel — sticky, scrolls independently
- Mobile (≤768px): Single column, results panel becomes static below inputs

### Container
- Max width: `1200px`, centered
- Widget lives inside Shopify theme — no full-page layout control; respect theme gutters

### Border Radius Scale
- `8px`: Inputs, selects, standard buttons, toggles
- `12px`: Section cards, results panel, mobile "View Plan" button
- `9999px`: Pills, badges, unit toggle pills

---

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | No shadow, no border | Page background, inline text |
| Subtle Card | `0 1px 3px rgba(0,0,0,0.08)` | Section cards (input panel) |
| Panel | `0 1px 3px rgba(0,0,0,0.1)` | Results panel |
| Floating CTA | `0 -2px 12px rgba(0,0,0,0.15)` | Mobile fixed "View Plan" button |
| Focus Ring | `0 0 0 3px rgba(0,163,139,0.1)` | Keyboard/tap focus on inputs |

**Shadow philosophy**: single-layer, very low opacity. The widget lives inside a Shopify theme that already has visual weight — don't add competing elevation. Flat cards with subtle shadows keep the tool feeling embedded, not overlaid.

---

## 7. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | ≤768px | Single column, tab bar visible, cards compact (12px padding), hero image hidden |
| Desktop | >768px | Two-panel grid (5fr/6fr), tab bar hidden, results panel sticky |

### Mobile Specifics
- Tab bar: sticky at top, `z-index: 10`, white background
- Two tabs: "Enter Data" / "View Plan" (or similar)
- Swiper handles tab switching — CSS scroll-snap, no JS touch handlers
- Fixed "View Plan" button at bottom (`position: fixed; bottom: 12px; left: 15px; right: 15px`)
- Stats grid: `repeat(2, 1fr)` on mobile
- Hero: single column, image hidden, heading centered

### Touch Targets
- All inputs: `10px 12px` padding — comfortable tap area
- Buttons: minimum `44px` height equivalent
- Tabs: `8px 16px` padding

---

## 8. Accessibility & States

### Focus System
- All inputs and selects: brand teal focus ring (`0 0 0 3px rgba(0,163,139,0.1)`)
- Buttons: inherit browser default or add matching ring
- Tab navigation: fully supported

### Interactive States
| State | Treatment |
|-------|-----------|
| Default | `#ddd` border, `#666`–`#333` text |
| Hover (input) | No change (focus on click) |
| Focus | `#00a38b` border + teal glow ring |
| Active/Selected | Brand teal background (`#00a38b`), white text |
| Error | `#dc3545` border, error message below at 13px |
| Disabled | Reduced opacity, `#888` text |

### Color Contrast
- Body text (`#1a1a1a`) on white: ~17:1 (WCAG AAA)
- Labels (`#333`) on white: ~12:1 (WCAG AAA)
- Secondary text (`#666`) on white: ~5.7:1 (WCAG AA)
- Brand teal (`#00a38b`) on white: ~3.7:1 — use for decorative/non-text only at small sizes; pair with bold weight or larger size for AA

---

## 9. Health-Specific UI Patterns

### Suggestion Cards (Results Panel)
- Each suggestion: icon or color-coded severity indicator + recommendation text + evidence citation
- Clinical citations in small muted text below — `12–13px`, `#888`
- Severity tiers map to semantic colors: success (optimal), warning (borderline), error (at-risk)

### Longitudinal Fields
- Start **empty** (no prefilled value)
- Previous value shown as a small clickable label below the input (links to history chart)
- "Save New Values" button appends an immutable record — never overwrites

### Progressive Disclosure
- Stage 1: Units, Sex, Height
- Stage 2 (unlocks): Birth Month, Birth Year
- Stage 3 (unlocks): Weight, Waist
- Stage 4 (unlocks): BP, Blood Tests, Medications, Screenings
- The next-to-fill field gets `.field-attention` pulsing highlight class

### Medication Cascade UI
- Stepped disclosure — each medication shown only when clinically appropriate based on prior inputs
- Step hints in `13px #666` above the drug selector

---

## 10. Agent Prompt Guide

### Quick Reference
| Role | Value |
|------|-------|
| Brand color (focus, active) | `#00a38b` |
| Primary button (`.btn-primary`) | `#00a38b` (teal) |
| Info suggestion tier | `#0066cc` (blue) |
| Page / panel background | `#f8f9fa` |
| Card background | `#ffffff` |
| Body text | `#1a1a1a` |
| Labels | `#333` |
| Secondary text | `#666` |
| Muted / hints | `#888` |
| Border | `1px solid #ddd` |
| Focus ring | `0 0 0 3px rgba(0,163,139,0.1)` |
| Card radius | `12px` |
| Input radius | `8px` |
| Card shadow | `0 1px 3px rgba(0,0,0,0.08)` |

### Example Component Prompts
- **New section card**: "White card, 12px radius, `0 1px 3px rgba(0,0,0,0.08)` shadow, 24px padding. Section title at 18px weight 600 color `#333`. Fields at 16px with `1px solid #ddd` border, 8px radius, 10px 12px padding. On focus: `border-color: #00a38b` + `0 0 0 3px rgba(0,163,139,0.1)`."
- **Primary button**: "`#00a38b` background, white text, 8px radius, hover `#008f7a`, active scale(0.98)."
- **Status badge**: "Pill shape, 9999px radius, brand-tinted background, `#00a38b` text, 12px weight 500."
- **Mobile tab**: "Flex tab, 14px weight 500, `#666` default, active: `#00a38b` text + 2px bottom border."
- **Error state**: "Input border `#dc3545`. Below: 13px `#dc3545` error message, 4px margin-top."

### Rules for New UI
1. Match the system font — never import Google Fonts or custom fonts
2. Use `#00a38b` for focus, active, selection, and all primary buttons — never blue for these
3. Use `#0066cc` for `info`-tier suggestion UI only (group titles, badges, evidence links)
4. Cards get 12px radius; inputs get 8px — never swap them
5. Shadow is one layer at very low opacity — no multi-layer stacks, no `box-shadow: none` overrides
6. 16px minimum input font size — prevents iOS zoom
7. Spacing from the token scale — don't introduce arbitrary values
8. Mobile ≤768px: single column, compact card padding (12px), hide hero image
9. Clinical text (evidence citations, guideline references) always at 12–13px muted gray — never styled prominently
10. Never use pure black (`#000`) — use `#1a1a1a` or `#111`
