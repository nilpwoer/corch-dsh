package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCorrectionPolicyIsBoundedAndFrozenWithoutChangingLegacyHashShape(t *testing.T) {
	c, err := Load(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{-1, 4} {
		p := c.Prompts["report"]
		p.MaxCorrections = limit
		c.Prompts["report"] = p
		if c.Validate() == nil {
			t.Fatal("unbounded correction budget accepted")
		}
	}
	p := c.Prompts["report"]
	p.MaxCorrections = 2
	c.Prompts["report"] = p
	r := c.Release("report")
	if !r.ValidHash() || r.Pipeline.MaxCorrections != 2 {
		t.Fatal("correction budget not captured")
	}
	r.Pipeline.MaxCorrections = 1
	if r.ValidHash() {
		t.Fatal("changed correction budget has same release hash")
	}
	p.MaxCorrections = 0
	c.Prompts["report"] = p
	r = c.Release("report")
	raw, _ := json.Marshal(r)
	if strings.Contains(string(raw), "max_corrections") {
		t.Fatal("legacy zero-value release serialization changed")
	}
	var legacy Release
	if json.Unmarshal(raw, &legacy) != nil || !legacy.ValidHash() {
		t.Fatal("legacy release not readable")
	}
	f := c.Prompts["followup"]
	f.MaxCorrections = 1
	c.Prompts["followup"] = f
	if c.Validate() == nil {
		t.Fatal("report correction budget applied to followups")
	}
}
