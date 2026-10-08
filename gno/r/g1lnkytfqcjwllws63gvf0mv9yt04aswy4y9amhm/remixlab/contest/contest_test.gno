package contest

import (
	"strconv"
	"strings"
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
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

func entrant(i int) address {
	return testutils.TestAddress("entrant" + strconv.Itoa(i))
}

// submitAndAdmit submits n entries from distinct entrants and admits them.
func submitAndAdmit(cur realm, n int) {
	for i := 1; i <= n; i++ {
		testing.SetRealm(testing.NewUserRealm(entrant(i)))
		Submit(cross(cur), "Demo "+strconv.Itoa(i), "gno.land/r/demo/x", "")
	}
	testing.SetRealm(testing.NewUserRealm(owner))
	for i := 1; i <= n; i++ {
		Accept(cross(cur), uint64(i))
	}
}

func join(cur realm, addrs ...address) {
	for _, a := range addrs {
		testing.SetRealm(testing.NewUserRealm(owner))
		Invite(cross(cur), a, "member")
		testing.SetRealm(testing.NewUserRealm(a))
		Join(cross(cur))
	}
}

func TestContestAcceptance(cur realm, t *testing.T) {
	reset()
	join(cur, alice, bob)

	// Admit entries.
	submitAndAdmit(cur, 3)
	uassert.Equal(t, 3, len(Entries()))

	// Freeze choices and electorate.
	testing.SetRealm(testing.NewUserRealm(owner))
	OpenVoting(cross(cur), 3600)
	v, ok := Ballot()
	uassert.True(t, ok)
	uassert.Equal(t, 3, v.ElectorateSize)
	uassert.Equal(t, "#2 Demo 2", v.Options[1])
	ids := BallotEntries()
	uassert.Equal(t, 3, len(ids))
	uassert.Equal(t, uint64(3), ids[2])

	// Vote.
	testing.SetRealm(testing.NewUserRealm(alice))
	Vote(cross(cur), 2)
	testing.SetRealm(testing.NewUserRealm(bob))
	Vote(cross(cur), 2)
	testing.SetRealm(testing.NewUserRealm(owner))
	Vote(cross(cur), 3)
	uassert.AbortsWithMessage(t, cur, "remix: conflict: already voted", func() {
		Vote(cross(cur), 2)
	})
	testing.SetRealm(testing.NewUserRealm(entrant(1)))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), 1)
	})

	// Finalize and display the winner.
	testing.SkipHeights(3600/5 + 1)
	testing.SetRealm(testing.NewUserRealm(mallory))
	Finalize(cross(cur))
	w, ok := Winner()
	uassert.True(t, ok)
	uassert.Equal(t, uint64(2), w)
	page := Render("")
	uassert.True(t, strings.Contains(page, `Result: winner\: \#2 Demo 2 \(entry 2\)`), page)
}

func TestTieHasNoWinner(cur realm, t *testing.T) {
	reset()
	join(cur, alice)
	submitAndAdmit(cur, 2)
	testing.SetRealm(testing.NewUserRealm(owner))
	OpenVoting(cross(cur), 60)
	Vote(cross(cur), 1)
	testing.SetRealm(testing.NewUserRealm(alice))
	Vote(cross(cur), 2)
	testing.SkipHeights(13)
	Finalize(cross(cur))

	v, _ := Ballot()
	uassert.Equal(t, int(core.OutcomeTie), int(v.Outcome))
	_, ok := Winner()
	uassert.False(t, ok)
	uassert.True(t, strings.Contains(Render(""), "Result: tie"), Render(""))
}

func TestAdmissionIsCapped(cur realm, t *testing.T) {
	reset()
	submitAndAdmit(cur, maxEntries)
	testing.SetRealm(testing.NewUserRealm(entrant(99)))
	extra := Submit(cross(cur), "One too many", "x", "")
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: limit exceeded: the contest already has 10 entries", func() {
		Accept(cross(cur), extra)
	})
	// Rejecting stays possible, and the entry never reaches the ballot.
	Reject(cross(cur), extra)
	OpenVoting(cross(cur), 60)
	v, _ := Ballot()
	uassert.Equal(t, maxEntries, len(v.Options))
	uassert.AbortsWithMessage(t, cur, "remix: not found: entry is not on the ballot", func() {
		Vote(cross(cur), extra)
	})
}

