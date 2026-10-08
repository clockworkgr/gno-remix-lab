package core

import "testing"

func TestRoleOrdering(t *testing.T) {
	if !RoleOwner.AtLeast(RoleReviewer) || !RoleReviewer.AtLeast(RoleMember) {
		t.Fatal("role ordering broken")
	}
	if RoleMember.AtLeast(RoleReviewer) || RoleNone.AtLeast(RoleMember) {
		t.Fatal("lower role satisfied higher requirement")
	}
	for _, r := range []Role{RoleNone, RoleMember, RoleReviewer, RoleOwner} {
		got, err := ParseRole(r.String())
		if err != nil || got != r {
			t.Fatalf("round trip failed for %s", r.String())
		}
	}
	if _, err := ParseRole("admin"); !Is(err, ErrInvalidInput) {
		t.Fatal("expected invalid input")
	}
}

func TestCheckText(t *testing.T) {
	cases := []struct {
		s         string
		multiline bool
		want      error
	}{
		{"hello", false, nil},
		{"", false, ErrInvalidInput},
		{"line\nbreak", false, ErrInvalidInput},
		{"line\nbreak", true, nil},
		{"tab\there", true, ErrInvalidInput},
		{"bell\x07", false, ErrInvalidInput},
		{"bad\xff", false, ErrInvalidInput},
		{"sep\u2028x", true, ErrInvalidInput},
		{"0123456789a", false, ErrLimitExceeded},
		{"héllo", false, nil},
		{"   ", false, ErrInvalidInput},
		{"a\u202eb", false, ErrInvalidInput},
		{"a\u2066b", false, ErrInvalidInput},
		{"a\u200bb", false, ErrInvalidInput},
		{"\ufeffab", false, ErrInvalidInput},
		{"a\u00adb", false, ErrInvalidInput},
		{"a\u200db", false, nil},
	}
	for _, c := range cases {
		err := CheckText("f", c.s, 1, 10, c.multiline)
		if c.want == nil {
			if err != nil {
				t.Errorf("%q: unexpected %s", c.s, err.Error())
			}
			continue
		}
		if !Is(err, c.want) {
			t.Errorf("%q: want %s, got %v", c.s, c.want.Error(), err)
		}
	}
}

func TestCheckTextMinimum(t *testing.T) {
	if err := CheckText("f", "ab", 3, 10, false); !Is(err, ErrInvalidInput) || err.Error() != "remix: invalid input: f is too short" {
		t.Fatalf("got %v", err)
	}
	if err := CheckText("f", "    ", 3, 10, false); err == nil || err.Error() != "remix: invalid input: f is required" {
		t.Fatalf("blank text accepted: %v", err)
	}
	if err := CheckText("f", "", 0, 10, false); err != nil {
		t.Fatalf("optional empty text rejected: %s", err.Error())
	}
}

func TestErrorCategories(t *testing.T) {
	err := Errorf(ErrNotFound, "ballot 3")
	if err.Error() != "remix: not found: ballot 3" {
		t.Fatal(err.Error())
	}
	if !Is(err, ErrNotFound) || Is(err, ErrInvalidInput) {
		t.Fatal("category match broken")
	}
	if Is(nil, ErrNotFound) {
		t.Fatal("nil matched")
	}
}
