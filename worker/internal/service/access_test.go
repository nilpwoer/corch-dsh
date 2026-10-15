package service

import (
	"context"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
	"github.com/fanzy531/corch-dsh/worker/internal/packaccess"
	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"testing"
)

func (f *fakeManagement) ReadPackAccess(_ context.Context, e published.Entry) (packaccess.View, error) {
	f.accessMu.Lock()
	defer f.accessMu.Unlock()
	if v, ok := f.access[e.Key]; ok {
		if v.PublicationHash != e.Hash {
			return v, domain.Fail("ACCESS_PUBLICATION_CHANGED", 409)
		}
		return v, nil
	}
	return packaccess.Legacy(e), nil
}
func (f *fakeManagement) EnsurePackAccess(ctx context.Context, e published.Entry) (packaccess.View, error) {
	v, err := f.ReadPackAccess(ctx, e)
	if err != nil || v.Status != "missing" {
		return v, err
	}
	f.accessMu.Lock()
	defer f.accessMu.Unlock()
	if f.access == nil {
		f.access = map[string]packaccess.View{}
	}
	if v, ok := f.access[e.Key]; ok {
		return v, nil
	}
	code, err := packaccess.Generate()
	if err != nil {
		return v, err
	}
	v = packaccess.View{PublicationHash: e.Hash, Revision: 1, Code: code, Status: "active", Source: "worker"}
	f.access[e.Key] = v
	return v, nil
}
func (f *fakeManagement) ChangePackAccess(ctx context.Context, e published.Entry, revision int64, action string) (packaccess.View, error) {
	v, err := f.ReadPackAccess(ctx, e)
	if err != nil {
		return v, err
	}
	f.accessMu.Lock()
	defer f.accessMu.Unlock()
	if current, ok := f.access[e.Key]; ok {
		v = current
	}
	if v.Revision != revision {
		return v, domain.Fail("ACCESS_REVISION_CONFLICT", 409)
	}
	if action == "create" && v.Code != "" {
		return v, domain.Fail("ACCESS_ALREADY_EXISTS", 409)
	}
	switch action {
	case "create", "rotate":
		code, err := packaccess.Generate()
		if err != nil {
			return v, err
		}
		v.Code = code
		v.Source = "worker"
		v.Status = "active"
	case "revoke":
		if v.Code == "" {
			return v, domain.Fail("ACCESS_NOT_INITIALIZED", 409)
		}
		v.Status = "revoked"
	default:
		return v, domain.Fail("INVALID_ACCESS_ACTION", 400)
	}
	v.Revision++
	if f.access == nil {
		f.access = map[string]packaccess.View{}
	}
	f.access[e.Key] = v
	return v, nil
}
func (f *fakeManagement) CheckPackAccess(ctx context.Context, e published.Entry, code string) error {
	v, err := f.ReadPackAccess(ctx, e)
	if err != nil {
		return err
	}
	return packaccess.Check(v, code)
}

func TestAccessCredentialsAreServerGeneratedAndLegacyIsReadOnly(t *testing.T) {
	f := &fakeManagement{}
	e := published.Entry{Key: "synthetic-v1", Hash: "synthetic-hash"}
	ctx := context.Background()
	v, err := f.EnsurePackAccess(ctx, e)
	if err != nil || len(v.Code) != 40 || v.Source != "worker" {
		t.Fatal("server generation failed")
	}
	retry, err := f.EnsurePackAccess(ctx, e)
	if err != nil || retry != v {
		t.Fatal("retry changed credential")
	}
	if f.CheckPackAccess(ctx, e, "wrong") == nil || f.CheckPackAccess(ctx, e, v.Code) != nil {
		t.Fatal("validation failed")
	}
	legacy := published.Entry{Key: "legacy-v1", Hash: "legacy-hash", Pack: published.Pack{Invitation: &published.Invitation{Code: "synthetic-existing", Status: "active"}}}
	old, err := f.EnsurePackAccess(ctx, legacy)
	if err != nil || old.Code != "synthetic-existing" || old.Source != "legacy" {
		t.Fatal("legacy changed")
	}
	if _, ok := f.access[legacy.Key]; ok {
		t.Fatal("legacy auto migrated")
	}
	revoked, err := f.ChangePackAccess(ctx, e, v.Revision, "revoke")
	if err != nil || revoked.Status != "revoked" || f.CheckPackAccess(ctx, e, v.Code) == nil {
		t.Fatal("revocation failed")
	}
	repeat, err := f.EnsurePackAccess(ctx, e)
	if err != nil || repeat != revoked {
		t.Fatal("retry reactivated access")
	}
}
