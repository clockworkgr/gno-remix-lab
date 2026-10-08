package membership

import (
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
)

var (
	owner = testutils.TestAddress("owner")
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
	carol = testutils.TestAddress("carol")
)

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err.Error())
	}
}

func mustFail(t *testing.T, err, category error) {
	t.Helper()
	if !core.Is(err, category) {
		if err == nil {
			t.Fatalf("expected %s, got nil", category.Error())
		}
		t.Fatalf("expected %s, got %s", category.Error(), err.Error())
	}
}

func TestInvitationFlow(t *testing.T) {
	s := New(Config{JoinMode: JoinInvitation, MaxMembers: 3}, owner)
	if s.RoleOf(owner) != core.RoleOwner || s.Size() != 1 {
		t.Fatal("owner not seeded")
	}
	mustFail(t, s.Join(alice), core.ErrUnauthorized)
	mustOK(t, s.Invite(alice, core.RoleMember))
	mustFail(t, s.Invite(alice, core.RoleMember), core.ErrConflict)
	mustOK(t, s.Invite(bob, core.RoleReviewer))
	// owner + 2 invites fill capacity 3
	mustFail(t, s.Invite(carol, core.RoleMember), core.ErrLimitExceeded)
	mustOK(t, s.Join(alice))
	mustOK(t, s.Join(bob))
	if s.RoleOf(bob) != core.RoleReviewer {
		t.Fatal("invited role not applied")
	}
	if s.PendingInvites() != 0 || s.Size() != 3 {
		t.Fatal("invites not consumed")
	}
	mustFail(t, s.Join(alice), core.ErrConflict)
}

func TestOpenJoin(t *testing.T) {
	s := New(Config{JoinMode: JoinOpen, MaxMembers: 2}, owner)
	mustFail(t, s.Invite(alice, core.RoleMember), core.ErrInvalidState)
	mustOK(t, s.Join(alice))
	mustFail(t, s.Join(bob), core.ErrLimitExceeded)
	mustOK(t, s.Leave(alice))
	mustOK(t, s.Join(bob))
	if s.IsMember(alice) || !s.IsMember(bob) {
		t.Fatal("leave/join mismatch")
	}
}

func TestLastOwnerProtected(t *testing.T) {
	s := New(Config{JoinMode: JoinInvitation, MaxMembers: 10}, owner)
	mustFail(t, s.Leave(owner), core.ErrInvalidState)
	mustFail(t, s.Remove(owner), core.ErrInvalidState)
	mustFail(t, s.SetRole(owner, core.RoleMember), core.ErrInvalidState)
	mustOK(t, s.Add(alice, core.RoleOwner))
	if s.Owners() != 2 {
		t.Fatal("owner count")
	}
	mustOK(t, s.SetRole(owner, core.RoleMember))
	if s.Owners() != 1 {
		t.Fatal("owner count after demotion")
	}
	mustFail(t, s.Remove(alice), core.ErrInvalidState)
	mustOK(t, s.Remove(owner))
}

func TestAddValidation(t *testing.T) {
	s := New(Config{JoinMode: JoinInvitation, MaxMembers: 2}, owner)
	mustFail(t, s.Add(address("nope"), core.RoleMember), core.ErrInvalidInput)
	mustFail(t, s.Add(alice, core.RoleNone), core.ErrInvalidInput)
	mustFail(t, s.Add(alice, core.Role(9)), core.ErrInvalidInput)
	mustOK(t, s.Invite(alice, core.RoleMember))
	// a direct add supersedes the invite without double-counting capacity
	mustOK(t, s.Add(alice, core.RoleMember))
	if s.IsInvited(alice) {
		t.Fatal("invite should be consumed")
	}
	mustFail(t, s.Add(bob, core.RoleMember), core.ErrLimitExceeded)
	mustFail(t, s.Remove(bob), core.ErrNotFound)
}

func TestSnapshotBounded(t *testing.T) {
	s := New(Config{JoinMode: JoinOpen, MaxMembers: 10}, owner)
	mustOK(t, s.Join(alice))
	mustOK(t, s.Join(bob))
	mustOK(t, s.SetRole(bob, core.RoleReviewer))

	all, ok := s.Snapshot(core.RoleMember, 10)
	if !ok || len(all) != 3 {
		t.Fatal("full snapshot")
	}
	reviewers, ok := s.Snapshot(core.RoleReviewer, 10)
	if !ok || len(reviewers) != 2 {
		t.Fatal("reviewer snapshot")
	}
	if _, ok := s.Snapshot(core.RoleMember, 2); ok {
		t.Fatal("over-limit snapshot must fail rather than truncate")
	}
	if _, ok := s.Snapshot(core.RoleMember, -1); ok {
		t.Fatal("negative max must fail")
	}
	if _, ok := s.Snapshot(core.Role(7), 10); ok {
		t.Fatal("invalid minRole must fail")
	}
	// snapshot is a copy: later changes don't affect it
	before := make([]address, len(all))
	copy(before, all)
	mustOK(t, s.Leave(alice))
	mustOK(t, s.Join(carol))
	for i := range all {
		if all[i] != before[i] {
			t.Fatal("snapshot aliased internal state")
		}
	}
}

func TestInvitedOwnerIsCounted(t *testing.T) {
	s := New(Config{JoinMode: JoinInvitation, MaxMembers: 10}, owner)
	mustOK(t, s.Invite(alice, core.RoleOwner))
	mustOK(t, s.Invite(bob, core.RoleReviewer))
	if r, ok := s.InviteRole(alice); !ok || r != core.RoleOwner {
		t.Fatal("invite role")
	}
	if _, ok := s.InviteRole(carol); ok {
		t.Fatal("phantom invitation")
	}
	inv := s.Invites(0, 10)
	if len(inv) != 2 || len(s.Invites(1, 10)) != 1 || len(s.Invites(-1, 10)) != 0 {
		t.Fatal("invites listing")
	}
	mustOK(t, s.Join(alice))
	if s.Owners() != 2 {
		t.Fatalf("owners = %d, want 2", s.Owners())
	}
	// Either owner can now step down; the last one cannot.
	mustOK(t, s.Leave(owner))
	if err := s.Leave(alice); err == nil {
		t.Fatal("last owner left")
	}
}

func TestList(t *testing.T) {
	s := New(Config{JoinMode: JoinOpen, MaxMembers: 10}, owner)
	mustOK(t, s.Join(alice))
	mustOK(t, s.Join(bob))
	page := s.List(1, 1)
	if len(page) != 1 {
		t.Fatal("page size")
	}
	if len(s.List(0, 25)) != 3 || len(s.List(5, 25)) != 0 || len(s.List(-1, 5)) != 0 {
		t.Fatal("list bounds")
	}
}

func TestConfigValidation(t *testing.T) {
	if (Config{JoinMode: JoinOpen, MaxMembers: 0}).Validate() == nil {
		t.Fatal("zero max")
	}
	if (Config{JoinMode: JoinOpen, MaxMembers: HardMaxMembers + 1}).Validate() == nil {
		t.Fatal("over hard max")
	}
	if (Config{JoinMode: JoinMode(5), MaxMembers: 5}).Validate() == nil {
		t.Fatal("bad mode")
	}
}

func TestImplementsReader(t *testing.T) {
	var _ core.MembershipReader = New(Config{JoinMode: JoinOpen, MaxMembers: 1}, owner)
}
