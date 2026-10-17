# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- The product itself is a terminal TUI. This file scopes the brand presentation surface; the identity must also survive at one terminal cell and as an app icon. -->

## Users

Developers working in real repositories from a terminal, on macOS first. They run an agent against live code, not a chat sandbox: they watch it read files, edit, run checks, and stop for permission. They value local control, visible state, and a tool that behaves like an instrument rather than an assistant persona.

## Product Purpose

Hikaro is an independent TypeScript coding agent. It opens a real project, reads code, edits files, runs checks, and recovers from failures inside a fullscreen terminal UI. A bidirectional Pi integration lets the same agent run through an external host. Success means a developer can hand over a real coding loop without losing sight of what changed or who approved it.

## Positioning

The agent loop, the file boundaries, and the approval surface are Hikaro's own; it is not a wrapper around Pi's agent loop. Execution stays local, credentials stay on the host, and every privileged operation is a visible, reviewable decision rather than an opaque capability. The interface refuses decorative activity: status changes are immediate, and nothing animates just to look busy.

## Operating Context

A fullscreen TUI for an 18–36 row terminal; keyboard-first navigation; approval panels above the editor; session history in SQLite; data in `~/.hikaro`; macOS workspace sandbox for commands; optional MCP, Skills, LSP, index, browser, plugins, subagents, scheduled jobs, and remote relay. The brand also appears in the README, package metadata, an app icon, documentation, and release pages. A terminal cell, a 16 px favicon, and a 1024 px app icon are all first-class sizes.

## Capabilities and Constraints

Node 24.21+, pnpm 12.11.2, `rg`, and a C11 compiler are required to run from source. macOS is the initial supported host. No cloud execution, no central account, no cloud history backup. Command execution is sandboxed with no network by default. TypeScript and SQLite are implementation facts, not brand claims. No pricing, customer logos, benchmarks, or availability claims exist to reuse.

## Brand Commitments

The name is *hikaro*; the user confirms it is tied to light and illumination. The redesign is a full replacement: the incumbent terracotta-and-cream palette, the four-tile H icon, and the uppercase geometric wordmark are evidence, not authority. The identity is a serif `h` with a round sun behind the shoulder and one horizon line; the wordmark is lowercase Literata with a round Beam tittle. The macOS app icon uses the system squircle (824 / 1024, 100 px margin, 185 corner) as its canvas; this is not a generic monogram tile. Forbidden by the brief: gradients or glow, a light shape inside the `h`, a generic rounded-tile monogram (the macOS squircle canvas is allowed), Japanese-symbol pastiche (torii, sakura, brush strokes, seals), and minimalism that is clean but empty. A compact mark must remain legible at 16 px and one terminal cell.

## Evidence on Hand

`brand/hikaro-icon.png`, `brand/hikaro-icon-transparent.png`, and `brand/hikaro-wordmark.png` are the superseded assets. Product documentation is in `README.md`, `PLAN.md`, `TODO.md`, and `docs/`. There are no approved customer stories, press, or marketing claims; none may be invented.

## Product Principles

1. **Agency is visible.** The human grants or withholds permission; the interface makes that act legible without ceremony.
2. **Light, not glow.** Illumination comes from precision, contrast, and negative space, never from added effects.
3. **Calm under constraint.** Boundaries, budgets, and approvals produce steadiness rather than noise.
4. **Work at real scale.** The identity must hold at 16 px, in one terminal cell, in pure black and white, and at billboard size.
5. **Craft over costume.** Every form is drawn from the product's own mechanics, not from generic AI or Japanese surface cues.

## Accessibility & Inclusion

The identity must survive monochrome, low-resolution terminals, dark and light grounds, and reduced-motion contexts. Motion in the brand presentation must respect `prefers-reduced-motion` and never rely on color alone for meaning.
