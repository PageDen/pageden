# AGENTS.md — Pageden Public App

Instructions for AI coding agents working in this public repository.

## What This Repo Is

Pageden is the public, self-hostable core app: web app, server, Obsidian plugin, shared
packages, and tests.

This repository should stay clean for open-source and self-host use. Do not add hosted
service deployment assets, private infrastructure details, production credentials, or
internal operations notes here.

## Core Ownership

Core product code belongs here:

- `apps/server/` — API, database access, permissions, search, import, and agent endpoints.
- `apps/web/` — React web app and editor UI.
- `apps/obsidian-plugin/` — Obsidian integration.
- `packages/` — shared API types, MCP bridge, and TypeScript config.
- tests and generic self-host developer tooling.

## Public Repo Guardrails

- Keep features useful for self-hosted users by default.
- Put hosted-service-specific behavior behind configuration flags instead of hard-coding it.
- Do not include private repository names, private URLs, internal deployment workflow names,
  or hosted production/staging infrastructure details.
- Do not commit secrets. Use examples and placeholders only.
- Keep deployment guidance generic: PostgreSQL, object storage, reverse proxy, and TLS.

## Change Checklist

- Run the focused tests for the area you changed.
- Keep docs neutral and public-safe.
- Add tests for behavior changes.
- Keep API types and server behavior in sync.
