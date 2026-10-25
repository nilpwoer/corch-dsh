// Package reportview renders saved interview results without models or external resources.
package reportview

import (
	"bytes"
	_ "embed"
	"html/template"
	"strings"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

// Document contains only the saved report and its display metadata, never credentials or invitation data.
type Document struct {
	TaskID, InterviewID, ReleaseVersion, PDFURL string
	Result                                      domain.ReportResult
}

func kindLabel(kind string) string {
	switch kind {
	case "fact":
		return "专家事实"
	case "interpretation":
		return "分析解释"
	default:
		return "待核实"
	}
}

//go:embed report.html
var page string

var reportTemplate = template.Must(template.New("report").Funcs(template.FuncMap{
	"kindLabel": kindLabel, "join": strings.Join,
}).Parse(page))

// HTML reuses the Worker report sections, task fields and evidence links in a script-free page.
func HTML(doc Document) ([]byte, error) {
	var output bytes.Buffer
	if err := reportTemplate.Execute(&output, doc); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
