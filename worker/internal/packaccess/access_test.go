package packaccess

import (
	"bytes"
	"errors"
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

func TestGenerateSixDigitsWithSecureRandomness(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9]{6}$`)
	for i := 0; i < 256; i++ {
		code, err := Generate()
		if err != nil || !pattern.MatchString(code) {
			t.Fatal("generated invitation must contain exactly six ASCII digits")
		}
	}
}

func TestGeneratePreservesLeadingZerosAndRejectsBiasedCandidates(t *testing.T) {
	for _, example := range []struct {
		name string
		raw  []byte
		want string
	}{
		{"zero", []byte{0, 0, 0}, "000000"},
		{"leading zeros", []byte{0, 0, 7}, "000007"},
		{"maximum", []byte{15, 66, 63}, "999999"},
		{"reject one million then use next draw", []byte{15, 66, 64, 0, 0, 42}, "000042"},
	} {
		t.Run(example.name, func(t *testing.T) {
			code, err := generate(bytes.NewReader(example.raw), "")
			if err != nil || code != example.want {
				t.Fatal("decimal format or rejection sampling changed")
			}
		})
	}
	if code, err := generate(bytes.NewReader(nil), ""); !errors.Is(err, io.EOF) || code != "" {
		t.Fatal("entropy failure must not produce a fallback invitation")
	}
}

func TestRotationRejectsThePreviousInvitation(t *testing.T) {
	code, err := generate(bytes.NewReader([]byte{0, 0, 7, 0, 0, 8}), "000007")
	if err != nil || code != "000008" {
		t.Fatal("rotation reused the previous invitation")
	}
	if code, err := generate(bytes.NewReader([]byte{0, 0, 7}), "000007"); !errors.Is(err, io.EOF) || code != "" {
		t.Fatal("rotation returned the old invitation after entropy failure")
	}
	code, err = Rotate("000007")
	if err != nil || code == "000007" || !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) {
		t.Fatal("secure rotation failed")
	}
}

func TestCheckRetainsLongCodesAndExactStringMatching(t *testing.T) {
	for _, code := range []string{"000007", strings.Repeat("a", 40), "synthetic-legacy-invitation"} {
		view := View{Status: "active", Code: code}
		if err := Check(view, code); err != nil {
			t.Fatal("existing invitation rejected")
		}
		for _, attempt := range []string{"", "7", "000008", " " + code, code + " "} {
			var failure *domain.Error
			if err := Check(view, attempt); !errors.As(err, &failure) || failure.Code != "INVALID_INVITATION" || failure.HTTPStatus != 401 {
				t.Fatal("incorrect invitation must be rejected without normalization")
			}
		}
		view.Status = "revoked"
		if err := Check(view, code); err == nil {
			t.Fatal("revoked invitation accepted")
		}
	}
}
