package clubpoll

import (
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner   = testutils.TestAddress("scn-owner")
	scnAlice   = testutils.TestAddress("scn-alice")
	scnBob     = testutils.TestAddress("scn-bob")
	scnMallory = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
	setup(scnOwner)
	uassert.Equal(t, core.RoleOwner.String(), RoleOf(scnOwner))
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Invite(cross(cur), scnAlice, "member")
	testing.SetRealm(testing.NewUserRealm(scnAlice))
	Join(cross(cur))
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Invite(cross(cur), scnBob, "member")
	testing.SetRealm(testing.NewUserRealm(scnBob))
	Join(cross(cur))
	uassert.Equal(t, 3, len(Members(0, 25)))
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	id := CreatePoll(cross(cur), "T", "a|b", 60)
	OpenPoll(cross(cur), id)
	testing.SetRealm(testing.NewUserRealm(scnAlice))
	Vote(cross(cur), id, 1)
	testing.SetRealm(testing.NewUserRealm(scnBob))
	Vote(cross(cur), id, 1)
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Vote(cross(cur), id, 0)
	testing.SetRealm(testing.NewUserRealm(scnMallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {
		Vote(cross(cur), id, 0)
	})
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: deadline not reached", func() {
		Finalize(cross(cur), id)
	})
	testing.SkipHeights(13)
	Finalize(cross(cur), id)
	v, _ := Poll(id)
	uassert.Equal(t, 3, v.Turnout)
	uassert.Equal(t, int(core.OutcomeWinner), int(v.Outcome))
	uassert.Equal(t, 1, v.Winner)
}
