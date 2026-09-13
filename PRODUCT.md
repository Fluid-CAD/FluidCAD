# Product

## Register

brand

The design surface this file governs is `website/` — fluidcad.io: the home page,
and the marketing-shaped pages around the docs. The docs themselves and the
in-app UI (`ui/`, `shell/`) are product surfaces and follow the app's own
conventions; when a task targets those, override the register per task.

## Users

Two audiences arrive with equal weight, and the page is written so neither one
has to read past the other to find themselves.

- **CAD users** — mechanical engineers, product designers, makers who already
  work in SolidWorks, Fusion, Onshape or FreeCAD. They arrive skeptical: they
  have seen "CAD in the browser" before and it was a mesh toy. Their job is to
  find out, in under a minute, whether this is a real B-Rep kernel with sketch
  constraints, a feature tree, assemblies and STEP interop. They evaluate by
  looking at geometry, not by reading claims.
- **Developers and makers** — JavaScript-fluent people in the OpenSCAD /
  CadQuery / build123d orbit who want models that live in git, are diffable,
  parameterized, and scriptable. Their job is to find out whether the API is
  pleasant, whether they can drive it from CI or an agent, and whether it is
  open source.

Both arrive from a link (GitHub, X, Reddit, YouTube, a search) on desktop most
of the time, with a real GPU, and leave for the docs or for an install command
if the first fold earns it.

## Product Purpose

FluidCAD is a parametric CAD application built on the OpenCascade B-Rep kernel.
You model with the mouse — sketch with constraints, extrude, revolve, fillet,
pattern, assemble with mates — and every action writes a plain JavaScript
statement into a file you own. Code is the record and the fine control, not the
price of entry. It runs on the desktop (macOS, Windows, Linux), from any editor
via VS Code and Neovim extensions or the CLI, and exposes an MCP server so an
AI agent can drive a live workspace.

The home page succeeds when a CAD user believes the geometry is real and a
developer believes the API is worth writing, and both know within one screen
that the other half exists.

## Brand Personality

**Precise. Alive. Unadvertised.**

The voice is a competent engineer showing you the thing working, not a company
describing itself. Statements are specific and checkable ("exact B-Rep edges,
fillets and booleans — not mesh approximations") rather than adjectival. No
superlatives, no urgency, no invented metrics. Where a claim can be replaced by
a running model, it is.

The page should feel like an instrument that happens to be on: quiet ground,
generous space, and the geometry doing the talking. The emotional target is
*confidence* — the reader should feel the tool is more capable than the page is
loud.

## Anti-references

Rejected explicitly, all four confirmed by the user:

- **Generic AI/SaaS landing.** Gradient blobs, glassmorphism, three identical
  icon-and-heading cards, logo walls, hero metric rows, fake testimonials.
- **Legacy CAD vendor site.** Autodesk/SolidWorks density: stock photography of
  engineers pointing at monitors, certification badge grids, enterprise-speak,
  "solutions".
- **Toy / hobbyist project page.** Rounded playful shapes, emoji, hand-drawn
  doodles, weekend-project energy that undersells a production kernel.
- **Cold developer-tool clone.** Interchangeable dark terminal aesthetic with a
  monospace typeface doing all the personality work.

Also out: blueprint / graph-paper pastiche (the first thing anyone guesses for a
CAD site) and the tiny uppercase tracked eyebrow above every section.

## Design Principles

1. **Show the kernel running.** The strongest asset is that the real engine can
   run in the visitor's browser. Wherever a section could be a claim or a
   screenshot, prefer live geometry; wherever live is too heavy, prefer a frame
   captured from the actual app over an illustration.
2. **Both hands, no favorite.** Mouse-driven modeling and code are presented as
   one workflow seen from two sides, never as a beginner mode and an expert
   mode. Any section that names one should show the other.
3. **The app's own colors are the brand.** FluidCAD blue means live and
   interactive; the amber-gold selection highlight means the thing being acted
   on. The page borrows the meanings, not just the hex values, so the site and
   the app teach the same visual language.
4. **Specific over adjectival.** Every headline names a capability a CAD user
   can verify. If a sentence would survive being pasted on a competitor's site,
   it is rewritten.
5. **Nothing promised that is not shipping.** Platform availability, features
   and links state today's truth; anything ahead is labelled as such.

## Accessibility & Inclusion

- **Contrast:** WCAG 2.2 AA in both light and dark themes — 4.5:1 body,
  3:1 large text and meaningful UI boundaries. Theme follows the browser by
  default (`respectPrefersColorScheme`), and both themes are designed, not
  derived.
- **Motion:** `prefers-reduced-motion: reduce` is honored everywhere. The hero's
  automatic feature-tree replay stops, cross-fades replace transitions, and no
  content depends on an animation having run.
- **Baseline interaction:** visible focus on every control, real semantics
  (buttons, tabs, headings, landmarks), and text alternatives for the 3D canvas.
  Deep keyboard control of the 3D viewport itself is explicitly out of scope for
  the marketing surface (the app owns that).