func TestOpeningFreezesEntriesAndElectorate(cur realm, t *testing.T) {
	reset()
	join(cur, alice, bob)
	submitAndAdmit(cur, 2)
	testing.SetRealm(testing.NewUserRealm(entrant(3)))
	pending := Submit(cross(cur), "Late review", "x", "")

	testing.SetRealm(testing.NewUserRealm(owner))
	OpenVoting(cross(cur), 3600)

	// Entries and review are closed.
	testing.SetRealm(testing.NewUserRealm(entrant(4)))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submissions are closed", func() {
		Submit(cross(cur), "Too late", "x", "")
	})
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submissions are closed", func() {
		Accept(cross(cur), pending)
	})
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submissions are closed", func() {
		OpenVoting(cross(cur), 3600)
	})

	// Membership changes after opening do not change who may vote.
	join(cur, latecomer)
	testing.SetRealm(testing.NewUserRealm(latecomer))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), 1)
	})
	testing.SetRealm(testing.NewUserRealm(bob))
	Leave(cross(cur))
	Vote(cross(cur), 1)
	uassert.True(t, HasVoted(bob))
}

func TestOpeningNeedsTwoEntries(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: at least two admitted entries are required", func() {
		OpenVoting(cross(cur), 60)
	})
	submitAndAdmit(cur, 1)
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: at least two admitted entries are required", func() {
		OpenVoting(cross(cur), 60)
	})
	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: voting has not opened", func() {
		Vote(cross(cur), 1)
	})
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: voting has not opened", func() {
		Finalize(cross(cur))
	})
}

func TestDurationBounds(cur realm, t *testing.T) {
	reset()
	submitAndAdmit(cur, 2)
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: duration out of range", func() {
		OpenVoting(cross(cur), 59)
	})
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: duration out of range", func() {
		OpenVoting(cross(cur), 604801)
	})
}

func TestIntermediaryRealmGainsNoAuthority(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(entrant(1)))
	Submit(cross(cur), "a", "x", "")

	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/evil/proxy"))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.review requires reviewer", func() {
		Accept(cross(cur), 1)
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: contest.open requires owner", func() {
		OpenVoting(cross(cur), 60)
	})
}

func TestReviewerCannotOpenVoting(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), alice, "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))
	testing.SetRealm(testing.NewUserRealm(entrant(1)))
	Submit(cross(cur), "a", "x", "")
	testing.SetRealm(testing.NewUserRealm(entrant(2)))
	Submit(cross(cur), "b", "x", "")

	testing.SetRealm(testing.NewUserRealm(alice))
	Accept(cross(cur), 1)
	Accept(cross(cur), 2)
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: contest.open requires owner", func() {
		OpenVoting(cross(cur), 60)
	})

	// The owner may delegate opening to reviewers, but not to members.
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: contest.open: rule below floor reviewer", func() {
		SetRule(cross(cur), "contest.open", "member")
	})
	SetRule(cross(cur), "contest.open", "reviewer")
	testing.SetRealm(testing.NewUserRealm(alice))
	OpenVoting(cross(cur), 60)
}

func TestRenderEscapesEntries(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(entrant(1)))
	Submit(cross(cur), "[win](https://evil.example) <img>", "x", "")
	testing.SetRealm(testing.NewUserRealm(entrant(2)))
	Submit(cross(cur), "b", "/r/x$help&func=Drain", "")
	testing.SetRealm(testing.NewUserRealm(owner))
	Accept(cross(cur), 1)
	Accept(cross(cur), 2)
	OpenVoting(cross(cur), 60)

	for _, path := range []string{"", "entries/1", "entries/2", "queue", "rules"} {
		page := Render(path)
		uassert.False(t, strings.Contains(page, "](https://evil"), path)
		uassert.False(t, strings.Contains(page, "<img>"), path)
		uassert.False(t, strings.Contains(page, "$help&func=Drain"), path)
	}
}
