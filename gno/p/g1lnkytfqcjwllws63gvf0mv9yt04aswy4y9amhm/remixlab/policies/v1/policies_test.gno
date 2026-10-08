package policies

import (
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/membership/v1"
	"gno.land/p/nt/testutils/v0"
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
	if err := p.Authorize("poll.vote", owner); err == nil || err.Error() != "remix: unauthorized: poll.vote is disabled" {
		t.Fatalf("disabled op: %v", err)
	}
	// Owner-floor operations can never be disabled.
	if err := p.Set("members.add", RuleNobody); !core.Is(err, core.ErrInvalidInput) {
		t.Fatal("owner-floor op disabled")
	}
	if p.Authorize("members.add", owner) != nil {
		t.Fatal("owner lost members.add")
	}
	// Reviewer-floor operations may be disabled and re-enabled.
	if err := p.Set("poll.open", RuleNobody); err != nil {
		t.Fatal(err.Error())
	}
	if err := p.Set("poll.open", RuleOwner); err != nil {
		t.Fatal(err.Error())
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
	expectPanic(t, func() { p.Define("admin.lock", RuleNobody, RuleOwner) })
	for _, bad := range []string{"a..b", "a._", "a.", ".a", "a.1", "_a", "a__b"} {
		expectPanic(t, func() { p.Define(bad, RuleOwner, RuleOwner) })
	}
	p.Define("members.set_role", RuleOwner, RuleOwner)
	p.Define("v2.poll_open", RuleOwner, RuleReviewer)
	p.Define("feature.off", RuleNobody, RuleReviewer)
}

type badReader struct{}

func (badReader) RoleOf(address) core.Role                  { return core.Role(7) }
func (badReader) IsMember(address) bool                     { return true }
func (badReader) Size() int                                 { return 1 }
func (badReader) Snapshot(core.Role, int) ([]address, bool) { return nil, false }

func TestUndefinedRoleGrantsNothing(t *testing.T) {
	p := New(badReader{})
	p.Define("admin", RuleOwner, RuleOwner)
	p.Define("open", RulePublic, RulePublic)
	if p.Authorize("admin", outsider) == nil || p.Allowed("admin", outsider) {
		t.Fatal("undefined role passed an owner rule")
	}
	if p.Authorize("open", outsider) != nil {
		t.Fatal("public op refused")
	}
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
