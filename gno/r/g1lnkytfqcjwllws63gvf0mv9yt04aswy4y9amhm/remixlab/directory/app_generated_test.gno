package directory

import (
	"strings"
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner   = testutils.TestAddress("scn-owner")
	scnAlice   = testutils.TestAddress("scn-alice")
	scnMallory = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
	setup(scnOwner)
	uassert.Equal(t, core.RoleOwner.String(), RoleOf(scnOwner))
	testing.SetRealm(testing.NewUserRealm(scnAlice))
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: name is required", func() {
		Submit(cross(cur), "", "Example", "Realm", "2000", "Example")
	})
	id := Submit(cross(cur), "Example", "Example", "Realm", "2000", "Example")
	uassert.Equal(t, 1, len(Queue(0, 25)))
	uassert.Equal(t, 0, len(Entries(0, 25)))
	testing.SetRealm(testing.NewUserRealm(scnMallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.review requires reviewer", func() {
		Accept(cross(cur), id)
	})
	testing.SetRealm(testing.NewUserRealm(scnOwner))
	Accept(cross(cur), id)
	v, _ := Entry(id)
	uassert.Equal(t, int(core.SubmissionAccepted), int(v.Status))
	uassert.Equal(t, 1, len(Entries(0, 25)))
	uassert.Equal(t, 0, len(Queue(0, 25)))
	uassert.True(t, strings.Contains(Render("entries"), "Example"))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submission already reviewed", func() {
		Reject(cross(cur), id)
	})
}
