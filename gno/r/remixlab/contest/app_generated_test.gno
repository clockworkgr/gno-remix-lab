package contest

import (
	"strings"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/remixlab/core/v1"
)

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner    = testutils.TestAddress("scn-owner")
	scnAlice    = testutils.TestAddress("scn-alice")
	scnBob      = testutils.TestAddress("scn-bob")
	scnEntrant1 = testutils.TestAddress("scn-entrant1")
	scnEntrant2 = testutils.TestAddress("scn-entrant2")
	scnMallory  = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
	setup(scnOwner)
	uassert.NoError(t, members.Add(scnAlice, core.RoleMember))
	uassert.NoError(t, members.Add(scnBob, core.RoleMember))
	testing.SetRealm(testing.NewUserRealm(scnEntrant1))
	Submit(cross(cur), "Example", "Example", "Example")
	testing.SetRealm(testing.NewUserRealm(scnEntrant2))
	Submit(cross(cur), "Example", "Example", "Example")
	testing.SetRealm(testing.NewUserRealm(scnMallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.review requires reviewer", func() {
		Accept(cross(cur), 1)
	})
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Accept(cross(cur), 1)
	Accept(cross(cur), 2)
	uassert.Equal(t, 2, len(Entries()))
	OpenVoting(cross(cur), 60)
	testing.SetRealm(testing.NewUserRealm(scnEntrant1))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submissions are closed", func() {
		Submit(cross(cur), "Example", "Example", "Example")
	})
	testing.SetRealm(testing.NewUserRealm(scnAlice))
	Vote(cross(cur), 2)
	testing.SetRealm(testing.NewUserRealm(scnBob))
	Vote(cross(cur), 2)
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Vote(cross(cur), 1)
	testing.SetRealm(testing.NewUserRealm(scnMallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), 1)
	})
	uassert.AbortsWithMessage(t, cur, "remix: not found: entry is not on the ballot", func() {
		Vote(cross(cur), 99)
	})
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: deadline not reached", func() {
		Finalize(cross(cur))
	})
	testing.SkipHeights(13)
	Finalize(cross(cur))
	v, _ := Ballot()
	uassert.Equal(t, 3, v.Turnout)
	uassert.Equal(t, int(core.OutcomeWinner), int(v.Outcome))
	w, ok := Winner()
	uassert.Equal(t, true, ok)
	uassert.Equal(t, uint64(2), w)
	uassert.True(t, strings.Contains(Render(""), "(entry 2\\)"))
}
