# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- 

### Changed
- 

### Fixed
- 

## [0.3.0] - 2026-06-15

### Changed
- Migrated all package references from `@mariozechner/*` to `@earendil-works/*` scope (pi v0.74.0+)

### Fixed
- Changed apiKey to use $-prefixed env var syntax ("$OLLAMA_CLOUD_API_KEY") to eliminate deprecation warning

## [0.2.0] - 2026-05-05

### Added
- Offline mode (`PI_OFFLINE=1`) — uses cached data only, no network calls
- Cache reads ignore TTL when offline, gracefully handle missing cache
- Offline indicator in `/ollama-cloud` menu header and status view
- "Refresh Models" disabled in menu when offline, shows "Unavailable" instead

### Changed
- Removed release-it and its configuration

### Removed
- GitHub Actions publish workflow (auto-publishing on tag push)

## [0.1.0] - Initial release

### Added
- Dynamic model discovery from Ollama Cloud API (`GET /v1/models` + `POST /api/show`)
- Interactive `/ollama-cloud` management menu with SettingsList TUI
- Refresh Models submenu: choose between Ollama API or models.dev source
- Status submenu with source breakdown (ollama, modelsdev, inference)
- Persistent cache with 1-hour TTL for fast subsequent startups
- Fallback chain: `/api/show` → models.dev API → name-based inference
- Source tracking per model entry in cache
- Capability detection (reasoning/thinking, vision) from `/api/show`
- Accurate context windows and maxTokens from API metadata
- Zero-cost tracking (Ollama Cloud uses flat subscription pricing)
- Initial project scaffold with pi extension entry point
- release-it configuration for automated releases
- GitHub Actions workflow for OIDC npm publishing
