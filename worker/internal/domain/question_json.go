package domain

import (
	"bytes"
	"encoding/json"
	"io"
)

// MarshalJSON serializes sourceRefs object keys deterministically across MySQL JSON round trips.
// Array order, values and unknown reference fields are preserved; the question is not mutated.
func (q Question) MarshalJSON() ([]byte, error) {
	type wireQuestion Question
	value := wireQuestion(q)
	if len(q.SourceRefs) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(q.SourceRefs))
		decoder.UseNumber()
		var refs any
		if err := decoder.Decode(&refs); err != nil {
			return nil, err
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return nil, Fail("INVALID_SOURCE_REFS", 400)
		}
		raw, err := json.Marshal(refs)
		if err != nil {
			return nil, err
		}
		value.SourceRefs = raw
	}
	return json.Marshal(value)
}
