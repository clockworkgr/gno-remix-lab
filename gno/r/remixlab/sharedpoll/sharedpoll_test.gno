package sharedpoll

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/remixlab/core/v1"
	"gno.land/p/remixlab/membership/v1"
)

var (
	owner = testutils.TestAddress("owner")
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
)

// The real binding to gno.land/r/remixlab/sharedmembers is exercised by the
// local-node integration test, where both realms are deployed. Here the
// electorate source is a local set so the poll logic runs in isolation.
func useFakeShared(addrs ...address) *membership.Set {
	s := membership.New(membership.Config{JoinMode: membership.JoinOpen, MaxMembers: 10}, addrs[0])
	for _, a := range addrs[1:] {
		s.Join(a)
	}
	electorate = s
	return s
}

func TestSharedElectorate(cur realm, t *testing.T) {
	setup(owner)
	shared := useFakeShared(alice, bob)

	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "Shared question", "yes|no", 60)
	OpenPoll(cross(cur), id)

	// The local admin is not in the shared set, so cannot vote.
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), id, 0)
	})
	testing.SetRealm(testing.NewUserRealm(alice))
	Vote(cross(cur), id, 0)

	// Shared membership changes after opening do not affect this poll.
	shared.Leave(bob)
	testing.SetRealm(testing.NewUserRealm(bob))
	Vote(cross(cur), id, 0)

	testing.SkipHeights(13)
	Finalize(cross(cur), id)
	v, _ := Poll(id)
	uassert.Equal(t, int(core.OutcomeWinner), int(v.Outcome))
	uassert.Equal(t, 2, v.ElectorateSize)
}

func TestSharedMembersCannotAdminister(cur realm, t *testing.T) {
	setup(owner)
	useFakeShared(alice)
	// alice owns the (fake) shared set but has no local admin role.
	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: poll.create requires owner", func() {
		CreatePoll(cross(cur), "x", "a|b", 60)
	})
	testing.SetRealm(testing.NewUserRealm(owner))
	AddAdmin(cross(cur), alice, "reviewer")
	SetRule(cross(cur), "poll.create", "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	CreatePoll(cross(cur), "x", "a|b", 60)
}

func TestDescriptorBinding(t *testing.T) {
	d := Descriptor()
	uassert.Equal(t, "membership.read/v1=gno.land/r/remixlab/sharedmembers", d.Bindings[0])
}
