# Project Preferences & Design Guidelines

- **Design Reference**: Always refer to [design.md](file:///Users/imranhossen/Developer%20Space/Extensions/Auto%20refresher/design.md) for design preferences, color palettes, icon styles, and micro-animations.
- **Icon Actions**: Edit and Delete actions on item cards must always use minimalist, clean SVG icon buttons (`.btn-icon-action`), never bulky text/emoji buttons.
- **Color Swatches**: Swatch buttons must always include `appearance: none; -webkit-appearance: none;` and explicit `background-color` attribute rules to prevent Chrome native user-agent skins from overriding colors with white circles.
- **Custom Color Popover**: Maintain the dark glassmorphic custom color popover matching the extension popup (HEX default, RGB, HSL format toggle).
- **Dashboard Layout**: Keep the Link Groups Central Dashboard located in the upper right side of the options dashboard grid layout.
