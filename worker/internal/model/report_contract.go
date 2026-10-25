package model

import (
	"encoding/json"
	"fmt"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

const reportInstruction = `报告引用规则：fact 只能陈述本次 evidence 原文支持的专家事实，必须有非空 evidence_ids；每个 ID 必须来自本次提供的 evidence。不得仅为通过校验而附上不相关的 ID。
profile 是主持人提供、等待专家校准的背景，不是回答证据。行业、岗位、年限、职业阶段等背景以及缺少证据的说明，不得冒充无引用的 fact；应明确标为 needs_verification。sourceRefs、访谈问题及追问问句也不是专家回答证据。
task_cards 必须有非空的有效证据引用，字段只写对应原文支持的内容；不足的字段留空，不能编造完整任务。没有证据的候选任务放 needs_verification。
当 evidence 为空时，task_cards 必须为 []，所有 sections.statements 的 kind 只能是 needs_verification，evidence_ids 必须为 []；仅说明证据不足和待核实事项，不输出事实结论或推断。`

type outputContract struct {
	cacheName   string
	instruction string
	validate    func() error
	feedback    func() any
	constrain   func(map[string]any)
}

func contractFor(name string, input, output any) (outputContract, error) {
	contract := outputContract{cacheName: name, validate: func() error { return nil }, feedback: func() any { return nil }}
	switch result := output.(type) {
	case *domain.EvidenceResult:
		snapshot, ok := input.(domain.Snapshot)
		if !ok {
			return contract, domain.Fail("INVALID_STAGE_INPUT", 500)
		}
		contract.cacheName = "report_analyze_v2"
		contract.instruction = "证据提取规则：只从已确认且未跳过的 answers.text 逐字连续摘录 quote，保持否定、条件和范围；不要把 profile、问题、选项或 sourceRefs 当成已经发生的事实。确无可引用内容时返回 evidence: []，不得编造。"
		contract.validate = func() error { return domain.ValidateEvidence(*result, snapshot) }
	case *domain.Report:
		context, ok := input.(domain.ReportContext)
		if !ok {
			return contract, domain.Fail("INVALID_STAGE_INPUT", 500)
		}
		evidence := domain.EvidenceResult{Evidence: context.Evidence}
		contract.cacheName = "report_compose_v2"
		contract.instruction = reportInstruction
		contract.validate = func() error { return domain.ValidateReport(*result, evidence) }
		contract.feedback = func() any { return domain.ReportIssues(*result, evidence) }
		ids := make([]string, 0, len(context.Evidence))
		for _, item := range context.Evidence {
			ids = append(ids, item.ID)
		}
		encoded, _ := json.Marshal(ids)
		contract.instruction += "\n本次唯一可用的证据 ID：" + string(encoded)
		contract.constrain = func(schema map[string]any) { constrainReportSchema(schema, ids) }
	}
	return contract, nil
}

func object(value any) map[string]any {
	v, ok := value.(map[string]any)
	if !ok {
		panic("owned generated report schema object missing")
	}
	return v
}

// constrainReportSchema augments the owned generated schema; domain validation remains authoritative.
func constrainReportSchema(schema map[string]any, ids []string) {
	defs := object(schema["$defs"])
	statement := object(defs["Statement"])
	props := object(statement["properties"])
	kinds := []string{"fact", "interpretation", "needs_verification"}
	if len(ids) == 0 {
		kinds = []string{"needs_verification"}
	}
	object(props["kind"])["enum"] = kinds
	object(props["text"])["minLength"] = 1
	cites := object(props["evidence_ids"])
	cites["maxItems"] = 100
	cites["uniqueItems"] = true
	if len(ids) == 0 {
		cites["items"] = false
	} else {
		cites["items"] = map[string]any{"type": "string", "enum": ids}
	}
	statement["allOf"] = []any{map[string]any{"if": map[string]any{"properties": map[string]any{"kind": map[string]any{"const": "fact"}}, "required": []string{"kind"}}, "then": map[string]any{"properties": map[string]any{"evidence_ids": map[string]any{"minItems": 1}}}}}
	card := object(defs["TaskCard"])
	cardProps := object(card["properties"])
	object(cardProps["title"])["minLength"] = 1
	cardCites := object(cardProps["evidence_ids"])
	cardCites["minItems"] = 1
	cardCites["maxItems"] = 100
	cardCites["uniqueItems"] = true
	if len(ids) == 0 {
		cardCites["items"] = false
	} else {
		cardCites["items"] = map[string]any{"type": "string", "enum": ids}
	}
	report := object(defs["Report"])
	reportProps := object(report["properties"])
	object(reportProps["title"])["minLength"] = 1
	sections := object(reportProps["sections"])
	sections["minItems"] = 1
	sections["maxItems"] = 30
	maxCards := 100
	if len(ids) == 0 {
		maxCards = 0
	}
	object(reportProps["task_cards"])["maxItems"] = maxCards
	object(reportProps["needs_verification"])["maxItems"] = 100
}

func correctionMessage(code string, feedback any) string {
	data, _ := json.Marshal(feedback)
	return fmt.Sprintf("上一版输出未通过校验：%s。失败字段规则：%s。请依据原始输入和提供的证据重新生成完整 JSON。不得编造引用、机械附加无关ID或把未证实内容当作事实；无证据的内容明确标为 needs_verification，无法支持的任务卡删除。", code, data)
}
