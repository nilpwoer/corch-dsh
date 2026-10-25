package reportview

import (
	"bytes"
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

func testDocument() Document {
	return Document{TaskID: "synthetic-report", InterviewID: "synthetic-interview", ReleaseVersion: "synthetic-v1", PDFURL: "/synthetic/pdf", Result: domain.ReportResult{ReportVersion: 3, InputVersion: 5, Report: domain.Report{Title: "中文访谈报告 <script>不能执行</script>", Sections: []domain.Section{{Title: "专家确认摘要", Statements: []domain.Statement{{Kind: "fact", Text: "我会核对原始作品与课堂记录。", EvidenceIDs: []string{"E1"}}}}}, TaskCards: []domain.TaskCard{}, NeedsVerification: []string{"核实适用范围。"}}, Evidence: []domain.Evidence{{ID: "E1", QuestionID: "Q01", Quote: "我会核对原始作品与课堂记录。"}}}}
}

func TestReportHTMLEscapesDataAndPreservesEvidence(t *testing.T) {
	doc := testDocument()
	data, err := HTML(doc)
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"中文访谈报告", "&lt;script&gt;不能执行&lt;/script&gt;", "#evidence-E1", "原文证据", "下载 PDF", "专家事实"} {
		if !bytes.Contains(data, []byte(part)) {
			t.Fatalf("missing report content: %s", part)
		}
	}
	if bytes.Contains(data, []byte("<script>")) {
		t.Fatal("report data became executable HTML")
	}
}

func TestReportPDFEmbedsChineseFontAndSupportsLongParagraphs(t *testing.T) {
	doc := testDocument()
	doc.Result.Report.Sections[0].Statements[0].Text = strings.Repeat("中文分页测试：保留完整事实与引用，长段落继续换行。", 180)
	data, err := PDF(context.Background(), doc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.Contains(data, []byte("/ToUnicode")) || !bytes.Contains(data, []byte("/FontFile2")) || !bytes.Contains(data, []byte("%%EOF")) {
		t.Fatal("PDF is missing its document or embedded Unicode font")
	}
	if len(regexp.MustCompile(`/Type\s*/Page(?:\s|/)`).FindAll(data, -1)) < 2 {
		t.Fatal("long Chinese report did not paginate")
	}
}

func TestReportPDFCancellationAndMissingGlyphNeverDropContent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PDF(ctx, testDocument()); err == nil {
		t.Fatal("cancelled rendering succeeded")
	}
	doc := testDocument()
	doc.Result.Report.Title += " \U0010FFFF"
	if _, err := PDF(context.Background(), doc); err == nil {
		t.Fatal("unsupported text was silently dropped")
	}
}
