package domain

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestQuestionJSONIgnoresReferenceObjectOrderWithoutChangingValues(t *testing.T) {
	a := Question{ID: "q", Text: "Synthetic question", SourceRefs: json.RawMessage(`[{"title":"Synthetic reference","sourceType":"note","extra":{"z":9007199254740993,"a":true}}]`)}
	b := a
	b.SourceRefs = json.RawMessage(`[{"extra":{"a":true,"z":9007199254740993},"sourceType":"note","title":"Synthetic reference"}]`)
	original := append([]byte(nil), a.SourceRefs...)
	first, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	second, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) || !bytes.Contains(first, []byte("9007199254740993")) {
		t.Fatal("object order or exact numeric value changed serialized identity")
	}
	if !bytes.Equal(a.SourceRefs, original) {
		t.Fatal("caller-owned reference bytes were mutated")
	}
	for _, changed := range []string{`[{"title":"Changed reference","sourceType":"note","extra":{"z":9007199254740993,"a":true}}]`, `[{"title":"Synthetic reference","sourceType":"note","extra":{"z":9007199254740992,"a":true}}]`} {
		b.SourceRefs = []byte(changed)
		other, err := json.Marshal(b)
		if err != nil || bytes.Equal(first, other) {
			t.Fatal("changed reference value lost its identity")
		}
	}
	b.SourceRefs = []byte(`[{"b":2},{"a":1}]`)
	left, _ := json.Marshal(b)
	b.SourceRefs = []byte(`[{"a":1},{"b":2}]`)
	right, _ := json.Marshal(b)
	if bytes.Equal(left, right) {
		t.Fatal("reference array order was ignored")
	}
}

func TestQuestionJSONRejectsInvalidReferencesAndPreservesAbsentFields(t *testing.T) {
	for _, raw := range []string{`{`, `{} {}`} {
		if _, err := json.Marshal(Question{SourceRefs: []byte(raw)}); err == nil {
			t.Fatal("invalid reference JSON accepted")
		}
	}
	q := Question{ID: "q", Text: "Synthetic question"}
	raw, err := json.Marshal(q)
	if err != nil || bytes.Contains(raw, []byte("sourceRefs")) {
		t.Fatal("absent references changed")
	}
}
