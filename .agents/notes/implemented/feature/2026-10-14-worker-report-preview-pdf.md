# Agent Note: Shared saved-report preview and PDF download

Status: implemented

English | [中文](2026-10-14-worker-report-preview-pdf.zh.md)

## Problem

Participants can read an evidence-linked report, but the management view exposes raw JSON and downloads it as the report. A readable export must preserve Chinese text, long sections and evidence while retaining the existing interview permissions and saved versions.

## Decision

A shared, script-free HTML template retains the Worker report sections, statement kinds, task-card fields and original quotations. Both portal and management views embed that page and offer a PDF download. JSON stays an internal API representation. Each read checks the existing account or interview session, participant visibility policy and saved report state; trusted backend routes retain their existing Bearer authorization.

PDF generation runs in-process with pinned gopdf and a bundled, renamed OFL Chinese font. Text remains selectable, every paragraph is wrapped across A4 pages, and citation annotations point to evidence anchors. HTML escapes all report data and applies a restrictive CSP. Missing glyphs fail rendering instead of silently removing text. Viewing or downloading does not invoke models or mutate saved answers, releases or reports.

## Alternatives considered

**Browser printing alone** opens a print workflow without providing the requested downloadable PDF. **External conversion services** would introduce private-data transfer and another runtime dependency. **A headless browser on the production host** would add installation and process-management requirements to an older Linux system. **Separate report designs** would duplicate the existing Worker layout and allow participant and management views to diverge.

## Consequences

Releases include font and component license notices. The binary embeds its HTML and font, so production needs no Chrome, Python, network font or PDF conversion service. The reference font has finite character coverage; unsupported characters produce a rendering error and remain readable in HTML. API-only isolated acceptance uses saved synthetic reports to verify real browser downloads, Chinese long-text pagination, evidence links, escaping, failed/empty states and anonymous, cross-interview and visibility-policy rejection. No model calls are needed for report rendering.
