package reportview

import (
	"context"
	_ "embed"
	"fmt"
	"strings"
	"unicode"

	"github.com/signintech/gopdf"
)

//go:embed fonts/CorchReportSans-Regular.ttf
var reportFont []byte

type block struct {
	text, anchor string
	size         float64
	refs         []string
	heading      bool
}

func reportBlocks(doc Document) []block {
	result := []block{{text: fmt.Sprintf("报告 v%d · 答案版本 %d · %s", doc.Result.ReportVersion, doc.Result.InputVersion, doc.ReleaseVersion), size: 9}, {text: "访谈 " + doc.InterviewID, size: 9}, {text: doc.Result.Report.Title, size: 20, heading: true}}
	add := func(text string, size float64, heading bool, refs []string) {
		result = append(result, block{text: text, size: size, heading: heading, refs: refs})
	}
	for _, s := range doc.Result.Report.Sections {
		add(s.Title, 14, true, nil)
		for _, st := range s.Statements {
			add(kindLabel(st.Kind)+"  "+st.Text, 10.5, false, st.EvidenceIDs)
		}
	}
	for _, card := range doc.Result.Report.TaskCards {
		add("典型任务："+card.Title, 14, true, nil)
		for _, field := range []struct{ label, value string }{{"触发条件", card.Trigger}, {"情境约束", card.Context}, {"步骤", strings.Join(card.Steps, "\n")}, {"关键判断", strings.Join(card.Judgments, "\n")}, {"工具", strings.Join(card.Tools, "、")}, {"协作", card.Collaboration}, {"质量依据", card.QualityEvidence}, {"边界", card.Boundaries}} {
			if field.value != "" {
				add(field.label+"："+field.value, 10.5, false, nil)
			}
		}
		add("", 10.5, false, card.EvidenceIDs)
	}
	if len(doc.Result.Report.NeedsVerification) > 0 {
		add("尚待核实", 14, true, nil)
		for _, text := range doc.Result.Report.NeedsVerification {
			add("• "+text, 10.5, false, nil)
		}
	}
	add("原文证据", 14, true, nil)
	for _, e := range doc.Result.Evidence {
		result = append(result, block{text: e.ID + " · " + e.QuestionID, size: 11, heading: true, anchor: e.ID})
		add(e.Quote, 10.5, false, nil)
	}
	if len(doc.Result.Evidence) == 0 {
		add("本次报告没有可引用的原文证据，内容仅列为待核实事项。", 10.5, false, nil)
	}
	return result
}

// PDF embeds the licensed Chinese font, wraps every line and paginates complete content.
// Rendering is in-process; unsupported glyphs fail instead of silently dropping text.
func PDF(ctx context.Context, doc Document) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var pdf gopdf.GoPdf
	pdf.Start(gopdf.Config{PageSize: *gopdf.PageSizeA4})
	missing := false
	if err := pdf.AddTTFFontDataWithOption("report", reportFont, gopdf.TtfOption{OnGlyphNotFound: func(r rune) {
		if !unicode.IsControl(r) {
			missing = true
		}
	}}); err != nil {
		return nil, err
	}
	pdf.SetInfo(gopdf.PdfInfo{Title: doc.Result.Report.Title, Author: "实践专家访谈", Creator: "Teaching Worker"})
	const margin = 48.0
	width, height := gopdf.PageSizeA4.W, gopdf.PageSizeA4.H
	y := margin
	newPage := func() { pdf.AddPage(); y = margin }
	newPage()
	for _, item := range reportBlocks(doc) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := pdf.SetFont("report", "", item.size); err != nil {
			return nil, err
		}
		lineHeight := item.size * 1.65
		if item.heading && y+lineHeight*3 > height-margin {
			newPage()
		}
		text := strings.ReplaceAll(strings.ReplaceAll(item.text, "\r\n", "\n"), "\r", "\n")
		text = strings.Map(func(r rune) rune {
			if r == '\t' {
				return ' '
			}
			if unicode.IsControl(r) && r != '\n' {
				return -1
			}
			return r
		}, text)
		lines := []string{}
		for _, paragraph := range strings.Split(text, "\n") {
			if paragraph == "" {
				lines = append(lines, "")
				continue
			}
			wrapped, err := pdf.SplitText(paragraph, width-2*margin)
			if err != nil {
				return nil, err
			}
			lines = append(lines, wrapped...)
		}
		if item.text == "" {
			lines = nil
		}
		for i, line := range lines {
			if y+lineHeight > height-margin {
				newPage()
			}
			pdf.SetXY(margin, y)
			if i == 0 && item.anchor != "" {
				pdf.SetAnchor("evidence-" + item.anchor)
			}
			if err := pdf.Cell(nil, line); err != nil {
				return nil, err
			}
			y += lineHeight
		}
		if len(item.refs) > 0 {
			if err := pdf.SetFont("report", "", 9); err != nil {
				return nil, err
			}
			labels := make([]string, len(item.refs))
			for i, id := range item.refs {
				labels[i] = "[" + id + "]"
			}
			wrapped, err := pdf.SplitText("引用证据："+strings.Join(labels, " "), width-2*margin)
			if err != nil {
				return nil, err
			}
			for _, line := range wrapped {
				if y+16 > height-margin {
					newPage()
				}
				pdf.SetXY(margin, y)
				pdf.SetTextColor(166, 60, 56)
				if err := pdf.Cell(nil, line); err != nil {
					return nil, err
				}
				for _, id := range item.refs {
					label := "[" + id + "]"
					if at := strings.Index(line, label); at >= 0 {
						left, err := pdf.MeasureTextWidth(line[:at])
						if err != nil {
							return nil, err
						}
						linkWidth, err := pdf.MeasureTextWidth(label)
						if err != nil {
							return nil, err
						}
						pdf.AddInternalLink("evidence-"+id, margin+left, y, linkWidth, 14)
					}
				}
				pdf.SetTextColor(32, 38, 46)
				y += 16
			}
		}
		y += 7
	}
	pages := pdf.GetNumberOfPages()
	for n := 1; n <= pages; n++ {
		if err := pdf.SetPage(n); err != nil {
			return nil, err
		}
		if err := pdf.SetFont("report", "", 8.5); err != nil {
			return nil, err
		}
		pdf.SetTextColor(100, 110, 120)
		pdf.SetXY(margin, height-30)
		if err := pdf.Cell(nil, fmt.Sprintf("实践专家访谈 · 报告 v%d", doc.Result.ReportVersion)); err != nil {
			return nil, err
		}
		pdf.SetXY(width-margin-70, height-30)
		if err := pdf.Cell(nil, fmt.Sprintf("%d / %d", n, pages)); err != nil {
			return nil, err
		}
	}
	if missing {
		return nil, fmt.Errorf("report contains unsupported font glyphs")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return pdf.GetBytesPdfReturnErr()
}
