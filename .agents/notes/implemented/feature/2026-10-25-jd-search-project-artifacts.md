# Agent Note: JD Search Projects and Workspace Artifacts

Status: implemented

English | [中文](2026-10-25-jd-search-project-artifacts.zh.md)

## Problem

A completed JD search needs a durable project entry that users can reopen, and its cleaned job descriptions and generated typical-work-task report need to remain available in the DSH workspace.

## Decision

The workbench stores project metadata in browser local storage keyed by the DSH session id and opens the corresponding session from the sidebar. The running client retains an in-memory index when browser storage is unavailable. Exclusion changes invalidate stale analysis and reports. A completed search renames that session and asks its workspace file tools to write `outputs/jd-search/<session-id>/jobs.json`. After analysis, the same session writes `typical-work-tasks.md` and a template-styled `typical-work-tasks.html` beside the job data. The workbench opens the saved HTML through the host default application, normally a browser. The report contains confirmed JD evidence, verb-led independent tasks, sample frequency hints, and professional ability tags. Frequency describes coverage in the current sample and does not estimate the labor market.

The analysis prompt follows the JD-driven capability mapping method: retain evidence ids, merge semantically equivalent tasks, exclude vague support or participation statements as standalone tasks, and map only to professional ability tags. Search results retain cleaned JD bodies alongside summaries and source URLs.

The final “Save search project” action rewrites both reports and adds `finalizedAt` to the project index only after the workspace confirms both file writes. Future workbenches can use the stored report paths and timestamp. Changing the confirmed JD sample invalidates this marker.

JD orchestration admits a prompt only when the bound conversation has no running or queued work. It subscribes before sending, identifies the new durable user input by its exact prompt text, and reads the corresponding turn's final assistant text after its recorded end. It returns only after the conversation becomes idle, so a subsequent artifact request can be admitted. Partial JSON cannot commit a search result. A fixed browser deadline cannot represent the combined queue, tool and model execution time, so the session lifecycle owns completion; failure, interruption, cancellation and removal release the subscription explicitly. A five-minute workbench reminder reports continued waiting without rejecting the request. One cancellation signal spans each user action and its artifact writes. Explicit cancellation aborts the client wait, requests cancellation of the host turn and prevents later workflow stages; unconfirmed host cancellation remains visible. A silent host stall requires user cancellation rather than an inferred failure. View disposal releases its reminder timer without cancelling accepted work. A temporary history-resync error cannot establish host termination, so it retains the result subscription until recovery or an explicit terminal event. Async UI updates require the current operation identity as well as its session id, so a late callback cannot overwrite a newer operation after returning to the same session.

When browser project metadata is missing, the workbench can recover the latest completed search from the session. Recovery requires the exact generated search prompt and valid jobs, ignores an unfinished or failed latest search, and leaves existing project records untouched. It sends no prompt and does not claim that workspace files were written. The durable session therefore preserves a late result even when an earlier client stopped waiting.

## Alternatives considered

**Write files directly through a client filesystem API:** the workbench's client workspace service exposes workspace and file navigation, but no write operation. The active session's DSH file tools provide workspace-scoped writes without adding a new client API.

**Store all job content only in browser storage:** this would make artifacts browser-specific and would not provide deliverable files in the DSH workspace.

**Create the project only after analysis:** users would lose the searchable project entry when analysis is delayed or fails. The project is listed immediately after search results arrive; subsequent artifact errors remain visible without removing it.

**Use a fixed browser timeout:** valid searches can exceed that deadline while tools and the model continue running. Detaching then leaves a visible assistant answer without a project or step transition. The recorded completion of the admitted work establishes the result's availability.

## Consequences

Project metadata follows browser local storage and is specific to the browser origin. Job data and reports live in the DSH workspace and depend on the active session being available and its file tools completing the requested write. File paths are stored with the project for reopening and troubleshooting. A failed artifact write does not hide the search results or remove the sidebar project. The finalization marker is project metadata; the two workspace reports are the frozen deliverables shared with follow-on workbenches.
