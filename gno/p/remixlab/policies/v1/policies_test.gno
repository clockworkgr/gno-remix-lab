package policies

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/remixlab/core/v1"
	"gno.land/p/remixlab/membership/v1"
)

var (
	owner    = testutils.TestAddress("owner")
	reviewer = testutils.TestAddress("reviewer")
	member   = testutils.TestAddress("member")
	outsider = testutils.TestAddress("outsider")
)

func setup() *Policy {
	s := membership.New(membership.Config{JoinMode: membership.JoinInvitation, MaxMembers: 10}, owner)
	s.Add(reviewer, core.RoleReviewer)
	s.Add(member, core.RoleMember)
	p := New(s)
	p.Define("poll.vote", RuleMember, RulePublic)
	p.Define("poll.open", RuleOwner, RuleReviewer)
	p.Define("members.add", RuleOwner, RuleOwner)
	return p
}

func TestAuthorizeMatrix(t *testing.T) {
	p := setup()
	cases := []struct {
		op    string
		actor address
		ok    bool
	}{
		{"poll.vote", owner, true},
		{"poll.vote", reviewer, true},
		{"poll.vote", member, true},
		{"poll.vote", outsider, false},
		{"poll.open", owner, true},
		{"poll.open", reviewer, false},
		{"members.add", reviewer, false},
		{"members.add", owner, true},
		{"undefined.op", owner, false},
	}
	for _, c := range cases {
		err := p.Authorize(c.op, c.actor)
		if c.ok && err != nil {
			t.Errorf("%s by %s: unexpected %s", c.op, c.actor, err.Error())
		}
		if !c.ok && !core.Is(err, core.ErrUnauthorized) {
			t.Errorf("%s by %s: expected unauthorized", c.op, c.actor)
		}
		if p.Allowed(c.op, c.actor) != c.ok {
			t.Errorf("%s by %s: Allowed mismatch", c.op, c.actor)
		}
	}
}

func TestFloorsProtectAdmin(t *testing.T) {
	p := setup()
	if err := p.Set("members.add", RuleMember); !core.Is(err, core.ErrInvalidInput) {
		t.Fatal("admin op lowered below owner floor")
	}
	if err := p.Set("poll.open", RuleReviewer); err != nil {
		t.Fatal(err.Error())
	}
	if p.Authorize("poll.open", reviewer) != nil {
		t.Fatal("reviewer should now open polls")
	}
	if err := p.Set("poll.vote", RulePublic); err != nil {
		t.Fatal(err.Error())
	}
	if p.Authorize("poll.vote", outsider) != nil {
		t.Fatal("public vote")
	}
	if err := p.Set("poll.vote", RuleNobody); err != nil {
		t.Fatal(err.Error())
	}
	if p.Authorize("poll.vote", owner) == nil {
		t.Fatal("disabled op allowed")
	}
	if err := p.Set("nope", RuleOwner); !core.Is(err, core.ErrNotFound) {
		t.Fatal("unknown op set")
	}
}

func TestDefineGuards(t *testing.T) {
	p := setup()
	expectPanic(t, func() { p.Define("poll.vote", RuleOwner, RuleOwner) })
	expectPanic(t, func() { p.Define("x.y", RuleMember, RuleOwner) })
	expectPanic(t, func() { p.Define("Bad-Name", RuleOwner, RuleOwner) })
	expectPanic(t, func() { p.Define("", RuleOwner, RuleOwner) })
	expectPanic(t, func() { p.Define("x", Rule(42), RuleOwner) })
}

func TestMembershipChangesApply(t *testing.T) {
	s := membership.New(membership.Config{JoinMode: membership.JoinOpen, MaxMembers: 10}, owner)
	p := New(s)
	p.Define("post", RuleMember, RuleMember)
	if p.Allowed("post", outsider) {
		t.Fatal("outsider allowed")
	}
	s.Join(outsider)
	if !p.Allowed("post", outsider) {
		t.Fatal("new member denied")
	}
}

func TestListAndParse(t *testing.T) {
	p := setup()
	l := p.List()
	if len(l) != 3 || l[0].Op != "members.add" {
		t.Fatal("list order")
	}
	for r := RulePublic; r <= RuleNobody; r++ {
		got, err := ParseRule(r.String())
		if err != nil || got != r {
			t.Fatal("parse round trip")
		}
	}
}

func expectPanic(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("expected panic")
		}
	}()
	fn()
}
