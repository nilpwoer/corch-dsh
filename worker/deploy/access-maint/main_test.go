package main

import "testing"

func TestRestoreGuardRejectsEveryPostMigrationDataChange(t *testing.T) {
	before := snapshot{Database: "isolated", Schema: 3, Tables: map[string]table{"tw_schema": {1, "schema3"}, "tw_accounts": {1, "same"}}, Files: map[string]string{"publication": "same"}}
	fresh := func() snapshot {
		return snapshot{Database: "isolated", Schema: 4, Tables: map[string]table{"tw_schema": {1, "schema4"}, "tw_accounts": {1, "same"}, "tw_pack_access": {0, "empty"}}, Files: map[string]string{"publication": "same"}}
	}
	if !allowed(before, fresh()) {
		t.Fatal("empty additive migration must be reversible")
	}
	for _, change := range []func(*snapshot){
		func(s *snapshot) { s.Tables["tw_pack_access"] = table{1, "new credential"} },
		func(s *snapshot) { s.Tables["tw_accounts"] = table{1, "changed"} },
		func(s *snapshot) { s.Files["publication"] = "changed" },
		func(s *snapshot) { s.Database = "other" },
		func(s *snapshot) { s.Tables["unknown"] = table{} },
	} {
		s := fresh()
		change(&s)
		if allowed(before, s) {
			t.Fatal("stale restore accepted")
		}
	}
}
