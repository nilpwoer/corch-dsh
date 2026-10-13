package accounts

import "testing"

func TestPasswordsUseSaltedStrongHashes(t *testing.T) {
	first, err := Hash("synthetic-password-used-only-in-tests")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Hash("synthetic-password-used-only-in-tests")
	if err != nil || first == second {
		t.Fatal("salt not randomized")
	}
	if !ValidHash(first) || !Verify(first, "synthetic-password-used-only-in-tests") || Verify(first, "wrong") {
		t.Fatal("invalid password verification")
	}
	if ValidHash("plaintext") || Verify("pbkdf2-sha256$1$bad$bad", "anything") {
		t.Fatal("unsafe hash accepted")
	}
}
