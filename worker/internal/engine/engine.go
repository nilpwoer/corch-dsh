// Package engine 执行固定版本的追问和报告，租约丢失后禁止发布。
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/model"
	"github.com/fanzy531/corch-dsh/worker/internal/store"
)

type Engine struct {
	Store *store.Store
	Model stageClient
	Log   *slog.Logger
}

type stageClient interface {
	Stage(context.Context, store.Task, config.Release, config.Queue, string, string, any, any) error
}

func (e *Engine) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for kind, count := range map[string]int{"followup": e.Store.Config.Queue.FollowupConcurrency, "report": e.Store.Config.Queue.ReportConcurrency} {
		for i := 0; i < count; i++ {
			wg.Add(1)
			go func(kind string) { defer wg.Done(); e.loop(ctx, kind) }(kind)
		}
	}
	wg.Wait()
}
func (e *Engine) loop(ctx context.Context, kind string) {
	for ctx.Err() == nil {
		task, err := e.Store.Claim(ctx, kind)
		if err != nil && ctx.Err() == nil {
			e.Log.Error("任务认领失败", "kind", kind)
		}
		if task != nil {
			e.execute(ctx, *task)
			continue
		}
		timer := time.NewTimer(e.Store.Config.Queue.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
func (e *Engine) execute(parent context.Context, t store.Task) {
	var options config.Queue
	var release config.Release
	var in store.Input
	err := json.Unmarshal(t.Options, &options)
	if err == nil {
		err = json.Unmarshal(t.ReleaseData, &release)
	}
	if err == nil {
		err = json.Unmarshal(t.Input, &in)
	}
	if err == nil {
		err = in.Submit.Validate()
	}
	if err != nil || !release.ValidHash() || release.Kind != t.Kind || options.TaskTimeout <= 0 || options.LeaseDuration <= 0 || options.HeartbeatInterval <= 0 {
		cleanup, stop := context.WithTimeout(context.Background(), e.Store.Config.Database.ConnectTimeout)
		defer stop()
		if err := e.Store.Fail(cleanup, t, "INVALID_TASK_DATA", false, 0); err != nil {
			e.Log.Error("无效任务无法终止", "task_id", t.ID)
		}
		return
	}
	ctx, cancel := context.WithTimeout(parent, options.TaskTimeout)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(options.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.Store.Heartbeat(ctx, t, options.LeaseDuration); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	result, err := e.Process(ctx, t, in, release, options)
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		encoded, encodeErr := json.Marshal(result)
		if encodeErr != nil {
			err = encodeErr
		} else if int64(len(encoded)) > options.MaxOutputBytes {
			err = domain.Fail("RESULT_TOO_LARGE", 422)
		}
	}
	if err == nil {
		err = e.Store.Finish(ctx, t, result)
	}
	cancel()
	<-heartbeatDone
	if err == nil {
		return
	}
	var expected *domain.Error
	retryable := errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	if errors.As(err, &expected) {
		retryable = expected.Retryable
	}
	code := model.ErrorCode(err)
	retry := retryable && t.Attempt < t.MaxAttempts
	cleanup, stop := context.WithTimeout(context.Background(), e.Store.Config.Database.ConnectTimeout)
	defer stop()
	if retryable && !retry && t.Kind == "followup" {
		if finishErr := e.Store.Finish(cleanup, t, domain.FollowupResult{Status: "needs_review", Reason: code, AllowSkip: true}); finishErr == nil {
			return
		}
	}
	if failErr := e.Store.Fail(cleanup, t, code, retry, model.RetryDelay(options, t.Attempt)); failErr != nil {
		e.Log.Warn("任务失败状态未写入，等待租约回收", "task_id", t.ID, "error_code", code)
		return
	}
	e.Log.Warn("任务执行失败", "task_id", t.ID, "error_code", code, "retry", retry)
}

func (e *Engine) Process(ctx context.Context, t store.Task, in store.Input, r config.Release, options config.Queue) (any, error) {
	sub := in.Submit
	if sub.Kind == "followup" {
		var q domain.Question
		var a domain.Answer
		for _, question := range sub.Snapshot.Questions {
			if question.ID == sub.QuestionID {
				q = question
			}
		}
		for _, answer := range sub.Snapshot.Answers {
			if answer.QuestionID == sub.QuestionID {
				a = answer
			}
		}
		history := []domain.Followup{}
		for _, f := range in.Followups {
			if f.QuestionID == q.ID {
				history = append(history, f)
			}
		}
		if a.Skipped {
			return domain.FollowupResult{Status: "skipped", AllowSkip: true}, nil
		}
		count, limit := domain.FollowupLimit(sub.Snapshot, in.Followups, q.ID, r.Pipeline.MaxFollowups)
		if count >= limit {
			return domain.FollowupResult{Status: "needs_review", AllowSkip: true, Reason: "FOLLOWUP_LIMIT"}, nil
		}
		payload := struct {
			Profile  domain.Profile      `json:"profile"`
			Question domain.Question     `json:"question"`
			Answer   domain.Answer       `json:"answer"`
			History  []domain.Followup   `json:"previous_followups"`
			Pack     *domain.PackContext `json:"pack,omitempty"`
			Answers  []domain.Answer     `json:"answer_history,omitempty"`
		}{sub.Snapshot.Profile, q, a, history, sub.Snapshot.Pack, nil}
		if sub.Snapshot.Pack != nil {
			for _, answer := range sub.Snapshot.Answers {
				if answer.Confirmed {
					payload.Answers = append(payload.Answers, answer)
				}
			}
		}
		var analysis domain.Analysis
		if err := e.Model.Stage(ctx, t, r, options, "analyze", r.Pipeline.Analyze, payload, &analysis); err != nil {
			return nil, err
		}
		if err := domain.ValidateAnalysis(analysis, q); err != nil {
			return nil, err
		}
		result := domain.FollowupResult{Analysis: &analysis, AllowSkip: true}
		if analysis.Status == "complete" {
			result.Status = "complete"
			return result, nil
		}
		if analysis.Status == "sensitive" {
			result.Status = "needs_review"
			result.Reason = "SENSITIVE"
			return result, nil
		}
		var followup struct {
			Text string `json:"text"`
		}
		compose := struct {
			Context  any             `json:"context"`
			Analysis domain.Analysis `json:"analysis"`
		}{payload, analysis}
		if err := e.Model.Stage(ctx, t, r, options, "compose", r.Pipeline.Compose, compose, &followup); err != nil {
			return nil, err
		}
		if strings.TrimSpace(followup.Text) == "" || len(followup.Text) > 6000 {
			return nil, domain.Fail("INVALID_FOLLOWUP", 422)
		}
		result.Status = "followup_ready"
		result.Text = followup.Text
		return result, nil
	}
	var evidence domain.EvidenceResult
	if err := e.Model.Stage(ctx, t, r, options, "analyze", r.Pipeline.Analyze, sub.Snapshot, &evidence); err != nil {
		return nil, err
	}
	if err := domain.ValidateEvidence(evidence, sub.Snapshot); err != nil {
		return nil, err
	}
	var report domain.Report
	payload := struct {
		Profile   domain.Profile      `json:"profile"`
		Evidence  []domain.Evidence   `json:"evidence"`
		Followups []domain.Followup   `json:"followups"`
		Pack      *domain.PackContext `json:"pack,omitempty"`
	}{sub.Snapshot.Profile, evidence.Evidence, in.Followups, sub.Snapshot.Pack}
	if err := e.Model.Stage(ctx, t, r, options, "compose", r.Pipeline.Compose, payload, &report); err != nil {
		return nil, err
	}
	if err := domain.ValidateReport(report, evidence); err != nil {
		return nil, err
	}
	return domain.ReportResult{ReportVersion: t.ReportVersion, InputVersion: sub.Snapshot.InputVersion, Report: report, Evidence: evidence.Evidence}, nil
}
