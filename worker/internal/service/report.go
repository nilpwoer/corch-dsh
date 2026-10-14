package service

import (
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"strings"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/reportview"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

// serveSavedReport is called only after the owning route's session and interview authorization.
func serveSavedReport(w http.ResponseWriter, r *http.Request, task store.Task, format string) {
	if task.Kind != "report" {
		failure(w, domain.Fail("NOT_FOUND", 404))
		return
	}
	if task.Status != "succeeded" {
		failure(w, domain.Fail("REPORT_NOT_READY", 409))
		return
	}
	var result domain.ReportResult
	var input store.Input
	if json.Unmarshal(task.Output, &result) != nil || json.Unmarshal(task.Input, &input) != nil || result.ReportVersion != task.ReportVersion || result.InputVersion != input.Submit.Snapshot.InputVersion || result.InputVersion < 1 {
		failure(w, domain.Fail("INVALID_SAVED_REPORT", 500))
		return
	}
	evidence := domain.EvidenceResult{Evidence: result.Evidence}
	if domain.ValidateEvidence(evidence, input.Submit.Snapshot) != nil || domain.ValidateReport(result.Report, evidence) != nil {
		failure(w, domain.Fail("INVALID_SAVED_REPORT", 500))
		return
	}
	var release config.Release
	if json.Unmarshal(task.ReleaseData, &release) != nil {
		failure(w, domain.Fail("INVALID_SAVED_REPORT", 500))
		return
	}
	doc := reportview.Document{TaskID: task.ID, InterviewID: task.InterviewID, ReleaseVersion: release.Pipeline.Version, Result: result, PDFURL: strings.TrimSuffix(r.URL.Path, "/view") + "/pdf"}
	var body []byte
	var err error
	if format == "pdf" {
		body, err = reportview.PDF(r.Context(), doc)
	} else {
		body, err = reportview.HTML(doc)
	}
	if err != nil {
		failure(w, domain.Fail("REPORT_RENDER_FAILED", 500))
		return
	}
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if format == "pdf" {
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fmt.Sprintf("report-%s-v%d.pdf", task.ID, task.ReportVersion)}))
	} else {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	_, _ = w.Write(body)
}
