# Agent Note: Source-backed JD search integration

Status: implemented

English | [中文](2026-10-20-jd-search-integration.zh.md)

## Problem

The JD workbench needs actual public job descriptions. Enabling fetch only in the base bundle leaves browser sessions without the tool because shipped Agent presets own their tool registrations. Model output can also cite a different job identifier from the page actually fetched, so a plausible URL and summary do not establish source evidence.

## Decision

The standard, code and Cordis presets enable `web_fetch` against the host HTTP provider. The base importer records that workspace dependency without changing existing package resolutions. JD role inference and search use the exact owning session; changing sessions remounts the workbench rather than reusing another session's results. Structured output waits for a closed JSON object and terminal request errors propagate to the form.

Search prompts require fetched source bodies and prohibit guessed responsibilities, invented dates, software installation and access-control bypasses. Before displaying jobs, `verifiedJdSearchJobs` validates model fields and matches each source URL against successful `web_fetch` results recorded after this search began. Known redirects use the final canonical URL. Search snippets, failed fetches, stale evidence and unmatched source identifiers cannot establish a result. This verifies source retrieval, not the factual correctness of every model summary or the continued availability of a vacancy.

Results expose original public sources, exclusion and restoration. Empty results explain how to adjust the search. Task and ability analysis consumes the retained jobs. The workbench explicitly reports that saving search projects is unavailable; provider sessions retain their ordinary transcript, while the JD form and result state remain in memory. No Worker, publication, invitation, report, expert-answer or database format changes are part of this integration.

## Alternatives considered

**Trust model source URLs after syntax validation.** A real search returned a job identifier different from the successfully fetched page. Exact tool evidence prevents that mismatch from becoming a clickable result.

**Use search summaries when fetching fails.** Search summaries can omit responsibilities and dates. Returning fewer verified jobs or an empty result preserves the distinction between source evidence and inference.

**Fall back to another available conversation.** This can put JD requests and output in an unrelated interview. A missing owning session fails explicitly.

## Consequences

Live search and analysis use the user's existing configured model and native search provider, incurring ordinary provider usage. Public websites can return errors, require login or change their content; the workbench cannot guarantee the requested count or active vacancy status. Persisted search-project history and an authenticated browser collection flow are deferred. Verification includes real model/search/fetch execution plus focused role-argument, empty/error, source-mismatch and existing interview/publication regressions; synthetic regressions do not substitute for live search evidence.
