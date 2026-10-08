package clubpoll

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/remixlab/core/v1"
)

var (
	owner     = testutils.TestAddress("owner")
	alice     = testutils.TestAddress("alice")
	bob       = testutils.TestAddress("bob")
	mallory   = testutils.TestAddress("mallory")
	latecomer = testutils.TestAddress("latecomer")
)

func reset() {
	setup(owner)
}

func TestClubPollAcceptance(cur realm, t *testing.T) {
	reset()

	// Add two members.
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "member")
	Invite(cross(cur), bob, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))
	testing.SetRealm(testing.NewUserRealm(bob))
	Join(cross(cur))
	uassert.Equal(t, "member", RoleOf(alice))
	uassert.Equal(t, 3, len(Members(0, 25)))

	// Open a poll.
	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "Next meetup venue", "Library|Cafe|Online", 3600)
	OpenPoll(cross(cur), id)

	// Cast votes.
	testing.SetRealm(testing.NewUserRealm(alice))
	Vote(cross(cur), id, 1)
	testing.SetRealm(testing.NewUserRealm(bob))
	Vote(cross(cur), id, 1)
	testing.SetRealm(testing.NewUserRealm(owner))
	Vote(cross(cur), id, 0)

	// Reject a nonmember.
	testing.SetRealm(testing.NewUserRealm(mallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), id, 0)
	})

	// Finalization waits for the deadline.
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: deadline not reached", func() {
		Finalize(cross(cur), id)
	})
	testing.SkipHeights(3600/5 + 1)
	Finalize(cross(cur), id) // anyone may finalize

	// Inspect the tally.
	v, ok := Poll(id)
	uassert.True(t, ok)
	uassert.Equal(t, int(core.OutcomeWinner), int(v.Outcome))
	uassert.Equal(t, 1, v.Winner)
	uassert.Equal(t, 3, v.Turnout)
	uassert.Equal(t, 3, v.ElectorateSize)

	page := Render("polls/1")
	uassert.True(t, strings.Contains(page, `winner\: Cafe`), page)
}

func TestNonOwnerCannotAdminister(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))

	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.invite requires owner", func() {
		Invite(cross(cur), mallory, "member")
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: poll.create requires owner", func() {
		CreatePoll(cross(cur), "x", "a|b", 3600)
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: policy.set requires owner", func() {
		SetRule(cross(cur), "poll.create", "member")
	})
	testing.SetRealm(testing.NewUserRealm(mallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: invitation required", func() {
		Join(cross(cur))
	})
}

// An intermediary realm must not gain the owner's authority just because the
// owner signed the outer transaction.
func TestIntermediaryRealmGainsNoAuthority(cur realm, t *testing.T) {
	reset()
	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/evil/proxy"))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.invite requires owner", func() {
		Invite(cross(cur), mallory, "owner")
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: poll.create requires owner", func() {
		CreatePoll(cross(cur), "x", "a|b", 3600)
	})
	uassert.Equal(t, "none", RoleOf(mallory))
}

func TestElectorateFrozenAtOpening(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "member")
	Invite(cross(cur), latecomer, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))

	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "Budget", "yes|no", 3600)
	OpenPoll(cross(cur), id)

	// Joining after opening grants no vote in this poll.
	testing.SetRealm(testing.NewUserRealm(latecomer))
	Join(cross(cur))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), id, 0)
	})

	// Leaving after opening keeps the frozen vote, and a removed member's
	// later role changes do not alter it either.
	testing.SetRealm(testing.NewUserRealm(alice))
	Leave(cross(cur))
	Vote(cross(cur), id, 0)

	// Duplicate votes fail.
	uassert.AbortsWithMessage(t, cur, "remix: conflict: already voted", func() {
		Vote(cross(cur), id, 1)
	})

	// Options and electorate cannot be re-opened.
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: ballot already opened", func() {
		OpenPoll(cross(cur), id)
	})
}

func TestDeadlineBoundary(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "Quick", "a|b", 60)
	OpenPoll(cross(cur), id)
	testing.SkipHeights(11) // 55s
	Vote(cross(cur), id, 0)
	testing.SkipHeights(1) // 60s: deadline reached
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: voting period has ended", func() {
		Vote(cross(cur), id, 1)
	})
	testing.SetRealm(testing.NewUserRealm(mallory))
	Finalize(cross(cur), id)
	v, _ := Poll(id)
	uassert.Equal(t, int(core.OutcomeWinner), int(v.Outcome))
}

func TestTieIsDeterministic(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "member")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))
	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "Tie", "a|b", 60)
	OpenPoll(cross(cur), id)
	Vote(cross(cur), id, 0)
	testing.SetRealm(testing.NewUserRealm(alice))
	Vote(cross(cur), id, 1)
	testing.SkipHeights(13)
	Finalize(cross(cur), id)
	v, _ := Poll(id)
	uassert.Equal(t, int(core.OutcomeTie), int(v.Outcome))
	uassert.Equal(t, -1, v.Winner)
}

func TestPolicyFloors(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))

	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: members.remove: rule below floor owner", func() {
		SetRule(cross(cur), "members.remove", "reviewer")
	})
	SetRule(cross(cur), "poll.create", "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	CreatePoll(cross(cur), "Reviewer poll", "a|b", 60)

	// A reviewer allowed to invite still cannot invite an owner.
	testing.SetRealm(testing.NewUserRealm(owner))
	SetRule(cross(cur), "members.invite", "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	Invite(cross(cur), bob, "member")
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.set_role requires owner", func() {
		Invite(cross(cur), mallory, "owner")
	})
}

func TestRenderEscapesUserText(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	id := CreatePoll(cross(cur), "[pwn](https://evil.example) <b>x</b>", "![i](x)|`a`", 60)
	page := Render("polls/1")
	for _, bad := range []string{"](https", "<b>", "![i](x)", "`a`"} {
		uassert.False(t, strings.Contains(page, bad), "unescaped "+bad)
	}
	uassert.True(t, strings.Contains(page, "OpenPoll&id=1"), page)
	_ = id
	uassert.True(t, strings.Contains(Render("nope"), "Not found"))
	uassert.True(t, strings.Contains(Render("polls/abc"), "Not found"))
	uassert.True(t, strings.Contains(Render("rules"), `poll\.create`))
}

func TestDescriptor(t *testing.T) {
	d := Descriptor()
	uassert.Equal(t, "club-poll", d.Recipe)
	uassert.Equal(t, core.ViewSchemaVersion, d.ViewSchemaVersion)
}
